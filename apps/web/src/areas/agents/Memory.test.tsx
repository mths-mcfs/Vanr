import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../test/app.tsx";

const BASE = "/workspace/workspace_birchwood/agents/agt_scout";
const notes = (name: RegExp) =>
  within(screen.getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".memory-note__text")?.textContent);

describe("the agent's memory", () => {
  test("notes by tab with their counts, and a search over subject and text", async () => {
    const app = await renderApp({ path: `${BASE}?tab=memory`, signedInAs: "usr_iris" });
    expect(await screen.findByRole("tab", { name: "On record (2)" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Picked up (1)" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Set aside (1)" })).toBeDefined();
    expect(notes(/^On record/)).toEqual(["The shop orders paper on Mondays.", "Late orders go to Jonas."]);
    const paper = within(screen.getByRole("list", { name: /^On record/ })).getAllByRole("listitem")[0];
    expect(paper?.textContent).toContain("About paper");
    expect(paper?.textContent).toContain("3 uses");
    await app.user.type(screen.getByLabelText("Search the memory"), "JONAS");
    expect(notes(/^On record/)).toEqual(["Late orders go to Jonas."]);
    await app.user.clear(screen.getByLabelText("Search the memory"));
    await app.user.type(screen.getByLabelText("Search the memory"), "zebra");
    expect(screen.getByText("Nothing here matches “zebra”.")).toBeDefined();
  });

  test("a member reads the notes and their history, without the controls", async () => {
    const app = await renderApp({ path: `${BASE}?tab=memory`, signedInAs: "usr_iris" });
    await screen.findByRole("list", { name: /^On record/ });
    expect(screen.queryByRole("button", { name: "Edit" }) === null).toBe(true);
    await app.user.click(screen.getAllByRole("button", { name: "History" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "History of the note" });
    expect(within(dialog).getByText("Version 1")).toBeDefined();
  });

  test("the owner rewrites, pins, archives a note and undoes a person's edit", async () => {
    const app = await renderApp({ path: `${BASE}?tab=memory`, signedInAs: "usr_ana" });
    const list = await screen.findByRole("list", { name: /^On record/ });
    const [paper, late] = within(list).getAllByRole("listitem");
    await app.user.click(within(paper as HTMLElement).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit the note about paper" });
    await app.user.clear(within(form).getByLabelText("Text"));
    await app.user.type(within(form).getByLabelText("Text"), "Paper comes on Tuesdays.");
    await app.user.click(within(form).getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Note saved")).toBeDefined();
    await waitFor(() => expect(notes(/^On record/)).toContain("Paper comes on Tuesdays."));
    expect(app.server.agentAccess.memories.find((memory) => memory.id === "mem_paper")?.text).toBe(
      "Paper comes on Tuesdays.",
    );

    await app.user.click(within(late as HTMLElement).getByRole("button", { name: "Undo the person's edit" }));
    expect(await screen.findByText("The edit was undone")).toBeDefined();

    const first = within(screen.getByRole("list", { name: /^On record/ })).getAllByRole("listitem")[0];
    await app.user.click(within(first as HTMLElement).getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(app.server.agentAccess.memories.find((memory) => memory.id === "mem_paper")?.pinned).toBe(true),
    );
    const pinned = within(screen.getByRole("list", { name: /^On record/ })).getAllByRole("listitem")[0];
    await app.user.click(within(pinned as HTMLElement).getByRole("button", { name: "Archive" }));
    expect(await screen.findByText("Note archived")).toBeDefined();
    expect(await screen.findByRole("tab", { name: "Set aside (2)" })).toBeDefined();
  });

  test("editing starts from the note as it is now, not from a discarded draft", async () => {
    const app = await renderApp({ path: `${BASE}?tab=memory`, signedInAs: "usr_ana" });
    const list = await screen.findByRole("list", { name: /^On record/ });
    const paper = within(list).getAllByRole("listitem")[0] as HTMLElement;
    await app.user.click(within(paper).getByRole("button", { name: "Edit" }));
    await app.user.type(screen.getByLabelText("Text"), " Draft to drop.");
    await app.user.click(screen.getByRole("button", { name: "Cancel" }));
    await app.user.click(within(paper).getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe(
      "The shop orders paper on Mondays.",
    );
  });

  test("a save on top of a change made meanwhile is refused, not written over it", async () => {
    const app = await renderApp({ path: `${BASE}?tab=memory`, signedInAs: "usr_ana" });
    const list = await screen.findByRole("list", { name: /^On record/ });
    const paper = within(list).getAllByRole("listitem")[0] as HTMLElement;
    await app.user.click(within(paper).getByRole("button", { name: "Edit" }));
    // The agent rewrites the note while the person is editing it.
    const note = app.server.agentAccess.memories.find((memory) => memory.id === "mem_paper");
    if (note !== undefined)
      Object.assign(note, { text: "Paper now comes on Fridays.", sha256: "mem_paper-agent" });
    await app.user.type(screen.getByLabelText("Text"), " Mine.");
    await app.user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/This note changed since you opened it/)).toBeDefined();
    expect(note?.text).toBe("Paper now comes on Fridays.");
  });

  test("a memory that fails to load can be tried again", async () => {
    const server = newServer();
    server.force("listAgentMemories", { kind: "error", status: 503, code: "unavailable" }, 4);
    const app = await renderApp({ path: `${BASE}?tab=memory`, signedInAs: "usr_iris", server });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The memory could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: /^On record/ })).toBeDefined();
  });

  test("the memory page: the notes, the memory files and the way back", async () => {
    const app = await renderApp({ path: `${BASE}/memory`, signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Scout's memory" });
    expect(document.title).toBe("Scout's memory | Birchwood Labs | Vanr");
    const files = await screen.findByRole("list", { name: "Memory files" });
    expect(files.textContent).toContain("clients/acme.md");
    await app.user.click(screen.getByRole("link", { name: /Back to Scout/ }));
    await screen.findByRole("heading", { level: 1, name: "Scout" });
  });
});
