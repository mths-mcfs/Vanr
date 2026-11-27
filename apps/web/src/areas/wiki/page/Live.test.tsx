// A wiki page with its live document, over a socket that speaks the server's protocol: the editor stays
// the same through someone else's publish and through a dropped connection, and whatever the server
// says about the right to write (a conflict, a lock, a revoked read) takes every write control away.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp, TEST_NOW } from "../../../../test/app.tsx";
import { FakeCollabSocket, seedBlocks } from "../../../../test/live-socket.ts";

const WIKI = "/workspace/workspace_birchwood/wiki";
const live = FakeCollabSocket as unknown as new (url: string) => WebSocket;
const status = () => screen.getByRole("status").textContent;
/** The live editor, once it took over from the published text: editable for who may write. */
const liveEditor = async (name: string) => {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = screen.getByRole("textbox", { name });
    expect(found.getAttribute("contenteditable")).toBe("true");
  });
  return found as HTMLElement;
};
const socket = (index = 0) => {
  const found = FakeCollabSocket.instances[index];
  if (found === undefined) throw new Error(`no socket ${index}`);
  return found;
};

beforeEach(() => {
  FakeCollabSocket.instances = [];
  FakeCollabSocket.nextScope = "read-write";
  FakeCollabSocket.failHandshake = false;
  FakeCollabSocket.autoOpen = true;
});
afterEach(() => {
  FakeCollabSocket.nextScope = "read-write";
});

/** A page of Íris's own, so a member may edit it until an admin locks it. */
function withIrisPage() {
  const server = newServer();
  server.wiki.pages.push({
    workspaceId: "workspace_birchwood",
    slug: "iris-note",
    title: "Iris note",
    folder: "",
    tags: [],
    altTitles: [],
    props: {},
    pinned: false,
    locked: false,
    deletedAt: null,
    deletedBy: null,
    versions: [
      {
        version: 1,
        title: "Iris note",
        body: "First words.",
        author: { type: "person", id: "usr_iris" },
        at: TEST_NOW.toISOString(),
        note: null,
      },
    ],
  });
  return server;
}

