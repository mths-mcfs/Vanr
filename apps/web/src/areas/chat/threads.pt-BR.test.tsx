// Threads in Portuguese: the panel beside the channel and the list.
import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { newServer, renderApp } from "../../../test/app.tsx";

const WS = "workspace_birchwood";

describe("threads em português", () => {
  test("o painel e a lista", async () => {
    const server = newServer();
    server.state.messages.push({
      id: "msg_root",
      actions: [],
      agentMentionIds: [],
      author: { type: "person", id: "usr_jonas" },
      body: "Qual papel para os cartões?",
      channelId: "ch_general",
      clientId: null,
      createdAt: "2026-11-14T11:00:00.000Z",
      editedAt: null,
      memories: [],
      meta: {},
      reactions: [],
      receipts: { claimedBy: [], handled: [], viewedBy: [] },
      replyCount: 0,
      runId: null,
      threadId: null,
      usage: null,
    });
    server.chat.thread("msg_root", "usr_jonas", { title: "Papel dos cartões" });
    const options = { server, signedInAs: "usr_ana", languages: ["pt-BR"] } as const;
    const app = await renderApp({ path: `/workspace/${WS}/channel/ch_general?thread=msg_root`, ...options });
    const panel = await screen.findByRole("region", { name: "Thread" });
    expect(await within(panel).findByText("Ainda sem respostas.")).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Acompanhar" })).toBeDefined();
    expect(within(panel).getByRole("textbox", { name: "Responda na thread" })).toBeDefined();
    app.unmount();

    await renderApp({ path: `/workspace/${WS}/threads`, ...options });
    expect(await screen.findByRole("tab", { name: "Com agente trabalhando" })).toBeDefined();
    const list = await screen.findByRole("list", { name: "Threads" });
    expect(within(list).getByRole("link", { name: "Papel dos cartões" })).toBeDefined();
    expect(within(list).getByText("Ainda sem respostas.")).toBeDefined();
  });
});
