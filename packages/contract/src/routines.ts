// Routines: schedules, triggers, policies and runs.

export type Weekday = "FR" | "MO" | "SA" | "SU" | "TH" | "TU" | "WE";

export interface RecurrenceRule {
  byMonth?: number[];
  byMonthDay?: number[];
  bySetPos?: number[];
  count?: number;
  freq: "daily" | "hourly" | "minutely" | "monthly" | "weekly" | "yearly";
  interval?: number;
  start?: string;
  times?: string[];
  timezone: string;
  until?: string;
  weekdays?: Weekday[];
}

/** Email trigger filter: every condition present must match. */
export interface RoutineEmailFilter {
  /** Addresses or @domains. */
  from?: string[];
  subject?: string;
  text?: string;
}

export type RoutineTrigger =
  | { kind: "schedule"; rule: RecurrenceRule }
  | { at: string; kind: "once"; timezone: string }
  | { event: string; kind: "event" }
  | {
      accountId: string;
      filter?: RoutineEmailFilter;
      folder: string;
      kind: "email";
      /** Response only: the mailbox went down or was disconnected. */
      status?: "active" | "disconnected" | "reauth_required";
    }
  | { kind: "webhook" };

export type RoutineTarget =
  | { channelId: string; kind: "channel" }
  | { kind: "dm" }
  | { kind: "file" }
  | { agentIds: string[]; kind: "debate"; roundLimit: number }
  | { kind: "conversation" };

/**
 * `pending`: registered, waiting its turn; `queued`: waiting for the previous one to finish or for the
 * retry time; `running`: running. The rest are final.
 */
export type RoutineRunStatus = "failed" | "ok" | "pending" | "queued" | "running" | "silent" | "skipped";

/** What triggered the run. */
export type RoutineRunTrigger = "email" | "event" | "manual" | "once" | "retry" | "schedule" | "webhook";

/**
 * Routine rules. `missed`: a slot missed beyond the window (server down) is skipped or runs once;
 * `overlap`: a trigger while the previous run is still going is skipped or waits (at most one queued).
 * Hard limits per run: spend (USD), model turns and minutes. A failure runs again up to `retries` times,
 * with growing backoff; after `pauseAfterFailures` consecutive failed runs the routine pauses itself
 * (0 turns this off).
 */
export interface RoutinePolicy {
  maxCostUsd: number;
  maxMinutes: number;
  maxSteps: number;
  missed: "once" | "skip";
  missedWindowMin: number;
  overlap: "queue" | "skip";
  pauseAfterFailures: number;
  retries: number;
}

export interface Routine {
  id: string;
  active: boolean;
  agentId: string;
  createdAt: string;
  createdBy: string;
  lastRun: { at: string; status: RoutineRunStatus } | null;
  name: string;
  nextFireAt: string | null;
  /** Why it turned itself off (`failures`: N failures in a row). */
  pausedReason: "failures" | null;
  policy: RoutinePolicy;
  prompt: string;
  recentFires: { at: string; status: RoutineRunStatus }[];
  running: boolean;
  target: RoutineTarget;
  trigger: RoutineTrigger;
  /** The webhook already has a secret (the secret itself is shown only once, in `webhookSecret`). */
  webhookHasSecret: boolean;
  /** Webhook address. Not a credential: the request must be signed with the secret. */
  webhookUrl: string | null;
}

export interface RoutineInput {
  /** Creating it enabled is an explicit choice; without it the routine starts paused. */
  active?: boolean;
  agentId: string;
  name?: string;
  policy?: Partial<RoutinePolicy>;
  prompt: string;
  target: RoutineTarget;
  trigger: RoutineTrigger;
}

export interface RoutineRun {
  id: string;
  at: string;
  attempt: number;
  /** The session: channel and thread where the agent worked, the message and the run. */
  channelId: string | null;
  finishedAt: string | null;
  messageId: string | null;
  /** When the retry or the queued run happens. */
  notBefore: string | null;
  /** Reason for the skip or failure: missed, overlap, paused, budget, routine_budget, step_limit, time_limit, interrupted, busy... */
  reason: string | null;
  runId: string | null;
  /** Scheduled time (schedule and "once"). */
  scheduledFor: string | null;
  startedAt: string | null;
  status: RoutineRunStatus;
  summary: string | null;
  summaryKey: string | null;
  summaryVars: Record<string, string | number> | null;
  threadId: string | null;
  trigger: RoutineRunTrigger | null;
}

export interface RuleInfo {
  code: string | null;
  description: string | null;
  error: string | null;
  ok: boolean;
  rule: RecurrenceRule | null;
  upcomingFireTimes: string[];
}

export interface ScheduleParse {
  description: string | null;
  error: string | null;
  ok: boolean;
  trigger: RoutineTrigger | null;
  upcomingFireTimes: string[];
}

/**
 * Cost of running the routine. `upToUsd`: the cap when there is one (document: one call; debate: the
 * debate's cap); a conversation in a channel has no fixed cap. `recent`: what the latest runs actually
 * cost, from the ledger.
 */
export interface RoutineEstimate {
  calls: number | null;
  recent: { avgUsd: number; maxUsd: number; runs: number } | null;
  upToUsd: number | null;
}

/** The webhook's address and secret; the secret is shown only in this answer. */
export interface RoutineWebhookSecret {
  secret: string;
  url: string;
}

/** What the webhook answers: the execution it recorded, or the same message seen before. */
export type RoutineWebhookResult = { ok: true; runId: string } | { duplicate: true; ok: true };

/** "Run now". With the client's key, the same request repeated (a double click, a resend) runs once. */
export interface RoutineRunBody {
  key?: string;
}

export interface RoutineDuplicateBody {
  name?: string;
}

export interface ParseScheduleBody {
  phrase: string;
  timezone: string;
}

export interface ParseRuleBody {
  phrase: string;
  timezone?: string;
}

export interface DescribeRuleBody {
  rule: RecurrenceRule;
}
