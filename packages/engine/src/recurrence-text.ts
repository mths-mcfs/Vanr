// Recurrence rules as text: describe them ("Toda segunda às 09:00") and understand simple phrases in
// Portuguese and English ("dias úteis às 8h", "every 2 hours", "última sexta do mês às 17h").
// What it does not understand returns an error code; the screen shows the translated code.
import type { RecurrenceRule, Weekday } from "@vanr/contract";
import { localParts, nextRuns, validateRule, zonedTime } from "./recurrence";

type TextLocale = "pt-BR" | "en";

const DAY_NAMES: Record<TextLocale, Record<Weekday, string>> = {
  "pt-BR": {
    MO: "segunda",
    TU: "terça",
    WE: "quarta",
    TH: "quinta",
    FR: "sexta",
    SA: "sábado",
    SU: "domingo",
  },
  en: {
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
    SU: "Sunday",
  },
};
const MONTHS: Record<TextLocale, string[]> = {
  "pt-BR": [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};
const POS: Record<TextLocale, Record<string, string>> = {
  "pt-BR": { "1": "primeira", "2": "segunda", "3": "terceira", "4": "quarta", "-1": "última" },
  en: { "1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last" },
};
const WORKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

const join = (items: string[], locale: TextLocale) => {
  if (items.length <= 1) return items.join("");
  const and = locale === "en" ? " and " : " e ";
  return `${items.slice(0, -1).join(", ")}${and}${items[items.length - 1]}`;
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Toda segunda e quarta às 09:00", "Every 2 hours". */
export function describeRule(rule: RecurrenceRule, locale: TextLocale): string {
  const pt = locale === "pt-BR";
  const n = Math.max(1, rule.interval ?? 1);
  const times = rule.times?.length ? rule.times : null;
  const at = times ? (pt ? ` às ${join(times, locale)}` : ` at ${join(times, locale)}`) : "";
  const days = (list: Weekday[]) =>
    join(
      list.map((d) => DAY_NAMES[locale][d]),
      locale,
    );
  let text: string;
  switch (rule.freq) {
    case "minutely":
      text = pt ? `a cada ${n} minutos` : `every ${n} minutes`;
      break;
    case "hourly":
      text = n === 1 ? (pt ? "a cada hora" : "every hour") : pt ? `a cada ${n} horas` : `every ${n} hours`;
      break;
    case "daily": {
      const wd = rule.weekdays ?? [];
      if (n === 1 && wd.length === 5 && WORKDAYS.every((d) => wd.includes(d))) {
        text = pt ? `dias úteis${at}` : `weekdays${at}`;
      } else if (wd.length) {
        text = pt ? `toda ${days(wd)}${at}` : `every ${days(wd)}${at}`;
      } else {
        text =
          n === 1
            ? pt
              ? `todo dia${at}`
              : `every day${at}`
            : pt
              ? `a cada ${n} dias${at}`
              : `every ${n} days${at}`;
      }
      break;
    }
    case "weekly": {
      const wd = rule.weekdays?.length ? rule.weekdays : null;
      const which = wd ? days(wd) : pt ? "semana" : "week";
      if (n === 1)
        text = wd
          ? pt
            ? `toda ${which}${at}`
            : `every ${which}${at}`
          : pt
            ? `toda semana${at}`
            : `every week${at}`;
      else
        text = pt
          ? `a cada ${n} semanas${wd ? ` (${which})` : ""}${at}`
          : `every ${n} weeks${wd ? ` on ${which}` : ""}${at}`;
      break;
    }
    case "monthly": {
      const every =
        n === 1 ? (pt ? "todo mês" : "every month") : pt ? `a cada ${n} meses` : `every ${n} months`;
      if (rule.weekdays?.length && rule.bySetPos?.length) {
        const pos = rule.bySetPos.map((p) => POS[locale][String(p)] ?? String(p));
        text = pt
          ? `${join(pos, locale)} ${days(rule.weekdays)} do mês${n > 1 ? `, ${every}` : ""}${at}`
          : `the ${join(pos, locale)} ${days(rule.weekdays)} of ${n > 1 ? `${every}` : "the month"}${at}`;
      } else {
        const md = (rule.byMonthDay ?? []).map((d) =>
          d === -1 ? (pt ? "último dia" : "last day") : String(d),
        );
        text = md.length
          ? pt
            ? `${every} no dia ${join(md, locale)}${at}`
            : `${every} on day ${join(md, locale)}${at}`
          : `${every}${at}`;
      }
      break;
    }
    case "yearly": {
      const months = (rule.byMonth ?? []).map((m) => MONTHS[locale][m - 1] ?? String(m));
      const md = rule.byMonthDay?.length ? join(rule.byMonthDay.map(String), locale) : "";
      const when = months.length
        ? pt
          ? ` em ${md ? `${md} de ` : ""}${join(months, locale)}`
          : ` in ${join(months, locale)}${md ? ` on day ${md}` : ""}`
        : "";
      text =
        n === 1
          ? `${pt ? "todo ano" : "every year"}${when}${at}`
          : `${pt ? `a cada ${n} anos` : `every ${n} years`}${when}${at}`;
      break;
    }
  }
  if (rule.count) text += pt ? `, ${rule.count} vezes` : `, ${rule.count} times`;
  if (rule.until) text += pt ? `, até ${rule.until.slice(0, 10)}` : `, until ${rule.until.slice(0, 10)}`;
  return capital(text);
}

// ---- Phrases ----

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const DAY_WORDS: [RegExp, Weekday][] = [
  [/\b(segunda|segundas|seg|monday|mondays|mon)\b/, "MO"],
  [/\b(terca|tercas|ter|tuesday|tuesdays|tue)\b/, "TU"],
  [/\b(quarta|quartas|qua|wednesday|wednesdays|wed)\b/, "WE"],
  [/\b(quinta|quintas|qui|thursday|thursdays|thu)\b/, "TH"],
  [/\b(sexta|sextas|sex|friday|fridays|fri)\b/, "FR"],
  [/\b(sabado|sabados|sab|saturday|saturdays|sat)\b/, "SA"],
  [/\b(domingo|domingos|dom|sunday|sundays|sun)\b/, "SU"],
];

/** Times mentioned in the phrase: "às 9h", "at 9:30am", "17:00", "8 e 14h". */
function timesIn(text: string): string[] | null {
  const out: string[] = [];
  const re = /(?:^|\s|,|as |at |@)(\d{1,2})(?:(?::|h)(\d{2}))?\s*(am|pm|h)?(?=\s|,|$|\.)/g;
  const marker = /\b(as|at|@|h\b|am\b|pm\b)|\d:\d/.test(text);
  if (!marker) return null;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    if (!/(as |at |@|:|h|am|pm)/.test(raw)) continue;
    let hh = Number(m[1]);
    const mm = Number(m[2] ?? "0");
    if (m[3] === "pm" && hh < 12) hh += 12;
    if (m[3] === "am" && hh === 12) hh = 0;
    if (hh > 23 || mm > 59) return [];
    out.push(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
  }
  return out.length ? [...new Set(out)] : null;
}

type ParsedRule = { ok: true; rule: RecurrenceRule } | { ok: false; code: string };

/** Understands repetition phrases. No AI: only the most common forms, in pt and en. */
export function parseRulePhrase(phrase: string, timezone: string): ParsedRule {
  const text = normalize(phrase);
  if (!text) return { ok: false, code: "rule.empty" };
  const times = timesIn(text);
  if (times && times.length === 0) return { ok: false, code: "rule.time" };
  const withTimes = (rule: RecurrenceRule): ParsedRule => {
    const r = times && rule.freq !== "minutely" && rule.freq !== "hourly" ? { ...rule, times } : rule;
    const err = validateRule(r);
    return err ? { ok: false, code: err } : { ok: true, rule: r };
  };

  let m = /\b(?:a cada|every) (\d+) ?(minutos?|min|minutes?|mins?)\b/.exec(text);
  if (m) return withTimes({ freq: "minutely", interval: Number(m[1]), timezone });
  m = /\b(?:a cada|every) (\d+) ?(horas?|h|hours?|hrs?)\b/.exec(text);
  if (m) return withTimes({ freq: "hourly", interval: Number(m[1]), timezone });
  if (/\b(a cada hora|de hora em hora|every hour|hourly)\b/.test(text)) {
    return withTimes({ freq: "hourly", timezone });
  }

  const days = DAY_WORDS.filter(([re]) => re.test(text)).map(([, d]) => d);
  // "segunda" is a day and also an ordinal ("segunda sexta do mês"): with "do mes"/"of the month" it becomes a position.
  const monthly = /\b(do mes|de cada mes|of the month|of every month|each month)\b/.test(text);
  const pos = /\b(primeir[oa]|first|1st)\b/.test(text)
    ? 1
    : /\b(terceir[oa]|third|3rd)\b/.test(text)
      ? 3
      : /\b(quart[oa] (?:segunda|terca|quarta|quinta|sexta|sabado|domingo)|fourth|4th)\b/.test(text)
        ? 4
        : /\b(ultim[oa]|last)\b/.test(text)
          ? -1
          : /\b(second|2nd)\b|\bsegunda (?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/.test(text)
            ? 2
            : null;
  if (monthly && pos !== null && days.length) {
    // In the phrase "segunda sexta", the first "segunda" is the position, not the day.
    const ordinal = pos === 2 ? "MO" : pos === 4 ? "WE" : null;
    const word = pos === 2 ? "segunda" : "quarta";
    const asOrdinal = new RegExp(`\\b${word} (segunda|terca|quarta|quinta|sexta|sabado|domingo)\\b`);
    const realDays =
      ordinal && asOrdinal.test(text) && !new RegExp(`\\b${word} ${word}\\b`).test(text)
        ? days.filter((d) => d !== ordinal)
        : days;
    return withTimes({ freq: "monthly", weekdays: realDays, bySetPos: [pos], timezone });
  }

  m =
    /\b(?:todo mes|mensalmente|every month|monthly)(?: no| on)?(?: dia| day| the)? (\d{1,2})\b/.exec(text) ??
    /\b(?:todo|todos os) dias? (\d{1,2}) (?:do mes|de cada mes)\b/.exec(text) ??
    /\b(?:on the )?(\d{1,2})(?:st|nd|rd|th) (?:of )?(?:every|each) month\b/.exec(text);
  if (m) return withTimes({ freq: "monthly", byMonthDay: [Number(m[1])], timezone });
  if (/\b(ultimo dia do mes|last day of (the|every) month)\b/.test(text)) {
    return withTimes({ freq: "monthly", byMonthDay: [-1], timezone });
  }

  if (
    /\b(dias uteis|dia util|de segunda a sexta|weekdays|every weekday|monday to friday|mon-fri)\b/.test(text)
  ) {
    m = /\b(?:a cada|every) (\d+) ?(dias?|days?|semanas?|weeks?)\b/.exec(text);
    if (!m && /\b(?:a cada|every) \d+\b/.test(text)) return { ok: false, code: "rule.not_understood" };
    return withTimes({
      freq: m && /^(semana|week)/.test(m[2] ?? "") ? "weekly" : "daily",
      ...(m ? { interval: Number(m[1]) } : {}),
      weekdays: [...WORKDAYS],
      timezone,
    });
  }
  m = /\b(?:a cada|every) (\d+) ?(semanas?|weeks?)\b/.exec(text);
  if (m)
    return withTimes({
      freq: "weekly",
      interval: Number(m[1]),
      ...(days.length ? { weekdays: days } : {}),
      timezone,
    });
  if (days.length && /\b(toda|todo|todas|todos|every|each|on|as|aos|nas|nos)\b/.test(text)) {
    return withTimes({ freq: "weekly", weekdays: days, timezone });
  }
  if (/\b(semanalmente|toda semana|weekly|every week)\b/.test(text)) {
    return withTimes({ freq: "weekly", ...(days.length ? { weekdays: days } : {}), timezone });
  }
  m = /\b(?:a cada|every) (\d+) ?(dias?|days?)\b/.exec(text);
  if (m) return withTimes({ freq: "daily", interval: Number(m[1]), timezone });
  if (/\b(todo dia|todos os dias|diariamente|every day|daily|each day)\b/.test(text)) {
    return withTimes({ freq: "daily", timezone });
  }
  if (/\b(todo ano|anualmente|every year|yearly|annually)\b/.test(text))
    return withTimes({ freq: "yearly", timezone });
  return { ok: false, code: "rule.not_understood" };
}

type ParsedSchedule =
  | { ok: true; kind: "schedule"; rule: RecurrenceRule }
  | { ok: true; kind: "once"; at: Date }
  | { ok: false; code: string };

/**
 * Scheduling phrase: once ("amanhã às 9h", "em 2 horas", "tomorrow at 9am") or repeated (the rest goes to
 * parseRulePhrase).
 */
export function parseSchedulePhrase(phrase: string, timezone: string, now: Date): ParsedSchedule {
  const text = normalize(phrase);
  const m = /^(?:em|daqui a|in) (\d+) ?(minutos?|min|minutes?|horas?|h|hours?|dias?|days?)$/.exec(text);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] ?? "";
    const ms = unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
    return { ok: true, kind: "once", at: new Date(now.getTime() + n * ms) };
  }
  const day = /\b(hoje|today)\b/.test(text) ? 0 : /\b(amanha|tomorrow)\b/.test(text) ? 1 : null;
  if (day !== null) {
    const times = timesIn(text);
    if (times?.length !== 1) return { ok: false, code: "rule.time" };
    const [hh, mm] = (times[0] as string).split(":").map(Number);
    const local = localParts(now, timezone);
    const base = new Date(Date.UTC(local.y, local.m - 1, local.d + day));
    const at = zonedTime(
      { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() },
      hh ?? 0,
      mm ?? 0,
      timezone,
    );
    if (at <= now) return { ok: false, code: "rule.past" };
    return { ok: true, kind: "once", at };
  }
  const parsed = parseRulePhrase(phrase, timezone);
  return parsed.ok ? { ok: true, kind: "schedule", rule: parsed.rule } : parsed;
}

/** Next runs as ISO strings, for display. */
export const upcoming = (rule: RecurrenceRule, now: Date, n = 3) =>
  nextRuns(rule, now, n).map((d) => d.toISOString());
