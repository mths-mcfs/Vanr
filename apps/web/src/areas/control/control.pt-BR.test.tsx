// The control center in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

const languages = ["pt-BR"];

test("the approvals page, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/approvals",
    signedInAs: "usr_ana",
    languages,
  });
  await screen.findByRole("heading", { level: 1, name: "Aprovações" });
  const post = await screen.findByRole("article", { name: "Postar em #print-queue" });
  expect(within(post).getByRole("img", { name: "Alcance: Age fora do espaço de trabalho" })).toBeDefined();
  expect(within(post).getByText("Scout pede")).toBeDefined();
  expect(within(post).getByText(/Postar em #print-queue\. O agente para de pedir/)).toBeDefined();
  expect(screen.getByText("1 espera uma decisão.")).toBeDefined();
  const mail = screen.getByRole("article", { name: "Email the October invoices" });
  expect(within(mail).getByText("Esperando Jonas Lind decidir.")).toBeDefined();

  await app.user.click(within(post).getByRole("checkbox", { name: /Permitir sempre por 30 dias/ }));
  await app.user.click(within(post).getByRole("button", { name: "Aprovar envio" }));
  expect(await within(post).findByText("Aprovada por Ana Beatriz Souza.")).toBeDefined();
  const receipt = await within(post).findByRole("region", { name: "O que o agente mudou" });
  expect(within(receipt).getByRole("timer").textContent).toBe("Sai em 30 segundos");
  await app.user.click(within(receipt).getByRole("button", { name: "Desfazer" }));
  expect(await within(receipt).findByText("Cancelado por Ana Beatriz Souza. Nada saiu.")).toBeDefined();
  const rules = screen.getByRole("list", { name: "Regras de sempre permitir" });
  expect(await within(rules).findByText("Postar em #print-queue")).toBeDefined();
  expect(document.title).toBe("Aprovações | Birchwood Labs | Vanr");
});

test("the proposals page, in Portuguese", async () => {
  await renderApp({ path: "/workspace/workspace_birchwood/proposals", signedInAs: "usr_ana", languages });
  await screen.findByRole("heading", { level: 1, name: "Propostas" });
  const tone = await screen.findByRole("article", { name: "Answer print questions with the shop's hours" });
  expect(within(tone).getByText("Scout propõe")).toBeDefined();
  expect(within(tone).getByText("Instruções de Scout")).toBeDefined();
  expect(within(tone).getByRole("button", { name: "Aceitar" })).toBeDefined();
  expect(screen.getByText("1 para decidir.")).toBeDefined();
  const stale = screen.getByRole("article", { name: "Mention the new address" });
  expect(within(stale).getByText("O contexto do espaço de trabalho")).toBeDefined();
});
