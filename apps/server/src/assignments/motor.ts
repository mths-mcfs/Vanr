// The assignment engine. One loop per assignment with three fixed steps:
//
//   next  reads our tables and returns ONE action (decide(), pure);
//   act   runs the action idempotently (it checks the database before acting);
//   recv  waits for a wake or the deadline (a decision, the agent's timer, the assignment's due date, 6 h at most).
//
// All the behavior lives in the body of the steps: changing the code doesn't change the workflow's shape, so
// there is no DBOS.patch (rule 3 in durable.ts). On Postgres the loop is a DBOS workflow (`assignment`, ID
// `asg:<id>`): if the process dies, DBOS resumes from the last recorded step. On PGlite (dev and most tests) the
// same loop runs in memory and the boot recreates it: the state is in the tables, so it converges.
//
// Key of the work: (assignment, item, attempt) in `assignment_work`. A repeated step finds the row and doesn't
// send again: the effect (the agent's turn, the job on the runner) goes out only after the step claims the row,
// and the job on the runner carries an id derived from the key, which the runner rejects when repeated.

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AssignmentLimitKind, AssignmentUsage, AssignmentWaitReason } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, gt, inArray, isNotNull, isNull, lt, max, ne, sql } from "drizzle-orm";
import { channelInWorkspace } from "../channels";
import type { AppDeps } from "../context";
import { launchDurable } from "../durable";
import { HttpError } from "../http";
import { log } from "../logger";
import { postMessage } from "../messages";
import { assignmentUsage, ceilingState, type LimitKind } from "./budget";
import { type AssignmentRow, agentOf, agentSays, isClosed, moveAssignment, publishAssignment } from "./core";
import {
  announceCommand,
  announceSubmission,
  cancelJobs,
  createSubmission,
  jobEnded,
  notifyOwner,
  settleJob,
  startAssignmentJob,
} from "./engine";
import { assignmentEvent, SYSTEM } from "./events";
import { fixIdOf, jobIdOf, workIdOf } from "./keys";
import { groupOf, importLegacyPlan, type PlanItemRow, planOf, writePlan } from "./plan";
import { proofsOf } from "./proofs";
import { isStale, lastActivityOf, MAX_ROUNDS, MAX_TURNS, STALE_MS, type StateItem } from "./state";
import { modelVerifier, type VerifyItem } from "./verify";

const {
  assignments,
  assignmentWork,
  assignmentEvents,
  assignmentDecisions,
  assignmentReviews,
  assignmentCommands,
  assignmentSubmissions,
  assignmentPlanItems,
  runnerJobs,
  messages,
} = schema;

type AssignmentLimits = schema.AssignmentLimits;

const WORKING_WAIT_MS = 10 * 60_000;
/** A job that ended and nobody processed in 2 min (the server died in the middle): the engine processes it. */
const SETTLE_GRACE_MS = 2 * 60_000;
/**
 * A work row claimed and not yet bound to its run or job: the step that claimed it is still sending (posting the
 * turn, writing the files to the runner). Past this it counts as a step that died and gets reaped.
 */
const CLAIM_GRACE_MS = 2 * 60_000;
const RETRY_WAIT_MS = 5 * 60_000;
const MAX_WAIT_MS = 6 * 3600_000;
/** After a halt the cancels land a moment later: the next look is this far off. */
const HALT_WAIT_MS = 5_000;
/** Refusals of a job that come before anything reached the runner: the item's turn didn't happen. */
const BEFORE_SEND = new Set([
  "runner.offline",
  "assignment.needs_environment",
  "assignment.personal_plan",
  "assignment.job_running",
  "assignment.closed",
  "assignment.no_job",
]);

/** The cap a limit stops at, as the assignment row and the API name it (`dollars` is the `usd` cap). */
const ceilingOf = (k: LimitKind): AssignmentLimitKind => (k === "dollars" ? "usd" : k);
const limitOf = (c: AssignmentLimitKind): LimitKind => (c === "usd" ? "dollars" : c);

// ---- actions ----

export type EngineAction =
  | { type: "end" }
  | { type: "wait"; reason: AssignmentWaitReason; until: string | null }
  | { type: "ceiling"; which: LimitKind }
  | { type: "warn"; which: LimitKind }
  | { type: "deadline"; decisionId: string }
  | { type: "overdue" }
  | { type: "stale"; since: string }
  | { type: "reap"; workId: string }
  /** The assignment is paused or closed but a run or a job of it still goes on: stop them. */
  | { type: "halt" }
  /** A command or a submission waits for a person without its card (a crash between the row and the card). */
  | { type: "announce" }
  /** A job ended (or never left the server) and nobody processed its end: process it now. */
  | { type: "settle"; jobId: string }
  | { type: "plan" }
  | { type: "seed" }
  | { type: "work"; itemId: string; n: number }
  | { type: "stuck"; itemId: string; why: "turns" | "rounds" }
  | { type: "validate"; itemIds: string[]; round: number }
  | { type: "submit" };

type SnapItem = StateItem & Pick<PlanItemRow, "id" | "title" | "milestone" | "fixes">;

/** What `next` reads. Real dates (the snapshot doesn't leave the step; only the action is recorded). */
export interface Snapshot {
  status: AssignmentRow["status"];
  executor: AssignmentRow["executor"];
  ceiling: AssignmentRow["ceiling"];
  limits: AssignmentLimits;
  usage: Pick<AssignmentUsage, LimitKind>;
  dueAt: Date | null;
  wakeAt: Date | null;
  items: SnapItem[];
  /** Work that didn't end and whether it is still alive (a run on the air, a job running). */
  open: { id: string; live: boolean }[];
  /** The highest attempt already sent per item ("" is the planning turn). */
  lastN: Record<string, number>;
  /** A conversation or a job running on the assignment (a person's or the agent's own). */
  busy: boolean;
  person: { decisions: { id: string; deadlineAt: Date | null }[]; others: number; submission: boolean };
  lastActivity: Date | null;
  /** Keys (without the assignment's prefix) of the notices that go out only once. */
  emitted: string[];
  /** A pending command or submission with no card past the claim grace. */
  unannounced: boolean;
  /** When the grace of the first card-less one still within it runs out. */
  announceAt: Date | null;
  /** Jobs whose end nobody processed past the grace, or that never reached the runner. */
  unsettled: string[];
  /** A run in the thread or a job on the runner still going on. */
  stray: boolean;
}

const warnKey = (k: LimitKind, limit: number | null) => `warn:${k}:${limit}`;
const overdueKey = (dueAt: Date) => `overdue:${dueAt.toISOString()}`;
const staleKey = (since: Date) => `stale:${since.toISOString()}`;

function groupsOf(items: SnapItem[]): SnapItem[][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const order: SnapItem[][] = [];
  const byGroup = new Map<string, SnapItem[]>();
  for (const i of items) {
    const g = groupOf(i, byId);
    let list = byGroup.get(g);
    if (!list) {
      list = [];
      byGroup.set(g, list);
      order.push(list);
    }
    list.push(i);
  }
  return order;
}

