// The agent routes follow the channel rules: a delegation from a private channel, a live run there and an agent's
// spend don't show to whoever can't see them, and an archived agent takes no writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActiveRun } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
/** Live runs the fake runtime reports on top of the real ones, with the workspace of each. */
const live: (ActiveRun & { workspaceId: string })[] = [];
let completes = 0;

beforeAll(async () => {
  server = await startTestServer({
    runtime: (port) => ({
      ...port,
      activeRuns: (filter) => [
        ...port.activeRuns(filter),
        ...live.filter(
          (r) =>
            r.workspaceId === filter.workspaceId && (!filter.channelId || r.channelId === filter.channelId),
        ),
      ],
      complete: (input) => {
        completes++;
        return port.complete(input);
      },
    }),
  });
}, SERVER_TEST_MS);

afterAll(() => server.stop(), SERVER_TEST_MS);

let seq = 0;
const email = (who: string) => `${who}${++seq}@agent-access.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana);
  const carla = await memberOf(server, workspaceId, "Carla", email("carla"), "admin");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const secret = await seedChannel(server, workspaceId, {
    name: "secret",
    visibility: "private",
    members: [ana],
  });
  const lia = await seedAgent(server, workspaceId, beto, "lia", [general]);
  const helper = await seedAgent(server, workspaceId, ana, "helper");
  return { w: ws(workspaceId), workspaceId, general, secret, ana, carla, beto, lia, helper };
}

type Team = Awaited<ReturnType<typeof team>>;

async function insertRun(t: Team, values: Partial<typeof schema.runs.$inferInsert> & { agentId: string }) {
  const id = newId("run");
  await server.deps.db
    .insert(schema.runs)
    .values({ id, workspaceId: t.workspaceId, status: "done", model: "claude-haiku-5-5", ...values });
  return id;
}

/** A delegation lia asked helper from #secret: lia's run in the channel and helper's run with no channel. */
async function delegationFromSecret(t: Team) {
  const askingRun = await insertRun(t, { agentId: t.lia.id, channelId: t.secret, what: "board prep" });
  const delegateRun = await insertRun(t, {
    agentId: t.helper.id,
    channelId: null,
    sourceChannelId: t.secret,
    what: "@lia: merger terms",
  });
  await server.deps.db.insert(schema.delegations).values({
    id: newId("cons"),
    workspaceId: t.workspaceId,
    requesterAgentId: t.lia.id,
    delegateAgentId: t.helper.id,
    runId: askingRun,
    channelId: t.secret,
    question: "merger terms",
    status: "answered",
  });
  return delegateRun;
}

describe("a delegation asked from a private channel", () => {
  test(
    "GET /runs lists it only to whoever reads the channel, like the run's detail",
    async () => {
      const t = await team();
      const runId = await delegationFromSecret(t);
      const listed = async (who: Person) =>
        (await call(who, "GET", `${t.w}/runs?agentId=${t.helper.id}`)).body.runs.map(
          (r: { id: string; what: string }) => [r.id, r.what],
        );
      expect(await listed(t.ana)).toEqual([[runId, "@lia: merger terms"]]);
      expect(await listed(t.beto)).toEqual([]);
      expect(await listed(t.carla)).toEqual([]);
      // The list and the detail say the same.
      expect((await call(t.ana, "GET", `${t.w}/runs/${runId}`)).status).toBe(200);
      expect((await call(t.carla, "GET", `${t.w}/runs/${runId}`)).status).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "GET /team shows it only to whoever reads the channel it was asked from",
    async () => {
      const t = await team();
      await delegationFromSecret(t);
      const delegations = async (who: Person) => (await call(who, "GET", `${t.w}/team`)).body.delegations;
      expect(await delegations(t.ana)).toMatchObject([
        { requesterAgentId: t.lia.id, delegateAgentId: t.helper.id, status: "answered" },
      ]);
      expect(await delegations(t.beto)).toEqual([]);
      expect(await delegations(t.carla)).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("an agent working in a private channel", () => {
  test(
    "is busy only for whoever may see the live run, on the list, the profile and the team",
    async () => {
      const t = await team();
      const runId = await insertRun(t, { agentId: t.lia.id, channelId: t.secret, status: "running" });
      live.push({
        workspaceId: t.workspaceId,
        runId,
        status: "running",
        agentId: t.lia.id,
        channelId: t.secret,
        threadId: null,
        startedAt: new Date().toISOString(),
        lastPingAt: new Date().toISOString(),
        sourceMessageId: "msg_fake",
        initiatedBy: t.ana.user.id,
        browser: false,
      });
      try {
        const busy = async (who: Person) => {
          const list = (await call(who, "GET", `${t.w}/agents`)).body.agents;
          const crew = (await call(who, "GET", `${t.w}/team`)).body.agents;
          return [
            list.find((a: { id: string }) => a.id === t.lia.id)?.busy,
            (await call(who, "GET", `${t.w}/agents/${t.lia.id}`)).body.busy,
            crew.find((a: { id: string }) => a.id === t.lia.id)?.busy,
          ];
        };
        expect(await busy(t.ana)).toEqual([true, true, true]);
        expect(await busy(t.beto)).toEqual([false, false, false]);
        expect(await busy(t.carla)).toEqual([false, false, false]);
      } finally {
        live.length = 0;
      }
    },
    SERVER_TEST_MS,
  );
});

describe("an archived agent", () => {
  test(
    "refuses the harness, skills, channels, identity, repositories, scopes and access writes, and changes nothing",
    async () => {
      const t = await team();
      const base = `${t.w}/agents/${t.lia.id}`;
      const skill = await call(t.ana, "POST", `${t.w}/skills`, {
        name: "Triage",
        description: "x",
        body: "1.",
      });
      expect(skill.status).toBe(201);
      const ops = await seedChannel(server, t.workspaceId, { name: "ops", members: [t.ana] });
      expect((await call(t.ana, "DELETE", base)).status).toBe(204);

      const writes = [
        call(t.ana, "PUT", `${base}/runtime`, { harness: "model", model: "claude-opus-5-5" }),
        call(t.ana, "PUT", `${base}/skills`, { skills: [{ id: skill.body.id, enabled: true }] }),
        call(t.ana, "PUT", `${base}/channels`, { channels: [{ channelId: ops, autoAnswer: true }] }),
        call(t.ana, "POST", `${base}/identity/connections`, {}),
        call(t.ana, "PUT", `${base}/identity/channels`, { channels: [] }),
        call(t.ana, "PUT", `${base}/repositories`, { repositories: ["acme/app"] }),
        call(t.ana, "PUT", `${base}/scopes`, { scopes: [] }),
        call(t.ana, "PUT", `${base}/access`, {}),
        // The owner without manage_agents gets the same answer.
        call(t.beto, "PUT", `${base}/runtime`, { harness: "model", fallback: false }),
      ];
      for (const res of await Promise.all(writes))
        expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);

      const after = (await call(t.ana, "GET", base)).body;
      expect(after.model).toBe("claude-haiku-5-5");
      expect(after.channels.map((ch: { id: string }) => ch.id)).toEqual([t.general]);
      expect((await call(t.ana, "GET", `${base}/repositories`)).body.repositories).toEqual([]);
      const skills = (await call(t.ana, "GET", `${base}/skills`)).body.skills;
      expect(skills.find((s: { id: string }) => s.id === skill.body.id)?.enabled).toBe(false);
    },
    SERVER_TEST_MS,
  );

  test(
    "doesn't draft a skill from its run: the model isn't called and nothing is spent",
    async () => {
      const t = await team();
      const runId = await insertRun(t, { agentId: t.lia.id, channelId: t.general, what: "triage" });
      await server.deps.db
        .insert(schema.runEvents)
        .values({ runId, seq: 1, kind: "text", data: { text: "Done." } });
      await server.deps.db
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, t.lia.id));
      const before = completes;
      const res = await call(t.ana, "POST", `${t.w}/runs/${runId}/skill-draft`);
      expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);
      expect(completes).toBe(before);
    },
    SERVER_TEST_MS,
  );
});

describe("an agent's spend on its profile", () => {
  test(
    "shows only to whoever may view usage, as GET /usage: the owner and the other members get nulls",
    async () => {
      const t = await team();
      await insertRun(t, { agentId: t.lia.id, channelId: t.secret, costUsd: 2, inputTokens: 10 });
      const spend = async (who: Person) => {
        const d = (await call(who, "GET", `${t.w}/agents/${t.lia.id}`)).body;
        return [
          d.costThisMonthUsd,
          d.budgetPerMonthUsd,
          d.budgetSpentPct,
          d.inheritedBudgetUsd,
          d.monthRuns,
          d.monthTokens,
        ];
      };
      const hidden = [null, null, null, null, null, null];
      expect(await spend(t.beto)).toEqual(hidden);
      expect((await call(t.beto, "GET", `${t.w}/usage`)).status).toBe(403);
      const admin = await spend(t.carla);
      expect(admin[0]).toBe(2);
      expect(admin[4]).toBe(1);
      expect(admin.every((v) => typeof v === "number")).toBe(true);
    },
    SERVER_TEST_MS,
  );
});
