import { describe, expect, test } from "bun:test";
import type { RecurrenceRule } from "@vanr/contract";
import { nextRuns, occurrences } from "./recurrence";

const iso = (d: Date[]) => d.map((x) => x.toISOString());
const NY = "America/New_York";
// 2024-03-10: 02:00 EST jumps to 03:00 EDT (07:00Z); 02:15, 02:45 and 03:00 all land on 07:00Z.
const gapDay = (extra: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  freq: "daily",
  timezone: NY,
  start: "2024-03-10T00:00:00Z",
  times: ["02:15", "02:45", "03:00", "09:00"],
  ...extra,
});

describe("times that collide in the daylight saving gap are one occurrence", () => {
  test("count counts the shared instant once and the series goes on", () => {
    expect(iso(occurrences(gapDay({ count: 3 }), { from: new Date("2024-03-09T00:00:00Z") }))).toEqual([
      "2024-03-10T07:00:00.000Z",
      "2024-03-10T13:00:00.000Z",
      "2024-03-11T06:15:00.000Z",
    ]);
  });

  test("until bounds distinct instants", () => {
    const rule = gapDay({ until: "2024-03-11T06:30:00Z" });
    expect(iso(occurrences(rule, { from: new Date("2024-03-09T00:00:00Z") }))).toEqual([
      "2024-03-10T07:00:00.000Z",
      "2024-03-10T13:00:00.000Z",
      "2024-03-11T06:15:00.000Z",
    ]);
  });

  test("the next runs are distinct", () => {
    expect(iso(nextRuns(gapDay(), new Date("2024-03-10T06:00:00Z"), 3))).toEqual([
      "2024-03-10T07:00:00.000Z",
      "2024-03-10T13:00:00.000Z",
      "2024-03-11T06:15:00.000Z",
    ]);
  });

  test("outside the switches, and in the repeated hour, distinct times stay distinct", () => {
    const rule: RecurrenceRule = { freq: "daily", timezone: NY, times: ["01:15", "01:45", "02:15", "02:45"] };
    // 2024-03-12: an ordinary day, four occurrences.
    expect(iso(occurrences(rule, { from: new Date("2024-03-12T05:00:00Z"), limit: 4 }))).toEqual([
      "2024-03-12T05:15:00.000Z",
      "2024-03-12T05:45:00.000Z",
      "2024-03-12T06:15:00.000Z",
      "2024-03-12T06:45:00.000Z",
    ]);
    // 2024-11-03: 02:00 EDT goes back to 01:00 EST; 01:15 and 01:45 run once each, at their first occurrence.
    expect(iso(occurrences(rule, { from: new Date("2024-11-03T04:00:00Z"), limit: 4 }))).toEqual([
      "2024-11-03T05:15:00.000Z",
      "2024-11-03T05:45:00.000Z",
      "2024-11-03T07:15:00.000Z",
      "2024-11-03T07:45:00.000Z",
    ]);
  });
});
