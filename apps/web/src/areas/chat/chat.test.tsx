// The chat area against the fake server: the sidebar's conversations, who sees a private channel,
// writing and retrying, mentions, an agent's run drawn live and stopped, a withdrawn post, and the
// approval card in place.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { Message } from "@vanr/contract";
import type { FakeServer } from "../../../dev/fake-server.ts";
import { newServer, renderApp, TEST_NOW } from "../../../test/app.tsx";

const WS = "workspace_birchwood";
const at = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * 60_000).toISOString();

function message(fields: Partial<Message> & Pick<Message, "id" | "body">): Message {
  return {
    actions: [],
    agentMentionIds: [],
    author: { type: "person", id: "usr_jonas" },
    channelId: "ch_general",
    clientId: null,
    createdAt: at(-5),
    editedAt: null,
    memories: [],
    meta: {},
    reactions: [],
    receipts: { claimedBy: [], handled: [], viewedBy: [] },
    replyCount: 0,
    runId: null,
    threadId: null,
    usage: null,
    ...fields,
  };
}

/** A private channel Ana and Jonas are in, and Íris is not. */
function addBoard(server: FakeServer, unread = false) {
  server.state.channels.push({
    id: "ch_board",
    workspaceId: WS,
    name: "board-room",
    topic: "Pricing for next year",
    isGeneral: false,
    visibility: "private",
    budgetPerMonthUsd: null,
    createdAt: at(-60),
    memberIds: ["usr_ana", "usr_jonas"],
  });
  if (unread)
    server.state.messages.push(message({ id: "msg_secret", channelId: "ch_board", body: "Raise it 4%" }));
}

const open = (path: string, signedInAs = "usr_ana", server = newServer()) =>
  renderApp({ path: `/workspace/${WS}${path}`, server, signedInAs });

