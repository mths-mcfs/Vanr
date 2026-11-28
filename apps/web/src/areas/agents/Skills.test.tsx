import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { QUERY_RETRIES } from "@vanr/client/react";
import { newServer, renderApp } from "../../../test/app.tsx";

const PATH = "/workspace/workspace_birchwood/skills";
const names = () =>
  within(screen.getByRole("list", { name: "Skills" }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector("strong")?.textContent);

describe("the workspace's skills", () => {
  test("the catalog: name, where it came from, version and description", async () => {
    await renderApp({ path: PATH, signedInAs: "usr_iris" });
    await screen.findByRole("heading", { level: 1, name: "Skills" });
    expect(names()).toEqual(["Release notes", "Invoice check"]);
    const invoices = within(screen.getByRole("list", { name: "Skills" })).getAllByRole("listitem")[1];
    expect(invoices?.textContent).toContain("From GitHub");
    expect(invoices?.textContent).toContain("v1");
    expect(invoices?.textContent).toContain("Match invoices against orders.");
    expect(screen.queryByRole("button", { name: "Add a skill" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "Download Release notes as SKILL.md" })).toBeDefined();
  });

  test("a long catalog shows a few, and all of them with a search", async () => {
    const server = newServer();
    const [first] = server.agentWork.skills;
    if (first === undefined) throw new Error("the seed has no skills");
    for (let n = 1; n <= 6; n += 1) {
      server.agentWork.skills.push({
        ...structuredClone(first),
        id: `skl_extra_${n}`,
        name: `Extra ${n}`,
        description: n === 4 ? "Folds the brochures" : "Something else",
      });
    }
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    await screen.findByRole("list", { name: "Skills" });
    expect(names()).toHaveLength(6);
    await app.user.click(screen.getByRole("button", { name: "Show all 8" }));
    expect(names()).toHaveLength(8);
    await app.user.type(screen.getByLabelText("Find a skill"), "brochures");
    expect(names()).toEqual(["Extra 4"]);
    await app.user.clear(screen.getByLabelText("Find a skill"));
    await app.user.type(screen.getByLabelText("Find a skill"), "zebra");
    expect(screen.getByText("Nothing in the catalog matches “zebra”.")).toBeDefined();
  });

  test("an admin writes a skill that every new agent gets", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Add a skill" }));
    const dialog = await screen.findByRole("dialog", { name: "New skill" });
    const save = within(dialog).getByRole("button", { name: "Save" });
    await app.user.type(within(dialog).getByLabelText("Name"), "-bad");
    expect(within(dialog).getByText(/Use letters, numbers, spaces/)).toBeDefined();
    await app.user.clear(within(dialog).getByLabelText("Name"));
    await app.user.type(within(dialog).getByLabelText("Name"), "Stock count");
    await app.user.type(within(dialog).getByLabelText("Description"), "Counts the paper");
    expect(save.hasAttribute("disabled")).toBe(true);
    await app.user.type(within(dialog).getByLabelText("Instructions"), "Count every shelf.");
    await app.user.click(within(dialog).getByRole("switch", { name: /New agents get it/ }));
    await app.user.click(save);
    expect(await screen.findByText("Stock count was saved")).toBeDefined();
    await waitFor(() => expect(names()).toContain("Stock count"));
    expect(
      app.server.agentWork.skills.find((skill) => skill.name === "Stock count")?.autoGrantNewAgents,
    ).toBe(true);
  });

  test("an admin imports one from GitHub; a bad address says why", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    await app.user.click(await screen.findByRole("button", { name: "Add a skill" }));
    const dialog = await screen.findByRole("dialog", { name: "New skill" });
    await app.user.click(within(dialog).getByRole("tab", { name: "Import from GitHub" }));
    await app.user.type(within(dialog).getByLabelText("GitHub address"), "https://example.com/x");
    await app.user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Use a GitHub address");
    await app.user.clear(within(dialog).getByLabelText("GitHub address"));
    await app.user.type(
      within(dialog).getByLabelText("GitHub address"),
      "https://github.com/acme/skills/folding",
    );
    await app.user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(await screen.findByText("folding was imported")).toBeDefined();
    await waitFor(() => expect(names()).toContain("folding"));
  });

  test("editing an imported skill warns where it came from and lists its files", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const row = within(await screen.findByRole("list", { name: "Skills" })).getAllByRole("listitem")[1];
    await app.user.click(within(row as HTMLElement).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit skill" });
    expect(await within(dialog).findByText(/Imported from https:\/\/github.com\/birchwood/)).toBeDefined();
    expect(within(dialog).getByRole("list", { name: "Files" }).textContent).toContain("SKILL.md");
    await app.user.clear(within(dialog).getByLabelText("Description"));
    await app.user.type(within(dialog).getByLabelText("Description"), "Match every invoice.");
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Invoice check was saved")).toBeDefined();
    await waitFor(() => expect(screen.getByText("Match every invoice.")).toBeDefined());
    expect(screen.getByText("v2")).toBeDefined();
  });

  test("an admin deletes a skill after confirming", async () => {
    const app = await renderApp({ path: PATH, signedInAs: "usr_jonas" });
    const row = within(await screen.findByRole("list", { name: "Skills" })).getAllByRole("listitem")[0];
    await app.user.click(within(row as HTMLElement).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Release notes?" });
    await app.user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Release notes was deleted")).toBeDefined();
    await waitFor(() => expect(names()).toEqual(["Invoice check"]));
  });

  test("failed: what could not be loaded, and a retry that works", async () => {
    const server = newServer();
    server.force("listSkills", { kind: "error", status: 500, code: "internal" }, 1 + QUERY_RETRIES);
    const app = await renderApp({ path: PATH, signedInAs: "usr_iris", server });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert.textContent).toContain("The skills could not be loaded");
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("list", { name: "Skills" });
  });

  test("empty: what belongs here, with the way to add one for an admin", async () => {
    const server = newServer();
    server.agentWork.skills = [];
    await renderApp({ path: PATH, signedInAs: "usr_jonas", server });
    expect(await screen.findByText("No skills yet")).toBeDefined();
    expect(screen.getByRole("button", { name: "Add a skill" })).toBeDefined();
  });
});
