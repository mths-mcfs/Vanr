import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

const LIST = "/workspace/workspace_birchwood/debates";
const PT = ["pt-BR"] as const;

describe("the debates, in Portuguese", () => {
  test("the groups, the round, the table and what is stuck", async () => {
    await renderApp({ path: LIST, signedInAs: "usr_ana", languages: PT });
    await screen.findByRole("heading", { level: 1, name: "Debates" });
    const you = within(screen.getByRole("region", { name: "Precisa de você (1)" }));
    const paper = within(you.getByRole("article", { name: "Which paper supplier do we keep?" }));
    expect(paper.getByText("Sua vez")).toBeDefined();
    expect(paper.getByText("Rodada 1 de 2")).toBeDefined();
    expect(paper.getByText("Ana Beatriz Souza, aguardado")).toBeDefined();
    const live = within(screen.getByRole("region", { name: "Em discussão agora (1)" }));
    expect(live.getByText("Respostas iniciais, ainda lacradas")).toBeDefined();
    expect(screen.getByText("Parado em Ledger: The model did not answer")).toBeDefined();
  });

  test("the numbers, with the cost for who sees spend", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", languages: PT });
    await app.user.click(await screen.findByText("Como foram os debates nos últimos 90 dias"));
    expect(await screen.findByText("Custo médio por debate")).toBeDefined();
    expect(screen.getByText("US$ 0,0123")).toBeDefined();
  });

  test("starting one: the speaking order, the ceiling of calls and the cap", async () => {
    const app = await renderApp({ path: LIST, signedInAs: "usr_ana", languages: PT });
    await app.user.click(await screen.findByRole("button", { name: "Começar um debate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Começar um debate" }));
    expect(dialog.getByText("Escolha um agente para ver quanto isso pode custar.")).toBeDefined();
    await app.user.click(await dialog.findByRole("checkbox", { name: "Scout" }));
    expect(dialog.getByRole("checkbox", { name: "1. Scout" })).toBeDefined();
    await app.user.click(dialog.getByRole("checkbox", { name: "Ana Beatriz Souza (você)" }));
    expect(dialog.getByRole("checkbox", { name: "2. Ana Beatriz Souza (você)" })).toBeDefined();
    expect(await dialog.findByText("No máximo 3 chamadas ao modelo, até US$ 0,1275")).toBeDefined();
    await app.user.type(dialog.getByRole("textbox", { name: "Teto de gasto (%)" }), "0,05");
    expect(dialog.getByText("Use um número de 0,1 a 100.")).toBeDefined();
  });
});
