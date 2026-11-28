// The chat area in Portuguese: the sidebar's groups and counts, the composer, and an agent at work.
import { describe, expect, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../test/app.tsx";

const WS = "workspace_birchwood";

describe("conversa em português", () => {
  test("a barra lateral, o compositor e um agente trabalhando", async () => {
    const server = newServer();
    server.dms.set(WS, [
      { channelId: "dm_jonas", unread: 3, with: { id: "usr_jonas", name: "Jonas Lind", type: "person" } },
    ]);
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_pt",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: "usr_ana",
    });
    const app = await renderApp({
      path: `/workspace/${WS}/channel/ch_general`,
      server,
      signedInAs: "usr_ana",
      languages: ["pt-BR"],
    });
    const sidebar = await screen.findByRole("complementary");
    expect(await within(sidebar).findByRole("button", { name: /Canais/ })).toBeDefined();
    expect(within(sidebar).getByRole("button", { name: /Agentes/ })).toBeDefined();
    expect(within(sidebar).getByText("3 mensagens não lidas")).toBeDefined();

    const run = await screen.findByRole("region", { name: "Scout trabalhando" });
    expect(within(run).getByText("Trabalhando")).toBeDefined();
    await act(async () => {
      server.emit(WS, {
        type: "run.text_delta",
        runId: "run_pt",
        agentId: "agt_scout",
        channelId: "ch_general",
        seq: 0,
        text: "Olhando o forno",
      });
    });
    expect(within(run).getByText("Olhando o forno")).toBeDefined();
    expect(within(run).getByRole("button", { name: "Parar" })).toBeDefined();

    const field = screen.getByRole("textbox", { name: "Escreva em #general" });
    await app.user.type(field, "@scout oi");
    expect(screen.getByText("Scout vai responder")).toBeDefined();
    expect(screen.getByRole("toolbar", { name: "Formatação" })).toBeDefined();
  });

  test("um canal privado que não é seu aparece como inexistente", async () => {
    const server = newServer();
    server.state.channels.push({
      id: "ch_board",
      workspaceId: WS,
      name: "board-room",
      topic: "",
      isGeneral: false,
      visibility: "private",
      budgetPerMonthUsd: null,
      createdAt: "2026-11-14T10:00:00.000Z",
      memberIds: ["usr_ana"],
    });
    await renderApp({
      path: `/workspace/${WS}/channel/ch_board`,
      server,
      signedInAs: "usr_iris",
      languages: ["pt-BR"],
    });
    expect(await screen.findByText("Não há conversa aqui")).toBeDefined();
    expect(screen.queryByText("board-room") === null).toBe(true);
  });
});
