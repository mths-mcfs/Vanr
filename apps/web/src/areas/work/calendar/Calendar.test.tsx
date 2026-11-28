import { describe, expect, test } from "bun:test";

// The fixtures are in UTC: the screens read them in the same zone wherever the tests run.
process.env.TZ = "UTC";

import { screen, waitFor, within } from "@testing-library/react";
import type { CalendarEvent, CalendarRange } from "@vanr/contract";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";
import { dayKey, weekDays } from "../time.ts";
import { entriesByDay } from "./Calendar.tsx";

const CALENDAR = "/workspace/workspace_birchwood/calendar";
const day = (name: RegExp) => screen.getByRole("region", { name });

describe("the week", () => {
  test("each day holds its events, due issues and routine runs; proposals wait above", async () => {
    await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Calendar" });
    expect(screen.getByText("Nov 9 – Nov 15, 2026")).toBeDefined();
    expect(within(day(/^Thursday/)).getByRole("button", { name: /Print run review/ })).toBeDefined();
    expect(
      within(day(/^Wednesday/)).getByRole("link", { name: "Due: #1 Reprint the spring catalogue" }),
    ).toBeDefined();
    expect(within(day(/^Sunday/)).getByRole("link", { name: /Routine: Morning digest/ })).toBeDefined();
    expect(day(/^Saturday/).getAttribute("aria-current")).toBe("date");
    const proposals = screen.getByRole("region", { name: "Proposed by agents" });
    expect(within(proposals).getByText("Scout proposes")).toBeDefined();
    expect(within(proposals).getByText("They answer before noon on Fridays.")).toBeDefined();
  });

  test("a proposal added to the calendar becomes an event on its day", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    const proposal = within(await screen.findByRole("region", { name: "Proposed by agents" }));
    await app.user.click(proposal.getByRole("button", { name: "Add to calendar" }));
    expect(await screen.findByText("“Paper supplier call” is on the calendar")).toBeDefined();
    await waitFor(() =>
      expect(within(day(/^Friday/)).getByRole("button", { name: /Paper supplier call/ })).toBeDefined(),
    );
    expect(screen.queryByRole("region", { name: "Proposed by agents" }) === null).toBe(true);
  });

  test("answering one proposal keeps another's buttons waiting while its answer is on its way", async () => {
    const server = newServer();
    const first = server.work.proposals[0];
    if (first !== undefined)
      server.work.proposals.push({ ...first, id: "prp_proof", title: "Proof sign-off", note: null });
    const held = server.hold("confirmCalendarProposal");
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana", server });
    const proposals = within(await screen.findByRole("region", { name: "Proposed by agents" }));
    const confirmOf = (title: string) =>
      within(proposals.getByRole("listitem", { name: title })).getByRole("button", {
        name: "Add to calendar",
      });
    await app.user.click(confirmOf("Paper supplier call"));
    await app.user.click(confirmOf("Proof sign-off"));
    expect((confirmOf("Paper supplier call") as HTMLButtonElement).disabled).toBe(true);
    expect((confirmOf("Proof sign-off") as HTMLButtonElement).disabled).toBe(true);
    held.release();
    expect(await screen.findByText("“Paper supplier call” is on the calendar")).toBeDefined();
    expect(await screen.findByText("“Proof sign-off” is on the calendar")).toBeDefined();
  });

  test("a whole-day event made three hours behind UTC stays on its one day", async () => {
    process.env.TZ = "America/Sao_Paulo";
    try {
      const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
      await app.user.click(await screen.findByRole("button", { name: /^Add an event on Tuesday/ }));
      const dialog = within(await screen.findByRole("dialog", { name: "New event" }));
      await app.user.type(dialog.getByRole("textbox", { name: "Title" }), "Stock count");
      await app.user.click(dialog.getByRole("checkbox", { name: "All day" }));
      await app.user.click(dialog.getByRole("button", { name: "Create event" }));
      expect(await screen.findByText("“Stock count” added")).toBeDefined();
      const made = app.server.work.events.find((event) => event.title === "Stock count");
      expect([made?.startDate, made?.endDate]).toEqual(["2026-11-10", "2026-11-10"]);
      expect(await within(day(/^Tuesday/)).findByRole("button", { name: /Stock count/ })).toBeDefined();
      expect(within(day(/^Wednesday/)).queryByRole("button", { name: /Stock count/ }) === null).toBe(true);
    } finally {
      process.env.TZ = "UTC";
    }
  });

  test("a proposal answered elsewhere leaves the list when this page tries to answer it", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    const proposals = within(await screen.findByRole("region", { name: "Proposed by agents" }));
    const proposal = app.server.work.proposals.find((each) => each.id === "prp_sync");
    if (proposal !== undefined) proposal.status = "confirmed";
    await app.user.click(proposals.getByRole("button", { name: "Add to calendar" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Proposed by agents" }) === null).toBe(true),
    );
  });

  test("another week, and back to this one", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    await screen.findByRole("region", { name: /^Thursday/ });
    await app.user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByText("Nov 16 – Nov 22, 2026")).toBeDefined();
    expect(
      await screen.findByText("Nothing planned this week: no events, routine runs or due issues."),
    ).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "This week" }));
    expect(await screen.findByText("Nov 9 – Nov 15, 2026")).toBeDefined();
  });

  test("a weekly series starts at 10:00 on the day picked, and one occurrence is deleted", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: /^Add an event on Monday/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "New event" }));
    expect((dialog.getByLabelText("Starts") as HTMLInputElement).value).toBe("2026-11-09T10:00");
    expect((dialog.getByLabelText("Ends") as HTMLInputElement).value).toBe("2026-11-09T11:00");
    await app.user.type(dialog.getByRole("textbox", { name: "Title" }), "Press check");
    await chooseOption(app, dialog.getByRole("combobox", { name: "Repeats" }), "Every week on Monday");
    await app.user.click(dialog.getByRole("button", { name: "Create event" }));
    expect(await screen.findByText("“Press check” added")).toBeDefined();
    const saved = app.server.work.events.find((event) => event.title === "Press check");
    expect(saved?.rule?.freq).toBe("weekly");
    expect(saved?.rule?.weekdays).toEqual(["MO"]);

    await app.user.click(await within(day(/^Monday/)).findByRole("button", { name: /Press check/ }));
    const open = within(await screen.findByRole("dialog", { name: "Press check" }));
    expect(open.getByText("Every week on Monday")).toBeDefined();
    await app.user.click(open.getByRole("radio", { name: "Only this one" }));
    await app.user.click(open.getByRole("button", { name: "Delete event" }));
    expect(await screen.findByText("Event deleted")).toBeDefined();
    expect(saved?.exdates).toHaveLength(1);
    await waitFor(() =>
      expect(within(day(/^Monday/)).queryByRole("button", { name: /Press check/ }) === null).toBe(true),
    );
    await app.user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await within(day(/^Monday/)).findByRole("button", { name: /Press check/ })).toBeDefined();
  });

  test("an event ending before it starts can't be sent", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New event" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New event" }));
    await app.user.type(dialog.getByRole("textbox", { name: "Title" }), "Backwards");
    const ends = dialog.getByLabelText("Ends");
    await app.user.clear(ends);
    await app.user.type(ends, "2026-11-14T09:00");
    expect(dialog.getByText("It has to end after it starts.")).toBeDefined();
    expect(dialog.getByRole("button", { name: "Create event" }).hasAttribute("disabled")).toBe(true);
  });

  test("someone who didn't add an event and isn't in it sees it without a delete", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_iris" });
    await app.user.click(await within(day(/^Thursday/)).findByRole("button", { name: /Print run review/ }));
    const open = within(await screen.findByRole("dialog", { name: "Print run review" }));
    expect(open.getByText("Press room")).toBeDefined();
    expect(open.getByText("Everyone in the workspace")).toBeDefined();
    expect(open.queryByRole("button", { name: "Delete event" }) === null).toBe(true);
  });

  test("a week that did not load says so and loads again on retry", async () => {
    const server = newServer();
    server.force("getCalendar", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The calendar could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: /^Thursday/ })).toBeDefined();
  });
  test("a whole-day weekly series shows on its day in the next week too", async () => {
    const server = newServer();
    server.work.events.push(
      server.work.event("workspace_birchwood", {
        id: "evt_fair",
        title: "Trade fair",
        start: "2026-11-10T00:00:00.000Z",
        end: "2026-11-11T00:00:00.000Z",
        allDay: true,
        startDate: "2026-11-10",
        endDate: "2026-11-10",
        rule: { freq: "weekly", weekdays: ["TU"], timezone: "UTC" },
        createdBy: { type: "person", id: "usr_ana" },
      }),
    );
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana", server });
    expect(
      await within(await screen.findByRole("region", { name: /^Tuesday/ })).findByRole("button", {
        name: /Trade fair/,
      }),
    ).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByText("Nov 16 – Nov 22, 2026")).toBeDefined();
    expect(await within(day(/^Tuesday/)).findByRole("button", { name: /Trade fair/ })).toBeDefined();
  });
  test("a weekly series reads its weekday where the rule lives, not in UTC", async () => {
    const server = newServer();
    // Monday 23:30 in São Paulo is Tuesday 02:30 in UTC, where the page reads it.
    server.work.events.push(
      server.work.event("workspace_birchwood", {
        id: "evt_late",
        title: "Late press check",
        start: "2026-11-10T02:30:00.000Z",
        end: "2026-11-10T03:00:00.000Z",
        rule: { freq: "weekly", weekdays: ["MO"], timezone: "America/Sao_Paulo" },
        createdBy: { type: "person", id: "usr_ana" },
      }),
    );
    await renderApp({ path: CALENDAR, signedInAs: "usr_ana", server });
    expect(
      await within(await screen.findByRole("region", { name: /^Tuesday/ })).findByRole("button", {
        name: /Late press check/,
      }),
    ).toBeDefined();
  });
  test("the new-event form says who sees an event, and Escape gives the focus back to its button", async () => {
    const app = await renderApp({ path: CALENDAR, signedInAs: "usr_ana" });
    const button = await screen.findByRole("button", { name: "New event" });
    await app.user.click(button);
    const dialog = within(await screen.findByRole("dialog", { name: "New event" }));
    expect(dialog.getByText("With no one invited, everyone in the workspace sees it.")).toBeDefined();
    await app.user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.activeElement === screen.getByRole("button", { name: "New event" })).toBe(true),
    );
  });
});

