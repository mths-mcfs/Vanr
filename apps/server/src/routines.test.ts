// Routines without the runtime: a document asks the runtime for a text (`complete`) and a conversation runs the agent
// (`runFor`), which the server doesn't have until slice S6, so their execution is rejected at its entry before
// anything is written. A routine whose target is a debate only opens one, so it runs to the end here; the fire, the
// schedule, the queue, the overlap, the retries and the recovery of an interrupted execution work on their own. An
// interrupted execution is saved the way the execution saves it while it runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RoutineTrigger } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../test/harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "../test/seed";
import type { AgentRow } from "./agents";
import type { AppDeps } from "./context";
import {
  CATCH_UP_MAX_MS,
  canSeeRoutine,
  drainQueues,
  dueRoutines,
  fireRoutineEvent,
  nextRunFor,
  PENDING_STALE_MS,
  RETRY_BASE_MS,
  ROUTINE_CONTEXT_CHARS,
  type RoutineRow,
  registerFire,
  retryDelayMs,
  runtimeFor,
  STALE_GRACE_MS,
  seriesRule,
  startRoutineRun,
  toRoutines,
  toRun,
  webhookUrl,
} from "./routines";
import type { RunningServer } from "./server";

const { routines, routineExecutions, debates, notifications } = schema;
type Execution = typeof routineExecutions.$inferSelect;

let server: RunningServer;
let workspaceId: string;
let ana: Person;
let bob: Person;
let agent: AgentRow;
const MIN = 60_000;

