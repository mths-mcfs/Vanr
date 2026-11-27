// Bases in Portuguese: the list, a base's grid and a property's dialog, by what a person reads.
import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../../test/app.tsx";

const W = "/workspace/workspace_birchwood";
const pt = { signedInAs: "usr_ana", languages: ["pt-BR"] };

describe("bases em português", () => {
  test("a lista conta as linhas de cada base", async () => {
    await renderApp({ path: `${W}/bases`, ...pt });
    const list = await screen.findByRole("list", { name: "Bases" });
    expect(list.textContent).toContain("2 linhas");
    expect(list.textContent).toContain("1 linha");
    expect(screen.getByRole("button", { name: "Nova base" })).toBeDefined();
  });

  test("a grade nomeia cada célula e o diálogo de propriedade oferece relação e rollup", async () => {
    const server = newServer();
    const tasks = server.bases.bases[0];
    const app = await renderApp({ path: `${W}/bases/${tasks?.id}`, ...pt, server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    expect(within(grid).getByRole("combobox", { name: "Status de Wash" })).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Nova propriedade" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova propriedade" });
    const type = within(dialog).getByRole("combobox", { name: "Tipo" });
    expect(within(type).getByRole("option", { name: "Relação" })).toBeDefined();
    await app.user.selectOptions(type, "Rollup");
    expect(within(dialog).getByText(/Um rollup trabalha sobre uma relação/)).toBeDefined();
  });
});

describe("números em português", () => {
  test("a célula de número em edição usa vírgula, como a leitura", async () => {
    const server = newServer();
    const tasks = server.bases.bases[0];
    const wash = tasks?.rows[0];
    if (wash) wash.props.hours = 3.5;
    await renderApp({ path: `${W}/bases/${tasks?.id}`, ...pt, server });
    const grid = await screen.findByRole("table", { name: "Grid" });
    expect((within(grid).getByRole("textbox", { name: "Hours de Wash" }) as HTMLInputElement).value).toBe(
      "3,5",
    );
  });
});
