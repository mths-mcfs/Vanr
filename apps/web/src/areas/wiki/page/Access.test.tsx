// Losing a page: a reader whose read is taken away (a restriction, a lock) keeps nothing of it on screen,
// and who reads a page speaks the reader's language when the server refuses the change.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";
import { FakeCollabSocket } from "../../../../test/live-socket.ts";

const WIKI = "/workspace/workspace_birchwood/wiki";
const live = FakeCollabSocket as unknown as new (url: string) => WebSocket;
const status = () => screen.getByRole("status").textContent;

function resetLive() {
  FakeCollabSocket.instances = [];
  FakeCollabSocket.nextScope = "read-write";
  FakeCollabSocket.autoOpen = true;
  FakeCollabSocket.failHandshake = false;
  FakeCollabSocket.holdAcks = false;
  FakeCollabSocket.seed = null;
}

describe("losing a page", () => {
  test("a reader the page is restricted away from keeps nothing of it: text, comments, proposals or buttons", async () => {
    resetLive();
    const server = newServer();
    const checklist = server.wiki.pages[0];
    if (checklist === undefined) throw new Error("no checklist");
    checklist.comments = [
      {
        id: "ann_secret",
        agentId: null,
        anchor: null,
        anchorState: null,
        author: { type: "person", id: "usr_iris" },
        body: "A note on the restricted page",
        createdAt: "2026-11-14T10:00:00.000Z",
        handledAt: null,
        handledBy: null,
        parentId: null,
        status: "open",
      },
    ];
    await renderApp({ path: `${WIKI}/press-checklist`, signedInAs: "usr_iris", server, wikiSocket: live });
    await waitFor(() => expect(status()).toBe("Version 2 published"));
    const side = await screen.findByRole("complementary", { name: "About this page" });
    expect(await within(side).findByText("A note on the restricted page")).toBeDefined();
    const notesRead = () => server.calls.filter((call) => call.method === "getWikiPageAnnotations").length;
    const before = notesRead();

    // Ana restricts the checklist to herself: it moves to a new address Íris can't read.
    checklist.access = { kind: "private", userIds: ["usr_ana"], agentIds: [] };
    checklist.slug = "press-checklist-restricted";
    await act(async () => FakeCollabSocket.instances[0]?.serverClose(4403, "access-revoked"));

    expect(await screen.findByText("No page here")).toBeDefined();
    expect(notesRead() > before).toBe(true);
    expect({
      text: document.body.textContent?.includes("Clean the rollers") === true,
      comment: screen.queryByText("A note on the restricted page") !== null,
      proposal: screen.queryByText("Cover the press and switch it off.") !== null,
      reply: screen.queryByRole("button", { name: "Reply" }) !== null,
      resolve: screen.queryByRole("button", { name: "Resolve" }) !== null,
      commentOnSelection: screen.queryByRole("button", { name: "Comment on the selection" }) !== null,
    }).toEqual({
      text: false,
      comment: false,
      proposal: false,
      reply: false,
      resolve: false,
      commentOnSelection: false,
    });
  });

  test("coming back to the old address of a page restricted away shows it is not there", async () => {
    const server = newServer();
    const ink = server.wiki.pages.find((page) => page.slug === "ink-suppliers");
    if (ink === undefined) throw new Error("no ink suppliers");
    const app = await renderApp({ path: `${WIKI}/ink-suppliers`, signedInAs: "usr_iris", server });
    const text = await screen.findByRole("textbox", { name: "Text of Ink suppliers" });
    await waitFor(() => expect(text.textContent).toContain("Two suppliers in Porto."));
    await act(async () => {
      await app.runtime.router.navigate({ to: WIKI });
    });
    await screen.findByRole("navigation", { name: "Pages by folder" });

    ink.access = { kind: "private", userIds: ["usr_ana"], agentIds: [] };
    ink.slug = "ink-suppliers-restricted";
    await act(async () => {
      await app.runtime.router.navigate({ to: `${WIKI}/ink-suppliers` });
    });
    expect(await screen.findByText("No page here")).toBeDefined();
    expect({
      title: screen.queryByRole("textbox", { name: "Page title" }) !== null,
      text: document.body.textContent?.includes("Two suppliers in Porto.") === true,
    }).toEqual({ title: false, text: false });
  });

  test("who reads the page closes when the read is taken away", async () => {
    resetLive();
    const server = newServer();
    const app = await renderApp({
      path: `${WIKI}/ink-suppliers`,
      signedInAs: "usr_ana",
      server,
      wikiSocket: live,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Who reads it…" }));
    await screen.findByRole("dialog", { name: "Who reads Ink suppliers" });
    server.force("getWikiPage", { kind: "error", status: 404, code: "not_found" }, 50);
    await act(async () => FakeCollabSocket.instances[0]?.serverClose(4403, "access-revoked"));
    expect(await screen.findByText("No page here")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Who reads Ink suppliers" }) === null).toBe(true);
  });

  test("who reads the page closes when the page is locked while it is open", async () => {
    resetLive();
    const server = newServer();
    const ink = server.wiki.pages.find((page) => page.slug === "ink-suppliers");
    if (ink === undefined) throw new Error("no ink suppliers");
    const app = await renderApp({
      path: `${WIKI}/ink-suppliers`,
      signedInAs: "usr_ana",
      server,
      wikiSocket: live,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Who reads it…" }));
    await screen.findByRole("dialog", { name: "Who reads Ink suppliers" });
    ink.locked = true;
    await act(async () => FakeCollabSocket.instances[0]?.serverClose(4409, "reconnect-read-only"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Who reads Ink suppliers" }) === null).toBe(true),
    );
  });

  test("who restricts the page is taken to its new address, not told it is gone, when the old one closes", async () => {
    resetLive();
    const server = newServer();
    const app = await renderApp({
      path: `${WIKI}/ink-suppliers`,
      signedInAs: "usr_ana",
      server,
      wikiSocket: live,
    });
    await waitFor(() => expect(status()).toBe("Version 1 published"));
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Who reads it…" }));
    const dialog = await screen.findByRole("dialog", { name: "Who reads Ink suppliers" });
    await app.user.click(within(dialog).getByRole("radio", { name: /Only some people and agents/ }));
    const held = server.hold("setWikiPageAccess");
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === "setWikiPageAccess")).toHaveLength(1),
    );
    // The server moved the page before answering: the old address closes and is not found any more.
    server.force(
      "getWikiPage",
      { kind: "error", status: 404, code: "not_found" },
      50,
      (params) => params.pageId === "ink-suppliers",
    );
    // Not even for a moment, until the new address shows the page.
    let toldGone = false;
    const watch = new MutationObserver(() => {
      if (document.body.textContent?.includes("No page here") === true) toldGone = true;
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    await act(async () => FakeCollabSocket.instances[0]?.serverClose(4403, "access-revoked"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.release();
    expect(await screen.findByText("Only Ana Beatriz Souza")).toBeDefined();
    watch.disconnect();
    expect(toldGone).toBe(false);
    expect(app.runtime.router.state.location.pathname === `${WIKI}/ink-suppliers`).toBe(false);
  });

  test("a refused change of who reads the page is explained in the reader's language", async () => {
    const server = newServer();
    server.force(
      "setWikiPageAccess",
      {
        kind: "error",
        status: 403,
        code: "wiki.access.owner",
        message: "Only who created the page or an admin can change who reads it",
      },
      50,
    );
    const app = await renderApp({
      path: `${WIKI}/ink-suppliers`,
      signedInAs: "usr_ana",
      server,
      languages: ["pt-BR"],
    });
    await screen.findByRole("textbox", { name: "Título da página" });
    await app.user.click(screen.getByRole("button", { name: "Ações da página" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Quem lê…" }));
    const dialog = await screen.findByRole("dialog", { name: "Quem lê Ink suppliers" });
    await app.user.click(within(dialog).getByRole("radio", { name: /Só algumas pessoas e agentes/ }));
    await app.user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent?.includes("Only who created the page") === true).toBe(false);
  });
});
