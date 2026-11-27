// The databases integration on a real Postgres as the customer's database, through the server's own connector
// (postgres.js, one connection per use): connect over the route, a read query through the tool, the guard and the
// read-only transaction against a write, and the statement timeout. Only in the CI `postgres` job.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { channelInWorkspace } from "../src/channels";
import { DATABASE_TOOLS } from "../src/integrations/databases";
import { postgresGuardedConnector } from "../src/integrations/sql-identity";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { toolRun } from "./integration-run";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { call, seedAgent, ws } from "./route-calls";
import { seedWorkspace } from "./seed";

const run = test.skipIf(!TEST_POSTGRES_URL);
let customer = "";
let server: RunningServer;
beforeAll(async () => {
  if (!TEST_POSTGRES_URL) return;
  customer = await testDatabaseUrl("vanr_customer");
  const admin = postgres(customer, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`
      create table customers (id int primary key, name text, ssn text);
      insert into customers values (1, 'Joana', '111'), (2, 'Rui', '222');
    `);
  } finally {
    await admin.end({ timeout: 5 });
  }
  // No `sql` option: the server's own connector to a real Postgres.
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" } });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server?.stop();
}, SERVER_TEST_MS);

const target = () => {
  const u = new URL(customer);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    sslmode: "disable" as const,
  };
};

describe(`a real Postgres as the customer's database (${TEST_POSTGRES_URL ? "postgres" : NO_POSTGRES})`, () => {
  run(
    "Postgres: connect, a read query through the tool, a write rejected and the data unchanged",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@databases-postgres.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
      const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      if (!channel) throw new Error("no channel");
      const created = await call(ana, "POST", `${ws(workspaceId)}/databases`, {
        provider: "other",
        label: "Real",
        ...target(),
      });
      expect(created.status).toBe(201);
      expect(created.body.connection.hiddenSuggestion).toEqual(["public.customers.ssn"]);
      await call(ana, "PUT", `${ws(workspaceId)}/agents/${lia.id}/databases/${created.body.connection.id}`, {
        level: "read",
      });
      const ask = async (sql: string) =>
        (await toolRun(server.deps, lia, channel).run(DATABASE_TOOLS, "db_query", { database: "Real", sql }))
          .content;
      expect(await ask("select id, name from customers order by id")).toBe(
        "2 row(s)\nid\tname\n1\tJoana\n2\tRui",
      );
      expect(await ask("select ssn from customers")).toContain("is hidden");
      expect(await ask("delete from customers")).toContain("Only reading");
      const check = postgres(customer, { max: 1, onnotice: () => {} });
      try {
        expect([...(await check`select count(*)::int as n from customers`)]).toEqual([{ n: 2 }]);
      } finally {
        await check.end({ timeout: 5 });
      }
    },
    SERVER_TEST_MS,
  );

  run(
    "Postgres: the connector's session is read only and holds the statement timeout",
    async () => {
      const conn = await postgresGuardedConnector(target());
      try {
        await expect(
          conn.readOnly(5_000, (s) => s.run("insert into customers values (3, 'Eve', '333')")),
        ).rejects.toThrow(/read-only transaction/);
        await expect(conn.readOnly(200, (s) => s.rows("select pg_sleep(2)", []))).rejects.toThrow(
          /statement timeout/,
        );
        // Sent first in the session, past the text guard: the transaction is already sealed read only.
        await expect(
          conn.readOnly(5_000, async (s) => {
            await s.run("set transaction read write");
            await s.run("insert into customers values (4, 'Mal', '444')");
          }),
        ).rejects.toThrow(/before any query|read-only transaction/);
        expect(
          await conn.readOnly(5_000, (s) => s.rows("select count(*)::int as n from customers", [])),
        ).toEqual([{ n: 2 }]);
      } finally {
        await conn.close();
      }
    },
    SERVER_TEST_MS,
  );
});
