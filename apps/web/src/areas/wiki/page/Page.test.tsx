// A wiki page as a person uses it, without the live document (the fake server has none, so the page
// shows its published text): the header and side panel, renaming in place, properties, the version
// history and a restore, pin, lock and the trash by who may, and the missing and failed states.
import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
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
  });

  test("a tag added on the page is saved, once more on the fresh version when someone saved in between", async () => {
    const app = await renderApp({ path: PAGE, signedInAs: "usr_ana" });
    await title();
    app.server.force("updateWikiPageMeta", { kind: "error", status: 409, code: "wiki.page_changed" }, 1);
    await app.user.type(screen.getByRole("textbox", { name: "Add to Tags" }), "ink{Enter}");
    await waitFor(() => {
      const tags = screen.getByRole("list", { name: "Tags" });
      expect(within(tags).getByText(/ink/)).toBeDefined();
    });
    expect(app.server.calls.filter((call) => call.method === "updateWikiPageMeta")).toHaveLength(2);
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
