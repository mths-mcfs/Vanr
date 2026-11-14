// Recurrence rule (RecurrenceRule) of routines and the calendar: a subset of iCalendar RRULE, with local
// times in a time zone. All pure: takes dates and returns dates.
//
// - minutely/hourly step by `interval` from `start` (`times` does not apply).
// - daily/weekly/monthly/yearly walk day by day in the zone's local calendar; a day is in if it matches the
//   filters (weekdays, byMonthDay, byMonth, bySetPos) and the `interval` counted from `start`. Each day in
//   yields one occurrence per time in `times` (default: the time of `start`, or 09:00).
// - `until` and `count` bound the series; `count` counts from the beginning.
import type { RecurrenceRule, Weekday } from "@vanr/contract";

export const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_MS = 86_400_000;
/** Cap on days walked in one search (avoids a long loop with a rule that almost never matches). */
const MAX_DAYS = 366 * 12;
const MAX_STEPS = 200_000;

interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
}

interface LocalParts extends LocalDate {
  hh: number;
  mm: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Local date and time of an instant in the time zone. */
export function localParts(at: Date, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    y: parts.year ?? 1970,
    m: parts.month ?? 1,
    d: parts.day ?? 1,
    hh: (parts.hour ?? 0) % 24,
    mm: parts.minute ?? 0,
  };
}

