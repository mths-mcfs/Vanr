// A conversation that stays right while things change under it: losing a private channel while it is
// open, a run's light in the sidebar, older pages kept current, a run that survives leaving and coming
// back, a clock that stops once runs end, and what a run says while it consults or can't work.
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

function addBoard(server: FakeServer) {
  server.state.channels.push({
    id: "ch_board",
    workspaceId: WS,
    name: "board-room",
    topic: "Pricing for next year",
    isGeneral: false,
    visibility: "private",
    budgetPerMonthUsd: null,
    createdAt: at(-60),
    memberIds: ["usr_ana", "usr_iris"],
  });
  server.state.messages.push(
    message({ id: "msg_secret", channelId: "ch_board", body: "Raise it 4% secret" }),
  );
}

const open = (path: string, signedInAs = "usr_ana", server = newServer()) =>
  renderApp({ path: `/workspace/${WS}${path}`, server, signedInAs });

/** What of a channel is left in the cache. */
function cached(app: Awaited<ReturnType<typeof open>>, channelId: string) {
  return app.runtime.queryClient
    .getQueryCache()
    .findAll({
      predicate: (query) => {
        const args = query.queryKey[3];
        return (
          typeof args === "object" && args !== null && "channelId" in args && args.channelId === channelId
        );
      },
    })
    .filter((query) => query.state.data !== undefined).length;
}

describe("losing a private channel while it is open", () => {
  test("when its history answers 404, nothing of it stays on screen or in the cache", async () => {
    const server = newServer();
    addBoard(server);
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4% secret")).toBeDefined();
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    await act(async () => {
      await app.runtime.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "listChannelMessages",
      });
    });
    expect(await screen.findByText("There's no conversation here")).toBeDefined();
    expect(screen.queryByText("board-room") === null).toBe(true);
    expect(screen.queryByText("Pricing for next year") === null).toBe(true);
    expect(screen.queryByText("Raise it 4% secret") === null).toBe(true);
    expect(cached(app, "ch_board")).toBe(0);
  });

  test("the server ending the subscription is enough: the channel goes from the screen", async () => {
    const server = newServer();
    addBoard(server);
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4% secret")).toBeDefined();
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    await act(async () => server.dropFromChannel("usr_iris", "ch_board"));
    expect(await screen.findByText("There's no conversation here")).toBeDefined();
    expect(screen.queryByText("Raise it 4% secret") === null).toBe(true);
    const sidebar = screen.getByRole("complementary");
    await waitFor(() => expect(within(sidebar).queryByText("board-room") === null).toBe(true));
    expect(cached(app, "ch_board")).toBe(0);
  });
});

describe("the sidebar's agents", () => {
  test("an agent is lit only for a run this person may see", async () => {
    const server = newServer();
    // Scout is busy, but in a run this person's list of active runs doesn't show.
    server.runs = [
      {
        agentId: "agt_scout",
        workspaceId: "workspace_nightshift",
        channelId: "ch_hidden",
        runId: "run_hidden",
        startedAt: at(-1),
        status: "running",
        threadId: null,
        what: "secret",
      },
    ];
    await open("/channel/ch_general", "usr_iris", server);
    const sidebar = await screen.findByRole("complementary");
    const link = await within(sidebar).findByRole("link", { name: "Scout" });
    expect(link.querySelector("[data-working]") === null).toBe(true);
  });
});

