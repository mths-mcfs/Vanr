// Channels in Portuguese: making one and its people.
import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { renderApp } from "../../../test/app.tsx";

describe("canais em português", () => {
  test("criar um canal e ver quem está nele", async () => {
    const app = await renderApp({
      path: "/workspace/workspace_birchwood/channel/ch_general",
      signedInAs: "usr_ana",
      languages: ["pt-BR"],
    });
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Criar um canal" }));
    const dialog = await screen.findByRole("dialog", { name: "Criar um canal" });
    await app.user.type(within(dialog).getByRole("textbox", { name: "Nome" }), "Sala do Forno");
    expect(within(dialog).getByText("Vai ficar #sala-do-forno")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await app.user.click(await screen.findByRole("button", { name: /^\d+ no canal$/ }));
    expect(await screen.findByRole("dialog", { name: "Pessoas em #general" })).toBeDefined();
  });
});
