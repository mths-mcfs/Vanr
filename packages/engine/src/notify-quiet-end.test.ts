import { describe, expect, test } from "bun:test";
import type { NotificationSettings } from "@vanr/contract";
import { DEFAULT_SETTINGS, silenceUntil } from "./notify-rules";

const quiet = (start: string, end: string): NotificationSettings => ({
  ...DEFAULT_SETTINGS,
  quietHours: { enabled: true, start, end },
});
const until = (start: string, end: string, tz: string, at: string) =>
  silenceUntil(quiet(start, end), tz, new Date(at))?.toISOString() ?? null;

describe("end of the quiet window, exact", () => {
  test("a window whose only free minute is midnight ends at midnight", () => {
    expect(until("00:01", "00:00", "UTC", "2024-01-01T23:55:00Z")).toBe("2024-01-02T00:00:00.000Z");
    expect(until("00:01", "00:00", "UTC", "2024-01-01T23:55:30Z")).toBe("2024-01-02T00:00:00.000Z");
  });

  test("the end does not depend on a step size", () => {
    expect(until("22:00", "08:07", "UTC", "2024-01-01T23:00:00Z")).toBe("2024-01-02T08:07:00.000Z");
    expect(until("00:00", "23:59", "UTC", "2024-01-01T00:00:00Z")).toBe("2024-01-01T23:59:00.000Z");
    expect(until("22:00", "06:30", "Asia/Kolkata", "2024-01-01T17:30:00Z")).toBe("2024-01-02T01:00:00.000Z");
  });

  test("start equal to end is no quiet at all (not a quiet without end)", () => {
    expect(until("08:00", "08:00", "UTC", "2024-01-01T08:30:00Z")).toBeNull();
  });

  test("an end inside the hour skipped by daylight saving ends when the clock jumps", () => {
    // New York, 2024-03-10: 02:00 EST jumps to 03:00 EDT (07:00Z).
    expect(until("01:00", "02:45", "America/New_York", "2024-03-10T06:30:00Z")).toBe(
      "2024-03-10T07:00:00.000Z",
    );
    // Sydney, 2024-10-06: 02:00 AEST jumps to 03:00 AEDT (16:00Z).
    expect(until("22:00", "02:30", "Australia/Sydney", "2024-10-05T13:00:00Z")).toBe(
      "2024-10-05T16:00:00.000Z",
    );
    // Lord Howe, 2024-10-06: half-hour shift, 02:00 jumps to 02:30 (15:30Z).
    expect(until("23:00", "02:15", "Australia/Lord_Howe", "2024-10-05T13:00:00Z")).toBe(
      "2024-10-05T15:30:00.000Z",
    );
  });

  test("an end in the repeated hour is its first time on the clock", () => {
    // Sydney, 2024-04-07: 03:00 AEDT goes back to 02:00 AEST; 02:30 AEDT is 15:30Z.
    expect(until("01:00", "02:30", "Australia/Sydney", "2024-04-06T14:30:00Z")).toBe(
      "2024-04-06T15:30:00.000Z",
    );
    // New York, 2024-11-03: 02:00 EDT goes back to 01:00 EST; an end at 08:00 is after the repeated hour.
    expect(until("22:00", "08:00", "America/New_York", "2024-11-03T03:00:00Z")).toBe(
      "2024-11-03T13:00:00.000Z",
    );
  });
});
