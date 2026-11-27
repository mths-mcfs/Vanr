// Who reads a page, its comments and its proposals, as a person uses them: restricting a page to some
// people, replying to and resolving a comment, accepting an agent's proposed change, and where a
// picked passage anchors in the published text.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";
import { FakeCollabSocket } from "../../../../test/live-socket.ts";
import { trimPicked } from "../editor/Editor.tsx";
import { anchorFor } from "./Annotations.tsx";

const WIKI = "/workspace/workspace_birchwood/wiki";
const PAGE = `${WIKI}/press-checklist`;
const side = () => screen.findByRole("complementary", { name: "About this page" });

/** A server whose checklist has open comment threads, by Jonas then Íris. */
function withThreads(count: number) {
  const server = newServer();
  const checklist = server.wiki.pages[0];
  const authors = ["usr_jonas", "usr_iris"];
  if (checklist !== undefined)
    checklist.comments = authors.slice(0, count).map((author, n) => ({
      id: `ann_t${n}`,
      agentId: null,
      anchor: null,
      anchorState: null,
      author: { type: "person" as const, id: author },
      body: `Question ${n + 1}`,
      createdAt: "2026-11-14T10:00:00.000Z",
      handledAt: null,
      handledBy: null,
      parentId: null,
      status: "open" as const,
    }));
  return server;
}

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

  test("restricting waits for the live changes still on their way, and keeps the page as it is when they don't arrive", async () => {
    FakeCollabSocket.instances = [];
    FakeCollabSocket.nextScope = "read-write";
    FakeCollabSocket.autoOpen = true;
    FakeCollabSocket.failHandshake = false;
    FakeCollabSocket.holdAcks = true;
    try {
      const app = await renderApp({
        path: `${WIKI}/ink-suppliers`,
        signedInAs: "usr_ana",
        wikiSocket: FakeCollabSocket as unknown as new (url: string) => WebSocket,
      });
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Syncing changes…"));
      await app.user.click(screen.getByRole("button", { name: "Page actions" }));
      await app.user.click(await screen.findByRole("menuitem", { name: "Who reads it…" }));
      const dialog = await screen.findByRole("dialog", { name: "Who reads Ink suppliers" });
      await app.user.click(within(dialog).getByRole("radio", { name: /Only some people and agents/ }));
      await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
      expect(
        await within(dialog).findByText(
          "Some changes are still syncing. Try again in a moment, so none is lost.",
          {},
          { timeout: 6000 },
        ),
      ).toBeDefined();
      const ink = app.server.wiki.pages.find((each) => each.title === "Ink suppliers");
      expect(ink?.access ?? null).toBe(null);
    } finally {
      FakeCollabSocket.holdAcks = false;
    }
  }, 15000);

  test("while who reads the page is being saved, its text can't be edited and the dialog stays open", async () => {
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
    // Taken before the dialog opens: it hides the rest of the page from the accessibility tree.
    let text: HTMLElement | undefined;
    await waitFor(() => {
      text = screen.getByRole("textbox", { name: "Text of Ink suppliers" });
      expect(text.getAttribute("contenteditable")).toBe("true");
    });
    await app.user.click(screen.getByRole("button", { name: "Page actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Who reads it…" }));
    const dialog = await screen.findByRole("dialog", { name: "Who reads Ink suppliers" });
    await app.user.click(within(dialog).getByRole("radio", { name: /Only some people and agents/ }));
    const held = app.server.hold("setWikiPageAccess");
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(app.server.calls.filter((call) => call.method === "setWikiPageAccess")).toHaveLength(1),
    );
    await waitFor(() => expect(text?.getAttribute("contenteditable")).toBe("false"));
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    held.release();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Who reads Ink suppliers" }) === null).toBe(true),
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

  test("a reply that fails to send keeps its text for another try", async () => {
    const server = withThreads(1);
    server.force("createWikiPageComment", { kind: "error", status: 500, code: "internal" }, 50);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const list = await within(await side()).findByRole("list", { name: "Comments" });
    await app.user.click(within(list).getByRole("button", { name: "Reply" }));
    const box = within(list).getByRole("textbox", { name: "Reply to Jonas Lind" }) as HTMLTextAreaElement;
    await app.user.type(box, "The blue one.");
    await app.user.click(within(list).getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(box.value).toBe("The blue one.");
  });

  test("a reply on its way can't be changed until it is sent, so nothing typed then is lost", async () => {
    const server = withThreads(1);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const list = await within(await side()).findByRole("list", { name: "Comments" });
    await app.user.click(within(list).getByRole("button", { name: "Reply" }));
    const box = within(list).getByRole("textbox", { name: "Reply to Jonas Lind" }) as HTMLTextAreaElement;
    await app.user.type(box, "The blue one.");
    const held = app.server.hold("createWikiPageComment");
    await app.user.click(within(list).getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(box.readOnly).toBe(true));
    await app.user.type(box, " And the red.");
    expect(box.value).toBe("The blue one.");
    held.release();
    await waitFor(() =>
      expect(within(list).queryByRole("textbox", { name: "Reply to Jonas Lind" }) === null).toBe(true),
    );
  });

  test("a reply sent on one thread does not close the reply being written on another", async () => {
    const server = withThreads(2);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const list = await within(await side()).findByRole("list", { name: "Comments" });
    const [first, second] = within(list).getAllByRole("button", { name: "Reply" });
    await app.user.click(first as HTMLElement);
    await app.user.type(within(list).getByRole("textbox", { name: "Reply to Jonas Lind" }), "On the first.");
    const held = app.server.hold("createWikiPageComment");
    await app.user.click(within(list).getByRole("button", { name: "Comment" }));
    await app.user.click(second as HTMLElement);
    const other = within(list).getByRole("textbox", { name: "Reply to Íris Valença" }) as HTMLTextAreaElement;
    await app.user.type(other, "Still writing.");
    held.release();
    await waitFor(() =>
      expect(app.server.calls.filter((call) => call.method === "createWikiPageComment")).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(list).getByRole("textbox", { name: "Reply to Íris Valença" }) === other).toBe(true);
    expect(other.value).toBe("Still writing.");
  });

  test("comments and proposals that fail to load say so, and try again", async () => {
    const server = newServer();
    server.force("getWikiPageAnnotations", { kind: "error", status: 500, code: "internal" }, 50);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const panel = await side();
    const alert = await within(panel).findByRole("alert");
    expect(within(alert).getByText("The comments and proposals could not be loaded.")).toBeDefined();
    server.unforce("getWikiPageAnnotations");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByRole("region", { name: "1 proposal to review" })).toBeDefined();
  });

  test("a selection with spaces at its ends gives them to its context, so the right occurrence is found", () => {
    const picked = trimPicked(" target ", "A target Z\n\nB", "Y");
    expect(picked).toEqual({ quote: "target", before: "A target Z\n\nB ", after: " Y" });
    const body = "A target Z\n\nB target Y";
    expect(anchorFor(body, picked as NonNullable<typeof picked>).position).toBe(14);
    expect(trimPicked("   ", "a", "b") === null).toBe(true);
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
