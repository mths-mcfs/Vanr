import { expect, test } from "bun:test";
import { type EventRow, expand } from "./calendar";

for (const [start, end, day, next] of [
  ["2026-03-01T05:00Z", "2026-03-02T05:00Z", "2026-03-08", "2026-03-09T04:00Z"],
  ["2026-03-08T05:00Z", "2026-03-09T04:00Z", "2026-11-01", "2026-11-02T05:00Z"],
] as const) {
  test(`all-day recurrence keeps its local day across DST: ${day}`, () => {
    const row: EventRow = {
      id: "e",
      workspaceId: "w",
      title: "Day",
      start: new Date(start),
      end: new Date(end),
      allDay: true,
      timezone: "America/New_York",
      rule: { freq: "daily", timezone: "America/New_York" },
      exdates: [],
      seriesId: null,
      participants: [],
      createdBy: { type: "person", id: "u" },
      location: null,
      description: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const until = new Date(next);
    const events = expand(row, new Date(until.getTime() - 30 * 60_000), until);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ startDate: day, endDate: day, end: until.toISOString() });
    expect(
      expand(
        { ...row, rule: { freq: "daily", timezone: row.timezone, until: `${day}T12:00:00Z` } },
        until,
        new Date(until.getTime() + 60_000),
      ),
    ).toEqual([]);
  });
}