describe("older pages", () => {
  test("a reaction on a message from an older page shows without a reload", async () => {
    const server = newServer();
    for (let i = 1; i <= 120; i += 1)
      server.state.messages.push(message({ id: `msg_${i}`, body: `line ${i}`, createdAt: at(-200 + i) }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByText("line 120");
    await app.user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText("line 3");
    const reactions = [{ reaction: "🎉", count: 1, userIds: ["usr_jonas"], agentIds: [] }];
    await act(async () => {
      server.emit(WS, { type: "message.reactions_updated", messageId: "msg_3", reactions }, "ch_general");
    });
    expect(await screen.findByRole("button", { name: "🎉 from Jonas Lind" })).toBeDefined();
  });
});

describe("a live run", () => {
  const base = { runId: "run_away", agentId: "agt_scout", channelId: "ch_general", threadId: null };

  test("keeps its text and steps when the person leaves and comes back", async () => {
    const server = newServer();
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_away",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: "usr_ana",
    });
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("region", { name: "Scout at work" });
    await act(async () => {
      server.emit(WS, { type: "run.text_delta", ...base, seq: 0, text: "alpha " }, "ch_general");
      server.emit(
        WS,
        { type: "run.tool_call", ...base, toolUseId: "tu_a", tool: "search", detail: "kiln" },
        "ch_general",
      );
    });
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_print` }));
    await screen.findByRole("heading", { name: /print-queue/ });
    // Away from the channel, it is still followed while the run is live.
    expect(server.openSockets().some((socket) => socket.channels.includes("ch_general"))).toBe(true);
    await act(async () => {
      server.emit(WS, { type: "run.text_delta", ...base, seq: 1, text: "bravo" }, "ch_general");
    });
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_general` }));
    const run = await screen.findByRole("region", { name: "Scout at work" });
    expect(within(run).getByTestId("run-text").textContent).toBe("alpha bravo");
    expect(within(run).getByRole("button", { name: /search/ })).toBeDefined();
    await act(async () => {
      server.emit(WS, { type: "run.stopped", ...base }, "ch_general");
    });
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_print` }));
    await screen.findByRole("heading", { name: /print-queue/ });
    // Once its runs ended, the channel is let go.
    await waitFor(() =>
      expect(server.openSockets().some((socket) => socket.channels.includes("ch_general"))).toBe(false),
    );
  });

  test("the clock stops ticking once runs ended and landed", async () => {
    const server = newServer();
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_away",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: "usr_ana",
    });
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("region", { name: "Scout at work" });
    expect(app.clock.pending()).toContain(1000);
    server.chat.endRun("run_away");
    await act(async () => {
      server.emit(WS, { type: "run.completed", ...base, messageId: "msg_never" }, "ch_general");
    });
    // The list read again after the end has landed before time moves on.
    const lists = () => server.calls.filter((call) => call.method === "listChannelActiveRuns").length;
    await waitFor(() => expect(lists()).toBe(2));
    await act(async () => {});
    await app.advance(11_000);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Scout at work" }) === null).toBe(true));
    await app.advance(1000);
    expect(app.clock.pending()).not.toContain(1000);
  });

  test("says when it asks another agent, and when the agent can't work", async () => {
    const server = newServer();
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_away",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: "usr_ana",
    });
    await open("/channel/ch_general", "usr_ana", server);
    const run = await screen.findByRole("region", { name: "Scout at work" });
    await act(async () => {
      server.emit(WS, {
        type: "delegation.started",
        agentId: "agt_scout",
        delegateAgentId: "agt_ledger",
        runId: "run_away",
      });
    });
    expect(within(run).getByText("Asking Ledger…")).toBeDefined();
    await act(async () => {
      server.emit(WS, {
        type: "delegation.completed",
        agentId: "agt_scout",
        delegateAgentId: "agt_ledger",
        runId: "run_away",
      });
      server.emit(
        WS,
        { type: "run.agent_unavailable", ...base, reason: "its runner is offline" },
        "ch_general",
      );
    });
    expect(within(run).queryByText("Asking Ledger…") === null).toBe(true);
    expect(within(run).getByText("Scout can't work right now: its runner is offline")).toBeDefined();
    expect(screen.getByText("Scout is at work here")).toBeDefined();
    expect(screen.getByRole("button", { name: "Show the run" })).toBeDefined();
  });
});

describe("a direct message with an agent", () => {
  test("says what the agent does, who looks after it and what it runs on", async () => {
    await open("/dm/agent/agt_scout");
    const facts = await screen.findByRole("list", { name: "About this agent" });
    expect(within(facts).getByText("Looked after by Ana Beatriz Souza")).toBeDefined();
    expect(within(facts).getByText(/^Runs on /)).toBeDefined();
  });
});

describe("what CodeRabbit found on the second head", () => {
  const base = { runId: "run_late", agentId: "agt_scout", channelId: "ch_general", threadId: null };

  test("a late event of a run that stopped does not bring it back", async () => {
    const server = newServer();
    await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("textbox", { name: "Write in #general" });
    await act(async () => {
      server.emit(WS, { type: "run.status_changed", ...base, status: "running" }, "ch_general");
    });
    expect(await screen.findByRole("region", { name: "Scout at work" })).toBeDefined();
    await act(async () => {
      server.emit(WS, { type: "run.stopped", ...base }, "ch_general");
      server.emit(WS, { type: "run.text_delta", ...base, seq: 0, text: "late words" }, "ch_general");
    });
    expect(screen.queryByRole("region", { name: "Scout at work" }) === null).toBe(true);
    expect(screen.queryByText("late words") === null).toBe(true);
  });

  test("the same empty list read again still ends a run heard of in between", async () => {
    const server = newServer();
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("textbox", { name: "Write in #general" });
    const lists = () => server.calls.filter((call) => call.method === "listChannelActiveRuns").length;
    await waitFor(() => expect(lists()).toBe(1));
    await act(async () => {
      server.emit(WS, { type: "run.status_changed", ...base, status: "running" }, "ch_general");
    });
    expect(await screen.findByRole("region", { name: "Scout at work" })).toBeDefined();
    await app.advance(1000);
    const before = lists();
    // A reconnect reads the list again; the run ended while the connection was down.
    await act(async () => {
      await app.runtime.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "listChannelActiveRuns",
      });
    });
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Scout at work" }) === null).toBe(true));
  });

  test("an idle conversation left open past midnight moves today to yesterday", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_noon", body: "Proofs at noon", createdAt: at(-1) }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    expect(await screen.findByRole("heading", { name: "Today" })).toBeDefined();
    const midnight = new Date(TEST_NOW);
    midnight.setHours(24, 0, 0, 0);
    await app.advance(midnight.getTime() - TEST_NOW.getTime() + 1000);
    expect(await screen.findByRole("heading", { name: "Yesterday" })).toBeDefined();
  });
});