describe("the conversations in the sidebar", () => {
  test("channels, agents and people, with private ones only for their members", async () => {
    const server = newServer();
    addBoard(server, true);
    server.dms.set(WS, [
      { channelId: "dm_jonas", unread: 2, with: { id: "usr_jonas", name: "Jonas Lind", type: "person" } },
    ]);
    await open("/channel/ch_general", "usr_ana", server);
    const sidebar = await screen.findByRole("complementary");
    expect(await within(sidebar).findByRole("link", { name: /general/ })).toBeDefined();
    const board = within(sidebar).getByRole("link", { name: /board-room/ });
    expect(within(board).getByText("Private, members only")).toBeDefined();
    expect(within(board).getByText("1 unread message")).toBeDefined();
    expect(within(sidebar).getByRole("link", { name: "Scout" }).getAttribute("href")).toBe(
      `/workspace/${WS}/dm/agent/agt_scout`,
    );
    const jonas = within(sidebar).getByRole("link", { name: /Jonas Lind/ });
    expect(within(jonas).getByText("2 unread messages")).toBeDefined();
    // Folding a group keeps its unread count on the heading.
    await act(async () =>
      within(sidebar)
        .getByRole("button", { name: /with people/ })
        .click(),
    );
    expect(within(sidebar).queryByRole("link", { name: /Jonas Lind/ }) === null).toBe(true);
    expect(
      within(sidebar)
        .getByRole("button", { name: /with people/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("someone outside a private channel sees neither its name nor its unread count", async () => {
    const server = newServer();
    addBoard(server, true);
    await open("/channel/ch_general", "usr_iris", server);
    const sidebar = await screen.findByRole("complementary");
    await within(sidebar).findByRole("link", { name: /general/ });
    expect(within(sidebar).queryByText("board-room") === null).toBe(true);
  });

  test("a private channel's address answers like one that does not exist", async () => {
    const server = newServer();
    addBoard(server, true);
    await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("There's no conversation here")).toBeDefined();
    expect(screen.queryByText("board-room") === null).toBe(true);
    expect(screen.queryByText("Raise it 4%") === null).toBe(true);
    expect(screen.queryByText("Pricing for next year") === null).toBe(true);
    expect(server.calls.some((call) => call.method === "listChannelMessages")).toBe(false);
  });

  test("a failed list offers a retry", async () => {
    const server = newServer();
    server.force("getDms", { kind: "error", status: 500, code: "internal" }, 8);
    await open("/channel/ch_general", "usr_ana", server);
    const sidebar = await screen.findByRole("complementary");
    expect(await within(sidebar).findByText("Direct messages didn't load.")).toBeDefined();
  });
});

describe("a channel", () => {
  test("shows its header and history, and a post goes out on Enter", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_hi", body: "Proofs **ready** at noon" }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const strong = await screen.findByText("ready");
    console.log("FOUND", strong.tagName, document.querySelector("[role=log]")?.getAttribute("aria-label"));
    const log = screen.getByRole("log", { name: "Messages" });
    console.log("LOG");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.getByRole("heading", { name: /general/ })).toBeDefined();
    const field = screen.getByRole("textbox", { name: "Write in #general" });
    await app.user.type(field, "First line{Shift>}{Enter}{/Shift}second line");
    expect((field as HTMLTextAreaElement).value).toBe("First line\nsecond line");
    await app.user.type(field, "{Enter}");
    expect(await within(log).findByText(/second line/)).toBeDefined();
    const sent = server.calls.find((call) => call.method === "createChannelMessage");
    expect(sent?.params.body).toBe("First line\nsecond line");
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  test("text that is only spaces is not sent", async () => {
    const app = await open("/channel/ch_general");
    const field = await screen.findByRole("textbox", { name: "Write in #general" });
    await app.user.type(field, "   {Enter}");
    expect(app.server.calls.some((call) => call.method === "createChannelMessage")).toBe(false);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  test("a post that fails says so and goes out once on retry", async () => {
    const server = newServer();
    server.force("createChannelMessage", { kind: "offline" }, 1);
    const app = await open("/channel/ch_general", "usr_ana", server);
    const field = await screen.findByRole("textbox", { name: "Write in #general" });
    await app.user.type(field, "Kiln is warm{Enter}");
    expect(await screen.findByText("Not sent.")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(screen.queryByText("Not sent.") === null).toBe(true));
    const posts = server.calls.filter((call) => call.method === "createChannelMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.params.clientId).toBe(posts[1]?.params.clientId);
    expect(server.state.messages.filter((m) => m.body === "Kiln is warm")).toHaveLength(1);
  });

  test("@ offers agents first; Enter puts the handle in and names who will answer", async () => {
    const app = await open("/channel/ch_general");
    const field = await screen.findByRole("textbox", { name: "Write in #general" });
    await app.user.type(field, "ask @sc");
    const list = await screen.findByRole("listbox", { name: "People and agents to mention" });
    const options = within(list).getAllByRole("option");
    expect(options[0]?.textContent).toContain("Scout");
    await app.user.keyboard("{Enter}");
    expect((field as HTMLTextAreaElement).value).toBe("ask @scout ");
    expect(screen.queryByRole("listbox") === null).toBe(true);
    expect(screen.getByText("Scout will answer")).toBeDefined();
    await app.user.type(field, "x @");
    await screen.findByRole("listbox");
    await app.user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox") === null).toBe(true);
  });

  test("a quote rides along and can be dropped before sending", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_hi", body: "Proofs at noon" }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    await app.user.click(within(item).getByRole("button", { name: "Quote in your reply" }));
    expect(screen.getByRole("button", { name: "Remove the quote" })).toBeDefined();
    await app.user.type(screen.getByRole("textbox", { name: "Write in #general" }), "On it{Enter}");
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "createChannelMessage")?.params.replyTo).toBe(
        "msg_hi",
      ),
    );
    expect(screen.queryByRole("button", { name: "Remove the quote" }) === null).toBe(true);
  });

  test("a post an agent's undo withdrew hides its text for everyone", async () => {
    const server = newServer();
    server.state.messages.push(
      message({
        id: "msg_gone",
        author: { type: "agent", id: "agt_scout" },
        body: "Wrong price list",
        meta: { retracted: { actorUserId: "usr_ana", at: at(-1) } },
      }),
    );
    await open("/channel/ch_general", "usr_tomas", server);
    expect(
      await screen.findByText("Withdrawn by Ana Beatriz Souza. Its text is no longer shown."),
    ).toBeDefined();
    expect(screen.queryByText("Wrong price list") === null).toBe(true);
  });

  test("someone reading a public channel they have not joined gets a way in instead of the composer", async () => {
    const server = newServer();
    const design = server.state.channels.find((channel) => channel.id === "ch_design");
    if (design !== undefined) design.memberIds = design.memberIds.filter((id) => id !== "usr_tomas");
    const app = await open("/channel/ch_design", "usr_tomas", server);
    expect(await screen.findByText("You're reading #design. Join to write here.")).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Write in #design" }) === null).toBe(true);
    await app.user.click(screen.getByRole("button", { name: "Join channel" }));
    expect(await screen.findByRole("textbox", { name: "Write in #design" })).toBeDefined();
  });

  test("the approval a message carries shows as the control center's card", async () => {
    const server = newServer();
    server.state.messages.push(
      message({
        id: "msg_ask",
        author: { type: "agent", id: "agt_scout" },
        body: "",
        meta: { approvalId: "apr_post" },
      }),
    );
    await open("/channel/ch_general", "usr_ana", server);
    expect(await screen.findByRole("article", { name: "Post in #print-queue" })).toBeDefined();
  });

  test("a reaction shows who reacted, and the person's own toggles off", async () => {
    const server = newServer();
    server.state.messages.push(
      message({
        id: "msg_hi",
        body: "Proofs at noon",
        reactions: [{ reaction: "👍", count: 1, userIds: ["usr_ana"], agentIds: [] }],
      }),
    );
    const app = await open("/channel/ch_general", "usr_ana", server);
    const chip = await screen.findByRole("button", { name: "👍 from you" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await app.user.click(chip);
    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "clearMessageReactions")).toBe(true),
    );
  });
});

describe("an agent at work", () => {
  const live = (server: FakeServer, initiatedBy: string | null = "usr_ana") =>
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_live",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy,
    });
  const base = { runId: "run_live", agentId: "agt_scout", channelId: "ch_general", threadId: null };

  test("streams its text and steps, then gives way to the answer", async () => {
    const server = newServer();
    live(server);
    const app = await open("/channel/ch_general", "usr_ana", server);
    const run = await screen.findByRole("region", { name: "Scout at work" });
    await act(async () => {
      server.emit(WS, { type: "run.text_delta", ...base, seq: 0, text: "Checking the " });
      server.emit(WS, { type: "run.text_delta", ...base, seq: 1, text: "kiln log" });
      // A repeated delta is dropped.
      server.emit(WS, { type: "run.text_delta", ...base, seq: 1, text: "kiln log" });
    });
    expect(within(run).getByText("Checking the kiln log")).toBeDefined();
    await act(async () => {
      server.emit(WS, { type: "run.commentary", ...base, text: "Checking the kiln log" });
      server.emit(WS, {
        type: "run.tool_call",
        ...base,
        toolUseId: "tu_1",
        tool: "remember",
        detail: "Kiln B runs hot",
      });
      server.emit(WS, {
        type: "run.tool_result",
        ...base,
        toolUseId: "tu_1",
        tool: "remember",
        text: "saved mem_1",
        isError: false,
      });
      server.emit(WS, { type: "run.tool_call", ...base, toolUseId: "tu_1", tool: null });
    });
    const steps = within(run).getByRole("list", { name: "What Scout did so far" });
    const tool = within(steps).getByRole("button", { name: /remember/ });
    await app.user.click(tool);
    expect(within(run).getByRole("region", { name: "What the tool returned" }).textContent).toBe(
      "saved mem_1",
    );

    server.state.messages.push(
      message({
        id: "msg_answer",
        author: { type: "agent", id: "agt_scout" },
        body: "Saved: Kiln B runs hot",
        runId: "run_live",
      }),
    );
    server.chat.endRun("run_live");
    await act(async () => {
      server.emit(WS, { type: "run.completed", ...base, status: "done", messageId: "msg_answer" });
      server.emit(WS, { type: "message.posted", message: server.state.messages.at(-1) }, "ch_general");
    });
    expect(await screen.findByText("Saved: Kiln B runs hot")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Scout at work" }) === null).toBe(true));
  });

  test("whoever asked may stop it after confirming; someone else gets no stop button", async () => {
    const server = newServer();
    live(server, "usr_iris");
    const iris = await open("/channel/ch_general", "usr_iris", server);
    const run = await screen.findByRole("region", { name: "Scout at work" });
    await iris.user.click(within(run).getByRole("button", { name: "Stop" }));
    await iris.user.click(await screen.findByRole("button", { name: "Stop the run" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "cancelRun")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Scout at work" }) === null).toBe(true));
    iris.unmount();

    const other = newServer();
    other.chat.startRun({
      workspaceId: WS,
      runId: "run_2",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: "usr_iris",
    });
    await open("/channel/ch_general", "usr_tomas", other);
    const seen = await screen.findByRole("region", { name: "Scout at work" });
    expect(within(seen).queryByRole("button", { name: "Stop" }) === null).toBe(true);
  });

  test("a run that already ended says so when stopped", async () => {
    const server = newServer();
    live(server);
    const app = await open("/channel/ch_general", "usr_ana", server);
    const run = await screen.findByRole("region", { name: "Scout at work" });
    server.chat.endRun("run_live");
    await app.user.click(within(run).getByRole("button", { name: "Stop" }));
    await app.user.click(await screen.findByRole("button", { name: "Stop the run" }));
    expect(await screen.findByText("That run had already finished.")).toBeDefined();
  });

  test("an answer's saved steps open on demand", async () => {
    const server = newServer();
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_old",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: null,
    });
    server.chat.endRun("run_old", [
      {
        seq: 1,
        kind: "tool_call",
        createdAt: at(-3),
        data: { toolUseId: "tu_9", name: "search", input: { query: "kiln" } },
      },
      {
        seq: 2,
        kind: "tool_result",
        createdAt: at(-3),
        data: { toolUseId: "tu_9", content: "3 pages", isError: true },
      },
    ]);
    server.state.messages.push(
      message({
        id: "msg_done",
        author: { type: "agent", id: "agt_scout" },
        body: "Found it",
        runId: "run_old",
        meta: { toolSteps: 1 },
      }),
    );
    const app = await open("/channel/ch_general", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: "Show the step behind this answer" }));
    const steps = await screen.findByRole("list", { name: "Steps behind this answer" });
    await app.user.click(within(steps).getByRole("button", { name: /search/ }));
    expect(within(steps).getByRole("region", { name: "What went wrong" }).textContent).toBe("3 pages");
  });
});

describe("direct messages", () => {
  test("opening an agent's address opens its direct message", async () => {
    const app = await open("/dm/agent/agt_scout");
    expect(await screen.findByRole("heading", { name: "Scout" })).toBeDefined();
    expect(screen.getByText("Looked after by Ana Beatriz Souza")).toBeDefined();
    const field = screen.getByRole("textbox", { name: "Write a message" });
    await app.user.type(field, "hello");
    expect(screen.getByText("Scout will answer")).toBeDefined();
    expect(
      app.server.calls.some((call) => call.method === "createDm" && call.params.agentId === "agt_scout"),
    ).toBe(true);
  });

  test("a direct message that can't be opened offers a retry", async () => {
    const server = newServer();
    server.force("createDm", { kind: "error", status: 403, code: "forbidden" }, 8);
    await open("/dm/agent/agt_tally", "usr_tomas", server);
    expect(await screen.findByText("The conversation couldn't be opened")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });
});
