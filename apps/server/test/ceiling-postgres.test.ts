// Ported from the origin's cap test, on a real Postgres: runs at once for the same agent (or the same channel), each
// holding the worst-case reservation while the model answers slowly. The reservation locks the counter's row, so
// only the ones that fit the cap go through; the rest stop without calling the model. PGlite runs one transaction
// at a time, so only here does the lock show. CI postgres job only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq, ne } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { call, seedAgent, ws } from "./route-calls";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const { runs, usageLines, usageReservations, budgetCounters, agents, channels } = schema;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("a cap with an atomic reservation on Postgres"), () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("ceiling") } });
  }, 4 * SERVER_TEST_MS);
  afterAll(() => server?.stop(), SERVER_TEST_MS);

  /** The worst case one call reserves, and what it really cost, from one turn of the agent. */
  async function measure(
    workspaceId: string,
    general: string,
    who: Parameters<typeof call>[0],
    handle: string,
  ) {
    const path = `${ws(workspaceId)}/channels/${general}/messages`;
    expect((await call(who, "POST", path, { body: `@${handle} hi`, clientId: `m0-${handle}` })).status).toBe(
      201,
    );
    await settle(server);
    const [held] = await server.deps.db
      .select()
      .from(usageReservations)
      .where(eq(usageReservations.workspaceId, workspaceId));
    const [first] = await server.deps.db.select().from(runs).where(eq(runs.workspaceId, workspaceId));
    return {
      estimate: (held?.estimateMicros ?? 0) / 1_000_000,
      spent: first?.costUsd ?? 0,
      runId: first?.id ?? "",
      path,
    };
  }

  test(
    "6 runs at once at the limit: only the reservations that fit go through; the spend doesn't pass the cap",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@cap.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Cap");
      const ivo = await seedAgent(server, workspaceId, ana, "ivo", [general]);
      const first = await measure(workspaceId, general, ana, ivo.handle);
      expect(first.estimate).toBeGreaterThan(0.005);
      expect(first.spent).toBeLessThan(first.estimate / 10);
      // Two worst-case reservations fit, three don't.
      const limit = first.spent + first.estimate * 2.5;
      await server.deps.db.update(agents).set({ budgetPerMonthUsd: limit }).where(eq(agents.id, ivo.id));

      // Six conversations (threads) at once, each with the slow model holding its reservation.
      const roots = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          call(ana, "POST", first.path, { body: `request ${i}`, clientId: `r${i}` }),
        ),
      );
      await Promise.all(
        roots.map((root, i) =>
          call(ana, "POST", first.path, {
            body: `@${ivo.handle} answer [[slow:400]]`,
            clientId: `t${i}`,
            threadId: root.body.id,
          }),
        ),
      );
      await settle(server);

      const all = await server.deps.db
        .select()
        .from(runs)
        .where(and(eq(runs.agentId, ivo.id), ne(runs.id, first.runId)));
      expect(all).toHaveLength(6);
      const stopped = all.filter((r) => r.status === "failed" && r.errorCode === "budget_exhausted");
      expect(all.filter((r) => r.status === "done")).toHaveLength(2);
      expect(stopped).toHaveLength(4);
      // Who stopped didn't call the model: no line in the ledger.
      for (const r of stopped)
        expect(await server.deps.db.select().from(usageLines).where(eq(usageLines.runId, r.id))).toEqual([]);
      // The recorded spend (the month's counter) is the sum of the lines and doesn't pass the cap.
      const lines = await server.deps.db
        .select()
        .from(usageLines)
        .where(eq(usageLines.workspaceId, workspaceId));
      const [counter] = await server.deps.db
        .select()
        .from(budgetCounters)
        .where(eq(budgetCounters.scope, `agent:${ivo.id}`));
      expect(counter?.spentMicros).toBe(lines.reduce((sum, l) => sum + l.costMicros, 0));
      expect((counter?.spentMicros ?? 0) / 1_000_000).toBeLessThanOrEqual(limit);
      const open = await server.deps.db
        .select()
        .from(usageReservations)
        .where(and(eq(usageReservations.workspaceId, workspaceId), eq(usageReservations.status, "open")));
      expect(open).toEqual([]);
    },
    4 * SERVER_TEST_MS,
  );

  test(
    "6 agents at once in the same channel: the channel's cap holds, the spend doesn't pass it",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@channel-cap.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Channel");
      const crew = [];
      for (let i = 0; i < 6; i++) {
        const agent = await seedAgent(server, workspaceId, ana, `ag${i}`, [general]);
        await server.deps.db.update(agents).set({ budgetPerMonthUsd: 100 }).where(eq(agents.id, agent.id));
        crew.push(agent);
      }
      const [lead] = crew;
      if (!lead) throw new Error("no agent");
      const first = await measure(workspaceId, general, ana, lead.handle);
      const limit = first.spent + first.estimate * 2.5;
      await server.deps.db.update(channels).set({ budgetPerMonthUsd: limit }).where(eq(channels.id, general));

      await Promise.all(
        crew.map((a, i) =>
          call(ana, "POST", first.path, { body: `@${a.handle} answer [[slow:400]]`, clientId: `c${i}` }),
        ),
      );
      await settle(server);
      const all = (await server.deps.db.select().from(runs).where(eq(runs.workspaceId, workspaceId))).filter(
        (r) => r.id !== first.runId,
      );
      expect(all).toHaveLength(6);
      expect(all.filter((r) => r.status === "done")).toHaveLength(2);
      expect(
        all.filter((r) => r.status === "failed" && r.errorCode === "channel_budget_exhausted"),
      ).toHaveLength(4);
      const [counter] = await server.deps.db
        .select()
        .from(budgetCounters)
        .where(eq(budgetCounters.scope, `channel:${general}`));
      expect((counter?.spentMicros ?? 0) / 1_000_000).toBeLessThanOrEqual(limit);
    },
    4 * SERVER_TEST_MS,
  );
});
