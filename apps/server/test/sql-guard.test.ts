import { afterAll, beforeAll, expect, test } from "bun:test";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import { checkPlan, guardStatement, relationKey } from "../src/integrations/sql-guard";

/** The statement the guard accepts, or null. */
const accepted = (sql: string) => {
  const out = guardStatement(sql);
  return "statement" in out ? out.statement : null;
};

let pg: Awaited<ReturnType<typeof memoryPostgres>>;
beforeAll(async () => {
  pg = await memoryPostgres();
  await pg.exec(`
    create table customers (id int primary key, name text, ssn text);
    create index customers_ssn_idx on customers (ssn);
    create sequence counter;
    create table orders (id int, customer_id int, total numeric);
    create schema sales;
    create table sales.targets (month int, amount numeric);
    create table secrets (secret_key text);
  `);
});
afterAll(() => pg.close());

const policy = { tables: ["customers", "orders", "sales.targets"], maskedColumns: ["customers.ssn"] };
const plan = async (sql: string) => {
  const res = await pg.query<{ "QUERY PLAN": unknown }>(`explain (verbose, format json) ${sql}`);
  return res.rows[0]?.["QUERY PLAN"];
};
const check = async (sql: string) => checkPlan(await plan(sql), policy);

test("allows reading the allowed tables without the hidden column", async () => {
  expect(await check("select id, name from customers")).toBeNull();
  expect(
    await check("select c.name, p.total from customers c join orders p on p.customer_id = c.id"),
  ).toBeNull();
  expect(await check("select * from sales.targets where month = 3")).toBeNull();
  expect(await check("select name from customers where name = 'ssn'")).toBeNull();
  expect(await check("select count(*) from orders")).toBeNull();
  // Under the join the scan returns the whole row ("physical tlist"); that is not a read.
  expect(await check("select name from customers where id in (select customer_id from orders)")).toBeNull();
  expect(await check("select name from customers where id in (select 1 from orders)")).toBeNull();
  expect(await check("select name from customers order by name limit 5")).toBeNull();
});

test("rejects a hidden column read in any way", async () => {
  const ssn = { reason: "column", column: "public.customers.ssn" } as const;
  expect(await check("select ssn from customers")).toEqual(ssn);
  expect(await check("select * from customers")).toEqual(ssn);
  expect(await check("select c.ssn as x from customers c")).toEqual(ssn);
  expect(await check("select name from customers where ssn like '1%'")).toEqual(ssn);
  expect(
    await check("select p.total, (select ssn from customers where id = p.customer_id) from orders p"),
  ).toEqual(ssn);
  expect(await check(`select "ssn" from customers`)).toEqual(ssn);
  expect(await check("select p.total from orders p join customers c on c.ssn = p.id::text")).toEqual(ssn);
  expect(await check("select max(ssn) from customers")).toEqual(ssn);
  expect(await check("select name from customers order by ssn")).toEqual(ssn);
  expect(await check("select x.c from (select ssn as c from customers offset 0) x")).toEqual(ssn);
  expect(await check("select count(*) from customers where ssn = '123'")).toEqual(ssn);
  expect(await check("select row_to_json(c) from customers c")).toEqual({
    reason: "column",
    column: "public.customers.*",
  });
});

test("rejects a table outside the list, writes and a function that reads outside the database", async () => {
  expect(await check("select * from secrets")).toEqual({ reason: "table", table: "public.secrets" });
  expect(await check("select name from customers where id in (select 1 from secrets)")).toEqual({
    reason: "table",
    table: "public.secrets",
  });
  expect(await check("with x as (delete from orders returning *) select count(*) from x")).toEqual({
    reason: "write",
  });
  expect(await check("select name from customers for update")).toEqual({ reason: "write" });
  expect(await check("select pg_read_file('/etc/passwd')")).toEqual({
    reason: "function",
    name: "pg_read_file",
  });
});

test("a single statement, ignoring ; inside a string, identifier and comment", () => {
  expect(accepted("select 1;")).toBe("select 1");
  expect(accepted("  select 1 ;  ; ")).toBe("select 1");
  expect(accepted("select ';' as x")).toBe("select ';' as x");
  expect(accepted(`select 1 as ";"`)).toBe(`select 1 as ";"`);
  expect(accepted("select $$a;b$$")).toBe("select $$a;b$$");
  expect(accepted("select 1 -- ; drop\n")).toBe("select 1");
  expect(accepted("select 1; drop table customers")).toBeNull();
  expect(accepted("select 1; /* x */ select 2")).toBeNull();
  expect(accepted("   ")).toBeNull();
});

test("a function that runs SQL from text or reads the system does not pass; a plain set-returning function passes", async () => {
  // The text passed to ts_stat is a whole query; as a literal, it drops out of the column check.
  for (const sql of [
    "select * from ts_stat('select to_tsvector(secret_key) from secrets')",
    "select word from ts_stat($$select to_tsvector('simple', ssn) from customers$$)",
    "select ts_stat('select to_tsvector(ssn) from customers')",
    "select ts_rewrite('a'::tsquery, 'select ''a''::tsquery, ''b''::tsquery from customers')",
    "select setting from pg_settings limit 3",
    "select query from pg_stat_activity",
    "select current_setting('data_directory')",
  ]) {
    expect({ sql, failure: (await check(sql))?.reason }).toEqual({ sql, failure: "function" });
  }
  for (const sql of [
    "select n from generate_series(1, 3) n",
    "select x from unnest(array[1, 2]) x",
    "select key from jsonb_each('{\"a\": 1}'::jsonb)",
    "select name, lower(name), count(*) from customers group by name",
  ]) {
    expect({ sql, failure: await check(sql) }).toEqual({ sql, failure: null });
  }
});

test("rejects writes after recursive CTE SEARCH and CYCLE suffixes", () => {
  const cte = "with recursive t(n) as (values(1) union all select n+1 from t where n<1)";
  for (const tail of [
    "search depth first by n set ord delete from orders",
    "cycle n set cyclic using path update orders set total=20",
  ])
    expect(guardStatement(`${cte} ${tail}`)).toEqual({ failure: { reason: "write" } });
});

test("apostrophes in quoted aliases do not hide functions or masked columns", async () => {
  const from = `from customers "a'" join orders b on b.customer_id="a'".id`;
  expect((await check(`select "a'".id + nextval('counter') + "a'".id ${from}`))?.reason).toBe("function");
  expect((await check(`select "a'".ssn || "a'".ssn ${from}`))?.reason).toBe("column");
  expect(await check(`select "a'".name || 'ssn nextval(' ${from}`)).toBeNull();
});

test("a policy name comes back as SQL that reads the same relation, keywords quoted", async () => {
  expect(relationKey("Customers")).toBe("public.customers");
  expect(relationKey('"Customers"')).toBe('public."Customers"');
  expect(relationKey('"user".customers')).toBe('"user".customers');
  expect(relationKey('sales."select"')).toBe('sales."select"');
  await pg.exec(
    `create schema "user"; create table "user".customers (id int); create table sales."select" (id int);`,
  );
  for (const name of ['"user".customers', 'sales."select"'])
    expect((await pg.query(`select count(*)::int as n from ${relationKey(name)}`)).rows).toEqual([{ n: 0 }]);
});
