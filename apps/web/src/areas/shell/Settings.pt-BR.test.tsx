// The settings and the inbox in Portuguese: the same screens, read in the other language.
import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { chooseOption, renderApp } from "../../../test/app.tsx";

const languages = ["pt-BR"];

describe("em português", () => {
  test("um membro não vê Armazenamento, e o endereço diz por quê", async () => {
    await renderApp({
      path: "/workspace/workspace_birchwood/settings/storage",
      signedInAs: "usr_iris",
      languages,
    });
    expect(await screen.findByText("Esta seção é para admins")).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Seções" });
    expect(within(nav).queryByRole("link", { name: "Armazenamento" })).toBeNull();
  });

  test("um admin muda o papel de alguém", async () => {
    const app = await renderApp({
      path: "/workspace/workspace_birchwood/settings/members",
      signedInAs: "usr_jonas",
      languages,
    });
    expect(await screen.findByRole("heading", { level: 3, name: "4 membros" })).toBeDefined();
    await chooseOption(app, screen.getByRole("combobox", { name: "Papel de Tomás Eriksen" }), "Admin");
    expect(await screen.findByText("Tomás Eriksen agora é Admin.")).toBeDefined();
  });

  test("a caixa de entrada lê e adia um aviso", async () => {
    const app = await renderApp({
      path: "/workspace/workspace_birchwood/notifications",
      signedInAs: "usr_ana",
      languages,
    });
    expect(await screen.findByRole("region", { name: "Esperando você" })).toBeDefined();
    const mention = screen.getByRole("button", {
      name: /^Não lido:\s*Jonas Lind mencionou você em #print-queue$/,
    });
    await app.user.click(within(mention.closest("li") as HTMLElement).getByRole("button", { name: "Adiar" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "Por uma hora" }));
    expect(await screen.findByText(/^Adiado até /)).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("button", { name: /mencionou você/ })).toBeNull());
  });
});
