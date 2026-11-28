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
