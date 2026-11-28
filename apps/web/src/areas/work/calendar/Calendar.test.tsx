import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { chooseOption, newServer, renderApp } from "../../../../test/app.tsx";

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
});
