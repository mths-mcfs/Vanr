// The functions a data-source query may call: only known built-ins that compute on what they receive. A function
// of the customer's own reads any table without the plan showing it; xpath and xmltable parse what they are given.
// The cases are generated: each rejected call in each place a query can hold one, plus the allowed families.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import { checkPlan, type GuardFailure, guardStatement } from "../src/integrations/sql-guard";

let pg: Awaited<ReturnType<typeof memoryPostgres>>;
beforeAll(async () => {
  pg = await memoryPostgres();
  await pg.exec(`
    create table customers (id int primary key, name text, ssn text, meta jsonb, born date);
    create table orders (id int, customer_id int, total numeric);
    create function leak_fn() returns text language sql as $$ select ssn from customers limit 1 $$;
    create function "Leak"(x text) returns text language sql as $$ select ssn from customers limit 1 $$;
    create schema extra;
    create function extra.lower(x text) returns text language sql as $$ select ssn from customers limit 1 $$;
  `);
});
afterAll(() => pg.close());

const policy = { tables: ["customers", "orders"], maskedColumns: ["customers.ssn"] };

/** The guard's verdict on a query: null when it may run, else the failure (statement or plan). */
async function verdict(sql: string): Promise<GuardFailure | null> {
  const g = guardStatement(sql);
  if ("failure" in g) return g.failure;
  const res = await pg.query<{ "QUERY PLAN": unknown }>(`explain (verbose, format json) ${g.statement}`);
  return checkPlan(res.rows[0]?.["QUERY PLAN"], policy);
}

/** Places a query can hold a call, with `$` where the call goes. */
const PLACES = [
  "select $ from customers",
  "select name from customers where $ is not null",
  "select name from customers order by $",
  "select count(*) from customers group by $",
  "select c.name from customers c join orders o on o.customer_id = c.id and $ is not null",
  "with t as (select $ as v from customers) select v from t",
  "select v from (select $ as v from customers) s",
  "select (select $) from customers",
  "select coalesce($, name) from customers",
  "select name from customers where id in (select id from customers where $ is null)",
  "select x.v from customers c, lateral (select $ as v) x",
  "select case when id > 0 then $ end from customers",
  "select string_agg($, ',') from customers",
];

/** Calls the guard rejects, with the name the failure carries. */
const REJECTED: [call: string, name: string][] = [
  ["leak_fn()", "leak_fn"],
  ['"Leak"(name)', '"Leak"'],
  ["public.leak_fn()", "public.leak_fn"],
  ["extra.lower(name)", "extra.lower"],
  ["pg_catalog.lower(name)", "pg_catalog.lower"],
  // With a column argument: on constants alone, Postgres computes an immutable call while planning.
  ["xpath('/a', name::xml)::text", "xpath"],
  ["xmlparse(document name)::text", "xmlparse"],
  ["to_regclass('customers')::text", "to_regclass"],
  ["txid_current()::text", "txid_current"],
  ["version()", "version"],
];

describe("calls outside the list are rejected wherever they sit", () => {
  for (const place of PLACES) {
    for (const [call, name] of REJECTED) {
      test(`${call} in ${place}`, async () => {
        const failure = await verdict(place.replace("$", call));
        expect(failure).toMatchObject({ reason: "function" });
        // The plan may print the name already resolved: the qualified forms show either way.
        expect([name, name.split(".").pop()]).toContain((failure as { name: string }).name);
      });
    }
  }

  test("a table function (xmltable) and a function of the customer's in FROM are rejected", async () => {
    for (const sql of [
      "select * from xmltable('/a' passing '<a>1</a>' columns x int path '.')",
      "select * from leak_fn()",
    ])
      expect(await verdict(sql)).toMatchObject({ reason: "function" });
  });
});

describe("the allowed families still pass", () => {
  test.each([
    "select count(*), min(id), max(total), sum(total), avg(total) from orders",
    "select lower(name), upper(name), initcap(name), length(name), substr(name, 1, 2) from customers",
    "select substring(name from 1 for 2), position('a' in name), trim(both ' ' from name) from customers",
    "select left(name, 2), right(name, 2), replace(name, 'a', 'b'), split_part(name, ' ', 1) from customers",
    "select regexp_replace(name, 'a', 'b'), concat_ws('-', id, name), format('%s', name) from customers",
    "select date_trunc('month', born), extract(year from born), age(born), now() from customers",
    "select to_char(born, 'YYYY'), current_date, born + interval '1 day' from customers",
    "select abs(total), round(total, 2), floor(total), ceil(total), greatest(total, 1), least(total, 2) from orders",
    "select total::numeric(10,2), id::text, cast(total as numeric(8, 1)) from orders",
    "select name::varchar(20), name::character varying(5), born::timestamp(0) without time zone from customers",
    "select coalesce(name, ''), nullif(name, '') from customers",
    "select meta->>'a', jsonb_typeof(meta), jsonb_array_length(meta->'x'), jsonb_build_object('n', name) from customers",
    "select row_to_json(o), to_jsonb(o) from orders o",
    "select k, v from customers, jsonb_each(meta) as e(k, v)",
    "select * from jsonb_to_record('{\"a\":1}') as x(a int)",
    "select g from generate_series(1, 3) g",
    "select unnest(array[1, 2]), array_length(array[1], 1), cardinality(array[1])",
    "select row_number() over (order by id), rank() over (partition by name order by id) from customers",
    "select lag(total) over (order by id), sum(total) over () from orders",
    "select percentile_cont(0.5) within group (order by total) from orders",
    "select count(*) filter (where total > 10) from orders",
    "select string_agg(name, ',' order by name), array_agg(id) from customers",
    "select to_tsvector('simple', name) from customers",
    "select exists (select 1 from orders), id in (1, 2), id = any (array[1]) from customers",
  ])("%s", async (sql) => {
    expect(await verdict(sql)).toBeNull();
  });
});

describe("generated: random calls in random places, seed 42", () => {
  let seed = 42;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return Math.floor((seed / 0x80000000) * n);
  };
  const pick = <T>(items: readonly T[]) => items[rand(items.length)] as T;
  const spacing = ["", " ", "/*c*/", "\n"];

  test("every query that calls a rejected function is rejected (200 cases)", async () => {
    const passed: string[] = [];
    for (let i = 0; i < 200; i++) {
      const [call] = pick(REJECTED);
      const spaced = call.replace("(", `${pick(spacing)}(`);
      const sql = pick(PLACES).replace("$", spaced);
      if ("failure" in guardStatement(sql)) continue;
      const failure = await verdict(sql);
      if (failure?.reason !== "function") passed.push(sql);
    }
    expect(passed).toEqual([]);
  });
});
