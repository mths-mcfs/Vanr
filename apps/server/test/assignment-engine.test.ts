// The assignment engine (assignments/motor.ts) and what moves an assignment (assignments/engine.ts): the pure
// decision, the loop that takes an assignment through its states to done, and a crash in the middle of a step
// that resumes without sending the step twice. The loop reaches the agent runtime (slice S6) in every step, so
// without it the engine doesn't start; here the server runs on `agentRuntime`, the port as the engine sees it
// with no agent run on the air unless a test starts one through `runFor`. The runner is a fake one speaking the
// protocol (protocol-runner.ts) and the verifier is scripted. The routes that create, start and accept an
// assignment come with slice S5; the tests call the functions those routes call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { type AssignmentRow, moveAssignment } from "../src/assignments/core";
import { createAssignment, jobEnded, settleJob } from "../src/assignments/engine";
import { jobIdOf, workIdOf } from "../src/assignments/keys";
import {
  type AssignmentEngine,
  act,
  createEngine,
  decide,
  type Snapshot,
  snapshotOf,
  stepNext,
} from "../src/assignments/motor";
import { planOf, writePlan } from "../src/assignments/plan";
import { proofsOf } from "../src/assignments/proofs";
import type { Verifier } from "../src/assignments/verify";
import type { AppDeps } from "../src/context";
import type { RunningServer } from "../src/server";
import { agentRuntime, pairRunner, passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import type { ProtocolRunner } from "./protocol-runner";
import { type Person, seedWorkspace } from "./seed";

const { assignments, assignmentWork, assignmentEvents, assignmentSubmissions, runnerJobs, messages } = schema;

const base: Snapshot = {
  status: "active",
  executor: "agent",
  ceiling: null,
  limits: { dollars: 5, minutes: 480, steps: 30 },
  usage: { dollars: 0, minutes: 0, steps: 0 },
  dueAt: null,
  wakeAt: null,
  items: [],
  open: [],
  lastN: {},
  busy: false,
  person: { decisions: [], others: 0, submission: false },
  lastActivity: null,
  emitted: [],
  unannounced: false,
  unsettled: [],
  stray: false,
};
const item = (id: string, over: Partial<Snapshot["items"][number]> = {}): Snapshot["items"][number] => ({
  id,
  title: id,
  status: "todo",
  passes: null,
  checks: 0,
  turns: 0,
  milestone: null,
  fixes: null,
  kind: "work",
  ...over,
});

describe("decide (pure)", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  test("closed ends; proposed and paused wait; dead work is reaped before anything else", () => {
    expect(decide({ ...base, status: "done" }, now)).toEqual({ type: "end" });
    expect(decide({ ...base, status: "proposed" }, now)).toMatchObject({ type: "wait", reason: "proposed" });
    expect(decide({ ...base, status: "paused", ceiling: "usd" }, now)).toMatchObject({ reason: "ceiling" });
    expect(
      decide(
        { ...base, open: [{ id: "w1", live: false }], usage: { dollars: 9, minutes: 0, steps: 0 } },
        now,
      ),
    ).toEqual({ type: "reap", workId: "w1" });
  });

  test("cap: going over pauses; 80% warns only once", () => {
    expect(decide({ ...base, usage: { dollars: 5, minutes: 0, steps: 0 } }, now)).toEqual({
      type: "ceiling",
      which: "dollars",
    });
    // The row names the dollar cap `usd` (the contract's kind); the action names the limit it stops at.
    expect(decide({ ...base, ceiling: "usd" }, now)).toEqual({ type: "ceiling", which: "dollars" });
    const warned = { ...base, usage: { dollars: 0, minutes: 0, steps: 25 }, items: [item("p1")] };
    expect(decide(warned, now)).toEqual({ type: "warn", which: "steps" });
    expect(decide({ ...warned, emitted: ["warn:steps:30"] }, now)).toMatchObject({
      type: "work",
      itemId: "p1",
    });
  });

  test("a decision past its deadline decides; waiting for a person waits until the deadline", () => {
    const deadline = new Date(now.getTime() + 60_000);
    const asked = {
      ...base,
      items: [item("p1")],
      person: { decisions: [{ id: "d1", deadlineAt: deadline }], others: 0, submission: false },
    };
    expect(decide(asked, now)).toEqual({ type: "wait", reason: "person", until: deadline.toISOString() });
    expect(decide(asked, new Date(deadline.getTime() + 1))).toEqual({ type: "deadline", decisionId: "d1" });
  });

  test("going quiet (stale) and the due date warn once; the agent's timer is a scheduled wait", () => {
    const old = new Date(now.getTime() - 31 * 60_000);
    const s = { ...base, items: [item("p1")], busy: true, lastActivity: old };
    expect(decide(s, now)).toEqual({ type: "stale", since: old.toISOString() });
    expect(decide({ ...s, emitted: [`stale:${old.toISOString()}`] }, now)).toMatchObject({
      type: "wait",
      reason: "working",
    });
    const due = new Date(now.getTime() - 1);
    expect(decide({ ...base, dueAt: due }, now)).toEqual({ type: "overdue" });
    const later = new Date(now.getTime() + 3600_000);
    expect(decide({ ...base, items: [item("p1")], wakeAt: later }, now)).toEqual({
      type: "wait",
      reason: "timer",
      until: later.toISOString(),
    });
  });

  test("no plan: the agent plans once, then the engine seeds; milestone by milestone; a fix goes along", () => {
    expect(decide(base, now)).toEqual({ type: "plan" });
    expect(decide({ ...base, lastN: { "": 1 } }, now)).toEqual({ type: "seed" });
    expect(decide({ ...base, executor: "claude_code" }, now)).toEqual({ type: "seed" });
    const items = [
      item("a", { milestone: "m1", status: "done" }),
      item("b", { milestone: "m2" }),
      item("c", { milestone: "m1" }),
    ];
    // Milestone m1 comes first (the order of its first item), even with c after b.
    expect(decide({ ...base, items, lastN: { c: 2 } }, now)).toEqual({ type: "work", itemId: "c", n: 3 });
    const judged = [
      item("a", { status: "done", passes: false, checks: 1 }),
      item("a-fix1", { status: "done", kind: "fix", fixes: "a" }),
    ];
    expect(decide({ ...base, items: judged }, now)).toEqual({ type: "validate", itemIds: ["a"], round: 2 });
    expect(
      decide({ ...base, items: [item("a", { status: "done", passes: false, checks: 3 })] }, now),
    ).toEqual({
      type: "stuck",
      itemId: "a",
      why: "rounds",
    });
    expect(decide({ ...base, items: [item("a", { turns: 4 })] }, now)).toEqual({
      type: "stuck",
      itemId: "a",
      why: "turns",
    });
    expect(decide({ ...base, items: [item("a", { status: "done", passes: true })] }, now)).toEqual({
      type: "submit",
    });
    // Only a fix left (the person removed what it fixes): nothing to submit, so it waits instead of looping.
    expect(
      decide(
        { ...base, items: [item("a-fix1", { status: "done", kind: "fix", fixes: "a", passes: true })] },
        now,
      ),
    ).toMatchObject({ type: "wait", reason: "idle" });
  });
});

