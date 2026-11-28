// The issues in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";

// The fixtures are in UTC: the screens read them in the same zone wherever the tests run.
process.env.TZ = "UTC";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../test/app.tsx";

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

test("os limites em dólares usam a vírgula decimal: o ponto é separador de milhar", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/routines",
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  await app.user.click(await screen.findByRole("button", { name: "Nova rotina" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Nova rotina" }));
  await app.user.click(dialog.getByText("Limites"));
  const cost = dialog.getByRole("textbox", { name: "O máximo que pode gastar por execução (USD)" });
  await app.user.clear(cost);
  await app.user.type(cost, "1.000");
  expect(
    dialog.getByText(/^Um valor de 0,01 a 100, escrito como 1,50, sem separador de milhar\.$/),
  ).toBeDefined();
  await app.user.clear(cost);
  await app.user.type(cost, "1.5");
  expect(dialog.getByText(/^Um valor de 0,01 a 100/)).toBeDefined();
  await app.user.clear(cost);
  await app.user.type(cost, "1,5");
  expect(dialog.queryByText(/^Um valor de 0,01 a 100/) === null).toBe(true);
});

test("o limite de gasto de uma atribuição usa a vírgula decimal", async () => {
  const server = newServer();
  const paper = server.assignments.assignments.find((each) => each.id === "asg_paper");
  if (paper !== undefined) paper.limits = { ...paper.limits, dollars: 2.5 };
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/assignments/asg_paper",
    server,
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  const panel = within(await screen.findByRole("region", { name: "Atribuição" }));
  await app.user.click(panel.getByRole("tab", { name: "Configurações" }));
  const dollars = await panel.findByRole("textbox", { name: "Limite de gasto (USD)" });
  // What is saved shows as Portuguese writes it.
  expect((dollars as HTMLInputElement).value).toBe("2,5");
  await app.user.clear(dollars);
  await app.user.type(dollars, "1.000");
  expect(panel.getByText(/^Um valor de 0 a .*, escrito como 1,50, sem separador de milhar\.$/)).toBeDefined();
  expect((panel.getByRole("button", { name: "Salvar limites" }) as HTMLButtonElement).disabled).toBe(true);
  await app.user.clear(dollars);
  await app.user.type(dollars, "1.5");
  expect((panel.getByRole("button", { name: "Salvar limites" }) as HTMLButtonElement).disabled).toBe(true);
  await app.user.clear(dollars);
  await app.user.type(dollars, "1,5");
  await app.user.click(panel.getByRole("button", { name: "Salvar limites" }));
  await waitFor(() =>
    expect(server.assignments.assignments.find((each) => each.id === "asg_paper")?.limits.dollars).toBe(1.5),
  );
});
