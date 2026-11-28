// The three rules every agent route follows, checked from the routes themselves: an archived agent takes no writes,
// a runner acts for a person only if they may use it, and a memory's origin names its channel only to whoever
// reads it. The first test reads the router: a new route that names an agent (or an agent's memory, review,
// proposal, request or intervention) fails it until it is classified here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { queueMemoryReview } from "../src/memory-reviews";
import { revalidateInterventions } from "../src/runners/requests";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
/** Runners the fake hub reports online; their browser and job calls answer at once. */
const online = new Set<string>();

beforeAll(async () => {
  server = await startTestServer();
  const { runners } = server.deps;
  const isOnline = runners.isOnline.bind(runners);
  runners.isOnline = (id: string) => online.has(id) || isOnline(id);
  const callRunner = runners.call.bind(runners);
  runners.call = ((runnerId: string, op: string, ...rest: unknown[]) =>
    online.has(runnerId)
      ? Promise.resolve({})
      : (callRunner as (...a: unknown[]) => Promise<unknown>)(runnerId, op, ...rest)) as typeof runners.call;
}, SERVER_TEST_MS);

afterAll(() => server.stop(), SERVER_TEST_MS);

let seq = 0;
const email = (who: string) => `${who}${++seq}@agent-guards.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana);
  const carla = await memberOf(server, workspaceId, "Carla", email("carla"), "admin");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const davi = await memberOf(server, workspaceId, "Davi", email("davi"));
  // Beto owns Lia without managing agents: he edits her, but doesn't use Ana's runner.
  const lia = await seedAgent(server, workspaceId, beto, "lia", [general]);
  return { w: ws(workspaceId), workspaceId, general, ana, carla, beto, davi, lia };
}
type Team = Awaited<ReturnType<typeof team>>;

const archive = (t: Team) =>
  server.deps.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, t.lia.id));
const code = (res: { status: number; body: { error?: { code?: string } } | null }) => [
  res.status,
  res.body?.error?.code,
];

/** A runner paired by `who`, online, with the browser on, lent to Lia. */
async function lentRunner(t: Team, who: Person) {
  const start = await call(who, "POST", "/api/v1/runner-pairings", {
    name: `box-${seq}`,
    os: "linux",
    arch: "x64",
    hostname: `box-${seq}.local`,
    version: "1.0.0",
  });
  const runner = await call(who, "POST", `${t.w}/runner-pairings/${start.body.userCode}/confirm`, {
    name: `box-${seq}`,
  });
  expect(runner.status).toBe(200);
  const id: string = runner.body.id;
  online.add(id);
  await server.deps.db
    .update(schema.runners)
    .set({
      browser: true,
      access: { folders: [], tools: { browser: true, claude: false, codex: false, commands: false } },
    })
    .where(eq(schema.runners.id, id));
  await server.deps.db.update(schema.agents).set({ environmentId: id }).where(eq(schema.agents.id, t.lia.id));
  return id;
}

async function intervention(
  t: Team,
  runnerId: string,
  over: Partial<typeof schema.browserInterventions.$inferInsert> = {},
) {
  const id = newId("bi");
  await server.deps.db.insert(schema.browserInterventions).values({
    id,
    workspaceId: t.workspaceId,
    agentId: t.lia.id,
    runnerId,
    kind: "login",
    instructions: "Sign in",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    ...over,
  });
  return id;
}

const interventionStatus = async (id: string) =>
  (
    await server.deps.db
      .select()
      .from(schema.browserInterventions)
      .where(eq(schema.browserInterventions.id, id))
  )[0]?.status;

// ---- the router's classification ----

/** The routes that name an agent or something an agent owns (its memory, reviews, proposals, requests, browser). */
const FAMILY = /agent|memor|proposal|network-request|secret-request|browser-intervention|\/runs\/|feedback/;

/**
 * Every write of the family outside `/agents/:agentId` (those are all refused by the guard, except `OPEN`). Each
 * says how an archived agent is kept from it: `checked` names the test that proves the refusal, `ends` only ends,
 * refuses or takes away (open on purpose), `none` writes no agent (it creates one, or writes a person's store).
 */
const BY_REFERENCE: Record<string, { checked: string } | { ends: string } | { none: string }> = {
  "POST /browser-interventions/:interventionId/control": { checked: "A5" },
  "POST /memory-reviews/:memoryReviewId/approve": { checked: "A6" },
  "POST /proposals/:proposalId/accept": { checked: "A7" },
  "POST /network-requests/:networkRequestId/allow": { checked: "A8" },
  "POST /secret-requests/:secretRequestId/deliver": { checked: "A9" },
  "PATCH /memories/:memoryId": { checked: "agent-access: browser, environment and memory writes" },
  "POST /memories/:memoryId/revert": { checked: "agent-access: browser, environment and memory writes" },
  "POST /memories/:memoryId/versions/:versionId/restore": {
    checked: "agent-access: browser, environment and memory writes",
  },
  "POST /messages/:messageId/feedback": { checked: "agent-access: browser, environment and memory writes" },
  "POST /runs/:runId/skill-draft": { checked: "agent-access: doesn't draft a skill from its run" },
  "POST /issues/:issueId/ask-agent": { checked: "issues: an archived agent answers as missing" },
  "POST /runners/:runnerId/move-agents": { checked: "moves only active agents (the race is #121)" },
  "POST /browser-interventions/:interventionId/complete": { ends: "ends the intervention" },
  "POST /browser-interventions/:interventionId/fail": { ends: "ends the intervention" },
  "POST /browser-interventions/:interventionId/cancel": { ends: "ends the intervention" },
  "POST /memory-reviews/:memoryReviewId/reject": { ends: "drops a pending write" },
  "POST /proposals/:proposalId/reject": { ends: "drops a pending change" },
  "POST /network-requests/:networkRequestId/deny": { ends: "closes the network" },
  "DELETE /network-requests/:networkRequestId": { ends: "closes the network" },
  "POST /secret-requests/:secretRequestId/decline": { ends: "gives the agent nothing" },
  "POST /runs/:runId/cancel": { ends: "stops a run" },
  "DELETE /channels/:channelId/members/agents/:agentId": { ends: "takes the agent out of a channel" },
  "POST /agents": { none: "creates an agent" },
  "POST /agent-drafts": { none: "drafts a new agent" },
  "POST /agent-imports/github": { none: "reads instructions to create an agent" },
  "POST /memories": { none: "writes the person's or the workspace's store" },
  "POST /calendar/proposals/:proposalId/confirm": { none: "the person writes their calendar" },
  "POST /calendar/proposals/:proposalId/dismiss": { none: "the person drops a suggestion" },
};

/** The writes under `/agents/:agentId` an archived agent still takes: each only ends or takes something away. */
const OPEN: Record<string, string> = {
  "DELETE /agents/:agentId": "archives it (again)",
  "POST /agents/:agentId/identity/revoke": "disconnects its accounts",
  "DELETE /agents/:agentId/environment": "detaches its runner",
  "POST /agents/:agentId/environment/stop": "stops its environment",
  "POST /agents/:agentId/browser/stop": "closes its browser",
  "DELETE /agents/:agentId/secrets/:secretId": "deletes a secret",
  "PUT /agents/:agentId/environment/target": "clears its runner (lending one is refused by the route)",
};

const PREFIX = "/api/v1/workspaces/:workspaceId";
const familyWrites = () => [
  ...new Set(
    server.routes
      .filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && r.path.startsWith(PREFIX))
      .map((r) => `${r.method} ${r.path.slice(PREFIX.length)}`)
      .filter((key) => FAMILY.test(key)),
  ),
];
const underAgent = (key: string) => / \/agents\/:agentId(\/|$)/.test(key);

describe("the router's agent writes", () => {
  test(
    "each one is classified, and every write under /agents/:agentId refuses an archived agent but the open ones",
    async () => {
      const writes = familyWrites();
      const unclassified = writes.filter((k) => !underAgent(k) && !(k in BY_REFERENCE));
      expect(unclassified).toEqual([]);
      const stale = [...Object.keys(BY_REFERENCE), ...Object.keys(OPEN)].filter((k) => !writes.includes(k));
      expect(stale).toEqual([]);

      const t = await team();
      await archive(t);
      const path = (key: string) =>
        key
          .slice(key.indexOf(" ") + 1)
          .replace(":agentId", t.lia.id)
          .replace(/:[a-zA-Z]+/g, "x_missing");
      const refused: string[] = [];
      const answered: string[] = [];
      for (const key of writes.filter(underAgent)) {
        const method = key.slice(0, key.indexOf(" "));
        const res = await call(t.ana, method, `${t.w}${path(key)}`, method === "DELETE" ? undefined : {});
        (res.body?.error?.code === "agent.archived" ? refused : answered).push(key);
      }
      expect(answered.sort()).toEqual(Object.keys(OPEN).sort());
      expect(refused.length).toBe(writes.filter(underAgent).length - Object.keys(OPEN).length);
      // The target route decides by its body: lending a runner is refused, clearing it isn't.
      expect(
        code(await call(t.ana, "PUT", `${t.w}/agents/${t.lia.id}/environment/target`, { runnerId: "x" })),
      ).toEqual([409, "agent.archived"]);
    },
    SERVER_TEST_MS,
  );
});

// ---- A: the archived agent's writes that reach it by reference ----

describe("an archived agent, reached by reference", () => {
  test(
    "A5: taking its browser request is refused",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const id = await intervention(t, runner, { targetUserId: t.ana.user.id });
      await archive(t);
      expect(code(await call(t.ana, "POST", `${t.w}/browser-interventions/${id}/control`))).toEqual([
        409,
        "agent.archived",
      ]);
      expect(await interventionStatus(id)).toBe("pending");
      online.delete(runner);
    },
    SERVER_TEST_MS,
  );

  test(
    "A6: approving a memory write for it is refused and nothing is written (rejecting stays open)",
    async () => {
      const t = await team();
      const base = {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runId: null,
        scope: "agent" as const,
        ownerUserId: null,
        op: "create" as const,
        memoryId: null,
        newPath: null,
        kind: "fact" as const,
        about: null,
        replaces: null,
        reasons: [{ flag: "A" as const, source: "mail_read inbox/1" }],
        origin: { at: new Date().toISOString(), by: null, channel: null, name: null },
        tool: "memory" as const,
        baseSha256: null,
      };
      const one = await queueMemoryReview(server.deps, { ...base, path: "notes/a.md", text: "Approve me." });
      const two = await queueMemoryReview(server.deps, { ...base, path: "notes/b.md", text: "Reject me." });
      await archive(t);
      expect(code(await call(t.ana, "POST", `${t.w}/memory-reviews/${one.id}/approve`))).toEqual([
        409,
        "agent.archived",
      ]);
      const written = await server.deps.db
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.agentId, t.lia.id));
      expect(written).toEqual([]);
      expect((await call(t.ana, "POST", `${t.w}/memory-reviews/${two.id}/reject`, {})).status).toBe(200);
    },
    SERVER_TEST_MS,
  );

  test(
    "A7: accepting a proposal to change its instructions is refused and the instructions stay",
    async () => {
      const t = await team();
      const id = newId("prp");
      await server.deps.db.insert(schema.proposals).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        targetKind: "agent_prompt",
        recipientAgentId: t.lia.id,
        title: "Deadline",
        before: "",
        after: "Always mention the deadline.",
        why: "Customers ask",
      });
      await archive(t);
      const res = await call(t.ana, "POST", `${t.w}/proposals/${id}/accept`, {});
      expect(code(res)).toEqual([409, "agent.archived"]);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, t.lia.id));
      expect(agent?.instructions).toBe("");
    },
    SERVER_TEST_MS,
  );

  test(
    "A8: allowing a domain for it is refused; denying stays open",
    async () => {
      const t = await team();
      const request = async (domain: string) => {
        const id = newId("nr");
        await server.deps.db
          .insert(schema.networkRequests)
          .values({ id, workspaceId: t.workspaceId, agentId: t.lia.id, domain });
        return id;
      };
      const allow = await request("a.example.com");
      const deny = await request("b.example.com");
      await archive(t);
      expect(code(await call(t.ana, "POST", `${t.w}/network-requests/${allow}/allow`))).toEqual([
        409,
        "agent.archived",
      ]);
      expect((await call(t.ana, "POST", `${t.w}/network-requests/${deny}/deny`)).status).toBe(200);
    },
    SERVER_TEST_MS,
  );

  test(
    "A9: delivering a secret to it is refused and the request stays pending",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const id = newId("sr");
      await server.deps.db.insert(schema.secretPrompts).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: runner,
        name: "API_TOKEN",
        target: "env",
        targetUserId: t.beto.user.id,
        publicKey: "pk",
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
      await archive(t);
      const box = { v: 1, epk: "e", iv: "i", ct: "c" };
      expect(code(await call(t.beto, "POST", `${t.w}/secret-requests/${id}/deliver`, { box }))).toEqual([
        409,
        "agent.archived",
      ]);
      const [row] = await server.deps.db
        .select()
        .from(schema.secretPrompts)
        .where(eq(schema.secretPrompts.id, id));
      expect(row?.status).toBe("pending");
      online.delete(runner);
    },
    SERVER_TEST_MS,
  );

  test(
    "starting its environment is refused when the archive lands after the first read (checked under the lock)",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      // The archive lands after the route's first read, right as the write's transaction opens.
      const { db } = server.deps;
      const transaction = db.transaction.bind(db);
      db.transaction = (async (fn: Parameters<typeof transaction>[0]) => {
        db.transaction = transaction;
        await archive(t);
        return transaction(fn);
      }) as typeof db.transaction;
      try {
        expect(code(await call(t.ana, "POST", `${t.w}/agents/${t.lia.id}/environment/start`))).toEqual([
          409,
          "agent.archived",
        ]);
      } finally {
        db.transaction = transaction;
        online.delete(runner);
      }
      const env = await server.deps.db
        .select()
        .from(schema.agentEnvironments)
        .where(eq(schema.agentEnvironments.agentId, t.lia.id));
      expect(env.filter((e) => e.status === "running")).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

// ---- B: a runner acts for a person only if they may use it ----

describe("a runner someone else paired", () => {
  test(
    "B1: ending an intervention on it (cancel, complete, fail) is refused to who can't use it",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      // Beto edits Lia and the requests are addressed to him, but the runner is Ana's.
      const ids = await Promise.all(
        [1, 2, 3].map(() => intervention(t, runner, { targetUserId: t.beto.user.id })),
      );
      for (const [i, action] of ["cancel", "complete", "fail"].entries()) {
        const res = await call(t.beto, "POST", `${t.w}/browser-interventions/${ids[i]}/${action}`, {});
        expect([action, res.status]).toEqual([action, 403]);
        expect(await interventionStatus(ids[i] as string)).toBe("pending");
      }
      // Ana, who paired it, ends one.
      expect((await call(t.ana, "POST", `${t.w}/browser-interventions/${ids[0]}/cancel`, {})).status).toBe(
        200,
      );
      online.delete(runner);
    },
    SERVER_TEST_MS,
  );

  test(
    "B2: its live view is refused to who can talk to the agent but can't use the runner",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const davi = await TestSocket.open(t.davi.browser, t.workspaceId);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      try {
        davi.send({ type: "live_view.subscribe", agentId: t.lia.id });
        expect((await davi.event("live_view.unavailable")).event).toMatchObject({ reason: "forbidden" });
        ana.send({ type: "live_view.subscribe", agentId: t.lia.id });
        expect((await ana.event("live_view.status")).event).toMatchObject({ agentId: t.lia.id });
      } finally {
        davi.close();
        ana.close();
        online.delete(runner);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "B3: starting or stopping the agent's environment is refused to its owner who can't use the runner",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const base = `${t.w}/agents/${t.lia.id}/environment`;
      expect((await call(t.beto, "POST", `${base}/start`)).status).toBe(403);
      expect((await call(t.beto, "POST", `${base}/stop`)).status).toBe(403);
      expect((await call(t.ana, "POST", `${base}/start`)).status).toBe(200);
      expect((await call(t.ana, "POST", `${base}/stop`)).status).toBe(200);
      online.delete(runner);
    },
    SERVER_TEST_MS,
  );

  test(
    "B4: an admin demoted to member loses control of the browser they drive on it",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const taken = await call(t.carla, "POST", `${t.w}/agents/${t.lia.id}/browser/interventions/start`, {});
      expect(taken.status).toBe(200);
      await revalidateInterventions(server.deps);
      expect(await interventionStatus(taken.body.id)).toBe("active");
      await server.deps.db
        .update(schema.members)
        .set({ role: "member" })
        .where(eq(schema.members.userId, t.carla.user.id));
      await revalidateInterventions(server.deps);
      expect(await interventionStatus(taken.body.id)).toBe("canceled");
      online.delete(runner);
    },
    SERVER_TEST_MS,
  );
});

// ---- C: a memory review's origin ----

describe("a memory review's origin", () => {
  test(
    "C1: names its channel only to whoever reads it, in the list and the decision, never cached",
    async () => {
      const t = await team();
      const payroll = await seedChannel(server, t.workspaceId, {
        name: `payroll${seq}`,
        visibility: "private",
        members: [t.ana],
      });
      const runId = newId("run");
      await server.deps.db.insert(schema.runs).values({
        id: runId,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        channelId: payroll,
        status: "done",
        model: "claude-haiku-5-5",
      });
      const review = await queueMemoryReview(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runId,
        scope: "agent",
        ownerUserId: null,
        op: "create",
        memoryId: null,
        path: "notes/salaries.md",
        newPath: null,
        text: "Salaries are in the drive.",
        kind: "fact",
        about: null,
        replaces: null,
        reasons: [{ flag: "A", source: "mail_read inbox/1" }],
        origin: { at: new Date().toISOString(), by: null, channel: `#payroll${seq}`, name: null, runId },
        tool: "memory",
        baseSha256: null,
      });
      const listed = async (who: Person) => {
        const res = await t.beto.browser.fetch(`${t.w}/memory-reviews?agentId=${t.lia.id}`);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const own = await call(who, "GET", `${t.w}/memory-reviews?agentId=${t.lia.id}`);
        return own.body.reviews.map((r: { origin: { channel: string | null } }) => r.origin.channel);
      };
      expect(await listed(t.ana)).toEqual([`#payroll${seq}`]);
      expect(await listed(t.beto)).toEqual([null]);
      const rejected = await call(t.beto, "POST", `${t.w}/memory-reviews/${review.id}/reject`, {});
      expect(rejected.body.origin.channel).toBe(null);
    },
    SERVER_TEST_MS,
  );
});