describe("on the real agent runtime", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startTestServer();
  }, SERVER_TEST_MS);
  afterAll(() => server.stop(), SERVER_TEST_MS);

  test(
    "an active assignment advances one step: the engine sends the agent its turn and the agent's run answers it",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@engine-off.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Off");
      const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
      const row = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: "lia",
        channelId: general,
        ownerId: ana.user.id,
        title: "Tidy up",
        goal: "The house is tidy",
        executor: "agent",
        runnerId: null,
        commandPolicy: "always",
        plan: ["Kitchen"],
      });
      await moveAssignment(
        server.deps,
        row,
        ["proposed"],
        { status: "active", startedAt: new Date() },
        "status",
      );
      server.deps.assignmentEngine.wake(row.id);
      await server.deps.assignmentEngine.idle().catch(() => {});
      await server.deps.runtime.settle();
      const work = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.assignmentId, row.id));
      expect(work.length).toBeGreaterThan(0);
      const [first] = work;
      // The turn went out as a message of the assignment's thread and the agent's run on it ended.
      const turns = await server.deps.db.select().from(schema.runs).where(eq(schema.runs.agentId, agentId));
      expect(turns.length).toBeGreaterThan(0);
      expect(turns.every((r) => r.status === "done")).toBe(true);
      expect(first?.refId && turns.some((r) => r.id === first.refId)).toBe(true);
    },
    SERVER_TEST_MS,
  );
});

