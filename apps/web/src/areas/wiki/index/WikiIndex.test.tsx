// The wiki's index as a person uses it: the tree by folder, the pinned, recent and most read pages, the
// search on the server and the tag filter, a new page (also from a link with no page), the import of
// notes, the trash, and the loading, failed and empty states.
import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/wiki";
const tree = () => screen.findByRole("navigation", { name: "Pages by folder" });
const treePages = async () =>
  within(await tree())
    .queryAllByRole("link")
    .map((link) => link.textContent);

describe("the wiki index", () => {
  test("shows the pages by folder, with the pinned, the recent and the most read beside them", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await screen.findByRole("heading", { level: 1, name: "Wiki" });
    expect(await screen.findByText("3 pages")).toBeDefined();
    expect(await treePages()).toEqual(["Holidays", "Press checklist", "Ink suppliers"]);
    const holidays = within(await tree()).getByRole("link", { name: /Holidays/ });
    expect(within(holidays).getByRole("img", { name: "Locked" })).toBeDefined();
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("link", { name: /Press checklist/ })).toBeDefined();
    const read = screen.getByRole("region", { name: "Most read by agents" });
    expect(within(read).getByText("12 reads")).toBeDefined();
    expect(document.title).toBe("Wiki | Birchwood Labs | Vanr");
  });

  test("searches on the server, filters by tag, and says when nothing matches", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "#daily" }));
    expect(await treePages()).toEqual(["Press checklist"]);
    await app.user.click(screen.getByRole("button", { name: "#daily" }));
    await app.user.type(screen.getByRole("searchbox", { name: "Search pages" }), "porto");
    await waitFor(async () => expect(await treePages()).toEqual(["Ink suppliers"]));
    expect(
      app.server.calls.some((call) => call.method === "getWikiSearch" && call.params.q === "porto"),
    ).toBe(true);
    await app.user.type(screen.getByRole("searchbox", { name: "Search pages" }), "zzz");
    expect(await screen.findByText("No page matches.")).toBeDefined();
  });

  test("a failed search says so and tries again", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    app.server.force("getWikiSearch", { kind: "error", status: 500, code: "internal" }, 50);
    await app.user.type(screen.getByRole("searchbox", { name: "Search pages" }), "ink");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The search did not go through")).toBeDefined();
    app.server.unforce("getWikiSearch");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(async () => expect(await treePages()).toEqual(["Press checklist", "Ink suppliers"]));
  });

  test("a link with no page opens the form with its folder and title, and the new page opens", async () => {
    const app = await renderApp({ path: `${PATH}?new=Guides%2FOnboarding`, signedInAs: "usr_ana" });
    const dialog = await screen.findByRole("dialog", { name: "New page" });
    expect((within(dialog).getByLabelText(/Title/) as HTMLInputElement).value).toBe("Onboarding");
    expect((within(dialog).getByLabelText(/Folder/) as HTMLInputElement).value).toBe("Guides");
    await app.user.type(within(dialog).getByLabelText(/First text/), "Welcome aboard.");
    await app.user.click(within(dialog).getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(app.address()).toBe(`${PATH}/onboarding`));
    expect(await screen.findByRole("textbox", { name: "Page title" })).toBeDefined();
  });

  test("Enter in any field of the form creates the page", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "New page" }));
    const dialog = await screen.findByRole("dialog", { name: "New page" });
    await app.user.type(within(dialog).getByLabelText(/Title/), "Paper stock");
    await app.user.type(within(dialog).getByLabelText(/Folder/), "Print{Enter}");
    await waitFor(() => expect(app.address()).toBe(`${PATH}/paper-stock`));
    expect(app.server.calls.filter((call) => call.method === "createWikiPage")).toHaveLength(1);
  });

  test("the Enter that ends an input method's composition does not create the page", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "New page" }));
    const dialog = await screen.findByRole("dialog", { name: "New page" });
    await app.user.type(within(dialog).getByLabelText(/Title/), "Papel");
    fireEvent.keyDown(within(dialog).getByLabelText(/Folder/), { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.server.calls.some((call) => call.method === "createWikiPage")).toBe(false);
  });

  test("a vault is imported on its own: a zip picked with other files is refused", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    fireEvent.change(screen.getByTestId("wiki-import"), {
      target: {
        files: [
          new File(["zip"], "vault.zip", { type: "application/zip" }),
          new File(["note"], "note.md", { type: "text/markdown" }),
        ],
      },
    });
    expect(
      await screen.findByText("Import a vault on its own: pick one .zip and nothing else."),
    ).toBeDefined();
  });

  test("a title is needed before a page can be created", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "New page" }));
    const dialog = await screen.findByRole("dialog", { name: "New page" });
    const create = within(dialog).getByRole("button", { name: "Create page" });
    expect(create.hasAttribute("disabled")).toBe(true);
    await app.user.type(within(dialog).getByLabelText(/Title/), "   ");
    expect(create.hasAttribute("disabled")).toBe(true);
    await app.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(app.address()).toBe(PATH));
  });

  test("imports Markdown notes and says how many came in; anything else alone is refused", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    const picker = screen.getByTestId("wiki-import");
    // The picker suggests Markdown and zips, but a person can still pick anything.
    fireEvent.change(picker, {
      target: { files: [new File(["just a picture"], "photo.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("Pick Markdown notes (.md) or a vault in a .zip.")).toBeDefined();
    fireEvent.change(picker, {
      target: {
        files: [
          new File(["Cut on the left."], "Guillotine.md", { type: "text/markdown" }),
          new File(["x"], "photo.png", { type: "image/png" }),
        ],
      },
    });
    expect(await screen.findByText("Imported 1 pages, skipped 1.")).toBeDefined();
    await waitFor(async () => expect(await treePages()).toContain("Guillotine"));
  });

  test("the trash: restore opens the page; delete for good removes it", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "More wiki actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Wiki trash" });
    const list = await within(dialog).findByRole("list", { name: "Pages in the trash" });
    expect(within(list).getByText("Old price list")).toBeDefined();
    await app.user.click(within(list).getByRole("button", { name: "Restore Old price list" }));
    await waitFor(() => expect(app.address()).toBe(`${PATH}/old-price-list`));
  });

  test("delete for good, then the trash is empty", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "More wiki actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Wiki trash" });
    await app.user.click(
      await within(dialog).findByRole("button", { name: "Delete Old price list for good" }),
    );
    expect(await within(dialog).findByText("The trash is empty")).toBeDefined();
  });

  test("a link path as long as the server allows (200-character folder and title) opens the form", async () => {
    const folder = "f".repeat(200);
    const name = "t".repeat(200);
    await renderApp({
      path: `${PATH}?new=${encodeURIComponent(`${folder}/${name}`)}`,
      signedInAs: "usr_ana",
    });
    const dialog = await screen.findByRole("dialog", { name: "New page" });
    expect((within(dialog).getByLabelText(/Title/) as HTMLInputElement).value).toBe(name);
    expect((within(dialog).getByLabelText(/Folder/) as HTMLInputElement).value).toBe(folder);
  });

  test("a vault over 50 MB is refused before it is sent", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    const zip = new File(["zip"], "vault.zip", { type: "application/zip" });
    Object.defineProperty(zip, "size", { value: 50 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByTestId("wiki-import"), { target: { files: [zip] } });
    expect(
      await screen.findByText("This vault is larger than 50 MB. Split it into smaller zips."),
    ).toBeDefined();
    expect(app.server.calls.some((call) => call.method === "importWikiVault")).toBe(false);
  });

  test("a new search says it is on its way while the last results stay", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana" });
    await tree();
    const search = screen.getByRole("searchbox", { name: "Search pages" });
    fireEvent.change(search, { target: { value: "porto" } });
    await waitFor(async () => expect(await treePages()).toEqual(["Ink suppliers"]));
    const held = app.server.hold("getWikiSearch");
    fireEvent.change(search, { target: { value: "press" } });
    expect(await screen.findByText("Searching…")).toBeDefined();
    expect(await treePages()).toEqual(["Ink suppliers"]);
    held.release();
  });

  test("a wiki error reads in the interface language, not the server's English", async () => {
    const server = newServer();
    server.force(
      "getWikiSearch",
      {
        kind: "error",
        status: 400,
        code: "wiki.invalid_text",
        message: "Text can't contain a NUL character",
      },
      50,
    );
    await renderApp({ path: PATH, signedInAs: "usr_ana", server, languages: ["pt-BR"] });
    fireEvent.change(await screen.findByRole("searchbox", { name: "Buscar páginas" }), {
      target: { value: "press" },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O texto tem um caractere que não pode ser salvo.");
    expect(alert.textContent).not.toContain("NUL");
  });

  test("someone who did not make a trashed page is told who can restore it", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris" });
    await tree();
    await app.user.click(screen.getByRole("button", { name: "More wiki actions" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Wiki trash" });
    expect(await within(dialog).findByText("Its author or an admin can restore it.")).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: "Restore Old price list" }) === null).toBe(true);
  });

  test("loading, failed with a retry that works, and empty", async () => {
    const server = newServer();
    const held = server.hold("listWikiPages");
    const app = await renderApp({ path: PATH, signedInAs: "usr_ana", server });
    expect(await screen.findByRole("status")).toBeDefined();
    server.force("listWikiPages", { kind: "error", status: 500, code: "internal" }, 4);
    held.release();
    expect(await screen.findByText("The wiki could not be loaded")).toBeDefined();
    server.unforce("listWikiPages");
    server.wiki.pages = [];
    await app.user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No pages yet")).toBeDefined();
    expect(screen.getByRole("button", { name: "Write the first page" })).toBeDefined();
  });
});
