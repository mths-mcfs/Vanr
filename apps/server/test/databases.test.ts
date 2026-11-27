// Databases end to end: the "customer database" is an in-memory Postgres (PGlite); connecting, the tables, the
// per-agent policy go through the real routes, and the db_* tools run through runtime/tools' gate in a run built
// by hand (integration-run.ts) until the runtime comes. Every agent query is the guarded run (sql-identity): the guard
// rejects a write, the network rule rejects an internal host, and the password never comes back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import { eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { DATABASE_TOOLS, hasDatabases } from "../src/integrations/databases";
import {
  type GuardedConnector,
  pgliteGuardedConnector,
  postgresOptions,
} from "../src/integrations/sql-identity";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { toolRun } from "./integration-run";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";

let pg: Awaited<ReturnType<typeof memoryPostgres>>;
let server: RunningServer;
beforeAll(async () => {
  pg = await memoryPostgres();
  await pg.exec(`
    create table customers (id int primary key, name text, ssn text);
    create table orders (id int primary key, customer_id int references customers(id), total numeric);
    create table secrets (x text);
    create table "Suppliers" (id int primary key, company text);
    insert into customers values (1, 'Joana', '111'), (2, 'Rui', '222');
    insert into orders values (10, 1, 99.5), (11, 2, 12);
  `);
  server = await startTestServer({
    env: { ALLOW_PRIVATE_NETWORKS: "true" },
    sql: pgliteGuardedConnector(pg),
  });
  // Two PGlite instances start here (the server's and the outside database).
}, 120_000);
afterAll(async () => {
  await server.stop();
  await pg.close();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@databases.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, `lia${n}`, [general]);
  const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
  if (!channel) throw new Error("no channel");
  /** What the tool returned to the model, in a fresh run of Lia in #general. */
  const ask = async (tool: string, input: unknown) =>
    (await toolRun(server.deps, lia, channel).run(DATABASE_TOOLS, tool, input)).content;
  const url = (path: string) => `${ws(workspaceId)}${path}`;
  return { workspaceId, general, channel, ana, beto, lia, ask, url };
}

const connectInput = {
  provider: "other" as const,
  host: "127.0.0.1",
  database: "postgres",
  username: "postgres",
  password: "db-password-7731",
  sslmode: "disable" as const,
};

/** The installation's network switches for the length of `fn` (the server reads them on every connection). */
async function withNetRule(
  rule: { allowPrivateNetworks: boolean; allowPlaintext: boolean },
  fn: () => Promise<void>,
) {
  const { integrations } = server.deps.config;
  const before = { ...integrations };
  Object.assign(integrations, rule);
  try {
    await fn();
  } finally {
    Object.assign(integrations, before);
  }
}

/** The outside database for the length of `fn`. */
async function withConnector(sql: GuardedConnector, fn: () => Promise<void>) {
  const before = server.deps.sql;
  server.deps.sql = sql;
  try {
    await fn();
  } finally {
    server.deps.sql = before;
  }
}

