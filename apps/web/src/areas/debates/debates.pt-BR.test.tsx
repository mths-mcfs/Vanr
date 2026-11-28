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
    expect(screen.getByText("Um participante está demorando mais que o esperado")).toBeDefined();
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

  test("a debate's page: letters while blind, the turn, and the verdict once it ends", async () => {
    const app = await renderApp({ path: `${LIST}/deb_paper`, signedInAs: "usr_ana", languages: PT });
    const grid = within(await screen.findByRole("table"));
    expect(grid.getByRole("rowheader", { name: "Participante A" })).toBeDefined();
    expect(grid.getByText("Northpaper: 2 de 3")).toBeDefined();
    expect(screen.getByText("1 resposta está lacrada até todos desta rodada responderem.")).toBeDefined();
    const turn = within(screen.getByRole("region", { name: "É a sua vez" }));
    expect(turn.getByRole("button", { name: "Pular minha vez" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Concluir agora" })).toBeDefined();
    app.unmount();

    await renderApp({ path: `${LIST}/deb_logo`, signedInAs: "usr_ana", languages: PT });
    const synthesis = within(await screen.findByRole("region", { name: "Síntese" }));
    expect(synthesis.getByText("Use the round mark on the sign.")).toBeDefined();
    expect(synthesis.getByRole("button", { name: "Transformar 2 passos em tarefas" })).toBeDefined();
    expect(screen.getByText(/^Aceito por Ana Beatriz Souza/)).toBeDefined();
    expect(screen.getByText("Gasto até agora: US$ 0,0123")).toBeDefined();
    expect(screen.getByText("Parou porque todos concordaram.")).toBeDefined();
  });
});
