// The allowlist holds by the function's resolved identity, not by the name the plan prints: a customer function
// named like an allowed one (any schema, any argument types), one the planner would fold, one behind a view or
// an operator, is rejected before the query is planned. Each customer function here raises when it runs, so a
// rejection that comes back without that error proves it never ran, not even while planning.
// On PGlite always; on a real Postgres too in the CI `postgres` job (VANR_TEST_POSTGRES_URL), each case in a
// database of its own. The databases are left in place, as with every other Postgres test: a `drop database`
// forces an immediate checkpoint, which would flush, inside the test, every buffer the earlier CI steps dirtied.
import { expect, test } from "bun:test";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import postgres from "postgres";
import {
  type GuardedSession,
  guardedQuery,
  pgliteGuardedSession,
  postgresGuardedSession,
} from "../src/integrations/sql-identity";
import { TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const policy = { tables: ["customers", "orders"], maskedColumns: ["customers.ssn"] };

const FIXTURES = `
  create table customers (id int primary key, name text, ssn text);
  insert into customers values (7, 'Alice', '999-00-1111');
  create table orders (id int, customer_id int, total numeric);
  insert into orders values (10, 7, 50);
  create table secrets (v text);
  insert into secrets values ('top-secret');
`;

/** A customer function that raises when it runs (it would read the secret in a real attack). */
const evil = (signature: string, returns: string, extra = "") =>
  `create function ${signature} returns ${returns} language plpgsql ${extra} as $$
     begin raise exception 'customer function ran: %', (select v from secrets limit 1); end $$;`;

type Policy = typeof policy;
type Run = (sql: string, p?: Policy, raw?: (s: GuardedSession) => Promise<unknown>) => Promise<unknown>;

/** A fresh database with the fixtures plus `setup`, and a runner of guarded queries in one read-only transaction. */
async function withDatabase(kind: "PGlite" | "Postgres", setup: string, fn: (run: Run) => Promise<void>) {
  if (kind === "PGlite") {
    const pg = await memoryPostgres();
    try {
      await pg.exec(FIXTURES + setup);
      await fn((sql, p = policy, raw) =>
        pg.transaction(async (tx) => {
          await tx.exec("set transaction read only");
          const session = pgliteGuardedSession(tx);
          const out = await guardedQuery(session, sql, p);
          return raw ? { out, raw: await raw(session) } : out;
        }),
      );
    } finally {
      await pg.close();
    }
    return;
  }
  const db = postgres(await testDatabaseUrl("vanr_identity"), { max: 1, onnotice: () => {}, prepare: false });
  try {
    await db.unsafe(FIXTURES + setup);
    await fn(async (sql, p = policy, raw) => {
      let result: unknown;
      await db.begin("read only", async (tx) => {
        const session = postgresGuardedSession(tx);
        const out = await guardedQuery(session, sql, p);
        result = raw ? { out, raw: await raw(session) } : out;
      });
      return result;
    });
  } finally {
    await db.end({ timeout: 2 });
  }
}

/** A listed view works, through a view under it the policy doesn't name, and the check leaves no prepared statement. */
async function withViews(q: Run) {
  const listed = { ...policy, tables: [...policy.tables, "names_outer"] };
  const out = (await q("select name from names_outer", listed, (s) =>
    s.rows("select count(*)::int as n from pg_catalog.pg_prepared_statements", []),
  )) as { out: unknown; raw: Record<string, unknown>[] };
  expect(out).toEqual({ out: { result: { fields: ["name"], rows: [{ name: "Alice" }] } }, raw: [{ n: 0 }] });
}

for (const kind of ["PGlite", "Postgres"] as const) {
  const run = test.skipIf(kind === "Postgres" && !TEST_POSTGRES_URL);

  run(`${kind}: native functions still pass and run, with the masked column still masked`, async () => {
    await withDatabase(kind, "", async (q) => {
      expect(
        await q(
          "select lower(name) as l, upper(name) as u, length(name) as n, trim(name) as t from customers",
        ),
      ).toEqual({
        result: { fields: ["l", "u", "n", "t"], rows: [{ l: "alice", u: "ALICE", n: 5, t: "Alice" }] },
      });
      expect(
        await q(
          String.raw`select U&"\006cower"(name) as l, U&"!0075pper" UESCAPE '!'(name) as u,
            id+-1 as a, id++1 as b, id*-1 as c from customers`,
        ),
      ).toEqual({
        result: { fields: ["l", "u", "a", "b", "c"], rows: [{ l: "alice", u: "ALICE", a: 6, b: 8, c: -7 }] },
      });
      expect(
        await q("select o.total from orders o join customers c on c.id = o.customer_id where c.id in (7)"),
      ).toMatchObject({
        result: { rows: [{ total: expect.anything() }] },
      });
      expect(await q("select ssn from customers")).toEqual({
        failure: { reason: "column", column: "public.customers.ssn" },
      });
      expect(await q("select c from customers c")).toMatchObject({ failure: { reason: "column" } });
      expect(await q("select v from secrets")).toEqual({
        failure: { reason: "table", table: "public.secrets" },
      });
    });
  });

  run(`${kind}: public.lower(integer) and public.upper(integer) are rejected before they run`, async () => {
    const setup = evil("public.lower(x integer)", "text") + evil("public.upper(x integer)", "text");
    await withDatabase(kind, setup, async (q) => {
      expect(await q("select lower(id) from customers")).toEqual({
        failure: { reason: "function", name: "public.lower(x integer)" },
      });
      expect(await q("select upper(id) from customers")).toEqual({
        failure: { reason: "function", name: "public.upper(x integer)" },
      });
      // The native overload is shadowed too: the name alone already reaches the customer's code.
      expect(await q("select lower(name) from customers")).toMatchObject({ failure: { reason: "function" } });
      // A query that calls neither name is not affected.
      expect(await q("select id from customers")).toEqual({ result: { fields: ["id"], rows: [{ id: 7 }] } });
    });
  });

  run.each([
    [String.raw`select U&"\006cower"(id) from customers`, "lower"],
    [String.raw`select u&"\+00006cower"(id) from customers`, "lower"],
    [`select U&"!006cower" /*a*/ UESCAPE /*b*/ '!'(id) from customers`, "lower"],
    [String.raw`select U&"!006cower" UESCAPE E'\041'(id) from customers`, "lower"],
    [`select U&"!006cower" UESCAPE $esc$!$esc$(id) from customers`, "lower"],
    [`select U&"!006cower" UESCAPE ''\n'!'(id) from customers`, "lower"],
    [String.raw`select U&"\0075pper"(7) from customers`, "upper"],
  ])(`${kind}: Unicode function identity is checked before planning: %s`, async (sql, name) => {
    const setup =
      evil("public.lower(x integer)", "text", "stable") +
      evil("public.upper(x integer)", "text", "immutable");
    await withDatabase(kind, setup, async (q) => {
      expect(await q(sql)).toEqual({
        failure: { reason: "function", name: `public.${name}(x integer)` },
      });
    });
  });

  run(
    `${kind}: an IMMUTABLE customer function with constant arguments never runs while planning`,
    async () => {
      await withDatabase(kind, evil("public.leak_immutable()", "text", "immutable"), async (q) => {
        expect(await q("select leak_immutable() from customers")).toEqual({
          failure: { reason: "function", name: "public.leak_immutable()" },
        });
        expect(await q('select "leak_immutable"() as x')).toMatchObject({ failure: { reason: "function" } });
      });
    },
  );

  run(`${kind}: a customer function in another schema, behind a keyword or a view, is rejected`, async () => {
    const setup = `
      create schema extra;
      ${evil("extra.btrim(x text)", "text", "immutable")}
      ${evil("extra.leak_view()", "text", "immutable")}
      create view public.customer_names as select id, name, extra.leak_view() as tag from customers;
    `;
    await withDatabase(kind, setup, async (q) => {
      // `trim(name)` calls btrim: the keyword hides the name.
      expect(await q("select trim(name) from customers")).toMatchObject({
        failure: { reason: "function", name: "extra.btrim(x text)" },
      });
      // The view is allowed and the query names neither the function nor its schema: the view's dependency
      // on the customer's function is what rejects it (planning would fold the IMMUTABLE call).
      const withView = { ...policy, tables: [...policy.tables, "customer_names"] };
      expect(await q("select id, tag from customer_names", withView)).toEqual({
        failure: { reason: "function", name: "extra.leak_view (used by an allowed relation)" },
      });
    });
  });

  run(
    `${kind}: a customer operator in SQL is rejected; the search_path is fixed for check and run`,
    async () => {
      const setup = `
      ${evil("public.int_plus_text(a integer, b text)", "integer")}
      create operator public.+ (leftarg = integer, rightarg = text, function = public.int_plus_text);
    `;
      await withDatabase(kind, setup, async (q) => {
        expect(await q("select id + 'x' from customers")).toEqual({
          failure: { reason: "function", name: "public.operator(+)" },
        });
        const out = (await q("select id from customers", policy, async (s) =>
          s.rows("select pg_catalog.current_setting('search_path') as path", []),
        )) as {
          out: unknown;
          raw: Record<string, unknown>[];
        };
        expect(out.out).toEqual({ result: { fields: ["id"], rows: [{ id: 7 }] } });
        expect(Object.values(out.raw[0] ?? {})).toEqual(['pg_catalog, "public", pg_temp']);
      });
    },
  );

  run(
    `${kind}: a table that differs only in case is another relation, for the allowed tables and the masks`,
    async () => {
      const setup = `create table "Customers" (id int, ssn text, secret text); insert into "Customers" values (2, 'other-ssn', 'other table');`;
      await withDatabase(kind, setup, async (q) => {
        // #73: allowing customers does not open "Customers".
        expect(await q('select * from "Customers"')).toEqual({
          failure: { reason: "table", table: 'public."Customers"' },
        });
        expect(await q("select name from customers")).toEqual({
          result: { fields: ["name"], rows: [{ name: "Alice" }] },
        });

        const both = { tables: ["customers", '"Customers"'], maskedColumns: ["customers.ssn"] };
        expect(await q('select ssn from "Customers"', both)).toEqual({
          result: { fields: ["ssn"], rows: [{ ssn: "other-ssn" }] },
        });
        expect(await q("select ssn from customers", both)).toEqual({
          failure: { reason: "column", column: "public.customers.ssn" },
        });
        // Both in one plan: the mask on customers.ssn is not a mask on "Customers".ssn.
        expect(
          await q('select "Customers".ssn, customers.name from "Customers" join customers on true', both),
        ).toEqual({ result: { fields: ["ssn", "name"], rows: [{ ssn: "other-ssn", name: "Alice" }] } });

        const reverse = { tables: ["customers", 'public."Customers"'], maskedColumns: ['"Customers".ssn'] };
        expect(await q("select ssn from customers", reverse)).toEqual({
          result: { fields: ["ssn"], rows: [{ ssn: "999-00-1111" }] },
        });
        expect(await q('select ssn from "Customers"', reverse)).toEqual({
          failure: { reason: "column", column: 'public."Customers".ssn' },
        });
        expect(await q('select c.ssn from "Customers" c join customers d on true', reverse)).toEqual({
          failure: { reason: "column", column: 'public."Customers".ssn' },
        });
      });
    },
  );

  run(
    `${kind}: "Sales View" and "sales view" are two relations, and only the allowed one's code is looked up`,
    async () => {
      const setup = `
      ${evil("public.leak_view()", "text", "immutable")}
      create view "Sales View" as select id, name from customers;
      create view "sales view" as select id, leak_view() as tag from customers;
    `;
      await withDatabase(kind, setup, async (q) => {
        const upper = { ...policy, tables: [...policy.tables, '"Sales View"'] };
        expect(await q('select id from "Sales View"', upper)).toEqual({
          result: { fields: ["id"], rows: [{ id: 7 }] },
        });
        const lower = { ...policy, tables: [...policy.tables, '"sales view"'] };
        expect(await q('select id from "Sales View"', lower)).toEqual({
          failure: { reason: "function", name: "public.leak_view (used by an allowed relation)" },
        });
      });
    },
  );

  run(`${kind}: a non-ASCII name folds as Postgres folds it, in the policy and in the query`, async () => {
    // Unquoted, Postgres folds only ASCII letters: Étage stays Étage, where JavaScript would write étage.
    const setup = `
      ${evil("public.leak_floor()", "text", "immutable")}
      create view Étage as select id, leak_floor() as tag from customers;
      ${evil('public."Étiq"()', "text", "immutable")}
    `;
    await withDatabase(kind, setup, async (q) => {
      const withView = { ...policy, tables: [...policy.tables, "Étage"] };
      expect(await q("select id from Étage", withView)).toEqual({
        failure: { reason: "function", name: "public.leak_floor (used by an allowed relation)" },
      });
      expect(await q("select Étiq() from customers")).toEqual({
        failure: { reason: "function", name: "public.Étiq()" },
      });
    });
  });

  run(`${kind}: a view outside the policy is refused before planning, whatever it calls (#80)`, async () => {
    // Mislabeled IMMUTABLE functions that read: the planner would fold each call, and the plan would show only
    // customers and a constant. Each view below is outside the policy.
    const setup = `
      create function leak() returns text language sql immutable as $$ select string_agg(v, ',') from secrets $$;
      create function leakssn() returns text language sql immutable as $$ select string_agg(ssn, ',') from customers $$;
      create function leakarg(t text) returns text language sql immutable as $$ select v from secrets $$;
      ${evil("public.boom()", "text", "immutable")}
      create view v_plain as select id, name from customers;
      create view v_ssn as select id, ssn as s from customers;
      create view v_join as select c.id, s.v from customers c cross join secrets s;
      create view v_leak as select id, leak() as x from customers;
      create view v_leakssn as select id, leakssn() as x from customers;
      create view v_boom as select id, boom() as x from customers;
      create view v_leakarg as select id, leakarg('a') as x from customers;
      create schema other;
      create view other.v_leak as select id, leak() as x from public.customers;
      create view v_const as select leak() as x;
      create view v_sb with (security_barrier) as select id, leak() as x from customers;
      create view v_where as select id, name from customers where leak() is not null;
      create view "V_Leak" as select id, leak() as x from customers;
      create view names_inner as select id, name from customers;
      create view names_outer as select name from names_inner;
    `;
    await withDatabase(kind, setup, async (q) => {
      for (const [sql, table] of [
        ["select * from v_plain", "public.v_plain"],
        ["select s from v_ssn", "public.v_ssn"],
        // Two relations outside the policy: the one the query wrote is named, not the one under it.
        ["select * from v_join", "public.v_join"],
        ["select x from v_leak", "public.v_leak"],
        ["select x from v_leakssn", "public.v_leakssn"],
        ["select x from v_boom", "public.v_boom"],
        ["select x from v_leakarg", "public.v_leakarg"],
        ["select x from other.v_leak", "other.v_leak"],
        ["select x from v_const", "public.v_const"],
        ["select x from v_sb", "public.v_sb"],
        ["select * from v_where", "public.v_where"],
        ['select x from "V_Leak"', 'public."V_Leak"'],
        ["select c.name, (select x from v_leak limit 1) from customers c", "public.v_leak"],
        ["select name from customers where exists (select 1 from v_const)", "public.v_const"],
      ] as const)
        expect([sql, await q(sql)]).toEqual([sql, { failure: { reason: "table", table } }]);

      // Listed, a clean view works, and so does a view under it that the policy doesn't name.
      await withViews(q);
      // That inner view, named on its own, is outside the policy.
      const listed = { ...policy, tables: [...policy.tables, "names_outer"] };
      expect(await q("select name from names_inner", listed)).toEqual({
        failure: { reason: "table", table: "public.names_inner" },
      });
      // A CTE named like a refused view is the CTE, and a function in FROM is no relation.
      expect(await q("with v_leak as (select 1 as x) select x from v_leak, generate_series(1, 2) g")).toEqual(
        {
          result: { fields: ["x"], rows: [{ x: 1 }, { x: 1 }] },
        },
      );
    });
  });

  run(
    `${kind}: a type whose input runs customer code is refused before it runs, at parse time or later`,
    async () => {
      const setup = `
      ${evil("public.chk(t text)", "boolean", "immutable")}
      create domain dom as text check (chk(value));
      create domain dom2 as dom;
      create type comp as (a dom);
      create type nested as (c comp);
      create table tagged (id int, tag dom);
      create domain posint as int check (value > 0);
      create type dom_range as range (subtype = dom);
      create table booked (id int, r dom_range);
      create table booked_m (id int, m dom_multirange);
      create view dom_view as select (jsonb_populate_record(null::comp, '{"a": "x"}')).a::text as v;
    `;
      await withDatabase(kind, setup, async (q) => {
        const by = (type: string) => ({
          failure: { reason: "function", name: `public.chk (used by the type ${type})` },
        });
        // record_in and array_in call domain_in while the statement is still being parsed.
        expect(await q("select '(x)'::comp")).toEqual(by("public.dom"));
        expect(await q("select '{x}'::dom[]")).toEqual(by("public.dom"));
        expect(await q("select '{x}'::_dom")).toEqual(by("public.dom"));
        expect(await q("select '((x))'::nested")).toEqual(by("public.dom"));
        // A range literal: its constructor, named like the type, is already a customer function (step 1).
        expect(await q("select '[a,z]'::dom_range")).toMatchObject({ failure: { reason: "function" } });
        expect(await q("select 'x'::dom2")).toEqual(by("public.dom"));
        // A plain literal runs the CHECK only when the statement runs.
        expect(await q("select 'x'::dom")).toEqual(by("public.dom"));
        // A column cast runs the CHECK at execution, past every check that reads the plan.
        expect(await q("select name::dom from customers")).toEqual(by("public.dom"));
        expect(await q("select cast(name as dom) from customers")).toEqual(by("public.dom"));
        // A table with such a column: a record filled from JSON would run it, so naming the table is refused.
        const withTagged = { ...policy, tables: [...policy.tables, "tagged"] };
        expect(await q(`select jsonb_populate_record(t, '{"tag": "x"}') from tagged t`, withTagged)).toEqual(
          by("public.dom"),
        );
        expect(await q("select id from tagged", withTagged)).toEqual(by("public.dom"));
        // Through a range column's subtype, with no function named in the query.
        expect(await q("select id from booked", { ...policy, tables: [...policy.tables, "booked"] })).toEqual(
          by("public.dom"),
        );
        expect(
          await q("select id from booked_m", { ...policy, tables: [...policy.tables, "booked_m"] }),
        ).toEqual(by("public.dom"));
        // Inside an allowed view's rules, with no type named in the query.
        const withView = { ...policy, tables: [...policy.tables, "dom_view"] };
        expect(await q("select 1 from dom_view", withView)).toEqual(by("public.dom"));
        // A query that doesn't reach that view is not refused for it.
        expect(await q("select name from customers", withView)).toEqual({
          result: { fields: ["name"], rows: [{ name: "Alice" }] },
        });
        // A domain whose CHECK is the database's own still works.
        expect(await q("select 5::posint as p")).toEqual({ result: { fields: ["p"], rows: [{ p: 5 }] } });
      });
    },
  );

  run(`${kind}: a name longer than Postgres keeps is looked up the way Postgres truncates it`, async () => {
    const kept = "f".repeat(63);
    const setup = `
      ${evil(`public.${kept}()`, "text", "immutable")}
      create domain ${"d".repeat(63)} as text check (chk_long(value));
    `;
    const chk = `${evil("public.chk_long(t text)", "boolean", "immutable")}`;
    await withDatabase(kind, chk + setup, async (q) => {
      expect(await q(`select ${kept}tail()`)).toEqual({
        failure: { reason: "function", name: `public.${kept}()` },
      });
      expect(await q(`select 'x'::${"d".repeat(70)}`)).toEqual({
        failure: { reason: "function", name: `public.chk_long (used by the type public.${"d".repeat(63)})` },
      });
    });
  });

  run(`${kind}: a failed lock read still deallocates the prepared statement`, async () => {
    await withDatabase(kind, "", async (q) => {
      const failing = (session: GuardedSession): GuardedSession => ({
        ...session,
        rows: async (text, params) => {
          // A real failure inside the read: the transaction aborts, as a timeout or a cancel would.
          if (text.includes("pg_locks")) await session.rows("select 1 / 0", []);
          return session.rows(text, params);
        },
      });
      let seen: unknown;
      // postgres.js still fails the whole transaction for the error it saw; PGlite doesn't. Both are fine here:
      // what counts is what the session holds right after the guard gave up.
      await q("select 1", policy, async (s) => {
        const error = await guardedQuery(failing(s), "select name from customers", policy).catch(
          (e: Error) => e.message,
        );
        const [left] = await s.rows("select count(*)::int as n from pg_catalog.pg_prepared_statements", []);
        seen = { error, left };
      }).catch(() => {});
      expect(seen).toEqual({ error: expect.stringContaining("division by zero"), left: { n: 0 } });
    });
  });

  run.each(["select name+-1 from customers", "select name++1 from customers", "select 'x'::text+-1"])(
    `${kind}: adjacent signs cannot hide a customer operator before planning: %s`,
    async (sql) => {
      const setup = `
      ${evil("public.text_plus_int(a text, b integer)", "text", "immutable")}
      create operator public.+ (leftarg = text, rightarg = integer, function = public.text_plus_int);
    `;
      await withDatabase(kind, setup, async (q) => {
        expect(await q(sql)).toEqual({
          failure: { reason: "function", name: "public.operator(+)" },
        });
      });
    },
  );
}
