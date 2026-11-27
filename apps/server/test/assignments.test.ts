// The assignment routes over HTTP: an assignment on a runner from creation to done with its proofs read back, who
// may see and do what (another workspace's member and a reader outside the private channel get 404, a reader
// can't act, only the owner or an admin manages), the person's plan edits, the answers (commands, decisions,
// reviews, submissions, suggestions, join requests), the wiki copy of a private channel's assignment, two
// people at once on the same transition, and the routes refused before any write without the agent runtime.
// The server runs on `agentRuntime` (the runtime as the engine sees it before slice S6) with a verifier that
// passes everything; the runner is a fake one speaking the protocol, paired through its owner's browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { createAssignment } from "../src/assignments/engine";
import { jobIdOf, workIdOf } from "../src/assignments/keys";
import { finishAssignment, requestSubmissionChanges } from "../src/assignments/lifecycle";
import type { RunningServer } from "../src/server";
import { agentRuntime, pairRunner, passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import type { ProtocolRunner } from "./protocol-runner";
import { type Called, call, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

const {
  assignments,
  assignmentCommands,
  assignmentDecisions,
  assignmentReviews,
  assignmentPlanItems,
  runnerJobs,
} = schema;

let server: RunningServer;
let n = 0;
const email = (who: string) => `${who}${++n}@assignments.test`;
const runtime = agentRuntime();
const verify = passing();

beforeAll(async () => {
  server = await startTestServer({ runtime: runtime.wrap, assignmentVerifier: verify.verifier });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server?.stop();
}, SERVER_TEST_MS);

const idle = () => server.deps.assignmentEngine.idle();
const code = (r: Called) => r.body?.error?.code;

interface Team {
  ana: Person;
  beto: Person;
  caio: Person;
  dora: Person;
  workspaceId: string;
  general: string;
  agentId: string;
  /** Ana's assignment in #general (agent executor, proposed). */
  assignmentId: string;
  threadId: string;
  path: string;
}

/** Ana (owner), Beto and Caio (members), Dora (admin); Lia in #general; Ana's proposed assignment. */
async function team(): Promise<Team> {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const dora = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
  const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
  const created = await call(ana, "POST", `${ws(workspaceId)}/assignments`, {
    agentId,
    channelId: general,
    goal: "Ship the site\nwith the docs",
  });
  expect(created.status).toBe(201);
  return {
    ana,
    beto,
    caio,
    dora,
    workspaceId,
    general,
    agentId,
    assignmentId: created.body.id,
    threadId: created.body.threadId,
    path: `${ws(workspaceId)}/assignments/${created.body.id}`,
  };
}

/** Someone with a workspace of their own, outside the team's. */
async function outsider() {
  const zed = await signedIn(server, "Zed", email("zed"));
  const { workspaceId } = await seedWorkspace(server, zed, "Elsewhere");
  return { zed, workspaceId };
}

/** The fake runner can run Claude Code on its pairer's subscription (the hello of the fake says nothing of it). */
async function claudeRunner(
  owner: Person,
  workspaceId: string,
  starts: string[] = [],
): Promise<ProtocolRunner> {
  const runner = await pairRunner(server, owner, workspaceId, (id) => starts.push(id));
  await server.deps.db
    .update(schema.runners)
    .set({
      executors: ["claude_code"],
      access: { folders: [], tools: { claude: true, codex: false, commands: true, browser: false } },
      cli: { claude_code: { login: "subscription", plan: "max", version: "9.9.9" } },
    })
    .where(eq(schema.runners.id, runner.runnerId));
  return runner;
}

/** The runner ends a job and the server acknowledges it (the end was processed). */
async function endJob(runner: ProtocolRunner, jobId: string, itemId: string) {
  runner.send({
    type: "job.done",
    job: {
      jobId,
      status: "done",
      exitCode: 0,
      result: `Did ${itemId}`,
      files: [`src/${itemId}.ts`],
      session: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      denied: [],
      diff: `diff --git a/src/${itemId}.ts b/src/${itemId}.ts\n+ok`,
      blocked: [],
    },
  });
  await runner.next((f) => f.type === "job.ack" && f.jobId === jobId);
}

const status = async (id: string) =>
  (await server.deps.db.select().from(assignments).where(eq(assignments.id, id)))[0]?.status;

describe("an assignment on a runner, over HTTP", () => {
  test(
    "create, plan, start, comment and complete; the proofs read back; another workspace's member gets 404",
    async () => {
      const ana = await signedIn(server, "Ana", email("ana"));
      const { workspaceId, general } = await seedWorkspace(server, ana, "Live");
      const starts: string[] = [];
      const runner = await claudeRunner(ana, workspaceId, starts);
      try {
        const agentId = await seedAgent(server.deps.db, workspaceId, ana, runner.runnerId);
        const base = `${ws(workspaceId)}/assignments`;
        const eligible = await call(ana, "GET", `${base}/eligible-agents`);
        expect(eligible.body.agents.find((a: { agentId: string }) => a.agentId === agentId)).toMatchObject({
          executors: ["agent", "claude_code"],
          runner: { id: runner.runnerId, online: true },
          manageable: true,
        });

        const created = await call(ana, "POST", base, {
          agentId,
          channelId: general,
          goal: "Fix the tests",
          executor: "claude_code",
          runnerId: runner.runnerId,
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
          title: "Fix the tests",
          status: "proposed",
          executor: "claude_code",
        });
        expect(created.body.runner.executors).toContain("claude_code");
        const path = `${base}/${created.body.id}`;
        const harness = await call(ana, "GET", `${path}/runtime`);
        expect(harness.body.options.map((o: { kind: string }) => o.kind)).toEqual(["agent", "claude_code"]);
        const codex = await call(ana, "PUT", `${path}/runtime`, { harness: "codex" });
        expect([codex.status, code(codex)]).toEqual([409, "assignment.executor_unavailable"]);
        const sonnet = await call(ana, "PUT", `${path}/runtime`, { harness: "claude_code", model: "sonnet" });
        expect(sonnet.body.resolvedModel).toBe("sonnet");

        const plan = await call(ana, "PUT", `${path}/plan`, {
          parentVersion: 0,
          items: [{ id: "p1", title: "Make the tests pass", criteria: "The suite is green" }],
        });
        expect(plan.body.current.version).toBe(1);
        expect((await call(ana, "POST", `${path}/start`)).body.status).toBe("active");
        const firstJob = jobIdOf(workIdOf(created.body.id, "p1", 1));
        await runner.next(
          (f) => f.type === "request" && f.op === "job.start" && f.args.jobId === firstJob,
          15_000,
        );
        await endJob(runner, firstJob, "p1");
        await idle();
        expect(await status(created.body.id)).toBe("wrapping_up");

        // A comment while nothing runs goes to the runner as a resumed job.
        const comment = await call(ana, "POST", `${path}/messages`, { text: "Also bump the version" });
        expect(comment.body).toMatchObject({ delivered: true });
        const commentJob = comment.body.jobId as string;
        const sent = await runner.next(
          (f) => f.type === "request" && f.op === "job.start" && f.args.jobId === commentJob,
          15_000,
        );
        expect(JSON.stringify(sent)).toContain("Also bump the version");
        await endJob(runner, commentJob, "version");
        const jobs = await call(ana, "GET", `${ws(workspaceId)}/threads/${created.body.threadId}/jobs`);
        expect(jobs.body.jobs.map((j: { id: string }) => j.id).sort()).toEqual([commentJob, firstJob].sort());
        const output = await call(ana, "GET", `${ws(workspaceId)}/jobs/${firstJob}/output`);
        expect(output.status).toBe(200);

        const [submission] = (await call(ana, "GET", `${path}/submissions`)).body;
        expect(submission).toMatchObject({ status: "pending", auto: true });
        const done = await call(ana, "POST", `${path}/submissions/${submission.id}/accept`, {
          copyToWiki: true,
        });
        expect([done.status, done.body.status, done.body.outcome]).toEqual([200, "done", "done"]);
        expect((await call(ana, "GET", `${path}/submissions`)).body[0].status).toBe("accepted");

        const proofs = (await call(ana, "GET", `${path}/proofs`)).body.proofs;
        expect(
          proofs.filter((p: { jobId: string }) => p.jobId === firstJob).map((p: { kind: string }) => p.kind),
        ).toEqual(["files", "diff"]);
        expect(proofs.find((p: { kind: string }) => p.kind === "diff").body).toContain("+ok");
        const events = (await call(ana, "GET", `${path}/events`)).body.events.map(
          (e: { kind: string }) => e.kind,
        );
        expect(events).toContain("started");
        expect(events.at(-1)).toBe("closed");

        // Another workspace's member: through their workspace the id is unknown, through Ana's the workspace is.
        const { zed, workspaceId: theirs } = await outsider();
        const viaTheirs = await call(zed, "GET", `${ws(theirs)}/assignments/${created.body.id}`);
        expect([viaTheirs.status, code(viaTheirs)]).toEqual([404, "assignment.not_found"]);
        const viaOurs = await call(zed, "GET", path);
        expect([viaOurs.status, code(viaOurs)]).toEqual([404, "not_found"]);
        const output404 = await call(zed, "GET", `${ws(theirs)}/jobs/${firstJob}/output`);
        expect([output404.status, code(output404)]).toEqual([404, "not_found"]);
      } finally {
        await runner.close();
      }
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "three messages at once open one job; closing cancels the job that runs",
    async () => {
      const ana = await signedIn(server, "Ana", email("ana"));
      const { workspaceId, general } = await seedWorkspace(server, ana, "Race");
      const runner = await claudeRunner(ana, workspaceId);
      try {
        const agentId = await seedAgent(server.deps.db, workspaceId, ana, runner.runnerId);
        const created = await call(ana, "POST", `${ws(workspaceId)}/assignments`, {
          agentId,
          channelId: general,
          goal: "Tidy the page",
          executor: "claude_code",
          runnerId: runner.runnerId,
        });
        const id = created.body.id as string;
        const path = `${ws(workspaceId)}/assignments/${id}`;
        // Active without a plan item to work on: the engine waits, the messages are what opens a job.
        await server.deps.db.update(assignments).set({ status: "active" }).where(eq(assignments.id, id));
        const sent = await Promise.all(
          [1, 2, 3].map((i) => call(ana, "POST", `${path}/messages`, { text: `part ${i}` })),
        );
        expect(sent.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(sent.filter((r) => r.body.delivered)).toHaveLength(1);
        const live = async () =>
          (await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.assignmentId, id))).filter(
            (j) => j.status === "queued" || j.status === "running",
          );
        expect(await live()).toHaveLength(1);
        const cancel = runner.next((f) => f.type === "request" && f.op === "job.cancel", 15_000);
        const closed = await call(ana, "POST", `${path}/close`, { outcome: "canceled", note: "Later" });
        expect([closed.body.status, closed.body.findings.at(-1)]).toEqual(["canceled", "Later"]);
        await cancel;
        const again = await call(ana, "POST", `${path}/close`, { outcome: "done" });
        expect([again.status, code(again)]).toEqual([409, "assignment.closed"]);
      } finally {
        await runner.close();
      }
    },
    2 * SERVER_TEST_MS,
  );
});

describe("who sees and does what", () => {
  test(
    "every assignment route is a 404 for another workspace's member and for a reader outside the private channel",
    async () => {
      const t = await team();
      const priv = await seedChannel(server, t.workspaceId, {
        name: `priv${n}`,
        visibility: "private",
        members: [t.ana],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: priv, memberType: "agent", memberId: t.agentId });
      const hidden = await call(t.ana, "POST", `${ws(t.workspaceId)}/assignments`, {
        agentId: t.agentId,
        channelId: priv,
        goal: "Secret plan",
      });
      expect(hidden.status).toBe(201);
      const routes: [string, string, unknown?][] = [
        ["GET", ""],
        ["PATCH", "", { resumeJobs: false }],
        ["POST", "/start"],
        ["POST", "/pause"],
        ["POST", "/close", { outcome: "canceled" }],
        ["POST", "/messages", { text: "hi" }],
        ["GET", "/participants"],
        ["PATCH", `/participants/${t.beto.user.id}`, { role: "decide" }],
        ["DELETE", `/participants/${t.beto.user.id}`],
        ["GET", "/join-requests"],
        ["POST", "/join-requests"],
        ["POST", `/join-requests/${t.beto.user.id}/accept`, {}],
        ["POST", "/transfer", { userId: t.beto.user.id }],
        ["PUT", "/runner", { runnerId: "rn_x" }],
        ["PUT", "/executor", { executor: "agent" }],
        ["PUT", "/command-approval", { commandPolicy: "never" }],
        ["GET", "/settings"],
        ["GET", "/runtime"],
        ["PUT", "/runtime", { harness: "agent" }],
        ["DELETE", "/command-rules/acr_x"],
        ["GET", "/commands"],
        ["POST", "/commands/cmd_x/decide", { decision: "allow" }],
        ["POST", "/commands/retry", { jobId: "aj_x", commands: ["ls"] }],
        ["GET", "/decisions"],
        ["POST", "/decisions/approve-provisional"],
        ["POST", "/decisions/dec_x/choose", { option: "a" }],
        ["POST", "/decisions/dec_x/opinion", { option: "a" }],
        ["GET", "/reviews"],
        ["POST", "/reviews/rev_x/approve", {}],
        ["GET", "/submissions"],
        ["PUT", "/submissions/asub_x/checklist/c1", { checked: true }],
        ["POST", "/submissions/asub_x/accept", {}],
        ["POST", "/submissions/asub_x/request-changes", { note: "x" }],
        ["POST", "/suggestions/msg_x/accept"],
        ["GET", "/files"],
        ["GET", "/summary"],
        ["GET", "/plan"],
        ["PUT", "/plan", { parentVersion: 0, items: [] }],
        ["GET", "/plan/versions"],
        ["GET", "/events"],
        ["POST", "/seen", { seq: 0 }],
        ["GET", "/proofs"],
        ["POST", "/items/p1/retry"],
      ];
      const { zed, workspaceId: theirs } = await outsider();
      for (const [method, tail, payload] of routes) {
        const cross = await call(zed, method, `${ws(theirs)}/assignments/${t.assignmentId}${tail}`, payload);
        expect([method, tail, cross.status, code(cross)]).toEqual([
          method,
          tail,
          404,
          "assignment.not_found",
        ]);
        const outside = await call(
          t.caio,
          method,
          `${ws(t.workspaceId)}/assignments/${hidden.body.id}${tail}`,
          payload,
        );
        expect([method, tail, outside.status, code(outside)]).toEqual([
          method,
          tail,
          404,
          "assignment.not_found",
        ]);
      }
      const thread = await call(zed, "GET", `${ws(theirs)}/threads/${t.threadId}/assignment`);
      expect([thread.status, code(thread)]).toEqual([404, "not_found"]);
      const hiddenThread = await call(
        t.caio,
        "GET",
        `${ws(t.workspaceId)}/threads/${hidden.body.threadId}/assignment`,
      );
      expect(hiddenThread.status).toBe(404);
      const jobs = await call(t.caio, "GET", `${ws(t.workspaceId)}/threads/${hidden.body.threadId}/jobs`);
      expect(jobs.status).toBe(404);
      // The list doesn't show them either.
      const list = await call(t.caio, "GET", `${ws(t.workspaceId)}/assignments`);
      expect(list.body.assignments.map((a: { id: string }) => a.id)).toEqual([t.assignmentId]);
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "a reader can't act, a commenter gives opinions but can't decide, only the owner or an admin manages",
    async () => {
      const t = await team();
      const asReader = await call(t.caio, "POST", `${t.path}/start`);
      expect([asReader.status, code(asReader)]).toEqual([403, "assignment.forbidden"]);
      expect((await call(t.caio, "GET", t.path)).body).toMatchObject({ role: "view", actionable: false });
      const decision = newId("adec");
      await server.deps.db.insert(assignmentDecisions).values({
        id: decision,
        assignmentId: t.assignmentId,
        question: "Which host?",
        options: ["a", "b"],
        status: "pending",
      });
      const readerOpinion = await call(t.caio, "POST", `${t.path}/decisions/${decision}/opinion`, {
        option: "a",
      });
      expect([readerOpinion.status, code(readerOpinion)]).toEqual([403, "assignment.forbidden"]);

      expect(
        (await call(t.ana, "PATCH", `${t.path}/participants/${t.beto.user.id}`, { role: "comment" })).status,
      ).toBe(200);
      const opinion = await call(t.beto, "POST", `${t.path}/decisions/${decision}/opinion`, { option: "b" });
      expect(
        opinion.body.opinions.map((o: { userId: string; option: string }) => [o.userId, o.option]),
      ).toEqual([[t.beto.user.id, "b"]]);
      const choose = await call(t.beto, "POST", `${t.path}/decisions/${decision}/choose`, { option: "b" });
      expect(choose.status).toBe(403);
      // A participant doesn't manage: limits, runner, executor and people stay the owner's (or an admin's).
      expect((await call(t.beto, "PATCH", t.path, { limits: { dollars: 1 } })).status).toBe(403);
      expect(
        (await call(t.beto, "PATCH", `${t.path}/participants/${t.caio.user.id}`, { role: "decide" })).status,
      ).toBe(403);
      const admin = await call(t.dora, "PATCH", t.path, { limits: { dollars: 2, steps: 7.9 } });
      expect([admin.status, admin.body.limits]).toEqual([200, { dollars: 2, minutes: 480, steps: 7 }]);
      // Who decides acts; leaving is always allowed.
      await call(t.ana, "PATCH", `${t.path}/participants/${t.beto.user.id}`, { role: "decide" });
      expect(
        (await call(t.beto, "POST", `${t.path}/decisions/${decision}/choose`, { option: "b" })).body.status,
      ).toBe("taken");
      const twice = await call(t.ana, "POST", `${t.path}/decisions/${decision}/choose`, { option: "a" });
      expect([twice.status, code(twice)]).toEqual([409, "assignment.decision_taken"]);
      expect((await call(t.beto, "DELETE", `${t.path}/participants/${t.beto.user.id}`)).status).toBe(204);
      expect((await call(t.beto, "POST", `${t.path}/start`)).status).toBe(403);
    },
    SERVER_TEST_MS,
  );

  test(
    "a participant or a new owner must read a private channel; a participant who leaves it loses the assignment",
    async () => {
      const t = await team();
      const priv = await seedChannel(server, t.workspaceId, {
        name: `room${n}`,
        visibility: "private",
        members: [t.ana, t.beto],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: priv, memberType: "agent", memberId: t.agentId });
      const created = await call(t.ana, "POST", `${ws(t.workspaceId)}/assignments`, {
        agentId: t.agentId,
        channelId: priv,
        goal: "Private work",
      });
      const path = `${ws(t.workspaceId)}/assignments/${created.body.id}`;
      const outsiderIn = await call(t.ana, "PATCH", `${path}/participants/${t.caio.user.id}`, {
        role: "decide",
      });
      expect([outsiderIn.status, outsiderIn.body.error.params.field]).toEqual([400, "userId"]);
      const handOver = await call(t.ana, "POST", `${path}/transfer`, { userId: t.caio.user.id });
      expect(handOver.status).toBe(400);
      expect(
        (await call(t.ana, "PATCH", `${path}/participants/${t.beto.user.id}`, { role: "decide" })).status,
      ).toBe(200);
      expect((await call(t.beto, "GET", path)).body.role).toBe("decide");
      await server.deps.db
        .delete(schema.channelMemberships)
        .where(
          and(
            eq(schema.channelMemberships.channelId, priv),
            eq(schema.channelMemberships.memberId, t.beto.user.id),
          ),
        );
      const gone = await call(t.beto, "GET", path);
      expect([gone.status, code(gone)]).toEqual([404, "assignment.not_found"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "create checks the workspace: another workspace's agent, channel or runner is a 404; the agent must be in the channel",
    async () => {
      const t = await team();
      const { zed, workspaceId: theirs } = await outsider();
      const runner = await claudeRunner(zed, theirs);
      try {
        const theirAgent = await seedAgent(server.deps.db, theirs, zed, runner.runnerId);
        const base = `${ws(t.workspaceId)}/assignments`;
        const agent404 = await call(t.ana, "POST", base, {
          agentId: theirAgent,
          channelId: t.general,
          goal: "x",
        });
        expect([agent404.status, code(agent404)]).toEqual([404, "not_found"]);
        const runner404 = await call(t.ana, "POST", base, {
          agentId: t.agentId,
          channelId: t.general,
          goal: "x",
          executor: "claude_code",
          runnerId: runner.runnerId,
        });
        expect([runner404.status, code(runner404)]).toEqual([404, "runner.not_found"]);
        const setRunner = await call(t.ana, "PUT", `${t.path}/runner`, { runnerId: runner.runnerId });
        expect([setRunner.status, code(setRunner)]).toEqual([404, "runner.not_found"]);
        const theirGeneral = (await seedWorkspace(server, zed, "Other")).general;
        const channel404 = await call(t.ana, "POST", base, {
          agentId: t.agentId,
          channelId: theirGeneral,
          goal: "x",
        });
        expect(channel404.status).toBe(404);
        // Nothing was created by the refused calls.
        expect((await call(t.ana, "GET", base)).body.assignments).toHaveLength(1);

        const bare = await seedChannel(server, t.workspaceId, { name: `bare${n}`, members: [t.ana] });
        const notIn = await call(t.ana, "POST", base, { agentId: t.agentId, channelId: bare, goal: "x" });
        expect([notIn.status, code(notIn)]).toEqual([409, "assignment.agent_not_in_channel"]);
        const again = await call(t.ana, "POST", base, {
          agentId: t.agentId,
          channelId: t.general,
          goal: "y",
          threadId: t.threadId,
        });
        expect([again.status, code(again)]).toEqual([409, "assignment.exists"]);
        const extra = await call(t.ana, "POST", base, {
          agentId: t.agentId,
          channelId: t.general,
          goal: "z",
          passes: true,
        });
        expect(extra.status).toBe(400);
      } finally {
        await runner.close();
      }
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "the runner and the hand-over: only who may use the runner sets or lends it; without lending the assignment leaves it",
    async () => {
      const t = await team();
      const runner = await claudeRunner(t.ana, t.workspaceId);
      try {
        const forbiddenRunner = await call(t.ana, "POST", `${t.path}/transfer`, { userId: t.beto.user.id });
        expect(forbiddenRunner.body.ownerId).toBe(t.beto.user.id);
        const back = await call(t.beto, "POST", `${t.path}/transfer`, { userId: t.ana.user.id });
        expect(back.body.ownerId).toBe(t.ana.user.id);
        expect((await call(t.beto, "PUT", `${t.path}/runner`, { runnerId: runner.runnerId })).status).toBe(
          403,
        );
        expect(
          (await call(t.ana, "PUT", `${t.path}/runner`, { runnerId: runner.runnerId, checkoutPath: "/repo" }))
            .body.checkoutPath,
        ).toBe("/repo");
        // Without the folder it keeps the one it had; "" clears it.
        expect(
          (await call(t.ana, "PUT", `${t.path}/runner`, { runnerId: runner.runnerId })).body.checkoutPath,
        ).toBe("/repo");
        expect(
          (await call(t.ana, "PUT", `${t.path}/runner`, { runnerId: runner.runnerId, checkoutPath: "" })).body
            .checkoutPath,
        ).toBeNull();
        expect(
          (await call(t.ana, "PUT", `${t.path}/executor`, { executor: "claude_code" })).body.executor,
        ).toBe("claude_code");

        const dropped = await call(t.ana, "POST", `${t.path}/transfer`, { userId: t.beto.user.id });
        expect([
          dropped.body.ownerId,
          dropped.body.code,
          dropped.body.runner,
          dropped.body.needsEnvironment,
        ]).toEqual([t.beto.user.id, "assignment.needs_environment", null, true]);
        await call(t.beto, "POST", `${t.path}/transfer`, { userId: t.ana.user.id });
        await call(t.ana, "PUT", `${t.path}/runner`, { runnerId: runner.runnerId });
        const lent = await call(t.ana, "POST", `${t.path}/transfer`, {
          userId: t.beto.user.id,
          lendRunner: true,
        });
        expect([lent.body.ownerId, lent.body.runner?.id]).toEqual([t.beto.user.id, runner.runnerId]);
        const people = await call(t.beto, "GET", `${t.path}/participants`);
        expect(people.body).toEqual({
          owner: { userId: t.beto.user.id, name: "Beto" },
          participants: [{ userId: t.ana.user.id, name: "Ana", role: "decide" }],
        });
        expect((await call(t.ana, "GET", t.path)).body.actionable).toBe(true);
        // Beto owns it on a lent runner he can't use himself: he can't lend it on.
        const lendsOn = await call(t.beto, "POST", `${t.path}/transfer`, {
          userId: t.caio.user.id,
          lendRunner: true,
        });
        expect(lendsOn.status).toBe(403);
      } finally {
        await runner.close();
      }
    },
    2 * SERVER_TEST_MS,
  );
});

describe("the person's answers", () => {
  test(
    "the plan: version and author, an old version is a 409, an item left out drops, an approved item put back loses its verdict",
    async () => {
      const t = await team();
      const v1 = await call(t.ana, "PUT", `${t.path}/plan`, {
        parentVersion: 0,
        items: [
          { id: "p1", title: "Read the code", criteria: "A list of the modules" },
          { id: "p2", title: "Write the plan", status: "todo" },
        ],
      });
      expect(v1.body.current.version).toBe(1);
      expect(
        v1.body.current.items.map((i: { id: string; passes: unknown; createdBy: { type: string } }) => [
          i.id,
          i.passes,
          i.createdBy.type,
        ]),
      ).toEqual([
        ["p1", null, "person"],
        ["p2", null, "person"],
      ]);
      // Only the verifier approves: `passes` isn't an input field.
      const approve = await call(t.ana, "PUT", `${t.path}/plan`, {
        parentVersion: 1,
        items: [{ id: "p1", title: "x", passes: true }],
      });
      expect(approve.status).toBe(400);
      const stale = await call(t.ana, "PUT", `${t.path}/plan`, { parentVersion: 0, items: [] });
      expect([stale.status, code(stale)]).toEqual([409, "assignment.plan_changed"]);
      // A reader edits nothing.
      expect((await call(t.caio, "PUT", `${t.path}/plan`, { parentVersion: 1, items: [] })).status).toBe(403);

      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done", passes: true, verdict: "ok", verifiedAt: new Date() })
        .where(and(eq(assignmentPlanItems.assignmentId, t.assignmentId), eq(assignmentPlanItems.id, "p1")));
      const back = await call(t.ana, "PUT", `${t.path}/plan`, {
        parentVersion: 1,
        items: [{ id: "p1", title: "Read the code", status: "todo" }],
        note: "p2 isn't needed",
      });
      const items = back.body.current.items;
      expect(items.find((i: { id: string }) => i.id === "p1")).toMatchObject({
        status: "todo",
        passes: null,
      });
      expect(items.find((i: { id: string }) => i.id === "p2").status).toBe("dropped");
      const versions = (await call(t.ana, "GET", `${t.path}/plan/versions`)).body.versions;
      expect(
        versions.map((v: { version: number; author: { type: string; id: string }; note: string | null }) => [
          v.version,
          v.author,
          v.note,
        ]),
      ).toEqual([
        [1, { type: "person", id: t.ana.user.id }, null],
        [2, { type: "person", id: t.ana.user.id }, "p2 isn't needed"],
      ]);
      const summary = await call(t.ana, "GET", `${t.path}/summary`);
      expect(summary.body).toEqual({
        plan: { done: 0, total: 1, inProgress: 0, waiting: 0 },
        running: 0,
        pendingDecisions: 0,
        provisionalDecisions: 0,
        pendingReviews: 0,
      });
      const files = await call(t.caio, "GET", `${t.path}/files`);
      expect(files.body.files.map((f: { name: string }) => f.name)).toEqual([
        "assignment.md",
        "decisions.md",
        "notes.md",
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "trying a stuck item again zeroes its turns and rounds in a new epoch, and the trail says so",
    async () => {
      const t = await team();
      await call(t.ana, "PUT", `${t.path}/plan`, {
        parentVersion: 0,
        items: [{ id: "p1", title: "Screen" }],
      });
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "blocked_on_you", turns: 4, checks: 3 })
        .where(and(eq(assignmentPlanItems.assignmentId, t.assignmentId), eq(assignmentPlanItems.id, "p1")));
      const [before] = await server.deps.db
        .select()
        .from(assignmentPlanItems)
        .where(eq(assignmentPlanItems.assignmentId, t.assignmentId));
      const retried = await call(t.ana, "POST", `${t.path}/items/p1/retry`);
      expect(retried.body).toMatchObject({ id: "p1", status: "todo", stallReason: null });
      const [after] = await server.deps.db
        .select()
        .from(assignmentPlanItems)
        .where(eq(assignmentPlanItems.assignmentId, t.assignmentId));
      expect([after?.turns, after?.checks, after?.epoch]).toEqual([0, 0, (before?.epoch ?? 0) + 1]);
      const events = (await call(t.ana, "GET", `${t.path}/events`)).body;
      expect(events.events.at(-1)).toMatchObject({ kind: "item_retry", itemId: "p1" });
      expect((await call(t.ana, "POST", `${t.path}/items/nope/retry`)).status).toBe(404);
      const seen = await call(t.ana, "POST", `${t.path}/seen`, { seq: 10_000 });
      expect(seen.body.seenSeq).toBe(events.lastSeq);
    },
    SERVER_TEST_MS,
  );

  test(
    "commands, reviews, join requests and suggestions are answered once",
    async () => {
      const t = await team();
      await server.deps.db
        .update(assignments)
        .set({ status: "paused" })
        .where(eq(assignments.id, t.assignmentId));
      const cmd = newId("acmd");
      await server.deps.db.insert(assignmentCommands).values({
        id: cmd,
        assignmentId: t.assignmentId,
        jobId: "aj_test",
        command: "npm test --watch=false",
        tool: "Bash",
        rules: ["npm test *"],
      });
      const decided = await Promise.all(
        [1, 2].map(() => call(t.ana, "POST", `${t.path}/commands/${cmd}/decide`, { decision: "always" })),
      );
      expect(decided.map((r) => r.status).sort()).toEqual([200, 409]);
      const commands = (await call(t.caio, "GET", `${t.path}/commands`)).body;
      expect([commands.commands[0].state, commands.rules]).toEqual(["allowed", ["npm test *"]]);
      const settings = (await call(t.ana, "GET", `${t.path}/settings`)).body;
      expect(settings.rules.map((r: { rule: string; by: string }) => [r.rule, r.by])).toEqual([
        ["npm test *", "Ana"],
      ]);
      expect(settings.agentBaseline).toEqual({ commandPolicy: "when_safe", adjustable: true });
      expect(
        (
          await call(t.caio, "PUT", `${ws(t.workspaceId)}/agents/${t.agentId}/assignment-command-approval`, {
            commandPolicy: "never",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(t.ana, "PUT", `${ws(t.workspaceId)}/agents/${t.agentId}/assignment-command-approval`, {
            commandPolicy: "when_safe",
          })
        ).body,
      ).toEqual({ commandPolicy: "when_safe" });
      const removed = await call(t.ana, "DELETE", `${t.path}/command-rules/${settings.rules[0].id}`);
      expect(removed.body.rules).toEqual([]);

      const review = newId("arev");
      await server.deps.db
        .insert(assignmentReviews)
        .values({ id: review, assignmentId: t.assignmentId, title: "Login page", summary: "Done" });
      const noNote = await call(t.ana, "POST", `${t.path}/reviews/${review}/changes`, {});
      expect(noNote.status).toBe(400);
      const reviewed = await Promise.all(
        [1, 2].map(() => call(t.ana, "POST", `${t.path}/reviews/${review}/approve`, {})),
      );
      expect(reviewed.map((r) => r.status).sort()).toEqual([200, 409]);

      // Caio reads the channel: he asks to join, Ana sees it and accepts him as a commenter.
      const asked = await call(t.caio, "POST", `${t.path}/join-requests`);
      expect([asked.status, asked.body.status]).toEqual([201, "pending"]);
      expect((await call(t.ana, "GET", t.path)).body.pending.joinRequests).toBe(1);
      const [note] = await server.deps.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.userId, t.ana.user.id));
      expect(note).toMatchObject({ kind: "question_for_you", reason: "join_requested" });
      const accepted = await call(t.ana, "POST", `${t.path}/join-requests/${t.caio.user.id}/accept`, {
        role: "comment",
      });
      expect([accepted.body.status, accepted.body.role]).toEqual(["accepted", "comment"]);
      const reAccept = await call(t.ana, "POST", `${t.path}/join-requests/${t.caio.user.id}/decline`);
      expect([reAccept.status, code(reAccept)]).toEqual([409, "assignment.join_closed"]);
      const member = await call(t.caio, "POST", `${t.path}/join-requests`);
      expect([member.status, code(member)]).toEqual([409, "assignment.already_participant"]);

      const [msg] = await server.deps.db
        .insert(schema.messages)
        .values({
          id: newId("msg"),
          workspaceId: t.workspaceId,
          channelId: t.general,
          threadId: t.threadId,
          authorKind: "person",
          authorId: t.beto.user.id,
          body: "Use the dark theme",
          meta: { assignmentSuggestion: { assignmentId: t.assignmentId, text: "Use the dark theme" } },
        })
        .returning();
      const suggestion = await call(t.ana, "POST", `${t.path}/suggestions/${msg?.id}/decline`);
      expect(suggestion.body).toEqual({ messageId: msg?.id, status: "declined" });
      const twice = await call(t.ana, "POST", `${t.path}/suggestions/${msg?.id}/accept`);
      expect([twice.status, code(twice)]).toEqual([409, "assignment.suggestion_closed"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "lifecycle: two starts at once start it once; resume waits for the cap; pause twice pauses once",
    async () => {
      const t = await team();
      const starts = await Promise.all([1, 2, 3].map(() => call(t.ana, "POST", `${t.path}/start`)));
      expect(starts.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(starts.filter((r) => r.status === 409).map(code)).toEqual([
        "assignment.not_proposed",
        "assignment.not_proposed",
      ]);
      const pauses = await Promise.all([1, 2].map(() => call(t.ana, "POST", `${t.path}/pause`)));
      expect(pauses.map((r) => r.body.status)).toEqual(["paused", "paused"]);
      const events = (await call(t.ana, "GET", `${t.path}/events`)).body.events.map(
        (e: { kind: string }) => e.kind,
      );
      expect(events.filter((k: string) => k === "started")).toHaveLength(1);
      expect(events.filter((k: string) => k === "paused")).toHaveLength(1);
      expect((await call(t.ana, "POST", `${t.path}/messages`, { text: "go" })).status).toBe(409);
      await call(t.ana, "PATCH", t.path, { limits: { steps: 0 } });
      const capped = await call(t.ana, "POST", `${t.path}/resume`);
      expect([capped.status, code(capped), capped.body.error.params]).toEqual([
        409,
        "assignment.ceiling",
        { which: "steps" },
      ]);
      await call(t.ana, "PATCH", t.path, { limits: { steps: null } });
      const resumed = await Promise.all([1, 2].map(() => call(t.ana, "POST", `${t.path}/resume`)));
      expect(resumed.map((r) => r.status).sort()).toEqual([200, 409]);
      await call(t.ana, "POST", `${t.path}/pause`);
    },
    SERVER_TEST_MS,
  );

  test(
    "accepting a submission and asking for changes at the same time end in one outcome",
    async () => {
      for (let round = 0; round < 4; round++) {
        const t = await team();
        const sub = newId("asub");
        await server.deps.db
          .update(assignments)
          .set({ status: "wrapping_up" })
          .where(eq(assignments.id, t.assignmentId));
        await server.deps.db
          .insert(schema.assignmentSubmissions)
          .values({ id: sub, assignmentId: t.assignmentId, note: "Done", checklist: [] });
        const both = await Promise.all([
          call(t.ana, "POST", `${t.path}/submissions/${sub}/accept`, {}),
          call(t.ana, "POST", `${t.path}/submissions/${sub}/request-changes`, { note: "Add the footer" }),
        ]);
        expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
        const [row] = await server.deps.db
          .select()
          .from(assignments)
          .where(eq(assignments.id, t.assignmentId));
        const [s] = await server.deps.db
          .select()
          .from(schema.assignmentSubmissions)
          .where(eq(schema.assignmentSubmissions.id, sub));
        const accepted = both[0]?.status === 200;
        expect([row?.status, s?.status]).toEqual(
          accepted ? ["done", "accepted"] : ["active", "changes_requested"],
        );
        if (!accepted) await call(t.ana, "POST", `${t.path}/pause`);
      }
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "a private channel's assignment is copied to a page only the channel reads",
    async () => {
      const t = await team();
      const priv = await seedChannel(server, t.workspaceId, {
        name: `vault${n}`,
        visibility: "private",
        members: [t.ana, t.beto],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: priv, memberType: "agent", memberId: t.agentId });
      const created = await call(t.ana, "POST", `${ws(t.workspaceId)}/assignments`, {
        agentId: t.agentId,
        channelId: priv,
        goal: "Rotate the keys",
      });
      const path = `${ws(t.workspaceId)}/assignments/${created.body.id}`;
      await call(t.ana, "POST", `${path}/start`);
      const closed = await call(t.ana, "POST", `${path}/close`, { outcome: "done", copyToWiki: true });
      expect(closed.body.status).toBe("done");
      const [row] = await server.deps.db
        .select()
        .from(assignments)
        .where(eq(assignments.id, created.body.id));
      const [page] = await server.deps.db
        .select()
        .from(schema.knowledgePages)
        .where(eq(schema.knowledgePages.id, row?.wikiPageId ?? ""));
      expect(page?.access).toEqual({ kind: "channel", channelId: priv });
      expect(page?.slug).not.toBe("assignment-rotate-the-keys");
      const pages = `${ws(t.workspaceId)}/wiki/pages`;
      const caioList = await call(t.caio, "GET", pages);
      expect(JSON.stringify(caioList.body)).not.toContain("Rotate the keys");
      const betoList = await call(t.beto, "GET", pages);
      expect(JSON.stringify(betoList.body)).toContain("Rotate the keys");

      // A public channel's copy is the workspace's, as before.
      await call(t.ana, "POST", `${t.path}/start`);
      await call(t.ana, "POST", `${t.path}/close`, { outcome: "done", copyToWiki: true });
      const [pub] = await server.deps.db.select().from(assignments).where(eq(assignments.id, t.assignmentId));
      const [open] = await server.deps.db
        .select()
        .from(schema.knowledgePages)
        .where(eq(schema.knowledgePages.id, pub?.wikiPageId ?? ""));
      expect(open?.access).toBeNull();
    },
    SERVER_TEST_MS,
  );
});

describe("the transitions on their own", () => {
  test(
    "createAssignment refuses another workspace's agent or runner, before writing anything",
    async () => {
      const t = await team();
      const { zed, workspaceId: theirs } = await outsider();
      const runner = await claudeRunner(zed, theirs);
      try {
        const theirAgent = await seedAgent(server.deps.db, theirs, zed, null);
        const input = {
          workspaceId: t.workspaceId,
          agentId: t.agentId,
          agentHandle: "lia",
          channelId: t.general,
          ownerId: t.ana.user.id,
          title: "Probe",
          goal: "Probe",
          executor: "agent" as const,
          runnerId: null,
          commandPolicy: "always" as const,
        };
        await expect(createAssignment(server.deps, { ...input, agentId: theirAgent })).rejects.toMatchObject({
          status: 404,
        });
        await expect(
          createAssignment(server.deps, { ...input, runnerId: runner.runnerId }),
        ).rejects.toMatchObject({
          status: 404,
          code: "runner.not_found",
        });
        const rows = await server.deps.db
          .select()
          .from(assignments)
          .where(eq(assignments.workspaceId, t.workspaceId));
        expect(rows.map((r) => r.id)).toEqual([t.assignmentId]);
        const cards = await server.deps.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.workspaceId, t.workspaceId));
        expect(cards).toHaveLength(1);
      } finally {
        await runner.close();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a submission answered meanwhile can't be accepted, and a closed assignment takes no changes",
    async () => {
      const t = await team();
      const me = { workspaceId: t.workspaceId, userId: t.ana.user.id, role: "owner" as const, handle: "ana" };
      await server.deps.db
        .update(assignments)
        .set({ status: "wrapping_up" })
        .where(eq(assignments.id, t.assignmentId));
      const sub = newId("asub");
      await server.deps.db
        .insert(schema.assignmentSubmissions)
        .values({ id: sub, assignmentId: t.assignmentId, note: "Done", checklist: [], status: "superseded" });
      const [row] = await server.deps.db.select().from(assignments).where(eq(assignments.id, t.assignmentId));
      if (!row) throw new Error("no row");
      await expect(
        finishAssignment(server.deps, me, row, { outcome: "done", wiki: false, submissionId: sub }),
      ).rejects.toMatchObject({ status: 409, code: "assignment.submission_closed" });
      expect(await status(t.assignmentId)).toBe("wrapping_up");
      await finishAssignment(server.deps, me, row, { outcome: "canceled", wiki: false });
      await expect(requestSubmissionChanges(server.deps, me, row, sub, "More")).rejects.toMatchObject({
        status: 409,
        code: "assignment.closed",
      });
      expect(await status(t.assignmentId)).toBe("canceled");
    },
    SERVER_TEST_MS,
  );
});

describe("without the agent runtime (before slice S6)", () => {
  let bare: RunningServer;
  beforeAll(async () => {
    bare = await startTestServer();
  }, SERVER_TEST_MS);
  afterAll(async () => {
    await bare?.stop();
  }, SERVER_TEST_MS);

  test(
    "stopping or telling the agent is refused with not_available before any write; the rest works",
    async () => {
      const ana = await signedIn(bare, "Ana", email("ana"));
      const { workspaceId, general } = await seedWorkspace(bare, ana, "Bare");
      const agentId = await seedAgent(bare.deps.db, workspaceId, ana, null);
      const created = await call(ana, "POST", `${ws(workspaceId)}/assignments`, {
        agentId,
        channelId: general,
        goal: "Wait",
      });
      expect(created.status).toBe(201);
      const path = `${ws(workspaceId)}/assignments/${created.body.id}`;
      expect(
        (await call(ana, "PUT", `${path}/plan`, { parentVersion: 0, items: [{ title: "One" }] })).status,
      ).toBe(200);
      expect((await call(ana, "POST", `${path}/start`)).body.status).toBe("active");
      const review = newId("arev");
      await bare.deps.db
        .insert(assignmentReviews)
        .values({ id: review, assignmentId: created.body.id, title: "T", summary: "S" });
      const sub = newId("asub");
      await bare.deps.db
        .insert(schema.assignmentSubmissions)
        .values({ id: sub, assignmentId: created.body.id, note: "Done", checklist: [] });
      const refused: [string, string, unknown?][] = [
        ["POST", "/pause"],
        ["POST", "/stop"],
        ["POST", "/close", { outcome: "done" }],
        ["POST", `/submissions/${sub}/accept`, {}],
        ["POST", "/messages", { text: "hello" }],
        ["POST", `/reviews/${review}/approve`, {}],
      ];
      for (const [method, tail, payload] of refused) {
        const r = await call(ana, method, `${path}${tail}`, payload);
        expect([tail, r.status, code(r)]).toEqual([tail, 503, "not_available"]);
      }
      const [row] = await bare.deps.db.select().from(assignments).where(eq(assignments.id, created.body.id));
      expect(row?.status).toBe("active");
      const [r] = await bare.deps.db.select().from(assignmentReviews).where(eq(assignmentReviews.id, review));
      expect(r?.status).toBe("pending");
      const [s] = await bare.deps.db
        .select()
        .from(schema.assignmentSubmissions)
        .where(eq(schema.assignmentSubmissions.id, sub));
      expect(s?.status).toBe("pending");
      // Only the plan card is in the conversation: no person's message reached it for an agent that can't hear.
      const posted = await bare.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.workspaceId, workspaceId));
      expect(posted.map((m) => m.authorKind)).toEqual(["agent"]);
    },
    SERVER_TEST_MS,
  );
});