/** The next action, from the snapshot alone. Pure: the tests call it directly. */
export function decide(s: Snapshot, now: Date): EngineAction {
  const t = now.getTime();
  // The next time something comes due on its own (the due date, the assignment going quiet): the wait wakes then.
  const soon = (base: number | null): string | null => {
    const marks = [base ?? t + MAX_WAIT_MS];
    // Kept even when already past (the snapshot's queries ran past it): the wait is then the 1 s floor.
    if (s.announceAt) marks.push(s.announceAt.getTime());
    if (s.dueAt && s.dueAt > now && !s.emitted.includes(overdueKey(s.dueAt))) marks.push(s.dueAt.getTime());
    if (s.status === "active" && s.lastActivity) {
      const staleAt = s.lastActivity.getTime() + STALE_MS + 1000;
      if (staleAt > t) marks.push(staleAt);
    }
    return new Date(Math.min(...marks)).toISOString();
  };
  const wait = (reason: AssignmentWaitReason, until: number | null = null): EngineAction => ({
    type: "wait",
    reason,
    until: soon(until),
  });

  // Stopped (paused or closed) while a run or a job still went on, e.g. a pause whose cancel failed halfway.
  if ((s.status === "done" || s.status === "canceled" || s.status === "paused") && s.stray)
    return { type: "halt" };
  if (s.status === "done" || s.status === "canceled") return { type: "end" };
  if (s.status === "proposed") return { type: "wait", reason: "proposed", until: null };
  if (s.unannounced) return { type: "announce" };
  const unsettled = s.unsettled[0];
  if (unsettled) return { type: "settle", jobId: unsettled };
  if (s.status === "paused")
    return {
      type: "wait",
      reason: s.ceiling ? "ceiling" : "paused",
      until: s.announceAt?.toISOString() ?? null,
    };
  const dead = s.open.find((w) => !w.live);
  if (dead) return { type: "reap", workId: dead.id };
  if (s.ceiling) return { type: "ceiling", which: limitOf(s.ceiling) };
  const c = ceilingState(s.limits, s.usage);
  if (c.hit) return { type: "ceiling", which: c.hit };
  for (const k of c.warn) if (!s.emitted.includes(warnKey(k, s.limits[k]))) return { type: "warn", which: k };
  const late = s.person.decisions.find((d) => d.deadlineAt && d.deadlineAt <= now);
  if (late) return { type: "deadline", decisionId: late.id };
  if (s.dueAt && s.dueAt <= now && !s.emitted.includes(overdueKey(s.dueAt))) return { type: "overdue" };
  if (isStale(s, now) && s.lastActivity && !s.emitted.includes(staleKey(s.lastActivity)))
    return { type: "stale", since: s.lastActivity.toISOString() };
  if (s.open.length > 0 || s.busy) return wait("working", t + WORKING_WAIT_MS);
  if (s.person.submission) return wait("submission");
  if (
    s.person.decisions.length > 0 ||
    s.person.others > 0 ||
    s.items.some((i) => i.status === "blocked_on_you")
  ) {
    const deadlines = s.person.decisions.flatMap((d) => (d.deadlineAt ? [d.deadlineAt.getTime()] : []));
    return wait("person", deadlines.length ? Math.min(...deadlines) : null);
  }
  if (s.wakeAt && s.wakeAt > now) return wait("timer", s.wakeAt.getTime());
  if (s.status !== "active") return wait("idle");
  if (s.items.length === 0)
    return s.executor === "agent" && s.lastN[""] === undefined ? { type: "plan" } : { type: "seed" };
  const live = s.items.filter((i) => i.status !== "dropped");
  if (live.length === 0) return wait("idle");
  for (const group of groupsOf(live)) {
    const todo = group.find((i) => i.status !== "done");
    if (todo) {
      if (todo.turns >= MAX_TURNS) return { type: "stuck", itemId: todo.id, why: "turns" };
      return { type: "work", itemId: todo.id, n: (s.lastN[todo.id] ?? 0) + 1 };
    }
    const judge = group.filter((i) => i.kind !== "fix" && i.passes !== true);
    if (judge.length) {
      const round = Math.max(...judge.map((i) => i.checks)) + 1;
      const first = judge[0] as SnapItem;
      if (round > MAX_ROUNDS) return { type: "stuck", itemId: first.id, why: "rounds" };
      return { type: "validate", itemIds: judge.map((i) => i.id), round };
    }
  }
  // Only fix items left (the person removed what they fix): nothing to submit until the plan changes.
  if (!live.some((i) => i.kind !== "fix")) return wait("idle");
  return { type: "submit" };
}

// ---- reading (the next step) ----

export async function assignmentById(deps: Pick<AppDeps, "db">, id: string): Promise<AssignmentRow | null> {
  const [row] = await deps.db.select().from(assignments).where(eq(assignments.id, id));
  return row ?? null;
}

export async function snapshotOf(deps: AppDeps, row: AssignmentRow): Promise<Snapshot> {
  const { db } = deps;
  const items = await planOf(deps, row.id);
  const works = await db.select().from(assignmentWork).where(eq(assignmentWork.assignmentId, row.id));
  const jobs = await db
    .select({
      id: runnerJobs.id,
      status: runnerJobs.status,
      lastSignalAt: runnerJobs.lastSignalAt,
      endedAt: runnerJobs.endedAt,
      settledAt: runnerJobs.settledAt,
      createdAt: runnerJobs.createdAt,
    })
    .from(runnerJobs)
    .where(eq(runnerJobs.assignmentId, row.id));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const now = deps.now().getTime();
  // Saved and never heard from past the grace: the server fell between the row and the send to the runner.
  const lost = (j: (typeof jobs)[number]) =>
    j.status === "queued" && j.lastSignalAt === null && now - j.createdAt.getTime() >= CLAIM_GRACE_MS;
  // Running, or ended a moment ago and the assignment still processes the end (cards, item): the engine waits.
  const live = (j: (typeof jobs)[number] | undefined) =>
    !!j &&
    ((j.status === "queued" && !lost(j)) ||
      j.status === "running" ||
      (j.status !== "queued" &&
        j.settledAt === null &&
        (j.endedAt === null || now - j.endedAt.getTime() < SETTLE_GRACE_MS)));
  const unsettled = jobs
    .filter(
      (j) => lost(j) || (j.status !== "queued" && j.status !== "running" && j.settledAt === null && !live(j)),
    )
    .map((j) => j.id);
  const lastN: Record<string, number> = {};
  const open: Snapshot["open"] = [];
  for (const w of works) {
    lastN[w.itemId] = Math.max(lastN[w.itemId] ?? 0, w.n);
    if (w.status === "ended") continue;
    const sending =
      w.status === "running" && w.refId === null && now - w.startedAt.getTime() < CLAIM_GRACE_MS;
    open.push({
      id: w.id,
      live:
        sending ||
        (w.kind === "task"
          ? live(jobById.get(w.refId ?? jobIdOf(w.id)))
          : w.refId !== null && deps.runtime.liveRun(w.refId) !== null),
    });
  }
  const runOnAir = deps.runtime.activeRun(row.agentId, row.channelId, row.threadId) !== null;
  const busy = runOnAir || jobs.some((j) => live(j));
  const stray = runOnAir || jobs.some((j) => (j.status === "queued" && !lost(j)) || j.status === "running");
  // A pending command or submission without its card: past the grace its creator died before posting it; before,
  // the creator is still posting, and the engine looks again when the grace runs out.
  const cardless = [
    ...(await db
      .select({ createdAt: assignmentCommands.createdAt })
      .from(assignmentCommands)
      .where(
        and(
          eq(assignmentCommands.assignmentId, row.id),
          eq(assignmentCommands.state, "pending"),
          isNull(assignmentCommands.messageId),
        ),
      )),
    ...(await db
      .select({ createdAt: assignmentSubmissions.createdAt })
      .from(assignmentSubmissions)
      .where(
        and(
          eq(assignmentSubmissions.assignmentId, row.id),
          eq(assignmentSubmissions.status, "pending"),
          isNull(assignmentSubmissions.messageId),
        ),
      )),
  ].map((r) => r.createdAt.getTime() + CLAIM_GRACE_MS);
  const unannounced = cardless.some((at) => at <= now);
  const announceAt = cardless.length && !unannounced ? new Date(Math.min(...cardless)) : null;
  const decisions = await db
    .select({ id: assignmentDecisions.id, deadlineAt: assignmentDecisions.deadlineAt })
    .from(assignmentDecisions)
    .where(
      and(
        eq(assignmentDecisions.assignmentId, row.id),
        eq(assignmentDecisions.status, "pending"),
        eq(assignmentDecisions.blocking, true),
      ),
    );
  const count = async (q: Promise<{ id: string }[]>) => (await q).length;
  const others =
    (await count(
      db
        .select({ id: assignmentReviews.id })
        .from(assignmentReviews)
        .where(and(eq(assignmentReviews.assignmentId, row.id), eq(assignmentReviews.status, "pending"))),
    )) +
    (await count(
      db
        .select({ id: assignmentCommands.id })
        .from(assignmentCommands)
        .where(and(eq(assignmentCommands.assignmentId, row.id), eq(assignmentCommands.state, "pending"))),
    ));
  const submission =
    (await count(
      db
        .select({ id: assignmentSubmissions.id })
        .from(assignmentSubmissions)
        .where(
          and(eq(assignmentSubmissions.assignmentId, row.id), eq(assignmentSubmissions.status, "pending")),
        ),
    )) > 0;
  const usage = await assignmentUsage(deps, row);
  const emitted = (
    await db
      .select({ key: assignmentEvents.key })
      .from(assignmentEvents)
      .where(
        and(
          eq(assignmentEvents.assignmentId, row.id),
          inArray(assignmentEvents.kind, ["ceiling_warning", "overdue", "stale"]),
        ),
      )
  ).flatMap((e) => (e.key?.startsWith(`${row.id}:`) ? [e.key.slice(row.id.length + 1)] : []));
  return {
    status: row.status,
    executor: row.executor,
    ceiling: row.ceiling,
    limits: row.limits,
    usage,
    dueAt: row.dueAt,
    wakeAt: row.wakeAt,
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      passes: i.passes,
      checks: i.checks,
      turns: i.turns,
      milestone: i.milestone,
      fixes: i.fixes,
      kind: i.kind,
    })),
    open,
    lastN,
    busy,
    person: { decisions, others, submission },
    lastActivity: await lastActivityOf(deps, row, jobs),
    emitted,
    unannounced,
    announceAt,
    unsettled,
    stray,
  };
}

