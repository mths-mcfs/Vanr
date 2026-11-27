// A wiki page as a person uses it, without the live document (the fake server has none, so the page
// shows its published text): the header and side panel, renaming in place, properties, the version
// history and a restore, pin, lock and the trash by who may, and the missing and failed states.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const WIKI = "/workspace/workspace_birchwood/wiki";
const PAGE = `${WIKI}/press-checklist`;
const title = () => screen.findByRole("textbox", { name: "Page title" });
const actions = async (app: Awaited<ReturnType<typeof renderApp>>) => {
  await app.user.click(await screen.findByRole("button", { name: "Page actions" }));
  return screen.findByRole("menu");
};

describe("a wiki page", () => {
  test("shows where it is, who changed it, its text read only while the live draft connects, and its links", async () => {
    await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    expect(((await title()) as HTMLInputElement).value).toBe("Press checklist");
    const crumbs = screen.getByRole("navigation", { name: "Where the page is" });
    expect(within(crumbs).getByRole("link", { name: "Wiki" })).toBeDefined();
    expect(crumbs.textContent).toContain("Print");
    expect(screen.getByText(/Changed by Scout yesterday, version 2/)).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Connecting…");
    const text = await screen.findByRole("textbox", { name: "Text of Press checklist" });
    await waitFor(() => expect(text.textContent).toContain("Clean the rollers and check the"));
    expect(text.getAttribute("contenteditable")).toBe("false");
    const side = screen.getByRole("complementary", { name: "About this page" });
    const outline = await within(side).findByRole("navigation", { name: "On this page" });
    expect(within(outline).getByRole("button", { name: "After" })).toBeDefined();
    expect(within(side).getByRole("link", { name: "Ink suppliers" })).toBeDefined();
    expect(within(side).getByText("Read 12 times")).toBeDefined();
    expect(document.title).toBe("Press checklist | Birchwood Labs | Vanr");
  });

  test("renames in place: Enter saves and Escape goes back", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    const field = await title();
    await app.user.clear(field);
    await app.user.type(field, "Press list{Escape}");
    expect((field as HTMLInputElement).value).toBe("Press checklist");
    await app.user.clear(field);
    await app.user.type(field, "Morning press checklist");
    field.blur();
    await waitFor(() =>
      expect(
        app.server.calls.some(
          (call) => call.method === "renameWikiPage" && call.params.title === "Morning press checklist",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/version 3/)).toBeDefined());
    // The editor's name follows the new title.
    expect(await screen.findByRole("textbox", { name: "Text of Morning press checklist" })).toBeDefined();
  });

  test("a tag added on the page is saved, once more on the fresh version when someone saved in between", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    // Jonas saved a tag of his own meanwhile: the retry adds "ink" to his list, never drops his tag.
    const page = app.server.wiki.pages[0];
    if (page !== undefined) {
      page.tags = [...page.tags, "safety"];
      const last = page.versions.at(-1);
      if (last !== undefined) page.versions.push({ ...last, version: last.version + 1, note: "meta" });
    }
    app.server.force("updateWikiPageMeta", { kind: "error", status: 409, code: "wiki.stale_draft" }, 1);
    await app.user.type(screen.getByRole("textbox", { name: "Add to Tags" }), "ink{Enter}");
    await waitFor(() => expect(app.server.wiki.pages[0]?.tags).toEqual(["print", "daily", "safety", "ink"]));
    expect(app.server.calls.filter((call) => call.method === "updateWikiPageMeta")).toHaveLength(2);
  });

  test("two tags added one after the other both stay, the second waiting for the first to save", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    const held = app.server.hold("updateWikiPageMeta");
    const field = screen.getByRole("textbox", { name: "Add to Tags" });
    await app.user.type(field, "ink{Enter}");
    await app.user.type(field, "safety{Enter}");
    held.release();
    await waitFor(() => expect(app.server.wiki.pages[0]?.tags).toEqual(["print", "daily", "ink", "safety"]));
  });

  test("the history compares versions and restores an older one as a new version", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Version history" }));
    const dialog = await screen.findByRole("dialog", { name: "History of Press checklist" });
    const versions = within(dialog).getByRole("list", { name: "Versions" });
    expect(within(versions).getAllByRole("button")).toHaveLength(2);
    expect(await within(dialog).findByText(/Version 1 → 2: 3 added, 1 removed/)).toBeDefined();
    await app.user.click(within(versions).getByRole("button", { name: /Version 1/ }));
    await app.user.click(within(dialog).getByRole("button", { name: "Restore version 1" }));
    expect(await screen.findByText("Version 1 is back as version 3.")).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "History of Press checklist" }) === null).toBe(true),
    );
  });

  test("pin and lock from the menu; only an admin is offered the lock", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(app.server.wiki.pages[0]?.pinned).toBe(false));
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Lock" }));
    expect(await screen.findByText("Locked")).toBeDefined();
    app.unmount();

    const member = await renderApp({ path: `${WIKI}/ink-suppliers`, signedInAs: "usr_iris" });
    await screen.findByRole("textbox", { name: "Page title" });
    const menu = await actions(member);
    expect(within(menu).getByRole("menuitem", { name: "Pin" })).toBeDefined();
    expect(within(menu).queryByRole("menuitem", { name: "Lock" }) === null).toBe(true);
    expect(within(menu).queryByRole("menuitem", { name: "Move to trash" }) === null).toBe(true);
  });

  test("pinning the page keeps the editor that is open: the same document, not a new one", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    const text = await screen.findByRole("textbox", { name: "Text of Press checklist" });
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(app.server.wiki.pages[0]?.pinned).toBe(false));
    await within(await actions(app)).findByRole("menuitem", { name: "Pin" });
    await app.user.keyboard("{Escape}");
    expect(text.isConnected).toBe(true);
    expect(screen.getByRole("textbox", { name: "Text of Press checklist" }) === text).toBe(true);
  });

  test("a new option of a select property is saved on its definition, then picked", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    await app.user.click(screen.getByRole("button", { name: "Add a property" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Stage" }));
    await app.user.type(
      await screen.findByRole("textbox", { name: "New option for Stage" }),
      "Review{Enter}",
    );
    await waitFor(() =>
      expect(app.server.wiki.defs.get("workspace_birchwood")?.defs[1]?.options?.map((o) => o.name)).toEqual([
        "Draft",
        "Live",
        "Review",
      ]),
    );
    const review = app.server.wiki.defs.get("workspace_birchwood")?.defs[1]?.options?.[2]?.id;
    await waitFor(() => expect(app.server.wiki.pages[0]?.props.prop_stage).toBe(review));
  });

  test("a select property made on the page starts empty and takes its first option there", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    await app.user.click(screen.getByRole("button", { name: "Add a property" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "New property…" }));
    await app.user.type(screen.getByRole("textbox", { name: "Property name" }), "Topic");
    await app.user.click(screen.getByRole("combobox", { name: "Property type" }));
    await app.user.click(await screen.findByRole("option", { name: "Select" }));
    await app.user.click(screen.getByRole("button", { name: "Add" }));
    await app.user.type(await screen.findByRole("textbox", { name: "New option for Topic" }), "Inks{Enter}");
    const defs = () => app.server.wiki.defs.get("workspace_birchwood")?.defs ?? [];
    await waitFor(() =>
      expect(
        defs()
          .find((def) => def.name === "Topic")
          ?.options?.map((o) => o.name),
      ).toEqual(["Inks"]),
    );
    const topic = defs().find((def) => def.name === "Topic");
    await waitFor(() =>
      expect(app.server.wiki.pages[0]?.props[topic?.id ?? ""]).toBe(topic?.options?.[0]?.id),
    );
  });

  test("the side panel says when its links failed, and tries again", async () => {
    const server = newServer();
    server.force("getWikiPagePanel", { kind: "error", status: 500, code: "internal" }, 50);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The links could not be loaded")).toBeDefined();
    server.unforce("getWikiPagePanel");
    const side = screen.getByRole("complementary", { name: "About this page" });
    await app.user.click(within(side).getByRole("button", { name: "Retry" }));
    expect(await within(side).findByRole("link", { name: "Ink suppliers" })).toBeDefined();
  });

  test("a locked page reads only for a member: its title is not a field", async () => {
    await renderApp({ path: `${WIKI}/holidays`, signedInAs: "usr_iris" });
    expect(await screen.findByRole("heading", { level: 1, name: "Holidays" })).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Page title" }) === null).toBe(true);
  });

  test("moving to the trash asks first, then goes back to the index without the page", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Move to trash" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Move Press checklist to the trash?" });
    await app.user.click(within(confirm).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(app.address()).toBe(WIKI));
    const tree = await screen.findByRole("navigation", { name: "Pages by folder" });
    await waitFor(() =>
      expect(within(tree).queryByRole("link", { name: /Press checklist/ }) === null).toBe(true),
    );
  });

  test("an embedded image whose attachment loads after the editor turns from a link into the image", async () => {
    const server = newServer();
    const checklist = server.wiki.pages[0];
    if (checklist !== undefined) {
      const last = checklist.versions.at(-1);
      if (last !== undefined) last.body = "![[img.png]]";
    }
    const original = server.fetch.bind(server);
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    server.fetch = (jar) => {
      const fetch = original(jar);
      return async (url, options) => {
        const path = new URL(String(url), "https://vanr.test").pathname;
        if (path.endsWith("/wiki/attachments")) {
          await held;
          return Response.json({
            attachments: [{ path: "img.png", fileId: "file_img", contentType: "image/png" }],
          });
        }
        if (path.endsWith("/files/file_img/blob"))
          return new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } });
        return fetch(url, options);
      };
    };
    await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const editor = await screen.findByRole("textbox", { name: "Text of Press checklist" });
    const link = await within(editor).findByRole("link", { name: "img.png" });
    expect(link.getAttribute("data-missing")).toBe("true");
    await act(async () => release());
    expect(await within(editor).findByRole("img", { name: "img.png" })).toBeDefined();
    expect(within(editor).queryByRole("link", { name: "img.png" }) === null).toBe(true);
  });

  test("Escape throws away a tag being typed: leaving the field after it saves nothing", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    const tags = (await screen.findByRole("textbox", { name: "Add to Tags" })) as HTMLInputElement;
    await app.user.type(tags, "do-not-save{Escape}{Tab}");
    expect(tags.value).toBe("");
    expect(app.server.calls.some((call) => call.method === "updateWikiPageMeta")).toBe(false);
  });

  test("a page linked twice shows once among the links out", async () => {
    const server = newServer();
    const last = server.wiki.pages[0]?.versions.at(-1);
    if (last !== undefined) last.body = "[[Ink suppliers]] and again [[Ink suppliers]]";
    await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    const side = await screen.findByRole("complementary", { name: "About this page" });
    const out = await within(side).findByRole("region", { name: "1 link out" });
    expect(within(out).getAllByRole("link", { name: "Ink suppliers" })).toHaveLength(1);
  });

  test("the history shows the first version's whole text, not an empty comparison", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Version history" }));
    const dialog = await screen.findByRole("dialog", { name: "History of Press checklist" });
    await app.user.click(within(dialog).getByRole("button", { name: /Version 1/ }));
    expect(await within(dialog).findByText("The first version, as it was written:")).toBeDefined();
    expect(within(dialog).getByText(/Clean the rollers\./)).toBeDefined();
    expect(within(dialog).queryByText(/same version/) === null).toBe(true);
  });

  test("the first version that fails to load says so and tries again", async () => {
    const server = newServer();
    server.force("getWikiPageVersion", { kind: "error", status: 500, code: "internal" }, 50);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    await title();
    await app.user.click(within(await actions(app)).getByRole("menuitem", { name: "Version history" }));
    const dialog = await screen.findByRole("dialog", { name: "History of Press checklist" });
    await app.user.click(within(dialog).getByRole("button", { name: /Version 1/ }));
    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText("The comparison could not be loaded")).toBeDefined();
    expect(within(dialog).queryByText(/same version/) === null).toBe(true);
    server.unforce("getWikiPageVersion");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("The first version, as it was written:")).toBeDefined();
  });

  test("a page an agent wrote first is not trashed by who it wrote it for, as the server refuses", async () => {
    const server = newServer();
    const ink = server.wiki.pages.find((each) => each.slug === "ink-suppliers");
    const first = ink?.versions[0];
    if (first !== undefined)
      first.author = { type: "agent", id: "agt_scout", actingFor: "usr_iris" } as typeof first.author;
    const app = await renderApp({ path: `${WIKI}/ink-suppliers`, signedInAs: "usr_iris", server });
    await title();
    expect(within(await actions(app)).queryByRole("menuitem", { name: "Move to trash" }) === null).toBe(true);
  });

  test("a link to a heading of the same page scrolls there, and one to another page's heading opens it there", async () => {
    const server = newServer();
    const ink = server.wiki.pages.find((each) => each.slug === "ink-suppliers");
    const last = ink?.versions.at(-1);
    if (last !== undefined)
      last.body = "Two suppliers.\n\n## Prices\n\nSee [[#Prices]] and [[Press checklist#After]].";
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const app = await renderApp({ path: `${WIKI}/ink-suppliers`, signedInAs: "usr_ana", server });
      const editor = await screen.findByRole("textbox", { name: "Text of Ink suppliers" });
      await app.user.click(await within(editor).findByRole("link", { name: "Prices" }));
      expect(scrolled).toEqual(["Prices"]);
      expect(app.address()).toBe(`${WIKI}/ink-suppliers`);
      await app.user.click(within(editor).getByRole("link", { name: "Press checklist › After" }));
      await waitFor(() => expect(app.address()).toBe(`${WIKI}/press-checklist?at=After`));
      await waitFor(() => expect(scrolled).toEqual(["Prices", "After"]));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test("the outline scrolls to a heading by its name in the open document", async () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
      await screen.findByRole("textbox", { name: "Text of Press checklist" });
      const outline = await screen.findByRole("navigation", { name: "On this page" });
      await app.user.click(within(outline).getByRole("button", { name: "After" }));
      expect(scrolled).toEqual(["After"]);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test("the outline's second heading of the same name scrolls to the second one", async () => {
    const server = newServer();
    const last = server.wiki.pages[0]?.versions.at(-1);
    if (last !== undefined) last.body = "## Notes\n\nFirst.\n\n## Notes\n\nSecond.";
    const hit: number[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      hit.push([...document.querySelectorAll(".wiki-prose h2")].indexOf(this));
    };
    try {
      const app = await renderApp({ path: PAGE, server, signedInAs: "usr_ana" });
      await screen.findByRole("textbox", { name: "Text of Press checklist" });
      const outline = await screen.findByRole("navigation", { name: "On this page" });
      await waitFor(() => expect(within(outline).getAllByRole("button", { name: "Notes" })).toHaveLength(2));
      await app.user.click(within(outline).getAllByRole("button", { name: "Notes" })[1] as HTMLElement);
      expect(hit).toEqual([1]);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  test("the Enter that ends an input method's composition saves no tag and no property", async () => {
    const metaCalls = (app: Awaited<ReturnType<typeof renderApp>>) =>
      app.server.calls.filter((call) => call.method === "updateWikiPageMeta").length;
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    const tags = screen.getByRole("textbox", { name: "Add to Tags" });
    await app.user.type(tags, "インク");
    fireEvent.keyDown(tags, { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(metaCalls(app)).toBe(0);
    expect((tags as HTMLInputElement).value).toBe("インク");
    app.unmount();

    const again = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    const owner = screen.getByRole("textbox", { name: "Owner" });
    await again.user.type(owner, "!");
    fireEvent.keyDown(owner, { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(metaCalls(again)).toBe(0);
  });

  test("changing the day of a date keeps the rest of the stored value, such as its end", async () => {
    const server = newServer();
    const defs = server.wiki.defs.get("workspace_birchwood");
    defs?.defs.push({ id: "prop_due", name: "Due", type: "date" });
    const checklist = server.wiki.pages[0];
    if (checklist !== undefined) checklist.props.prop_due = { start: "2026-11-20", end: "2026-11-25" };
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    await title();
    const due = (await screen.findByLabelText("Due")) as HTMLInputElement;
    fireEvent.change(due, { target: { value: "2026-11-21" } });
    fireEvent.keyDown(due, { key: "Enter" });
    await waitFor(() =>
      expect(app.server.wiki.pages[0]?.props.prop_due).toEqual({ start: "2026-11-21", end: "2026-11-25" }),
    );
  });

  test("a page that is not there offers to create it", async () => {
    const app = await renderApp({ path: `${WIKI}/packing-guide`, signedInAs: "usr_ana" });
    expect(await screen.findByText("No page here")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Create this page" }));
    const dialog = await screen.findByRole("dialog", { name: "New page" });
    expect((within(dialog).getByLabelText(/Title/) as HTMLInputElement).value).toBe("packing-guide");
  });

  test("a page that fails to load says so and tries again", async () => {
    const server = newServer();
    server.force("getWikiPage", { kind: "error", status: 500, code: "internal" }, 50);
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana", server });
    expect(await screen.findByText("The page could not be loaded")).toBeDefined();
    server.unforce("getWikiPage");
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await title()).toBeDefined();
  });
});
