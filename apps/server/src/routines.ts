// Routines: an agent gets the same request on a schedule (a recurrence rule), once, on a workspace event or on a
// webhook. The result goes to a channel, to the DM or a new conversation with whoever created it, to a document in
// the Drive or to a debate.
//
// Executing reaches the runtime by the target: a document asks for a text (`complete`), a conversation runs the
// agent (`runFor`); a debate only opens one (its turns are the debate's own).
import type {
  RecurrenceRule,
  Routine,
  RoutinePolicy,
  RoutineRun,
  RoutineRunTrigger,
  RoutineTarget,
  RoutineTrigger,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { occurrences, validateRule } from "@vanr/engine/recurrence";
import { PRODUCT } from "@vanr/product";
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRow } from "./agents";
import { canReadChannel, channelInWorkspace, openDm } from "./channels";
import type { AppDeps, WorkspaceMember } from "./context";
import { openDebate } from "./debates";
import { createFile } from "./drive";
import { HttpError, notFound } from "./http";
import { addressOrDomain } from "./integrations/mail-rules";
import { log } from "./logger";
import { postMessage } from "./messages";
import { notify } from "./notifications";
import { PERSONAL_PLAN_TEXT, withPlanOwner } from "./runners/plans";
import type { RunLimits } from "./runtime/runtime";

const { routines, routineExecutions, agents, messages, runs, mailConnections } = schema;
export type RoutineRow = typeof routines.$inferSelect;
type ExecutionRow = typeof routineExecutions.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * `pausedReason` of a routine that turned itself off because its series ended (the last time of a schedule, or the
 * one time of "once"). It isn't a pause: a fire recorded before the end still runs.
 */
export const SERIES_ENDED = "ended";

/**
 * Events that fire a routine. Only what people do fires one (keeps a routine from firing a routine). The producers:
 * a debate that concludes (`debates.ts`) and an issue created (routes/issues, a later slice).
 */
export const ROUTINE_EVENTS = ["issue.created", "debate.concluded"] as const;
const RECENT = 14;

/** The default rules of a routine (whatever the routine didn't set). */
export const DEFAULT_POLICY: RoutinePolicy = {
  missed: "once",
  missedWindowMin: 60,
  overlap: "skip",
  maxCostUsd: 2,
  maxSteps: 12,
  maxMinutes: 30,
  retries: 2,
  pauseAfterFailures: 3,
};

export const policySchema = z
  .object({
    missed: z.enum(["once", "skip"]),
    missedWindowMin: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    overlap: z.enum(["skip", "queue"]),
    maxCostUsd: z.number().min(0.01).max(100),
    maxSteps: z.number().int().min(1).max(50),
    maxMinutes: z.number().int().min(1).max(240),
    retries: z.number().int().min(0).max(5),
    pauseAfterFailures: z.number().int().min(0).max(20),
  })
  .strict()
  .partial();

/** The rules in effect: the saved ones over the default (what doesn't pass the schema falls back to the default). */
export function policyOf(row: Pick<RoutineRow, "policy">): RoutinePolicy {
  const parsed = policySchema.safeParse(row.policy ?? {});
  return { ...DEFAULT_POLICY, ...(parsed.success ? parsed.data : {}) };
}

export const ruleSchema = z
  .object({
    freq: z.enum(["minutely", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(1000).optional(),
    weekdays: z
      .array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
      .max(7)
      .optional(),
    byMonthDay: z.array(z.number().int().min(-31).max(31)).max(31).optional(),
    bySetPos: z.array(z.number().int().min(-5).max(5)).max(5).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    times: z.array(z.string().max(5)).max(24).optional(),
    timezone: z.string().min(1).max(64),
    start: z.string().max(40).optional(),
    until: z.string().max(40).optional(),
    count: z.number().int().min(1).max(10_000).optional(),
  })
  .strict() satisfies z.ZodType<RecurrenceRule>;

/** A valid rule, or 400 with the code the screen translates (`rule.timezone`, `rule.too_often`...). */
export function checkRule(rule: RecurrenceRule): RecurrenceRule {
  const code = validateRule(rule);
  if (code) throw new HttpError(400, code, "Invalid recurrence rule", { code });
  return rule;
}

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), rule: ruleSchema }),
  z.object({
    kind: z.literal("once"),
    at: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1).max(64),
  }),
  z.object({ kind: z.literal("event"), event: z.enum(ROUTINE_EVENTS) }),
  z.object({
    kind: z.literal("email"),
    accountId: z.string().min(1),
    folder: z.string().min(1).max(200),
    filter: z
      .object({
        from: z.array(addressOrDomain).max(50).optional(),
        subject: z.string().trim().max(200).optional(),
        text: z.string().trim().max(200).optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({ kind: z.literal("webhook") }),
]) satisfies z.ZodType<RoutineTrigger>;

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), channelId: z.string().min(1) }),
  z.object({ kind: z.literal("dm") }),
  z.object({ kind: z.literal("file") }),
  z.object({
    kind: z.literal("debate"),
    agentIds: z.array(z.string().min(1)).min(1).max(8),
    roundLimit: z.number().int().min(1).max(10),
  }),
  z.object({ kind: z.literal("conversation") }),
]) satisfies z.ZodType<RoutineTarget>;

/** The saved trigger, read through its schema (the row is outside data for this code). */
export function triggerOf(row: Pick<RoutineRow, "id" | "trigger">): RoutineTrigger {
  const parsed = triggerSchema.safeParse(row.trigger);
  if (!parsed.success) throw new Error(`routine ${row.id} has an invalid trigger`);
  return parsed.data;
}

/** The saved target, read through its schema. */
export function targetOf(row: Pick<RoutineRow, "id" | "target">): RoutineTarget {
  const parsed = targetSchema.safeParse(row.target);
  if (!parsed.success) throw new Error(`routine ${row.id} has an invalid target`);
  return parsed.data;
}

/**
 * The next scheduled execution (only a schedule and "once" have a time). `anchor` is the start of the series (the
 * routine's creation): without it, `count` and the hourly step would count again on every fire and the series
 * would never end.
 */