describe("what a day holds", () => {
  const range = (events: Partial<CalendarEvent>[]): CalendarRange => ({
    dueItems: [],
    routines: [],
    proposals: [],
    events: events.map((event, at) => ({
      id: `evt_${at}`,
      allDay: false,
      createdBy: { type: "person", id: "usr_ana" },
      description: null,
      end: "",
      endDate: null,
      instanceStart: null,
      location: null,
      participants: [],
      recurrence: null,
      rule: null,
      seriesId: null,
      start: "",
      startDate: null,
      timezone: "UTC",
      title: "",
      ...event,
    })),
  });
  const week = weekDays(new Date(2026, 10, 9));
  const titles = (map: Map<string, unknown[]>, day: Date) =>
    (map.get(dayKey(day)) ?? []).map((entry) => (entry as { event?: CalendarEvent }).event?.title);

  test("a year-long all-day event shows on every day of the week", () => {
    const map = entriesByDay(
      range([{ title: "Fiscal year", allDay: true, startDate: "2026-01-01", endDate: "2026-12-31" }]),
      week,
    );
    for (const day of week) expect(titles(map, day)).toEqual(["Fiscal year"]);
  });

  test("an event across midnight shows on both days, and not on the day its end touches", () => {
    const sunday = new Date(2026, 10, 8, 23);
    const monday = new Date(2026, 10, 10, 0);
    const map = entriesByDay(
      range([
        { title: "Night run", start: sunday.toISOString(), end: new Date(2026, 10, 9, 1).toISOString() },
        { title: "Late shift", start: new Date(2026, 10, 9, 22).toISOString(), end: monday.toISOString() },
      ]),
      week,
    );
    expect(titles(map, week[0] ?? new Date())).toEqual(["Night run", "Late shift"]);
    expect(titles(map, week[1] ?? new Date())).toEqual([]);
  });
});
