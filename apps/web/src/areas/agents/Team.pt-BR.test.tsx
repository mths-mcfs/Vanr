// The same screen in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

test("the agents of a workspace, in Portuguese", async () => {
  await renderApp({
    path: "/workspace/workspace_birchwood/agents",
    signedInAs: "usr_ana",
    languages: ["pt-BR"],
  });
  await screen.findByRole("heading", { level: 1, name: "Agentes" });
  expect(await screen.findByText("3 agentes neste espaço de trabalho.")).toBeDefined();
  const rows = within(screen.getByRole("list", { name: "Agentes" })).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Scout@scoutTrabalhando",
    "Ledger@ledgerTrabalhando",
    "Tally@tallyParado",
  ]);
  expect(document.title).toBe("Agentes | Birchwood Labs | Vanr");
});
