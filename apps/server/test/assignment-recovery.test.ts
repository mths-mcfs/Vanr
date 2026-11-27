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
import { type AssignmentRow, moveAssignment } from "../src/assignments/core";
import { createAssignment } from "../src/assignments/engine";
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
import { DROP_LOCKS, outcome } from "./lock-double";
import { type Person, seedChannel, seedWorkspace } from "./seed";

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
        startedAt: t0,
        endedAt: new Date(t0.getTime() + 10 * MIN),
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
      await act(server.deps, row.id, { type: "work", itemId: "p1", n: 2 });
      const [turn] = await server.deps.db
        .select()
        .from(messages)
        .where(eq(messages.clientId, workIdOf(row.id, "p1", 2)));
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
