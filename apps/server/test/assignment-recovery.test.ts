// The assignment engine on the real agent runtime, after a crash or a change between its steps: a card that never
// went out is posted again, a pause whose cancel failed halfway is finished, a job whose end nobody processed (one
// the agent started has no work row, one never reached the runner) is processed, a step decided before a pause, a
// cancel or the end sends nothing, a late attempt can't go into (or stop) the run a later attempt holds, the next
// turn hears of a job that ended during the previous one, a crash in the middle of a validation doesn't spend a
// round, and removing an item removes its fixes. Nothing wakes these assignments' loops: the tests run the steps.
//
// The fence test is forced (the later attempt goes in while the earlier one is about to send): with
// VANR_TEST_DROP_LOCKS=1 the double takes the fence out, and CI expects it to fail on its outcome.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { assignmentOfRun } from "../src/assignments/budget";
import { type AssignmentRow, agentSays, moveAssignment } from "../src/assignments/core";
import { createAssignment, createSubmission } from "../src/assignments/engine";
import { workIdOf } from "../src/assignments/keys";
import { tellIfPossible } from "../src/assignments/lifecycle";
import { act, decide, snapshotOf, stepNext } from "../src/assignments/motor";
import { planOf, writePlan } from "../src/assignments/plan";
import type { Verifier } from "../src/assignments/verify";
import { channelInWorkspace } from "../src/channels";
import type { AppDeps, RuntimePort } from "../src/context";
import { postMessage } from "../src/messages";
import type { RunningServer } from "../src/server";
import { passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import { DROP_LOCKS, outcome, wrapQuery } from "./lock-double";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

const {
  assignments,
  assignmentWork,
  assignmentEvents,
  assignmentCommands,
  assignmentSubmissions,
  assignmentPlanItems,
  runnerJobs,
  runs,
  messages,
  messageDispatches,
} = schema;
const MIN = 60_000;

let server: RunningServer;
let ana: Person;
let workspaceId = "";
let general = "";
beforeAll(async () => {
  server = await startTestServer({ assignmentVerifier: passing().verifier });
  ana = await signedIn(server, "Ana", "ana@recovery.test");
  ({ workspaceId, general } = await seedWorkspace(server, ana, "Recovery"));
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

/** An agent assignment with this plan, active straight in the database: no loop runs it. */
async function active(title: string, plan: string[]) {
  const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
  const proposed = await createAssignment(server.deps, {
    workspaceId,
    agentId,
    agentHandle: `lia${agentId.slice(-4)}`,
    channelId: general,
    ownerId: ana.user.id,
    title,
    goal: `${title}, checked`,
    executor: "agent",
    runnerId: null,
    commandPolicy: "always",
  });
  await writePlan(server.deps, proposed.id, {
    author: { type: "person", id: ana.user.id },
    mode: "person",
    items: plan.map((t, i) => ({ id: `p${i + 1}`, title: t, criteria: `${t} is done` })),
  });
  await server.deps.db
    .update(assignments)
    .set({ status: "active", startedAt: server.deps.now() })
    .where(eq(assignments.id, proposed.id));
  return { row: await reload(proposed.id), agentId };
}
const reload = async (id: string): Promise<AssignmentRow> => {
  const [row] = await server.deps.db.select().from(assignments).where(eq(assignments.id, id));
  if (!row) throw new Error("gone");
  return row;
};
/** Done with it: closed, so a run that ends later doesn't start its loop. */
const close = async (id: string) => {
  await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, id));
  await server.deps.runtime.settle();
  await server.deps.assignmentEngine.idle();
};
const kinds = async (id: string) =>
  (await server.deps.db.select().from(assignmentEvents).where(eq(assignmentEvents.assignmentId, id))).map(
    (e) => e.kind,
  );
const ago = (ms: number) => new Date(Date.now() - ms);
const turnsOf = async (row: AssignmentRow) =>
  (await planOf(server.deps, row.id)).map((i) => [i.id, i.status, i.turns]);

describe("a card that never went out", () => {
  test(
    "a pending submission whose card a crash left out gets its card once, and the assignment moves on",
    async () => {
      const { row } = await active("Report", ["Write"]);
      const id = newId("asub");
      await server.deps.db
        .insert(assignmentSubmissions)
        .values({ id, assignmentId: row.id, note: "All done", checklist: [], createdAt: ago(3 * MIN) });
      expect((await snapshotOf(server.deps, row)).unannounced).toBe(true);
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "announce" });
      await act(server.deps, row.id, { type: "announce" });
      await act(server.deps, row.id, { type: "announce" });
      const [sub] = await server.deps.db
        .select()
        .from(assignmentSubmissions)
        .where(eq(assignmentSubmissions.id, id));
      const cards = await server.deps.db
        .select()
        .from(messages)
        .where(and(eq(messages.threadId, row.threadId), eq(messages.clientId, `card:${id}`)));
      expect(cards).toHaveLength(1);
      expect(sub?.messageId).toBe(cards[0]?.id ?? "");
      expect(cards[0]?.meta.assignmentSubmission).toEqual({ assignmentId: row.id, submissionId: id });
      expect((await reload(row.id)).status).toBe("wrapping_up");
      expect((await snapshotOf(server.deps, await reload(row.id))).unannounced).toBe(false);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a pending command whose card never reached the thread gets it once; a fresh one is left to its creator",
    async () => {
      const { row } = await active("Deploy", ["Ship"]);
      const lost = newId("acmd");
      const fresh = newId("acmd");
      await server.deps.db.insert(assignmentCommands).values([
        {
          id: lost,
          assignmentId: row.id,
          command: "make deploy",
          tool: "Bash",
          rules: [],
          createdAt: ago(3 * MIN),
        },
        { id: fresh, assignmentId: row.id, command: "make test", tool: "Bash", rules: [] },
      ]);
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "announce" });
      await act(server.deps, row.id, { type: "announce" });
      await act(server.deps, row.id, { type: "announce" });
      const rows = await server.deps.db
        .select()
        .from(assignmentCommands)
        .where(eq(assignmentCommands.assignmentId, row.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const cards = await server.deps.db
        .select()
        .from(messages)
        .where(eq(messages.clientId, `card:${lost}`));
      expect(cards.map((c) => c.id)).toEqual([byId.get(lost)?.messageId ?? ""]);
      expect(byId.get(fresh)?.messageId).toBeNull();
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a submission's card, in order", () => {
  test(
    "a crash after the card but before its mark tells the owner on the repost; a pause isn't undone by a submission",
    async () => {
      const { row } = await active("Wrap", ["Write"]);
      const id = newId("asub");
      await server.deps.db
        .insert(assignmentSubmissions)
        .values({ id, assignmentId: row.id, note: "Ready", checklist: [], createdAt: ago(3 * MIN) });
      // The crash: moved and the card posted, the owner not told and the card not marked.
      const moved = await moveAssignment(
        server.deps,
        row,
        ["active"],
        { status: "wrapping_up" },
        "submission",
      );
      if (!moved) throw new Error("not moved");
      await agentSays(
        server.deps,
        moved,
        "Ready",
        { assignmentSubmission: { assignmentId: row.id, submissionId: id } },
        `card:${id}`,
      );
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "announce" });
      await act(server.deps, row.id, { type: "announce" });
      const [sub] = await server.deps.db
        .select()
        .from(assignmentSubmissions)
        .where(eq(assignmentSubmissions.id, id));
      const told = await server.deps.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.groupKey, `assignment:${row.id}:assignment_finished`));
      expect([sub?.messageId !== null, told.length, (await reload(row.id)).status]).toEqual([
        true,
        1,
        "wrapping_up",
      ]);
      await close(row.id);

      // A submission that lands after a pause posts its card but leaves the assignment paused.
      const { row: other } = await active("Wrap paused", ["Write"]);
      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, other.id));
      await createSubmission(server.deps, await reload(other.id), {
        note: "Late",
        checklist: [],
        auto: false,
      });
      expect((await reload(other.id)).status).toBe("paused");
      await close(other.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a stop that didn't finish", () => {
  test(
    "paused with the agent's run still on the air (the cancel failed halfway): the engine stops the run",
    async () => {
      const { row, agentId } = await active("Pause", ["Sand"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      if (!channel) throw new Error("no channel");
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!agent) throw new Error("no agent");
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: { type: "person", id: ana.user.id },
        body: "[[slow:400]] keep going",
        clientId: newId("c"),
        threadId: row.threadId,
      });
      const [trigger] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
      if (!trigger) throw new Error("no message");
      const started = await server.deps.runtime.runFor({ agent, channel, trigger });
      if (!started.ok) throw new Error(started.code);
      // The status moved; the cancel that should have followed never ran.
      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, row.id));
      expect((await snapshotOf(server.deps, await reload(row.id))).stray).toBe(true);
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "halt" });
      // Resumed between the decision and the act: the halt stops nothing of the resumed assignment.
      await server.deps.db.update(assignments).set({ status: "active" }).where(eq(assignments.id, row.id));
      await act(server.deps, row.id, { type: "halt" });
      // A cancel takes the run off the air a moment later; the run's text is still streaming well past this.
      await Bun.sleep(100);
      expect(server.deps.runtime.liveRun(started.runId)).not.toBeNull();
      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, row.id));
      await act(server.deps, row.id, { type: "halt" });
      await started.done;
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
      expect(run?.status).toBe("canceled");
      expect(await stepNext(server.deps, row.id)).toMatchObject({ type: "wait", reason: "paused" });
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a close that didn't finish", () => {
  test(
    "canceled with the agent's run still on the air: the loop halts it before it ends",
    async () => {
      const { row, agentId } = await active("Close", ["Sand"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!channel || !agent) throw new Error("setup");
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: { type: "person", id: ana.user.id },
        body: "[[slow:400]] keep going",
        clientId: newId("c"),
        threadId: row.threadId,
      });
      const [trigger] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
      if (!trigger) throw new Error("no message");
      const started = await server.deps.runtime.runFor({ agent, channel, trigger });
      if (!started.ok) throw new Error(started.code);
      await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "halt" });
      await act(server.deps, row.id, { type: "halt" });
      await started.done;
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "end" });
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("the reviewer of an assignment's run", () => {
  test(
    "a run's calls reserve against its assignment's cap; the reviewer's call too, charged to the assignment",
    async () => {
      const { row, agentId } = await active("Reviewed", ["x"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      const caps = await assignmentOfRun(server.deps, agentId, row.threadId);
      if (!channel || !agent || !caps) throw new Error("setup");
      await server.deps.db
        .update(schema.workspaces)
        .set({ approvalReviewer: true })
        .where(eq(schema.workspaces.id, workspaceId));
      try {
        // What Ana asked in the thread: the reviewer reads it.
        const { message } = await postMessage(server.deps, {
          workspaceId,
          channel,
          author: { type: "person", id: ana.user.id },
          body: "Please post the shipping note",
          clientId: newId("c"),
          threadId: row.threadId,
        });
        const [asked] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
        if (!asked) throw new Error("no message");

        // The caps a run's calls reserve against (its turns, its reviewer, its delegations): with the
        // assignment's dollars at 0, a turn in its thread stops before the model.
        await server.deps.db
          .update(assignments)
          .set({ limits: { ...row.limits, dollars: 0 } })
          .where(eq(assignments.id, row.id));
        const started = await server.deps.runtime.runFor({ agent, channel, trigger: asked });
        if (!started.ok) throw new Error(started.code);
        await started.done;
        const [stopped] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
        expect([stopped?.status, stopped?.errorCode]).toEqual(["failed", "assignment_budget_exhausted"]);
        await server.deps.db
          .update(assignments)
          .set({ limits: row.limits, ceiling: null })
          .where(eq(assignments.id, row.id));

        const review = (scope: typeof caps.scope) =>
          server.runtime.reviewCall({
            agent,
            channelId: general,
            threadId: row.threadId,
            requesterId: ana.user.id,
            requestAt: asked.createdAt,
            req: { tool: "post_message", effect: "K2", reason: "rule_of_two", preview: { title: "Post" } },
            scopes: [scope],
            assignmentId: row.id,
          });
        const reviewLines = () =>
          server.deps.db
            .select()
            .from(schema.usageLines)
            .where(and(eq(schema.usageLines.agentId, agentId), eq(schema.usageLines.source, "review")));
        // No room left on the assignment: no verdict, and the model isn't called.
        expect(await review({ ...caps.scope, limitUsd: 0 })).toBeNull();
        expect(await reviewLines()).toEqual([]);
        // With room: the call goes, and its line is the assignment's.
        await review(caps.scope);
        expect((await reviewLines()).map((l) => l.assignmentId)).toEqual([row.id]);
      } finally {
        await server.deps.db
          .update(schema.workspaces)
          .set({ approvalReviewer: false })
          .where(eq(schema.workspaces.id, workspaceId));
        await close(row.id);
      }
    },
    SERVER_TEST_MS,
  );
});

describe("a job whose end nobody processed", () => {
  const job = (row: AssignmentRow, agentId: string, over: Partial<typeof runnerJobs.$inferInsert>) => ({
    id: newId("aj"),
    workspaceId,
    runnerId: "rnr_gone",
    agentId,
    assignmentId: row.id,
    threadId: row.threadId,
    channelId: row.channelId,
    title: "Build",
    executor: "claude_code" as const,
    prompt: "build it",
    ...over,
  });

  test(
    "a job the agent started (no work row) that ended while the server was down is processed",
    async () => {
      const { row, agentId } = await active("Build", ["Compile"]);
      const ended = job(row, agentId, {
        status: "done",
        result: "Built",
        endedAt: ago(5 * MIN),
        createdAt: ago(9 * MIN),
      });
      await server.deps.db.insert(runnerJobs).values(ended);
      expect((await snapshotOf(server.deps, row)).unsettled).toEqual([ended.id]);
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "settle", jobId: ended.id });
      await act(server.deps, row.id, { type: "settle", jobId: ended.id });
      const [after] = await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, ended.id));
      expect(after?.settledAt).toBeInstanceOf(Date);
      expect(await kinds(row.id)).toContain("job_done");
      expect((await snapshotOf(server.deps, await reload(row.id))).unsettled).toEqual([]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a job saved and never sent to the runner stops holding the slot: canceled and processed",
    async () => {
      const { row, agentId } = await active("Lost", ["Compile"]);
      const lost = job(row, agentId, { status: "queued", createdAt: ago(3 * MIN) });
      await server.deps.db.insert(runnerJobs).values(lost);
      const snap = await snapshotOf(server.deps, row);
      expect([snap.busy, snap.unsettled]).toEqual([false, [lost.id]]);
      await act(server.deps, row.id, { type: "settle", jobId: lost.id });
      const [after] = await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, lost.id));
      expect([after?.status, after?.settledAt instanceof Date]).toEqual(["canceled", true]);
      // A job still within the grace is the one being sent now: left alone.
      const sending = job(row, agentId, { status: "queued" });
      await server.deps.db.insert(runnerJobs).values(sending);
      expect((await snapshotOf(server.deps, await reload(row.id))).busy).toBe(true);
      await server.deps.db.delete(runnerJobs).where(eq(runnerJobs.id, sending.id));
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a step decided before the assignment stopped", () => {
  for (const status of ["paused", "canceled", "done"] as const)
    test(
      `decided while active, acted after it went ${status}: no turn goes out and the item keeps its turns`,
      async () => {
        const { row } = await active(`Late ${status}`, ["Paint"]);
        const action = await stepNext(server.deps, row.id);
        expect(action).toEqual({ type: "work", itemId: "p1", n: 1 });
        await moveAssignment(server.deps, row, ["active"], { status }, "status");
        await act(server.deps, row.id, action);
        const id = workIdOf(row.id, "p1", 1);
        const [w] = await server.deps.db.select().from(assignmentWork).where(eq(assignmentWork.id, id));
        expect([w?.status, w?.outcome]).toEqual(["ended", "canceled"]);
        expect(await server.deps.db.select().from(messages).where(eq(messages.clientId, id))).toEqual([]);
        expect(await turnsOf(row)).toEqual([["p1", "todo", 0]]);
        await close(row.id);
      },
      SERVER_TEST_MS,
    );
});

