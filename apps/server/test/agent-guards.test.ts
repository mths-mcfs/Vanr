// The three rules every agent route follows, checked from the routes themselves: an archived agent takes no writes,
// a runner acts for a person only if they may use it, and a memory's origin names its channel only to whoever
// reads it. The first test reads the router: a new family, a new write of a family that reaches agents, or a new
// route that names an agent, fails it until it is classified here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { createAssignment } from "../src/assignments/engine";
import { assignmentEvent, SYSTEM } from "../src/assignments/events";
import { act } from "../src/assignments/motor";
import { queueMemoryReview } from "../src/memory-reviews";
import { postMessage } from "../src/messages";
import { recheckLiveViews } from "../src/runners/browser-live";
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
/** Archives Lia right as the next transaction opens: after the route's first read, before its locked write. */
function archiveAtNextTransaction(t: Team) {
  const { db } = server.deps;
  const transaction = db.transaction.bind(db);
  db.transaction = (async (fn: Parameters<typeof transaction>[0]) => {
    db.transaction = transaction;
    await archive(t);
    return transaction(fn);
  }) as typeof db.transaction;
  return () => {
    db.transaction = transaction;
  };
}

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

/**
 * Every workspace write sits in a family, its first path segment. The writes of an agent family can reach an agent's
 * state (its memory, skills, environment, identity, approvals, questions, runs or jobs), so each one is classified in
 * `BY_REFERENCE`. Every other family says here why it can't, and a write there that still names an agent
 * (`NAMES_AGENT`) is classified too. A new family fails the first test until it is placed.
 */
const AGENT_FAMILIES = new Set([
  "agents",
  "agent-drafts",
  "agent-imports",
  "approvals",
  "questions",
  "actions",
  "assignments",
  "memories",
  "memory-reviews",
  "proposals",
  "network-requests",
  "secret-requests",
  "browser-interventions",
  "runs",
  "messages",
]);
const OTHER_FAMILIES: Record<string, string> = {
  "": "the workspace's own settings",
  "approval-rules": "revokes a rule, which only takes away",
  "archived-channels": "the owner brings back a channel; its agents' posts are checked as in any channel",
  bases: "people's bases",
  calendar: "people's calendars",
  channels: "channels and posts; a post reaches only active agents (routing skips an archived one)",
  connectors: "the workspace's connections; an agent's accounts are under /agents/:agentId",
  credentials: "the workspace's model credentials",
  databases: "outside databases the workspace connects",
  "debate-suggestions": "suggests a debate; a debate picks only active agents",
  debates: "debates; a debate picks only active agents",
  dms: "opens a DM, refused with an archived agent",
  files: "the Drive",
  "github-app": "the GitHub installation",
  "invite-links": "invitations",
  invitations: "invitations",
  "issue-columns": "the issue board",
  issues: "issues",
  logo: "the workspace's logo",
  mail: "people's mail accounts; an agent's are under /agents/:agentId",
  me: "the person's own profile",
  members: "people",
  notifications: "the person's inbox",
  reminders: "a reminder for an archived agent answers 404",
  routines: "routines; a routine's run refuses an archived agent (agent_gone)",
  "runner-pairings": "pairs a runner",
  runners: "runners; moving agents onto one is classified",
  "sandbox-settings": "the workspace's sandbox",
  search: "asks the search",
  settings: "the workspace's settings",
  skills: "the workspace's skill library; an agent's own list is under /agents/:agentId",
  storage: "the workspace's storage",
  threads: "threads",
  wiki: "the wiki",
};

/** A write outside the agent families that still names an agent or something an agent owns. */
const NAMES_AGENT =
  /agent|memor|proposal|network-request|secret-request|browser-intervention|\/runs\/|feedback/;

/** Reaches the agent only through its runs and jobs, which an archived agent doesn't start. */
const RUNS = { checked: "agent-archive: stops a real live run, and the agent starts no run after it" };
const NO_JOB = { checked: "agent-archive: an archived agent's assignment starts no job" };

