import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const ISSUES = "/workspace/workspace_birchwood/issues";

/** The options a select offers, opened from the keyboard. */
async function optionsOf(combobox: HTMLElement): Promise<string[]> {
  await act(async () => {
    combobox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  return (await screen.findAllByRole("option")).map((option) => option.textContent ?? "");
}

const lane = (name: RegExp) => screen.getByRole("region", { name });
const cardTitles = (region: HTMLElement) =>
  within(region)
    .queryAllByRole("listitem")
    .map((item) => within(item).getByRole("link").textContent);

describe("the board", () => {
  test("a column per open stage with its cards; the canceled column only on request", async () => {
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Issues" });
    expect(screen.getByText("3 issues")).toBeDefined();
    expect(cardTitles(lane(/^To do/))).toEqual(["Reprint the spring catalogue"]);
    expect(cardTitles(lane(/^In progress/))).toEqual(["Draft the release notes"]);
    expect(within(lane(/^In review/)).getByText("Nothing here")).toBeDefined();
    expect(cardTitles(lane(/^Done/))).toEqual(["Archive the old invoices"]);
    expect(screen.queryByRole("region", { name: /^Canceled/ }) === null).toBe(true);
    const card = within(lane(/^To do/)).getByRole("listitem");
    expect(within(card).getByRole("img", { name: "1 of 2 criteria met" })).toBeDefined();
    expect(within(card).getByRole("img", { name: "Priority: High" })).toBeDefined();
    expect(within(card).getByText("Jonas Lind")).toBeDefined();
    expect(within(lane(/^In progress/)).getByText("Agent at work")).toBeDefined();
    await app.user.click(screen.getByRole("switch", { name: "Show canceled" }));
    expect(screen.getByRole("region", { name: /^Canceled/ })).toBeDefined();
  });

  test("who it's with narrows the cards; a search that finds nothing says so in the list", async () => {
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_jonas" });
    await screen.findByRole("region", { name: /^To do/ });
    await app.user.click(screen.getByRole("button", { name: "Agents" }));
    expect(cardTitles(lane(/^To do/))).toEqual([]);
    expect(cardTitles(lane(/^In progress/))).toEqual(["Draft the release notes"]);
    await app.user.click(screen.getByRole("button", { name: "Mine" }));
    expect(cardTitles(lane(/^To do/))).toEqual(["Reprint the spring catalogue"]);
    expect(cardTitles(lane(/^In progress/))).toEqual([]);
    await app.user.click(screen.getByRole("button", { name: "Everyone" }));
    await app.user.click(screen.getByRole("tab", { name: "List" }));
    const table = screen.getByRole("table", { name: "Issues" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    await app.user.type(screen.getByRole("searchbox", { name: "Search issues" }), "pelican");
    await app.advance(300);
    expect(await screen.findByText("Nothing matches")).toBeDefined();
    expect(app.server.calls.some((call) => call.method === "listIssues" && call.params.q === "pelican")).toBe(
      true,
    );
  });

  test("Space picks a card up, the arrows carry it, Space drops it, and the server keeps it there", async () => {
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_ana" });
    const grab = await screen.findByRole("button", { name: "Move #1" });
    grab.focus();
    fireEvent.keyDown(grab, { key: " " });
    expect(screen.getByRole("status").textContent).toBe("#1 picked up in To do, position 1 of 1.");
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: "ArrowRight" });
    expect(screen.getByRole("status").textContent).toBe("#1 is over In progress, position 1 of 2.");
    // Drawn where it would land, before the card already there; and still the focused control.
    expect(cardTitles(lane(/^In progress/))).toEqual([
      "Reprint the spring catalogue",
      "Draft the release notes",
    ]);
    await waitFor(() =>
      expect(document.activeElement === screen.getByRole("button", { name: "Move #1" })).toBe(true),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: " " });
    expect(screen.getByRole("status").textContent).toBe("#1 dropped in In progress, position 2 of 2.");
    await waitFor(() => {
      const moved = app.server.work.issues.find((issue) => issue.number === 1);
      const other = app.server.work.issues.find((issue) => issue.number === 2);
      expect(moved?.columnId).toBe("col_workspace_birchwood_in_progress");
      expect((moved?.boardPosition ?? 0) > (other?.boardPosition ?? 0)).toBe(true);
    });
    expect(cardTitles(lane(/^In progress/))).toEqual([
      "Draft the release notes",
      "Reprint the spring catalogue",
    ]);
  });

  test("Escape puts a carried card back without asking the server", async () => {
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_ana" });
    const grab = await screen.findByRole("button", { name: "Move #1" });
    fireEvent.keyDown(grab, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: "Escape" });
    expect(screen.getByRole("status").textContent).toBe("#1 went back to To do.");
    expect(cardTitles(lane(/^To do/))).toEqual(["Reprint the spring catalogue"]);
    expect(app.server.calls.some((call) => call.method === "updateIssue")).toBe(false);
  });

  test("a move the server refuses goes back, and a toast says why", async () => {
    const server = newServer();
    server.force("updateIssue", { kind: "error", status: 503, code: "unavailable" }, 4);
    await renderApp({ path: ISSUES, signedInAs: "usr_ana", server });
    fireEvent.keyDown(await screen.findByRole("button", { name: "Move #1" }), { key: " " });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Move #1" }), { key: " " });
    expect(await screen.findByText("#1 could not be moved, so it went back")).toBeDefined();
    await waitFor(() => expect(cardTitles(lane(/^To do/))).toEqual(["Reprint the spring catalogue"]));
  });
});

