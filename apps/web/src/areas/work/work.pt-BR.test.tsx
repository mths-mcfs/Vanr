// The issues in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";
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
