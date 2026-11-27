// The files area in Portuguese: the Drive, a file's preview, the trash and the search, by what a person
// reads on screen.
import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

const W = "/workspace/workspace_birchwood";
const pt = { signedInAs: "usr_ana", languages: ["pt-BR"] };

describe("arquivos em português", () => {
  test("a lista diz o tipo, a versão e a origem de cada arquivo", async () => {
    await renderApp({ path: `${W}/files`, ...pt });
    await screen.findByRole("heading", { level: 1, name: "Arquivos" });
    const list = await screen.findByRole("list", { name: "Arquivos" });
    expect(list.textContent).toContain("Documento, versão 2");
    expect(list.textContent).toContain("Só em Arquivos");
    expect(screen.getByRole("button", { name: "Enviar arquivos" })).toBeDefined();
  });

  test("a prévia mostra a versão e o histórico", async () => {
    await renderApp({ path: `${W}/files?file=fil_plan`, ...pt });
    const open = await screen.findByRole("dialog", { name: "Release plan" });
    expect(within(open).getByTestId("files-version").textContent).toBe("Versão 2 de 2");
    expect(within(open).getByRole("list", { name: "Histórico" })).toBeDefined();
    expect(within(open).getByRole("button", { name: "Mover para a lixeira" })).toBeDefined();
  });

  test("a lixeira conta os dias que faltam", async () => {
    await renderApp({ path: `${W}/files?trash=1`, ...pt, signedInAs: "usr_tomas" });
    const trash = await screen.findByRole("list", { name: "Arquivos excluídos" });
    expect(trash.textContent).toContain("Faltam 2 dias");
    expect(trash.textContent).toContain("Quem criou ou um administrador pode restaurar");
  });

  test("a busca pede dois caracteres e mostra os resultados", async () => {
    const app = await renderApp({ path: `${W}/search`, ...pt });
    expect(await screen.findByText("Digite pelo menos dois caracteres para buscar")).toBeDefined();
    await app.user.type(screen.getByRole("searchbox", { name: "Buscar no espaço de trabalho" }), "drying");
    const results = await screen.findByRole("list", { name: "Resultados" });
    expect(within(results).getByText("Arquivo")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Perguntar" }));
    expect(await screen.findByText("Respondido pelo modelo de teste, não por um modelo real.")).toBeDefined();
  });
});