describe("the issues' other states", () => {
  test("no issues yet: what an issue is and how to write one", async () => {
    const server = newServer();
    server.work.issues = [];
    await renderApp({ path: ISSUES, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No issues yet")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "New issue" }).length).toBeGreaterThan(0);
  });

  test("a list that did not load says so and loads again on retry", async () => {
    const server = newServer();
    server.force("listIssues", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The issues could not be loaded")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: /^To do/ })).toBeDefined();
  });
});

describe("a new issue", () => {
  test("its list lines become criteria, and it lands on top of its column", async () => {
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_ana" });
    await app.user.click(await screen.findByRole("button", { name: "New issue" }));
    const dialog = await screen.findByRole("dialog", { name: "New issue" });
    await app.user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Fix the guillotine");
    await app.user.click(within(dialog).getByRole("textbox", { name: "Description" }));
    await app.user.paste("The blade drifts.\n- Blade aligned\n- [ ] Test cut done\n- ");
    expect(within(dialog).getByText(/2 acceptance criteria/)).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Create issue" }));
    expect(await screen.findByText("#4 created")).toBeDefined();
    const created = app.server.work.issues.find((issue) => issue.number === 4);
    expect([created?.description, created?.criteria.map((c) => c.text), created?.priority]).toEqual([
      "The blade drifts.",
      ["Blade aligned", "Test cut done"],
      "none",
    ]);
    await waitFor(() =>
      expect(cardTitles(lane(/^To do/))).toEqual(["Fix the guillotine", "Reprint the spring catalogue"]),
    );
  });

  test("only agents the person may set to work are offered, and no finished column", async () => {
    const server = newServer();
    const ledger = server.agents.find((agent) => agent.id === "agt_ledger");
    if (ledger !== undefined) ledger.reachable = false;
    const app = await renderApp({ path: ISSUES, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "New issue" }));
    const dialog = await screen.findByRole("dialog", { name: "New issue" });
    expect(await optionsOf(within(dialog).getByRole("combobox", { name: "Assignee" }))).toEqual([
      "Unassigned",
      "Scout (@scout)",
      "Tally (@tally)",
      "Ana Beatriz Souza (@ana)",
      "Íris Valença (@iris)",
      "Jonas Lind (@jonas)",
      "Tomás Eriksen (@tomas)",
    ]);
    await app.user.keyboard("{Escape}");
    expect(await optionsOf(within(dialog).getByRole("combobox", { name: "Column" }))).toEqual([
      "To do",
      "In progress",
      "In review",
    ]);
    await app.user.keyboard("{Escape}");
    expect(within(dialog).getByRole("button", { name: "Create issue" }).hasAttribute("disabled")).toBe(true);
  });
});
