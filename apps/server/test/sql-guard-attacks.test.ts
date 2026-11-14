// Attacks on the read-only boundary of the agents' database queries. The connection of @vanr/engine/sqlconn opens
// a read-only transaction with a timeout, but a first statement such as `set transaction read write`, `commit` or
// `set local statement_timeout = 0` would undo either of them: the guard has to stop every one of these before
// anything reaches the database, and has to split statements exactly where Postgres does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import { checkPlan, guardStatement } from "../src/integrations/sql-guard";

let pg: Awaited<ReturnType<typeof memoryPostgres>>;
beforeAll(async () => {
  pg = await memoryPostgres();
  await pg.exec(`
    create table customers (id int primary key, name text, ssn text);
    create table orders (id int, customer_id int, total numeric);
  `);
});
afterAll(() => pg.close());

const policy = { tables: ["customers", "orders"], maskedColumns: ["customers.ssn"] };
const failureOf = (sql: string) => {
  const out = guardStatement(sql);
  return "failure" in out ? out.failure : null;
};

describe("commands that would undo the read-only transaction or its timeout", () => {
  test.each([
    ["set transaction read write", "set"],
    ["commit", "commit"],
    ["begin", "begin"],
    ["start transaction read write", "start"],
    ["set local statement_timeout = 0", "set"],
    ["SET statement_timeout TO 0", "set"],
    ["reset all", "reset"],
    ["set session characteristics as transaction read write", "set"],
    ["copy (select 1) to program 'id'", "copy"],
    ["explain analyze delete from orders", "explain"],
    ["delete from orders", "delete"],
    ["/* hi */ -- there\n  set transaction read write", "set"],
    ["   ", ""],
  ])("%p is rejected as a statement that is not a query", (sql, keyword) => {
    expect(failureOf(sql)).toEqual({ reason: "statement", keyword });
  });

  test("a function that changes the session setting is rejected by the plan check", async () => {
    for (const sql of [
      "select set_config('statement_timeout', '0', true)",
      "select set_config('transaction_read_only', 'off', false)",
      "with t as (select set_config('statement_timeout', '0', true)) select * from t",
    ]) {
      expect(guardStatement(sql)).toEqual({ statement: sql });
      const res = await pg.query<{ "QUERY PLAN": unknown }>(`explain (verbose, format json) ${sql}`);
      expect(checkPlan(res.rows[0]?.["QUERY PLAN"], policy)).toEqual({
        reason: "function",
        name: "set_config",
      });
    }
  });
});

describe("a second command hidden in one string", () => {
  test.each([
    "select 1; delete from orders",
    "select 1 -- x\n; delete from orders",
    "select 1 /* x */; delete from orders",
    // Block comments nest in Postgres: the comment ends at the second `*/`, and `'` after the first is code.
    "select 1 /* /* */ ' */ ; delete from orders; -- '",
    // In an E'' string the backslash escapes the quote: the string ends before the `;`.
    "select E'\\''; delete from orders; --'",
    "select e'\\\\'; delete from orders; --'",
    // A `$` inside an identifier is part of the name: `foo$$` does not open a dollar quote.
    "select 1 as foo$$; delete from orders; select 1 as bar$$",
    "select 1 as a$x$; delete from orders; select $x$ $x$",
    // A `--` comment also ends at a carriage return.
    "select 1--\r;delete from orders;select\n 2",
  ])("%p is rejected as more than one statement", (sql) => {
    expect(failureOf(sql)).toEqual({ reason: "multiple_statements" });
  });

  // Postgres itself is the oracle: its simple query protocol returns one result per statement it ran.
  test("the guard splits statements exactly where Postgres does", async () => {
    for (const sql of [
      "select 1 /* /* */ ' */ ; select 2; -- '",
      "select E'\\''; select 2; --'",
      "select 1 as foo$$; select 2; select 3 as bar$$",
      "select 1 /* a /* b */ c */",
      "select E'a\\'b;c'",
      "select 'a\\'; select 2; --'",
      "select $tag$ ; $tag$",
      "select $1$a",
      'select 1 as "a;b"',
      "select U&'d\\0061t\\+000061;'",
    ]) {
      let statements: number;
      try {
        statements = (await pg.exec(sql)).length;
      } catch {
        continue; // Postgres rejects the text: nothing ran, nothing to compare.
      }
      expect({ sql, single: "statement" in guardStatement(sql) }).toEqual({ sql, single: statements === 1 });
    }
  });
});

