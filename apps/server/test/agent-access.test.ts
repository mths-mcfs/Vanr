// The agent routes follow the channel and runner rules: a delegation from a private channel, a live run there, an
// agent's spend and a memory's channel don't show to whoever can't see them, the browser on a runner is driven only
// by whoever may use the runner, and an archived agent takes no writes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActiveRun } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

type Runner = { id: string };

let server: RunningServer;
/** Live runs the fake runtime reports on top of the real ones, with the workspace of each. */
const live: (ActiveRun & { workspaceId: string })[] = [];
let completes = 0;
/** Runners the fake hub reports online; the browser calls on them answer at once. */
const online = new Set<string>();

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
  const { runners } = server.deps;
  const isOnline = runners.isOnline.bind(runners);
  runners.isOnline = (id: string) => online.has(id) || isOnline(id);
  const callRunner = runners.call.bind(runners);
  runners.call = ((runnerId: string, op: string, ...rest: unknown[]) =>
    online.has(runnerId) && op === "browser.close"
      ? Promise.resolve({})
      : (callRunner as (...a: unknown[]) => Promise<unknown>)(runnerId, op, ...rest)) as typeof runners.call;
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

/** A runner paired by `who`, online, with the browser on. */
async function pairedRunner(t: Team, who: Person, name: string): Promise<Runner> {
  const start = await call(who, "POST", "/api/v1/runner-pairings", {
    name,
    os: "linux",
    arch: "x64",
    hostname: `${name}.local`,
    version: "1.0.0",
  });
  const runner = await call(who, "POST", `${t.w}/runner-pairings/${start.body.userCode}/confirm`, { name });
  expect(runner.status).toBe(200);
  online.add(runner.body.id);
  await server.deps.db
    .update(schema.runners)
    .set({
      browser: true,
      access: { folders: [], tools: { browser: true, claude: false, codex: false, commands: false } },
    })
    .where(eq(schema.runners.id, runner.body.id));
  return runner.body;
}

/** A reply of lia in `channelId` and the feedback `who` leaves on it: a lesson in lia's memory, from that channel. */
async function feedbackIn(t: Team, who: Person, channelId: string, body: string) {
  const id = newId("msg");
  await server.deps.db.insert(schema.messages).values({
    id,
    workspaceId: t.workspaceId,
    channelId,
    authorKind: "agent",
    authorId: t.lia.id,
    body: "Draft ready.",
  });
  expect((await call(who, "POST", `${t.w}/messages/${id}/feedback`, { body })).status).toBe(201);
  const [memory] = await server.deps.db.select().from(schema.memories).where(eq(schema.memories.text, body));
  if (!memory) throw new Error("no lesson");
  return memory;
}

/**
 * A write whose body arrives late: the route reads lia (still active) and waits on the body; lia is archived
 * then, and the body goes. Returns the status and the error code.
 */
