import { describe, expect, test } from "bun:test";
import type { RecurrenceRule } from "@vanr/contract";
import { nextRuns, occurrences, validateRule, zonedTime } from "./recurrence";
import { describeRule, parseRulePhrase, parseSchedulePhrase } from "./recurrence-text";

const SP = "America/Sao_Paulo";
const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe("occurrences", () => {
  test.each(["daily", "weekly", "monthly", "yearly"] as const)(
    "%s intersects weekdays, month and positive/negative month days",
    (freq) => {
      const rule: RecurrenceRule = {
        freq,
        timezone: "UTC",
        start: "2026-01-01T09:00:00Z",
        byMonth: [4],
        byMonthDay: [15, -1],
        weekdays: ["MO", "TU", "WE", "TH", "FR"],
      };
      expect(validateRule(rule)).toBeNull();
      expect(iso(nextRuns(rule, new Date("2026-01-01T00:00:00Z"), 2))).toEqual([
        "2026-04-15T09:00:00.000Z",
        "2026-04-30T09:00:00.000Z",
      ]);
    },
  );

  test.each(["monthly", "yearly"] as const)("%s applies set positions after all calendar filters", (freq) => {
    for (const weekdays of [undefined, ["MO", "TU", "WE", "TH", "FR"] satisfies RecurrenceRule["weekdays"]]) {
      const rule: RecurrenceRule = {
        freq,
        timezone: "UTC",
        start: "2026-01-01T09:00:00Z",
        byMonth: [4],
        byMonthDay: [1, 15, -2],
        bySetPos: [-1],
        weekdays,
      };
      expect(iso(nextRuns(rule, new Date("2026-01-01T00:00:00Z"), 1))).toEqual(["2026-04-29T09:00:00.000Z"]);
    }
  });

  test("a weekly month-day filter keeps the anchor weekday when weekdays is absent", () => {
    expect(
      iso(
        nextRuns(
          {
            freq: "weekly",
            timezone: "UTC",
            start: "2026-01-01T09:00:00Z",
            byMonth: [4],
            byMonthDay: [1, -1],
          },
          new Date("2026-01-01T00:00:00Z"),
          1,
        ),
      ),
    ).toEqual(["2026-04-30T09:00:00.000Z"]);
  });

  test("every day at 9:00 in the São Paulo time zone (UTC-3)", () => {
    const rule: RecurrenceRule = { freq: "daily", times: ["09:00"], timezone: SP };
    const got = nextRuns(rule, new Date("2026-10-20T13:00:00Z"), 3);
    expect(iso(got)).toEqual([
      "2026-10-21T12:00:00.000Z",
      "2026-10-22T12:00:00.000Z",
      "2026-10-23T12:00:00.000Z",
    ]);
  });

  test("weekdays skip the weekend", () => {
    const rule: RecurrenceRule = {
      freq: "daily",
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      times: ["08:00"],
      timezone: "UTC",
    };
    // 2026-10-23 is a Friday.
    const got = nextRuns(rule, new Date("2026-10-23T09:00:00Z"), 2);
    expect(iso(got)).toEqual(["2026-10-26T08:00:00.000Z", "2026-10-27T08:00:00.000Z"]);
  });

  test("every 2 weeks on Monday, counting from the start week", () => {
    const rule: RecurrenceRule = {
      freq: "weekly",
      interval: 2,
      weekdays: ["MO"],
      times: ["10:00"],
      timezone: "UTC",
      start: "2026-10-19T10:00:00Z",
    };
    const got = occurrences(rule, { from: new Date("2026-10-19T00:00:00Z"), limit: 3 });
    expect(iso(got)).toEqual([
      "2026-10-19T10:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
      "2026-11-16T10:00:00.000Z",
    ]);
  });

  test("last Friday of the month, and day 31 that does not exist in every month", () => {
    const last: RecurrenceRule = {
      freq: "monthly",
      weekdays: ["FR"],
      bySetPos: [-1],
      times: ["17:00"],
      timezone: "UTC",
    };
    expect(iso(nextRuns(last, new Date("2026-10-01T00:00:00Z"), 2))).toEqual([
      "2026-10-30T17:00:00.000Z",
      "2026-11-27T17:00:00.000Z",
    ]);
    const day31: RecurrenceRule = { freq: "monthly", byMonthDay: [31], times: ["09:00"], timezone: "UTC" };
    expect(iso(nextRuns(day31, new Date("2026-10-01T00:00:00Z"), 2))).toEqual([
      "2026-10-31T09:00:00.000Z",
      "2026-12-31T09:00:00.000Z",
    ]);
  });

  test("count counts from the start and until cuts the series", () => {
    const rule: RecurrenceRule = { freq: "daily", count: 3, timezone: "UTC", start: "2026-10-01T09:00:00Z" };
    expect(occurrences(rule, { from: new Date("2026-10-02T00:00:00Z") }).length).toBe(2);
    const until: RecurrenceRule = {
      freq: "daily",
      until: "2026-10-03T23:59:00Z",
      timezone: "UTC",
      start: "2026-10-01T09:00:00Z",
    };
    expect(occurrences(until, { from: new Date("2026-10-01T00:00:00Z") }).length).toBe(3);
  });

  test("every 2 hours from the start", () => {
    const rule: RecurrenceRule = {
      freq: "hourly",
      interval: 2,
      timezone: "UTC",
      start: "2026-10-20T00:30:00Z",
    };
    expect(iso(nextRuns(rule, new Date("2026-10-20T03:00:00Z"), 2))).toEqual([
      "2026-10-20T04:30:00.000Z",
      "2026-10-20T06:30:00.000Z",
    ]);
  });

  test("daylight saving: 9:00 local stays 9:00 local", () => {
    // New York goes from UTC-4 to UTC-5 on 2026-11-01.
    const rule: RecurrenceRule = { freq: "daily", times: ["09:00"], timezone: "America/New_York" };
    const got = nextRuns(rule, new Date("2026-10-31T00:00:00Z"), 2);
    expect(iso(got)).toEqual(["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
    expect(zonedTime({ y: 2026, m: 11, d: 1 }, 9, 0, "America/New_York").toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });

  test("validation returns a code", () => {
    expect(validateRule({ freq: "daily", timezone: "Lua/Base" })).toBe("rule.timezone");
    expect(validateRule({ freq: "minutely", interval: 1, timezone: "UTC" })).toBe("rule.too_often");
    expect(validateRule({ freq: "daily", times: ["25:00"], timezone: "UTC" })).toBe("rule.time");
    expect(validateRule({ freq: "daily", timezone: "UTC" })).toBeNull();
  });
});

describe("phrases", () => {
  const rule = (phrase: string) => {
    const r = parseRulePhrase(phrase, "UTC");
    if (!r.ok) throw new Error(`${phrase}: ${r.code}`);
    const { timezone: _tz, ...rest } = r.rule;
    return rest;
  };

  test("workday phrases preserve explicit daily and weekly intervals", () => {
    for (const phrase of ["a cada 2 semanas de segunda a sexta às 9h", "every 2 weeks on weekdays at 9am"])
      expect(rule(phrase)).toEqual({
        freq: "weekly",
        interval: 2,
        weekdays: ["MO", "TU", "WE", "TH", "FR"],
        times: ["09:00"],
      });
    expect(rule("every 2 days on weekdays at 9am")).toEqual({
      freq: "daily",
      interval: 2,
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      times: ["09:00"],
    });
    expect(parseRulePhrase("every 2 months on weekdays at 9am", "UTC").ok).toBe(false);
  });

  test("Portuguese", () => {
    expect(rule("todo dia às 9h")).toEqual({ freq: "daily", times: ["09:00"] });
    expect(rule("dias úteis às 8:30")).toEqual({
      freq: "daily",
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      times: ["08:30"],
    });
    expect(rule("toda segunda e quarta às 10h")).toEqual({
      freq: "weekly",
      weekdays: ["MO", "WE"],
      times: ["10:00"],
    });
    expect(rule("a cada 2 horas")).toEqual({ freq: "hourly", interval: 2 });
    expect(rule("todo mês no dia 5 às 9h")).toEqual({ freq: "monthly", byMonthDay: [5], times: ["09:00"] });
    expect(rule("última sexta do mês às 17h")).toEqual({
      freq: "monthly",
      weekdays: ["FR"],
      bySetPos: [-1],
      times: ["17:00"],
    });
    expect(rule("segunda sexta do mês")).toEqual({ freq: "monthly", weekdays: ["FR"], bySetPos: [2] });
  });

  test("English", () => {
    expect(rule("every day at 9am")).toEqual({ freq: "daily", times: ["09:00"] });
    expect(rule("weekdays at 5pm")).toEqual({
      freq: "daily",
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      times: ["17:00"],
    });
    expect(rule("every monday at 10:30")).toEqual({ freq: "weekly", weekdays: ["MO"], times: ["10:30"] });
    expect(rule("every 30 minutes")).toEqual({ freq: "minutely", interval: 30 });
    expect(rule("last friday of the month")).toEqual({ freq: "monthly", weekdays: ["FR"], bySetPos: [-1] });
  });

  test("what it does not understand becomes a code", () => {
    expect(parseRulePhrase("quando der vontade", "UTC")).toEqual({ ok: false, code: "rule.not_understood" });
    expect(parseRulePhrase("a cada 1 minuto", "UTC")).toEqual({ ok: false, code: "rule.too_often" });
    expect(parseRulePhrase("todo dia às 27h", "UTC")).toEqual({ ok: false, code: "rule.time" });
  });

  test("one-time schedule", () => {
    const now = new Date("2026-10-20T13:00:00Z");
    expect(parseSchedulePhrase("em 2 horas", "UTC", now)).toEqual({
      ok: true,
      kind: "once",
      at: new Date("2026-10-20T15:00:00Z"),
    });
    expect(parseSchedulePhrase("amanhã às 9h", SP, now)).toEqual({
      ok: true,
      kind: "once",
      at: new Date("2026-10-21T12:00:00Z"),
    });
    expect(parseSchedulePhrase("hoje às 8h", "UTC", now)).toEqual({ ok: false, code: "rule.past" });
    const repeated = parseSchedulePhrase("toda sexta às 18h", "UTC", now);
    expect(repeated.ok && repeated.kind).toBe("schedule");
  });

  test("describe", () => {
    expect(
      describeRule(
        { freq: "daily", weekdays: ["MO", "TU", "WE", "TH", "FR"], times: ["08:00"], timezone: "UTC" },
        "pt-BR",
      ),
    ).toBe("Dias úteis às 08:00");
    expect(
      describeRule({ freq: "weekly", weekdays: ["MO", "WE"], times: ["10:00"], timezone: "UTC" }, "en"),
    ).toBe("Every Monday and Wednesday at 10:00");
    expect(
      describeRule({ freq: "monthly", weekdays: ["FR"], bySetPos: [-1], timezone: "UTC" }, "pt-BR"),
    ).toBe("Última sexta do mês");
    expect(describeRule({ freq: "hourly", interval: 2, timezone: "UTC" }, "pt-BR")).toBe("A cada 2 horas");
  });
});