// ---- running (the act step) ----

/** What a person did unblocks the item: it resets the turns of the open ones (and moves the epoch). */
export async function resetTurns(deps: AppDeps, assignmentId: string): Promise<void> {
  await deps.db
    .update(assignmentPlanItems)
    .set({ turns: 0, epoch: sql`${assignmentPlanItems.epoch} + 1` })
    .where(
      and(
        eq(assignmentPlanItems.assignmentId, assignmentId),
        inArray(assignmentPlanItems.status, ["todo", "doing"]),
        gt(assignmentPlanItems.turns, 0),
      ),
    );
}

const waitMs = (until: string | null, now: Date) =>
  until === null
    ? MAX_WAIT_MS
    : Math.min(MAX_WAIT_MS, Math.max(1000, new Date(until).getTime() - now.getTime()));

async function setWait(deps: AppDeps, row: AssignmentRow, reason: AssignmentWaitReason): Promise<void> {
  if (row.waitReason === reason) return;
  const [next] = await deps.db
    .update(assignments)
    .set({ waitReason: reason })
    .where(eq(assignments.id, row.id))
    .returning();
  if (next) publishAssignment(deps, next, "status");
}

/** Stops the assignment (a cap, the agent's budget, a personal plan): pauses, stops what runs and tells. */
async function pauseFor(
  deps: AppDeps,
  row: AssignmentRow,
  set: Partial<typeof assignments.$inferInsert>,
  text: string,
  data: Record<string, unknown>,
): Promise<void> {
  const next = await moveAssignment(
    deps,
    row,
    ["active", "wrapping_up"],
    { status: "paused", pausedAt: deps.now(), ...set },
    "status",
  );
  if (!next) return;
  const run = deps.runtime.activeRun(row.agentId, row.channelId, row.threadId);
  if (run) deps.runtime.cancel(run, null);
  await cancelJobs(deps, row);
  await assignmentEvent(deps, row, { kind: set.ceiling ? "ceiling_hit" : "paused", actor: SYSTEM, data });
  await agentSays(deps, next, text, {
    assignmentReport: { assignmentId: row.id, text: text.slice(0, 2000) },
  });
  await notifyOwner(deps, next, "assignment_stopped", text, null);
}

export async function act(deps: AppDeps, assignmentId: string, a: EngineAction): Promise<number | null> {
  const row = await assignmentById(deps, assignmentId);
  if (!row || a.type === "end") return null;
  const now = deps.now();
  const key = (k: string) => `${row.id}:${k}`;
  switch (a.type) {
    case "wait":
      await setWait(deps, row, a.reason);
      return waitMs(a.until, now);

    case "ceiling": {
      const usage = await assignmentUsage(deps, row);
      // A cap raised since the decision: pause only if it is still hit (or a reservation was already rejected).
      if (!row.ceiling && ceilingState(row.limits, usage).hit !== a.which) return null;
      await pauseFor(
        deps,
        row,
        { ceiling: ceilingOf(a.which), waitReason: "ceiling" },
        `I stopped: this assignment reached its ${a.which} limit (${row.limits[a.which]}). Raise it to continue.`,
        { which: a.which, limit: row.limits[a.which], usage },
      );
      return null;
    }

    case "warn": {
      const limit = row.limits[a.which];
      const ev = await assignmentEvent(deps, row, {
        kind: "ceiling_warning",
        actor: SYSTEM,
        key: key(warnKey(a.which, limit)),
        data: { which: a.which, limit, usage: await assignmentUsage(deps, row) },
      });
      if (ev) await notifyOwner(deps, row, "assignment_stopped", `80% of the ${a.which} limit used`, null);
      return null;
    }

    case "deadline": {
      const [d] = await deps.db
        .select()
        .from(assignmentDecisions)
        .where(and(eq(assignmentDecisions.id, a.decisionId), eq(assignmentDecisions.assignmentId, row.id)));
      if (d?.status !== "pending" || !d.deadlineAt || d.deadlineAt > now) return null;
      // With a recommendation it goes on with it (provisional: the person confirms or changes it later).
      // Without one, it tells again.
      const [next] = await deps.db
        .update(assignmentDecisions)
        .set(d.recommendation ? { status: "provisional", chosen: d.recommendation } : { deadlineAt: null })
        .where(and(eq(assignmentDecisions.id, d.id), eq(assignmentDecisions.status, "pending")))
        .returning();
      if (!next) return null;
      await assignmentEvent(deps, row, {
        kind: "decision_deadline",
        actor: SYSTEM,
        data: { decisionId: d.id, question: d.question, chosen: d.recommendation },
      });
      publishAssignment(deps, row, "decision");
      if (!d.recommendation)
        await notifyOwner(deps, row, "assignment_stopped", `Deadline passed: ${d.question}`, d.messageId);
      return null;
    }

    case "overdue": {
      if (!row.dueAt || row.dueAt > now) return null;
      const ev = await assignmentEvent(deps, row, {
        kind: "overdue",
        actor: SYSTEM,
        key: key(overdueKey(row.dueAt)),
        data: { dueAt: row.dueAt.toISOString() },
      });
      if (ev) await notifyOwner(deps, row, "assignment_stopped", `Past the due date: ${row.title}`, null);
      return null;
    }

    case "stale": {
      const since = new Date(a.since);
      const ev = await assignmentEvent(deps, row, {
        kind: "stale",
        actor: SYSTEM,
        key: key(staleKey(since)),
        data: { since: a.since },
      });
      if (ev)
        await notifyOwner(deps, row, "assignment_stopped", `No news for 30 minutes: ${row.title}`, null);
      return null;
    }

    case "reap":
      await reap(deps, row, a.workId);
      return null;

    case "halt": {
      // Resumed since the decision: the run and the jobs are the resumed assignment's.
      if (row.status !== "paused" && !isClosed(row)) return null;
      const run = deps.runtime.activeRun(row.agentId, row.channelId, row.threadId);
      if (run) deps.runtime.cancel(run, null);
      await cancelJobs(deps, row);
      // The cancels land a moment later: look again shortly, not at once.
      return HALT_WAIT_MS;
    }

    case "announce":
      await announcePending(deps, row);
      return null;

    case "settle":
      await settleLost(deps, a.jobId);
      return null;

    case "seed": {
      const w = await writePlan(deps, row.id, {
        author: SYSTEM,
        mode: "append",
        items: [{ id: "goal", title: row.title, criteria: row.goal.slice(0, 2000) }],
        note: "seed",
      });
      if (w.added.length)
        await assignmentEvent(deps, row, {
          kind: "plan_edited",
          actor: SYSTEM,
          data: { version: w.version, added: w.added, removed: [], edited: [] },
        });
      publishAssignment(deps, row, "plan");
      return null;
    }

    case "plan":
      return dispatch(deps, row, "", 1);

    case "work":
      return dispatch(deps, row, a.itemId, a.n);

    case "stuck": {
      const items = await planOf(deps, row.id);
      const item = items.find((i) => i.id === a.itemId);
      if (!item) return null;
      const ev = await assignmentEvent(deps, row, {
        kind: "item_stuck",
        actor: SYSTEM,
        itemId: item.id,
        key: key(`stuck:${item.id}:${item.epoch}:${item.turns}:${item.checks}`),
        data: { why: a.why, turns: item.turns, checks: item.checks },
      });
      if (ev) await notifyOwner(deps, row, "assignment_stopped", `Stuck on ${item.title}`, null);
      await setWait(deps, row, "stuck");
      return MAX_WAIT_MS;
    }

    case "validate":
      return validate(deps, row, a.itemIds, a.round);

    case "submit":
      await submit(deps, row);
      return null;
  }
}