describe("the engine on its loop", () => {
  let server: RunningServer;
  let runner: ProtocolRunner;
  let ana: Person;
  let workspaceId = "";
  let general = "";
  const runtime = agentRuntime();
  const verify = passing();
  /** Every `job.start` the runner got, by job id; `hold` keeps the next one unanswered until released. */
  const starts = new Map<string, number>();
  beforeAll(async () => {
    server = await startTestServer({ runtime: runtime.wrap, assignmentVerifier: verify.verifier });
    ana = await signedIn(server, "Ana", "ana@engine.test");
    ({ workspaceId, general } = await seedWorkspace(server, ana, "Engine"));
    runner = await pairRunner(server, ana, workspaceId, (id) => starts.set(id, (starts.get(id) ?? 0) + 1));
  }, 2 * SERVER_TEST_MS);
  afterAll(async () => {
    await runner?.close();
    await server?.stop();
  }, SERVER_TEST_MS);

  /** An assignment on the runner (Claude Code) with the given plan, started as the start route does. */
  async function onRunner(title: string, plan: string[]) {
    const agentId = await seedAgent(server.deps.db, workspaceId, ana, runner.runnerId);
    const proposed = await createAssignment(server.deps, {
      workspaceId,
      agentId,
      agentHandle: `lia${agentId.slice(-4)}`,
      channelId: general,
      ownerId: ana.user.id,
      title,
      goal: `${title}, checked`,
      executor: "claude_code",
      runnerId: runner.runnerId,
      commandPolicy: "always",
    });
    await writePlan(server.deps, proposed.id, {
      author: { type: "person", id: ana.user.id },
      mode: "person",
      items: plan.map((t, i) => ({ id: `p${i + 1}`, title: t, criteria: `${t} is done` })),
    });
    return proposed;
  }

  const start = async (row: AssignmentRow, engine: AssignmentEngine = server.deps.assignmentEngine) => {
    const active = await moveAssignment(
      server.deps,
      row,
      ["proposed"],
      { status: "active", startedAt: server.deps.now() },
      "status",
    );
    if (!active) throw new Error("not started");
    engine.wake(row.id);
    return active;
  };
  const reload = async (id: string) => {
    const [row] = await server.deps.db.select().from(assignments).where(eq(assignments.id, id));
    if (!row) throw new Error("gone");
    return row;
  };
  const kinds = async (id: string) =>
    (await server.deps.db.select().from(assignmentEvents).where(eq(assignmentEvents.assignmentId, id)))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => (e.itemId ? `${e.kind}:${e.itemId}` : e.kind));
  /** The runner ends the job the engine sent for this item (attempt `n`) and the server processes its end. */
  async function jobDone(row: AssignmentRow, itemId: string, n = 1) {
    const jobId = jobIdOf(workIdOf(row.id, itemId, n));
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
    return jobId;
  }
  const jobSent = (row: AssignmentRow, itemId: string, n = 1) =>
    runner.next(
      (f) =>
        f.type === "request" && f.op === "job.start" && f.args.jobId === jobIdOf(workIdOf(row.id, itemId, n)),
      15_000,
    );

  test(
    "an assignment on the runner goes through its states to done: one item at a time, the verifier, the submission",
    async () => {
      const proposed = await onRunner("Ship the site", ["Build", "Deploy"]);
      // Proposed: the engine only waits.
      server.deps.assignmentEngine.wake(proposed.id);
      await server.deps.assignmentEngine.idle();
      expect((await reload(proposed.id)).waitReason).toBe("proposed");

      const row = await start(proposed);
      await jobSent(row, "p1");
      await server.deps.assignmentEngine.idle();
      expect((await reload(row.id)).waitReason).toBe("working");
      await jobDone(row, "p1");
      await jobSent(row, "p2");
      await jobDone(row, "p2");
      await server.deps.assignmentEngine.idle();

      const waiting = await reload(row.id);
      expect([waiting.status, waiting.waitReason]).toEqual(["wrapping_up", "submission"]);
      // No milestone: each item is its own group, judged before the next one starts.
      expect(verify.seen).toEqual([["p1"], ["p2"]]);
      const [submission] = await server.deps.db
        .select()
        .from(assignmentSubmissions)
        .where(eq(assignmentSubmissions.assignmentId, row.id));
      expect(submission?.status).toBe("pending");
      expect(submission?.checklist.map((c) => c.text)).toEqual(["Build is done", "Deploy is done"]);

      // The person accepts the submission (what the accept route does) and the loop ends.
      const done = await moveAssignment(
        server.deps,
        waiting,
        ["wrapping_up"],
        { status: "done", outcome: "done", closedAt: server.deps.now() },
        "status",
      );
      expect(done?.status).toBe("done");
      server.deps.assignmentEngine.wake(row.id);
      await server.deps.assignmentEngine.idle();
      expect(await kinds(row.id)).toEqual([
        "item_started:p1",
        "item_done:p1",
        "job_done:p1",
        "validation_passed:p1",
        "item_started:p2",
        "item_done:p2",
        "job_done:p2",
        "validation_passed:p2",
        "delivered",
      ]);
      // Each item went out once, as one job, with its proofs.
      const work = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.assignmentId, row.id));
      expect(work.map((w) => [w.itemId, w.n, w.status, w.outcome]).sort()).toEqual([
        ["p1", 1, "ended", "done"],
        ["p2", 1, "ended", "done"],
      ]);
      expect(starts.get(jobIdOf(workIdOf(row.id, "p1", 1)))).toBe(1);
      expect(starts.get(jobIdOf(workIdOf(row.id, "p2", 1)))).toBe(1);
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "a crash after the job went out and before the step recorded it resumes without sending the job again",
    async () => {
      const original = server.deps.assignmentEngine;
      const proposed = await onRunner("Fix the build", ["Fix"]);
      // The first process: its database dies at the step's last write (the job's id on the work row).
      const dying = crashAt(server.deps.db, (values) => "refId" in values);
      // Its listener of the runs' end goes with it, as in a process that died.
      const gone = { ...server.deps.runtime, onRunEnd: () => {} };
      const first = createEngine(() => ({ ...server.deps, db: dying.db, runtime: gone }), "local", {
        url: null,
        version: "1",
        poolSize: 2,
      });
      server.deps.assignmentEngine = first;
      const engines: AssignmentEngine[] = [first];
      try {
        await first.start();
        const row = await start(proposed, first);
        await jobSent(row, "p1");
        await dying.crashed;
        await first.stop();
        const [w] = await server.deps.db
          .select()
          .from(assignmentWork)
          .where(eq(assignmentWork.id, workIdOf(row.id, "p1", 1)));
        expect([w?.status, w?.refId]).toEqual(["running", null]);
        // On Postgres DBOS replays the step that didn't finish, with the action it recorded: it sends nothing.
        const jobId = jobIdOf(workIdOf(row.id, "p1", 1));
        expect(await act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 })).toBeNull();
        expect(starts.get(jobId)).toBe(1);

        // The server comes back: a new engine on the same database picks the open assignment up.
        const second = createEngine(() => server.deps, "local", { url: null, version: "1", poolSize: 2 });
        engines.push(second);
        server.deps.assignmentEngine = second;
        await second.start();
        await second.idle();
        // The job on the air is the step's: the engine waits for it instead of sending another.
        expect((await reload(row.id)).waitReason).toBe("working");
        await jobDone(row, "p1");
        await second.idle();
        expect(starts.get(jobId)).toBe(1);
        const jobs = await server.deps.db
          .select()
          .from(runnerJobs)
          .where(eq(runnerJobs.assignmentId, row.id));
        expect(jobs.map((j) => [j.id, j.status])).toEqual([[jobId, "done"]]);
        const after = await reload(row.id);
        expect([after.status, after.waitReason]).toEqual(["wrapping_up", "submission"]);
        const work = await server.deps.db
          .select()
          .from(assignmentWork)
          .where(eq(assignmentWork.assignmentId, row.id));
        expect(work.map((x) => [x.itemId, x.n, x.outcome])).toEqual([["p1", 1, "done"]]);
      } finally {
        await Promise.allSettled(engines.map((e) => e.stop()));
        server.deps.assignmentEngine = original;
      }
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "a repeated step doesn't send again; an item taken out of the plan doesn't run",
    async () => {
      const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
      const row = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: `lia${agentId.slice(-4)}`,
        channelId: general,
        ownerId: ana.user.id,
        title: "Tidy up",
        goal: "Tidy up",
        executor: "agent",
        runnerId: null,
        commandPolicy: "always",
      });
      await writePlan(server.deps, row.id, {
        author: { type: "person", id: ana.user.id },
        mode: "person",
        items: [
          { id: "p1", title: "One", criteria: "one" },
          { id: "p2", title: "Two", criteria: "two" },
        ],
      });
      // Active straight in the database, with nothing waking it: no loop runs it; the test calls the step by hand.
      await server.deps.db
        .update(assignments)
        .set({ status: "active", startedAt: server.deps.now() })
        .where(eq(assignments.id, row.id));
      const turnsBefore = runtime.turns.length;
      await act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 });
      await act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 });
      expect(runtime.turns.length).toBe(turnsBefore + 1);
      const run = runtime.turns.at(-1)?.runId ?? "";
      runtime.finish(run);
      await server.deps.runtime.settle();
      await act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 });
      expect(runtime.turns.length).toBe(turnsBefore + 1);
      const work = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(and(eq(assignmentWork.assignmentId, row.id), eq(assignmentWork.itemId, "p1")));
      expect(work.map((w) => [w.id, w.refId, w.outcome])).toEqual([[workIdOf(row.id, "p1", 1), run, "done"]]);
      const turns = (
        await server.deps.db.select().from(messages).where(eq(messages.threadId, row.threadId))
      ).filter((x) => x.meta.assignmentTurn);
      expect(turns).toHaveLength(1);
      // The person takes p2 out; the step that had already decided to work on it sends nothing.
      await writePlan(server.deps, row.id, {
        author: { type: "person", id: ana.user.id },
        mode: "person",
        parentVersion: 1,
        items: [{ id: "p1", title: "One" }],
      });
      await act(server.deps, row.id, { type: "work", itemId: "p2", n: 1 });
      const [p2] = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(and(eq(assignmentWork.assignmentId, row.id), eq(assignmentWork.itemId, "p2")));
      expect([p2?.status, p2?.outcome, p2?.refId]).toEqual(["ended", "canceled", null]);
      expect(runtime.turns.length).toBe(turnsBefore + 1);
    },
    SERVER_TEST_MS,
  );

  test(
    "two steps at once on the same work send one turn, and the item counts one turn",
    async () => {
      const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
      const row = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: `lia${agentId.slice(-4)}`,
        channelId: general,
        ownerId: ana.user.id,
        title: "Paint",
        goal: "Paint",
        executor: "agent",
        runnerId: null,
        commandPolicy: "always",
        plan: ["Walls"],
      });
      await server.deps.db
        .update(assignments)
        .set({ status: "active", startedAt: server.deps.now() })
        .where(eq(assignments.id, row.id));
      const before = runtime.turns.length;
      await Promise.all(
        Array.from({ length: 5 }, () => act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 })),
      );
      expect(runtime.turns.length).toBe(before + 1);
      const [p1] = await server.deps.db
        .select()
        .from(schema.assignmentPlanItems)
        .where(
          and(eq(schema.assignmentPlanItems.assignmentId, row.id), eq(schema.assignmentPlanItems.id, "p1")),
        );
      expect([p1?.status, p1?.turns]).toEqual(["doing", 1]);
      for (const t of runtime.turns.slice(before)) runtime.finish(t.runId);
      await server.deps.runtime.settle();
    },
    SERVER_TEST_MS,
  );

  test(
    "a job's end processed again after a crash records the item, the proofs and the cost, once",
    async () => {
      const row = await onRunner("Runner", ["A", "B"]);
      // The runner as executor; the assignment stays proposed (the engine doesn't step in).
      const mk = async (id: string, itemId: string, denied: string[] = []) => {
        const now = new Date();
        const [job] = await server.deps.db
          .insert(runnerJobs)
          .values({
            id,
            workspaceId,
            runnerId: runner.runnerId,
            agentId: row.agentId,
            assignmentId: row.id,
            title: `job ${itemId}`,
            executor: "claude_code",
            prompt: "x",
            status: "done",
            files: ["src/a.ts"],
            diff: "diff --git a/src/a.ts b/src/a.ts\n+ok",
            result: "done",
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              cachedTokens: 0,
              cacheWriteTokens: 0,
              costUsd: null,
              model: "x",
            },
            denied,
            planItemId: itemId,
            startedAt: now,
            endedAt: now,
          })
          .returning();
        if (!job) throw new Error("no job");
        return job;
      };
      const costOf = async () =>
        (
          await server.deps.db
            .select()
            .from(schema.usageLines)
            .where(eq(schema.usageLines.assignmentId, row.id))
        ).length;
      const itemOf = async (id: string) => (await planOf(server.deps, row.id)).find((i) => i.id === id);

      // Crash: the first pass recorded the end's event and died before the rest.
      const crashed = await mk(`aj_crash_${row.id}`, "p1");
      await server.deps.db.insert(assignmentEvents).values({
        assignmentId: row.id,
        key: `${row.id}:job:${crashed.id}`,
        kind: "job_done",
        actor: { type: "agent", id: row.agentId },
        itemId: "p1",
        data: {},
        at: new Date(),
      });
      // What the engine does in `reap`, twice (the second changes nothing).
      for (let i = 0; i < 2; i++) {
        await jobEnded(server.deps, crashed);
        await settleJob(server.deps, crashed);
      }
      expect((await itemOf("p1"))?.status).toBe("done");
      const proofs = await proofsOf(server.deps, row.id);
      expect(
        proofs
          .filter((p) => p.itemId === "p1")
          .map((p) => p.kind)
          .sort(),
      ).toEqual(["diff", "files"]);
      expect(await costOf()).toBe(1);
      const [settled] = await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, crashed.id));
      expect(settled?.settledAt).not.toBeNull();

      // A crash after the blocked command's card: the second pass makes neither another card nor another cost.
      const blocked = await mk(`aj_blocked_${row.id}`, "p2", ["rm -rf build"]);
      await server.deps.db.insert(schema.assignmentCommands).values({
        id: `acmd_${row.id}`,
        assignmentId: row.id,
        jobId: blocked.id,
        command: "rm -rf build",
        tool: "Bash",
        rules: [],
      });
      await jobEnded(server.deps, blocked);
      await jobEnded(server.deps, blocked);
      const cards = await server.deps.db
        .select()
        .from(schema.assignmentCommands)
        .where(eq(schema.assignmentCommands.jobId, blocked.id));
      expect(cards).toHaveLength(1);
      expect(await costOf()).toBe(2);
      expect((await itemOf("p2"))?.status).toBe("todo");
    },
    SERVER_TEST_MS,
  );

  /** An agent assignment with one item, paused straight in the database: the loop only waits. */
  async function heldAgentAssignment(title: string) {
    const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
    const row = await createAssignment(server.deps, {
      workspaceId,
      agentId,
      agentHandle: `lia${agentId.slice(-4)}`,
      channelId: general,
      ownerId: ana.user.id,
      title,
      goal: title,
      executor: "agent",
      runnerId: null,
      commandPolicy: "always",
      plan: ["Walls"],
    });
    await server.deps.db
      .update(assignments)
      .set({ status: "active", startedAt: server.deps.now() })
      .where(eq(assignments.id, row.id));
    return reload(row.id);
  }

  test(
    "a claimed work still sending stays live for the other loop; past the grace it is a dead step",
    async () => {
      const row = await heldAgentAssignment("Sending");
      const id = workIdOf(row.id, "p1", 1);
      await server.deps.db
        .insert(assignmentWork)
        .values({ id, assignmentId: row.id, itemId: "p1", n: 1, kind: "run", status: "running" });
      expect((await snapshotOf(server.deps, row)).open).toEqual([{ id, live: true }]);
      await server.deps.db
        .update(assignmentWork)
        .set({ startedAt: new Date(Date.now() - 3 * 60_000) })
        .where(eq(assignmentWork.id, id));
      expect((await snapshotOf(server.deps, row)).open).toEqual([{ id, live: false }]);
    },
    SERVER_TEST_MS,
  );

  test(
    "an attempt reaped while its step was still sending doesn't keep its turn",
    async () => {
      const row = await heldAgentAssignment("Reaped");
      const id = workIdOf(row.id, "p1", 1);
      // Another loop reaps the attempt while this step is inside runFor.
      runtime.hooks.onTurn = async () => {
        await act(server.deps, row.id, { type: "reap", workId: id });
      };
      try {
        await act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 });
      } finally {
        runtime.hooks.onTurn = undefined;
      }
      const run = runtime.turns.at(-1)?.runId ?? "";
      expect(server.deps.runtime.liveRun(run)).toBeNull();
      const [w] = await server.deps.db.select().from(assignmentWork).where(eq(assignmentWork.id, id));
      expect([w?.status, w?.outcome, w?.refId]).toEqual(["ended", "interrupted", null]);
      await server.deps.runtime.settle();
    },
    SERVER_TEST_MS,
  );

  test(
    "a run another attempt holds is left alone when this attempt was reaped",
    async () => {
      const row = await heldAgentAssignment("Shared run");
      const id = workIdOf(row.id, "p1", 1);
      const next = workIdOf(row.id, "p1", 2);
      // The turn went into a run attempt 2 holds, and attempt 1 was reaped meanwhile.
      runtime.hooks.onTurn = async (runId) => {
        await act(server.deps, row.id, { type: "reap", workId: id });
        await server.deps.db.insert(assignmentWork).values({
          id: next,
          assignmentId: row.id,
          itemId: "p1",
          n: 2,
          kind: "run",
          status: "running",
          refId: runId,
        });
      };
      try {
        await act(server.deps, row.id, { type: "work", itemId: "p1", n: 1 });
      } finally {
        runtime.hooks.onTurn = undefined;
      }
      const run = runtime.turns.at(-1)?.runId ?? "";
      expect(server.deps.runtime.liveRun(run)).not.toBeNull();
      runtime.finish(run);
      await server.deps.runtime.settle();
    },
    SERVER_TEST_MS,
  );

  test(
    "a cap raised and a due date moved since the decision: the step does nothing",
    async () => {
      const row = await heldAgentAssignment("Moved");
      await server.deps.db
        .update(assignments)
        .set({ status: "active", dueAt: new Date(Date.now() + 3600_000) })
        .where(eq(assignments.id, row.id));
      // The decision saw the steps cap hit (0 of 0); the owner raised it to 30 before the step.
      await server.deps.db
        .update(assignments)
        .set({ limits: { dollars: 5, minutes: 480, steps: 30 } })
        .where(eq(assignments.id, row.id));
      await act(server.deps, row.id, { type: "ceiling", which: "steps" });
      await act(server.deps, row.id, { type: "overdue" });
      const after = await reload(row.id);
      expect([after.status, after.ceiling]).toEqual(["active", null]);
      expect(await kinds(row.id)).toEqual(["plan_edited"]);
      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, row.id));
    },
    SERVER_TEST_MS,
  );

  test(
    "a verdict on an item the person changed during the check is not applied",
    async () => {
      const row = await onRunner("Judged", ["Build"]);
      await server.deps.db
        .update(schema.assignmentPlanItems)
        .set({ status: "done", summary: "Built" })
        .where(
          and(eq(schema.assignmentPlanItems.assignmentId, row.id), eq(schema.assignmentPlanItems.id, "p1")),
        );
      const editing: Verifier = async (_deps, _row, items) => {
        // The person rewrote the criterion while the verifier read the old one.
        await server.deps.db
          .update(schema.assignmentPlanItems)
          .set({ epoch: 1, criteria: "Build and test" })
          .where(
            and(eq(schema.assignmentPlanItems.assignmentId, row.id), eq(schema.assignmentPlanItems.id, "p1")),
          );
        return {
          ok: true,
          runId: null,
          verdicts: items.map((i) => ({ id: i.item.id, passes: true, reason: "ok" })),
        };
      };
      await act({ ...server.deps, assignmentVerifier: editing }, row.id, {
        type: "validate",
        itemIds: ["p1"],
        round: 1,
      });
      const [p1] = await server.deps.db
        .select()
        .from(schema.assignmentPlanItems)
        .where(
          and(eq(schema.assignmentPlanItems.assignmentId, row.id), eq(schema.assignmentPlanItems.id, "p1")),
        );
      expect([p1?.passes, p1?.checks]).toEqual([null, 0]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a verdict on an item the person removed during the check is not applied and makes no fix",
    async () => {
      const row = await onRunner("Removed", ["Build"]);
      const p1 = and(
        eq(schema.assignmentPlanItems.assignmentId, row.id),
        eq(schema.assignmentPlanItems.id, "p1"),
      );
      await server.deps.db
        .update(schema.assignmentPlanItems)
        .set({ status: "done", summary: "Built" })
        .where(p1);
      const removing: Verifier = async (_deps, _row, items) => {
        await server.deps.db.update(schema.assignmentPlanItems).set({ status: "dropped" }).where(p1);
        return {
          ok: true,
          runId: null,
          verdicts: items.map((i) => ({ id: i.item.id, passes: false, reason: "no" })),
        };
      };
      await act({ ...server.deps, assignmentVerifier: removing }, row.id, {
        type: "validate",
        itemIds: ["p1"],
        round: 1,
      });
      const items = await planOf(server.deps, row.id);
      expect(items.map((i) => [i.id, i.status, i.passes, i.checks])).toEqual([["p1", "dropped", null, 0]]);
    },
    SERVER_TEST_MS,
  );
  /** On the runner and active straight in the database, with nothing waking it: the test runs the steps. */
  async function idleOnRunner(title: string, plan: string[]) {
    const row = await onRunner(title, plan);
    await server.deps.db
      .update(assignments)
      .set({ status: "active", startedAt: server.deps.now() })
      .where(eq(assignments.id, row.id));
    return reload(row.id);
  }
  const itemOf = async (row: AssignmentRow, id: string) =>
    (await planOf(server.deps, row.id)).find((i) => i.id === id);

  test(
    "a job's end doesn't bring back an item the person dropped meanwhile",
    async () => {
      const row = await idleOnRunner("Dropped meanwhile", ["Build", "Docs"]);
      const [job] = await server.deps.db
        .insert(runnerJobs)
        .values({
          id: newId("aj"),
          workspaceId,
          runnerId: runner.runnerId,
          agentId: row.agentId,
          assignmentId: row.id,
          threadId: row.threadId,
          channelId: row.channelId,
          title: "Build",
          executor: "claude_code",
          prompt: "build",
          planItemId: "p1",
          status: "done",
          result: "Built",
          endedAt: new Date(),
        })
        .returning();
      if (!job) throw new Error("no job");
      await writePlan(server.deps, row.id, {
        author: { type: "person", id: ana.user.id },
        mode: "person",
        items: [{ id: "p2", title: "Docs" }],
      });
      await jobEnded(server.deps, job);
      expect((await itemOf(row, "p1"))?.status).toBe("dropped");
      await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
    },
    SERVER_TEST_MS,
  );

  test(
    "an attempt that reaches its send after the item was done starts no job on the runner",
    async () => {
      const row = await idleOnRunner("Done meanwhile", ["Build"]);
      const action = await stepNext(server.deps, row.id);
      expect(action).toEqual({ type: "work", itemId: "p1", n: 1 });
      await server.deps.db
        .update(schema.assignmentPlanItems)
        .set({ status: "done" })
        .where(
          and(eq(schema.assignmentPlanItems.assignmentId, row.id), eq(schema.assignmentPlanItems.id, "p1")),
        );
      await act(server.deps, row.id, action);
      const jobId = jobIdOf(workIdOf(row.id, "p1", 1));
      expect(starts.get(jobId)).toBeUndefined();
      expect(await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, jobId))).toEqual([]);
      const [w] = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.id, workIdOf(row.id, "p1", 1)));
      expect([w?.status, w?.outcome]).toEqual(["ended", "canceled"]);
      await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
    },
    SERVER_TEST_MS,
  );

  test(
    "an attempt reaped while it was starting its job: the job it started is canceled, not left running",
    async () => {
      const row = await idleOnRunner("Reaped while starting", ["Build"]);
      const workId = workIdOf(row.id, "p1", 1);
      const jobId = jobIdOf(workId);
      const hub = server.deps.runners;
      let reaped = false;
      // Another loop reaps the attempt while this one writes the assignment files to the runner.
      const slow: AppDeps = {
        ...server.deps,
        runners: Object.assign(Object.create(hub), {
          call: async (...args: Parameters<typeof hub.call>) => {
            if (!reaped && args[1] === "write") {
              reaped = true;
              await act(server.deps, row.id, { type: "reap", workId });
            }
            return hub.call(...args);
          },
        }),
      };
      await act(slow, row.id, { type: "work", itemId: "p1", n: 1 });
      expect(reaped).toBe(true);
      await jobSent(row, "p1");
      await runner.next(
        (f) => f.type === "request" && f.op === "job.cancel" && f.args.jobId === jobId,
        15_000,
      );
      const [w] = await server.deps.db.select().from(assignmentWork).where(eq(assignmentWork.id, workId));
      expect([w?.status, w?.outcome, w?.refId]).toEqual(["ended", "interrupted", null]);
      await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
    },
    SERVER_TEST_MS,
  );

  test(
    "starts refused because the runner is offline don't use up the item's turns",
    async () => {
      const row = await idleOnRunner("Offline", ["Build"]);
      const hub = server.deps.runners;
      const offline: AppDeps = {
        ...server.deps,
        runners: Object.assign(Object.create(hub), { isOnline: () => false }),
      };
      for (let n = 1; n <= 5; n++) await act(offline, row.id, { type: "work", itemId: "p1", n });
      expect((await itemOf(row, "p1"))?.turns).toBe(0);
      // The item isn't stuck: with the runner back, the next attempt goes.
      expect(await stepNext(server.deps, row.id)).toMatchObject({ type: "work", itemId: "p1" });
      await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
    },
    SERVER_TEST_MS,
  );
});

/**
 * The database of a process that dies at one write: the update whose values match `at` throws, and every query
 * after it throws too (nothing of that process reaches the database any more). `crashed` resolves when it died.
 */
function crashAt(db: Db, at: (values: Record<string, unknown>) => boolean) {
  let dead = false;
  let died!: () => void;
  const crashed = new Promise<void>((r) => {
    died = r;
  });
  const gone = () => new Error("the process is gone");
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "update")
        return (table: Parameters<Db["update"]>[0]) => {
          if (dead) throw gone();
          const builder = target.update(table);
          return new Proxy(builder, {
            get(b, p) {
              if (p !== "set") return Reflect.get(b, p, b);
              return (values: Record<string, unknown>) => {
                if (at(values)) {
                  dead = true;
                  died();
                  throw new Error("crash");
                }
                return b.set(values as never);
              };
            },
          });
        };
      return (...args: unknown[]) => {
        if (dead) throw gone();
        return value.apply(target, args);
      };
    },
  });
  return { db: proxy as Db, crashed };
}
