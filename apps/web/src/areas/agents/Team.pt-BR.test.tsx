// The same screen in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

test("the team, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/agents",
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  await screen.findByRole("heading", { level: 1, name: "Agentes" });
  expect(screen.getByText("3 agentes neste espaço de trabalho.")).toBeDefined();
  const rows = within(screen.getByRole("list", { name: "Agentes de Ana Beatriz Souza" })).getAllByRole(
    "listitem",
  );
  expect(rows.map((row) => row.textContent)).toEqual([
    "Scout@scoutEm atividade",
    "Ledger@ledgerEm atividade",
  ]);
  expect(screen.getByRole("list", { name: "Delegações de hoje" }).textContent).toContain(
    "Scout pediu a Ledger",
  );
  await app.user.click(screen.getByRole("button", { name: "Tally" }));
  const card = screen.getByRole("region", { name: "Tally" });
  expect(within(card).getByRole("link", { name: "Abrir perfil" })).toBeDefined();
  expect(within(card).getByRole("link", { name: "Conversar com Tally" })).toBeDefined();
  expect(document.title).toBe("Agentes | Birchwood Labs | Vanr");
});
