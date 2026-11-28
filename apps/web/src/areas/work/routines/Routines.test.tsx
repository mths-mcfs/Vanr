import { describe, expect, test } from "bun:test";

// The fixtures are in UTC: the screens read them in the same zone wherever the tests run.
process.env.TZ = "UTC";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const ROUTINES = "/workspace/workspace_birchwood/routines";
const card = (name: string) => within(screen.getByRole("article", { name }));

describe("the routines", () => {
  test("what each one does, when, where, and how its last run went", async () => {
    await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Routines" });
    const digest = card("Morning digest");
    expect(digest.getByText("Scout")).toBeDefined();
    expect(digest.getByText("Every day at 09:00")).toBeDefined();
    expect(digest.getByText("In a direct conversation with the agent")).toBeDefined();
    expect(digest.getByText(/^Next run /)).toBeDefined();
    expect(digest.getByText(/Last run .*: Done/)).toBeDefined();
    const watcher = card("Invoice watcher");
    expect(watcher.getByText("Paused")).toBeDefined();
    expect(watcher.getByText("When its web address is called")).toBeDefined();
    expect(watcher.getByText("In #print-queue")).toBeDefined();
  });

  test("run now: it starts, and its details show the run with a way into the conversation", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await screen.findByRole("article", { name: "Morning digest" });
    await app.user.click(card("Morning digest").getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("Morning digest started")).toBeDefined();
    const runs = await card("Morning digest").findByRole("list", { name: "Recent runs" });
    await waitFor(() => expect(within(runs).getByText("Started by hand")).toBeDefined());
    expect(within(runs).getAllByRole("link", { name: "Open the conversation" }).length).toBe(2);
    expect(
      card("Morning digest").getByText(
        "Up to $2.00 a run. The last 3 runs cost $0.12 on average, $0.30 at most.",
      ),
    ).toBeDefined();
  });

  test("an admin turns another person's routine on, and deletes one after confirming", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await screen.findByRole("article", { name: "Invoice watcher" });
    await app.user.click(card("Invoice watcher").getByRole("switch", { name: "Run Invoice watcher" }));
    expect(await screen.findByText("Invoice watcher turned on")).toBeDefined();
    expect(app.server.work.routines.find((routine) => routine.id === "rtn_invoices")?.active).toBe(true);
    await app.user.click(card("Morning digest").getByRole("button", { name: "Delete" }));
    const confirm = within(await screen.findByRole("alertdialog", { name: "Delete Morning digest?" }));
    await app.user.click(confirm.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Morning digest deleted")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Morning digest" }) === null).toBe(true),
    );
  });

  test("a routine answering in a channel the person can't open can't be duplicated", async () => {
    const server = newServer();
    const watcher = server.work.routines.find((routine) => routine.id === "rtn_invoices");
    if (watcher !== undefined) watcher.target = { kind: "channel", channelId: "ch_hidden" };
    await renderApp({ path: ROUTINES, signedInAs: "usr_ana", server });
    await screen.findByRole("article", { name: "Invoice watcher" });
    expect(card("Invoice watcher").getByText("In a channel you can't open")).toBeDefined();
    expect(card("Invoice watcher").queryByRole("button", { name: "Duplicate" }) === null).toBe(true);
    expect(card("Morning digest").getByRole("button", { name: "Duplicate" })).toBeDefined();
  });

  test("a member sees a routine of a channel they read, but can't run, pause or delete it, nor see its cost", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_iris" });
    await screen.findByRole("article", { name: "Invoice watcher" });
    // Ana's routine answers in her own conversation with the agent: Íris doesn't see it.
    expect(screen.queryByRole("article", { name: "Morning digest" }) === null).toBe(true);
    const watcher = card("Invoice watcher");
    expect(watcher.queryByRole("switch") === null).toBe(true);
    expect(watcher.queryByRole("button", { name: "Run now" }) === null).toBe(true);
    expect(watcher.queryByRole("button", { name: "Delete" }) === null).toBe(true);
    await app.user.click(watcher.getByRole("button", { name: "Details of Invoice watcher" }));
    expect(await watcher.findByRole("region", { name: "Recent runs" })).toBeDefined();
    expect(watcher.queryByRole("region", { name: "What it costs" }) === null).toBe(true);
  });

  test("an admin who isn't in a private channel can't duplicate the routine that answers there", async () => {
    const server = newServer();
    server.state.channels.push({
      id: "ch_board",
      workspaceId: "workspace_birchwood",
      name: "board",
      topic: "",
      isGeneral: false,
      visibility: "private",
      budgetPerMonthUsd: null,
      createdAt: "2026-11-02T09:00:00.000Z",
      memberIds: ["usr_ana"],
    });
    const watcher = server.work.routines.find((routine) => routine.id === "rtn_invoices");
    if (watcher !== undefined) watcher.target = { kind: "channel", channelId: "ch_board" };
    await renderApp({ path: ROUTINES, signedInAs: "usr_jonas", server });
    await screen.findByRole("article", { name: "Invoice watcher" });
    expect(card("Invoice watcher").queryByRole("button", { name: "Duplicate" }) === null).toBe(true);
  });

  test("a double click on run now runs it once", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    const runNow = (await screen.findAllByRole("button", { name: "Run now" }))[0] as HTMLElement;
    const before = app.server.work.runs.length;
    fireEvent.click(runNow);
    fireEvent.click(runNow);
    expect(await screen.findByText("Morning digest started")).toBeDefined();
    await waitFor(() =>
      expect(app.server.calls.filter((call) => call.method === "runRoutine").length).toBeGreaterThan(0),
    );
    const keys = new Set(
      app.server.calls.filter((call) => call.method === "runRoutine").map((call) => call.params.key),
    );
    expect(keys.size).toBe(1);
    expect(app.server.work.runs.length).toBe(before + 1);
  });

  test("the limits keep what is typed until the routine is sent", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New routine" }));
    await app.user.type(dialog.getByRole("textbox", { name: "Name" }), "Limits");
    await app.user.type(dialog.getByRole("textbox", { name: "Instruction" }), "Do it.");
    await app.user.click(dialog.getByRole("combobox", { name: "Runs" }));
    await app.user.click(await screen.findByRole("option", { name: "When a web address is called" }));
    await app.user.click(dialog.getByText("Limits"));
    const field = (name: string) => dialog.getByRole("textbox", { name });
    for (const [name, value] of [
      ["Most it may spend per run (USD)", "1.5"],
      ["Most minutes per run", "45"],
    ] as const) {
      await app.user.clear(field(name));
      await app.user.type(field(name), value);
      expect((field(name) as HTMLInputElement).value).toBe(value);
    }
    await app.user.clear(field("Most steps per run"));
    await app.user.type(field("Most steps per run"), "0.25");
    expect(dialog.getByText("A number from 1 to 50.")).toBeDefined();
    expect(dialog.getByRole("button", { name: "Create routine" }).hasAttribute("disabled")).toBe(true);
    await app.user.clear(field("Most steps per run"));
    await app.user.type(field("Most steps per run"), "20");
    await app.user.click(dialog.getByRole("button", { name: "Create routine" }));
    expect(await screen.findByText("Limits created")).toBeDefined();
    const made = app.server.work.routines.find((routine) => routine.name === "Limits");
    expect([made?.policy.maxCostUsd, made?.policy.maxMinutes, made?.policy.maxSteps]).toEqual([1.5, 45, 20]);
  });

  test("a webhook's secret is made and shown once", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_jonas" });
    await screen.findByRole("article", { name: "Invoice watcher" });
    await app.user.click(card("Invoice watcher").getByRole("button", { name: "Details of Invoice watcher" }));
    expect(
      card("Invoice watcher").getByText("https://vanr.test/api/v1/hooks/routines/rtn_invoices"),
    ).toBeDefined();
    expect(card("Invoice watcher").getByText(/No secret yet/)).toBeDefined();
    await app.user.click(card("Invoice watcher").getByRole("button", { name: "Make a secret" }));
    const dialog = within(await screen.findByRole("dialog", { name: "The webhook's secret" }));
    expect(dialog.getByText(/^whsec_/)).toBeDefined();
    expect(dialog.getByText(/won't be shown again/)).toBeDefined();
  });

  test("a new routine reads its schedule back before it is created, and starts paused", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New routine" }));
    await app.user.type(dialog.getByRole("textbox", { name: "Name" }), "Paper check");
    await app.user.type(dialog.getByRole("textbox", { name: "Instruction" }), "Count the paper left.");
    await app.user.type(dialog.getByRole("textbox", { name: "Schedule" }), "every day at 9am");
    expect(await dialog.findByText(/^Every day at 09:00\. Next run /)).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Create routine" }));
    expect(await screen.findByText("Paper check created")).toBeDefined();
    expect(app.server.work.routines.find((routine) => routine.name === "Paper check")?.active).toBe(false);
    expect(await screen.findByRole("article", { name: "Paper check" })).toBeDefined();
  });

  test("a schedule that isn't understood holds the routine back", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New routine" }));
    await app.user.type(dialog.getByRole("textbox", { name: "Name" }), "Odd");
    await app.user.type(dialog.getByRole("textbox", { name: "Instruction" }), "Do it.");
    await app.user.type(dialog.getByRole("textbox", { name: "Schedule" }), "whenever the moon is full");
    expect(await dialog.findByText(/That schedule wasn't understood/)).toBeDefined();
    expect(dialog.getByRole("button", { name: "Create routine" }).hasAttribute("disabled")).toBe(true);
  });

  test("with no agent to set to work, a new routine can't be started", async () => {
    const server = newServer();
    for (const agent of server.agents) agent.reachable = false;
    await renderApp({ path: ROUTINES, signedInAs: "usr_iris", server });
    expect(await screen.findByText(/Routines need an agent you can talk to/)).toBeDefined();
    expect(screen.getByRole("button", { name: "New routine" }).hasAttribute("disabled")).toBe(true);
  });

  test("no routines yet: what a routine is", async () => {
    const server = newServer();
    server.work.routines = [];
    await renderApp({ path: ROUTINES, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No routines yet")).toBeDefined();
  });

  test("a list that did not load says so and loads on retry", async () => {
    const server = newServer();
    server.force("listRoutines", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The routines could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "Morning digest" })).toBeDefined();
  });
  test("a run with nothing to say says so in the person's language, and the full instruction opens in the details", async () => {
    const server = newServer();
    server.work.runs.unshift({
      ...(server.work.runs[0] as (typeof server.work.runs)[number]),
      id: "rrun_quiet",
      summary: null,
      summaryKey: "routines.run.silent",
      status: "silent",
    });
    const digest = server.work.routines.find((routine) => routine.id === "rtn_digest");
    if (digest !== undefined) digest.prompt = "Line one\nLine two\nLine three\nLine four is the end";
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana", server });
    await screen.findByRole("article", { name: "Morning digest" });
    await app.user.click(card("Morning digest").getByRole("button", { name: "Details of Morning digest" }));
    expect(await card("Morning digest").findByText("The agent had nothing to report.")).toBeDefined();
    const instruction = within(card("Morning digest").getByRole("region", { name: "Instruction" }));
    expect(instruction.getByText(/Line four is the end/)).toBeDefined();
  });

  test("a schedule that couldn't be checked says so and checks again on retry", async () => {
    const server = newServer();
    server.force("parseRoutineSchedule", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New routine" }));
    await app.user.type(dialog.getByRole("textbox", { name: "Schedule" }), "every day at 9am");
    expect(await dialog.findByText("The schedule couldn't be checked.")).toBeDefined();
    await app.user.click(dialog.getByRole("button", { name: "Retry" }));
    expect(await dialog.findByText(/^Every day at 09:00\. Next run /)).toBeDefined();
  });
  test("a time with impossible minutes isn't taken as a schedule", async () => {
    const app = await renderApp({ path: ROUTINES, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New routine" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New routine" }));
    await app.user.type(dialog.getByRole("textbox", { name: "Schedule" }), "every day at 09:99");
    expect(await dialog.findByText(/That schedule wasn't understood/)).toBeDefined();
  });
});