describe("a live wiki page", () => {
  test("someone else's publish keeps the open editor: the same document, still focused", async () => {
    const app = await renderApp({ path: `${WIKI}/press-checklist`, signedInAs: "usr_ana", wikiSocket: live });
    await waitFor(() => expect(status()).toBe("Version 2 published"));
    const editor = await liveEditor("Text of Press checklist");
    editor.focus();
    // Jonas publishes: the page has a new version and the server says so on the socket.
    const page = app.server.wiki.pages[0];
    page?.versions.push({
      ...(page.versions.at(-1) as NonNullable<typeof page>["versions"][number]),
      version: 3,
      author: { type: "person", id: "usr_jonas" },
    });
    await act(async () =>
      socket().pushStateless("wiki/workspace_birchwood/press-checklist", { type: "published", version: 3 }),
    );
    await waitFor(() => expect(status()).toBe("Version 3 published"));
    expect(document.activeElement === editor).toBe(true);
    expect(screen.getByRole("textbox", { name: "Text of Press checklist" }) === editor).toBe(true);
    expect(editor.isConnected).toBe(true);
  });

  test("a dropped connection keeps the editor and lets edits wait: offline, then live again", async () => {
    await renderApp({ path: `${WIKI}/press-checklist`, signedInAs: "usr_ana", wikiSocket: live });
    await waitFor(() => expect(status()).toBe("Version 2 published"));
    const editor = await liveEditor("Text of Press checklist");
    FakeCollabSocket.autoOpen = false;
    await act(async () => socket().serverClose(1006));
    await waitFor(() => expect(status()).toBe("Offline: changes wait to sync"));
    expect(screen.getByRole("textbox", { name: "Text of Press checklist" }) === editor).toBe(true);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    // The retry starts: still offline to the person, never flickering back to "Connecting…".
    await waitFor(() => expect(FakeCollabSocket.instances.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    expect(status()).toBe("Offline: changes wait to sync");
    // The retry gets through: the same editor is live again.
    FakeCollabSocket.autoOpen = true;
    await act(async () => FakeCollabSocket.instances.at(-1)?.open());
    await waitFor(() => expect(status()).toBe("Version 2 published"));
    expect(screen.getByRole("textbox", { name: "Text of Press checklist" }) === editor).toBe(true);
  });

  test("leaving a live page closes its editor cleanly: nothing throws afterwards", async () => {
    const thrown: unknown[] = [];
    const onError = (event: ErrorEvent) => thrown.push(event.error ?? event.message);
    const consoleError = console.error;
    console.error = (...args: unknown[]) => thrown.push(args[0]);
    window.addEventListener("error", onError);
    try {
      const app = await renderApp({
        path: `${WIKI}/press-checklist`,
        signedInAs: "usr_ana",
        wikiSocket: live,
      });
      await waitFor(() => expect(status()).toBe("Version 2 published"));
      await liveEditor("Text of Press checklist");
      await act(async () => {
        await app.runtime.router.navigate({ to: `${WIKI}/ink-suppliers` });
      });
      await waitFor(() => expect(socket(0).closed).toBe(true));
      await waitFor(() => expect(status()).toBe("Version 1 published"));
      app.unmount();
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      window.removeEventListener("error", onError);
      console.error = consoleError;
    }
    expect(
      thrown.map(String).filter((text) => text.includes("MilkdownError") || text.includes("not found")),
    ).toEqual([]);
  });

  test("a conflict on a page someone may not write shows no publish or discard", async () => {
    FakeCollabSocket.nextScope = "readonly";
    await renderApp({ path: `${WIKI}/holidays`, signedInAs: "usr_iris", wikiSocket: live });
    await screen.findByRole("heading", { level: 1, name: "Holidays" });
    await waitFor(() => expect(FakeCollabSocket.instances).toHaveLength(1));
    await act(async () =>
      socket().pushStateless("wiki/workspace_birchwood/holidays", { type: "conflict", version: 2 }),
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Someone published a newer version")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Publish over version 2" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Discard my draft" }) === null).toBe(true);
  });

  test("a lock while the page is open (4409) takes every write control away", async () => {
    const server = withIrisPage();
    await renderApp({ path: `${WIKI}/iris-note`, signedInAs: "usr_iris", wikiSocket: live, server });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    expect(screen.getByRole("textbox", { name: "Page title" })).toBeDefined();
    const page = server.wiki.pages.find((each) => each.slug === "iris-note");
    if (page !== undefined) page.locked = true;
    FakeCollabSocket.nextScope = "readonly";
    await act(async () => socket().serverClose(4409, "reconnect-read-only"));
    expect(await screen.findByRole("heading", { level: 1, name: "Iris note" })).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Page title" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Add a property" }) === null).toBe(true);
    expect(screen.getByRole("textbox", { name: "Text of Iris note" }).getAttribute("contenteditable")).toBe(
      "false",
    );
    await waitFor(() => expect(screen.getByText("Locked")).toBeDefined());
  });

  test("a revoked read (4403) stops reconnecting and takes every write control away", async () => {
    const server = withIrisPage();
    await renderApp({ path: `${WIKI}/iris-note`, signedInAs: "usr_iris", wikiSocket: live, server });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    // The live editor goes away under a document that stays: nothing may throw from it afterwards.
    const thrown: unknown[] = [];
    const onError = (event: ErrorEvent) => thrown.push(event.error ?? event.message);
    const consoleError = console.error;
    console.error = (...args: unknown[]) => thrown.push(args[0]);
    window.addEventListener("error", onError);
    await act(async () => socket().serverClose(4403, "access-revoked"));
    await waitFor(() => expect(status()).toBe("Read only"));
    expect(screen.queryByRole("textbox", { name: "Page title" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Add a property" }) === null).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    window.removeEventListener("error", onError);
    console.error = consoleError;
    expect(FakeCollabSocket.instances).toHaveLength(1);
    expect(
      thrown.map(String).filter((text) => text.includes("MilkdownError") || text.includes("not found")),
    ).toEqual([]);
  });
  test("after a revoked read the page's own actions go too: no trash, pin or lock, and an open confirmation closes", async () => {
    const server = withIrisPage();
    const app = await renderApp({
      path: `${WIKI}/iris-note`,
      signedInAs: "usr_iris",
      wikiSocket: live,
      server,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Move to trash" }));
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    // The page can't be read again: the refetch fails and the cached page still says unlocked.
    server.force("getWikiPage", { kind: "error", status: 404, code: "not_found" }, 50);
    await act(async () => socket().serverClose(4403, "access-revoked"));
    await waitFor(() => expect(status()).toBe("Read only"));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Move to trash" }) === null).toBe(true);
    expect(within(menu).queryByRole("menuitem", { name: "Pin" }) === null).toBe(true);
    expect(
      app.server.calls.some((call) => call.method === "deleteWikiPage" || call.method === "pinWikiPage"),
    ).toBe(false);
  });

  test("a new property being named when the read is revoked is never saved", async () => {
    const server = withIrisPage();
    const app = await renderApp({
      path: `${WIKI}/iris-note`,
      signedInAs: "usr_iris",
      wikiSocket: live,
      server,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    await app.user.click(screen.getByRole("button", { name: "Add a property" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "New property…" }));
    await app.user.type(await screen.findByRole("textbox", { name: "Property name" }), "Priority");
    await act(async () => socket().serverClose(4403, "access-revoked"));
    await waitFor(() => expect(status()).toBe("Read only"));
    expect(screen.queryByRole("textbox", { name: "Property name" }) === null).toBe(true);
    expect(app.server.calls.some((call) => call.method === "setWikiProps")).toBe(false);
  });

  test("a value typed before the read is revoked is not sent when the field is left", async () => {
    const server = withIrisPage();
    const app = await renderApp({
      path: `${WIKI}/iris-note`,
      signedInAs: "usr_iris",
      wikiSocket: live,
      server,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    await app.user.click(screen.getByRole("button", { name: "Add a property" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Owner" }));
    const owner = await screen.findByRole("textbox", { name: "Owner" });
    await app.user.clear(owner);
    await app.user.type(owner, "Someone else");
    await act(async () => socket().serverClose(4403, "access-revoked"));
    await waitFor(() => expect(status()).toBe("Read only"));
    await act(async () => owner.blur());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.server.calls.some((call) => call.method === "updateWikiPageMeta")).toBe(false);
  });
  test("a field change waiting its turn when the read is revoked is never sent", async () => {
    const server = withIrisPage();
    const app = await renderApp({
      path: `${WIKI}/iris-note`,
      signedInAs: "usr_iris",
      wikiSocket: live,
      server,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    const held = app.server.hold("updateWikiPageMeta");
    const field = screen.getByRole("textbox", { name: "Add to Tags" });
    await app.user.type(field, "a{Enter}");
    await app.user.type(field, "b{Enter}");
    const sent = () => app.server.calls.filter((call) => call.method === "updateWikiPageMeta").length;
    await waitFor(() => expect(sent()).toBe(1));
    await act(async () => socket().serverClose(4403, "access-revoked"));
    await waitFor(() => expect(status()).toBe("Read only"));
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent()).toBe(1);
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("an address with ?at= scrolls the live editor to that heading, not only the published text before it", async () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      const editable = this.closest(".wiki-prose")?.getAttribute("contenteditable");
      scrolled.push(`${editable === "true" ? "live" : "static"}:${this.textContent ?? ""}`);
    };
    FakeCollabSocket.seed = seedBlocks([
      { type: "heading", text: "Before a run" },
      { type: "paragraph", text: "Clean the rollers." },
      { type: "heading", text: "After" },
      { type: "paragraph", text: "Cover the press." },
    ]);
    try {
      const app = await renderApp({
        path: `${WIKI}/press-checklist?at=After`,
        signedInAs: "usr_ana",
        wikiSocket: live,
      });
      await waitFor(() => expect(status()).toBe("Version 2 published"));
      await waitFor(() => expect(scrolled).toContain("live:After"));
      // Only the address's heading changes (back, forward, a link): the open editor goes there too.
      await act(async () => {
        await app.runtime.router.navigate({ to: `${WIKI}/press-checklist`, search: { at: "Before a run" } });
      });
      await waitFor(() => expect(scrolled).toContain("live:Before a run"));
    } finally {
      FakeCollabSocket.seed = null;
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
