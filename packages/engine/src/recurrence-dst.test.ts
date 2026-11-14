import { describe, expect, test } from "bun:test";
import type { RecurrenceRule } from "@vanr/contract";
import { localParts, nextRuns, occurrences, zonedTime } from "./recurrence";

const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe("local times around daylight saving", () => {
  test("a time that does not exist moves forward to the first valid instant after the gap", () => {
    const ny = zonedTime({ y: 2024, m: 3, d: 10 }, 2, 30, "America/New_York");
    expect(ny.toISOString()).toBe("2024-03-10T07:00:00.000Z");
    expect(localParts(ny, "America/New_York")).toMatchObject({ hh: 3, mm: 0 });
    expect(zonedTime({ y: 2024, m: 10, d: 6 }, 2, 30, "Australia/Sydney").toISOString()).toBe(
      "2024-10-05T16:00:00.000Z",
    );
    expect(zonedTime({ y: 2024, m: 10, d: 6 }, 2, 15, "Australia/Lord_Howe").toISOString()).toBe(
      "2024-10-05T15:30:00.000Z",
    );
    // Santiago skips midnight: 00:00 on 2024-09-08 becomes 01:00.
    expect(zonedTime({ y: 2024, m: 9, d: 8 }, 0, 0, "America/Santiago").toISOString()).toBe(
      "2024-09-08T04:00:00.000Z",
    );
  });

  test("ordinary times, including a half-hour zone, are unchanged", () => {
    expect(zonedTime({ y: 2024, m: 1, d: 1 }, 9, 0, "Asia/Kolkata").toISOString()).toBe(
      "2024-01-01T03:30:00.000Z",
    );
    expect(zonedTime({ y: 2024, m: 3, d: 10 }, 3, 30, "America/New_York").toISOString()).toBe(
      "2024-03-10T07:30:00.000Z",
    );
  });

  test("the run of the day with the gap does not disappear", () => {
    const rule: RecurrenceRule = {
      freq: "daily",
      timezone: "America/New_York",
      start: "2024-03-09T07:30:00Z",
      times: ["02:30"],
    };
    expect(iso(nextRuns(rule, new Date("2024-03-10T06:45:00Z"), 2))).toEqual([
      "2024-03-10T07:00:00.000Z",
      "2024-03-11T06:30:00.000Z",
    ]);
  });

  test("a time in the repeated hour runs once, at its first occurrence", () => {
    const ny: RecurrenceRule = { freq: "daily", timezone: "America/New_York", times: ["01:30"] };
    expect(
      iso(occurrences(ny, { from: new Date("2024-11-02T12:00:00Z"), to: new Date("2024-11-05T00:00:00Z") })),
    ).toEqual(["2024-11-03T05:30:00.000Z", "2024-11-04T06:30:00.000Z"]);
    expect(zonedTime({ y: 2024, m: 4, d: 7 }, 2, 30, "Australia/Sydney").toISOString()).toBe(
      "2024-04-06T15:30:00.000Z",
    );
  });
});
