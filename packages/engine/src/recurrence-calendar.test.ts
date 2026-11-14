import { describe, expect, test } from "bun:test";
import type { RecurrenceRule } from "@vanr/contract";
import { localParts, occurrences, validateRule, zonedTime } from "./recurrence";

const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe("calendar edges of a rule", () => {
  test("a year below 100 stays as written (Date.UTC would move it to the 1900s)", () => {
    const rule: RecurrenceRule = { freq: "daily", timezone: "UTC", start: "0050-03-01T09:00:00Z", count: 2 };
    expect(validateRule(rule)).toBeNull();
    expect(iso(occurrences(rule, { from: new Date("0050-01-01T00:00:00Z") }))).toEqual([
      "0050-03-01T09:00:00.000Z",
      "0050-03-02T09:00:00.000Z",
    ]);
    expect(zonedTime({ y: 50, m: 3, d: 1 }, 9, 0, "UTC").toISOString()).toBe("0050-03-01T09:00:00.000Z");
    expect(localParts(new Date("0050-03-01T09:00:00Z"), "UTC")).toEqual({ y: 50, m: 3, d: 1, hh: 9, mm: 0 });
  });

  test("year 0 is 1 BC, a leap year: the last day of its February is the 29th", () => {
    const rule: RecurrenceRule = {
      freq: "monthly",
      timezone: "UTC",
      byMonthDay: [-1],
      times: ["09:00"],
      start: "0000-02-01T00:00:00Z",
      count: 1,
    };
    expect(iso(occurrences(rule, { from: new Date("0000-01-01T00:00:00Z") }))).toEqual([
      "0000-02-29T09:00:00.000Z",
    ]);
  });

  test("a local mean time offset with seconds is kept to the second", () => {
    // New York before 1883 is local mean time, UTC-4:56:02.
    const at = zonedTime({ y: 1850, m: 6, d: 1 }, 9, 0, "America/New_York");
    expect(at.toISOString()).toBe("1850-06-01T13:56:02.000Z");
    expect(localParts(at, "America/New_York")).toEqual({ y: 1850, m: 6, d: 1, hh: 9, mm: 0 });
  });

  test("a start or until on a day that does not exist is rejected, not rolled into the next month", () => {
    expect(validateRule({ freq: "daily", timezone: "UTC", start: "2026-02-31T09:00:00Z" })).toBe(
      "rule.start",
    );
    expect(validateRule({ freq: "daily", timezone: "UTC", until: "2026-04-31" })).toBe("rule.until");
    expect(validateRule({ freq: "daily", timezone: "UTC", start: "2024-02-29T09:00:00Z" })).toBeNull();
    expect(validateRule({ freq: "daily", timezone: "UTC", start: "2026-13-01T09:00:00Z" })).toBe(
      "rule.start",
    );
  });
});
