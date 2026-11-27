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
      era: "short",
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

/**
 * Instant of a UTC date and time. `Date.UTC` maps years 0 to 99 to 1900 to 1999; this keeps the year as
 * given. Month (0-based) and day overflow carry over as in `Date.UTC`.
 */
function utcMs(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  const at = new Date(0);
  at.setUTCFullYear(y, m, d);
  at.setUTCHours(hh, mm, ss, 0);
  return at.getTime();
}

/** Local parts of an instant, with the astronomical year (1 BC is year 0) and the seconds. */
function wallParts(at: Date, tz: string): LocalParts & { ss: number } {
  const parts: Record<string, number> = {};
  let bc = false;
  for (const p of formatter(tz).formatToParts(at)) {
    if (p.type === "era") bc = p.value === "BC";
    else if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const year = parts.year ?? 1970;
  return {
    y: bc ? 1 - year : year,
    m: parts.month ?? 1,
    d: parts.day ?? 1,
    hh: (parts.hour ?? 0) % 24,
    mm: parts.minute ?? 0,
    ss: parts.second ?? 0,
  };
}

/** Local date and time of an instant in the time zone. */
export function localParts(at: Date, tz: string): LocalParts {
  const { y, m, d, hh, mm } = wallParts(at, tz);
  return { y, m, d, hh, mm };
}

/** The day exists in the calendar (no February 31, month 1 to 12). */
function isCalendarDay(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * Instant of a rule's `start` or `until`, or null if it is not a date. An ISO date whose day does not exist
 * (`2026-02-31`) is not a date: `Date.parse` would roll it over into March.
 */
function parseInstant(text: string): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (iso && !isCalendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

/** Offset of the time zone from UTC, in ms, at the given instant (to the second: old local mean times). */
function offsetAt(at: Date, tz: string): number {
  const p = wallParts(at, tz);
  return utcMs(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Instant of a local date and time in the time zone. The offsets a day before and a day after bound the
 * candidates: a time in the repeated hour (daylight saving ends) is its first occurrence, so a series runs
 * once; a time that does not exist (daylight saving starts) moves forward to the first valid instant after
 * the gap, the transition itself.
 */
export function zonedTime(date: LocalDate, hh: number, mm: number, tz: string): Date {
  const wall = utcMs(date.y, date.m - 1, date.d, hh, mm);
  const before = offsetAt(new Date(wall - DAY_MS), tz);
  const after = offsetAt(new Date(wall + DAY_MS), tz);
  const shows = (at: number) => at + offsetAt(new Date(at), tz) === wall;
  const valid = [wall - before, wall - after].filter(shows).sort((x, y) => x - y);
  if (valid[0] !== undefined) return new Date(valid[0]);
  // In the gap: before the transition the clock is still behind `wall`, after it already past. Bisect the
  // transition minute.
  let lo = Math.min(wall - before, wall - after);
  let hi = Math.max(wall - before, wall - after);
  const offsetLo = offsetAt(new Date(lo), tz);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (offsetAt(new Date(mid), tz) === offsetLo) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

const dayNumber = (d: LocalDate) => Math.floor(utcMs(d.y, d.m - 1, d.d) / DAY_MS);
const fromDayNumber = (n: number): LocalDate => {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
/** 0 = Monday ... 6 = Sunday. */
const weekdayIndex = (n: number) => (((n + 3) % 7) + 7) % 7;
function daysInMonth(y: number, m: number): number {
  return new Date(utcMs(y, m, 0)).getUTCDate();
}

function parseTime(s: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh < 24 && mm < 60 ? { hh, mm } : null;
}

function anchorOf(rule: RecurrenceRule, fallback: Date): Date {
  const start = rule.start ? parseInstant(rule.start) : null;
  return start === null ? fallback : new Date(start);
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
  const dim = daysInMonth(date.y, date.m);
  const monthDayMatches = (d: number) =>
    !byMonthDay || byMonthDay.some((md) => (md > 0 ? md === d : dim + md + 1 === d));
  if (!monthDayMatches(date.d)) return false;
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
      const matches = (d: number) =>
        monthDayMatches(d) &&
        (weekdays
          ? weekdays.includes(WEEKDAYS[weekdayIndex(dayNumber({ ...date, d }))] as Weekday)
          : !!byMonthDay || d === anchor.d);
      if (!matches(date.d)) return false;
      if (!rule.bySetPos?.length) return true;
      // Position among the month's days that satisfy every calendar filter.
      const same: number[] = [];
      for (let d = 1; d <= dim; d++) {
        if (matches(d)) same.push(d);
      }
      const pos = same.indexOf(date.d);
      return rule.bySetPos.some((p) => (p > 0 ? pos === p - 1 : pos === same.length + p));
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
  const untilMs = rule.until ? parseInstant(rule.until) : null;
  const until = untilMs === null ? null : new Date(untilMs);
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
  // Times that fall in the daylight saving gap land on the same instant (the transition): one instant of the
  // rule is one occurrence, for `count`, `until` and the next run. Instants only grow (times are sorted).
  let last = Number.NEGATIVE_INFINITY;
  for (let day = first; day < first + MAX_DAYS; day++) {
    if (!dayMatches(rule, day, anchorDay)) continue;
    const date = fromDayNumber(day);
    let go = true;
    for (const t of times) {
      const at = zonedTime(date, t.hh, t.mm, tz);
      if (at.getTime() <= last) continue;
      last = at.getTime();
      go = push(at);
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
  if (rule.start && parseInstant(rule.start) === null) return "rule.start";
  if (rule.until && parseInstant(rule.until) === null) return "rule.until";
  return null;
}