beforeAll(async () => {
  server = await startTestServer();
  ana = await signedIn(server, "Ana", "ana@routines.test");
  ({ workspaceId } = await seedWorkspace(server, ana, "Routines"));
  bob = await memberOf(server, workspaceId, "Bob", "bob@routines.test");
  const [row] = await server.deps.db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: "Rita",
      handle: "rita",
      role: "support",
      instructions: "",
      model: "claude-haiku-5-5",
      ownerUserId: ana.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  if (!row) throw new Error("no agent");
  agent = row;
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const debateTarget = () => ({ kind: "debate", agentIds: [agent.id], roundLimit: 1 });

async function newRoutine(values: Partial<typeof routines.$inferInsert> = {}): Promise<RoutineRow> {
  const [row] = await server.deps.db
    .insert(routines)
    .values({
      id: newId("rtn"),
      workspaceId,
      name: "Daily digest",
      prompt: "Summarize the day",
      agentId: agent.id,
      target: debateTarget(),
      trigger: { kind: "webhook" },
      createdBy: ana.user.id,
      ...values,
    })
    .returning();
  if (!row) throw new Error("no routine");
  return row;
}

/** The deps with the background work observed (see debates.test.ts) and, optionally, another clock. */
function observed(now?: Date) {
  const deps = server.deps;
  const outcomes: Promise<unknown>[] = [];
  const runtime = {
    ...deps.runtime,
    track(work: Promise<unknown>, what: string) {
      outcomes.push(
        work.then(
          () => null,
          (err: unknown) => err,
        ),
      );
      deps.runtime.track(work, what);
    },
  };
  const watched: AppDeps = { ...deps, runtime, ...(now ? { now: () => now } : {}) };
  return {
    deps: watched,
    async failures() {
      await deps.runtime.settle();
      return (await Promise.all(outcomes)).filter(Boolean);
    },
  };
}

/** Done with these routines: their executions left recorded go with them, so no later sweep takes them. */
const drop = (...rows: RoutineRow[]) =>
  Promise.all(rows.map((r) => server.deps.db.delete(routines).where(eq(routines.id, r.id))));

const executionsOf = (routineId: string) =>
  server.deps.db
    .select()
    .from(routineExecutions)
    .where(eq(routineExecutions.routineId, routineId))
    .orderBy(routineExecutions.at, routineExecutions.attempt);

const routineRow = async (id: string) => {
  const [row] = await server.deps.db.select().from(routines).where(eq(routines.id, id));
  if (!row) throw new Error("no routine");
  return row;
};

const debatesOf = (routineId: string) =>
  server.deps.db
    .select()
    .from(debates)
    .where(and(eq(debates.workspaceId, workspaceId)))
    .then((rows) => rows.filter((d) => (d.origin as { routineId?: string } | null)?.routineId === routineId));

describe("the next time", () => {
  const schedule = (rule: Record<string, unknown>): RoutineTrigger => ({
    kind: "schedule",
    rule: { freq: "daily", times: ["09:00"], timezone: "UTC", ...rule },
  });

  test("in the rule's time zone, across a daylight saving change, after the series ends and anchored in the past", () => {
    // 09:00 in São Paulo (UTC-3) is 12:00 UTC.
    expect(nextRunFor(schedule({ timezone: "America/Sao_Paulo" }), new Date("2026-11-14T13:00:00Z"))).toEqual(
      new Date("2026-11-15T12:00:00Z"),
    );
    // New York moves to daylight time on 2027-03-14: 09:00 is 14:00 UTC the day before and 13:00 UTC on that day.
    const ny = schedule({ timezone: "America/New_York" });
    expect(nextRunFor(ny, new Date("2027-03-12T15:00:00Z"))).toEqual(new Date("2027-03-13T14:00:00Z"));
    expect(nextRunFor(ny, new Date("2027-03-13T15:00:00Z"))).toEqual(new Date("2027-03-14T13:00:00Z"));
    expect(nextRunFor(schedule({ until: "2026-11-01" }), new Date("2026-11-14T13:00:00Z"))).toBeNull();
    // An hourly series of 2 anchored at its creation: the creation's own instant doesn't count, then it ends.
    const anchor = new Date("2026-11-14T10:00:00Z");
    const hourly: RoutineTrigger = { kind: "schedule", rule: { freq: "hourly", count: 2, timezone: "UTC" } };
    expect(seriesRule({ freq: "hourly", count: 2, timezone: "UTC" }, anchor).count).toBe(3);
    const first = nextRunFor(hourly, anchor, anchor);
    const second = first && nextRunFor(hourly, first, anchor);
    expect([first, second]).toEqual([new Date("2026-11-14T11:00:00Z"), new Date("2026-11-14T12:00:00Z")]);
    expect(second && nextRunFor(hourly, second, anchor)).toBeNull();
    // Long after the anchor the count still holds: no next time.
    expect(nextRunFor(hourly, new Date("2026-12-01T00:00:00Z"), anchor)).toBeNull();
    expect(
      nextRunFor(
        { kind: "once", at: "2026-11-01T10:00:00Z", timezone: "UTC" },
        new Date("2026-11-14T00:00:00Z"),
      ),
    ).toBeNull();
    expect(
      nextRunFor(
        { kind: "once", at: "2026-12-01T10:00:00Z", timezone: "UTC" },
        new Date("2026-11-14T00:00:00Z"),
      ),
    ).toEqual(new Date("2026-12-01T10:00:00Z"));
    for (const trigger of [
      { kind: "webhook" },
      { kind: "event", event: "debate.concluded" },
    ] as RoutineTrigger[])
      expect(nextRunFor(trigger, new Date())).toBeNull();
  });
});

describe("recording a fire", () => {
  test(
    "the same webhook delivered N times at once records one execution; the context is cut at its limit",
    async () => {
      expect(ROUTINE_CONTEXT_CHARS).toBe(12_000);
      const routine = await newRoutine();
      const fires = await Promise.all(
        Array.from({ length: 8 }, () =>
          registerFire(server.deps, routine.id, {
            trigger: "webhook",
            key: "webhook:msg_1",
            context: { text: "x".repeat(ROUTINE_CONTEXT_CHARS * 2), untrusted: "webhook" },
          }),
        ),
      );
      const fresh = fires.filter((f) => !f.duplicate);
      expect(fresh).toHaveLength(1);
      const id = fresh[0]?.run?.id;
      expect(fires.every((f) => f.run?.id === id)).toBe(true);
      const [saved] = await executionsOf(routine.id);
      expect(saved?.payload?.text).toHaveLength(ROUTINE_CONTEXT_CHARS);
      expect(saved).toMatchObject({ status: "pending", dedupeKey: "webhook:msg_1", notBefore: null });
      const slot = new Date("2026-11-14T09:00:00Z");
      const slots = await Promise.all(
        [1, 2, 3].map(() =>
          registerFire(server.deps, routine.id, { trigger: "schedule", scheduledFor: slot }),
        ),
      );
      expect(slots.filter((f) => !f.duplicate)).toHaveLength(1);
      await drop(routine);
    },
    SERVER_TEST_MS,
  );
});

describe("executing", () => {
  test(
    "a document or a conversation is rejected with not_available before anything is written",
    async () => {
      const channel = await seedChannel(server, workspaceId, { name: "digest", members: [ana] });
      for (const [target, method] of [
        [{ kind: "channel", channelId: channel }, "runFor"],
        [{ kind: "dm" }, "runFor"],
        [{ kind: "conversation" }, "runFor"],
        [{ kind: "file" }, "complete"],
      ] as const) {
        const routine = await newRoutine({ target });
        const reg = await registerFire(server.deps, routine.id, {
          trigger: "manual",
          key: `manual:${target.kind}`,
        });
        if (reg.duplicate) throw new Error("duplicate");
        expect(runtimeFor(target)).toBe(method);
        await expect(startRoutineRun(server.deps, reg.run)).rejects.toMatchObject({
          status: 503,
          code: "not_available",
          params: { method },
        });
        const [after] = await executionsOf(routine.id);
        expect(after).toEqual(reg.run);
        expect((await routineRow(routine.id)).runningSince).toBeNull();
        await drop(routine);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a debate routine runs to the end: the debate opens with the routine's origin and the creator is told",
    async () => {
      const routine = await newRoutine({ name: "Weekly debate" });
      const watch = observed();
      const reg = await registerFire(watch.deps, routine.id, {
        trigger: "webhook",
        key: "webhook:d1",
        context: { text: "Outside text", untrusted: "webhook:d1" },
      });
      if (reg.duplicate) throw new Error("duplicate");
      const done = await startRoutineRun(watch.deps, reg.run);
      expect(done).toMatchObject({
        status: "ok",
        summaryKey: "routines.run.debate",
        summary: "Weekly debate",
      });
      const [debate] = await debatesOf(routine.id);
      expect(debate).toMatchObject({ title: "Weekly debate", requesterUserId: ana.user.id });
      expect(debate?.goal).toBe("Summarize the day\n\n---\nOutside text");
      expect(debate?.origin).toEqual({
        kind: "routine",
        agentId: agent.id,
        routineId: routine.id,
        untrusted: "webhook:d1",
      });
      expect(done.summaryVars).toEqual({ debateId: debate?.id ?? "", title: "Weekly debate" });
      expect((await routineRow(routine.id)).runningSince).toBeNull();
      const told = await server.deps.db
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.kind, "routine_report"), eq(notifications.groupKey, `routine:${routine.id}`)),
        );
      expect(told.map((n) => n.userId)).toEqual([ana.user.id]);
      // The only failure in the background is the debate's agent turn, which waits for the runtime.
      expect((await watch.failures()).map((e) => (e as { code?: string }).code)).toEqual(["not_available"]);
      expect(toRun(done)).toMatchObject({
        status: "ok",
        trigger: "webhook",
        summaryKey: "routines.run.debate",
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "a routine still running: the next fire is skipped (its key freed) or waits in a queue of one",
    async () => {
      const at = new Date();
      const busy = { runningSince: at, runningUntil: new Date(at.getTime() + 30 * MIN) };
      const skip = await newRoutine(busy);
      const reg = await registerFire(server.deps, skip.id, { trigger: "webhook", key: "webhook:o1" });
      if (reg.duplicate) throw new Error("duplicate");
      expect(await startRoutineRun(server.deps, reg.run)).toMatchObject({
        status: "skipped",
        reason: "overlap",
        dedupeKey: null,
      });
      // The key went: the sender can deliver again.
      expect(
        (await registerFire(server.deps, skip.id, { trigger: "webhook", key: "webhook:o1" })).duplicate,
      ).toBe(false);

      const queue = await newRoutine({ ...busy, policy: { overlap: "queue" } });
      const runs: Execution[] = [];
      for (const key of ["q1", "q2"]) {
        const r = await registerFire(server.deps, queue.id, { trigger: "webhook", key });
        if (r.duplicate) throw new Error("duplicate");
        runs.push(await startRoutineRun(server.deps, r.run));
      }
      expect(runs.map((r) => [r.status, r.reason])).toEqual([
        ["queued", null],
        ["skipped", "overlap"],
      ]);
      // The previous execution ended: two queue sweeps at once, one execution.
      await server.deps.db
        .update(routines)
        .set({ runningSince: null, runningUntil: null })
        .where(eq(routines.id, queue.id));
      const watch = observed(new Date(Date.now() + MIN));
      await Promise.all([drainQueues(watch.deps), drainQueues(watch.deps)]);
      await watch.failures();
      const after = await executionsOf(queue.id);
      expect(after.map((r) => r.status).sort()).toEqual(["ok", "skipped"]);
      expect(await debatesOf(queue.id)).toHaveLength(1);
      await drop(skip, queue);
    },
    SERVER_TEST_MS,
  );

  test(
    "a paused routine skips what was queued; what a person asked for runs even paused",
    async () => {
      const routine = await newRoutine({ active: false });
      const queued = await registerFire(server.deps, routine.id, { trigger: "webhook", key: "webhook:p1" });
      if (queued.duplicate) throw new Error("duplicate");
      await server.deps.db
        .update(routineExecutions)
        .set({ status: "queued", notBefore: new Date() })
        .where(eq(routineExecutions.id, queued.run.id));
      const watch = observed(new Date(Date.now() + MIN));
      await drainQueues(watch.deps);
      await watch.failures();
      const [skipped] = await executionsOf(routine.id);
      expect(skipped).toMatchObject({ status: "skipped", reason: "paused", dedupeKey: null });
      const manual = await registerFire(server.deps, routine.id, { trigger: "manual", key: "manual:p2" });
      if (manual.duplicate) throw new Error("duplicate");
      expect(await startRoutineRun(watch.deps, manual.run)).toMatchObject({ status: "ok" });
      await watch.failures();
    },
    SERVER_TEST_MS,
  );

  test(
    "an execution of a deleted routine goes with it, and the sweep finds nothing",
    async () => {
      const routine = await newRoutine();
      await registerFire(server.deps, routine.id, { trigger: "webhook", key: "webhook:gone" });
      await server.deps.db.delete(routines).where(eq(routines.id, routine.id));
      expect(await executionsOf(routine.id)).toEqual([]);
      const watch = observed(new Date(Date.now() + 10 * MIN));
      await drainQueues(watch.deps);
      expect(await watch.failures()).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("a fall in the middle", () => {
  test(
    "a fire recorded and never begun is taken by the sweep after PENDING_STALE_MS, not before",
    async () => {
      expect(PENDING_STALE_MS).toBe(2 * MIN);
      const routine = await newRoutine();
      const reg = await registerFire(server.deps, routine.id, { trigger: "webhook", key: "webhook:orphan" });
      if (reg.duplicate) throw new Error("duplicate");
      const recorded = reg.run.at.getTime();
      const soon = observed(new Date(recorded + PENDING_STALE_MS - 1000));
      await drainQueues(soon.deps);
      await soon.failures();
      expect((await executionsOf(routine.id))[0]?.status).toBe("pending");
      const late = observed(new Date(recorded + PENDING_STALE_MS + 1000));
      await drainQueues(late.deps);
      await late.failures();
      expect((await executionsOf(routine.id))[0]?.status).toBe("ok");
    },
    SERVER_TEST_MS,
  );

  test(
    "an interrupted execution fails after its cap and the grace, retries after 1, 4 and 16 minutes, then tells and pauses",
    async () => {
      expect([RETRY_BASE_MS, STALE_GRACE_MS]).toEqual([MIN, 5 * MIN]);
      expect([1, 2, 3].map(retryDelayMs)).toEqual([MIN, 4 * MIN, 16 * MIN]);
      const channel = await seedChannel(server, workspaceId, { name: "fall", members: [ana] });
      const routine = await newRoutine({
        target: { kind: "channel", channelId: channel },
        policy: { retries: 3, pauseAfterFailures: 1, maxMinutes: 30 },
        nextFireAt: new Date(Date.now() + 24 * 60 * MIN),
      });
      const reg = await registerFire(server.deps, routine.id, { trigger: "webhook", key: "webhook:fall" });
      if (reg.duplicate) throw new Error("duplicate");
      let clock = Date.now();
      const delays: number[] = [];
      let current = reg.run;
      for (let attempt = 1; attempt <= 4; attempt++) {
        // The execution began (as `startRoutineRun` saves it) and the server fell.
        const startedAt = new Date(clock);
        const deadlineAt = new Date(clock + 30 * MIN);
        await server.deps.db
          .update(routineExecutions)
          .set({ status: "running", startedAt, deadlineAt })
          .where(eq(routineExecutions.id, current.id));
        await server.deps.db
          .update(routines)
          .set({ runningSince: startedAt, runningUntil: deadlineAt })
          .where(eq(routines.id, routine.id));
        // Within the grace it is still running.
        const early = observed(new Date(deadlineAt.getTime() + STALE_GRACE_MS - 1000));
        await drainQueues(early.deps);
        expect(await early.failures()).toEqual([]);
        expect((await executionsOf(routine.id)).find((r) => r.id === current.id)?.status).toBe("running");
        const at = new Date(deadlineAt.getTime() + STALE_GRACE_MS + 1000);
        const watch = observed(at);
        await drainQueues(watch.deps);
        expect(await watch.failures()).toEqual([]);
        const rows = await executionsOf(routine.id);
        expect(rows.find((r) => r.id === current.id)).toMatchObject({
          status: "failed",
          reason: "interrupted",
        });
        expect((await routineRow(routine.id)).runningSince).toBeNull();
        const next = rows.find((r) => r.attempt === attempt + 1);
        if (attempt === 4) {
          expect(next).toBeUndefined();
          break;
        }
        expect(next).toMatchObject({ status: "queued", trigger: "retry", retryOf: reg.run.id });
        expect(rows.find((r) => r.id === current.id)?.retried).toBe(true);
        const delay = (next?.notBefore?.getTime() ?? 0) - at.getTime();
        delays.push(delay);
        if (!next) throw new Error("no retry");
        current = next;
        clock = at.getTime() + delay;
      }
      expect(delays).toEqual([MIN, 4 * MIN, 16 * MIN]);
      const alerts = await server.deps.db
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.kind, "routine_alert"), eq(notifications.groupKey, `routine:${routine.id}`)),
        );
      expect(alerts.map((n) => n.userId)).toEqual([ana.user.id]);
      expect(await routineRow(routine.id)).toMatchObject({
        active: false,
        pausedReason: "failures",
        nextFireAt: null,
      });
    },
    SERVER_TEST_MS,
  );
});

describe("the schedule", () => {
  test(
    "N ticks at once record one execution per time and move the next time once",
    async () => {
      const slot = new Date(Date.now() - 10 * MIN);
      const routine = await newRoutine({
        trigger: { kind: "schedule", rule: { freq: "hourly", timezone: "UTC" } },
        nextFireAt: slot,
        createdAt: new Date(slot.getTime() - 60 * MIN),
      });
      const watch = observed();
      const started = await Promise.all(Array.from({ length: 4 }, () => dueRoutines(watch.deps)));
      await watch.failures();
      expect(started.reduce((a, b) => a + b, 0)).toBe(1);
      const rows = await executionsOf(routine.id);
      expect(rows.map((r) => [r.trigger, r.scheduledFor?.getTime()])).toEqual([["schedule", slot.getTime()]]);
      expect((await routineRow(routine.id)).nextFireAt?.getTime()).toBeGreaterThan(Date.now());
    },
    SERVER_TEST_MS,
  );

  test(
    "times missed while the server was off become one `missed` with the count; the latest runs late or is skipped",
    async () => {
      const at = new Date("2026-11-14T12:30:00Z");
      const created = new Date("2026-11-14T06:00:00Z");
      const hourly = { kind: "schedule", rule: { freq: "hourly", timezone: "UTC" } };
      const routine = await newRoutine({
        trigger: hourly,
        nextFireAt: new Date("2026-11-14T08:00:00Z"),
        createdAt: created,
      });
      const watch = observed(at);
      await dueRoutines(watch.deps);
      await watch.failures();
      const rows = await executionsOf(routine.id);
      expect(rows.map((r) => [r.status, r.reason, r.summaryVars, r.scheduledFor?.toISOString()])).toEqual([
        ["skipped", "missed", { count: 4 }, "2026-11-14T11:00:00.000Z"],
        ["ok", null, expect.not.objectContaining({ lateMin: expect.anything() }), "2026-11-14T12:00:00.000Z"],
      ]);
      expect((await routineRow(routine.id)).nextFireAt?.toISOString()).toBe("2026-11-14T13:00:00.000Z");

      // "Once", two hours late: run once with the delay under the default, skipped under `skip`.
      const onceAt = new Date(at.getTime() - 120 * MIN);
      const once = { kind: "once", at: onceAt.toISOString(), timezone: "UTC" };
      const late = await newRoutine({ trigger: once, nextFireAt: onceAt });
      const skipped = await newRoutine({ trigger: once, nextFireAt: onceAt, policy: { missed: "skip" } });
      const tooOld = new Date(at.getTime() - CATCH_UP_MAX_MS - MIN);
      const ancient = await newRoutine({
        trigger: { ...once, at: tooOld.toISOString() },
        nextFireAt: tooOld,
      });
      const again = observed(at);
      await dueRoutines(again.deps);
      await again.failures();
      expect((await executionsOf(late.id)).map((r) => [r.status, r.summaryVars?.lateMin])).toEqual([
        ["ok", 120],
      ]);
      expect((await executionsOf(skipped.id)).map((r) => [r.status, r.reason])).toEqual([
        ["skipped", "missed"],
      ]);
      expect((await executionsOf(ancient.id)).map((r) => [r.status, r.reason])).toEqual([
        ["skipped", "missed"],
      ]);
      // Without a next time the routine turns itself off.
      for (const r of [late, skipped, ancient])
        expect(await routineRow(r.id)).toMatchObject({ active: false, nextFireAt: null });
    },
    SERVER_TEST_MS,
  );

  test(
    "the window: a time missed by less than `missedWindowMin` runs, by more is late",
    async () => {
      const at = new Date("2026-11-20T12:00:00Z");
      const onceAt = new Date(at.getTime() - 59 * MIN);
      const routine = await newRoutine({
        trigger: { kind: "once", at: onceAt.toISOString(), timezone: "UTC" },
        nextFireAt: onceAt,
        policy: { missed: "skip", missedWindowMin: 60 },
      });
      const watch = observed(at);
      await dueRoutines(watch.deps);
      await watch.failures();
      expect((await executionsOf(routine.id)).map((r) => [r.status, r.summaryVars?.lateMin])).toEqual([
        ["ok", undefined],
      ]);
    },
    SERVER_TEST_MS,
  );
});

describe("events", () => {
  test(
    "an event fires the workspace's active routines of that event once per event id",
    async () => {
      const event = { kind: "event", event: "issue.created" };
      const on = await newRoutine({ trigger: event });
      const off = await newRoutine({ trigger: event, active: false });
      const other = await newRoutine({ trigger: { kind: "event", event: "debate.concluded" } });
      const watch = observed();
      const fire = () =>
        fireRoutineEvent(watch.deps, {
          workspaceId,
          event: "issue.created",
          eventId: "iss_1",
          context: "Issue #1",
        });
      await Promise.all([fire(), fire(), fire()]);
      await watch.failures();
      expect((await executionsOf(on.id)).map((r) => [r.trigger, r.dedupeKey, r.status, r.payload])).toEqual([
        ["event", "event:issue.created:iss_1", "ok", { text: "Issue #1" }],
      ]);
      expect(await executionsOf(off.id)).toEqual([]);
      expect(await executionsOf(other.id)).toEqual([]);
      await fireRoutineEvent(watch.deps, {
        workspaceId: "ws_other",
        event: "issue.created",
        eventId: "iss_2",
        context: "",
      });
      expect(await executionsOf(on.id)).toHaveLength(1);
      await server.deps.db.update(routines).set({ active: false }).where(eq(routines.id, on.id));
      await server.deps.db.update(routines).set({ active: false }).where(eq(routines.id, other.id));
      await watch.failures();
    },
    SERVER_TEST_MS,
  );
});

describe("what the screen sees", () => {
  test(
    "the webhook's address carries the hook id and never the secret",
    async () => {
      const routine = await newRoutine({ hookId: "hook_public", webhookSecret: "sealed-secret-value" });
      const url = webhookUrl(server.deps, routine);
      expect(url).toBe(`${server.deps.config.publicUrl}/api/v1/hooks/routines/hook_public`);
      expect(url).not.toContain("secret");
      const [view] = await toRoutines(server.deps, [routine]);
      expect(view).toMatchObject({ webhookUrl: url, webhookHasSecret: true });
      expect(JSON.stringify(view)).not.toContain("sealed-secret-value");
      expect(
        webhookUrl(
          server.deps,
          await newRoutine({ hookId: "hook_x", trigger: { kind: "event", event: "issue.created" } }),
        ),
      ).toBeNull();
    },
    SERVER_TEST_MS,
  );

  test(
    "a saved trigger or target that doesn't pass its schema is rejected, not trusted",
    async () => {
      const bad = await newRoutine({ trigger: { kind: "schedule", rule: { freq: "secondly" } } });
      await expect(toRoutines(server.deps, [bad])).rejects.toThrow("invalid trigger");
      const target = await newRoutine({ target: { kind: "spreadsheet" } });
      await expect(toRoutines(server.deps, [target])).rejects.toThrow("invalid target");
    },
    SERVER_TEST_MS,
  );

  test(
    "who sees a routine: its creator, an admin, and whoever reads its channel or sees the Drive and the debates",
    async () => {
      const privateCh = await seedChannel(server, workspaceId, {
        name: "secret",
        visibility: "private",
        members: [ana],
      });
      const inChannel = await newRoutine({ target: { kind: "channel", channelId: privateCh } });
      const file = await newRoutine({ target: { kind: "file" } });
      const asBob = { workspaceId, userId: bob.user.id, role: "member" as const, handle: "bob" };
      const asAdmin = { ...asBob, role: "admin" as const };
      const asAna = { workspaceId, userId: ana.user.id, role: "member" as const, handle: "ana" };
      expect(await canSeeRoutine(server.deps, asBob, inChannel)).toBe(false);
      expect(await canSeeRoutine(server.deps, asAdmin, inChannel)).toBe(true);
      expect(await canSeeRoutine(server.deps, asAna, inChannel)).toBe(true);
      expect(await canSeeRoutine(server.deps, asBob, file)).toBe(true);
      expect(await canSeeRoutine(server.deps, asBob, await newRoutine())).toBe(true);
    },
    SERVER_TEST_MS,
  );
});
