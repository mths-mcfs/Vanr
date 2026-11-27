// The calendar routes (routes/calendar.ts): single events and who sees them, series expanded by the engine's
// recurrence (with a daylight-saving change), "this", "this and the following" and "all" when changing or
// deleting, the routines' times, the issues' due dates and the agents' proposals in a range; who may call each
// route; and two answers to one proposal, or two changes of one series, at the same time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CalendarEvent, CalendarRange } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { MAX_RANGE_DAYS, ROUTINE_TIMES_MAX } from "../src/routes/calendar";
import type { RunningServer } from "../src/server";
import { Browser, body, SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@calendar.test`;
const DAY = 86_400_000;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Agenda");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  return { workspaceId, general, ana, beto, caio };
}

const call = async (
  who: Person | Browser,
  workspaceId: string,
  method: string,
  path: string,
  data?: unknown,
) => {
  const browser = who instanceof Browser ? who : who.browser;
  const res = await browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  return { status: res.status, json: res.status === 204 ? null : await body(res) };
};
const ok = async <T>(p: ReturnType<typeof call>, status = 200): Promise<T> => {
  const res = await p;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
};
const range = (who: Person, workspaceId: string, from: string, to: string) =>
  ok<CalendarRange>(
    call(
      who,
      workspaceId,
      "GET",
      `/calendar?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`,
    ),
  );
const create = (who: Person, workspaceId: string, data: unknown) =>
  ok<CalendarEvent>(call(who, workspaceId, "POST", "/calendar/events", data), 201);
const update = (who: Person, workspaceId: string, id: string, data: unknown) =>
  ok<CalendarEvent>(call(who, workspaceId, "PATCH", `/calendar/events/${id}`, data));
const remove = (
  who: Person,
  workspaceId: string,
  id: string,
  scope?: { scope: string; instanceStart?: string },
) =>
  ok(
    call(
      who,
      workspaceId,
      "DELETE",
      `/calendar/events/${id}${scope ? `?${new URLSearchParams(scope).toString()}` : ""}`,
    ),
    204,
  );

async function seedAgent(workspaceId: string, owner: Person, handle: string) {
  const id = newId("agt");
  await server.deps.db.insert(schema.agents).values({
    id,
    workspaceId,
    name: handle,
    handle,
    model: "claude-haiku-5-5",
    ownerUserId: owner.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  return id;
}

describe("calendar", () => {
  test(
    "single event: create, who sees it, edit, delete and the real-time events",
    async () => {
      const { workspaceId, ana, beto, caio } = await team();
      const ws = await TestSocket.open(beto.browser, workspaceId);
      try {
        const e = await create(ana, workspaceId, {
          title: "Meeting with the supplier",
          start: "2026-11-03T13:00:00Z",
          end: "2026-11-03T14:00:00Z",
          timezone: "America/Sao_Paulo",
          participants: [{ type: "person", id: beto.user.id }],
          location: "Room 2",
        });
        expect(e).toMatchObject({
          allDay: false,
          rule: null,
          seriesId: null,
          createdBy: { type: "person", id: ana.user.id },
        });
        expect((await ws.event("calendar_event.saved")).event).toMatchObject({ eventId: e.id });
        const forBeto = await range(beto, workspaceId, "2026-11-01", "2026-11-08");
        expect(forBeto.events.map((x) => x.title)).toEqual(["Meeting with the supplier"]);
        // Caio isn't a participant: he doesn't see it.
        expect((await range(caio, workspaceId, "2026-11-01", "2026-11-08")).events).toEqual([]);
        expect(
          (await call(caio, workspaceId, "PATCH", `/calendar/events/${e.id}`, { title: "x" })).status,
        ).toBe(404);

        const moved = await update(beto, workspaceId, e.id, { start: "2026-11-03T15:00:00Z" });
        expect(moved).toMatchObject({ start: "2026-11-03T15:00:00.000Z", end: "2026-11-03T16:00:00.000Z" });
        const backwards = await call(ana, workspaceId, "PATCH", `/calendar/events/${e.id}`, {
          end: "2026-11-03T14:00:00Z",
        });
        expect(backwards.json.error.code).toBe("calendar.end_before_start");
        await remove(ana, workspaceId, e.id);
        expect((await ws.event("calendar_event.removed")).event).toMatchObject({
          eventId: e.id,
          scope: "all",
        });
        expect((await range(beto, workspaceId, "2026-11-01", "2026-11-08")).events).toEqual([]);

        const allDay = await create(ana, workspaceId, {
          title: "Holiday",
          start: "2026-11-15T03:00:00Z",
          end: "2026-11-17T03:00:00Z",
          allDay: true,
          timezone: "America/Sao_Paulo",
        });
        // Without participants the whole workspace sees it. The end is inclusive.
        expect(allDay).toMatchObject({ startDate: "2026-11-15", endDate: "2026-11-16" });
        expect((await range(caio, workspaceId, "2026-11-14", "2026-11-20")).events.map((x) => x.id)).toEqual([
          allDay.id,
        ]);
        const tooLong = await call(
          caio,
          workspaceId,
          "GET",
          "/calendar?from=2026-01-01T00:00:00Z&to=2028-01-01T00:00:00Z",
        );
        expect(tooLong.json.error.code).toBe("calendar.range");
      } finally {
        ws.ws.close();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "series: expand, change only this one, this and the following, and delete with a scope",
    async () => {
      const { workspaceId, ana } = await team();
      const daily = await create(ana, workspaceId, {
        title: "Daily",
        start: "2026-11-02T12:00:00Z",
        end: "2026-11-02T12:15:00Z",
        timezone: "America/Sao_Paulo",
        rule: { freq: "daily", weekdays: ["MO", "TU", "WE", "TH", "FR"], timezone: "America/Sao_Paulo" },
      });
      let week = await range(ana, workspaceId, "2026-11-02T00:00:00Z", "2026-11-09T00:00:00Z");
      expect(week.events.map((x) => x.start)).toEqual([
        "2026-11-02T12:00:00.000Z",
        "2026-11-03T12:00:00.000Z",
        "2026-11-04T12:00:00.000Z",
        "2026-11-05T12:00:00.000Z",
        "2026-11-06T12:00:00.000Z",
      ]);
      expect(week.events[0]).toMatchObject({
        seriesId: daily.id,
        instanceStart: "2026-11-02T12:00:00.000Z",
        recurrence: "daily",
      });

      // Only Wednesday's changes its time.
      const wed = await update(ana, workspaceId, daily.id, {
        start: "2026-11-04T14:00:00Z",
        title: "Daily (afternoon)",
        scope: "this",
        instanceStart: "2026-11-04T12:00:00Z",
      });
      expect(wed).toMatchObject({
        seriesId: daily.id,
        rule: null,
        start: "2026-11-04T14:00:00.000Z",
        end: "2026-11-04T14:15:00.000Z",
      });
      week = await range(ana, workspaceId, "2026-11-02T00:00:00Z", "2026-11-09T00:00:00Z");
      expect(week.events.map((x) => [x.title, x.start.slice(0, 13)])).toEqual([
        ["Daily", "2026-11-02T12"],
        ["Daily", "2026-11-03T12"],
        ["Daily (afternoon)", "2026-11-04T14"],
        ["Daily", "2026-11-05T12"],
        ["Daily", "2026-11-06T12"],
      ]);
      const saturday = await call(ana, workspaceId, "PATCH", `/calendar/events/${daily.id}`, {
        title: "x",
        scope: "this",
        instanceStart: "2026-11-07T12:00:00Z",
      });
      expect(saturday.status).toBe(404);

      // From Friday on it takes 30 minutes.
      const fri = await update(ana, workspaceId, daily.id, {
        end: "2026-11-06T12:30:00Z",
        scope: "following",
        instanceStart: "2026-11-06T12:00:00Z",
      });
      expect(fri.seriesId).not.toBe(daily.id);
      const two = await range(ana, workspaceId, "2026-11-05T00:00:00Z", "2026-11-11T00:00:00Z");
      expect(
        two.events.map((x) => [
          x.start.slice(5, 13),
          (new Date(x.end).getTime() - new Date(x.start).getTime()) / 60_000,
        ]),
      ).toEqual([
        ["11-05T12", 15],
        ["11-06T12", 30],
        ["11-09T12", 30],
        ["11-10T12", 30],
      ]);

      // Delete only Tuesday's; then the whole old series.
      await remove(ana, workspaceId, daily.id, { scope: "this", instanceStart: "2026-11-03T12:00:00Z" });
      week = await range(ana, workspaceId, "2026-11-02T00:00:00Z", "2026-11-06T00:00:00Z");
      expect(week.events.map((x) => x.start.slice(5, 10))).toEqual(["11-02", "11-04", "11-05"]);
      // "This and the following" on the continuation; then "all" takes the whole family (exceptions and continuation).
      await remove(ana, workspaceId, fri.id, { scope: "following", instanceStart: "2026-11-10T12:00:00Z" });
      week = await range(ana, workspaceId, "2026-11-02T00:00:00Z", "2026-11-20T00:00:00Z");
      expect(week.events.map((x) => x.start.slice(5, 10))).toEqual([
        "11-02",
        "11-04",
        "11-05",
        "11-06",
        "11-09",
      ]);
      await remove(ana, workspaceId, daily.id, { scope: "all" });
      week = await range(ana, workspaceId, "2026-11-02T00:00:00Z", "2026-11-20T00:00:00Z");
      expect(week.events).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    'split series: "all" from a part takes the family; "this and the following" takes the later parts',
    async () => {
      const { workspaceId, ana } = await team();
      const make = () =>
        create(ana, workspaceId, {
          title: "On call",
          start: "2026-11-02T12:00:00Z",
          end: "2026-11-02T13:00:00Z",
          timezone: "America/Sao_Paulo",
          rule: { freq: "daily", timezone: "America/Sao_Paulo" },
        });
      const split = (id: string, day: string) =>
        update(ana, workspaceId, id, {
          title: `On call ${day}`,
          scope: "following",
          instanceStart: `2026-11-${day}T12:00:00Z`,
        });
      const days = async () =>
        (await range(ana, workspaceId, "2026-11-01T00:00:00Z", "2026-11-09T00:00:00Z")).events.map((x) =>
          x.start.slice(8, 10),
        );

      // "All" asked on a part (not on the original) deletes the whole series.
      const a = await make();
      const partA = await split(a.id, "05");
      await remove(ana, workspaceId, partA.id, { scope: "all" });
      expect(await days()).toEqual([]);

      // "This and the following" at the start of a part also deletes the parts after it.
      const b = await make();
      const partB1 = await split(b.id, "04");
      await split(partB1.id, "06");
      await remove(ana, workspaceId, partB1.id, {
        scope: "following",
        instanceStart: "2026-11-04T12:00:00Z",
      });
      expect(await days()).toEqual(["02", "03"]);
      await remove(ana, workspaceId, b.id, { scope: "all" });

      // An occurrence edited on its own has no rule: deleting it takes only it, not the series.
      const c = await make();
      const moved = await update(ana, workspaceId, c.id, {
        start: "2026-11-03T15:00:00Z",
        end: "2026-11-03T16:00:00Z",
        scope: "this",
        instanceStart: "2026-11-03T12:00:00Z",
      });
      await remove(ana, workspaceId, moved.id);
      expect(await days()).toEqual(["02", "04", "05", "06", "07", "08"]);
      await remove(ana, workspaceId, c.id, { scope: "all" });

      // An occurrence edited on its own inside a part: "this and the following" on the part and "all" through the
      // root take it too (it points to the root, not to the part).
      const d = await make();
      const partD = await split(d.id, "05");
      await update(ana, workspaceId, partD.id, {
        start: "2026-11-08T15:00:00Z",
        end: "2026-11-08T16:00:00Z",
        scope: "this",
        instanceStart: "2026-11-08T12:00:00Z",
      });
      await remove(ana, workspaceId, partD.id, { scope: "following", instanceStart: "2026-11-07T12:00:00Z" });
      expect(await days()).toEqual(["02", "03", "04", "05", "06"]);
      const e = await make();
      const partE = await split(e.id, "05");
      await update(ana, workspaceId, partE.id, {
        start: "2026-11-07T15:00:00Z",
        end: "2026-11-07T16:00:00Z",
        scope: "this",
        instanceStart: "2026-11-07T12:00:00Z",
      });
      await remove(ana, workspaceId, d.id, { scope: "all" });
      await remove(ana, workspaceId, e.id, { scope: "all" });
      expect(await days()).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    'a split series with a count keeps its total; "all" after a split changes every part',
    async () => {
      const { workspaceId, ana } = await team();
      const listed = async (from: string, to: string) =>
        (await range(ana, workspaceId, from, to)).events.map((x) => [x.start, x.title]);
      const daily = (title: string, count?: number) =>
        create(ana, workspaceId, {
          title,
          start: "2026-11-15T10:00:00Z",
          end: "2026-11-15T11:00:00Z",
          timezone: "UTC",
          rule: { freq: "daily", interval: 1, timezone: "UTC", ...(count ? { count } : {}) },
        });

      // Three days, split at the second: still three, the continuation never runs on.
      const three = await daily("Three days", 3);
      const rest = await update(ana, workspaceId, three.id, {
        scope: "following",
        instanceStart: "2026-11-16T10:00:00Z",
        title: "The rest",
      });
      expect(rest.rule?.count).toBe(2);
      expect(await listed("2026-11-14T00:00:00Z", "2026-12-01T00:00:00Z")).toEqual([
        ["2026-11-15T10:00:00.000Z", "Three days"],
        ["2026-11-16T10:00:00.000Z", "The rest"],
        ["2026-11-17T10:00:00.000Z", "The rest"],
      ]);
      await remove(ana, workspaceId, three.id, { scope: "all" });

      // An occurrence taken out before the split still counts: four days, the second out, split at the third.
      const four = await daily("Four days", 4);
      await remove(ana, workspaceId, four.id, { scope: "this", instanceStart: "2026-11-16T10:00:00Z" });
      await update(ana, workspaceId, four.id, {
        scope: "following",
        instanceStart: "2026-11-17T10:00:00Z",
        title: "Later",
      });
      expect(await listed("2026-11-14T00:00:00Z", "2026-12-01T00:00:00Z")).toEqual([
        ["2026-11-15T10:00:00.000Z", "Four days"],
        ["2026-11-17T10:00:00.000Z", "Later"],
        ["2026-11-18T10:00:00.000Z", "Later"],
      ]);
      await remove(ana, workspaceId, four.id, { scope: "all" });

      // Split, an occurrence moved on its own, then "all" from the continuation: every part takes the new title
      // and keeps its own times.
      const open = await daily("Stand-up");
      const part = await update(ana, workspaceId, open.id, {
        scope: "following",
        instanceStart: "2026-11-17T10:00:00Z",
        title: "Later stand-up",
      });
      await update(ana, workspaceId, part.id, {
        scope: "this",
        instanceStart: "2026-11-18T10:00:00Z",
        start: "2026-11-18T14:00:00Z",
        end: "2026-11-18T15:00:00Z",
      });
      await update(ana, workspaceId, part.id, { scope: "all", title: "Renamed", location: "Room 2" });
      const after = await range(ana, workspaceId, "2026-11-15T00:00:00Z", "2026-11-20T00:00:00Z");
      expect(after.events.map((x) => [x.start, x.title, x.location])).toEqual([
        ["2026-11-15T10:00:00.000Z", "Renamed", "Room 2"],
        ["2026-11-16T10:00:00.000Z", "Renamed", "Room 2"],
        ["2026-11-17T10:00:00.000Z", "Renamed", "Room 2"],
        ["2026-11-18T14:00:00.000Z", "Renamed", "Room 2"],
        ["2026-11-19T10:00:00.000Z", "Renamed", "Room 2"],
      ]);
      await remove(ana, workspaceId, open.id, { scope: "all" });
    },
    SERVER_TEST_MS,
  );

  test(
    '"this and the following" reaches the parts split off later; a split on a daylight saving day keeps the times',
    async () => {
      const { workspaceId, ana } = await team();
      const listed = async (from: string, to: string) =>
        (await range(ana, workspaceId, from, to)).events.map((x) => [x.start, x.title]);
      const five = await create(ana, workspaceId, {
        title: "Original",
        start: "2027-04-01T12:00:00Z",
        end: "2027-04-01T13:00:00Z",
        timezone: "UTC",
        rule: { freq: "daily", count: 5, timezone: "UTC" },
      });
      await update(ana, workspaceId, five.id, {
        scope: "following",
        instanceStart: "2027-04-04T12:00:00Z",
        title: "First edit",
      });
      await update(ana, workspaceId, five.id, {
        scope: "following",
        instanceStart: "2027-04-02T12:00:00Z",
        title: "Second edit",
      });
      expect(await listed("2027-04-01T00:00:00Z", "2027-04-10T00:00:00Z")).toEqual([
        ["2027-04-01T12:00:00.000Z", "Original"],
        ["2027-04-02T12:00:00.000Z", "Second edit"],
        ["2027-04-03T12:00:00.000Z", "Second edit"],
        ["2027-04-04T12:00:00.000Z", "Second edit"],
        ["2027-04-05T12:00:00.000Z", "Second edit"],
      ]);
      await remove(ana, workspaceId, five.id, { scope: "all" });

      // A part moved before the original: "this and the following" from its first occurrence is every
      // occurrence after it in time, the original's too, for an edit and for a delete.
      const late = await create(ana, workspaceId, {
        title: "Original",
        start: "2027-04-08T12:00:00Z",
        end: "2027-04-08T13:00:00Z",
        timezone: "UTC",
        rule: { freq: "daily", count: 5, timezone: "UTC" },
      });
      const early = await update(ana, workspaceId, late.id, {
        scope: "following",
        instanceStart: "2027-04-10T12:00:00Z",
        start: "2027-04-05T12:00:00Z",
        end: "2027-04-05T13:00:00Z",
        title: "Part",
      });
      await update(ana, workspaceId, early.id, {
        scope: "following",
        instanceStart: "2027-04-05T12:00:00Z",
        title: "New",
      });
      expect(await listed("2027-04-05T00:00:00Z", "2027-04-14T00:00:00Z")).toEqual([
        ["2027-04-05T12:00:00.000Z", "New"],
        ["2027-04-06T12:00:00.000Z", "New"],
        ["2027-04-07T12:00:00.000Z", "New"],
        ["2027-04-08T12:00:00.000Z", "New"],
        ["2027-04-09T12:00:00.000Z", "New"],
      ]);
      await remove(ana, workspaceId, early.id, { scope: "following", instanceStart: "2027-04-05T12:00:00Z" });
      expect(await listed("2027-04-05T00:00:00Z", "2027-04-14T00:00:00Z")).toEqual([]);

      // An hourly series split at 11:00 and turned daily: the continuation runs at 11:00, its own start (the
      // series' 09:00 belongs to the hourly rule, not to the new one).
      const hourly = await create(ana, workspaceId, {
        title: "Hourly",
        start: "2027-03-13T09:00:00Z",
        end: "2027-03-13T09:30:00Z",
        timezone: "UTC",
        rule: { freq: "hourly", count: 4, timezone: "UTC" },
      });
      const daily = await update(ana, workspaceId, hourly.id, {
        scope: "following",
        instanceStart: "2027-03-13T11:00:00Z",
        rule: { freq: "daily", count: 2, timezone: "UTC" },
      });
      expect([daily.start, daily.rule?.times]).toEqual(["2027-03-13T11:00:00.000Z", undefined]);
      expect(
        (await range(ana, workspaceId, "2027-03-13T00:00:00Z", "2027-03-17T00:00:00Z")).events.map(
          (x) => x.start,
        ),
      ).toEqual([
        "2027-03-13T09:00:00.000Z",
        "2027-03-13T10:00:00.000Z",
        "2027-03-13T11:00:00.000Z",
        "2027-03-14T11:00:00.000Z",
      ]);
      await remove(ana, workspaceId, hourly.id, { scope: "all" });

      // 02:30 in New York: on 2027-03-14 that time doesn't exist and the occurrence moves to 03:00 EDT.
      // Splitting there keeps 02:30 for the days after. The rule's own `times` from a client are ignored.
      const tz = "America/New_York";
      const dst = await create(ana, workspaceId, {
        title: "Early",
        start: "2027-03-13T07:30:00Z",
        end: "2027-03-13T08:30:00Z",
        timezone: tz,
        rule: { freq: "daily", count: 4, timezone: tz, times: ["23:00"] },
      });
      const starts = async () =>
        (await range(ana, workspaceId, "2027-03-12T00:00:00Z", "2027-03-18T00:00:00Z")).events.map(
          (x) => x.start,
        );
      const before = await starts();
      expect(before).toEqual([
        "2027-03-13T07:30:00.000Z",
        "2027-03-14T07:00:00.000Z",
        "2027-03-15T06:30:00.000Z",
        "2027-03-16T06:30:00.000Z",
      ]);
      const part = await update(ana, workspaceId, dst.id, {
        scope: "following",
        instanceStart: "2027-03-14T07:00:00Z",
        title: "Early, later",
      });
      expect(await starts()).toEqual(before);
      // The client sends the part's rule back as it read it with another title: the kept local time stays.
      expect(part.rule?.times).toEqual(["02:30"]);
      await update(ana, workspaceId, part.id, { scope: "all", title: "Early, again", rule: part.rule });
      expect(await starts()).toEqual(before);
      // So does a changed rule (here an end date), on the part and on a new continuation from it.
      const until = { ...part.rule, until: "2027-03-20T00:00:00Z" };
      await update(ana, workspaceId, part.id, { scope: "all", rule: until });
      expect(await starts()).toEqual(before);
      await update(ana, workspaceId, part.id, {
        scope: "following",
        instanceStart: "2027-03-15T06:30:00Z",
        title: "Early, last",
        rule: until,
      });
      // The rule sent is the person's (its count runs from the 15th); its days stay at 02:30 local.
      const later = (await starts()).slice(2);
      expect(later[0]).toBe("2027-03-15T06:30:00.000Z");
      expect(later.every((at) => at.endsWith("T06:30:00.000Z"))).toBe(true);
      // A new start for the part gives it its own time again; the continuation made from it keeps its own.
      await update(ana, workspaceId, part.id, { scope: "all", start: "2027-03-14T13:00:00Z" });
      expect(await starts()).toEqual([
        "2027-03-13T07:30:00.000Z",
        "2027-03-14T13:00:00.000Z",
        "2027-03-15T06:30:00.000Z",
        "2027-03-16T06:30:00.000Z",
        "2027-03-17T06:30:00.000Z",
      ]);
      await remove(ana, workspaceId, dst.id, { scope: "all" });
    },
    SERVER_TEST_MS,
  );

  test(
    "the agents' proposals, the routines' times and the issues' due dates in the range",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const lia = await seedAgent(workspaceId, ana, "lia");
      const start = new Date("2026-11-20T15:00:00Z");
      await server.deps.db.insert(schema.calendarProposals).values([
        {
          id: newId("prop"),
          workspaceId,
          agentId: lia,
          title: "Contract review",
          start,
          end: new Date(start.getTime() + 3_600_000),
          participants: [{ type: "person", id: ana.user.id }],
          note: "Everyone is free",
        },
        {
          id: newId("prop"),
          workspaceId,
          agentId: lia,
          title: "Another",
          start,
          end: new Date(start.getTime() + 3_600_000),
          participants: [{ type: "person", id: ana.user.id }],
        },
      ]);
      const [p1, p2] = await server.deps.db
        .select({ id: schema.calendarProposals.id, title: schema.calendarProposals.title })
        .from(schema.calendarProposals)
        .where(eq(schema.calendarProposals.workspaceId, workspaceId))
        .orderBy(schema.calendarProposals.title)
        .then((rows) => [
          rows.find((r) => r.title === "Contract review"),
          rows.find((r) => r.title === "Another"),
        ]);
      await server.deps.db.insert(schema.routines).values({
        id: newId("rtn"),
        workspaceId,
        name: "Good morning",
        prompt: "Good morning",
        agentId: lia,
        target: { kind: "channel", channelId: general },
        trigger: { kind: "schedule", rule: { freq: "daily", times: ["09:00"], timezone: "UTC" } },
        createdBy: ana.user.id,
        createdAt: new Date("2026-11-01T00:00:00Z"),
      });
      // A routine whose saved trigger can't be read doesn't break the range.
      await server.deps.db.insert(schema.routines).values({
        id: newId("rtn"),
        workspaceId,
        name: "Broken",
        prompt: "x",
        agentId: lia,
        target: { kind: "channel", channelId: general },
        trigger: { kind: "schedule", rule: { freq: "fortnightly" } },
        createdBy: ana.user.id,
      });
      await server.deps.db.insert(schema.routines).values({
        id: newId("rtn"),
        workspaceId,
        name: "No target",
        prompt: "x",
        agentId: lia,
        target: { kind: "somewhere" },
        trigger: { kind: "schedule", rule: { freq: "daily", times: ["10:00"], timezone: "UTC" } },
        createdBy: beto.user.id,
      });
      const issue = await ok<{ id: string; number: number }>(
        call(ana, workspaceId, "POST", "/issues", { title: "Deliver the proposal", dueDate: "2026-11-20" }),
        201,
      );
      // A closed issue's due date doesn't show.
      const cols = await ok<{ columns: { id: string; stage: string }[] }>(
        call(ana, workspaceId, "GET", "/issue-columns"),
      );
      const closed = await ok<{ id: string }>(
        call(ana, workspaceId, "POST", "/issues", { title: "Done already", dueDate: "2026-11-20" }),
        201,
      );
      await ok(
        call(ana, workspaceId, "PATCH", `/issues/${closed.id}`, {
          columnId: cols.columns.find((c) => c.stage === "done")?.id,
        }),
      );
      const from = "2026-11-18T12:00:00Z";
      const to = "2026-11-22T12:00:00Z";
      const r = await range(ana, workspaceId, from, to);
      expect(r.proposals.map((p) => p.title).sort()).toEqual(["Another", "Contract review"]);
      expect(r.routines.map((x) => x.at)).toEqual([
        "2026-11-19T09:00:00.000Z",
        "2026-11-20T09:00:00.000Z",
        "2026-11-21T09:00:00.000Z",
        "2026-11-22T09:00:00.000Z",
      ]);
      expect(r.routines[0]).toMatchObject({
        name: "Good morning",
        agentId: lia,
        target: { kind: "channel" },
      });
      expect(r.dueItems).toEqual([
        { issueId: issue.id, title: "Deliver the proposal", date: "2026-11-20", number: issue.number },
      ]);
      // Beto isn't in the proposal.
      expect((await range(beto, workspaceId, from, to)).proposals).toEqual([]);
      expect((await call(beto, workspaceId, "POST", `/calendar/proposals/${p1?.id}/confirm`)).status).toBe(
        404,
      );

      const event = await ok<CalendarEvent>(
        call(ana, workspaceId, "POST", `/calendar/proposals/${p1?.id}/confirm`),
        201,
      );
      expect(event).toMatchObject({
        title: "Contract review",
        createdBy: { type: "agent", id: lia },
        description: "Everyone is free",
      });
      const again = await call(ana, workspaceId, "POST", `/calendar/proposals/${p1?.id}/confirm`);
      expect(again.json.error.code).toBe("calendar.proposal_closed");
      await ok(call(ana, workspaceId, "POST", `/calendar/proposals/${p2?.id}/dismiss`), 204);
      const after = await range(ana, workspaceId, from, to);
      expect(after.proposals).toEqual([]);
      expect(after.events.map((e) => e.id)).toEqual([event.id]);
    },
    SERVER_TEST_MS,
  );
});

describe("time zones and limits", () => {
  test(
    "an all-day day on the 25-hour fall-back day keeps whole days; a new time zone is the series' too",
    async () => {
      const { workspaceId, ana } = await team();
      const tz = "America/New_York";
      // 1 November 2026 lasts 25 hours in New York: the day ends at 05:00Z, not 04:00Z.
      const days = () =>
        create(ana, workspaceId, {
          title: "Day",
          allDay: true,
          timezone: tz,
          start: "2026-10-31T04:00:00Z",
          end: "2026-11-01T04:00:00Z",
          rule: { freq: "daily", count: 4, timezone: tz },
        });
      const one = await days();
      const renamed = await update(ana, workspaceId, one.id, {
        scope: "this",
        instanceStart: "2026-11-01T04:00:00Z",
        title: "Renamed",
      });
      expect([renamed.start, renamed.end]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
      await remove(ana, workspaceId, one.id, { scope: "all" });
      const two = await days();
      const rest = await update(ana, workspaceId, two.id, {
        scope: "following",
        instanceStart: "2026-11-01T04:00:00Z",
        title: "Rest",
      });
      expect([rest.start, rest.end]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
      await remove(ana, workspaceId, two.id, { scope: "all" });
      // A single all-day event moved onto that day by its start only.
      const single = await create(ana, workspaceId, {
        title: "One",
        allDay: true,
        timezone: tz,
        start: "2026-10-30T04:00:00Z",
        end: "2026-10-31T04:00:00Z",
      });
      const moved = await update(ana, workspaceId, single.id, { start: "2026-11-01T04:00:00Z" });
      expect(moved.end).toBe("2026-11-02T05:00:00.000Z");

      // A daily 09:00 in New York moved to UTC without a rule: it is 13:00Z every day, also after 1 November.
      const ny = await create(ana, workspaceId, {
        title: "NY",
        timezone: tz,
        start: "2026-10-30T13:00:00Z",
        end: "2026-10-30T14:00:00Z",
        rule: { freq: "daily", timezone: tz },
      });
      const utc = await update(ana, workspaceId, ny.id, { scope: "all", timezone: "UTC" });
      expect([utc.timezone, utc.rule?.timezone]).toEqual(["UTC", "UTC"]);
      const r = await range(ana, workspaceId, "2026-10-30T00:00:00Z", "2026-11-03T00:00:00Z");
      expect(r.events.filter((e) => e.title === "NY").map((e) => e.start)).toEqual([
        "2026-10-30T13:00:00.000Z",
        "2026-10-31T13:00:00.000Z",
        "2026-11-01T13:00:00.000Z",
        "2026-11-02T13:00:00.000Z",
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the range: proposals that start after it stay out, no shared cache; all-day bounds; the rule's own start is dropped",
    async () => {
      const { workspaceId, ana } = await team();
      const lia = await seedAgent(workspaceId, ana, "lia");
      const proposal = (title: string, start: string, end: string) => ({
        id: newId("prop"),
        workspaceId,
        agentId: lia,
        title,
        start: new Date(start),
        end: new Date(end),
        participants: [{ type: "person" as const, id: ana.user.id }],
      });
      await server.deps.db
        .insert(schema.calendarProposals)
        .values([
          proposal("Crossing in", "2026-11-17T23:00:00Z", "2026-11-18T01:00:00Z"),
          proposal("Inside", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z"),
          proposal("Later", "2026-11-25T10:00:00Z", "2026-11-25T11:00:00Z"),
        ]);
      const q = new URLSearchParams({ from: "2026-11-18T00:00:00Z", to: "2026-11-22T00:00:00Z" });
      const res = await ana.browser.json(`/api/v1/workspaces/${workspaceId}/calendar?${q}`, "GET");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const got: CalendarRange = await body(res);
      expect(got.proposals.map((p) => p.title).sort()).toEqual(["Crossing in", "Inside"]);

      // An all-day event from 10:00 to 11:00 the same day would end at midnight, before it starts.
      const sameDay = await call(ana, workspaceId, "POST", "/calendar/events", {
        title: "Off",
        allDay: true,
        timezone: "UTC",
        start: "2026-11-20T10:00:00Z",
        end: "2026-11-20T11:00:00Z",
      });
      expect([sameDay.status, sameDay.json.error.code]).toEqual([400, "calendar.all_day_span"]);
      const day = await create(ana, workspaceId, {
        title: "Off",
        allDay: true,
        timezone: "UTC",
        start: "2026-11-20T00:00:00Z",
        end: "2026-11-21T00:00:00Z",
        rule: { freq: "weekly", timezone: "UTC", start: "2030-01-01T00:00:00Z" },
      });
      expect(day.rule?.start).toBeUndefined();
      const shrunk = await call(ana, workspaceId, "PATCH", `/calendar/events/${day.id}`, {
        end: "2026-11-20T12:00:00Z",
      });
      expect([shrunk.status, shrunk.json.error.code]).toEqual([400, "calendar.all_day_span"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a daily 09:00 in New York stays at 09:00 local across the end of daylight saving",
    async () => {
      const { workspaceId, ana } = await team();
      await create(ana, workspaceId, {
        title: "Standup",
        start: "2026-10-30T13:00:00Z",
        end: "2026-10-30T13:15:00Z",
        timezone: "America/New_York",
        rule: { freq: "daily", timezone: "America/New_York" },
      });
      const r = await range(ana, workspaceId, "2026-10-30T00:00:00Z", "2026-11-03T00:00:00Z");
      // EDT (UTC-4) until Sunday 1 November 2026, EST (UTC-5) from then on.
      expect(r.events.map((e) => e.start)).toEqual([
        "2026-10-30T13:00:00.000Z",
        "2026-10-31T13:00:00.000Z",
        "2026-11-01T14:00:00.000Z",
        "2026-11-02T14:00:00.000Z",
      ]);
      const tz = await call(ana, workspaceId, "POST", "/calendar/events", {
        title: "x",
        start: "2026-11-03T13:00:00Z",
        end: "2026-11-03T14:00:00Z",
        timezone: "Mars/Olympus",
      });
      expect(tz.json.error.code).toBe("rule.timezone");
    },
    SERVER_TEST_MS,
  );

  test(
    "a range is at most MAX_RANGE_DAYS long, and a routine shows at most ROUTINE_TIMES_MAX times in it",
    async () => {
      const { workspaceId, general, ana } = await team();
      const from = new Date("2026-01-01T00:00:00Z");
      const at = (days: number) => new Date(from.getTime() + days * DAY).toISOString();
      expect(
        (await call(ana, workspaceId, "GET", `/calendar?from=${from.toISOString()}&to=${at(MAX_RANGE_DAYS)}`))
          .status,
      ).toBe(200);
      const longer = await call(
        ana,
        workspaceId,
        "GET",
        `/calendar?from=${from.toISOString()}&to=${at(MAX_RANGE_DAYS + 1)}`,
      );
      expect([longer.status, longer.json.error.code]).toEqual([400, "calendar.range"]);
      const lia = await seedAgent(workspaceId, ana, "tick");
      await server.deps.db.insert(schema.routines).values({
        id: newId("rtn"),
        workspaceId,
        name: "Every hour",
        prompt: "x",
        agentId: lia,
        target: { kind: "channel", channelId: general },
        trigger: { kind: "schedule", rule: { freq: "hourly", timezone: "UTC" } },
        createdBy: ana.user.id,
        createdAt: from,
      });
      const r = await range(ana, workspaceId, from.toISOString(), at(30));
      expect(r.routines).toHaveLength(ROUTINE_TIMES_MAX);
    },
    SERVER_TEST_MS,
  );
});

describe("who may call", () => {
  test(
    "without a session 401 and a non-member 404 on every route; only the creator, a participant or an admin edits",
    async () => {
      const { workspaceId, ana, beto, caio } = await team();
      const e = await create(ana, workspaceId, {
        title: "Planning",
        start: "2026-11-03T13:00:00Z",
        end: "2026-11-03T14:00:00Z",
      });
      const lia = await seedAgent(workspaceId, ana, "lia");
      const prop = newId("prop");
      await server.deps.db.insert(schema.calendarProposals).values({
        id: prop,
        workspaceId,
        agentId: lia,
        title: "Sync",
        start: new Date("2026-11-04T13:00:00Z"),
        end: new Date("2026-11-04T14:00:00Z"),
        participants: [{ type: "person", id: beto.user.id }],
      });
      const routes: [string, string, unknown?][] = [
        ["GET", "/calendar?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z"],
        [
          "POST",
          "/calendar/events",
          { title: "x", start: "2026-11-03T13:00:00Z", end: "2026-11-03T14:00:00Z" },
        ],
        ["PATCH", `/calendar/events/${e.id}`, { title: "x" }],
        ["DELETE", `/calendar/events/${e.id}`],
        ["POST", `/calendar/proposals/${prop}/confirm`],
        ["POST", `/calendar/proposals/${prop}/dismiss`],
      ];
      const stranger = await signedIn(server, "Zed", email("zed"));
      await seedWorkspace(server, stranger, "Elsewhere");
      const anonymous = new Browser(server.url);
      for (const [method, path, data] of routes) {
        expect([path, (await call(anonymous, workspaceId, method, path, data)).status]).toEqual([path, 401]);
        expect([path, (await call(stranger, workspaceId, method, path, data)).status]).toEqual([path, 404]);
      }
      // Planning has no participants: Caio (a member) sees it but neither edits nor deletes it.
      const edit = await call(caio, workspaceId, "PATCH", `/calendar/events/${e.id}`, { title: "Mine" });
      expect([edit.status, edit.json.error.code]).toEqual([403, "forbidden"]);
      expect((await call(caio, workspaceId, "DELETE", `/calendar/events/${e.id}`)).status).toBe(403);
      // A participant other than Beto (Caio) can't answer Beto's proposal; the owner (an admin) can.
      expect((await call(caio, workspaceId, "POST", `/calendar/proposals/${prop}/dismiss`)).status).toBe(404);
      expect(
        (
          await ok<CalendarEvent>(
            call(ana, workspaceId, "PATCH", `/calendar/events/${e.id}`, { title: "Ok" }),
          )
        ).title,
      ).toBe("Ok");
      await ok(call(ana, workspaceId, "POST", `/calendar/proposals/${prop}/dismiss`), 204);
    },
    SERVER_TEST_MS,
  );

  test(
    "deleting a whole series tells the people of every part it removes",
    async () => {
      const { workspaceId, ana, beto, caio } = await team();
      const daily = await create(ana, workspaceId, {
        title: "Review",
        start: "2026-11-15T10:00:00Z",
        end: "2026-11-15T11:00:00Z",
        timezone: "UTC",
        participants: [{ type: "person", id: beto.user.id }],
        rule: { freq: "daily", count: 4, timezone: "UTC" },
      });
      // Caio is in the later part only.
      await update(ana, workspaceId, daily.id, {
        scope: "following",
        instanceStart: "2026-11-17T10:00:00Z",
        participants: [{ type: "person", id: caio.user.id }],
      });
      const ws = await TestSocket.open(caio.browser, workspaceId);
      try {
        await remove(ana, workspaceId, daily.id, { scope: "all" });
        expect((await ws.event("calendar_event.removed")).event).toMatchObject({
          eventId: daily.id,
          scope: "all",
        });
      } finally {
        ws.close();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    'a participant of one part of a split series changes only that part: "all" and "following" check every part',
    async () => {
      const { workspaceId, ana, caio } = await team();
      const listed = async () =>
        (await range(ana, workspaceId, "2026-11-14T00:00:00Z", "2026-11-21T00:00:00Z")).events.map((x) => [
          x.start,
          x.title,
        ]);
      const daily = await create(ana, workspaceId, {
        title: "Stand-up",
        start: "2026-11-15T10:00:00Z",
        end: "2026-11-15T11:00:00Z",
        timezone: "UTC",
        rule: { freq: "daily", interval: 1, timezone: "UTC", count: 5 },
      });
      // Caio is in the later part only.
      const part = await update(ana, workspaceId, daily.id, {
        scope: "following",
        instanceStart: "2026-11-17T10:00:00Z",
        participants: [{ type: "person", id: caio.user.id }],
      });
      const before = await listed();
      const all = await call(caio, workspaceId, "PATCH", `/calendar/events/${part.id}`, {
        scope: "all",
        title: "Taken",
      });
      expect([all.status, all.json.error.code]).toEqual([403, "forbidden"]);
      expect((await call(caio, workspaceId, "DELETE", `/calendar/events/${part.id}?scope=all`)).status).toBe(
        403,
      );
      // A later part made by Ana without Caio: "following" from Caio's part would delete it too.
      await update(ana, workspaceId, part.id, {
        scope: "following",
        instanceStart: "2026-11-19T10:00:00Z",
        participants: [],
      });
      const following = new URLSearchParams({ scope: "following", instanceStart: "2026-11-18T10:00:00Z" });
      expect(
        (await call(caio, workspaceId, "DELETE", `/calendar/events/${part.id}?${following}`)).status,
      ).toBe(403);
      expect(await listed()).toEqual(before);
      // His own part he still changes on its own.
      await ok(
        call(caio, workspaceId, "PATCH", `/calendar/events/${part.id}`, {
          scope: "this",
          instanceStart: "2026-11-17T10:00:00Z",
          title: "Mine",
        }),
      );
      await remove(ana, workspaceId, daily.id, { scope: "all" });
    },
    SERVER_TEST_MS,
  );
});

describe("at the same time", () => {
  test(
    "two confirmations of one proposal make one event; the other gets proposal_closed",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const lia = await seedAgent(workspaceId, ana, "lia");
      const prop = newId("prop");
      await server.deps.db.insert(schema.calendarProposals).values({
        id: prop,
        workspaceId,
        agentId: lia,
        title: "Sync",
        start: new Date("2026-11-04T13:00:00Z"),
        end: new Date("2026-11-04T14:00:00Z"),
        participants: [
          { type: "person", id: ana.user.id },
          { type: "person", id: beto.user.id },
        ],
      });
      const answers = await Promise.all(
        [ana, beto, ana, beto].map((who) =>
          call(who, workspaceId, "POST", `/calendar/proposals/${prop}/confirm`),
        ),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([201, 409, 409, 409]);
      const events = await server.deps.db
        .select()
        .from(schema.calendarEntries)
        .where(eq(schema.calendarEntries.workspaceId, workspaceId));
      expect(events.map((e) => e.title)).toEqual(["Sync"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "occurrences taken out of one series at the same time all stay out",
    async () => {
      const { workspaceId, ana } = await team();
      const daily = await create(ana, workspaceId, {
        title: "Daily",
        start: "2026-11-02T12:00:00Z",
        end: "2026-11-02T12:15:00Z",
        timezone: "UTC",
        rule: { freq: "daily", timezone: "UTC" },
      });
      const days = ["03", "04", "05", "06"];
      await Promise.all(
        days.map((d) =>
          remove(ana, workspaceId, daily.id, { scope: "this", instanceStart: `2026-11-${d}T12:00:00Z` }),
        ),
      );
      const r = await range(ana, workspaceId, "2026-11-02T00:00:00Z", "2026-11-08T00:00:00Z");
      expect(r.events.map((e) => e.start.slice(8, 10))).toEqual(["02", "07"]);
    },
    SERVER_TEST_MS,
  );
});
