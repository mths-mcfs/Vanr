// The agent's assignment and runner tools on a real Postgres, where calls at once really interleave (PGlite runs
// one transaction at a time): reports at once all land in the assignment's notes (one statement each), and
// requests for a person in the browser at once make one (the check and the insert under the agent's row lock).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { createAssignment } from "../src/assignments/engine";
import { assignmentToolsFor } from "../src/assignments/tools";
import { environmentToolsFor } from "../src/runners/agent-tools";
import type { RunningServer } from "../src/server";
import { pairFake } from "./fake-runner";
import { SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import type { ProtocolRunner } from "./protocol-runner";
import { seedWorkspace } from "./seed";
import { seedAgent, toolRun } from "./tool-run";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const { agents, assignments, browserInterventions } = schema;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("the agent's tools on Postgres"), () => {
  let server: RunningServer;
  const open: ProtocolRunner[] = [];
  beforeAll(async () => {
    server = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("agent_tools") } });
  }, 2 * SERVER_TEST_MS);
  afterAll(async () => {
    for (const r of open) await r.close();
    await server?.stop();
  }, SERVER_TEST_MS);

  async function team(n: number) {
    const ana = await signedIn(server, "Ana", `ana${n}@agent-tools-postgres.test`);
    const { workspaceId, general } = await seedWorkspace(server, ana, "Tools");
    const lia = await seedAgent(server, workspaceId, ana, { name: "Lia", channels: [general] });
    const fake = await pairFake(server, ana, workspaceId, { browser: true, open });
    await server.deps.db.update(agents).set({ environmentId: fake.runnerId }).where(eq(agents.id, lia.id));
    const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, lia.id));
    if (!agent) throw new Error("agent gone");
    return { ana, workspaceId, general, agent };
  }

  test(
    "ten reports at once all land in the assignment's notes",
    async () => {
      const t = await team(1);
      const row = await createAssignment(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.agent.id,
        agentHandle: t.agent.handle,
        channelId: t.general,
        ownerId: t.ana.user.id,
        title: "Notes",
        goal: "Keep every finding",
        executor: "agent",
        runnerId: null,
        commandPolicy: "never",
      });
      await server.deps.db.update(assignments).set({ status: "active" }).where(eq(assignments.id, row.id));
      const tools = await assignmentToolsFor(server.deps, t.agent, row.threadId);
      const runs = await Promise.all(
        Array.from({ length: 10 }, () =>
          toolRun(server, {
            workspaceId: t.workspaceId,
            agent: t.agent,
            channelId: t.general,
            asker: t.ana,
            tools,
          }),
        ),
      );
      const outs = await Promise.all(
        runs.map((r, i) => r.call("report", { text: `finding ${i}` }, { threadId: row.threadId })),
      );
      expect(outs.every((o) => !o.isError)).toBe(true);
      const [noted] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
      expect(noted?.findings.map((f) => f.text).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `finding ${i}`).sort(),
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "five requests for a person in the browser at once make one",
    async () => {
      const t = await team(2);
      const tools = await environmentToolsFor({ deps: server.deps, agent: t.agent });
      const stops = Array.from({ length: 5 }, () => new AbortController());
      const runs = await Promise.all(
        stops.map(() =>
          toolRun(server, {
            workspaceId: t.workspaceId,
            agent: t.agent,
            channelId: t.general,
            asker: t.ana,
            tools,
          }),
        ),
      );
      const calls = runs.map((r, i) =>
        r.call(
          "browser_ask_person",
          { kind: "login", instructions: "Sign in" },
          { signal: (stops[i] as AbortController).signal },
        ),
      );
      await waitFor(async () => {
        const rows = await server.deps.db
          .select()
          .from(browserInterventions)
          .where(eq(browserInterventions.agentId, t.agent.id));
        return rows.length > 0 && rows.every((x) => !!x.messageId);
      });
      for (const stop of stops) stop.abort();
      const outs = await Promise.all(calls);
      expect(outs.filter((o) => o.content.includes("already asked")).length).toBe(4);
      const rows = await server.deps.db
        .select()
        .from(browserInterventions)
        .where(eq(browserInterventions.agentId, t.agent.id));
      expect(rows.length).toBe(1);
    },
    SERVER_TEST_MS,
  );
});
