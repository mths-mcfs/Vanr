// Notification rules, the pure part: which tab a notice goes to, why, whether it breaks through the quiet and
// when it goes out by push and email. No database or Bun: the server decides with this and the web app shows
// the same reason.
//
// Deterministic rules, in this order:
// 1. An open request (`waiting`) always stays in "Action needed": an approval never disappears or gets demoted.
// 2. The person's first matching rule (kind, channel, agent) picks the tab.
// 3. Without a rule: the priority the notifier asked for, or the kind's default (DM and mention need you).
//
// Used by everything that notifies someone (through the server's `notify`).
import type {
  NotificationKind,
  NotificationPriority,
  NotificationReason,
  NotificationRule,
  NotificationSettings,
  NotificationTab,
  WorkStateName,
} from "@vanr/contract";

/** Default reason of each kind (the notifier may give a more precise one). */
export const REASON_OF_KIND: Record<NotificationKind, NotificationReason> = {
  mention: "mentioned",
  thread_followup: "thread_followup",
  dm: "dm",
  question_for_you: "question_raised",
  issue_ownership: "assigned",
  issue_discussion: "commented",
  issue_progress: "status_changed",
  debate_turn: "turn_requested",
  debate_synthesis: "synthesis_ready",
  approval: "approval_requested",
  assignment_finished: "assignment_finished",
  assignment_stopped: "assignment_stopped",
  routine_report: "routine_report",
  routine_alert: "routine_alert",
  runner_connected: "runner_connected",
  browser_intervention: "browser_intervention",
  reaction: "reacted",
};

/** Reasons that break through the quiet while the request is open. */
const CRITICAL_REASONS: ReadonlySet<NotificationReason> = new Set([
  "approval_requested",
  "question_raised",
  "agent_failed",
]);

/** Kinds that need you even without an open request: someone talked to you. */
const NEEDS_YOU_KINDS: ReadonlySet<NotificationKind> = new Set(["dm", "mention"]);

interface ClassifyInput {
  kind: NotificationKind;
  reason?: NotificationReason;
  priority?: NotificationPriority;
  waiting: boolean;
  channelId?: string | null;
  agentId?: string | null;
}

interface Classified {
  tab: NotificationTab;
  critical: boolean;
  reason: NotificationReason;
  ruleId: string | null;
}

export function ruleMatches(rule: NotificationRule, input: ClassifyInput): boolean {
  if (rule.kind && rule.kind !== input.kind) return false;
  if (rule.channelId && rule.channelId !== input.channelId) return false;
  if (rule.agentId && rule.agentId !== input.agentId) return false;
  return true;
}

export function classify(input: ClassifyInput, rules: readonly NotificationRule[]): Classified {
  const reason = input.reason ?? REASON_OF_KIND[input.kind];
  // Critical only with an open request: the notice of an approval already decided wakes nobody.
  const critical = input.waiting && (input.priority === "critical" || CRITICAL_REASONS.has(reason));
  if (input.waiting) return { tab: "action_needed", critical, reason, ruleId: null };
  const rule = rules.find((r) => ruleMatches(r, input));
  if (rule) return { tab: rule.tab, critical: false, reason, ruleId: rule.id };
  const tab: NotificationTab =
    input.priority === "critical" || input.priority === "action_needed"
      ? "action_needed"
      : input.priority === "fyi"
        ? "fyi"
        : NEEDS_YOU_KINDS.has(input.kind)
          ? "action_needed"
          : "fyi";
  return { tab, critical: false, reason, ruleId: null };
}

// ---- preferences ----

export const DEFAULT_SETTINGS: NotificationSettings = {
  push: true,
  email: true,
  emailDelayMinutes: 15,
  kinds: {},
  channels: {},
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  dndUntil: null,
  rules: [],
  locale: "pt-BR",
};

export const MAX_RULES = 50;

/**
 * Conservative default: only "Action needed" leaves the app. Push for everything in that tab; email only for
 * an open request (the "waiting on you" one). Kind and channel can turn it off, and email can be turned on for
 * DM and mention by kind. "FYI" never goes out by push or email (it goes to the digest).
 */
export function wantsChannel(
  channel: "push" | "email",
  n: { tab: NotificationTab; waiting: boolean; kind: NotificationKind; channelId?: string | null },
  s: NotificationSettings,
): boolean {
  if (n.tab !== "action_needed") return false;
  if (!s[channel]) return false;
  const byChannel = n.channelId ? s.channels[n.channelId]?.[channel] : undefined;
  if (byChannel === false) return false;
  const byKind = s.kinds[n.kind]?.[channel];
  if (byKind !== undefined) return byKind;
  if (byChannel === true) return true;
  return channel === "push" ? true : n.waiting;
}

// ---- quiet ----