async function reap(deps: AppDeps, row: AssignmentRow, workId: string): Promise<void> {
  const [w] = await deps.db.select().from(assignmentWork).where(eq(assignmentWork.id, workId));
  if (!w || w.status === "ended") return;
  if (w.kind === "task") {
    const [j] = await deps.db
      .select()
      .from(runnerJobs)
      .where(eq(runnerJobs.id, w.refId ?? jobIdOf(w.id)));
    if (j?.status === "queued" && j.lastSignalAt === null) await settleLost(deps, j.id);
    // The end of a job the listener didn't process (the server died in the middle): process it now and close.
    else if (j && j.status !== "queued" && j.status !== "running") {
      await jobEnded(deps, j);
      await settleJob(deps, j);
      return;
    }
  }
  const [ended] = await deps.db
    .update(assignmentWork)
    .set({ status: "ended", outcome: "interrupted", endedAt: deps.now() })
    .where(and(eq(assignmentWork.id, w.id), ne(assignmentWork.status, "ended")))
    .returning();
  if (ended)
    await assignmentEvent(deps, row, {
      kind: "work_ended",
      actor: SYSTEM,
      itemId: w.itemId || null,
      key: `${row.id}:end:${w.id}`,
      data: { workId: w.id, n: w.n, outcome: "interrupted" },
    });
}

/** Posts the cards a crash left out: pending commands and submissions with no card past the claim grace. */
async function announcePending(deps: AppDeps, row: AssignmentRow): Promise<void> {
  const graceAgo = new Date(deps.now().getTime() - CLAIM_GRACE_MS);
  const commands = await deps.db
    .select()
    .from(assignmentCommands)
    .where(
      and(
        eq(assignmentCommands.assignmentId, row.id),
        eq(assignmentCommands.state, "pending"),
        isNull(assignmentCommands.messageId),
        lt(assignmentCommands.createdAt, graceAgo),
      ),
    );
  for (const cmd of commands) await announceCommand(deps, row, cmd);
  const submissions = await deps.db
    .select()
    .from(assignmentSubmissions)
    .where(
      and(
        eq(assignmentSubmissions.assignmentId, row.id),
        eq(assignmentSubmissions.status, "pending"),
        isNull(assignmentSubmissions.messageId),
        lt(assignmentSubmissions.createdAt, graceAgo),
      ),
    );
  for (const sub of submissions) await announceSubmission(deps, row, sub, row.status === "active");
}

/**
 * The end of a job nobody processed: one that ended while the server was down (a job the agent started has no work
 * row for `reap` to find), or one saved and never sent (the server fell between the row and the send), which is
 * canceled first so it stops holding the assignment's only job slot.
 */
async function settleLost(deps: AppDeps, jobId: string): Promise<void> {
  const [j] = await deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, jobId));
  if (!j || j.settledAt) return;
  if (j.status === "queued" && j.lastSignalAt === null) {
    const [canceled] = await deps.db
      .update(runnerJobs)
      .set({ status: "canceled", endedAt: deps.now() })
      .where(and(eq(runnerJobs.id, j.id), eq(runnerJobs.status, "queued"), isNull(runnerJobs.lastSignalAt)))
      .returning();
    if (!canceled) return;
    await jobEnded(deps, canceled);
    return;
  }
  if (j.status === "queued" || j.status === "running") return;
  await jobEnded(deps, j);
}

/** Gives the item back the turn a claim counted when the turn never went out (rejected before the send, paused). */
async function refundTurn(deps: AppDeps, assignmentId: string, itemId: string): Promise<void> {
  if (!itemId) return;
  await deps.db
    .update(assignmentPlanItems)
    .set({ turns: sql`${assignmentPlanItems.turns} - 1` })
    .where(
      and(
        eq(assignmentPlanItems.assignmentId, assignmentId),
        eq(assignmentPlanItems.id, itemId),
        gt(assignmentPlanItems.turns, 0),
      ),
    );
}

/**
 * Claims the work for this step: under the row's lock, a work row still `starting` becomes `running` and the
 * item gets its turn, once. Whoever finds it already claimed sends nothing: the effect (the agent's turn, the
 * job) goes out once per row even with two loops on the same assignment (a fork while the old workflow still
 * runs its step). The assignment must still be active: a step decided before a pause, a cancel or the end claims
 * nothing. A crash after the claim leaves the row running with no ref; the next step reaps it and the item goes to
 * its next attempt.
 */
async function claimWork(deps: AppDeps, workId: string, item: PlanItemRow | null): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [w] = await tx.select().from(assignmentWork).where(eq(assignmentWork.id, workId)).for("update");
    if (w?.status !== "starting") return false;
    // Decided while active, acted after a pause, a cancel or the end: the turn doesn't go out.
    const [a] = await tx
      .select({ status: assignments.status })
      .from(assignments)
      .where(eq(assignments.id, w.assignmentId));
    if (a?.status !== "active") {
      await tx
        .update(assignmentWork)
        .set({ status: "ended", outcome: "canceled", endedAt: deps.now() })
        .where(eq(assignmentWork.id, workId));
      return false;
    }
    if (item) {
      // Only an item still open: one the person (or the executor) finished or dropped since the decision isn't
      // reopened by its old turn.
      const [turned] = await tx
        .update(assignmentPlanItems)
        .set({ status: "doing", turns: sql`${assignmentPlanItems.turns} + 1`, updatedAt: deps.now() })
        .where(
          and(
            eq(assignmentPlanItems.assignmentId, w.assignmentId),
            eq(assignmentPlanItems.id, item.id),
            inArray(assignmentPlanItems.status, ["todo", "doing", "blocked_on_you"]),
          ),
        )
        .returning({ id: assignmentPlanItems.id });
      if (!turned) {
        await tx
          .update(assignmentWork)
          .set({ status: "ended", outcome: "canceled", endedAt: deps.now() })
          .where(eq(assignmentWork.id, workId));
        return false;
      }
    }
    await tx.update(assignmentWork).set({ status: "running" }).where(eq(assignmentWork.id, workId));
    return true;
  });
}