describe("two attempts of one item", () => {
  test(
    "forced: a late attempt doesn't go into the run a later attempt holds, nor stop it",
    async () => {
      const { row } = await active("Fence", ["[[slow:600]] Long job"]);
      const real = server.deps.runtime;
      // The mutant: the double takes the fence out of every call.
      const port: RuntimePort = DROP_LOCKS
        ? {
            ...real,
            runFor: (input) => real.runFor({ ...input, fence: undefined }),
            cancel: (runId, actor) => real.cancel(runId, actor),
          }
        : real;
      const later: AppDeps = { ...server.deps, runtime: port };
      // Attempt 1 is about to send its turn when attempt 2 (the next attempt, after a reap) sends its own.
      const early: AppDeps = {
        ...server.deps,
        runtime: {
          ...port,
          runFor: async (input) => {
            await act(later, row.id, { type: "work", itemId: "p1", n: 2 });
            return port.runFor(input);
          },
        },
      };
      await act(early, row.id, { type: "work", itemId: "p1", n: 1 });
      const [w1] = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.id, workIdOf(row.id, "p1", 1)));
      const [w2] = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.id, workIdOf(row.id, "p1", 2)));
      const [turn1] = await server.deps.db
        .select()
        .from(messages)
        .where(eq(messages.clientId, workIdOf(row.id, "p1", 1)));
      const into = await server.deps.db
        .select({ runId: messageDispatches.runId })
        .from(messageDispatches)
        .where(eq(messageDispatches.messageId, turn1?.id ?? ""));
      outcome(
        "run-fence",
        {
          attempt1: [w1?.status, w1?.outcome],
          attempt2Live: w2?.refId ? real.liveRun(w2.refId) !== null : false,
          turn1Reached: into.length,
        },
        { attempt1: ["ended", "canceled"], attempt2Live: true, turn1Reached: 0 },
      );
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "the runtime's fence: a lower token is turned away; a fenced stop only stops its own attempt's run",
    async () => {
      const { row, agentId } = await active("Fence unit", ["x"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!channel || !agent) throw new Error("setup");
      const say = async (body: string) => {
        const { message } = await postMessage(server.deps, {
          workspaceId,
          channel,
          author: { type: "person", id: ana.user.id },
          body,
          clientId: newId("c"),
          threadId: row.threadId,
        });
        const [m] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
        if (!m) throw new Error("no message");
        return m;
      };
      const key = `${row.id}:p1`;
      const first = await server.deps.runtime.runFor({
        agent,
        channel,
        trigger: await say("[[slow:600]] one"),
        fence: { key, token: 2 },
      });
      if (!first.ok) throw new Error(first.code);
      expect(
        await server.deps.runtime.runFor({
          agent,
          channel,
          trigger: await say("two"),
          fence: { key, token: 1 },
        }),
      ).toEqual({ ok: false, code: "fenced" });
      // Token 3 goes into the live run: from then on token 2's fenced stop doesn't touch it, token 3's does.
      const third = await server.deps.runtime.runFor({
        agent,
        channel,
        trigger: await say("three"),
        fence: { key, token: 3 },
      });
      expect(third).toMatchObject({ ok: true, runId: first.runId });
      expect(server.deps.runtime.cancel(first.runId, null, { key, token: 2 })).toBe(false);
      expect(server.deps.runtime.liveRun(first.runId)).not.toBeNull();
      expect(server.deps.runtime.cancel(first.runId, null, { key, token: 3 })).toBe(true);
      await first.done;
      // Two attempts in the same tick: the older one is past the first check when the newer one comes in, and
      // the check after the await turns it away before it reaches a run.
      const [four, five] = [await say("four"), await say("five")];
      const [older, newer] = await Promise.all([
        server.deps.runtime.runFor({ agent, channel, trigger: four, fence: { key, token: 4 } }),
        server.deps.runtime.runFor({ agent, channel, trigger: five, fence: { key, token: 5 } }),
      ]);
      expect([older.ok, older.ok ? "" : older.code, newer.ok]).toEqual([false, "fenced", true]);
      if (newer.ok) {
        server.deps.runtime.cancel(newer.runId, null);
        await newer.done;
      }
      // A message of another channel is never run here: its thread would pick another channel's tools.
      const side = await channelInWorkspace(
        server.deps.db,
        workspaceId,
        await seedChannel(server, workspaceId, { name: `side${Date.now()}`, members: [ana] }),
      );
      if (!side) throw new Error("no channel");
      await expect(
        server.deps.runtime.runFor({ agent, channel: side, trigger: await say("elsewhere") }),
      ).rejects.toThrow("is not of channel");
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a later attempt that goes while the earlier one's run is starting: the earlier run stops, fenced",
    async () => {
      const { row, agentId } = await active("Fence start", ["x"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!channel || !agent) throw new Error("setup");
      const say = async (body: string) => {
        const { message } = await postMessage(server.deps, {
          workspaceId,
          channel,
          author: { type: "person", id: ana.user.id },
          body,
          clientId: newId("c"),
          threadId: row.threadId,
        });
        const [m] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
        if (!m) throw new Error("no message");
        return m;
      };
      const key = `${row.id}:p1`;
      const [older, newer] = [await say("[[slow:300]] one"), await say("[[slow:300]] two")];
      // The forced interleave: attempt 2 goes right after attempt 1's run row is written, before attempt 1's
      // run is on the air. It waits for attempt 1's admission to the conversation, then finds a run it doesn't
      // join (attempt 1 stopped it, stale) and opens its own.
      let second: ReturnType<RuntimePort["runFor"]> | null = null;
      const { deps } = server;
      const real = deps.db;
      deps.db = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "insert") return typeof value === "function" ? value.bind(target) : value;
          return (table: typeof runs) => {
            const builder = target.insert(table);
            if (table !== runs || second) return builder;
            return wrapQuery(builder, async () => {
              second ??= deps.runtime.runFor({ agent, channel, trigger: newer, fence: { key, token: 2 } });
            });
          };
        },
      });
      let first: Awaited<ReturnType<RuntimePort["runFor"]>>;
      try {
        first = await deps.runtime.runFor({ agent, channel, trigger: older, fence: { key, token: 1 } });
      } finally {
        deps.db = real;
      }
      const later = await (second as ReturnType<RuntimePort["runFor"]> | null);
      expect(first).toEqual({ ok: false, code: "fenced" });
      if (!later?.ok) throw new Error("the later attempt didn't start");
      await server.deps.runtime.settle();
      const [olderRun] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, older.id));
      const [newerRun] = await server.deps.db.select().from(runs).where(eq(runs.id, later.runId));
      expect([olderRun?.status, newerRun?.status]).toEqual(["canceled", "done"]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "an attempt still starting its run when the assignment closes (and its fences are dropped) stops that run",
    async () => {
      const { row } = await active("Close mid-start", ["x"]);
      const { deps } = server;
      const real = deps.db;
      let fired = false;
      // While the attempt's run row is written: the assignment closes and its loop's last decision drops the fences.
      deps.db = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "insert") return typeof value === "function" ? value.bind(target) : value;
          return (table: typeof runs) => {
            const builder = target.insert(table);
            if (table !== runs || fired) return builder;
            return wrapQuery(builder, async () => {
              fired = true;
              await real.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
              expect(await stepNext({ ...deps, db: real }, row.id)).toEqual({ type: "end" });
            });
          };
        },
      });
      try {
        await act(deps, row.id, { type: "work", itemId: "p1", n: 1 });
      } finally {
        deps.db = real;
      }
      expect(fired).toBe(true);
      await server.deps.runtime.settle();
      const [w] = await real
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.id, workIdOf(row.id, "p1", 1)));
      const turnRuns = await real
        .select({ status: runs.status })
        .from(runs)
        .innerJoin(messages, eq(messages.id, runs.sourceMessageId))
        .where(eq(messages.clientId, workIdOf(row.id, "p1", 1)));
      expect([w?.status, turnRuns.map((r) => r.status)]).toEqual(["ended", ["canceled"]]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "an admit check that throws stops the run it was checking",
    async () => {
      const { row, agentId } = await active("Admit throws", ["x"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!channel || !agent) throw new Error("setup");
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: { type: "person", id: ana.user.id },
        body: "[[slow:300]] go",
        clientId: newId("c"),
        threadId: row.threadId,
      });
      const [trigger] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
      if (!trigger) throw new Error("no message");
      await expect(
        server.deps.runtime.runFor({
          agent,
          channel,
          trigger,
          fence: { key: `${row.id}:p1`, token: 1 },
          admit: async () => {
            throw new Error("records down");
          },
        }),
      ).rejects.toThrow("records down");
      await server.deps.runtime.settle();
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, trigger.id));
      expect(run?.status).toBe("canceled");
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "the fences of an item that ended, and of an assignment that ended, are forgotten",
    async () => {
      const { row, agentId } = await active("Fence end", ["x", "y"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!channel || !agent) throw new Error("setup");
      const fences = () =>
        [...server.runtime["fences"].keys()].filter((k) => k.startsWith(`${row.id}:`)).sort();
      const turn = async (itemId: string) => {
        const { message } = await postMessage(server.deps, {
          workspaceId,
          channel,
          author: { type: "person", id: ana.user.id },
          body: `turn of ${itemId}`,
          clientId: newId("c"),
          threadId: row.threadId,
        });
        const [m] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
        if (!m) throw new Error("no message");
        const res = await server.deps.runtime.runFor({
          agent,
          channel,
          trigger: m,
          fence: { key: `${row.id}:${itemId}`, token: 1 },
        });
        if (res.ok) await res.done;
      };
      await turn("p1");
      await turn("p2");
      expect(fences()).toEqual([`${row.id}:p1`, `${row.id}:p2`]);
      // p1 is done: its next attempt sends nothing and its fence goes.
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done" })
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
      await act(server.deps, row.id, { type: "work", itemId: "p1", n: 2 });
      expect(fences()).toEqual([`${row.id}:p2`]);
      // The assignment ends (its loop, woken by the runs' ends, stops what it started): the rest go.
      await close(row.id);
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "end" });
      expect(fences()).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a fenced attempt isn't put off into the next run: the run it gets back is the one that answers it",
    async () => {
      const { row, agentId } = await active("Fence put off", ["x"]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      const [agent] = await server.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
      if (!channel || !agent) throw new Error("setup");
      const beto = await memberOf(server, workspaceId, "Beto", `beto${Date.now()}@recovery.test`);
      await server.deps.db
        .insert(schema.agentGrants)
        .values({ agentId, workspaceId, connectionId: "", scope: "tool:memory" });
      const say = async (who: Person, body: string) => {
        const { message } = await postMessage(server.deps, {
          workspaceId,
          channel,
          author: { type: "person", id: who.user.id },
          body,
          clientId: newId("c"),
          threadId: row.threadId,
        });
        const [m] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
        if (!m) throw new Error("no message");
        return m;
      };
      // Beto's run reads his own notes: it is pinned to him, and a message from Ana waits for the next run.
      const his = await server.deps.runtime.runFor({
        agent,
        channel,
        trigger: await say(
          beto,
          '[[tool:memory {"command":"view","path":"/memories/you"}]] [[slow:300]] mine',
        ),
      });
      if (!his.ok) throw new Error(his.code);
      await waitFor(async () => {
        const steps = await server.deps.db
          .select()
          .from(schema.runEvents)
          .where(eq(schema.runEvents.runId, his.runId));
        return steps.some((e) => e.kind === "tool_result");
      });
      const trigger = await say(ana, "the item");
      const turn = await server.deps.runtime.runFor({
        agent,
        channel,
        trigger,
        fence: { key: `${row.id}:p1`, token: 1 },
      });
      if (!turn.ok) throw new Error(turn.code);
      expect(turn.runId).not.toBe(his.runId);
      expect(server.deps.runtime.liveRun(his.runId)).toBeNull();
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.id, turn.runId));
      expect(run?.sourceMessageId).toBe(trigger.id);
      // And its fenced stop reaches it.
      expect(server.deps.runtime.cancel(turn.runId, null, { key: `${row.id}:p1`, token: 1 })).toBe(true);
      await turn.done;
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("what the next turn hears", () => {
  test(
    "a job that ended during the previous turn shows in the next turn's news",
    async () => {
      const { row, agentId } = await active("News", ["Fix the bug"]);
      const t0 = ago(20 * MIN);
      // Turn 1 started at t0 and ended 10 min later; the job the agent started in it ended halfway.
      await server.deps.db.insert(assignmentWork).values({
        id: workIdOf(row.id, "p1", 1),
        assignmentId: row.id,
        itemId: "p1",
        n: 1,
        kind: "run",
        status: "ended",
        outcome: "done",
        refId: "run_turn1",
        startedAt: t0,
        endedAt: new Date(t0.getTime() + 10 * MIN),
      });
      // Attempt 2 was refused before it went out (it never got a run): it isn't a turn the agent heard.
      await server.deps.db.insert(assignmentWork).values({
        id: workIdOf(row.id, "p1", 2),
        assignmentId: row.id,
        itemId: "p1",
        n: 2,
        kind: "run",
        status: "ended",
        outcome: "failed",
        startedAt: new Date(t0.getTime() + 12 * MIN),
        endedAt: new Date(t0.getTime() + 12 * MIN),
      });
      await server.deps.db.insert(runnerJobs).values({
        id: newId("aj"),
        workspaceId,
        runnerId: "rnr_gone",
        agentId,
        assignmentId: row.id,
        title: "Tests",
        executor: "claude_code",
        prompt: "run the tests",
        status: "done",
        result: "RESULT-ALL-GREEN",
        createdAt: new Date(t0.getTime() + MIN),
        endedAt: new Date(t0.getTime() + 5 * MIN),
        settledAt: new Date(t0.getTime() + 5 * MIN),
      });
      await act(server.deps, row.id, { type: "work", itemId: "p1", n: 3 });
      const [turn] = await server.deps.db
        .select()
        .from(messages)
        .where(eq(messages.clientId, workIdOf(row.id, "p1", 3)));
      expect(turn?.body).toContain("RESULT-ALL-GREEN");
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a crash in the middle of a validation", () => {
  test(
    "the fix goes in before the verdict: a crash between the two leaves the fix to work on and the round unspent",
    async () => {
      const { row } = await active("Check", ["Docs"]);
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done", summary: "wrote them" })
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
      const failing: Verifier = async (_deps, _row, items) => ({
        ok: true,
        runId: null,
        verdicts: items.map((i) => ({ id: i.item.id, passes: false, reason: "Missing the install step" })),
      });
      // The database falls on the verdict's write.
      const db = new Proxy(server.deps.db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "update") return typeof value === "function" ? value.bind(target) : value;
          return (table: unknown) => {
            const builder = target.update(table as typeof assignmentPlanItems);
            if (table !== assignmentPlanItems) return builder;
            return new Proxy(builder, {
              get(b, p) {
                const v = Reflect.get(b, p, b);
                if (p !== "set") return typeof v === "function" ? v.bind(b) : v;
                return (values: Record<string, unknown>) => {
                  if ("passes" in values && values.passes === false) throw new Error("crash");
                  return v.call(b, values);
                };
              },
            });
          };
        },
      });
      const crashing: AppDeps = { ...server.deps, db, assignmentVerifier: failing };
      await expect(act(crashing, row.id, { type: "validate", itemIds: ["p1"], round: 1 })).rejects.toThrow(
        "crash",
      );
      const items = await planOf(server.deps, row.id);
      expect(items.map((i) => [i.id, i.kind, i.status, i.checks, i.passes])).toEqual([
        ["p1", "work", "done", 0, null],
        [items[1]?.id ?? "", "fix", "todo", 0, null],
      ]);
      // No round was spent: the next step works on the fix.
      expect(decide(await snapshotOf(server.deps, await reload(row.id)), new Date())).toMatchObject({
        type: "work",
        itemId: items[1]?.id,
      });
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("the local engine stopping", () => {
  test(
    "a stop that lands while the loop decides: the decision isn't acted on",
    async () => {
      const own = await startTestServer({ assignmentVerifier: passing().verifier });
      try {
        const owner = await signedIn(own, "Ana", "ana@engine-stop.test");
        const ws = await seedWorkspace(own, owner, "Stop");
        const agentId = await seedAgent(own.deps.db, ws.workspaceId, owner, null);
        const proposed = await createAssignment(own.deps, {
          workspaceId: ws.workspaceId,
          agentId,
          agentHandle: `lia${agentId.slice(-4)}`,
          channelId: ws.general,
          ownerId: owner.user.id,
          title: "Stop",
          goal: "Stop",
          executor: "agent",
          runnerId: null,
          commandPolicy: "always",
          plan: ["One"],
        });
        await own.deps.db
          .update(assignments)
          .set({ status: "active", startedAt: own.deps.now() })
          .where(eq(assignments.id, proposed.id));
        // The loop's first read of the assignment (its decision) waits for the test.
        let release!: () => void;
        const held = new Promise<void>((r) => {
          release = r;
        });
        let reached!: () => void;
        const deciding = new Promise<void>((r) => {
          reached = r;
        });
        let armed = true;
        const real = own.deps.db;
        own.deps.db = new Proxy(real, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
            return (...args: Parameters<typeof target.select>) =>
              wrapQuery(target.select(...args), async (q) => {
                if (!armed || !String(q.toSQL?.().sql ?? "").includes('from "assignments"')) return;
                armed = false;
                reached();
                await held;
              });
          },
        });
        try {
          own.deps.assignmentEngine.wake(proposed.id);
          await deciding;
          const stopping = own.deps.assignmentEngine.stop();
          release();
          await stopping;
        } finally {
          own.deps.db = real;
        }
        const work = await own.deps.db
          .select()
          .from(assignmentWork)
          .where(eq(assignmentWork.assignmentId, proposed.id));
        expect(work).toEqual([]);
      } finally {
        await own.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

describe("two steps on one validation", () => {
  /** A barrier: `wait` resolves once `open` was called (or at once, if it already was). */
  const barrier = () => {
    let open!: () => void;
    const opened = new Promise<void>((r) => {
      open = r;
    });
    return { open, wait: () => opened };
  };
  const claimKey = (id: string) => `assignment-validate:${id}`;
  const claimOf = async (id: string) =>
    (
      await server.deps.db
        .select()
        .from(schema.effectKeys)
        .where(eq(schema.effectKeys.key, claimKey(id)))
    )[0];
  const doneItems = async (row: AssignmentRow, ids: string[]) => {
    for (const id of ids)
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done", summary: "wrote them" })
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, id)));
  };
  const verdicts = (items: Parameters<Verifier>[2], passes: boolean) => ({
    ok: true as const,
    runId: null,
    verdicts: items.map((i) => ({ id: i.item.id, passes, reason: passes ? "ok" : "No" })),
  });

  test(
    "two steps on the same round call the verifier once and spend one round",
    async () => {
      const { row } = await active("Twice", ["Docs"]);
      await doneItems(row, ["p1"]);
      // The first call waits until the other step is done (it found the round held).
      const other = barrier();
      let calls = 0;
      // Only the first call waits: a second one (a regression) returns at once and fails the assertion below.
      const counting: Verifier = async (_deps, _row, items) => {
        calls++;
        if (calls === 1) await other.wait();
        return verdicts(items, false);
      };
      const deps = { ...server.deps, assignmentVerifier: counting };
      const step = { type: "validate" as const, itemIds: ["p1"], round: 1 };
      const first = act(deps, row.id, step);
      try {
        await waitFor(async () => calls === 1);
        expect(await act(deps, row.id, step)).toBe(30_000);
      } finally {
        other.open();
      }
      await first;
      const p1 = (await planOf(server.deps, row.id)).find((i) => i.id === "p1");
      expect([calls, p1?.checks, await claimOf(row.id)]).toEqual([1, 1, undefined]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a step decided for round 1 after round 1 was spent calls nothing; nor does round 2 while round 1 still writes",
    async () => {
      const { row } = await active("Rounds", ["Docs", "Tests"]);
      await doneItems(row, ["p1", "p2"]);
      let calls = 0;
      // Round 1's verifier fails: it counts as a round (checks + 1) and frees the claim.
      const unparsed: Verifier = async () => {
        calls++;
        return { ok: false, code: "unparsed", error: "no verdict" };
      };
      const step = { type: "validate" as const, itemIds: ["p1", "p2"], round: 1 };
      await act({ ...server.deps, assignmentVerifier: unparsed }, row.id, step);
      expect(calls).toBe(1);
      // A second step decided for round 1 before that: it finds the round spent and calls nothing.
      expect(await act({ ...server.deps, assignmentVerifier: unparsed }, row.id, step)).toBeNull();
      expect(calls).toBe(1);

      // Round 2 is held while its call is out; meanwhile p1's checks already moved on (a partial write) and a
      // step decides round 3 for both: it waits for the claim instead of calling.
      const out = barrier();
      const slow: Verifier = async (_deps, _row, items) => {
        calls++;
        // Only round 2's call waits; a round-3 call (a regression) returns at once.
        if (calls === 2) await out.wait();
        return verdicts(items, false);
      };
      const second = act({ ...server.deps, assignmentVerifier: slow }, row.id, { ...step, round: 2 });
      try {
        await waitFor(async () => calls === 2);
        await server.deps.db
          .update(assignmentPlanItems)
          .set({ checks: 2 })
          .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
        expect(await act({ ...server.deps, assignmentVerifier: slow }, row.id, { ...step, round: 3 })).toBe(
          30_000,
        );
        expect(calls).toBe(2);
      } finally {
        out.open();
      }
      await second;
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a validation decided before a pause makes no paid call",
    async () => {
      const { row } = await active("Paused round", ["Docs"]);
      await doneItems(row, ["p1"]);
      let calls = 0;
      const counting: Verifier = async (_deps, _row, items) => {
        calls++;
        return verdicts(items, true);
      };
      expect(await stepNext(server.deps, row.id)).toEqual({ type: "validate", itemIds: ["p1"], round: 1 });
      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, row.id));
      await act({ ...server.deps, assignmentVerifier: counting }, row.id, {
        type: "validate",
        itemIds: ["p1"],
        round: 1,
      });
      expect(calls).toBe(0);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a pause that lands between the claim and the verifier's call: no paid call, and the claim is released",
    async () => {
      const { row } = await active("Paused mid-round", ["Docs"]);
      await doneItems(row, ["p1"]);
      let calls = 0;
      const counting: Verifier = async (_deps, _row, items) => {
        calls++;
        return verdicts(items, true);
      };
      // The round's input reads the assignment's jobs after the claim: the pause lands right there.
      let paused = false;
      const db = new Proxy(server.deps.db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "select") return typeof value === "function" ? value.bind(target) : value;
          return (...args: Parameters<typeof target.select>) =>
            wrapQuery(target.select(...args), async (q) => {
              if (paused || !String(q.toSQL?.().sql ?? "").includes('from "runner_jobs"')) return;
              paused = true;
              await server.deps.db
                .update(assignments)
                .set({ status: "paused" })
                .where(eq(assignments.id, row.id));
            });
        },
      });
      await act({ ...server.deps, db, assignmentVerifier: counting }, row.id, {
        type: "validate",
        itemIds: ["p1"],
        round: 1,
      });
      expect([paused, calls, await claimOf(row.id)]).toEqual([true, 0, undefined]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a step past the lease loses the claim to the next one, and its end doesn't release the next one's claim",
    async () => {
      const { row } = await active("Lease", ["Docs"]);
      await doneItems(row, ["p1"]);
      const later = barrier();
      let calls = 0;
      let next: Promise<number | null> | null = null;
      // The first step's call outlives the lease; a second step takes the claim and is still calling when the
      // first one ends.
      const verifier: Verifier = async (_deps, _row, items) => {
        calls++;
        if (calls === 1) {
          await server.deps.db
            .update(schema.effectKeys)
            .set({ createdAt: new Date(Date.now() - 21 * MIN) })
            .where(eq(schema.effectKeys.key, claimKey(row.id)));
          next = act(deps, row.id, { type: "validate", itemIds: ["p1"], round: 1 });
          await waitFor(async () => calls === 2);
          return verdicts(items, false);
        }
        await later.wait();
        return verdicts(items, false);
      };
      const deps = { ...server.deps, assignmentVerifier: verifier };
      try {
        await act(deps, row.id, { type: "validate", itemIds: ["p1"], round: 1 });
        // The first step is done: it lost the round, so it wrote nothing, and the second one's claim is still there.
        const claim = await claimOf(row.id);
        expect(claim?.status).toBe("pending");
        expect((await planOf(server.deps, row.id)).find((i) => i.id === "p1")?.checks).toBe(0);
      } finally {
        later.open();
      }
      await next;
      expect(await claimOf(row.id)).toBeUndefined();
      // The round is the second step's.
      expect((await planOf(server.deps, row.id)).find((i) => i.id === "p1")?.checks).toBe(1);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a fix isn't written for an item the owner changed after the verdict was read, before the plan's lock",
    async () => {
      const { row } = await active("Edited mid-fix", ["Docs"]);
      await doneItems(row, ["p1"]);
      const { deps: base } = server;
      const real = base.db;
      let judged = false;
      let edited = false;
      // The forced interleave: the verifier failed the item, the step read the plan again (still done, same
      // epoch), and the owner's edit lands right before the plan write takes its lock.
      const db = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "transaction" || !judged || edited)
            return typeof value === "function" ? value.bind(target) : value;
          return async (fn: Parameters<typeof real.transaction>[0]) => {
            edited = true;
            await writePlan({ ...base, db: real }, row.id, {
              author: { type: "person", id: ana.user.id },
              mode: "person",
              items: [{ id: "p1", title: "Docs", criteria: "Docs in two languages" }],
            });
            return target.transaction(fn);
          };
        },
      });
      const verifier: Verifier = async (_deps, _row, items) => {
        judged = true;
        return verdicts(items, false);
      };
      await act({ ...base, db, assignmentVerifier: verifier }, row.id, {
        type: "validate",
        itemIds: ["p1"],
        round: 1,
      });
      const plan = await planOf(server.deps, row.id);
      expect(edited).toBe(true);
      expect(plan.filter((i) => i.kind === "fix").map((i) => i.fixes)).toEqual([]);
      expect(plan.find((i) => i.id === "p1")?.criteria).toBe("Docs in two languages");
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("a validation with no room for its fix", () => {
  test(
    "a full plan pauses the assignment and leaves the round unspent, instead of calling the verifier again",
    async () => {
      const titles = Array.from({ length: 60 }, (_, i) => `Part ${i + 1}`);
      const { row } = await active("Full", titles);
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done", summary: "done" })
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
      const failing: Verifier = async (_deps, _row, items) => ({
        ok: true,
        runId: null,
        verdicts: items.map((i) => ({ id: i.item.id, passes: false, reason: "Not yet" })),
      });
      await act({ ...server.deps, assignmentVerifier: failing }, row.id, {
        type: "validate",
        itemIds: ["p1"],
        round: 1,
      });
      const p1 = (await planOf(server.deps, row.id)).find((i) => i.id === "p1");
      expect([p1?.checks, p1?.passes, (await reload(row.id)).status]).toEqual([0, null, "paused"]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("removing an item", () => {
  test(
    "a person removing a plan item removes its fix items too, done or not, even one kept in the list",
    async () => {
      const { row } = await active("Cascade", ["Docs", "Code"]);
      await writePlan(server.deps, row.id, {
        author: { type: "verifier", id: null },
        mode: "append",
        items: [
          { id: "p1-fix1", title: "Docs", criteria: "add install", kind: "fix", fixes: "p1" },
          { id: "p1-fix2", title: "Docs", criteria: "add usage", kind: "fix", fixes: "p1-fix1" },
        ],
      });
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done" })
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1-fix1")));
      const w = await writePlan(server.deps, row.id, {
        author: { type: "person", id: ana.user.id },
        mode: "person",
        // The person keeps a fix in the list but takes out the item it fixes: the fix goes with it.
        items: [
          { id: "p2", title: "Code" },
          { id: "p1-fix2", title: "Docs", criteria: "add usage" },
        ],
      });
      expect(w.removed.sort()).toEqual(["p1", "p1-fix1", "p1-fix2"]);
      expect((await planOf(server.deps, row.id)).map((i) => [i.id, i.status]).sort()).toEqual([
        ["p1", "dropped"],
        ["p1-fix1", "dropped"],
        ["p1-fix2", "dropped"],
        ["p2", "todo"],
      ]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

describe("telling the executor after a person's answer", () => {
  test(
    "it reads the assignment after the answer: paused meanwhile, nothing is told; active, the agent hears it once",
    async () => {
      const { row, agentId } = await active("Tell", ["Paint"]);
      const said = async () =>
        (await server.deps.db.select().from(messages).where(eq(messages.threadId, row.threadId))).filter(
          (m) => m.authorKind === "person" && m.body.endsWith("go ahead"),
        );
      // The route read it active; a pause landed before the tell.
      await moveAssignment(server.deps, row, ["active"], { status: "paused" }, "status");
      expect(
        await tellIfPossible(server.deps, row.id, ana.user.id, "go ahead", (r) => r.status === "active"),
      ).toBe(false);
      expect(await said()).toEqual([]);
      await moveAssignment(server.deps, await reload(row.id), ["paused"], { status: "active" }, "status");
      expect(
        await tellIfPossible(server.deps, row.id, ana.user.id, "go ahead", (r) => r.status === "active"),
      ).toBe(true);
      await server.deps.runtime.settle();
      const told = await said();
      expect(told).toHaveLength(1);
      const reached = await server.deps.db
        .select()
        .from(messageDispatches)
        .where(eq(messageDispatches.messageId, told[0]?.id ?? ""));
      expect(reached.map((d) => d.agentId)).toEqual([agentId]);
      await close(row.id);
    },
    SERVER_TEST_MS,
  );
});

// Wait for the runtime's slow runs of these tests to end before the server stops.
afterAll(async () => {
  await waitFor(async () => server.deps.runtime.busyAgents().size === 0).catch(() => {});
}, SERVER_TEST_MS);
