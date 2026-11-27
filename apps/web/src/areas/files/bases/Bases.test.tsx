// Bases as a person uses them: the list and a new base, the grid with cells edited in place, a property
// added (with a relation and a rollup shown from another base), a board grouped by status, a row's
// panel and page, and a change made elsewhere showing up without a reload.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const W = "/workspace/workspace_birchwood";
const ids = (server: ReturnType<typeof newServer>) => {
  const [tasks, projects] = server.bases.bases;
  if (tasks === undefined || projects === undefined) throw new Error("no seeded bases");
  return { tasks, projects };
};

describe("the list of bases", () => {
  test("shows each base with its rows and opens it", async () => {
    const server = newServer();
    const app = await renderApp({ path: `${W}/bases`, signedInAs: "usr_ana", server });
    await screen.findByRole("heading", { level: 1, name: "Bases" });
    const list = await screen.findByRole("list", { name: "Bases" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent?.slice(0, 13)),
    ).toEqual(["Tasks2 rowsAn", "Projects1 row"]);
    await app.user.click(within(list).getByRole("link", { name: "Tasks" }));
    await screen.findByRole("button", { name: "Rename Tasks" });
    expect(app.address()).toBe(`${W}/bases/${ids(server).tasks.id}`);
    expect(document.title).toBe("Tasks | Birchwood Labs | Vanr");
  });

  test("empty: says what a base is, and a new one opens once it has a name", async () => {
    const server = newServer();
    server.bases.bases = [];
    const app = await renderApp({ path: `${W}/bases`, signedInAs: "usr_ana", server });
    expect(await screen.findByText("No bases yet")).toBeDefined();
    await app.user.click(screen.getAllByRole("button", { name: "New base" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "New base" });
    const create = within(dialog).getByRole("button", { name: "Create base" });
    expect(create.hasAttribute("disabled")).toBe(true);
    await app.user.type(within(dialog).getByRole("textbox", { name: /Name/ }), "Suppliers");
    await app.user.click(create);
    await screen.findByRole("button", { name: "Rename Suppliers" });
    expect(await screen.findByText("No rows yet")).toBeDefined();
  });

  test("failed: says so, with a retry that works", async () => {
    const server = newServer();
    server.force("listBases", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: `${W}/bases`, signedInAs: "usr_ana", server });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert.textContent).toContain("The bases could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "Bases" });
  });
});