/** "HH:MM" → minutes of the day; null if invalid. */
function parseClock(v: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const MINUTE = 60_000;
const DAY_MINUTES = 1440;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock formatter of the time zone; an invalid zone falls back to UTC. */
function wallFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    };
    try {
      f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
    }
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock at the minute `t` (epoch minutes) in the zone, as epoch minutes of that local date and time. */
function wallMinutes(t: number, tz: string): number {
  const parts = wallFormatter(tz).formatToParts(new Date(t * MINUTE));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) / MINUTE;
}

const offsetAt = (t: number, tz: string) => wallMinutes(t, tz) - t;
const minuteOfDay = (wall: number) => ((wall % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;

/**
 * First minute at or after `from` (epoch minutes) whose local clock is outside the window. Between two time
 * zone transitions the clock moves with real time, so the exit is exactly the minutes left to `end`; when a
 * transition falls inside that stretch, the walk restarts at the transition (found by bisection), where the
 * clock may jump over the end (a skipped hour) or back into the window (a repeated hour).
 */
function quietExit(from: number, tz: string, inside: (minute: number) => boolean, end: number): number {
  let t = from;
  for (let hop = 0; hop < 8; hop++) {
    const wall = wallMinutes(t, tz);
    if (!inside(minuteOfDay(wall))) return t;
    const next = t + ((end - minuteOfDay(wall) + DAY_MINUTES) % DAY_MINUTES);
    const offset = offsetAt(t, tz);
    if (offsetAt(next, tz) === offset) return next;
    let lo = t;
    let hi = next;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(mid, tz) === offset) lo = mid;
      else hi = mid;
    }
    t = hi;
  }
  return t;
}

/**
 * Until when the person is quiet at `now` (do not disturb or quiet hours), or null if not. The end of the quiet
 * hours is the first minute their local clock is outside the window, computed exactly in their time zone
 * (daylight saving switches included). A window with `start` equal to `end` is off, not a quiet without end.
 */
export function silenceUntil(s: NotificationSettings, tz: string, now: Date): Date | null {
  let until: Date | null = null;
  if (s.dndUntil) {
    const d = new Date(s.dndUntil);
    if (!Number.isNaN(d.getTime()) && d > now) until = d;
  }
  const q = s.quietHours;
  const start = parseClock(q.start);
  const end = parseClock(q.end);
  if (q.enabled && start !== null && end !== null && start !== end) {
    const inside = (m: number) => (start < end ? m >= start && m < end : m >= start || m < end);
    const from = Math.floor(now.getTime() / MINUTE);
    if (inside(minuteOfDay(wallMinutes(from, tz)))) {
      const quietEnd = new Date(quietExit(from, tz, inside, end) * MINUTE);
      if (!until || quietEnd > until) until = quietEnd;
    }
  }
  return until;
}

/**
 * When to send: now, or at the end of the quiet. Critical breaks through the quiet. Email waits for the delay
 * (the request may be seen in the app first).
 */
export function dueAt(
  channel: "push" | "email",
  n: { critical: boolean },
  s: NotificationSettings,
  tz: string,
  now: Date,
): Date {
  const base =
    channel === "email" ? new Date(now.getTime() + s.emailDelayMinutes * 60_000) : new Date(now.getTime());
  if (n.critical) return base;
  const quiet = silenceUntil(s, tz, base);
  return quiet && quiet > base ? quiet : base;
}

// ---- the request behind the notice (derived waiting) ----

/**
 * The request the notice stands for, read from the `groupKey`. The notice is "waiting on you" while the
 * request is open; the server checks the state in the database on create and on each tick, and closes what
 * was already handled.
 */
export type RequestRef =
  | { type: "approval"; id: string }
  | { type: "question"; id: string }
  | { type: "secret"; id: string }
  | { type: "intervention"; id: string }
  | { type: "debate_turn"; debateId: string }
  | { type: "assignment_command"; assignmentId: string; messageId: string }
  | { type: "assignment"; assignmentId: string };

export function requestOf(groupKey: string): RequestRef | null {
  const [head, a, b, c] = groupKey.split(":");
  if (!a) return null;
  switch (head) {
    case "approval":
      return { type: "approval", id: a };
    case "question":
      return { type: "question", id: a };
    case "secret":
      return { type: "secret", id: a };
    case "intervention":
      return { type: "intervention", id: a };
    case "debate_turn":
      return { type: "debate_turn", debateId: a };
    case "assignment":
      if (b === "approval" && c) return { type: "assignment_command", assignmentId: a, messageId: c };
      return { type: "assignment", assignmentId: a };
    default:
      return null;
  }
}

// ---- state shown in the inbox ----

export function notificationWorkState(n: { kind: NotificationKind; waiting: boolean }): WorkStateName | null {
  if (n.waiting) return "blocked_on_you";
  switch (n.kind) {
    case "routine_alert":
      return "failed";
    case "assignment_stopped":
      return "stopped";
    case "assignment_finished":
    case "routine_report":
      return "done";
    default:
      return null;
  }
}