describe("databases", () => {
  test(
    "connect, suggestions, tables, update and disconnect",
    async () => {
      const { ana, beto, url } = await team();
      expect((await call(beto, "POST", url("/databases"), connectInput)).status).toBe(403);
      const created = await call(ana, "POST", url("/databases"), { ...connectInput, label: "Store" });
      expect(created.status).toBe(201);
      const conn = created.body.connection;
      expect(conn).toMatchObject({
        label: "Store",
        host: "127.0.0.1",
        status: "active",
        canWrite: true,
        agents: [],
      });
      expect(conn.hiddenSuggestion).toEqual(["public.customers.ssn"]);
      const byUrl = (
        await call(ana, "POST", url("/databases"), {
          provider: "neon",
          url: "postgres://reader:s3cret@127.0.0.1:6543/shop?sslmode=disable",
        })
      ).body.connection;
      expect(byUrl).toMatchObject({
        host: "127.0.0.1",
        database: "shop",
        username: "reader",
        label: "shop @ 127.0.0.1",
      });
      expect(
        (await call(ana, "POST", url("/databases"), { provider: "other", url: "mysql://x@y/z" })).body.error
          .code,
      ).toBe("database.invalid_url");
      const listed = await call(beto, "GET", url("/databases"));
      expect(listed.body.connections.map((d: { label: string }) => d.label)).toEqual([
        "Store",
        "shop @ 127.0.0.1",
      ]);

      expect((await call(ana, "GET", url(`/databases/${conn.id}/tables`))).body.tables).toEqual([
        { schema: "public", name: "Suppliers" },
        { schema: "public", name: "customers" },
        { schema: "public", name: "orders" },
        { schema: "public", name: "secrets" },
      ]);
      expect((await call(beto, "GET", url(`/databases/${conn.id}/tables`))).status).toBe(403);

      const updated = await call(ana, "PATCH", url(`/databases/${conn.id}`), {
        label: "Online store",
        disabledActions: ["describe"],
      });
      expect(updated.body.connection).toMatchObject({ label: "Online store", disabledActions: ["describe"] });
      expect(
        (await call(ana, "PATCH", url(`/databases/${conn.id}`), { password: "another" })).body.connection
          .status,
      ).toBe("active");

      expect((await call(ana, "DELETE", url(`/databases/${byUrl.id}`))).status).toBe(204);
      expect(
        (await call(ana, "GET", url("/databases"))).body.connections.map((d: { id: string }) => d.id),
      ).toEqual([conn.id]);
    },
    SERVER_TEST_MS,
  );

  test(
    "agent: policy, tables, hidden columns, read only, one statement, quota and turned-off action",
    async () => {
      const { ana, beto, lia, ask, url } = await team();
      const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Store" })).body
        .connection;
      expect((await call(ana, "GET", url(`/agents/${lia.id}/databases`))).body.databases).toEqual([]);
      expect(
        (await call(beto, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" })).status,
      ).toBe(403);
      const link = await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), {
        level: "read",
        policy: { tables: ["customers", "PUBLIC.Orders", '"Suppliers"'], queriesPerDay: 4 },
      });
      // A name SQL would not read as one table or column is refused, not stored as something else.
      for (const policy of [
        { tables: ['"customers'] },
        { tables: ["my-table"] },
        { tables: ["a.b.c"] },
        { tables: ['""'] },
        { tables: ["public."] },
        { maskedColumns: ["ssn"] },
        { maskedColumns: ['customers."ssn'] },
      ])
        expect(
          (await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read", policy }))
            .status,
        ).toBe(400);
      // Read as SQL reads them: unquoted names fold, a quoted one keeps its capital.
      expect(link.body.policy).toEqual({
        tables: ["public.customers", "public.orders", 'public."Suppliers"'],
        maskedColumns: ["public.customers.ssn"],
        queriesPerDay: 4,
        timeoutSeconds: 30,
      });
      expect(
        (await call(beto, "GET", url(`/agents/${lia.id}/databases`))).body.databases.map(
          (d: { level: string }) => d.level,
        ),
      ).toEqual(["read"]);
      expect((await call(ana, "GET", url("/databases"))).body.connections[0]?.agents).toEqual([
        { agentId: lia.id, level: "read" },
      ]);
      expect(await hasDatabases(server.deps.db, lia.id)).toBe(true);

      expect(await ask("db_list_tables", { database: "Store" })).toContain("public.customers\npublic.orders");
      const described = await ask("db_describe_table", { database: "Store", table: "customers" });
      expect(described).toContain("name");
      expect(described).not.toContain("ssn");
      // A table with a capital letter in its name is named as in SQL, quoted.
      expect(await ask("db_describe_table", { database: "Store", table: '"Suppliers"' })).toContain(
        "company",
      );
      expect(await ask("db_describe_table", { database: "Store", table: "Suppliers" })).toContain(
        "The table public.suppliers is not available to you.",
      );

      const rows = await ask("db_query", {
        database: "Store",
        sql: "select c.name, o.total from customers c join orders o on o.customer_id = c.id order by o.id;",
      });
      expect(rows).toContain("2 row(s)");
      expect(rows).toContain("Joana\t99.5");
      expect(await ask("db_query", { database: "Store", sql: "select * from customers" })).toContain(
        "public.customers.ssn is hidden",
      );
      expect(await ask("db_query", { database: "Store", sql: "select x from secrets" })).toContain(
        "public.secrets is not available",
      );
      expect(
        await ask("db_query", { database: "Store", sql: "delete from customers where id = 2" }),
      ).toContain("Only reading");
      expect(await ask("db_query", { database: "Store", sql: "select 1; select 2" })).toContain(
        "one statement",
      );
      expect((await pg.query("select count(*)::int as n from customers")).rows).toEqual([{ n: 2 }]);

      // 4 a day: the ones the plan rejected count (they went to the database); the ones the text alone rejected
      // (the delete, the two statements) never got there.
      expect(await ask("db_query", { database: "Store", sql: "select name from customers" })).toContain(
        "2 row(s)",
      );
      expect(await ask("db_query", { database: "Store", sql: "select name from customers" })).toContain(
        "Daily limit of 4",
      );

      await call(ana, "PATCH", url(`/databases/${conn.id}`), { disabledActions: ["tables"] });
      expect(await ask("db_list_tables", { database: "Store" })).toContain("turned off");

      await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "none" });
      expect(await ask("db_list_tables", { database: "Store" })).toContain("Unknown database");
      expect(await hasDatabases(server.deps.db, lia.id)).toBe(false);
      await call(ana, "DELETE", url(`/databases/${conn.id}`));
      expect((await call(ana, "GET", url(`/agents/${lia.id}/databases`))).body.databases).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("the guard and the network rule on a connected database", () => {
  test(
    "a read query runs through the tool; every way of writing is rejected and nothing changes",
    async () => {
      const { ana, lia, ask, url } = await team();
      const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Shop" })).body
        .connection;
      await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), {
        level: "read",
        policy: { tables: ["customers", "orders"], queriesPerDay: null },
      });
      expect(
        await ask("db_query", { database: "Shop", sql: "select id, name from customers order by id" }),
      ).toBe("2 row(s)\nid\tname\n1\tJoana\n2\tRui");
      for (const sql of [
        "update customers set name = 'x'",
        "insert into orders values (99, 1, 1)",
        "with gone as (delete from orders returning *) select * from gone",
        "select * into copied from orders",
        "select id from orders for update",
        "truncate orders",
        "commit; delete from orders",
        "set transaction read write",
      ])
        expect(await ask("db_query", { database: "Shop", sql })).toMatch(/Only reading|one statement/);
      expect(
        await ask("db_query", { database: "Shop", sql: "select pg_read_file('/etc/passwd')" }),
      ).toContain("The function pg_read_file is not allowed");
      expect((await pg.query("select count(*)::int as n from orders")).rows).toEqual([{ n: 2 }]);
      expect((await pg.query("select name from customers order by id")).rows).toEqual([
        { name: "Joana" },
        { name: "Rui" },
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "an internal host and a plain-text connection are rejected under the installation's rule, before connecting",
    async () => {
      const { ana, url } = await team();
      let opened = 0;
      const counting: GuardedConnector = async (t) => {
        opened++;
        return pgliteGuardedConnector(pg)(t);
      };
      await withConnector(counting, () =>
        withNetRule({ allowPrivateNetworks: false, allowPlaintext: false }, async () => {
          for (const host of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "localhost"]) {
            const res = await call(ana, "POST", url("/databases"), {
              ...connectInput,
              host,
              sslmode: "require",
            });
            expect([host, res.status, res.body.error.code]).toEqual([host, 400, "blocked_host"]);
          }
          const plain = await call(ana, "POST", url("/databases"), { ...connectInput, host: "8.8.8.8" });
          expect([plain.status, plain.body.error.code]).toEqual([400, "tls_required"]);
          const byUrl = await call(ana, "POST", url("/databases"), {
            provider: "other",
            url: "postgres://u:p@192.168.1.20:5432/db",
          });
          expect(byUrl.body.error.code).toBe("blocked_host");
        }),
      );
      expect(opened).toBe(0);
      expect((await call(ana, "GET", url("/databases"))).body.connections).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a saved database whose host is internal now is rejected at query time too",
    async () => {
      const { ana, lia, ask, url } = await team();
      const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Local" })).body
        .connection;
      await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" });
      await withNetRule({ allowPrivateNetworks: false, allowPlaintext: true }, async () => {
        expect(await ask("db_query", { database: "Local", sql: "select name from customers" })).toBe(
          "That address is on a private network",
        );
        expect((await call(ana, "GET", url(`/databases/${conn.id}/tables`))).body.error.code).toBe(
          "blocked_host",
        );
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "the password never comes back: not in a response, an error or a tool result",
    async () => {
      const { ana, lia, ask, url } = await team();
      const pw = connectInput.password;
      const conn = await call(ana, "POST", url("/databases"), { ...connectInput, label: "Echo" });
      expect(JSON.stringify(conn.body)).not.toContain(pw);
      const [row] = await server.deps.db
        .select()
        .from(schema.dataSources)
        .where(eq(schema.dataSources.id, conn.body.connection.id));
      expect(row?.secret).not.toContain(pw);
      await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.body.connection.id}`), {
        level: "read",
      });
      const listed = JSON.stringify([
        (await call(ana, "GET", url("/databases"))).body,
        (await call(ana, "GET", url(`/agents/${lia.id}/databases`))).body,
      ]);
      expect(listed).not.toContain(pw);

      // A server that echoes what it got, the password included, in its errors.
      const echo =
        (where: "connect" | "query"): GuardedConnector =>
        async (t) => {
          if (where === "connect")
            throw new Error(`connect failed for ${t.username}:${t.password}@${t.host}`);
          return {
            readOnly: (_ms, fn) =>
              fn({
                rows: async () => [],
                explain: async () => {
                  throw new Error(
                    `syntax error near "${t.password}" (${Buffer.from(t.password).toString("base64")})`,
                  );
                },
                run: async () => ({ fields: [], rows: [] }),
              }),
            close: async () => {},
          };
        };
      await withConnector(echo("connect"), async () => {
        const failed = await call(ana, "POST", url("/databases"), { ...connectInput, label: "Echo 2" });
        expect(failed.body.error.code).toBe("database.unreachable");
        expect(failed.body.error.message).toContain("[redacted]");
        expect(JSON.stringify(failed.body)).not.toContain(pw);
        const tables = await call(ana, "GET", url(`/databases/${conn.body.connection.id}/tables`));
        expect(JSON.stringify(tables.body)).not.toContain(pw);
        const result = await ask("db_query", { database: "Echo", sql: "select name from customers" });
        expect(result).toContain("[redacted]");
        expect(result).not.toContain(pw);
      });
      await withConnector(echo("query"), async () => {
        const result = await ask("db_query", { database: "Echo", sql: "select name from customers" });
        expect(result).toStartWith("syntax error near");
        expect(result).not.toContain(pw);
        expect(result).not.toContain(Buffer.from(pw).toString("base64"));
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "another workspace's database and agent are 404 on every route, and its agent can't reach the database",
    async () => {
      const one = await team();
      const two = await team();
      const conn = (await call(one.ana, "POST", one.url("/databases"), connectInput)).body.connection;
      await call(one.ana, "PUT", one.url(`/agents/${one.lia.id}/databases/${conn.id}`), { level: "read" });
      const probes: [string, string, unknown?][] = [
        ["PATCH", `/databases/${conn.id}`, { label: "Mine" }],
        ["DELETE", `/databases/${conn.id}`],
        ["GET", `/databases/${conn.id}/tables`],
        ["PUT", `/agents/${two.lia.id}/databases/${conn.id}`, { level: "read" }],
        ["PUT", `/agents/${one.lia.id}/databases/${conn.id}`, { level: "none" }],
        ["GET", `/agents/${one.lia.id}/databases`],
      ];
      for (const [method, path, payload] of probes) {
        const res = await call(two.ana, method, two.url(path), payload);
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
      // The path's workspace is the caller's own: someone outside workspace one can't use its prefix.
      expect((await call(two.ana, "GET", one.url("/databases"))).status).toBe(404);
      expect((await call(two.ana, "GET", two.url("/databases"))).body.connections).toEqual([]);
      expect((await call(one.ana, "GET", one.url("/databases"))).body.connections[0]).toMatchObject({
        id: conn.id,
        label: "postgres @ 127.0.0.1",
        agents: [{ agentId: one.lia.id, level: "read" }],
      });
      // A link written by hand across workspaces still gives the other workspace's agent nothing.
      await server.deps.db.insert(schema.agentDatabases).values({
        agentId: two.lia.id,
        connectionId: conn.id,
        workspaceId: two.workspaceId,
        level: "read",
        policy: { tables: ["public.customers"], maskedColumns: [], queriesPerDay: null, timeoutSeconds: 15 },
      });
      expect(await two.ask("db_query", { database: conn.id, sql: "select name from customers" })).toContain(
        "Unknown database. Available: none",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "a channel rule turns the databases off in that channel only",
    async () => {
      const { ana, lia, channel, url, workspaceId } = await team();
      const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Ruled" })).body
        .connection;
      await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" });
      await server.deps.db.insert(schema.agentChannelAccess).values({
        agentId: lia.id,
        workspaceId,
        channelId: channel.id,
        connectionId: "*",
        level: "off",
      });
      const inGeneral = await toolRun(server.deps, lia, channel).run(DATABASE_TOOLS, "db_list_tables", {
        database: "Ruled",
      });
      expect(inGeneral.content).toContain("Unknown database");
      const elsewhere = { ...channel, id: "ch_elsewhere" };
      const there = await toolRun(server.deps, lia, elsewhere).run(DATABASE_TOOLS, "db_list_tables", {
        database: "Ruled",
      });
      expect(there.content).toContain("public.customers");
    },
    SERVER_TEST_MS,
  );

  test(
    "a catalog that can't be read fails the first read link instead of saving an empty policy",
    async () => {
      const { ana, lia, ask, url } = await team();
      const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Flaky" })).body
        .connection;
      const down: GuardedConnector = async () => {
        throw new Error("connection refused");
      };
      await withConnector(down, async () => {
        const res = await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" });
        expect([res.status, res.body.error.code]).toEqual([400, "database.unreachable"]);
      });
      expect((await call(ana, "GET", url(`/agents/${lia.id}/databases`))).body.databases).toEqual([]);
      // Back up: the same request reads the catalog and gives the tables.
      const link = await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" });
      expect(link.body.policy.tables).toContain("public.customers");
      expect(await ask("db_list_tables", { database: "Flaky" })).toContain("public.orders");
    },
    SERVER_TEST_MS,
  );

  test(
    "two result columns with one name are rejected instead of showing one value twice",
    async () => {
      const { ana, lia, ask, url } = await team();
      const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Twins" })).body
        .connection;
      await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" });
      expect(
        await ask("db_query", { database: "Twins", sql: "select id as v, name as v from customers" }),
      ).toBe("Two result columns have the same name; give each one its own alias.");
      expect(
        await ask("db_query", {
          database: "Twins",
          sql: "select id as a, name as b from customers order by id",
        }),
      ).toBe("2 row(s)\na\tb\n1\tJoana\n2\tRui");
    },
    SERVER_TEST_MS,
  );

  test(
    "the session itself stays read only: SET TRANSACTION READ WRITE sent first, past the text guard, can't reopen writes",
    async () => {
      const conn = await pgliteGuardedConnector(pg)({ ...connectInput, port: 5432 });
      await expect(
        conn.readOnly(5_000, async (s) => {
          await s.run("set transaction read write");
          await s.run("insert into secrets values ('written')");
        }),
      ).rejects.toThrow(/before any query|read-only transaction/);
      expect((await pg.query("select count(*)::int as n from secrets")).rows).toEqual([{ n: 0 }]);
    },
    SERVER_TEST_MS,
  );
});

describe("catalog names the policy keeps exactly", () => {
  test(
    "a table named with a space and capitals is queried through the agent, and a view by such a name still has its code checked",
    async () => {
      await pg.exec(
        `create table "Sales Report" (region text, "API_Key" text); insert into "Sales Report" values ('north', 'k-1');`,
      );
      try {
        const { ana, lia, ask, url, workspaceId, general } = await team();
        const conn = (await call(ana, "POST", url("/databases"), { ...connectInput, label: "Mixed" })).body
          .connection;
        expect(conn.hiddenSuggestion).toEqual(['public."Sales Report"."API_Key"', "public.customers.ssn"]);
        // The first policy, from the catalog: each name exactly as the database keeps it.
        const link = await call(ana, "PUT", url(`/agents/${lia.id}/databases/${conn.id}`), { level: "read" });
        expect(link.body.policy).toMatchObject({
          tables: [
            'public."Sales Report"',
            'public."Suppliers"',
            "public.customers",
            "public.orders",
            "public.secrets",
          ],
          maskedColumns: ['public."Sales Report"."API_Key"', "public.customers.ssn"],
        });
        expect(await ask("db_query", { database: "Mixed", sql: 'select region from "Sales Report"' })).toBe(
          "1 row(s)\nregion\nnorth",
        );
        expect(
          await ask("db_query", { database: "Mixed", sql: 'select "API_Key" from "Sales Report"' }),
        ).toContain('The column public."Sales Report"."API_Key" is hidden.');
        expect(await ask("db_describe_table", { database: "Mixed", table: 'public."Sales Report"' })).toBe(
          "region\ttext",
        );
        expect(
          await ask("db_query", { database: "Mixed", sql: "select name from customers order by id" }),
        ).toContain("2 row(s)");

        // A view by such a name whose rule calls customer code: the lookup finds it and the query is rejected
        // before planning (an allowed relation with customer code rejects every query, as for any view).
        await pg.exec(`
          create function public.leak(t text) returns text language plpgsql as $$
            begin raise exception 'customer function ran'; end $$;
          create view "Sales View" as select region, public.leak(region) as l from "Sales Report";
        `);
        const kai = await seedAgent(server, workspaceId, ana, `kai${n}`, [general]);
        await call(ana, "PUT", url(`/agents/${kai.id}/databases/${conn.id}`), { level: "read" });
        const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
        if (!channel) throw new Error("no channel");
        const viewed = await toolRun(server.deps, kai, channel).run(DATABASE_TOOLS, "db_query", {
          database: "Mixed",
          sql: 'select region from "Sales View"',
        });
        expect(viewed.content).toBe("The function public.leak (used by an allowed relation) is not allowed.");
      } finally {
        await pg.exec(
          `drop view if exists "Sales View"; drop function if exists public.leak(text); drop table "Sales Report";`,
        );
      }
    },
    SERVER_TEST_MS,
  );
});

describe("the Postgres connection's options", () => {
  const target = {
    host: "db.example.test",
    port: 6543,
    database: "shop",
    username: "reader",
    password: "",
    sslmode: "require" as const,
  };

  test("the checked address and port go as one-element lists: an IPv6 address is never split on ':'", () => {
    const opts = postgresOptions({ ...target, address: "2001:db8::5" }) as unknown as {
      host: string[];
      port: number[];
      ssl: { servername?: string; rejectUnauthorized: boolean };
    };
    expect([opts.host, opts.port]).toEqual([["2001:db8::5"], [6543]]);
    // The TLS name is still the host the person entered, not the address.
    expect(opts.ssl).toEqual({ rejectUnauthorized: false, servername: "db.example.test" });
    const byIp = postgresOptions({ ...target, host: "203.0.113.7", sslmode: "verify-full" }) as unknown as {
      host: string[];
      ssl: { servername?: string; rejectUnauthorized: boolean };
    };
    expect([byIp.host, byIp.ssl]).toEqual([["203.0.113.7"], { rejectUnauthorized: true }]);
    expect(postgresOptions({ ...target, sslmode: "disable" }).ssl).toBe(false);
  });

  test("an empty password stays empty: it is a function, so the installation's PGPASSWORD never fills it", async () => {
    const before = process.env.PGPASSWORD;
    process.env.PGPASSWORD = "installation-secret";
    try {
      const { password } = postgresOptions(target);
      expect(typeof password).toBe("function");
      expect(await password()).toBe("");
      expect(await postgresOptions({ ...target, password: "mine" }).password()).toBe("mine");
    } finally {
      if (before === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = before;
    }
  });
});
