// The wiki in Portuguese: the index, a page and its history, by what a person reads on screen.
import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";
import en from "../../messages/wiki/en.ts";
import ptBR from "../../messages/wiki/pt-BR.ts";

const W = "/workspace/workspace_birchwood/wiki";
const pt = { signedInAs: "usr_ana", languages: ["pt-BR"] };

describe("a wiki em português", () => {
  test("todo texto da wiki existe em português, e nenhum está vazio", () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort());
    expect(Object.entries(ptBR).filter(([, text]) => text === "")).toEqual([]);
  });

  test("o índice mostra as páginas por pasta, as fixadas e as mais lidas", async () => {
    await renderApp({ path: W, ...pt });
    expect(await screen.findByText("3 páginas")).toBeDefined();
    expect(await screen.findByRole("navigation", { name: "Páginas por pasta" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Fixadas" })).toBeDefined();
    expect(
      within(screen.getByRole("region", { name: "Mais lidas pelos agentes" })).getByText("12 leituras"),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Nova página" })).toBeDefined();
  });

  test("a página diz quem alterou, o estado do rascunho e o histórico", async () => {
    const app = await renderApp({ path: `${W}/press-checklist`, ...pt });
    await screen.findByRole("textbox", { name: "Título da página" });
    expect(screen.getByText(/Alterada por Scout ontem, versão 2/)).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Conectando…");
    await app.user.click(screen.getByRole("button", { name: "Ações da página" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Histórico de versões" }));
    const dialog = await screen.findByRole("dialog", { name: "Histórico de Press checklist" });
    expect(within(dialog).getByText("Publicada")).toBeDefined();
    expect(await within(dialog).findByText(/Versão 1 → 2: 3 acrescentadas, 1 removidas/)).toBeDefined();
  });
});
