// The control center in Portuguese. Assertions on Portuguese text live in a `*.pt-BR.test.tsx` file.
import { expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../test/app.tsx";

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
  await app.user.click(within(post).getByRole("button", { name: "Pode enviar" }));
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

test("the connectors section, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/settings/connectors?connector_error=access_denied",
    signedInAs: "usr_jonas",
    languages,
  });
  expect(await screen.findByText("O acesso foi recusado no serviço.")).toBeDefined();
  const services = await screen.findByRole("list", { name: "Serviços" });
  const stripe = within(services)
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes("Stripe"));
  if (stripe === undefined) throw new Error("no Stripe row");
  await app.user.click(within(stripe).getByRole("button", { name: "Conectar" }));
  const dialog = await screen.findByRole("dialog", { name: "Conectar Stripe" });
  await app.user.type(within(dialog).getByLabelText("Chave"), "sk_1");
  expect(within(dialog).getByText("Uma chave tem no mínimo 8 caracteres.")).toBeDefined();
  await app.user.type(within(dialog).getByLabelText("Chave"), "23456789");
  await app.user.click(within(dialog).getByRole("button", { name: "Conectar com esta chave" }));
  expect(await screen.findByText("Stripe está conectado.")).toBeDefined();
  const mcp = screen.getByRole("region", { name: "Seus servidores MCP" });
  expect(within(mcp).getByText("Nenhum servidor MCP ainda")).toBeDefined();
  const github = screen.getByRole("region", { name: "GitHub" });
  expect(await within(github).findByText("Nenhuma conta do GitHub vinculada")).toBeDefined();
});

test("the data sources section, in Portuguese", async () => {
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/settings/data-sources?mail_error=denied",
    signedInAs: "usr_jonas",
    languages,
  });
  expect(await screen.findByText("O provedor não liberou o acesso à caixa.")).toBeDefined();
  const boxes = await screen.findByRole("region", { name: "Caixas de e-mail" });
  expect(await within(boxes).findByText("Nenhuma caixa de e-mail ainda")).toBeDefined();
  const databases = screen.getByRole("region", { name: "Bancos de dados" });
  await app.user.click(within(databases).getByRole("button", { name: "Conectar banco" }));
  const form = await screen.findByRole("form", { name: "Conectar banco de dados" });
  expect(within(form).getByRole("combobox", { name: "Criptografia" }).textContent).toBe("Criptografado");
  await app.user.click(within(form).getByRole("radio", { name: /Campos separados/ }));
  const port = within(form).getByLabelText(/^Porta/);
  await app.user.clear(port);
  await app.user.type(port, "70000");
  expect(within(form).getByText("Uma porta é um número inteiro de 1 a 65535.")).toBeDefined();
  await app.user.clear(port);
  await app.user.type(port, "5432");
  await app.user.type(within(form).getByRole("textbox", { name: /^Host/ }), "db.birchwood.example");
  await app.user.type(within(form).getByLabelText(/^Banco$/), "loja");
  await app.user.type(within(form).getByLabelText(/^Usuário/), "leitor");
  await app.user.type(within(form).getByLabelText(/^Senha/), "senha-1");
  await app.user.click(within(form).getByRole("button", { name: "Conectar" }));
  expect(await screen.findByText("loja @ db.birchwood.example está conectado.")).toBeDefined();
  const row = within(await within(databases).findByRole("list", { name: "Bancos de dados" })).getByRole(
    "listitem",
  );
  expect(within(row).getByText("Supabase: leitor em db.birchwood.example, banco loja")).toBeDefined();
  expect(within(row).getByText("Nenhum agente")).toBeDefined();
});

test("the access matrix, in Portuguese", async () => {
  await renderApp({
    path: "/workspace/workspace_birchwood/settings/access",
    signedInAs: "usr_jonas",
    languages,
  });
  const grid = await screen.findByRole("table", { name: "Agentes e conexões" });
  expect(within(grid).getByRole("columnheader", { name: "Tudo" })).toBeDefined();
  const level = await within(grid).findByRole("combobox", { name: "O que Scout pode fazer em Team Linear" });
  expect(level.textContent).toBe("Nada");
  expect(within(grid).getByRole("switch", { name: "Tudo para Scout" })).toBeDefined();
});

test("the usage section, in Portuguese", async () => {
  const server = newServer();
  server.usage.push(
    { workspaceId: "workspace_birchwood", agentId: "agt_scout", kind: "model", calls: 1, costUsd: 12.5 },
    { workspaceId: "workspace_birchwood", agentId: null, kind: "embedding", calls: 4, costUsd: 0.5 },
  );
  const app = await renderApp({
    path: "/workspace/workspace_birchwood/settings/usage",
    signedInAs: "usr_jonas",
    server,
    languages,
  });
  const part = await screen.findByRole("region", { name: "Este mês" });
  expect(await within(part).findByText("de US$ 60,00")).toBeDefined();
  expect(within(part).getByText("Não conta no orçamento.", { exact: false })).toBeDefined();
  expect(within(part).getByText(/soma dos orçamentos mensais dos seus 3 agentes ativos/)).toBeDefined();
  const form = screen.getByRole("form", { name: "Orçamento padrão de agente" });
  const field = within(form).getByLabelText(/^Por agente, por mês/);
  await app.user.clear(field);
  await app.user.type(field, "12.50");
  expect(within(form).getByText("Um valor de 0 a US$ 100.000,00, como 12,50.")).toBeDefined();
  await app.user.clear(field);
  await app.user.type(field, "12,50");
  await app.user.click(within(form).getByRole("button", { name: "Salvar padrão" }));
  expect(
    await screen.findByText("Agentes sem orçamento próprio agora recebem US$ 12,50 por mês."),
  ).toBeDefined();
});
