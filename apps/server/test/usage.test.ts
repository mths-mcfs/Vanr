// The integrations' daily quota is atomic: N requests at once at the limit don't go past it. Before, each one
// counted the use and then wrote it; they all read the same total and all passed. The db_query runs are built by
// hand (integration-run.ts) until the runtime comes; each one is a run of its own, and they run together.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { memoryPostgres } from "@vanr/engine/sqlconn";
import { count, eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { DATABASE_TOOLS } from "../src/integrations/databases";
import { pgliteGuardedConnector } from "../src/integrations/sql-identity";
import { reserveUsage } from "../src/integrations/usage";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { toolRun } from "./integration-run";
import { call, seedAgent, ws } from "./route-calls";
import { seedWorkspace } from "./seed";

let pg: Awaited<ReturnType<typeof memoryPostgres>>;
let server: RunningServer;
beforeAll(async () => {
  pg = await memoryPostgres();
  await pg.exec("create table items (id int primary key, name text); insert into items values (1, 'a');");
  server = await startTestServer({
    env: { ALLOW_PRIVATE_NETWORKS: "true" },
    sql: pgliteGuardedConnector(pg),
  });
}, 120_000);
afterAll(async () => {
  await server.stop();
  await pg.close();
}, SERVER_TEST_MS);

async function burst(cap: number, n: number) {
  const ana = await signedIn(server, "Ana", `ana${cap}-${n}@burst.test`);
  const { workspaceId } = await seedWorkspace(server, ana, "Burst");
  const input = { workspaceId, agentId: `agt_${cap}_${n}`, resourceId: "res_1", kind: "db_query" as const };
  const ids = await Promise.all(
    Array.from({ length: n }, () => reserveUsage(server.deps, { ...input, cap })),
  );
  const [row] = await server.deps.db
    .select({ n: count() })
    .from(schema.integrationUsage)
    .where(eq(schema.integrationUsage.agentId, input.agentId));
  return { granted: ids.filter(Boolean).length, stored: row?.n ?? 0 };
}

describe("reserving quota in parallel", () => {
  test(
    "PGlite: 20 requests with a cap of 5 give 5",
    async () => {
      expect(await burst(5, 20)).toEqual({ granted: 5, stored: 5 });
      expect(await burst(0, 3)).toEqual({ granted: 0, stored: 0 });
    },
    SERVER_TEST_MS,
  );
});

describe("db_query in parallel runs", () => {
  test(
    "6 runs of the same agent query at once with a cap of 2: only 2 queries pass",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@quota.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Quota");
      const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      if (!channel) throw new Error("no channel");
      const conn = await call(ana, "POST", `${ws(workspaceId)}/databases`, {
        provider: "other",
        label: "Stock",
        host: "127.0.0.1",
        database: "postgres",
        username: "postgres",
        password: "db-password",
        sslmode: "disable",
      });
      await call(ana, "PUT", `${ws(workspaceId)}/agents/${lia.id}/databases/${conn.body.connection.id}`, {
        level: "read",
        policy: { tables: ["items"], queriesPerDay: 2 },
      });
      const results = await Promise.all(
        Array.from(
          { length: 6 },
          async () =>
            (
              await toolRun(server.deps, lia, channel).run(DATABASE_TOOLS, "db_query", {
                database: "Stock",
                sql: "select name from items",
              })
            ).content,
        ),
      );
      expect(results.filter((r) => r.includes("1 row(s)")).length).toBe(2);
      expect(results.filter((r) => r.includes("Daily limit of 2")).length).toBe(4);
    },
    SERVER_TEST_MS,
  );
});