/** Offset of the time zone from UTC, in ms, at the given instant. */
function offsetAt(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** Instant of a local date and time in the time zone. A time that does not exist (daylight saving) moves forward. */
export function zonedTime(date: LocalDate, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(date.y, date.m - 1, date.d, hh, mm);
  let at = guess - offsetAt(new Date(guess), tz);
  const second = guess - offsetAt(new Date(at), tz);
  if (second !== at) at = second;
  return new Date(at);
}

const dayNumber = (d: LocalDate) => Math.floor(Date.UTC(d.y, d.m - 1, d.d) / DAY_MS);
const fromDayNumber = (n: number): LocalDate => {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
/** 0 = Monday ... 6 = Sunday. */
const weekdayIndex = (n: number) => (((n + 3) % 7) + 7) % 7;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseTime(s: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh < 24 && mm < 60 ? { hh, mm } : null;
}

function anchorOf(rule: RecurrenceRule, fallback: Date): Date {
  const start = rule.start ? new Date(rule.start) : fallback;
  return Number.isNaN(start.getTime()) ? fallback : start;
}

function timesOf(rule: RecurrenceRule, anchor: Date): { hh: number; mm: number }[] {
  const parsed = (rule.times ?? []).map(parseTime).filter((t): t is { hh: number; mm: number } => !!t);
  if (parsed.length) return [...parsed].sort((a, b) => a.hh * 60 + a.mm - (b.hh * 60 + b.mm));
  if (rule.start) {
    const p = localParts(anchor, rule.timezone);
    return [{ hh: p.hh, mm: p.mm }];
  }
  return [{ hh: 9, mm: 0 }];
}

/** Is the day in the series? (not counting `times`, `until` and `count`) */
function dayMatches(rule: RecurrenceRule, day: number, anchorDay: number): boolean {
  const date = fromDayNumber(day);
  const anchor = fromDayNumber(anchorDay);
  const interval = Math.max(1, rule.interval ?? 1);
  const wd = WEEKDAYS[weekdayIndex(day)] as Weekday;
  const weekdays = rule.weekdays?.length ? rule.weekdays : null;
  const byMonthDay = rule.byMonthDay?.length ? rule.byMonthDay : null;
  const byMonth = rule.byMonth?.length ? rule.byMonth : null;
  if (byMonth && !byMonth.includes(date.m)) return false;
  switch (rule.freq) {
    case "daily":
      if ((day - anchorDay) % interval !== 0) return false;
      return !weekdays || weekdays.includes(wd);
    case "weekly": {
      const week = (n: number) => Math.floor((n - weekdayIndex(n)) / 7);
      if ((week(day) - week(anchorDay)) % interval !== 0) return false;
      const days = weekdays ?? [WEEKDAYS[weekdayIndex(anchorDay)] as Weekday];
      return days.includes(wd);
    }
    case "monthly":
    case "yearly": {
      const months = (date.y - anchor.y) * 12 + (date.m - anchor.m);
      if (rule.freq === "monthly" && months % interval !== 0) return false;
      if (rule.freq === "yearly") {
        if ((date.y - anchor.y) % interval !== 0) return false;
        if (!byMonth && date.m !== anchor.m) return false;
      }
      const dim = daysInMonth(date.y, date.m);
      if (weekdays) {
        if (!weekdays.includes(wd)) return false;
        if (!rule.bySetPos?.length) return true;
        // bySetPos: position of this day among the month's days that match weekdays (1 = first, -1 = last).
        const same: number[] = [];
        for (let dd = 1; dd <= dim; dd++) {
          const n = dayNumber({ y: date.y, m: date.m, d: dd });
          if (weekdays.includes(WEEKDAYS[weekdayIndex(n)] as Weekday)) same.push(dd);
        }
        const pos = same.indexOf(date.d);
        return rule.bySetPos.some((p) => (p > 0 ? pos === p - 1 : pos === same.length + p));
      }
      const days = byMonthDay ?? [anchor.d];
      return days.some((md) => (md > 0 ? md === date.d : dim + md + 1 === date.d));
    }
    default:
      return false;
  }
}

interface ExpandOptions {
  /** Only occurrences from here on (inclusive). */
  from: Date;
  /** Only occurrences before here (exclusive). */
  to?: Date;
  limit?: number;
  /** Used as the start when the rule has no `start`. */
  anchor?: Date;
}

/** Occurrences of the rule between `from` and `to`, in order. */
export function occurrences(rule: RecurrenceRule, opts: ExpandOptions): Date[] {
  const out: Date[] = [];
  const limit = opts.limit ?? 500;
  const anchor = anchorOf(rule, opts.anchor ?? opts.from);
  const until = rule.until ? new Date(rule.until) : null;
  const end = opts.to ?? null;
  const tz = rule.timezone;
  let produced = 0;
  const push = (at: Date): boolean => {
    if (at < anchor) return true;
    if (until && at > until) return false;
    if (end && at >= end) return false;
    produced++;
    if (rule.count && produced > rule.count) return false;
    if (at >= opts.from) out.push(at);
    return out.length < limit;
  };

  if (rule.freq === "minutely" || rule.freq === "hourly") {
    const step = Math.max(1, rule.interval ?? 1) * (rule.freq === "minutely" ? 60_000 : 3_600_000);
    // Without `count`, jump straight to near `from`.
    let t = anchor.getTime();
    if (!rule.count && opts.from.getTime() > t) t += Math.floor((opts.from.getTime() - t) / step) * step;
    for (let i = 0; i < MAX_STEPS; i++, t += step) if (!push(new Date(t))) break;
    return out;
  }

  const times = timesOf(rule, anchor);
  const anchorDay = dayNumber(localParts(anchor, tz));
  // With `count` it has to count from the beginning; without it, start one day before `from`.
  const fromDay = dayNumber(localParts(opts.from, tz)) - 1;
  const first = rule.count ? anchorDay : Math.max(anchorDay, fromDay);
  for (let day = first; day < first + MAX_DAYS; day++) {
    if (!dayMatches(rule, day, anchorDay)) continue;
    const date = fromDayNumber(day);
    let go = true;
    for (const t of times) {
      go = push(zonedTime(date, t.hh, t.mm, tz));
      if (!go) break;
    }
    if (!go) break;
    if (end && zonedTime(date, 0, 0, tz) >= end) break;
  }
  return out;
}

/** The next `n` runs after `after` (exclusive). */
export function nextRuns(rule: RecurrenceRule, after: Date, n = 1): Date[] {
  return occurrences(rule, { from: new Date(after.getTime() + 1), limit: n, anchor: after });
}

/** Validation errors with a translatable code. */
export function validateRule(rule: RecurrenceRule): string | null {
  if (!isTimezone(rule.timezone)) return "rule.timezone";
  if (rule.interval !== undefined && (!Number.isInteger(rule.interval) || rule.interval < 1)) {
    return "rule.interval";
  }
  if (rule.freq === "minutely" && (rule.interval ?? 1) < 5) return "rule.too_often";
  if (rule.times?.some((t) => !parseTime(t))) return "rule.time";
  if (rule.byMonthDay?.some((d) => d === 0 || d > 31 || d < -31)) return "rule.month_day";
  if (rule.byMonth?.some((m) => m < 1 || m > 12)) return "rule.month";
  if (rule.start && Number.isNaN(Date.parse(rule.start))) return "rule.start";
  if (rule.until && Number.isNaN(Date.parse(rule.until))) return "rule.until";
  return null;
}
