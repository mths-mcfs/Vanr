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
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
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

describe("a base, past the happy path", () => {
  test("a File property shows the file's title in the row's panel and on its page", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    tasks.table.defs.push({ id: "doc", name: "Doc", type: "file" });
    const wash = tasks.rows[0];
    if (wash) wash.props.doc = ["fil_plan"];
    const app = await renderApp({
      path: `${W}/bases/${tasks.id}?row=${wash?.id}`,
      signedInAs: "usr_ana",
      server,
    });
    const panel = await screen.findByRole("dialog", { name: "Row" });
    expect(await within(panel).findByRole("button", { name: "Doc of Wash" })).toBeDefined();
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "Doc of Wash" }).textContent).toBe("Release plan"),
    );
    app.unmount();
    await renderApp({ path: `${W}/bases/${tasks.id}/rows/${wash?.id}`, signedInAs: "usr_ana", server });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Doc of Wash" }).textContent).toBe("Release plan"),
    );
  });

  test("Delete on a focused choice empties it; in a text field it only edits the text", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    within(grid).getByRole("combobox", { name: "Status of Wash" }).focus();
    await app.user.keyboard("{Delete}");
    await waitFor(() => expect(tasks.rows[0]?.props.status).toBeNull());
    within(grid).getByRole("textbox", { name: "Name of Dry" }).focus();
    await app.user.keyboard("{Backspace}");
    expect(tasks.rows[1]?.props[tasks.table.titlePropId]).toBe("Dry");
  });

  test("a quick filter is made from a choice, narrows the rows, and goes with its chip", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    const grid = () => screen.getByRole("table", { name: "Grid" });
    await app.user.selectOptions(screen.getByRole("combobox", { name: "Quick filter" }), "Status: Done");
    await waitFor(() =>
      expect(within(grid()).queryByRole("textbox", { name: "Name of Wash" }) === null).toBe(true),
    );
    expect(within(grid()).getByRole("textbox", { name: "Name of Dry" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Filter (1)" })).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Remove the quick filter Status: Done" }));
    await waitFor(() => expect(within(grid()).getByRole("textbox", { name: "Name of Wash" })).toBeDefined());
  });

  test("a grouped grid shows each group with its count, and a group's new row starts in it", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const view = tasks.views[0];
    if (view) view.config = { groupBy: { prop: "status", hideEmpty: true } };
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    expect(
      within(grid)
        .getAllByRole("rowgroup")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual([null, "To do", "Done"]);
    await app.user.click(within(grid).getByRole("button", { name: "New row in Done" }));
    await waitFor(() => expect(tasks.rows).toHaveLength(3));
    expect(tasks.rows[2]?.props.status).toBe("done");
  });

  test("a view change the server refuses says so and comes back to what is saved", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    server.force("updateBaseView", { kind: "error", status: 409, code: "base.bad_view" });
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.selectOptions(screen.getByRole("combobox", { name: "Quick filter" }), "Status: Done");
    expect(await screen.findByText("The view's change was not saved")).toBeDefined();
    await waitFor(() => expect(screen.getByRole("button", { name: "Filter" })).toBeDefined());
  });

  test("a relation picker whose rows could not be loaded says so, with a retry", async () => {
    const server = newServer();
    const { projects } = ids(server);
    server.force("createBaseTableQuery", { kind: "error", status: 400, code: "base.bad_filter" });
    const app = await renderApp({ path: `${W}/bases/${projects.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    server.force("createBaseTableQuery", { kind: "error", status: 400, code: "base.bad_filter" });
    await app.user.click(within(grid).getByRole("button", { name: "Tasks of Home" }));
    const picker = await screen.findByRole("dialog", { name: "Tasks of Home" });
    const alert = await within(picker).findByRole("alert");
    expect(alert.textContent).toContain("The choices could not be loaded.");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(picker).findByRole("checkbox", { name: "Wash" })).toBeDefined();
  });

  test("a rollup whose linked base could not be read says so", async () => {
    const server = newServer();
    const { projects } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${projects.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    server.force("getBase", { kind: "error", status: 403, code: "forbidden" }, 1 + QUERY_RETRIES);
    await app.user.click(screen.getByRole("button", { name: "Edit property Total hours" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Total hours" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "The linked base's properties could not be loaded.",
    );
  });

  test("a property someone changed while it was open is shown again instead of written over", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: "Edit property Hours" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Hours" });
    // Jonas gives Hours a currency format meanwhile, and the screen hears of it.
    const hours = tasks.table.defs.find((def) => def.id === "hours");
    if (hours) hours.numberFormat = "currency_usd";
    tasks.table = { ...tasks.table, schemaVersion: tasks.table.schemaVersion + 1 };
    await act(async () => {
      await app.runtime.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes("getBase"),
      });
    });
    await app.user.click(within(dialog).getByRole("button", { name: "Save property" }));
    const again = await screen.findByRole("dialog", { name: "Edit Hours" });
    expect(await within(again).findByRole("alert")).toBeDefined();
    expect((within(again).getByRole("combobox", { name: "Number format" }) as HTMLSelectElement).value).toBe(
      "currency_usd",
    );
    expect(server.calls.some((call) => call.method === "setBaseTableSchema")).toBe(false);
  });

  test("a filter with groups inside groups is not rewritten by the panel", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const view = tasks.views[0];
    const nested = {
      and: [{ prop: "hours", op: "gt", value: 0 }, { or: [{ prop: "status", op: "eq", value: "todo" }] }],
    };
    if (view) view.config = { filter: nested };
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: /^Filters? / }));
    const panel = await screen.findByRole("dialog", { name: "Filter" });
    expect(within(panel).getByText(/groups inside groups/)).toBeDefined();
    expect(within(panel).queryByRole("button", { name: "Add a condition" }) === null).toBe(true);
    expect(server.calls.some((call) => call.method === "updateBaseView")).toBe(false);
  });

  test("text typed while the row's text is being saved stays", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({
      path: `${W}/bases/${tasks.id}?row=${tasks.rows[0]?.id}`,
      signedInAs: "usr_ana",
      server,
    });
    const panel = await screen.findByRole("dialog", { name: "Row" });
    const body = (await within(panel).findByRole("textbox", { name: "Page text" })) as HTMLTextAreaElement;
    await app.user.type(body, "B");
    const held = server.hold("updateBaseRow");
    await app.user.click(within(panel).getByRole("button", { name: "Save text" }));
    await app.user.type(body, "C");
    held.release();
    await waitFor(() => expect(tasks.rows[0]?.body).toBe("B"));
    await act(async () => {
      await app.runtime.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes("getBaseRow"),
      });
    });
    expect(body.value).toBe("BC");
  });
});

describe("a base, at the edges", () => {
  test("Delete on the button that opens a row leaves its title alone", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    within(grid).getByRole("button", { name: "Open Wash" }).focus();
    await app.user.keyboard("{Delete}");
    expect(server.calls.some((call) => call.method === "updateBaseRow")).toBe(false);
    expect(tasks.rows[0]?.props[tasks.table.titlePropId]).toBe("Wash");
  });

  test("a board with empty groups hidden still offers them as places to move a card to", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const view = tasks.views[0];
    if (view) view.type = "board";
    if (view) view.config = { groupBy: { prop: "status", hideEmpty: true } };
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const board = await screen.findByRole("region", { name: "Grid" });
    expect(within(board).queryByRole("region", { name: "Doing" }) === null).toBe(true);
    await app.user.selectOptions(within(board).getByRole("combobox", { name: "Move Wash to" }), "Doing");
    await waitFor(() => expect(tasks.rows[0]?.props.status).toBe("doing"));
  });

  test("a row whose option was removed shows under no group, not nowhere", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const status = tasks.table.defs.find((def) => def.id === "status");
    if (status) status.options = status.options?.filter((option) => option.id !== "done");
    const view = tasks.views[0];
    if (view) view.config = { groupBy: { prop: "status" } };
    await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    const none = within(grid).getByRole("rowgroup", { name: "No Status" });
    expect(within(none).getByRole("textbox", { name: "Name of Dry" })).toBeDefined();
  });

  test("leaving a number cell without changing it writes nothing", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const wash = tasks.rows[0];
    if (wash) wash.props.hours = 1e-21;
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    await app.user.click(within(grid).getByRole("textbox", { name: "Hours of Wash" }));
    await app.user.tab();
    expect(server.calls.some((call) => call.method === "updateBaseRow")).toBe(false);
    expect(tasks.rows[0]?.props.hours).toBe(1e-21);
  });

  test("text typed back to the old value while a save is on its way still stays", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const wash = tasks.rows[0];
    if (wash) wash.body = "A";
    const app = await renderApp({
      path: `${W}/bases/${tasks.id}?row=${wash?.id}`,
      signedInAs: "usr_ana",
      server,
    });
    const panel = await screen.findByRole("dialog", { name: "Row" });
    const body = (await within(panel).findByRole("textbox", { name: "Page text" })) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toBe("A"));
    await app.user.clear(body);
    await app.user.type(body, "B");
    const held = server.hold("updateBaseRow");
    await app.user.click(within(panel).getByRole("button", { name: "Save text" }));
    await app.user.clear(body);
    await app.user.type(body, "A");
    held.release();
    await waitFor(() => expect(tasks.rows[0]?.body).toBe("B"));
    await act(async () => {
      await app.runtime.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes("getBaseRow"),
      });
    });
    expect(body.value).toBe("A");
    expect(within(panel).getByRole("button", { name: "Save text" }).hasAttribute("disabled")).toBe(false);
  });

  test("a property save that answers after its dialog closed leaves the next dialog open", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: "Edit property Hours" }));
    const first = await screen.findByRole("dialog", { name: "Edit Hours" });
    const held = server.hold("setBaseTableSchema");
    await app.user.click(within(first).getByRole("button", { name: "Save property" }));
    await app.user.click(within(first).getByRole("button", { name: "Cancel" }));
    await app.user.click(screen.getByRole("button", { name: "Edit property Status" }));
    await screen.findByRole("dialog", { name: "Edit Status" });
    held.release();
    await waitFor(() => expect(server.calls.some((call) => call.method === "setBaseTableSchema")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("dialog", { name: "Edit Status" })).toBeDefined();
  });

  test("deleting a property someone changed meanwhile shows theirs first; one deleted meanwhile says so", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    const refresh = () =>
      act(async () => {
        await app.runtime.queryClient.refetchQueries({
          predicate: (query) => query.queryKey.includes("getBase"),
        });
      });
    await app.user.click(screen.getByRole("button", { name: "Edit property Hours" }));
    let dialog = await screen.findByRole("dialog", { name: "Edit Hours" });
    const hours = tasks.table.defs.find((def) => def.id === "hours");
    if (hours) hours.numberFormat = "percent";
    tasks.table = { ...tasks.table, schemaVersion: tasks.table.schemaVersion + 1 };
    await refresh();
    await app.user.click(within(dialog).getByRole("button", { name: "Delete property" }));
    dialog = await screen.findByRole("dialog", { name: "Edit Hours" });
    expect((within(dialog).getByRole("combobox", { name: "Number format" }) as HTMLSelectElement).value).toBe(
      "percent",
    );
    expect(server.calls.some((call) => call.method === "setBaseTableSchema")).toBe(false);
    tasks.table = {
      ...tasks.table,
      defs: tasks.table.defs.filter((def) => def.id !== "hours"),
      schemaVersion: tasks.table.schemaVersion + 1,
    };
    await refresh();
    await app.user.click(within(dialog).getByRole("button", { name: "Save property" }));
    expect(await screen.findByText("Someone deleted this property while it was open.")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Hours" }) === null).toBe(true));
  });

  test("an operator that takes several options lets several be chosen", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const view = tasks.views[0];
    if (view) view.config = { filter: { and: [{ prop: "status", op: "eq", value: "todo" }] } };
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    await app.user.click(screen.getByRole("button", { name: /^Filters? / }));
    const panel = await screen.findByRole("dialog", { name: "Filter" });
    await app.user.selectOptions(
      within(panel).getByRole("combobox", { name: "Operator of condition 1" }),
      "is one of",
    );
    await app.user.click(within(panel).getByRole("checkbox", { name: "Done" }));
    await waitFor(() =>
      expect(tasks.views[0]?.config.filter).toEqual({
        and: [{ prop: "status", op: "in", value: ["todo", "done"] }],
      }),
    );
  });

  test("an empty base grouped by status shows its groups, and a row starts in the one chosen", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    tasks.rows = [];
    const view = tasks.views[0];
    if (view) view.config = { groupBy: { prop: "status" } };
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    await app.user.click(within(grid).getByRole("button", { name: "New row in Doing" }));
    await waitFor(() => expect(tasks.rows[0]?.props.status).toBe("doing"));
  });

  test("two quick changes to a view reach the server one after the other, the newest last", async () => {
    const server = newServer();
    const { tasks } = ids(server);
    const app = await renderApp({ path: `${W}/bases/${tasks.id}`, signedInAs: "usr_ana", server });
    await screen.findByRole("table", { name: "Grid" });
    const held = server.hold("updateBaseView");
    const quick = screen.getByRole("combobox", { name: "Quick filter" });
    await app.user.selectOptions(quick, "Status: Done");
    await app.user.selectOptions(screen.getByRole("combobox", { name: "Quick filter" }), "Status: Doing");
    held.release();
    await waitFor(() => expect(tasks.views[0]?.config.quickFilters).toHaveLength(2));
  });
});