/** The agent's turn (or a job on the runner) for the item. Idempotent by the work's key. */
async function dispatch(
  deps: AppDeps,
  row: AssignmentRow,
  itemId: string,
  n: number,
): Promise<number | null> {
  const { db } = deps;
  const now = deps.now();
  const id = workIdOf(row.id, itemId, n);
  const kind = itemId === "" ? "plan" : row.executor === "agent" ? "run" : "task";
  await db
    .insert(assignmentWork)
    .values({ id, assignmentId: row.id, itemId, n, kind, status: "starting", startedAt: now })
    .onConflictDoNothing();
  const [w] = await db.select().from(assignmentWork).where(eq(assignmentWork.id, id));
  if (!w || w.status === "ended") return null;
  const end = async (outcome: "failed" | "canceled") => {
    await db
      .update(assignmentWork)
      .set({ status: "ended", outcome, endedAt: deps.now() })
      .where(and(eq(assignmentWork.id, id), ne(assignmentWork.status, "ended")));
  };
  // The item still exists and isn't done (the person may have taken it out of the plan meanwhile).
  const items = itemId ? await planOf(deps, row.id) : [];
  const item = items.find((i) => i.id === itemId) ?? null;
  if (itemId && (!item || item.status === "done" || item.status === "dropped")) {
    await end("canceled");
    return null;
  }
  // Already sent (the step ran again after sending): it only checks.
  if (w.refId) {
    const live =
      kind === "task"
        ? ["queued", "running"].includes(
            (await db.select().from(runnerJobs).where(eq(runnerJobs.id, w.refId)))[0]?.status ?? "",
          )
        : deps.runtime.liveRun(w.refId) !== null;
    if (!live) await end("canceled");
    return null;
  }
  if (!(await claimWork(deps, id, item))) return null;
  if (row.wakeAt) await db.update(assignments).set({ wakeAt: null }).where(eq(assignments.id, row.id));
  await assignmentEvent(deps, row, {
    kind: "item_started",
    actor: SYSTEM,
    itemId: itemId || null,
    key: `${row.id}:start:${id}`,
    data: { workId: id, n, kind, title: item?.title ?? null },
  });
  publishAssignment(deps, row, "plan");

  // Still this attempt's to send (another loop may have reaped it), the item still open, the assignment active.
  const sendable = async () => {
    const [still] = await db
      .select({ status: assignmentWork.status })
      .from(assignmentWork)
      .where(eq(assignmentWork.id, id));
    if (still?.status === "ended") return false;
    if (item) {
      const [current] = await db
        .select({ status: assignmentPlanItems.status })
        .from(assignmentPlanItems)
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, item.id)));
      if (current?.status === "done" || current?.status === "dropped") {
        await end("canceled");
        return false;
      }
    }
    const fresh = await assignmentById(deps, row.id);
    if (fresh?.status !== "active") {
      await end("canceled");
      await refundTurn(deps, row.id, itemId);
      return false;
    }
    return true;
  };

  if (kind === "task" && item) {
    try {
      if (!(await sendable())) return null;
      const job = await startAssignmentJob(deps, row, {
        id: jobIdOf(id),
        planItemId: item.id,
        title: item.title,
        extra: await itemBrief(deps, row, item, items, w.startedAt),
      });
      const [bound] = await db
        .update(assignmentWork)
        .set({ refId: job.id })
        .where(and(eq(assignmentWork.id, id), ne(assignmentWork.status, "ended")))
        .returning();
      // Reaped while the job was being started: the job doesn't go on for an attempt that no longer counts.
      if (!bound) await cancelJobs(deps, row, job.id);
      return null;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      await end("failed");
      // Rejected before anything reached the runner (offline, no runner): the item keeps its turn.
      if (BEFORE_SEND.has(err.code)) await refundTurn(deps, row.id, item.id);
      // Another job already runs (a person asked for something): wait for it. Runner offline: try again later.
      if (err.code === "assignment.job_running") return null;
      await assignmentEvent(deps, row, {
        kind: "work_ended",
        actor: SYSTEM,
        itemId: item.id,
        data: { workId: id, n, outcome: "failed", code: err.code, error: err.message },
      });
      return RETRY_WAIT_MS;
    }
  }

  const channel = await channelInWorkspace(db, row.workspaceId, row.channelId);
  if (!channel) {
    await end("failed");
    return null;
  }
  const agent = await agentOf(db, row);
  const text = item ? await itemBrief(deps, row, item, items, w.startedAt) : planBrief(row);
  if (!(await sendable())) return null;
  const { message } = await postMessage(deps, {
    workspaceId: row.workspaceId,
    channel,
    author: { type: "person", id: row.ownerId },
    body: text,
    clientId: id,
    threadId: row.threadId,
    meta: {
      assignmentTurn: { assignmentId: row.id, itemId, n },
      ...(itemId === "" ? { assignmentStart: { assignmentId: row.id } } : {}),
    },
  });
  const [trigger] = await db.select().from(messages).where(eq(messages.id, message.id));
  if (!trigger) {
    await end("failed");
    return null;
  }
  // The last check before the turn goes out: an attempt another loop reaped meanwhile, or an assignment paused,
  // canceled or done meanwhile, sends nothing. The fence turns away this turn if a later attempt already went.
  if (!(await sendable())) return null;
  const fence = { key: `${row.id}:${itemId}`, token: n };
  const res = await deps.runtime.runFor({ agent, channel, trigger, fence });
  if (!res.ok && res.code === "fenced") {
    await end("canceled");
    return null;
  }
  if (!res.ok) {
    await end("failed");
    await pauseFor(
      deps,
      row,
      { waitReason: "paused" },
      res.code === "budget"
        ? `I stopped: ${agent.name} is out of budget this month.`
        : `I stopped: ${agent.name} thinks with the personal plan of who paired its runner and only works for that person.`,
      { why: res.code },
    );
    return null;
  }
  const [bound] = await db
    .update(assignmentWork)
    .set({ refId: res.runId })
    .where(and(eq(assignmentWork.id, id), ne(assignmentWork.status, "ended")))
    .returning();
  // The attempt was reaped while this step was still sending: its turn doesn't go on.
  // A run another attempt holds (the message went into a run already live) is left alone.
  if (!bound) {
    const [owner] = await db
      .select({ id: assignmentWork.id })
      .from(assignmentWork)
      .where(eq(assignmentWork.refId, res.runId));
    // Fenced: if a later attempt already went into the same run, the run is that attempt's and stays.
    if (!owner) deps.runtime.cancel(res.runId, null, fence);
  }
  return null;
}

function planBrief(row: AssignmentRow): string {
  return [
    `▶ ${row.goal}`,
    "Plan this assignment with update_plan: small deliverables, each with a done criterion a reviewer can check, and a milestone when several go together. You can start the first item in this same turn.",
    "Mark an item done with finish_item (summary and proofs). Only the verifier marks it as passed.",
  ].join("\n\n");
}