async function archivedWhileSending(t: Team, method: string, path: string, payload: unknown) {
  let send!: (chunk: string) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (chunk) => {
        controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      };
    },
  });
  const pending = t.ana.browser.fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  });
  await Bun.sleep(300);
  await server.deps.db
    .update(schema.agents)
    .set({ archivedAt: new Date() })
    .where(eq(schema.agents.id, t.lia.id));
  send(JSON.stringify(payload));
  const res = await pending;
  return [res.status, ((await res.json()) as { error?: { code?: string } }).error?.code];
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
    "refuses the browser, environment and memory writes",
    async () => {
      const t = await team();
      const base = `${t.w}/agents/${t.lia.id}`;
      const runner = await pairedRunner(t, t.ana, `ana-box-${seq}`);
      const lesson = await feedbackIn(t, t.ana, t.general, `Answer in English ${seq}.`);
      const reply = newId("msg");
      await server.deps.db.insert(schema.messages).values({
        id: reply,
        workspaceId: t.workspaceId,
        channelId: t.general,
        authorKind: "agent",
        authorId: t.lia.id,
        body: "Another draft.",
      });
      expect((await call(t.ana, "DELETE", base)).status).toBe(204);
      const writes = [
        call(t.ana, "PUT", `${base}/browser`, { permittedDomains: ["example.com"] }),
        call(t.ana, "PUT", `${base}/browser/policy`, { level: "free", sites: [] }),
        call(t.ana, "POST", `${base}/environment/start`),
        call(t.ana, "PUT", `${base}/environment/target`, { runnerId: runner.id }),
        call(t.ana, "PATCH", `${t.w}/memories/${lesson.id}`, { text: "Changed." }),
        call(t.ana, "POST", `${t.w}/memories/${lesson.id}/revert`, {}),
        call(t.ana, "POST", `${t.w}/memories/${lesson.id}/versions/mv_any/restore`, {}),
        call(t.ana, "POST", `${t.w}/messages/${reply}/feedback`, { body: "Too late." }),
      ];
      for (const res of await Promise.all(writes))
        expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, t.lia.id));
      expect(agent?.environmentId ?? null).toBe(null);
      const [kept] = await server.deps.db
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.id, lesson.id));
      expect(kept?.text).toBe(lesson.text);
      const late = await server.deps.db
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.text, "Too late."));
      expect(late).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "PUT /channels refuses when the archive lands after the first read: the check runs again under the lock",
    async () => {
      const t = await team();
      const ops = await seedChannel(server, t.workspaceId, { name: "ops", members: [t.ana] });
      const res = await archivedWhileSending(t, "PUT", `${t.w}/agents/${t.lia.id}/channels`, {
        channels: [{ channelId: ops, autoAnswer: true }],
      });
      expect(res).toEqual([409, "agent.archived"]);
      const links = await server.deps.db
        .select({ channelId: schema.channelMemberships.channelId })
        .from(schema.channelMemberships)
        .where(eq(schema.channelMemberships.memberId, t.lia.id));
      expect(links.map((l) => l.channelId)).toEqual([t.general]);
    },
    SERVER_TEST_MS,
  );

  test(
    "PUT /environment/target refuses when the archive lands after the first read: no runner is lent",
    async () => {
      const t = await team();
      const runner = await pairedRunner(t, t.ana, `ana-box-${seq}`);
      const res = await archivedWhileSending(t, "PUT", `${t.w}/agents/${t.lia.id}/environment/target`, {
        runnerId: runner.id,
      });
      expect(res).toEqual([409, "agent.archived"]);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, t.lia.id));
      expect(agent?.environmentId ?? null).toBe(null);
      const env = await server.deps.db
        .select()
        .from(schema.agentEnvironments)
        .where(eq(schema.agentEnvironments.agentId, t.lia.id));
      expect(env.filter((e) => e.status === "running")).toEqual([]);
      // Clearing the runner stays open on the archived agent.
      expect(
        (await call(t.ana, "PUT", `${t.w}/agents/${t.lia.id}/environment/target`, { runnerId: null })).status,
      ).toBe(200);
      online.delete(runner.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "the browser policy writes refuse when the archive lands after the first read: no policy is saved",
    async () => {
      const t = await team();
      const base = `${t.w}/agents/${t.lia.id}`;
      expect(
        await archivedWhileSending(t, "PUT", `${base}/browser/policy`, { level: "free", sites: [] }),
      ).toEqual([409, "agent.archived"]);
      await server.deps.db
        .update(schema.agents)
        .set({ archivedAt: null })
        .where(eq(schema.agents.id, t.lia.id));
      expect(
        await archivedWhileSending(t, "PUT", `${base}/browser`, { permittedDomains: ["example.com"] }),
      ).toEqual([409, "agent.archived"]);
      const saved = await server.deps.db
        .select()
        .from(schema.browserPolicies)
        .where(eq(schema.browserPolicies.agentId, t.lia.id));
      expect(saved).toEqual([]);
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

describe("an agent's browser on someone's runner", () => {
  test(
    "a member who may talk to the agent but can't use the runner neither takes over nor stops it",
    async () => {
      const t = await team();
      const base = `${t.w}/agents/${t.lia.id}`;
      const runner = await pairedRunner(t, t.ana, `ana-box-${seq}`);
      expect((await call(t.ana, "PUT", `${base}/environment/target`, { runnerId: runner.id })).status).toBe(
        200,
      );
      const davi = await memberOf(server, t.workspaceId, "Davi", email("davi"));
      for (const res of [
        await call(davi, "POST", `${base}/browser/interventions/start`, {}),
        await call(davi, "POST", `${base}/browser/stop`, {}),
      ])
        expect(res.status).toBe(403);
      // Whoever paired the runner takes over and stops.
      expect((await call(t.ana, "POST", `${base}/browser/interventions/start`, {})).status).toBe(200);
      expect((await call(t.ana, "POST", `${base}/browser/stop`, {})).status).toBe(204);
      online.delete(runner.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "stopping ends only the interventions on the runner checked, not one opened on another runner",
    async () => {
      const t = await team();
      const base = `${t.w}/agents/${t.lia.id}`;
      // Lia works on Beto's runner; an intervention is still open on Ana's, which Beto can't use.
      const betoBox = await pairedRunner(t, t.beto, `beto-box-${seq}`);
      const anaBox = await pairedRunner(t, t.ana, `ana-box-${seq}`);
      expect((await call(t.beto, "PUT", `${base}/environment/target`, { runnerId: betoBox.id })).status).toBe(
        200,
      );
      const elsewhere = newId("bi");
      await server.deps.db.insert(schema.browserInterventions).values({
        id: elsewhere,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: anaBox.id,
        kind: "login",
        instructions: "Sign in",
        targetUserId: t.ana.user.id,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      expect((await call(t.beto, "POST", `${base}/browser/stop`, {})).status).toBe(204);
      const [row] = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.id, elsewhere));
      expect(row?.status).toBe("pending");
      online.delete(betoBox.id);
      online.delete(anaBox.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a browser request addressed to someone who can't use the runner", () => {
  test(
    "they can't take it: taking a request is driving the browser",
    async () => {
      const t = await team();
      const anaBox = await pairedRunner(t, t.ana, `ana-box-${seq}`);
      const id = newId("bi");
      await server.deps.db.insert(schema.browserInterventions).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: anaBox.id,
        kind: "login",
        instructions: "Sign in",
        targetUserId: t.beto.user.id,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      expect((await call(t.beto, "POST", `${t.w}/browser-interventions/${id}/control`)).status).toBe(403);
      const [row] = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.id, id));
      expect(row?.status).toBe("pending");
      online.delete(anaBox.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "stopping an agent with no runner leaves an intervention on a runner they can't use open",
    async () => {
      const t = await team();
      const anaBox = await pairedRunner(t, t.ana, `ana-box-${seq}`);
      const id = newId("bi");
      await server.deps.db.insert(schema.browserInterventions).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: anaBox.id,
        kind: "login",
        instructions: "Sign in",
        targetUserId: t.ana.user.id,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      expect((await call(t.beto, "POST", `${t.w}/agents/${t.lia.id}/browser/stop`, {})).status).toBe(204);
      const [row] = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.id, id));
      expect(row?.status).toBe("pending");
      online.delete(anaBox.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a memory's origin", () => {
  test(
    "names its channel only to whoever reads it, from feedback and from a run",
    async () => {
      const t = await team();
      const payroll = await seedChannel(server, t.workspaceId, {
        name: `payroll${seq}`,
        visibility: "private",
        members: [t.ana],
      });
      await feedbackIn(t, t.ana, payroll, `Keep salaries confidential ${seq}.`);
      const runId = await insertRun(t, { agentId: t.lia.id, channelId: payroll });
      await server.deps.db.insert(schema.memories).values({
        id: newId("mem"),
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        scope: "agent",
        text: "Bonus sheet is in the drive.",
        origin: { by: null, name: null, channel: `#payroll${seq}`, at: new Date().toISOString(), runId },
      });
      const channels = async (who: Person) =>
        (
          (await call(who, "GET", `${t.w}/agents/${t.lia.id}/memories`)).body.memories as {
            origin: { channel: string | null } | null;
          }[]
        ).map((m) => m.origin?.channel);
      expect(await channels(t.ana)).toEqual([`#payroll${seq}`, `#payroll${seq}`]);
      // The feedback's lesson stays in #payroll (it doesn't show at all outside it); the run's memory shows unnamed.
      expect(await channels(t.beto)).toEqual([null]);
      expect(await channels(t.carla)).toEqual([null]);
      // The answer depends on who asks: no shared cache keeps it.
      for (const path of [`${t.w}/agents/${t.lia.id}/memories`, `${t.w}/memories/workspace`])
        expect((await t.beto.browser.fetch(path)).headers.get("cache-control")).toBe("no-store");
    },
    SERVER_TEST_MS,
  );
});