/**
 * Every classified write outside `/agents/:agentId` (those are all refused by the guard, except `OPEN`). Each says
 * how an archived agent is kept from it: `checked` names the test that proves the refusal, `ends` only ends, refuses
 * or takes away (open on purpose), `none` writes no agent (it creates one, or writes a person's own records).
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
  "POST /approvals/:approvalId/approve": { checked: "agent-archive: approving ... refuses with 409" },
  "POST /approvals/:approvalId/edit": { checked: "agent-archive: approving ... refuses with 409" },
  "POST /proposals/:proposalId/reject": { checked: "agent-archive: rejecting a proposal ... refuses" },
  "POST /questions/:questionId/answer": { checked: "agent-archive: archiving closes its open questions" },
  "POST /actions/:actionId/undo": { checked: "agent-archive: undoing what it wrote is refused" },
  "POST /actions/:actionId/redo": { checked: "agent-archive: undoing what it wrote is refused" },
  "POST /messages/:messageId/actions/undo": { checked: "agent-archive: undoing what it wrote is refused" },
  "POST /assignments": { checked: "assignments: an archived agent can't take one" },
  "POST /assignments/:assignmentId/:action{start|pause|resume|stop}": RUNS,
  "POST /assignments/:assignmentId/messages": RUNS,
  "POST /assignments/:assignmentId/decisions/:decisionId/choose": RUNS,
  "POST /assignments/:assignmentId/decisions/approve-provisional": RUNS,
  "POST /assignments/:assignmentId/reviews/:reviewId/:action{approve|changes}": RUNS,
  "POST /assignments/:assignmentId/submissions/:submissionId/accept": RUNS,
  "POST /assignments/:assignmentId/submissions/:submissionId/request-changes": RUNS,
  "POST /assignments/:assignmentId/suggestions/:suggestionId/:action{accept|decline}": RUNS,
  "POST /assignments/:assignmentId/items/:itemId/retry": NO_JOB,
  "POST /assignments/:assignmentId/commands/:commandId/decide": NO_JOB,
  "POST /assignments/:assignmentId/commands/retry": NO_JOB,
  "POST /browser-interventions/:interventionId/complete": { ends: "ends the intervention" },
  "POST /browser-interventions/:interventionId/fail": { ends: "ends the intervention" },
  "POST /browser-interventions/:interventionId/cancel": { ends: "ends the intervention" },
  "POST /memory-reviews/:memoryReviewId/reject": { ends: "drops a pending write" },
  "POST /approvals/:approvalId/reject": { ends: "ends the wait, runs nothing" },
  "POST /network-requests/:networkRequestId/deny": { ends: "closes the network" },
  "DELETE /network-requests/:networkRequestId": { ends: "closes the network" },
  "POST /secret-requests/:secretRequestId/decline": { ends: "gives the agent nothing" },
  "POST /runs/:runId/cancel": { ends: "stops a run" },
  "DELETE /channels/:channelId/members/agents/:agentId": { ends: "takes the agent out of a channel" },
  "POST /assignments/:assignmentId/close": { ends: "closes the assignment" },
  "DELETE /assignments/:assignmentId/command-rules/:commandRuleId": { ends: "drops a command rule" },
  "DELETE /assignments/:assignmentId/participants/:participantId": { ends: "takes a person out" },
  "POST /agents": { none: "creates an agent" },
  "POST /agent-drafts": { none: "drafts a new agent" },
  "POST /agent-imports/github": { none: "reads instructions to create an agent" },
  "POST /memories": { none: "writes the person's or the workspace's store" },
  "POST /calendar/proposals/:proposalId/confirm": { none: "the person writes their calendar" },
  "POST /calendar/proposals/:proposalId/dismiss": { none: "the person drops a suggestion" },
  "POST /messages/:messageId/reactions": { none: "a person's reaction" },
  "DELETE /messages/:messageId/reactions": { none: "a person's reaction" },
  "PATCH /assignments/:assignmentId": { none: "the assignment's own fields" },
  "PUT /assignments/:assignmentId/plan": { none: "the assignment's plan" },
  "PUT /assignments/:assignmentId/runner": { none: "picks the runner; a job still starts through NO_JOB" },
  "PUT /assignments/:assignmentId/executor": {
    none: "picks the executor; a job still starts through NO_JOB",
  },
  "PUT /assignments/:assignmentId/runtime": { none: "the assignment's limits" },
  "PUT /assignments/:assignmentId/command-approval": { none: "the assignment's command policy" },
  "POST /assignments/:assignmentId/decisions/:decisionId/opinion": { none: "a person's opinion" },
  "PUT /assignments/:assignmentId/submissions/:submissionId/checklist/:itemId": {
    none: "a reviewer's checklist",
  },
  "POST /assignments/:assignmentId/join-requests": { none: "a person asks to join" },
  "POST /assignments/:assignmentId/join-requests/:joinRequestId/:action{accept|decline}": {
    none: "a person joins or not",
  },
  "PATCH /assignments/:assignmentId/participants/:participantId": { none: "a person's role" },
  "POST /assignments/:assignmentId/seen": { none: "the person's read mark" },
  "POST /assignments/:assignmentId/transfer": { none: "who owns the assignment" },
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
const allWrites = () => [
  ...new Set(
    server.routes
      .filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && r.path.startsWith(PREFIX))
      .map((r) => `${r.method} ${r.path.slice(PREFIX.length)}`),
  ),
];
const familyOf = (key: string) => key.slice(key.indexOf(" ") + 1).split("/")[1] ?? "";
const familyWrites = () =>
  allWrites().filter((key) => AGENT_FAMILIES.has(familyOf(key)) || NAMES_AGENT.test(key));
const underAgent = (key: string) => / \/agents\/:agentId(\/|$)/.test(key);

describe("the router's agent writes", () => {
  test(
    "each one is classified, and every write under /agents/:agentId refuses an archived agent but the open ones",
    async () => {
      const families = new Set(allWrites().map(familyOf));
      expect([...families].filter((f) => !AGENT_FAMILIES.has(f) && !(f in OTHER_FAMILIES))).toEqual([]);
      expect(Object.keys(OTHER_FAMILIES).filter((f) => !families.has(f))).toEqual([]);
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

describe("the writes an archived agent still takes", () => {
  test(
    "each one works and does what it says",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const base = `${t.w}/agents/${t.lia.id}`;
      const pending = await intervention(t, runner, { targetUserId: t.ana.user.id });
      await server.deps.db.insert(schema.runnerSecrets).values({
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        runnerId: runner,
        name: "API_TOKEN",
        target: "env",
      });
      await server.deps.db.insert(schema.connections).values({
        id: newId("conn"),
        workspaceId: t.workspaceId,
        connector: "linear",
        label: "Lia's Linear",
        authKind: "none",
        agentId: t.lia.id,
      });
      await archive(t);
      expect((await call(t.ana, "DELETE", base)).status).toBe(204);
      expect((await call(t.ana, "POST", `${base}/identity/revoke`)).body).toEqual({ revoked: 1 });
      expect((await call(t.ana, "POST", `${base}/browser/stop`, {})).status).toBe(204);
      expect(await interventionStatus(pending)).toBe("canceled");
      expect((await call(t.ana, "DELETE", `${base}/secrets/API_TOKEN?runnerId=${runner}`)).status).toBe(204);
      const secrets = await server.deps.db
        .select()
        .from(schema.runnerSecrets)
        .where(eq(schema.runnerSecrets.agentId, t.lia.id));
      expect(secrets).toEqual([]);
      expect((await call(t.ana, "POST", `${base}/environment/stop`)).body.status).toBe("stopped");
      expect(
        (await call(t.ana, "PUT", `${base}/environment/target`, { runnerId: runner })).body.error.code,
      ).toBe("agent.archived");
      expect((await call(t.ana, "PUT", `${base}/environment/target`, { runnerId: null })).status).toBe(200);
      expect((await call(t.ana, "DELETE", `${base}/environment`)).status).toBe(204);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, t.lia.id));
      expect([agent?.environmentId, agent?.archivedAt !== null]).toEqual([null, true]);
      online.delete(runner);
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

describe("an archive that lands after the first read", () => {
  test(
    "a secret delivery checks it again under the lock: nothing goes out",
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
      const restore = archiveAtNextTransaction(t);
      try {
        const box = { v: 1, epk: "e", iv: "i", ct: "c" };
        expect(code(await call(t.beto, "POST", `${t.w}/secret-requests/${id}/deliver`, { box }))).toEqual([
          409,
          "agent.archived",
        ]);
      } finally {
        restore();
        online.delete(runner);
      }
      const [row] = await server.deps.db
        .select()
        .from(schema.secretPrompts)
        .where(eq(schema.secretPrompts.id, id));
      expect(row?.status).toBe("pending");
    },
    SERVER_TEST_MS,
  );

  test(
    "a takeover checks it again under the lock: no intervention opens",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const restore = archiveAtNextTransaction(t);
      try {
        expect(
          code(await call(t.ana, "POST", `${t.w}/agents/${t.lia.id}/browser/interventions/start`, {})),
        ).toEqual([409, "agent.archived"]);
      } finally {
        restore();
        online.delete(runner);
      }
      const open = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.agentId, t.lia.id));
      expect(open).toEqual([]);
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
    "B2: a live view already streaming from the agent's previous runner isn't handed to who may use the new one",
    async () => {
      const t = await team();
      const anaBox = await lentRunner(t, t.ana);
      const ana = await TestSocket.open(t.ana.browser, t.workspaceId);
      const carla = await TestSocket.open(t.carla.browser, t.workspaceId);
      try {
        ana.send({ type: "live_view.subscribe", agentId: t.lia.id });
        await ana.event("live_view.status");
        // Lia moves to Carla's runner while Ana's stream of the old one is still up.
        const carlaBox = await lentRunner(t, t.carla);
        carla.send({ type: "live_view.subscribe", agentId: t.lia.id });
        expect((await carla.event("live_view.unavailable")).event).toMatchObject({
          reason: "no_environment",
        });
        online.delete(carlaBox);
      } finally {
        ana.close();
        carla.close();
        online.delete(anaBox);
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

  test(
    "B5: an admin demoted to member loses the live view they watch on the next recheck",
    async () => {
      const t = await team();
      const runner = await lentRunner(t, t.ana);
      const sock = await TestSocket.open(t.carla.browser, t.workspaceId);
      try {
        sock.send({ type: "live_view.subscribe", agentId: t.lia.id });
        await sock.event("live_view.status");
        await server.deps.db
          .update(schema.members)
          .set({ role: "member" })
          .where(eq(schema.members.userId, t.carla.user.id));
        await recheckLiveViews(server.deps);
        expect((await sock.event("live_view.unavailable")).event).toMatchObject({ reason: "forbidden" });
      } finally {
        sock.close();
        online.delete(runner);
      }
    },
    SERVER_TEST_MS,
  );
});

// ---- the agent's integrations ----

describe("the agent's integrations", () => {
  test(
    "its mail list reads like its other integrations: open to any member, missing for another workspace",
    async () => {
      const t = await team();
      const other = await team();
      const reads = ["mail", "databases", "scopes", "access", "identity"];
      const status = async (agentId: string) => {
        const out: Record<string, number> = {};
        for (const r of reads) out[r] = (await call(t.davi, "GET", `${t.w}/agents/${agentId}/${r}`)).status;
        return out;
      };
      expect(await status(t.lia.id)).toEqual(Object.fromEntries(reads.map((r) => [r, 200])));
      expect(await status(other.lia.id)).toEqual(Object.fromEntries(reads.map((r) => [r, 404])));
    },
    SERVER_TEST_MS,
  );
});

// ---- C: a memory review's origin ----

describe("a memory review's origin", () => {
  test(
    "C1: a review from a private channel goes only to deciders who read it, with its channel's name, never cached",
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
        const res = await who.browser.fetch(`${t.w}/memory-reviews?agentId=${t.lia.id}`);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        // The channel's name never reaches whoever doesn't read it.
        if (who !== t.ana) expect(text.includes(`#payroll${seq}`)).toBe(false);
        const body = JSON.parse(text) as { reviews: { origin: { channel: string | null } }[] };
        return body.reviews.map((r) => r.origin.channel);
      };
      expect(await listed(t.ana)).toEqual([`#payroll${seq}`]);
      // Beto owns Lia but isn't in #payroll: what its run there wants to remember isn't his to see or decide.
      expect(await listed(t.beto)).toEqual([]);
      const rejected = await call(t.beto, "POST", `${t.w}/memory-reviews/${review.id}/reject`, {});
      expect(rejected.status).toBe(404);
      expect(JSON.stringify(rejected.body).includes(`#payroll${seq}`)).toBe(false);
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
    "D4: a run's cost and tokens are null without view_usage, in the list and the detail",
    async () => {
      const t = await team();
      const id = newId("run");
      await server.deps.db.insert(schema.runs).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        channelId: t.general,
        status: "done",
        model: "claude-haiku-5-5",
        costUsd: 2,
        inputTokens: 10,
        cachedTokens: 3,
        outputTokens: 5,
      });
      const spend = (run: Record<string, unknown>) => [
        run.costUsd,
        run.inputTokens,
        run.cachedTokens,
        run.outputTokens,
      ];
      const listed = async (who: Person) =>
        (await call(who, "GET", `${t.w}/runs?agentId=${t.lia.id}`)).body.runs.find(
          (r: { id: string }) => r.id === id,
        );
      expect(spend(await listed(t.beto))).toEqual([null, null, null, null]);
      expect(spend((await call(t.beto, "GET", `${t.w}/runs/${id}`)).body.run)).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(spend(await listed(t.carla))).toEqual([2, 10, 3, 5]);
      expect(spend((await call(t.carla, "GET", `${t.w}/runs/${id}`)).body.run)).toEqual([2, 10, 3, 5]);
    },
    SERVER_TEST_MS,
  );

  test(
    "D5: a debate's spend is null without view_usage",
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
      const beto = await call(t.beto, "GET", `${t.w}/debates/${debateId}`);
      expect([beto.status, beto.body.spentUsd]).toEqual([200, null]);
      expect(typeof (await call(t.carla, "GET", `${t.w}/debates/${debateId}`)).body.spentUsd).toBe("number");
    },
    SERVER_TEST_MS,
  );

  test(
    "D6: an assignment's dollars and job tokens are null without view_usage; its minutes and steps stay",
    async () => {
      const t = await team();
      const row = await createAssignment(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        agentHandle: t.lia.handle,
        channelId: t.general,
        ownerId: t.beto.user.id,
        title: "Fix the flaky test",
        goal: "The suite passes ten times in a row",
        executor: "agent",
        runnerId: null,
        commandPolicy: "never",
      });
      const usage = async (who: Person) =>
        (await call(who, "GET", `${t.w}/assignments/${row.id}`)).body.usage;
      expect(await usage(t.beto)).toMatchObject({ dollars: null, jobTokens: null, minutes: 0, steps: 0 });
      expect(await usage(t.carla)).toMatchObject({ dollars: 0, minutes: 0, steps: 0 });
    },
    SERVER_TEST_MS,
  );

  test(
    "D7: a routine's recent cost is null without view_usage, and counts only the runs the person sees",
    async () => {
      const t = await team();
      const secret = await seedChannel(server, t.workspaceId, {
        name: `secret-${seq}`,
        visibility: "private",
        members: [t.beto],
      });
      const routineId = newId("rtn");
      await server.deps.db.insert(schema.routines).values({
        id: routineId,
        workspaceId: t.workspaceId,
        name: "Digest",
        prompt: "Sum up the day",
        agentId: t.lia.id,
        target: { kind: "channel", channelId: t.general },
        trigger: { kind: "webhook" },
        createdBy: t.carla.user.id,
      });
      // One run in #general, and one from when the routine pointed at a private channel Carla isn't in.
      for (const [channelId, cost] of [
        [t.general, 1],
        [secret, 5],
      ] as const) {
        const runId = newId("run");
        await server.deps.db.insert(schema.runs).values({
          id: runId,
          workspaceId: t.workspaceId,
          agentId: t.lia.id,
          channelId,
          status: "done",
          model: "claude-haiku-5-5",
          costUsd: cost,
        });
        await server.deps.db.insert(schema.routineExecutions).values({
          id: newId("rrun"),
          routineId,
          at: new Date(),
          status: "ok",
          trigger: "webhook",
          runId,
          channelId,
        });
      }
      const estimate = (who: Person) => call(who, "GET", `${t.w}/routines/${routineId}/estimate`);
      expect((await estimate(t.carla)).body.recent).toEqual({ runs: 1, avgUsd: 1, maxUsd: 1 });
      const beto = await estimate(t.beto);
      expect([beto.status, beto.body.recent]).toEqual([200, null]);
    },
    SERVER_TEST_MS,
  );

  test(
    "D8: an assignment's cap warning keeps its dollars from whoever lacks view_usage, and out of the channel event",
    async () => {
      const t = await team();
      const row = await createAssignment(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        agentHandle: t.lia.handle,
        channelId: t.general,
        ownerId: t.beto.user.id,
        title: "Fix the flaky test",
        goal: "The suite passes ten times in a row",
        executor: "agent",
        runnerId: null,
        commandPolicy: "never",
      });
      const usage = { dollars: 8.5, minutes: 3, steps: 2, jobTokens: 0, unmeasuredJobs: 0 };
      const socket = await TestSocket.open(t.carla.browser, t.workspaceId);
      try {
        expect((await socket.subscribe(t.general)).type).toBe("subscribed");
        await assignmentEvent(server.deps, row, {
          kind: "ceiling_warning",
          actor: SYSTEM,
          data: { which: "dollars", limit: 10, usage },
        });
        const live = (await socket.event("assignment.trail_event")).event as unknown as {
          event: { data: unknown };
        };
        expect(live.event.data).toEqual({
          which: "dollars",
          limit: 10,
          usage: { ...usage, dollars: null, jobTokens: null },
        });
      } finally {
        socket.close();
      }
      const warning = async (who: Person) =>
        (await call(who, "GET", `${t.w}/assignments/${row.id}/events`)).body.events.find(
          (e: { kind: string }) => e.kind === "ceiling_warning",
        )?.data.usage;
      expect(await warning(t.beto)).toEqual({ ...usage, dollars: null, jobTokens: null });
      expect(await warning(t.carla)).toEqual(usage);
    },
    SERVER_TEST_MS,
  );

  test(
    "D11: the 80% notice of a dollars cap reaches the assignment's owner only with view_usage",
    async () => {
      const t = await team();
      const notices = async (owner: Person) => {
        const row = await createAssignment(server.deps, {
          workspaceId: t.workspaceId,
          agentId: t.lia.id,
          agentHandle: t.lia.handle,
          channelId: t.general,
          ownerId: owner.user.id,
          title: "Fix the flaky test",
          goal: "The suite passes ten times in a row",
          executor: "agent",
          runnerId: null,
          commandPolicy: "never",
        });
        await server.deps.db
          .update(schema.assignments)
          .set({ status: "active", limits: { dollars: 10, minutes: 10, steps: null } })
          .where(eq(schema.assignments.id, row.id));
        for (const which of ["dollars", "minutes"] as const)
          await act(server.deps, row.id, { type: "warn", which });
        // Both warnings fold into the assignment's one notice: its count says how many reached the owner.
        const [notice] = await server.deps.db
          .select({ count: schema.notifications.count, latest: schema.notifications.latest })
          .from(schema.notifications)
          .where(eq(schema.notifications.groupKey, `assignment:${row.id}:assignment_stopped`));
        return [notice?.count ?? 0, notice?.latest.text];
      };
      // Beto lacks view_usage: he hears of the minutes cap, not of the dollars one.
      expect(await notices(t.beto)).toEqual([1, "80% of the minutes limit used"]);
      expect(await notices(t.carla)).toEqual([2, "80% of the minutes limit used"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "D9: a test run's cost is null without view_usage",
    async () => {
      const t = await team();
      const id = newId("eval");
      await server.deps.db.insert(schema.agentEvals).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        beforeText: "Helps.",
        textAfter: "Helps more.",
        status: "done",
        costUsd: 0.25,
      });
      const cost = async (who: Person) => {
        const one = await call(who, "GET", `${t.w}/agents/${t.lia.id}/evals/${id}`);
        const list = await call(who, "GET", `${t.w}/agents/${t.lia.id}/evals`);
        return [one.body.costUsd, list.body.evals[0]?.costUsd];
      };
      // Beto owns Lia, so he reads her test runs, but not what they spent.
      expect(await cost(t.beto)).toEqual([null, null]);
      expect(await cost(t.carla)).toEqual([0.25, 0.25]);
    },
    SERVER_TEST_MS,
  );

  test(
    "D10: a message's tokens are null without view_usage, and in the channel event",
    async () => {
      const t = await team();
      const [channel] = await server.deps.db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.id, t.general));
      if (!channel) throw new Error("no channel");
      const usage = { model: "claude-haiku-5-5", inputTokens: 120, outputTokens: 40 };
      const socket = await TestSocket.open(t.carla.browser, t.workspaceId);
      let id = "";
      try {
        expect((await socket.subscribe(t.general)).type).toBe("subscribed");
        const { message } = await postMessage(server.deps, {
          workspaceId: t.workspaceId,
          channel,
          author: { type: "agent", id: t.lia.id },
          body: "The report is ready.",
          clientId: null,
          usage,
        });
        id = message.id;
        const live = (await socket.event("message.posted")).event as unknown as {
          message: { usage: unknown };
        };
        expect(live.message.usage).toBe(null);
      } finally {
        socket.close();
      }
      const read = async (who: Person) =>
        (await call(who, "GET", `${t.w}/channels/${t.general}/messages`)).body.messages.find(
          (m: { id: string }) => m.id === id,
        )?.usage;
      expect(await read(t.beto)).toBe(null);
      expect(await read(t.carla)).toEqual(usage);
    },
    SERVER_TEST_MS,
  );

  test(
    "D2: the agent's budget notice reaches an owner without view_usage only when it runs out, with no amounts",
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
        const notify = (agentId: string, kind: "warning" | "exhausted" = "exhausted") =>
          server.deps.db
            .select()
            .from(schema.agents)
            .where(eq(schema.agents.id, agentId))
            .then(([row]) =>
              server.runtime["notifyBudget"](row as never, kind, kind === "warning" ? 8.5 : 12, 10),
            );
        // The 80% notice alone tells how much went: it doesn't reach Beto.
        await notify(t.lia.id, "warning");
        expect(sent.filter((s) => s.userId === t.beto.user.id)).toEqual([]);
        await notify(t.lia.id);
        expect(sent.find((s) => s.userId === t.beto.user.id)?.event).toMatchObject({
          type: "budget.cap_reached",
          agentId: t.lia.id,
          spentUsd: null,
          budgetUsd: null,
        });
        const owned = await seedAgent(server, t.workspaceId, t.carla, "max");
        await notify(owned.id, "warning");
        expect(sent.find((s) => s.userId === t.carla.user.id)?.event).toMatchObject({
          type: "budget.threshold_reached",
          spentUsd: 8.5,
          budgetUsd: 10,
        });
        await notify(owned.id);
        expect(sent.findLast((s) => s.userId === t.carla.user.id)?.event).toMatchObject({
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

describe("a budget notice whose recipients can't be read", () => {
  test(
    "isn't claimed: the next check still sends it, for the agent and for the channel",
    async () => {
      const t = await team();
      const runtime = server.runtime;
      const seesUsage = runtime["seesUsage"].bind(runtime);
      const sent: string[] = [];
      const { hub } = server.deps;
      const toUser = hub.toUser.bind(hub);
      hub.toUser = (workspaceId, userId, event) => {
        sent.push((event as { type: string }).type);
        return toUser(workspaceId, userId, event);
      };
      const failOnce = () => {
        runtime["seesUsage"] = async () => {
          runtime["seesUsage"] = seesUsage;
          throw new Error("members read failed");
        };
      };
      try {
        const [agent] = await server.deps.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, t.lia.id));
        failOnce();
        await expect(runtime["notifyBudget"](agent as never, "exhausted", 12, 10)).rejects.toThrow(
          "members read failed",
        );
        await runtime["notifyBudget"](agent as never, "exhausted", 12, 10);
        expect(sent).toEqual(["budget.cap_reached"]);
        const channel = await seedChannel(server, t.workspaceId, { name: `fin${seq}`, members: [t.ana] });
        await server.deps.db
          .update(schema.channels)
          .set({ budgetPerMonthUsd: 10 })
          .where(eq(schema.channels.id, channel));
        failOnce();
        await expect(runtime["channelBudgetCheck"](channel, null, true) as Promise<void>).rejects.toThrow();
        await runtime["channelBudgetCheck"](channel, null, true);
        expect(sent.filter((s) => s === "channel.budget").length).toBeGreaterThan(0);
      } finally {
        runtime["seesUsage"] = seesUsage;
        hub.toUser = toUser;
      }
    },
    SERVER_TEST_MS,
  );
});
