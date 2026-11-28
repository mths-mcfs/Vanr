// The creation, the profile, the lab and the skills in Portuguese.
import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

const BASE = "/workspace/workspace_birchwood";
const languages = ["pt-BR"];

test("adicionar um agente, em português", async () => {
  const app = await renderApp({ path: `${BASE}/agents/new`, signedInAs: "usr_ana", languages });
  await screen.findByRole("form", { name: "Etapa 1 de 6: Função" });
  expect(screen.getByRole("button", { name: /^Suporte/ })).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Avançar" }));
  await screen.findByRole("form", { name: "Etapa 2 de 6: Nome" });
  await app.user.type(screen.getByLabelText("Nome"), "Ledger");
  expect(screen.getByText("Esse identificador já está em uso. Escolha outro.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Me surpreenda" })).toBeDefined();
});

test("o perfil e o laboratório, em português", async () => {
  const app = await renderApp({ path: `${BASE}/agents/agt_scout`, signedInAs: "usr_jonas", languages });
  await screen.findByRole("heading", { level: 1, name: "Scout" });
  expect(screen.getByRole("tablist", { name: "Seções do agente" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Conversar com Scout" })).toBeDefined();
  await app.user.click(screen.getByRole("tab", { name: "Laboratório" }));
  expect(await screen.findByText("Nenhum caso de teste ainda. Adicione um abaixo.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Rodar os casos" })).toBeDefined();
  await app.user.click(screen.getByRole("tab", { name: "Atividade" }));
  const runs = await screen.findByRole("list", { name: "Atividade" });
  expect(within(runs).getAllByRole("listitem")[0]?.textContent).toContain("Concluída");
  expect(within(runs).getByRole("button", { name: "Salvar como skill" })).toBeDefined();
});

test("as skills, em português", async () => {
  await renderApp({ path: `${BASE}/skills`, signedInAs: "usr_jonas", languages });
  await screen.findByRole("heading", { level: 1, name: "Skills" });
  expect(screen.getByText("Do GitHub")).toBeDefined();
  expect(screen.getByRole("button", { name: "Adicionar uma skill" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Baixar Release notes como SKILL.md" })).toBeDefined();
});

test("memória, acesso e ambiente, em português", async () => {
  const app = await renderApp({
    path: `${BASE}/agents/agt_scout?tab=memory`,
    signedInAs: "usr_iris",
    languages,
  });
  expect(await screen.findByRole("tab", { name: "Fatos e decisões (2)" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "Arquivadas (1)" })).toBeDefined();
  await app.user.click(screen.getByRole("tab", { name: "Acesso" }));
  expect(await screen.findByRole("list", { name: "Regras por canal" })).toBeDefined();
  expect(screen.getByText("Todas as conexões")).toBeDefined();
  await app.user.click(screen.getByRole("tab", { name: "Ambiente" }));
  expect(await screen.findByText("Trabalha em Studio Mac, que está conectado.")).toBeDefined();
  expect(screen.getByText("Ninguém está conduzindo o navegador do agente.")).toBeDefined();
});

test("runners e pareamento, em português", async () => {
  await renderApp({ path: `${BASE}/settings/runners`, signedInAs: "usr_iris", languages });
  const list = await screen.findByRole("list", { name: "Runners" });
  expect(list.textContent).toContain("Pareado por Ana Beatriz Souza");
  expect(list.textContent).toContain("Conectado");
});

test("o pareamento por código, em português", async () => {
  await renderApp({ path: "/connect?code=BIRCH7", signedInAs: "usr_jonas", languages });
  await screen.findByRole("heading", { name: "Parear Garage laptop?" });
  expect(screen.getByText("O código expira em 9 minutos.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Parear" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Recusar" })).toBeDefined();
});

test("o dinheiro do mês no formato do português", async () => {
  await renderApp({ path: `${BASE}/agents/agt_scout`, signedInAs: "usr_iris", languages });
  await screen.findByRole("heading", { level: 1, name: "Scout" });
  const month = screen.getByRole("region", { name: "Este mês" });
  expect(month.textContent?.replace(/\s/g, " ")).toContain("US$ 5,00");
  expect(month.textContent?.replace(/\s/g, " ")).toContain("10% de US$ 50,00");
});