describe("writes in a query", () => {
  test("a CTE with insert, a top-level delete after WITH and SELECT INTO are writes", async () => {
    const cte = "with x as (insert into orders values (1, 1, 1) returning *) select * from x";
    expect(failureOf(cte)).toEqual({ reason: "write" });
    expect(failureOf("select id into stolen from orders")).toEqual({ reason: "write" });
    expect(failureOf("select * into stolen from customers")).toEqual({ reason: "write" });
    for (const sql of [cte, "with x as (select 1) delete from orders"]) {
      expect(failureOf(sql)).toEqual({ reason: "write" });
      const res = await pg.query<{ "QUERY PLAN": unknown }>(`explain (verbose, format json) ${sql}`);
      expect(checkPlan(res.rows[0]?.["QUERY PLAN"], policy)).toEqual({ reason: "write" });
    }
    expect(failureOf("with x as (delete from orders returning *) select * from x")).toEqual({
      reason: "write",
    });
    for (const lock of ["for update", "for no key update", "for share", "for key share"])
      expect(failureOf(`select id from orders ${lock}`)).toEqual({ reason: "write" });
  });

  test("a sequence function is rejected by the plan check (the read-only transaction rejects it too)", async () => {
    await pg.exec("create sequence if not exists counter");
    for (const sql of [
      "select nextval('counter')",
      "select setval('counter', 9)",
      "select \"nextval\"('counter')",
    ]) {
      expect(guardStatement(sql)).toEqual({ statement: sql });
      const res = await pg.query<{ "QUERY PLAN": unknown }>(`explain (verbose, format json) ${sql}`);
      expect(checkPlan(res.rows[0]?.["QUERY PLAN"], policy)?.reason).toBe("function");
    }
  });
});

describe("string constants read the way Postgres reads them", () => {
  test("a literal glued across a newline keeps the E'' escapes: the second command is seen", () => {
    expect(failureOf("select E''\n'\\'';delete from orders;--'")).toEqual({ reason: "multiple_statements" });
    expect(failureOf("select 'a'\n'b'")).toBeNull();
  });

  test("a boundary that depends on standard_conforming_strings is rejected", () => {
    expect(failureOf("select '\\'';delete from orders;--'")).toEqual({ reason: "ambiguous" });
    expect(failureOf("select 'C:\\temp\\'")).toEqual({ reason: "ambiguous" });
    expect(failureOf("select 'a\\b', '\\d+'")).toBeNull();
  });

  test("a text Postgres would not parse is rejected", () => {
    for (const sql of [
      "select 'open",
      "select 1 /* open",
      "select $x$ open",
      'select "open',
      "select 1\0",
      "select 1abc",
    ])
      expect(failureOf(sql)).toEqual({ reason: "malformed" });
  });

  test("reads still pass, with the trailing semicolon and comments stripped", () => {
    expect(guardStatement("select id, name from customers;")).toEqual({
      statement: "select id, name from customers",
    });
    expect(guardStatement("  (select 1) -- note")).toEqual({ statement: "(select 1)" });
    expect(guardStatement("with t as (select 1) select * from t")).toEqual({
      statement: "with t as (select 1) select * from t",
    });
    expect(guardStatement("values (1), (2)")).toEqual({ statement: "values (1), (2)" });
    expect(guardStatement("table orders")).toEqual({ statement: "table orders" });
    expect(guardStatement("select 'into' as \"into\"")).toEqual({ statement: "select 'into' as \"into\"" });
  });
});

test("a plan off the EXPLAIN shape fails closed", () => {
  for (const explain of [
    null,
    [],
    "plan",
    [{}],
    { Plan: { "Relation Name": 5 } },
    { Plan: { Plans: [{ Alias: [] }] } },
  ]) {
    expect(checkPlan(explain, policy)).toEqual({ reason: "write" });
  }
});