// ---- D: spend follows view_usage ----

describe("spend outside the usage page", () => {
  test(
    "D1: the overview's budget share is null without view_usage",
    async () => {
      const t = await team();
      expect((await call(t.beto, "GET", `${t.w}/overview`)).body.budgetSpentPct).toBe(null);
      expect(typeof (await call(t.carla, "GET", `${t.w}/overview`)).body.budgetSpentPct).toBe("number");
    },
    SERVER_TEST_MS,
  );

  test(
    "GET /usage leaves out the runs of a debate that is still anonymous",
    async () => {
      const t = await team();
      const debateId = newId("dbt");
      await server.deps.db.insert(schema.debates).values({
        id: debateId,
        workspaceId: t.workspaceId,
        title: "Price",
        goal: "Pick the price",
        channelId: t.general,
        createdBy: { type: "person", id: t.ana.user.id },
      });
      const run = (cost: number, debate: string | null) =>
        server.deps.db.insert(schema.runs).values({
          id: newId("run"),
          workspaceId: t.workspaceId,
          agentId: t.lia.id,
          channelId: t.general,
          debateId: debate,
          status: "done",
          model: "claude-haiku-5-5",
          costUsd: cost,
        });
      await run(1, null);
      await run(5, debateId);
      const usage = (await call(t.carla, "GET", `${t.w}/usage`)).body.usage;
      expect(usage).toEqual([{ agentId: t.lia.id, costUsd: 1 }]);
    },
    SERVER_TEST_MS,
  );

  test(
    "D2: the agent's budget notice reaches an owner without view_usage with no amounts",
    async () => {
      const sent: { userId: string; event: Record<string, unknown> }[] = [];
      const { hub } = server.deps;
      const toUser = hub.toUser.bind(hub);
      hub.toUser = (workspaceId, userId, event) => {
        sent.push({ userId, event: event as Record<string, unknown> });
        return toUser(workspaceId, userId, event);
      };
      try {
        const t = await team();
        const notify = (agentId: string) => {
          const [agent] = [agentId];
          return server.deps.db
            .select()
            .from(schema.agents)
            .where(eq(schema.agents.id, agent as string))
            .then(([row]) => server.runtime["notifyBudget"](row as never, "exhausted", 12, 10));
        };
        await notify(t.lia.id);
        expect(sent.find((s) => s.userId === t.beto.user.id)?.event).toMatchObject({
          type: "budget.cap_reached",
          agentId: t.lia.id,
          spentUsd: null,
          budgetUsd: null,
        });
        const owned = await seedAgent(server, t.workspaceId, t.carla, "max");
        await notify(owned.id);
        expect(sent.find((s) => s.userId === t.carla.user.id)?.event).toMatchObject({
          type: "budget.cap_reached",
          spentUsd: 12,
          budgetUsd: 10,
        });
      } finally {
        hub.toUser = toUser;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "D3: a channel's budget notice reaches a requester without view_usage only when it runs out, with no amounts",
    async () => {
      const sent: { userId: string; event: Record<string, unknown> }[] = [];
      const { hub, ledger } = server.deps;
      const toUser = hub.toUser.bind(hub);
      const spent = ledger.spent.bind(ledger);
      hub.toUser = (workspaceId, userId, event) => {
        sent.push({ userId, event: event as Record<string, unknown> });
        return toUser(workspaceId, userId, event);
      };
      try {
        const t = await team();
        const channel = await seedChannel(server, t.workspaceId, {
          name: `ops${seq}`,
          members: [t.ana, t.beto],
        });
        await server.deps.db
          .update(schema.channels)
          .set({ budgetPerMonthUsd: 10 })
          .where(eq(schema.channels.id, channel));
        const check = (rejected: boolean) =>
          server.runtime["channelBudgetCheck"](channel, t.beto.user.id, rejected) as Promise<void>;
        ledger.spent = async () => 8;
        await check(false);
        expect(sent.filter((s) => s.userId === t.beto.user.id)).toEqual([]);
        expect(sent.find((s) => s.userId === t.carla.user.id)?.event).toMatchObject({
          level: "75",
          spentUsd: 8,
        });
        await check(true);
        expect(sent.find((s) => s.userId === t.beto.user.id)?.event).toMatchObject({
          type: "channel.budget",
          level: "exhausted",
          spentUsd: null,
          budgetUsd: null,
        });
      } finally {
        hub.toUser = toUser;
        ledger.spent = spent;
      }
    },
    SERVER_TEST_MS,
  );
});
