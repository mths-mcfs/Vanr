// Dates as the work screens need them, in the browser's own time zone: the week a day falls in, the
// days of a week, the values of date and time inputs, and how a repeating rule reads in words.
import type { RecurrenceRule, Weekday } from "@vanr/contract";

const DAY_MS = 86_400_000;

/** The browser's time zone: where the person is, and what a new series repeats in. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Local midnight of the day. */
export function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/**
 * The start of the local day `days` later (or earlier). Counted on the date, not from the hour: a day whose
 * midnight is skipped by a change of clocks starts at 01:00, and the days after it start at 00:00 again.
 */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
}

/** Local midnight of the Monday the day falls in: weeks here run Monday to Sunday. */
export function startOfWeek(at: Date): Date {
  const day = startOfDay(at);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** The seven local days of the week that starts on `monday`. */
export function weekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, offset) => addDays(monday, offset));
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "2026-11-14": a local day, as a key and as a date input's value. */
export function dayKey(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** "2026-11-14T10:00": a datetime-local input's value. */
export function toLocalInput(at: Date): string {
  return `${dayKey(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A date or datetime-local input's value as a local moment; undefined while it isn't one. */
export function fromLocalInput(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (match === null) return undefined;
  const [, y, m, d, h = "0", min = "0"] = match;
  const at = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min));
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** The local days from `first` to `last` ("YYYY-MM-DD", both included), at most `limit` of them. */
export function daysBetween(first: string, last: string, limit = 62): string[] {
  const from = fromLocalInput(first);
  const to = fromLocalInput(last);
  if (from === undefined || to === undefined) return [];
  const out: string[] = [];
  for (let at = from; at <= to && out.length < limit; at = addDays(at, 1)) out.push(dayKey(at));
  return out;
}

export const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The rule code of a local day's weekday. */
export const weekdayOf = (at: Date): Weekday => WEEKDAYS[at.getDay()] ?? "MO";

/** A weekday's name in the language: from a known Sunday (2026-11-01) onward. */
export function weekdayName(day: Weekday, locale: string): string {
  const sunday = new Date(Date.UTC(2026, 10, 1, 12));
  const at = new Date(sunday.getTime() + WEEKDAYS.indexOf(day) * DAY_MS);
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(at);
}

export type RuleWords = {
  daily: (count: number) => string;
  dailyOn: (count: number, days: string) => string;
  weekdays: () => string;
  weekly: (count: number, days: string) => string;
  hourly: (count: number) => string;
  minutely: (count: number) => string;
  monthly: (count: number, days: string) => string;
  yearly: () => string;
  at: (rule: string, times: string) => string;
};

const WORKWEEK = ["MO", "TU", "WE", "TH", "FR"];

/** A repeating rule in words: "Every weekday at 09:00", "Every 2 weeks on Monday". */
export function describeRule(rule: RecurrenceRule, words: RuleWords, locale: string): string {
  const count = rule.interval ?? 1;
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const days = rule.weekdays ?? [];
  let text: string;
  // A daily or weekly rule limited to some days reads by its days: Monday to Friday is "every weekday".
  const someDays = days.length > 0 && days.length < 7;
  const workweek = days.length === 5 && WORKWEEK.every((day) => days.includes(day as Weekday));
  const named = () =>
    list.format(WEEKDAYS.filter((day) => days.includes(day)).map((day) => weekdayName(day, locale)));
  switch (rule.freq) {
    case "daily":
      text = !someDays
        ? words.daily(count)
        : count > 1
          ? words.dailyOn(count, named())
          : workweek
            ? words.weekdays()
            : words.weekly(1, named());
      break;
    case "weekly":
      text = count === 1 && workweek ? words.weekdays() : words.weekly(count, named());
      break;
    case "hourly":
      text = words.hourly(count);
      break;
    case "minutely":
      text = words.minutely(count);
      break;
    case "monthly":
      text = words.monthly(count, list.format((rule.byMonthDay ?? []).map(String)));
      break;
    default:
      text = words.yearly();
  }
  const times = rule.times ?? [];
  return times.length === 0 ? text : words.at(text, list.format(times));
}
