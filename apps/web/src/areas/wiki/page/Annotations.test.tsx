// Who reads a page, its comments and its proposals, as a person uses them: restricting a page to some
// people, replying to and resolving a comment, accepting an agent's proposed change, and where a
// picked passage anchors in the published text.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";
import { FakeCollabSocket } from "../../../../test/live-socket.ts";
import { anchorFor } from "./Annotations.tsx";

const WIKI = "/workspace/workspace_birchwood/wiki";
const PAGE = `${WIKI}/press-checklist`;
const side = () => screen.findByRole("complementary", { name: "About this page" });

describe("access, comments and proposals", () => {
  test("who created a page restricts it to some people; it shows as restricted, and only they keep it", async () => {
    const app = await renderApp({ path: `${WIKI}/ink-suppliers`, signedInAs: "usr_ana" });
    await screen.findByRole("textbox", { name: "Page title" });
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Who reads it…" }));
    const dialog = await screen.findByRole("dialog", { name: "Who reads Ink suppliers" });
    await app.user.click(within(dialog).getByRole("radio", { name: /Only some people and agents/ }));
    const you = within(dialog).getByRole("checkbox", { name: "Ana Beatriz Souza (you)" });
    expect(you.getAttribute("aria-checked")).toBe("true");
    await app.user.click(within(dialog).getByRole("checkbox", { name: "Jonas Lind" }));
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Only Jonas Lind, Ana Beatriz Souza")).toBeDefined();
    app.unmount();

    await renderApp({ path: WIKI, signedInAs: "usr_iris", server: app.server });
    const tree = await screen.findByRole("navigation", { name: "Pages by folder" });
    await waitFor(() =>
      expect(within(tree).queryByRole("link", { name: /Ink suppliers/ }) === null).toBe(true),
    );
  });

  test("after a revoked read who reads the page can no longer be changed from it", async () => {
    FakeCollabSocket.instances = [];
    FakeCollabSocket.nextScope = "read-write";
    FakeCollabSocket.autoOpen = true;
    FakeCollabSocket.failHandshake = false;
    const app = await renderApp({
      path: `${WIKI}/ink-suppliers`,
      signedInAs: "usr_ana",
      wikiSocket: FakeCollabSocket as unknown as new (url: string) => WebSocket,
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Version 1 published"));
    app.server.force("getWikiPage", { kind: "error", status: 404, code: "not_found" }, 50);
    await act(async () => FakeCollabSocket.instances[0]?.serverClose(4403, "access-revoked"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Read only"));
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Who reads it…" }) === null).toBe(true);
  });

  test("someone who did not create a page is not offered who reads it", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_iris" });
    await screen.findByRole("textbox", { name: "Page title" });
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Who reads it…" }) === null).toBe(true);
  });

  test("an agent's proposed change is accepted on its own and lands as a new version", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    const panel = await side();
    const proposals = await within(panel).findByRole("region", { name: "1 proposal to review" });
    expect(within(proposals).getByText("Proposed by Scout")).toBeDefined();
    expect(within(proposals).getByText("Cover the press and switch it off.")).toBeDefined();
    await app.user.click(within(proposals).getByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Saved as version 3.")).toBeDefined();
    await waitFor(() =>
      expect(within(panel).queryByRole("region", { name: "1 proposal to review" }) === null).toBe(true),
    );
    expect(app.server.wiki.pages[0]?.versions.at(-1)?.body).toContain("Cover the press and switch it off.");
  });

  test("when the live document turns read only, deciding a proposal goes away with it", async () => {
    FakeCollabSocket.instances = [];
    FakeCollabSocket.nextScope = "read-write";
    FakeCollabSocket.autoOpen = true;
    FakeCollabSocket.failHandshake = false;
    await renderApp({
      path: PAGE,
      signedInAs: "usr_iris",
      wikiSocket: FakeCollabSocket as unknown as new (url: string) => WebSocket,
    });
    const panel = await side();
    const proposals = await within(panel).findByRole("region", { name: "1 proposal to review" });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Version 2 published"));
    expect(within(proposals).getByRole("button", { name: "Accept" })).toBeDefined();
    // The server reopens the page read only for this person, before the page itself says so.
    FakeCollabSocket.nextScope = "readonly";
    await act(async () => FakeCollabSocket.instances[0]?.serverClose(4409, "reconnect-read-only"));
    await waitFor(() =>
      expect(within(proposals).queryByRole("button", { name: "Accept" }) === null).toBe(true),
    );
    FakeCollabSocket.nextScope = "read-write";
  });

  test("a member who may not edit the page reads a proposal without deciding it", async () => {
    await renderApp({ path: `${WIKI}/holidays`, signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Holidays" });
    expect(screen.queryByRole("button", { name: "Accept" }) === null).toBe(true);
  });

  test("a comment thread: reply, resolve and reopen", async () => {
    const server = newServer();
    const checklist = server.wiki.pages[0];
    if (checklist === undefined) throw new Error("no page");
    checklist.comments = [
      {
        id: "ann_c1",
        agentId: null,
        anchor: {
          quote: "Clean the rollers",
          prefix: "# Before a run\n\n",
          suffix: " and check",
          position: 16,
        },
        anchorState: "ok",
        author: { type: "person", id: "usr_jonas" },
        body: "Which cleaner?",
        createdAt: "2026-11-14T10:00:00.000Z",
        handledAt: null,
        handledBy: null,
        parentId: null,
        status: "open",
      },
    ];
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const panel = await side();
    const list = await within(panel).findByRole("list", { name: "Comments" });
    expect(within(list).getByText("Clean the rollers")).toBeDefined();
    expect(within(panel).getByRole("heading", { name: "1 open comment" })).toBeDefined();
    await app.user.click(within(list).getByRole("button", { name: "Reply" }));
    await app.user.type(within(list).getByRole("textbox", { name: "Reply to Jonas Lind" }), "The blue one.");
    await app.user.click(within(list).getByRole("button", { name: "Comment" }));
    expect(await within(list).findByText("The blue one.")).toBeDefined();
    await app.user.click(within(list).getByRole("button", { name: "Resolve" }));
    expect(await within(list).findByText("Resolved by Ana Beatriz Souza")).toBeDefined();
    expect(within(panel).getByRole("heading", { name: "0 open comments" })).toBeDefined();
    await app.user.click(within(list).getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(within(list).queryByText("Resolved by Ana Beatriz Souza") === null).toBe(true),
    );
  });

  test("a picked passage anchors where its surroundings match in the published text", () => {
    const body = "Ink: cyan.\n\nInk: magenta and more.";
    const picked = { quote: "Ink", before: "cyan.\n\n", after: ": magenta" };
    expect(anchorFor(body, picked)).toEqual({
      quote: "Ink",
      prefix: "Ink: cyan.\n\n",
      suffix: ": magenta and more.",
      position: 12,
    });
    expect(anchorFor(body, { quote: "toner", before: "x", after: "y" })).toEqual({
      quote: "toner",
      prefix: "x",
      suffix: "y",
    });
  });
});