describe("a base", () => {
  test("the grid edits a cell in place and keeps the server's answer", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    expect(
      within(grid)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Name", "Status", "Hours"]);
    const hours = within(grid).getByRole("textbox", { name: "Hours of Wash" }) as HTMLInputElement;
    await app.user.clear(hours);
    await app.user.type(hours, "4,5{Enter}");
    await waitFor(() => expect(tasks.rows[0]?.props.hours).toBe(4.5));
    // Not a number: the old value stays and nothing is sent.
    const calls = server.calls.filter((call) => call.method === "updateBaseRow").length;
    await app.user.clear(hours);
    await app.user.type(hours, "lots{Enter}");
    expect(hours.value).toBe("4.5");
    expect(server.calls.filter((call) => call.method === "updateBaseRow")).toHaveLength(calls);
    await app.user.selectOptions(within(grid).getByRole("combobox", { name: "Status of Wash" }), "Doing");
    await waitFor(() => expect(tasks.rows[0]?.props.status).toBe("doing"));
  });

  test("a relation shows the linked rows' titles and a rollup sums their hours", async () => {
    const server = newServer();
    const { projects } = ids(server);
    await renderApp({ path: `${W}/bases/${projects.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    expect(within(grid).getByRole("button", { name: "Tasks of Home" }).textContent).toBe("Wash, Dry");
    const row = within(grid).getAllByRole("row")[1];
    expect(row?.textContent).toContain("5");
  });

  test("a new property: a name already taken is refused, then the column shows", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: "New property" }));
    const dialog = await screen.findByRole("dialog", { name: "New property" });
    const name = within(dialog).getByRole("textbox", { name: /Name/ });
    await app.user.type(name, "hours");
    expect(within(dialog).getByText("Another property already has this name.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Save property" }).hasAttribute("disabled")).toBe(true);
    await app.user.clear(name);
    await app.user.type(name, "Due");
    await app.user.selectOptions(within(dialog).getByRole("combobox", { name: "Type" }), "Date");
    await app.user.click(within(dialog).getByRole("button", { name: "Save property" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const grid = screen.getByRole("table", { name: "Grid" });
    await waitFor(() =>
      expect(
        within(grid)
          .getAllByRole("columnheader")
          .map((cell) => cell.textContent),
      ).toEqual(["Name", "Status", "Hours", "Due"]),
    );
  });

  test("a formula's result is previewed on the first row while it is typed", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: "New property" }));
    const dialog = await screen.findByRole("dialog", { name: "New property" });
    await app.user.selectOptions(within(dialog).getByRole("combobox", { name: "Type" }), "Formula");
    const formula = within(dialog).getByRole("textbox", { name: /Formula/ });
    await app.user.click(formula);
    await app.user.paste('prop("Hours") * 2');
    expect(await within(dialog).findByText("On the first row: 4")).toBeDefined();
    expect(within(dialog).getByText("Result: number")).toBeDefined();
    await app.user.clear(formula);
    await app.user.paste('prop("Nope")');
    expect(await within(dialog).findByText("There is no property named Nope.")).toBeDefined();
  });

  test("a board groups by status, and a card moves to another column", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: "New view" }));
    await app.user.click(screen.getByRole("button", { name: "Board" }));
    const board = await screen.findByRole("region", { name: "Board" });
    expect(within(within(board).getByRole("region", { name: "To do" })).getByText("Wash")).toBeDefined();
    expect(within(within(board).getByRole("region", { name: "Done" })).getByText("Dry")).toBeDefined();
    await app.user.selectOptions(within(board).getByRole("combobox", { name: "Move Wash to" }), "Doing");
    await waitFor(() =>
      expect(within(within(board).getByRole("region", { name: "Doing" })).getByText("Wash")).toBeDefined(),
    );
    expect(tasks.rows[0]?.props.status).toBe("doing");
  });

  test("a row opens beside the base, its text saves, and it opens as a page with the text kept", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Open Wash" }));
    const panel = await screen.findByRole("dialog", { name: "Row" });
    const body = await within(panel).findByRole("textbox", { name: "Page text" });
    const save = within(panel).getByRole("button", { name: "Save text" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await app.user.type(body, "Use cold water.");
    await app.user.click(save);
    await waitFor(() => expect(tasks.rows[0]?.body).toBe("Use cold water."));
    await app.user.click(within(panel).getByRole("link", { name: /Open as a page/ }));
    await screen.findByRole("link", { name: /Back to Tasks/ });
    expect(((await screen.findByRole("textbox", { name: "Page text" })) as HTMLTextAreaElement).value).toBe(
      "Use cold water.",
    );
    expect(app.address()).toBe(`${W}/bases/${tasks.id}/rows/${tasks.rows[0]?.id}`);
  });

  test("a row someone else adds shows up without a reload", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    await waitFor(() => expect(app.server.openSockets().length).toBe(1));
    await act(async () => {
      server.bases.row(tasks, { [tasks.table.titlePropId]: "Fold" }, { type: "person", id: "usr_jonas" });
      server.emit("workspace_birchwood", { type: "base.rows", baseId: tasks.id, tableId: tasks.table.id });
    });
    await waitFor(() => expect(within(grid).getByRole("textbox", { name: "Name of Fold" })).toBeDefined());
  });

  test("renaming takes Enter and gives up on Escape", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await app.user.click(await screen.findByRole("button", { name: "Rename Tasks" }));
    await app.user.type(screen.getByRole("textbox", { name: "Base name" }), " list{Escape}");
    expect(await screen.findByRole("button", { name: "Rename Tasks" })).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Rename Tasks" }));
    await app.user.type(screen.getByRole("textbox", { name: "Base name" }), " list{Enter}");
    expect(await screen.findByRole("button", { name: "Rename Tasks list" })).toBeDefined();
  });
});

describe("saving rows", () => {
  test("two quick edits of one row both land: the second waits for the first and takes its version", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    const held = server.hold("updateBaseRow");
    const title = within(grid).getByRole("textbox", { name: "Name of Wash" });
    await app.user.clear(title);
    await app.user.type(title, "Rinse{Enter}");
    const hours = within(grid).getByRole("textbox", { name: "Hours of Rinse" });
    await app.user.clear(hours);
    await app.user.type(hours, "6{Enter}");
    held.release();
    await waitFor(() => expect(tasks.rows[0]?.props).toMatchObject({ hours: 6 }));
    expect(tasks.rows[0]?.props[tasks.table.titlePropId]).toBe("Rinse");
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });
});
