// The issues in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";

// The fixtures are in UTC: the screens read them in the same zone wherever the tests run.
process.env.TZ = "UTC";

import { fireEvent, screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

test("the board and an issue, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/issues",
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  await screen.findByRole("heading", { level: 1, name: "Tarefas" });
  expect(screen.getByText("3 tarefas")).toBeDefined();
  const todo = screen.getByRole("region", { name: /^A fazer/ });
  expect(within(todo).getByRole("img", { name: "1 de 2 critérios cumpridos" })).toBeDefined();
  expect(within(todo).getByRole("img", { name: "Prioridade: Alta" })).toBeDefined();
  fireEvent.keyDown(within(todo).getByRole("button", { name: "Mover #1" }), { key: " " });
  expect(screen.getByRole("status").textContent).toBe("#1 pega em A fazer, posição 1 de 1.");
  fireEvent.keyDown(screen.getByRole("button", { name: "Mover #1" }), { key: "Escape" });
  expect(screen.getByRole("tab", { name: "Lista" })).toBeDefined();
  expect(screen.getByRole("switch", { name: "Mostrar canceladas" })).toBeDefined();
  await app.user.click(within(todo).getByRole("link", { name: "Reprint the spring catalogue" }));
  await screen.findByRole("heading", { level: 1, name: "#1 Reprint the spring catalogue" });
  expect(screen.getByRole("region", { name: "Critérios de aceite" })).toBeDefined();
  expect(await screen.findByText(/Ana Beatriz Souza abriu a tarefa/)).toBeDefined();
  expect(screen.getByRole("region", { name: "Entregar a um agente" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Publicar comentário" })).toBeDefined();
});

test("the calendar and the routines, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/calendar",
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  await screen.findByRole("heading", { level: 1, name: "Agenda" });
  expect(screen.getByText("9 de nov. – 15 de nov. de 2026")).toBeDefined();
  expect(screen.getByRole("region", { name: "Sugeridos por agentes" })).toBeDefined();
  expect(screen.getByText("Scout sugere")).toBeDefined();
  const wednesday = screen.getByRole("region", { name: /^quarta-feira/ });
  expect(
    within(wednesday).getByRole("link", { name: "Prazo: #1 Reprint the spring catalogue" }),
  ).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Novo evento" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Novo evento" }));
  expect(dialog.getByRole("combobox", { name: "Repete" }).textContent).toBe("Não repete");
  await app.user.click(dialog.getByRole("button", { name: "Cancelar" }));

  await app.user.click(screen.getByRole("link", { name: "Rotinas" }));
  await screen.findByRole("heading", { level: 1, name: "Rotinas" });
  const digest = within(screen.getByRole("article", { name: "Morning digest" }));
  expect(digest.getByText("Todo dia às 09:00")).toBeDefined();
  expect(digest.getByText("Numa conversa direta com o agente")).toBeDefined();
  expect(digest.getByRole("button", { name: "Executar agora" })).toBeDefined();
  expect(within(screen.getByRole("article", { name: "Invoice watcher" })).getByText("Pausada")).toBeDefined();
});

test("the assignments, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/assignments",
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  await screen.findByRole("heading", { level: 1, name: "Atribuições" });
  const paper = within(screen.getByRole("article", { name: "Restock the paper room" }));
  expect(paper.getByText("Trabalhando")).toBeDefined();
  expect(paper.getByText("1 de 2 passos")).toBeDefined();
  expect(paper.getByText("3 coisas esperam você")).toBeDefined();
  expect(screen.getByRole("tab", { name: "Encerradas (1)" })).toBeDefined();
  await app.user.click(paper.getByRole("link", { name: "Restock the paper room" }));
  const panel = within(await screen.findByRole("region", { name: "Atribuição" }));
  expect(panel.getByText("Você é o dono")).toBeDefined();
  expect(panel.getByRole("button", { name: "Pausar" })).toBeDefined();
  await app.user.click(panel.getByRole("tab", { name: "Esperando você" }));
  const decision = within(await panel.findByRole("article", { name: "Decisão" }));
  expect(decision.getByRole("button", { name: "Escolher Northpaper" })).toBeDefined();
  expect(decision.getByText("Recomendada")).toBeDefined();
});