export function nextRunFor(trigger: RoutineTrigger, after: Date, anchor?: Date): Date | null {
  if (trigger.kind === "schedule") {
    const from = anchor ?? after;
    return (
      occurrences(seriesRule(trigger.rule, from), {
        from: new Date(after.getTime() + 1),
        limit: 1,
        anchor: from,
      })[0] ?? null
    );
  }
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return at > after ? at : null;
  }
  return null;
}

/**
 * The rule as the routine counts it: without `start`, the series begins at the instant of creation, and the
 * occurrence that falls exactly on it (hourly step, a rule without a fixed time) never runs, because the next time
 * is always after now. In RFC 5545 it counts in `count`; here `count` is the number of executions, so it stays out.
 */
export function seriesRule(rule: RecurrenceRule, anchor: Date): RecurrenceRule {
  if (!rule.count || rule.start) return rule;
  const first = occurrences(rule, { from: anchor, limit: 1, anchor })[0];
  return first?.getTime() === anchor.getTime() ? { ...rule, count: rule.count + 1 } : rule;
}

/** The start of the series (a rule with `start` uses its own): the last trigger change, or the creation. */
export const anchorOf = (row: Pick<RoutineRow, "createdAt" | "scheduleFrom">) =>
  row.scheduleFrom ?? row.createdAt;

/**
 * The webhook's address. It carries only the public hook id, never the secret: the request proves itself with the
 * signature (webhook-signature.ts), which the hook's route checks.
 */
export function webhookUrl(deps: AppDeps, row: RoutineRow): string | null {
  return triggerOf(row).kind === "webhook" && row.hookId
    ? `${deps.config.publicUrl}/api/v1/hooks/routines/${row.hookId}`
    : null;
}