/** What the executor gets to work on the item: the criterion, the previous verdict and what changed since its last turn. */
async function itemBrief(
  deps: AppDeps,
  row: AssignmentRow,
  item: PlanItemRow,
  items: PlanItemRow[],
  startedAt: Date,
): Promise<string> {
  // "Since your last turn": after the start of the previous work that went out (a decision taken, a job that
  // ended). From its start, not its end: a job the agent started in that turn can end before the turn does. An
  // attempt refused before the send (no run or job behind it) isn't a turn the agent heard.
  const [prev] = await deps.db
    .select({ at: max(assignmentWork.startedAt) })
    .from(assignmentWork)
    .where(
      and(
        eq(assignmentWork.assignmentId, row.id),
        eq(assignmentWork.status, "ended"),
        isNotNull(assignmentWork.refId),
      ),
    );
  const since = prev?.at ?? row.startedAt ?? startedAt;
  const decided = await deps.db
    .select()
    .from(assignmentDecisions)
    .where(and(eq(assignmentDecisions.assignmentId, row.id), gt(assignmentDecisions.selectedAt, since)));
  const ended = await deps.db
    .select()
    .from(runnerJobs)
    .where(and(eq(runnerJobs.assignmentId, row.id), gt(runnerJobs.endedAt, since)));
  const target = item.fixes ? items.find((i) => i.id === item.fixes) : undefined;
  const news = [
    ...decided.map(
      (d) => `- Decision "${d.question}" → ${d.chosen}${d.status === "provisional" ? " (provisional)" : ""}`,
    ),
    ...ended.map((j) => `- Job "${j.title}" ${j.status}${j.result ? `: ${j.result.slice(0, 1500)}` : ""}`),
  ];
  return [
    `Work on ${item.id}: ${item.title}`,
    target
      ? `This fixes ${target.id} (${target.title}). The verifier said: ${item.criteria}`
      : `Done when: ${item.criteria || item.title}`,
    item.passes === false && item.verdict ? `Last verdict: ${item.verdict}` : "",
    news.length ? `Since your last turn:\n${news.join("\n")}` : "",
    row.executor === "agent"
      ? "When it is done, call finish_item with a short summary and proofs (diff, test log, screenshot or preview). If the team must choose, use ask_decision and end the turn."
      : "When you finish, answer with a short summary of what changed and how to check it.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A milestone's validation by a clean-context agent; a failed item becomes a fix item. */
async function validate(
  deps: AppDeps,
  row: AssignmentRow,
  itemIds: string[],
  round: number,
): Promise<number | null> {
  const items = await planOf(deps, row.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const targets = itemIds
    .map((id) => byId.get(id))
    .filter((i): i is PlanItemRow => !!i && i.status === "done" && i.passes !== true);
  if (targets.length === 0) return null;
  // The evidence of the item and of its fixes (the verifier judges the original item).
  const rootOf = (i: PlanItemRow): string => {
    let cur = i;
    for (let hops = 0; hops < 20 && cur.fixes; hops++) {
      const parent = byId.get(cur.fixes);
      if (!parent) break;
      cur = parent;
    }
    return cur.id;
  };
  const familyOf = (t: PlanItemRow) =>
    items.filter((i) => i.id === t.id || (i.kind === "fix" && rootOf(i) === t.id));
  const proofs = await proofsOf(deps, row.id);
  const jobs = await deps.db.select().from(runnerJobs).where(eq(runnerJobs.assignmentId, row.id));
  const input: VerifyItem[] = targets.map((t) => {
    const family = familyOf(t);
    const ids = new Set(family.map((i) => i.id));
    return {
      item: {
        ...t,
        summary: family
          .map((i) => (i.summary ? (i.id === t.id ? i.summary : `${i.title}: ${i.summary}`) : ""))
          .filter(Boolean)
          .join("\n\n"),
      },
      proofs: proofs.filter((p) => p.itemId && ids.has(p.itemId)),
      results: jobs
        .filter((x) => x.planItemId && ids.has(x.planItemId) && x.result)
        .map((x) => x.result as string),
    };
  });
  const verifier = deps.assignmentVerifier ?? modelVerifier;
  const res = await verifier(deps, row, input);
  // The plan as it is after the call: a fix only for an item still done, with the round that was judged.
  const after = new Map((await planOf(deps, row.id)).map((i) => [i.id, i]));
  const unchanged = (t: PlanItemRow) => {
    const now = after.get(t.id);
    return now?.status === "done" && now.epoch === t.epoch && now.checks === t.checks;
  };
  const now = deps.now();
  const verifierActor = { type: "verifier" as const, id: null };
  if (!res.ok) {
    if (res.code === "budget" && res.scope === "assignment") {
      await deps.db.update(assignments).set({ ceiling: "usd" }).where(eq(assignments.id, row.id));
      return null;
    }
    await assignmentEvent(deps, row, {
      kind: "verifier_unavailable",
      actor: verifierActor,
      key: `${row.id}:vu:${round}:${targets.map((t) => `${t.id}.${t.epoch}`).join(",")}`,
      data: { round, code: res.code, error: res.error.slice(0, 500), itemIds: targets.map((t) => t.id) },
    });
    // It counts as a round: three failures of the verifier in a row leave the item stuck (the person decides).
    for (const t of targets)
      await deps.db
        .update(assignmentPlanItems)
        .set({ checks: t.checks + 1, updatedAt: now })
        .where(
          and(
            eq(assignmentPlanItems.assignmentId, row.id),
            eq(assignmentPlanItems.id, t.id),
            eq(assignmentPlanItems.checks, t.checks),
            eq(assignmentPlanItems.epoch, t.epoch),
            eq(assignmentPlanItems.status, "done"),
          ),
        );
    return RETRY_WAIT_MS;
  }
  // The fix items go in before the verdicts: a crash between the two then repeats the round's verifier call (the
  // fix ids are fixed by item, epoch and round, so nothing doubles), instead of spending a round with no fix.
  const fixes = res.verdicts.flatMap((v) => {
    const t = targets.find((x) => x.id === v.id);
    return t && !v.passes && unchanged(t)
      ? [
          {
            id: fixIdOf(t.id, t.epoch, round),
            title: t.title,
            criteria: v.reason.slice(0, 2000),
            kind: "fix" as const,
            fixes: t.id,
          },
        ]
      : [];
  });
  if (fixes.length) {
    const w = await writePlan(deps, row.id, {
      author: verifierActor,
      mode: "append",
      items: fixes,
      note: `validation round ${round}`,
    }).catch(async (err: unknown) => {
      if (!(err instanceof HttpError) || err.code !== "assignment.plan_too_long") throw err;
      // No room for the fixes: the round isn't spent (no verdict goes in), and the person makes room.
      await pauseFor(
        deps,
        row,
        { waitReason: "paused" },
        "I paused: the plan is full, so the verifier's fixes don't fit. Remove items from the plan and resume.",
        { why: "plan_too_long", round },
      );
      return null;
    });
    if (!w) return null;
    for (const id of w.added)
      await assignmentEvent(deps, row, {
        kind: "fix_created",
        actor: verifierActor,
        itemId: id,
        key: `${row.id}:fix:${id}`,
        data: { fixes: fixes.find((f) => f.id === id)?.fixes ?? null, round },
      });
  }
  for (const v of res.verdicts) {
    const t = targets.find((x) => x.id === v.id);
    if (!t) continue;
    // Only this path writes `passes` (the executor and the person have no way to).
    const [judged] = await deps.db
      .update(assignmentPlanItems)
      .set({
        passes: v.passes,
        verdict: v.reason.slice(0, 2000),
        verifiedAt: now,
        checks: t.checks + 1,
        updatedBy: verifierActor,
        updatedAt: now,
      })
      .where(
        and(
          eq(assignmentPlanItems.assignmentId, row.id),
          eq(assignmentPlanItems.id, t.id),
          eq(assignmentPlanItems.checks, t.checks),
          eq(assignmentPlanItems.epoch, t.epoch),
          eq(assignmentPlanItems.status, "done"),
        ),
      )
      .returning();
    if (!judged) continue;
    await assignmentEvent(deps, row, {
      kind: v.passes ? "validation_passed" : "validation_failed",
      actor: verifierActor,
      itemId: t.id,
      key: `${row.id}:val:${t.id}:${t.epoch}:${round}`,
      data: { round, reason: v.reason.slice(0, 500), runId: res.runId },
    });
    const family = familyOf(t).filter((i) => i.id !== t.id);
    if (v.passes && family.length)
      await deps.db
        .update(assignmentPlanItems)
        .set({ passes: true, verdict: "Fixed", verifiedAt: now, updatedBy: verifierActor, updatedAt: now })
        .where(
          and(
            eq(assignmentPlanItems.assignmentId, row.id),
            inArray(
              assignmentPlanItems.id,
              family.map((i) => i.id),
            ),
          ),
        );
  }
  publishAssignment(deps, row, "plan");
  return null;
}

async function submit(deps: AppDeps, row: AssignmentRow): Promise<void> {
  if (row.status !== "active") return;
  const [pending] = await deps.db
    .select({ id: assignmentSubmissions.id })
    .from(assignmentSubmissions)
    .where(and(eq(assignmentSubmissions.assignmentId, row.id), eq(assignmentSubmissions.status, "pending")));
  if (pending) return;
  const items = (await planOf(deps, row.id)).filter((i) => i.status !== "dropped" && i.kind !== "fix");
  if (items.length === 0 || items.some((i) => i.passes !== true)) return;
  const proofs = await proofsOf(deps, row.id);
  // The note is data (titles and summaries); the "everything passed the verifier" sentence the screen puts in its
  // own language.
  const note = items.map((i) => `- ${i.title}${i.summary ? `: ${i.summary.slice(0, 300)}` : ""}`).join("\n");
  const { submission } = await createSubmission(deps, row, {
    note,
    checklist: items.map((i) => i.criteria || i.title),
    auto: true,
  });
  await assignmentEvent(deps, row, {
    kind: "delivered",
    actor: SYSTEM,
    key: `${row.id}:delivered:${submission.id}`,
    data: { submissionId: submission.id, items: items.length, proofs: proofs.length },
  });
}

// ---- steps (the same body in both engines) ----

let inflight = 0;

/** The `next` step. An error becomes a short wait: the workflow never goes to ERROR because of our code. */
export async function stepNext(deps: AppDeps, assignmentId: string): Promise<EngineAction> {
  inflight++;
  try {
    const row = await assignmentById(deps, assignmentId);
    if (!row) return { type: "end" };
    // A closed one still decides: a run or a job left going on after the close gets its halt before the end.
    return decide(await snapshotOf(deps, row), deps.now());
  } catch (err) {
    log.error("assignment.engine_next_failed", { err, assignmentId });
    return { type: "wait", reason: "idle", until: new Date(deps.now().getTime() + 60_000).toISOString() };
  } finally {
    inflight--;
  }
}

/** The `act` step. Returns how long to wait (ms), or null to decide again at once. */
export async function stepAct(deps: AppDeps, assignmentId: string, a: EngineAction): Promise<number | null> {
  inflight++;
  try {
    return await act(deps, assignmentId, a);
  } catch (err) {
    log.error("assignment.engine_act_failed", { err, assignmentId, action: a.type });
    return 60_000;
  } finally {
    inflight--;
  }
}

// ---- engines ----

export interface AssignmentEngine {
  readonly kind: "dbos" | "local";
  /** Boot: starts the engine and makes sure each open assignment has its loop. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Wakes the assignment's loop (creates it if it doesn't exist yet). Doesn't throw; nothing before `start`. */
  wake(assignmentId: string): void;
  /** Tests: waits until no step runs and no agent run is on the air. */
  idle(): Promise<void>;
}

const LIVE_STATUSES = ["active", "paused", "wrapping_up"] as const;

async function openAssignments(deps: AppDeps): Promise<AssignmentRow[]> {
  return deps.db
    .select()
    .from(assignments)
    .where(inArray(assignments.status, [...LIVE_STATUSES]));
}

/** The listener of the runs' end: closes the run's work and wakes the thread's assignment. */
function watchRuns(getDeps: () => AppDeps, engine: AssignmentEngine): void {
  const deps = getDeps();
  deps.runtime.onRunEnd((end) => {
    if (!end.threadId) return;
    const threadId = end.threadId;
    deps.runtime.track(
      (async () => {
        const [row] = await deps.db.select().from(assignments).where(eq(assignments.threadId, threadId));
        if (!row || row.agentId !== end.agentId || isClosed(row)) return;
        const [w] = await deps.db
          .update(assignmentWork)
          .set({
            status: "ended",
            outcome: end.status === "done" ? "done" : end.status === "canceled" ? "canceled" : "failed",
            endedAt: deps.now(),
          })
          .where(and(eq(assignmentWork.refId, end.runId), ne(assignmentWork.status, "ended")))
          .returning();
        if (w)
          await assignmentEvent(deps, row, {
            kind: "work_ended",
            actor: { type: "agent", id: row.agentId },
            itemId: w.itemId || null,
            key: `${row.id}:end:${w.id}`,
            data: { workId: w.id, n: w.n, outcome: w.outcome, runId: end.runId, errorCode: end.errorCode },
          });
        // The assignment's cap rejected the reservation: the next decision pauses (the spend may be under the cap).
        if (end.errorCode === "assignment_budget_exhausted")
          await deps.db.update(assignments).set({ ceiling: "usd" }).where(eq(assignments.id, row.id));
        // A cap that isn't the assignment's (the channel's or the agent's month): trying again only spends
        // steps and repeats the notice. It pauses and says which cap ran out; whoever can raise it decides.
        const outside =
          end.errorCode === "channel_budget_exhausted"
            ? "this channel's monthly budget"
            : end.errorCode === "budget_exhausted"
              ? "my monthly budget"
              : null;
        if (outside) {
          const [fresh] = await deps.db.select().from(assignments).where(eq(assignments.id, row.id));
          if (fresh)
            await pauseFor(
              deps,
              fresh,
              { waitReason: "paused" },
              `I paused this assignment: ${outside} ran out. Raise it and resume the assignment to continue.`,
              { budget: end.errorCode, runId: end.runId },
            );
        }
        engine.wake(row.id);
      })(),
      "assignment.run_end",
    );
  });
}

/** A local loop's mailbox: a wake that arrives outside the wait isn't lost. */
class Mailbox {
  private pending = false;
  private resolve: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  get parked() {
    return this.resolve !== null;
  }
  poke() {
    const r = this.resolve;
    if (!r) {
      this.pending = true;
      return;
    }
    this.resolve = null;
    if (this.timer) clearTimeout(this.timer);
    r();
  }
  sleep(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((r) => {
      this.resolve = r;
      this.timer = setTimeout(() => {
        this.resolve = null;
        r();
      }, ms);
    });
  }
}

/** PGlite: the same loop in memory, one per assignment; the boot recreates it (the state is in the tables). */
export class LocalEngine implements AssignmentEngine {
  readonly kind = "local" as const;
  private loops = new Map<string, { box: Mailbox; done: Promise<void> }>();
  private started = false;
  private stopped = false;

  constructor(private readonly getDeps: () => AppDeps) {}

  async start(): Promise<void> {
    const deps = this.getDeps();
    this.started = true;
    watchRuns(this.getDeps, this);
    await recoverPlans(deps);
    for (const row of await openAssignments(deps)) this.wake(row.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const l of this.loops.values()) l.box.poke();
    await Promise.allSettled([...this.loops.values()].map((l) => l.done));
  }

  wake(assignmentId: string): void {
    if (!this.started || this.stopped) return;
    const cur = this.loops.get(assignmentId);
    if (cur) {
      cur.box.poke();
      return;
    }
    const box = new Mailbox();
    const done = this.run(assignmentId, box).finally(() => {
      if (this.loops.get(assignmentId)?.box === box) this.loops.delete(assignmentId);
    });
    this.loops.set(assignmentId, { box, done });
  }

  private async run(assignmentId: string, box: Mailbox): Promise<void> {
    const deps = this.getDeps();
    while (!this.stopped) {
      const a = await stepNext(deps, assignmentId);
      if (a.type === "end") return;
      const ms = await stepAct(deps, assignmentId, a);
      if (this.stopped) return;
      if (ms !== null) await box.sleep(ms);
    }
  }

  async idle(): Promise<void> {
    const rt = this.getDeps().runtime;
    for (;;) {
      await rt.settle();
      while (inflight > 0 || [...this.loops.values()].some((l) => !l.box.parked)) await Bun.sleep(5);
      if (rt.busyAgents().size === 0) {
        await rt.settle();
        if (
          inflight === 0 &&
          [...this.loops.values()].every((l) => l.box.parked) &&
          rt.busyAgents().size === 0
        )
          return;
      }
    }
  }
}

// ---- DBOS ----

/** The deps of the process that owns DBOS (one per process: the workflow's step finds the deps here). */
let durableDeps: (() => AppDeps) | null = null;
const depsForStep = () => {
  if (!durableDeps) throw new Error("the assignment engine is not running in this process");
  return durableDeps();
};

/**
 * The workflow. Stable code (rule 2 in durable.ts): only the three steps, in a loop. The plan is read only inside
 * the step, the act step checks the database, and there is no DBOS.patch.
 */
async function assignmentWorkflowFn(assignmentId: string): Promise<string> {
  for (;;) {
    const a = await DBOS.runStep(() => stepNext(depsForStep(), assignmentId), { name: "next" });
    if (a.type === "end") return "closed";
    const ms = await DBOS.runStep(() => stepAct(depsForStep(), assignmentId, a), { name: "act" });
    if (ms !== null) await DBOS.recv<string>("wake", Math.max(1, Math.ceil(ms / 1000)));
  }
}

let registered: ((assignmentId: string) => Promise<string>) | null = null;
function assignmentWorkflow() {
  registered ??= DBOS.registerWorkflow(assignmentWorkflowFn, { name: "assignment" });
  return registered;
}

export const workflowIdOf = (assignmentId: string, fork = 0) =>
  fork ? `asg:${assignmentId}:f${fork}` : `asg:${assignmentId}`;

/** Postgres: one durable workflow per assignment. */
export class DbosEngine implements AssignmentEngine {
  readonly kind = "dbos" as const;
  private engine: { stop(): Promise<void> } | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly getDeps: () => AppDeps,
    private readonly opts: { url: string; version: string; poolSize: number; sweepEveryMs?: number },
  ) {}

  async start(): Promise<void> {
    const deps = this.getDeps();
    assignmentWorkflow();
    durableDeps = this.getDeps;
    watchRuns(this.getDeps, this);
    await recoverPlans(deps);
    try {
      this.engine = await launchDurable({
        url: this.opts.url,
        version: this.opts.version,
        poolSize: this.opts.poolSize,
      });
    } catch (err) {
      durableDeps = null;
      throw err;
    }
    await this.sweep();
    const every = this.opts.sweepEveryMs ?? 5 * 60_000;
    if (every > 0)
      this.sweepTimer = setInterval(() => {
        void this.sweep().catch((err) => log.error("assignment.engine_sweep_failed", { err }));
      }, every);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.engine?.stop();
    this.engine = null;
    durableDeps = null;
  }

  /**
   * Makes sure each open assignment has a live workflow. DBOS resumes this version's PENDING ones on its own at
   * launch. PENDING of another version, ERROR, MAX_RECOVERY and CANCELLED become a fork from step 0 in this
   * version (the state is in our tables, so starting over converges).
   */
  async sweep(): Promise<void> {
    const deps = this.getDeps();
    for (const row of await openAssignments(deps)) await this.ensure(row);
  }

  private async ensure(row: AssignmentRow): Promise<string | null> {
    if (this.stopped || !this.engine) return null;
    const deps = this.getDeps();
    if (!row.workflowId) {
      const id = workflowIdOf(row.id);
      await DBOS.startWorkflow(assignmentWorkflow(), { workflowID: id })(row.id);
      await deps.db.update(assignments).set({ workflowId: id }).where(eq(assignments.id, row.id));
      return id;
    }
    const status = await DBOS.getWorkflowStatus(row.workflowId);
    if (status?.status === "PENDING" || status?.status === "ENQUEUED") {
      if (status.applicationVersion === this.opts.version) return row.workflowId;
      await DBOS.cancelWorkflow(row.workflowId);
    } else if (status?.status === "SUCCESS" && isClosed(row)) return row.workflowId;
    const fork = Number(/:f(\d+)$/.exec(row.workflowId)?.[1] ?? 0) + 1;
    const id = workflowIdOf(row.id, fork);
    if (status)
      await DBOS.forkWorkflow(row.workflowId, 0, {
        newWorkflowID: id,
        applicationVersion: this.opts.version,
      });
    else await DBOS.startWorkflow(assignmentWorkflow(), { workflowID: id })(row.id);
    await deps.db.update(assignments).set({ workflowId: id }).where(eq(assignments.id, row.id));
    await assignmentEvent(deps, row, {
      kind: "engine_forked",
      actor: SYSTEM,
      key: `${row.id}:fork:${id}`,
      data: { from: row.workflowId, to: id, status: status?.status ?? null, version: this.opts.version },
    });
    return id;
  }

  wake(assignmentId: string): void {
    if (this.stopped || !this.engine) return;
    void (async () => {
      const row = await assignmentById(this.getDeps(), assignmentId);
      if (!row || isClosed(row)) {
        // Closed: the loop wakes to end.
        if (row?.workflowId) await DBOS.send(row.workflowId, "wake", "wake");
        return;
      }
      const id = row.workflowId ?? (await this.ensure(row));
      if (id) await DBOS.send(id, "wake", "wake");
    })().catch((err) => log.error("assignment.engine_wake_failed", { err, assignmentId }));
  }

  async idle(): Promise<void> {
    const rt = this.getDeps().runtime;
    for (let quiet = 0; quiet < 3; ) {
      await rt.settle();
      await Bun.sleep(50);
      quiet = inflight === 0 && rt.busyAgents().size === 0 ? quiet + 1 : 0;
    }
  }
}

/** Assignments from before the plan table: the jsonb becomes rows (once). */
async function recoverPlans(deps: AppDeps): Promise<void> {
  const rows = await deps.db
    .select()
    .from(assignments)
    .where(inArray(assignments.status, ["proposed", ...LIVE_STATUSES]));
  for (const row of rows)
    await importLegacyPlan(deps, row).catch((err) =>
      log.error("assignment.plan_import_failed", { err, assignmentId: row.id }),
    );
}

export function createEngine(
  getDeps: () => AppDeps,
  kind: "dbos" | "local",
  opts: { url: string | null; version: string; poolSize: number; sweepEveryMs?: number },
): AssignmentEngine {
  if (kind === "dbos") {
    if (!opts.url) throw new Error("the durable assignment engine needs Postgres (DATABASE_URL)");
    return new DbosEngine(getDeps, {
      url: opts.url,
      version: opts.version,
      poolSize: opts.poolSize,
      ...(opts.sweepEveryMs !== undefined ? { sweepEveryMs: opts.sweepEveryMs } : {}),
    });
  }
  return new LocalEngine(getDeps);
}