async function recentFires(db: Db, ids: string[]): Promise<Map<string, ExecutionRow[]>> {
  const out = new Map<string, ExecutionRow[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(routineExecutions)
    .where(
      and(
        inArray(routineExecutions.routineId, ids),
        sql`${routineExecutions.id} in (select id from routine_executions r2 where r2.routine_id = ${routineExecutions.routineId} order by r2.at desc limit ${RECENT})`,
      ),
    )
    .orderBy(desc(routineExecutions.at));
  for (const r of rows) out.set(r.routineId, [...(out.get(r.routineId) ?? []), r]);
  return out;
}

/** The trigger as the screen sees it: the email one says whether the mailbox is still connected. */
async function withMailStatus(db: Db, rows: RoutineRow[]): Promise<Map<string, RoutineTrigger>> {
  const ids = rows.flatMap((r) => {
    const t = triggerOf(r);
    return t.kind === "email" ? [t.accountId] : [];
  });
  const accounts = ids.length
    ? await db
        .select({ id: mailConnections.id, status: mailConnections.status })
        .from(mailConnections)
        .where(inArray(mailConnections.id, ids))
    : [];
  const out = new Map<string, RoutineTrigger>();
  for (const row of rows) {
    const t = triggerOf(row);
    if (t.kind !== "email") {
      out.set(row.id, t);
      continue;
    }
    const status = accounts.find((a) => a.id === t.accountId)?.status;
    out.set(row.id, {
      ...t,
      status: status === "active" ? "active" : status ? "reauth_required" : "disconnected",
    });
  }
  return out;
}

export async function toRoutines(deps: AppDeps, rows: RoutineRow[]): Promise<Routine[]> {
  const byRoutine = await recentFires(
    deps.db,
    rows.map((r) => r.id),
  );
  const triggers = await withMailStatus(deps.db, rows);
  return rows.map((row) => {
    const recent = (byRoutine.get(row.id) ?? []).map((r) => ({ at: r.at.toISOString(), status: r.status }));
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      agentId: row.agentId,
      target: targetOf(row),
      trigger: triggers.get(row.id) ?? triggerOf(row),
      policy: policyOf(row),
      active: row.active,
      pausedReason: row.pausedReason === "failures" ? "failures" : null,
      running: !!row.runningSince,
      nextFireAt: row.active ? (row.nextFireAt?.toISOString() ?? null) : null,
      lastRun: recent[0] ?? null,
      recentFires: recent,
      webhookUrl: webhookUrl(deps, row),
      webhookHasSecret: !!row.webhookSecret,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function toRoutine(deps: AppDeps, row: RoutineRow): Promise<Routine> {
  const [r] = await toRoutines(deps, [row]);
  if (!r) throw new Error("toRoutines returned nothing");
  return r;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const runTrigger = z.enum(["email", "event", "manual", "once", "retry", "schedule", "webhook"]);

export function toRun(r: ExecutionRow): RoutineRun {
  const trigger = runTrigger.safeParse(r.trigger);
  return {
    id: r.id,
    at: r.at.toISOString(),
    status: r.status,
    trigger: trigger.success ? trigger.data : null,
    scheduledFor: iso(r.scheduledFor),
    reason: r.reason,
    attempt: r.attempt,
    notBefore: r.status === "queued" ? iso(r.notBefore) : null,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    summary: r.summary,
    summaryKey: r.summaryKey,
    summaryVars: r.summaryVars ?? null,
    channelId: r.channelId,
    threadId: r.threadId,
    messageId: r.messageId,
    runId: r.runId,
  };
}

export async function routineById(db: Db, workspaceId: string, id: string): Promise<RoutineRow> {
  const [row] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.workspaceId, workspaceId)));
  if (!row) throw notFound("Routine not found");
  return row;
}

interface Outcome {
  status: "ok" | "silent" | "failed" | "skipped";
  /** Why it was skipped or failed; decides whether the failure gets a retry (`RETRYABLE`). */
  reason?: string | null;
  summary: string | null;
  summaryKey: string | null;
  summaryVars?: Record<string, string | number>;
  channelId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  runId?: string | null;
}

const fail = (
  summaryKey: string,
  summary: string,
  reason: string,
  params?: Record<string, string | number>,
): Outcome => ({
  status: "failed",
  reason,
  summary,
  summaryKey,
  ...(params ? { summaryVars: params } : {}),
});

/**
 * Failures worth another attempt: the model or the network, the agent busy in the conversation, a server error, a
 * stop in the middle and the agent out of the channel (someone may put it back; an attempt that fails before the
 * model costs nothing). An archived agent, a deleted channel, the personal plan, a person's "stop" and the caps
 * (spend, turns, time) don't get better by trying again.
 */
const RETRYABLE = new Set(["model", "busy", "error", "interrupted", "agent_not_in_channel"]);
/** The wait before attempt n+1: 1 min, 4 min, 16 min... */
export const RETRY_BASE_MS = 60_000;
export const retryDelayMs = (attempt: number) => RETRY_BASE_MS * 4 ** (attempt - 1);
/** "Once" recovers a missed time up to 7 days; older than that becomes `missed`. */
export const CATCH_UP_MAX_MS = 7 * 24 * 60 * 60_000;
/** Slack over the time cap before an execution counts as interrupted (the server fell in the middle). */
export const STALE_GRACE_MS = 5 * 60_000;
/** A lock and an execution saved without a deadline (before this version) were worth 30 min. */
const LEGACY_LOCK_MS = 30 * 60_000;
/** A `pending` record stopped for longer than this: the process fell before it began. */
export const PENDING_STALE_MS = 2 * 60_000;

/**
 * The trigger's context pasted into the request. `untrusted` says where the outside part came from (email,
 * webhook): the run that reads the request raises flag A with that source.
 */
export interface RoutineContext {
  text: string;
  untrusted?: string;
}

/**
 * Ceiling of what comes from outside with the request (the webhook's body, an email, an event). The webhook
 * already rejects more than 10 thousand bytes and the email cuts the text at 4 thousand, but a header and an event
 * had no limit. With the ceiling, the routine's cost estimate (estimates.ts) stays an upper bound.
 */
export const ROUTINE_CONTEXT_CHARS = 12_000;
const CONTEXT_SEPARATOR = "\n\n---\n";

/** Triggers that bring outside content into the request. */
export const carriesContext = (trigger: RoutineTrigger) =>
  trigger.kind === "webhook" || trigger.kind === "email" || trigger.kind === "event";

/** How many characters the request can gain from the outside content, at most. */
export const contextChars = (trigger: RoutineTrigger) =>
  carriesContext(trigger) ? ROUTINE_CONTEXT_CHARS + CONTEXT_SEPARATOR.length : 0;

/** A fire: what fired it, the dedupe key and the scheduled time (schedule and "once"). */
export interface Fire {
  trigger: RoutineRunTrigger;
  /** The fire's key (event id, `webhook-id`, email UID, client key). */
  key?: string | null;
  scheduledFor?: Date | null;
  context?: RoutineContext;
  params?: Record<string, string | number>;
}

/**
 * Records the fire before running: a `pending` row in `routine_executions`, unique per (routine, scheduled time) and
 * per (routine, key). A second fire with the same time or the same key writes nothing and comes back `duplicate`
 * with the row that exists. The context is cut to ROUTINE_CONTEXT_CHARS here, before it is saved.
 */
export async function registerFire(
  deps: AppDeps,
  routineId: string,
  fire: Fire,
): Promise<{ run: ExecutionRow; duplicate: false } | { run: ExecutionRow | null; duplicate: true }> {
  const { db } = deps;
  const run = await insertFire(db, deps.now(), routineId, fire);
  if (run) return { run, duplicate: false };
  const [existing] = await db
    .select()
    .from(routineExecutions)
    .where(
      and(
        eq(routineExecutions.routineId, routineId),
        fire.scheduledFor
          ? eq(routineExecutions.scheduledFor, fire.scheduledFor)
          : eq(routineExecutions.dedupeKey, fire.key ?? ""),
      ),
    );
  return { run: existing ?? null, duplicate: true };
}

/** The `pending` row of a fire, or null when one with the same time or key exists (in the caller's transaction). */
async function insertFire(
  db: Db | Tx,
  at: Date,
  routineId: string,
  fire: Fire,
): Promise<ExecutionRow | null> {
  const payload = fire.context
    ? { ...fire.context, text: fire.context.text.slice(0, ROUTINE_CONTEXT_CHARS) }
    : null;
  const [run] = await db
    .insert(routineExecutions)
    .values({
      id: newId("rrun"),
      routineId,
      at,
      status: "pending",
      trigger: fire.trigger,
      scheduledFor: fire.scheduledFor ?? null,
      dedupeKey: fire.key ?? null,
      payload,
      summaryVars: fire.params ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return run ?? null;
}

/** Records and runs (waits for the end). For whoever needs the result: email, tests. */
export async function fireRoutine(deps: AppDeps, routineId: string, fire: Fire) {
  const reg = await registerFire(deps, routineId, fire);
  if (reg.duplicate) return reg;
  return { run: await startRoutineRun(deps, reg.run), duplicate: false as const };
}

/** Writes to the execution; with `from`, only if it is still in one of those statuses. */
async function updateRun(
  deps: AppDeps,
  id: string,
  set: Partial<ExecutionRow>,
  from?: ExecutionRow["status"][],
): Promise<ExecutionRow | null> {
  const [row] = await deps.db
    .update(routineExecutions)
    .set(set)
    .where(and(eq(routineExecutions.id, id), from ? inArray(routineExecutions.status, from) : undefined))
    .returning();
  return row ?? null;
}

/**
 * The owner of a recorded execution: whoever marks `notBefore` first takes it. Whoever recorded it marks it at once;
 * the queue's sweep only takes the one nobody marked for `PENDING_STALE_MS` (the owner fell), and two sweeps at
 * the same time don't take the same one (one conditional UPDATE).
 */
async function own(deps: AppDeps, run: ExecutionRow): Promise<ExecutionRow | null> {
  const now = deps.now();
  const [row] = await deps.db
    .update(routineExecutions)
    .set({ notBefore: now })
    .where(
      and(
        eq(routineExecutions.id, run.id),
        eq(routineExecutions.status, "pending"),
        or(
          isNull(routineExecutions.notBefore),
          lt(routineExecutions.notBefore, new Date(now.getTime() - PENDING_STALE_MS)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The routine's lock: one execution at a time (one conditional UPDATE). A lock past its holder's deadline and the
 * slack (the server fell) counts as free. The deadline is the time cap as of when the execution began.
 */
async function claim(
  deps: AppDeps,
  row: RoutineRow,
  policy: RoutinePolicy,
): Promise<{ at: Date; until: Date } | null> {
  const at = deps.now();
  const until = new Date(at.getTime() + policy.maxMinutes * 60_000);
  const expired = new Date(at.getTime() - STALE_GRACE_MS);
  const [claimed] = await deps.db
    .update(routines)
    .set({ runningSince: at, runningUntil: until })
    .where(
      and(
        eq(routines.id, row.id),
        or(
          isNull(routines.runningSince),
          lt(routines.runningUntil, expired),
          // A lock from before the saved deadline: it was worth 30 min.
          and(
            isNull(routines.runningUntil),
            lt(routines.runningSince, new Date(expired.getTime() - LEGACY_LOCK_MS)),
          ),
        ),
      ),
    )
    .returning({ id: routines.id });
  return claimed ? { at, until } : null;
}

/**
 * Takes a recorded (`pending`) or queued (`queued`) execution to its end. A busy routine: under the "queue one"
 * policy the execution waits (at most one, retries aside); otherwise it becomes `skipped` for the overlap. The
 * runtime method the target reaches is checked first, before anything is written.
 */
export async function startRoutineRun(deps: AppDeps, registered: ExecutionRow): Promise<ExecutionRow> {
  const { db } = deps;
  const [before] = await db.select().from(routines).where(eq(routines.id, registered.routineId));
  if (!before) return registered;
  let run = registered;
  if (run.status === "pending") {
    const owned = await own(deps, run);
    if (!owned) return run;
    run = owned;
  }
  const mine = run;
  // The definition the execution runs with is read under the routine's row lock, in the transaction that claims
  // it: an edit or a pause committed before this point is seen, and one that comes later waits for the claim. Read
  // before the transaction, a concurrent edit or pause could run the fire with the old definition. FOR NO KEY
  // UPDATE: an execution inserted at the same time (its foreign key takes KEY SHARE on this row) doesn't wait.
  const decided = await db.transaction(async (tx) => {
    const scoped = { ...deps, db: tx };
    const [fresh] = await tx
      .select()
      .from(routines)
      .where(eq(routines.id, mine.routineId))
      .for("no key update");
    if (!fresh) return { kind: "gone" as const };
    const policy = policyOf(fresh);
    // A fire from before a person's pause doesn't run any more, and the key goes (the sender delivers again once
    // it is turned on). A routine whose series ended isn't paused: the fire recorded before the end (in the same
    // transaction that turned it off) runs, even as an orphan after a fall. "Run now" and "once" (and their
    // retries) were asked for already, so they run with the routine paused.
    const paused = !fresh.active && fresh.pausedReason !== SERIES_ENDED;
    if (paused && !(await askedExplicitly(scoped, mine))) {
      const skipped = await finishRun(
        scoped,
        mine,
        {
          status: "skipped",
          reason: "paused",
          summary: "The routine was paused",
          summaryKey: "routines.run.paused",
          dedupeKey: null,
        },
        [mine.status],
      );
      return { kind: "skipped" as const, row: skipped ?? mine };
    }
    const lock = await claim(scoped, fresh, policy);
    if (!lock) return { kind: "busy" as const, policy };
    const running = await updateRun(
      scoped,
      mine.id,
      { status: "running", startedAt: lock.at, deadlineAt: lock.until },
      ["pending", "queued"],
    );
    if (!running) await release(scoped, fresh.id, lock.at);
    return { kind: "claimed" as const, routine: fresh, policy, running };
  });
  if (decided.kind === "gone") return run;
  if (decided.kind === "skipped") return decided.row;
  if (decided.kind === "busy") {
    const { policy } = decided;
    if (run.status === "queued") return run;
    if (policy.overlap === "queue" && run.trigger !== "retry") {
      try {
        const queued = await updateRun(deps, run.id, { status: "queued", notBefore: deps.now() }, [
          run.status,
        ]);
        if (queued) return queued;
      } catch {
        // There is one in the queue already (unique index): this one skips.
      }
    }
    // Skipped: the key goes, so the sender (webhook, email) can deliver again.
    return (
      (await finishRun(
        deps,
        run,
        {
          status: "skipped",
          reason: "overlap",
          summary: "Still running the previous time",
          summaryKey: "routines.run.busy",
          dedupeKey: null,
        },
        [run.status],
      )) ?? run
    );
  }
  const { routine, policy, running } = decided;
  if (!running) return run;
  let outcome: Outcome;
  try {
    outcome = await execute(deps, routine, running, policy);
  } catch (err) {
    log.error("routine.failed", { routineId: routine.id, err });
    outcome = fail("routines.run.error", err instanceof Error ? err.message : String(err), "error");
  }
  const done = (await completeRun(deps, routine, policy, running, outcome)) ?? running;
  // The next one of the queue (overlap or a retry that came due) runs now, in the background.
  deps.runtime.track(drainRoutine(deps, routine.id), "routine.queue");
  return done;
}

async function askedExplicitly(deps: AppDeps, run: ExecutionRow): Promise<boolean> {
  let trigger = run.trigger;
  if (trigger === "retry" && run.retryOf) {
    const [root] = await deps.db
      .select({ trigger: routineExecutions.trigger })
      .from(routineExecutions)
      .where(eq(routineExecutions.id, run.retryOf));
    trigger = root?.trigger ?? null;
  }
  return trigger === "manual" || trigger === "once";
}

async function release(deps: AppDeps, routineId: string, claimedAt: Date) {
  await deps.db
    .update(routines)
    .set({ runningSince: null, runningUntil: null })
    .where(and(eq(routines.id, routineId), eq(routines.runningSince, claimedAt)));
}

/**
 * Writes the end, only if the execution hasn't ended yet (the recovery and the normal end don't run each other
 * over). `from` narrows it: whoever skips writes only if the row is still in the status it read, so as not to
 * close the execution another process already began.
 */
async function finishRun(
  deps: AppDeps,
  run: ExecutionRow,
  outcome: Outcome & { dedupeKey?: null },
  from: ExecutionRow["status"][] = ["pending", "queued", "running"],
): Promise<ExecutionRow | null> {
  const [row] = await deps.db
    .update(routineExecutions)
    .set({
      status: outcome.status,
      reason: outcome.reason ?? null,
      summary: outcome.summary,
      summaryKey: outcome.summaryKey,
      summaryVars: { ...(run.summaryVars ?? {}), ...(outcome.summaryVars ?? {}) },
      channelId: outcome.channelId ?? null,
      threadId: outcome.threadId ?? null,
      messageId: outcome.messageId ?? null,
      runId: outcome.runId ?? null,
      finishedAt: deps.now(),
      ...(outcome.dedupeKey === null ? { dedupeKey: null } : {}),
    })
    .where(and(eq(routineExecutions.id, run.id), inArray(routineExecutions.status, from)))
    .returning();
  return row ?? null;
}

/** The result, release and retry/pause commit together; notifications run only after the commit. */
async function completeRun(
  deps: AppDeps,
  routine: RoutineRow,
  policy: RoutinePolicy,
  run: ExecutionRow,
  outcome: Outcome,
) {
  const result = await deps.db.transaction(async (tx) => {
    const scoped = { ...deps, db: tx };
    const done = await finishRun(scoped, run, outcome);
    if (!done) return null;
    if (run.startedAt) await release(scoped, routine.id, run.startedAt);
    return { done, notice: await afterRun(scoped, routine, policy, done) };
  });
  if (result?.notice) await notify(deps, result.notice);
  return result?.done ?? null;
}

/** After the end: the retry, the notice and the pause after N failures in a row. */
async function afterRun(
  deps: AppDeps,
  routine: RoutineRow,
  policy: RoutinePolicy,
  run: ExecutionRow,
): Promise<Parameters<typeof notify>[1] | null> {
  const { db } = deps;
  const target = targetOf(routine);
  if (run.status === "failed" && RETRYABLE.has(run.reason ?? "") && run.attempt <= policy.retries) {
    const root = run.retryOf ?? run.id;
    const attempt = run.attempt + 1;
    await db
      .insert(routineExecutions)
      .values({
        id: newId("rrun"),
        routineId: routine.id,
        at: deps.now(),
        status: "queued",
        trigger: "retry",
        dedupeKey: `retry:${root}:${attempt}`,
        notBefore: new Date(deps.now().getTime() + retryDelayMs(run.attempt)),
        attempt,
        retryOf: root,
        payload: run.payload,
      })
      .onConflictDoNothing();
    await updateRun(deps, run.id, { retried: true });
    return null;
  }
  if (run.status === "failed") {
    const paused = await pauseAfterFailures(deps, routine, policy);
    return {
      workspaceId: routine.workspaceId,
      userId: routine.createdBy,
      kind: "routine_alert",
      groupKey: `routine:${routine.id}`,
      actor: { type: "agent", id: routine.agentId },
      source: { routineId: routine.id, label: routine.name },
      latest: {
        title: routine.name,
        text: (paused
          ? `Paused after ${policy.pauseAfterFailures} failed runs in a row. ${run.summary ?? ""}`
          : (run.summary ?? "")
        ).slice(0, 160),
      },
    };
  }
  if (run.status === "ok" && (target.kind === "file" || target.kind === "debate"))
    return {
      workspaceId: routine.workspaceId,
      userId: routine.createdBy,
      kind: "routine_report",
      groupKey: `routine:${routine.id}`,
      actor: { type: "agent", id: routine.agentId },
      source: { routineId: routine.id, label: routine.name },
      latest: { title: routine.name, ...(run.summary ? { text: run.summary.slice(0, 160) } : {}) },
    };
  return null;
}

/**
 * N executions in a row that failed (a failure that already has a retry doesn't count: the chain counts once, on
 * its last attempt) turn the routine off with `pausedReason: failures`.
 */
async function pauseAfterFailures(deps: AppDeps, routine: RoutineRow, policy: RoutinePolicy) {
  const n = policy.pauseAfterFailures;
  if (n <= 0) return false;
  const last = await deps.db
    .select({ status: routineExecutions.status })
    .from(routineExecutions)
    .where(
      and(
        eq(routineExecutions.routineId, routine.id),
        inArray(routineExecutions.status, ["ok", "silent", "failed"]),
        eq(routineExecutions.retried, false),
      ),
    )
    // An old row (without `finished_at`) goes in the order by the fire's time, not at the top (NULL comes first in
    // Postgres in descending order).
    .orderBy(desc(sql`coalesce(${routineExecutions.finishedAt}, ${routineExecutions.at})`))
    .limit(n);
  if (last.length < n || last.some((r) => r.status !== "failed")) return false;
  const [paused] = await deps.db
    .update(routines)
    .set({ active: false, nextFireAt: null, pausedReason: "failures" })
    .where(and(eq(routines.id, routine.id), eq(routines.active, true)))
    .returning({ id: routines.id });
  return !!paused;
}

/** Runs the next one of this routine's queue, if its time has come. */
async function drainRoutine(deps: AppDeps, routineId: string): Promise<void> {
  const [next] = await deps.db
    .select()
    .from(routineExecutions)
    .where(
      and(
        eq(routineExecutions.routineId, routineId),
        eq(routineExecutions.status, "queued"),
        lte(routineExecutions.notBefore, deps.now()),
      ),
    )
    .orderBy(asc(routineExecutions.notBefore), asc(routineExecutions.at))
    .limit(1);
  if (next) await startRoutineRun(deps, next);
}

/** The runtime's tick: queues that came due (retries and overlap) and executions the server left in the middle. */
export async function drainQueues(deps: AppDeps): Promise<number> {
  await recoverInterrupted(deps);
  // Recorded and never begun: the process fell between recording and running. The row holds the key (the
  // redelivery comes back `duplicate`), so it is the one that runs; `own` decides who takes it.
  const stale = new Date(deps.now().getTime() - PENDING_STALE_MS);
  const orphans = await deps.db
    .select()
    .from(routineExecutions)
    .where(
      and(
        eq(routineExecutions.status, "pending"),
        lt(routineExecutions.at, stale),
        or(isNull(routineExecutions.notBefore), lt(routineExecutions.notBefore, stale)),
      ),
    )
    .orderBy(asc(routineExecutions.at))
    .limit(50);
  for (const run of orphans) deps.runtime.track(startRoutineRun(deps, run), "routine.orphan");
  const due = await deps.db
    .selectDistinct({ routineId: routineExecutions.routineId })
    .from(routineExecutions)
    .where(and(eq(routineExecutions.status, "queued"), lte(routineExecutions.notBefore, deps.now())))
    .limit(50);
  for (const { routineId } of due) deps.runtime.track(drainRoutine(deps, routineId), "routine.queue");
  return due.length;
}

/**
 * A `running` execution older than its time cap plus the slack: the process fell in the middle. It closes as
 * `failed` (`interrupted`), the lock is released and a retry is marked like any failure.
 */
async function recoverInterrupted(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now().getTime();
  const expired = new Date(now - STALE_GRACE_MS);
  const rows = await db
    .select({ run: routineExecutions, routine: routines })
    .from(routineExecutions)
    .innerJoin(routines, eq(routines.id, routineExecutions.routineId))
    .where(
      and(
        eq(routineExecutions.status, "running"),
        // The deadline saved when it began (changing the cap later doesn't shorten a live execution).
        or(
          lt(routineExecutions.deadlineAt, expired),
          and(
            isNull(routineExecutions.deadlineAt),
            lt(routineExecutions.startedAt, new Date(expired.getTime() - LEGACY_LOCK_MS)),
          ),
        ),
      ),
    )
    .limit(50);
  for (const { run, routine } of rows) {
    const policy = policyOf(routine);
    if (!run.startedAt) continue;
    await completeRun(
      deps,
      routine,
      policy,
      run,
      fail("routines.run.interrupted", "The server stopped in the middle of this run", "interrupted"),
    );
  }
}

/** What the model receives in a routine that writes a document (the cost estimate starts from the same text). */
export function fileRoutineSystem(agent: Pick<AgentRow, "name" | "handle" | "instructions">): string {
  return (
    `You are ${agent.name} (@${agent.handle}), an AI agent on ${PRODUCT.name}. A routine asks you to ` +
    `write a document. Answer only with the document, in markdown.\n\n# Your instructions\n${agent.instructions.trim() || "-"}`
  );
}

async function execute(
  deps: AppDeps,
  row: RoutineRow,
  run: ExecutionRow,
  policy: RoutinePolicy,
): Promise<Outcome> {
  const { db } = deps;
  const context = run.payload ?? undefined;
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, row.agentId), isNull(agents.archivedAt)));
  if (!agent) return fail("routines.run.agent_gone", "The agent was archived", "agent_gone");
  // A personal-plan agent only runs the routine of whoever paired its runner (before posting the request).
  const planOwner = (await withPlanOwner(db, agent)).planOwnerUserId;
  if (planOwner !== null && planOwner !== row.createdBy)
    return fail("routines.run.personal_plan", `${agent.name} ${PERSONAL_PLAN_TEXT}`, "personal_plan");
  const target = targetOf(row);
  const prompt = context
    ? `${row.prompt}${CONTEXT_SEPARATOR}${context.text.slice(0, ROUTINE_CONTEXT_CHARS)}`
    : row.prompt;
  const stamp = deps.now().toISOString().slice(0, 16).replace("T", " ");
  // A hard cap: the spend counts for the whole chain (the retries share the same cap).
  const root = run.retryOf ?? run.id;
  const limits: RunLimits = {
    scopes: [{ kind: "routine_run", id: root, limitUsd: policy.maxCostUsd, period: "total" }],
    maxTurns: policy.maxSteps,
    timeoutMs:
      run.deadlineAt && run.startedAt
        ? run.deadlineAt.getTime() - run.startedAt.getTime()
        : policy.maxMinutes * 60_000,
    effectKey: `rrun:${root}`,
  };

  if (target.kind === "file") {
    const result = await deps.runtime.complete({
      agent,
      initiatedBy: row.createdBy,
      source: "routine",
      what: `Routine: ${row.name}`,
      system: fileRoutineSystem(agent),
      prompt,
      scopes: limits.scopes,
      timeoutMs: limits.timeoutMs,
    });
    if (!result.ok)
      return result.code === "budget"
        ? { status: "skipped", reason: "budget", summary: result.error, summaryKey: "routines.run.budget" }
        : result.code === "routine_budget"
          ? {
              status: "failed",
              reason: "routine_budget",
              summary: result.error,
              summaryKey: "routines.run.routine_budget",
            }
          : result.code === "personal_plan"
            ? fail("routines.run.personal_plan", result.error, "personal_plan")
            : fail("routines.run.model", result.error, "model");
    if (!result.text)
      return { status: "silent", summary: null, summaryKey: "routines.run.silent", runId: result.runId };
    const { row: file } = await createFile(deps, {
      workspaceId: row.workspaceId,
      title: `${row.name} · ${stamp}`,
      author: { type: "agent", id: agent.id },
      content: { kind: "document", markdown: result.text },
    });
    return {
      status: "ok",
      summary: file.title,
      summaryKey: "routines.run.file",
      summaryVars: { fileId: file.id, title: file.title },
      runId: result.runId,
    };
  }

  if (target.kind === "debate") {
    const debate = await openDebate(deps, {
      id: `deb_${root}`,
      workspaceId: row.workspaceId,
      title: row.name,
      goal: prompt,
      agentIds: target.agentIds,
      roundLimit: target.roundLimit,
      createdBy: { type: "agent", id: agent.id },
      requesterUserId: row.createdBy,
      // The goal carries the outside text (email, webhook): the origin is marked, and the search raises flag A.
      origin: {
        kind: "routine",
        agentId: agent.id,
        routineId: row.id,
        ...(context?.untrusted ? { untrusted: context.untrusted } : {}),
      },
    });
    return {
      status: "ok",
      summary: debate.title,
      summaryKey: "routines.run.debate",
      summaryVars: { debateId: debate.id, title: debate.title },
    };
  }

  // A conversation: the routine posts the request in its creator's name, and the agent answers there.
  let channelId: string;
  if (target.kind === "channel") channelId = target.channelId;
  else
    channelId = await openDm(db, {
      workspaceId: row.workspaceId,
      userId: row.createdBy,
      other: { type: "agent", id: agent.id },
    });
  const channel = await channelInWorkspace(db, row.workspaceId, channelId);
  if (!channel || channel.archivedAt)
    return fail("routines.run.channel_gone", "The channel no longer exists", "channel_gone");
  const [inChannel] = await db
    .select({ id: schema.channelMemberships.memberId })
    .from(schema.channelMemberships)
    .where(
      and(
        eq(schema.channelMemberships.channelId, channel.id),
        eq(schema.channelMemberships.memberType, "agent"),
        eq(schema.channelMemberships.memberId, agent.id),
      ),
    );
  if (!inChannel)
    return fail(
      "routines.run.agent_not_in_channel",
      `${agent.name} is not in this channel`,
      "agent_not_in_channel",
    );
  const routineRef = { routineId: row.id, name: row.name };
  const { message } = await postMessage(deps, {
    workspaceId: row.workspaceId,
    channel,
    author: { type: "person", id: row.createdBy },
    body: prompt,
    // One message per attempt: resending the same attempt doesn't post twice.
    clientId: `routine:${run.id}`,
    meta: {
      routine: routineRef,
      ...(target.kind === "conversation" ? { spawnsThread: true } : {}),
      ...(context?.untrusted ? { untrusted: context.untrusted } : {}),
    },
  });
  const session = {
    channelId: channel.id,
    threadId: message.threadId ?? (target.kind === "conversation" ? message.id : null),
    messageId: message.id,
  };
  const [trigger] = await db.select().from(messages).where(eq(messages.id, message.id));
  if (!trigger) return { ...fail("routines.run.error", "Message not saved", "error"), ...session };
  const started = await deps.runtime.runFor({
    agent,
    channel,
    trigger,
    replyMeta: { fromRoutine: routineRef },
    limits,
  });
  if (!started.ok && started.code === "personal_plan")
    return {
      ...fail("routines.run.personal_plan", `${agent.name} ${PERSONAL_PLAN_TEXT}`, "personal_plan"),
      ...session,
    };
  if (!started.ok && started.code === "busy")
    return {
      ...fail("routines.run.agent_busy", `${agent.name} was busy in this conversation`, "busy"),
      ...session,
    };
  if (!started.ok)
    return {
      status: "skipped",
      reason: "budget",
      summary: `${agent.name} is out of budget`,
      summaryKey: "routines.run.budget",
      ...session,
    };
  await started.done;
  const withRun = { ...session, runId: started.runId };
  const [agentRun] = await db.select().from(runs).where(eq(runs.id, started.runId));
  const [reply] = await db
    .select({ id: messages.id, body: messages.body })
    .from(messages)
    .where(eq(messages.runId, started.runId))
    .orderBy(asc(messages.createdAt))
    .limit(1);
  if (agentRun?.status === "failed" || agentRun?.status === "canceled") {
    const code = agentRun.errorCode ?? "";
    const reason = LIMIT_REASONS[code] ?? (agentRun.status === "canceled" ? "canceled" : "model");
    return {
      ...fail(`routines.run.${reason}`, agentRun.error ?? "The agent failed", reason),
      ...withRun,
    };
  }
  if (!reply) return { status: "silent", summary: null, summaryKey: "routines.run.silent", ...withRun };
  return {
    status: "ok",
    summary: reply.body.slice(0, 200),
    summaryKey: null,
    ...withRun,
    messageId: reply.id,
  };
}

/** A run's error code → why the execution failed (the caps get no retry). */
const LIMIT_REASONS: Record<string, string> = {
  budget_exhausted: "budget",
  routine_budget: "routine_budget",
  step_limit: "step_limit",
  time_limit: "time_limit",
};

/** The most occurrences counted one by one for the record of the times missed in a row (past it: "at least"). */
export const MISSED_COUNT_CAP = 1000;

/**
 * The latest occurrence of the rule in [notBefore, before), or null. It looks back in windows that double (1 minute,
 * 2, 4...), so a routine late by months costs a few dozen small expansions, never one per missed time.
 */
function latestBefore(rule: RecurrenceRule, anchor: Date, before: Date, notBefore: Date): Date | null {
  const end = before.getTime();
  const floor = notBefore.getTime();
  for (let span = 60_000; ; span *= 2) {
    const from = Math.max(floor, end - span);
    const found = occurrences(rule, { from: new Date(from), to: before, anchor, limit: 100_000 });
    const last = found.at(-1);
    if (last) return last;
    if (from <= floor) return null;
  }
}

/**
 * How many occurrences fall in [first, last] (both occurrences of the rule). A fixed step (minutely, hourly) is
 * counted by arithmetic; the rest one by one up to MISSED_COUNT_CAP.
 */
function countBetween(
  rule: RecurrenceRule,
  anchor: Date,
  first: Date,
  last: Date,
): { count: number; atLeast: boolean } {
  if ((rule.freq === "minutely" || rule.freq === "hourly") && !rule.count) {
    const step = Math.max(1, rule.interval ?? 1) * (rule.freq === "minutely" ? 60_000 : 3_600_000);
    return { count: Math.round((last.getTime() - first.getTime()) / step) + 1, atLeast: false };
  }
  const found = occurrences(rule, {
    from: first,
    to: new Date(last.getTime() + 1),
    anchor,
    limit: MISSED_COUNT_CAP,
  });
  return { count: found.length, atLeast: found.length >= MISSED_COUNT_CAP };
}

/**
 * Routines that came due (the runtime's tick). For each one, moving its next time and recording what it owes
 * happen in one transaction (the compare-and-swap on `nextFireAt` keeps two instances apart): after a fall at any
 * point, either the time is still due or its fire is recorded. The time that runs is the latest one already due;
 * the older ones missed while the server was off become one `missed` record with how many and from when to when.
 * The latest one itself, missed beyond the window, is `missed` under `skip`; under `once` it runs late, up to 7 days.
 */
export async function dueRoutines(deps: AppDeps): Promise<number> {
  const { db } = deps;
  const at = deps.now();
  const due = await db
    .select()
    .from(routines)
    .where(and(eq(routines.active, true), lte(routines.nextFireAt, at)))
    .orderBy(asc(routines.nextFireAt))
    .limit(50);
  let started = 0;
  for (const row of due) {
    const first = row.nextFireAt;
    if (!first) continue;
    const trigger = triggerOf(row);
    const policy = policyOf(row);
    const anchor = anchorOf(row);
    const rule = trigger.kind === "schedule" ? seriesRule(trigger.rule, anchor) : null;
    const after = new Date(at.getTime() + 1);
    const latest = rule ? (latestBefore(rule, anchor, after, first) ?? first) : first;
    const previous = rule && latest > first ? (latestBefore(rule, anchor, latest, first) ?? first) : null;
    const next = trigger.kind === "schedule" ? nextRunFor(trigger, at, anchor) : null;
    const kind = trigger.kind === "once" ? "once" : "schedule";
    const lateMs = at.getTime() - latest.getTime();
    const late = lateMs > policy.missedWindowMin * 60_000;
    const skipLatest = late && (policy.missed === "skip" || lateMs > CATCH_UP_MAX_MS);
    const fire = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(routines)
        // Without a next time ("once", a series that ended), the routine turns itself off: nothing more to run.
        .set({ nextFireAt: next, ...(next ? {} : { active: false, pausedReason: SERIES_ENDED }) })
        .where(
          and(eq(routines.id, row.id), sql`${routines.nextFireAt} = ${first.toISOString()}::timestamptz`),
        )
        .returning({ id: routines.id });
      if (!claimed) return null;
      const missed = (
        scheduledFor: Date,
        vars: Record<string, string | number>,
        count: number,
        atLeast = false,
      ) =>
        tx
          .insert(routineExecutions)
          .values({
            id: newId("rrun"),
            routineId: row.id,
            at,
            status: "skipped",
            trigger: kind,
            scheduledFor,
            reason: "missed",
            summary: `Missed ${atLeast ? "at least " : ""}${count} time(s) while the server was off`,
            summaryKey: "routines.run.missed",
            summaryVars: vars,
            finishedAt: at,
          })
          .onConflictDoNothing();
      if (rule && previous) {
        const { count, atLeast } = countBetween(rule, anchor, first, previous);
        await missed(
          previous,
          {
            count,
            from: first.toISOString(),
            to: previous.toISOString(),
            ...(atLeast ? { atLeast: 1 } : {}),
          },
          count,
          atLeast,
        );
      }
      if (skipLatest) {
        await missed(latest, { count: 1 }, 1);
        return null;
      }
      return insertFire(tx, at, row.id, {
        trigger: kind,
        scheduledFor: latest,
        ...(late ? { params: { lateMin: Math.round(lateMs / 60_000) } } : {}),
      });
    });
    if (!fire) continue;
    // A fall from here on leaves the fire `pending`: the queue's sweep runs it after PENDING_STALE_MS.
    deps.runtime.track(startRoutineRun(deps, fire), "routine.scheduled");
    started++;
  }
  return started;
}

/** A workspace event that fires routines (only what people do). The event's id is the dedupe key. */
export async function fireRoutineEvent(
  deps: AppDeps,
  input: {
    workspaceId: string;
    event: (typeof ROUTINE_EVENTS)[number];
    eventId: string;
    context: string;
    /** The channel the context comes from: a private one or a DM keeps it among the people who read it. */
    channelId?: string | null;
  },
) {
  const candidates = await deps.db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.workspaceId, input.workspaceId),
        eq(routines.active, true),
        sql`${routines.trigger}->>'kind' = 'event' and ${routines.trigger}->>'event' = ${input.event}`,
      ),
    );
  const rows = await keptInChannel(deps.db, candidates, input.workspaceId, input.channelId ?? null);
  for (const row of rows) {
    const reg = await registerFire(deps, row.id, {
      trigger: "event",
      key: `event:${input.event}:${input.eventId}`,
      context: { text: input.context },
    });
    if (!reg.duplicate) deps.runtime.track(startRoutineRun(deps, reg.run), "routine.event");
  }
}

/**
 * The routines an event's context may reach. A public channel's (or no channel's) reaches them all. A private
 * channel's or a DM's reaches only a routine whose creator reads that channel and that answers back in it or in
 * the creator's own DM with the agent, so its text never lands where someone outside the channel reads it.
 */
async function keptInChannel(
  db: Db,
  rows: RoutineRow[],
  workspaceId: string,
  channelId: string | null,
): Promise<RoutineRow[]> {
  if (channelId === null) return rows;
  const channel = await channelInWorkspace(db, workspaceId, channelId);
  if (channel?.kind === "channel" && channel.visibility === "public") return rows;
  const kept: RoutineRow[] = [];
  for (const row of rows) {
    const target = targetOf(row);
    const ownDm = target.kind === "dm" || target.kind === "conversation";
    if (!ownDm && !(target.kind === "channel" && target.channelId === channelId)) continue;
    if (await canReadChannel(db, { workspaceId, userId: row.createdBy, channelId })) kept.push(row);
  }
  return kept;
}

/** Who sees it: whoever created it; and everyone who reads the target channel or sees the workspace's Drive and debates. */
export async function canSeeRoutine(deps: AppDeps, me: WorkspaceMember, row: RoutineRow): Promise<boolean> {
  if (row.createdBy === me.userId || can(me.role, "configure")) return true;
  const target = targetOf(row);
  if (target.kind === "channel")
    return canReadChannel(deps.db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: target.channelId,
    });
  return target.kind === "file" || target.kind === "debate";
}
