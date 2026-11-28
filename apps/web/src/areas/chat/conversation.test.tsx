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

  test("says when it asks another agent, and points to itself above the composer", async () => {
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
    });
    expect(within(run).queryByText("Asking Ledger…") === null).toBe(true);
    expect(screen.getByText("Scout is at work here")).toBeDefined();
    expect(screen.getByRole("button", { name: "Show the run" })).toBeDefined();
  });
});

describe("a direct message with an agent", () => {
  test("says what the agent does, who looks after it and what it runs on", async () => {
    await open("/dm/agent/agt_scout");
    const facts = await screen.findByRole("list", { name: "About this agent" });
    expect(within(facts).getByText("Looked after by Ana Beatriz Souza")).toBeDefined();
    // An agent on the API is told by its model; the kind's label adds nothing there.
    expect(within(facts).getByText(/^Uses /)).toBeDefined();
    expect(within(facts).queryByText(/Model/) === null).toBe(true);
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

describe("regaining a channel after the server ended its subscription", () => {
  const subscribed = (server: FakeServer, userId: string, channelId: string) =>
    server.openSockets().some((socket) => socket.userId === userId && socket.channels.includes(channelId));
  const board = (server: FakeServer) => server.state.channels.find((channel) => channel.id === "ch_board");

  for (const withRun of [true, false])
    test(`it is followed again when the person is added back${withRun ? ", even with a run that was live" : ""}`, async () => {
      const server = newServer();
      addBoard(server);
      if (withRun)
        server.chat.startRun({
          workspaceId: WS,
          runId: "run_b",
          agentId: "agt_scout",
          channelId: "ch_board",
          initiatedBy: "usr_ana",
        });
      const app = await open("/channel/ch_board", "usr_iris", server);
      expect(await screen.findByText("Raise it 4% secret")).toBeDefined();
      if (withRun) {
        await screen.findByRole("region", { name: "Scout at work" });
        await act(async () => {
          server.emit(
            WS,
            {
              type: "run.text_delta",
              runId: "run_b",
              agentId: "agt_scout",
              channelId: "ch_board",
              threadId: null,
              seq: 0,
              text: "board secret alpha",
            },
            "ch_board",
          );
        });
      }
      await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_general` }));
      await screen.findByRole("heading", { name: /general/ });
      const room = board(server);
      if (room !== undefined) room.memberIds = ["usr_ana"];
      await act(async () => server.dropFromChannel("usr_iris", "ch_board"));
      // Held for its run, the channel hears the end of its subscription: nothing of it stays in memory.
      if (withRun) expect(cached(app, "ch_board")).toBe(0);
      if (room !== undefined) room.memberIds = ["usr_ana", "usr_iris"];
      await act(async () => {
        await app.runtime.queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[2] === "listChannels",
        });
      });
      await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_board` }));
      expect(await screen.findByText("Raise it 4% secret")).toBeDefined();
      await waitFor(() => expect(subscribed(server, "usr_iris", "ch_board")).toBe(true));
      expect(screen.queryByText("board secret alpha") === null).toBe(true);
    });
});

describe("what the second round of review found", () => {
  test("an agent the author called that isn't in the channel says so, in the author's words, never the code", async () => {
    const server = newServer();
    await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("textbox", { name: "Write in #general" });
    // As the server sends it: to the author alone, with no run, a code and a sentence.
    const notice = (reason: string, messageId: string) => ({
      type: "run.agent_unavailable",
      agentId: "agt_scout",
      channelId: "ch_general",
      threadId: null,
      messageId,
      reason,
      text: "Scout isn't in this conversation.",
    });
    await act(async () => server.emit(WS, notice("not_in_channel", "msg_1")));
    expect(
      await screen.findByText("Scout isn't in this conversation. Add it to the channel to bring it in."),
    ).toBeDefined();
    expect(screen.queryByText(/not_in_channel/) === null).toBe(true);
    // A code the web doesn't know yet shows the server's sentence.
    await act(async () => server.emit(WS, notice("something_new", "msg_2")));
    expect(await screen.findByText("Scout isn't in this conversation.")).toBeDefined();
    await act(async () => screen.getAllByRole("button", { name: "Dismiss" })[0]?.click());
    expect(
      screen.queryByText("Scout isn't in this conversation. Add it to the channel to bring it in.") === null,
    ).toBe(true);
  });

  test("receipts on older pages follow the events (the reply count is drawn with threads)", async () => {
    const server = newServer();
    for (let i = 1; i <= 120; i += 1)
      server.state.messages.push(message({ id: `msg_${i}`, body: `line ${i}`, createdAt: at(-200 + i) }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByText("line 120");
    await app.user.click(screen.getByRole("button", { name: "Show earlier messages" }));
    await screen.findByText("line 3");
    await act(async () => {
      server.emit(
        WS,
        { type: "thread.info_changed", threadId: "msg_3", channelId: "ch_general", replyCount: 2 },
        "ch_general",
      );
      server.emit(WS, { type: "message.claimed", messageId: "msg_4", agentId: "agt_scout" }, "ch_general");
      server.emit(
        WS,
        {
          type: "message.handled",
          messageId: "msg_5",
          agentId: "agt_ledger",
          runId: "run_x",
          status: "answered",
        },
        "ch_general",
      );
    });
    expect(await screen.findByText("Scout picked this up")).toBeDefined();
    expect(screen.getByText("Ledger answered")).toBeDefined();
  });

  test("a quick reaction that fails says so", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_hi", body: "Proofs at noon" }));
    server.force("createMessageReaction", { kind: "error", status: 500, code: "internal" }, 8);
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    await app.user.click(within(item).getByRole("button", { name: "Add a reaction" }));
    await app.user.click(await screen.findByRole("menuitem", { name: "React with 🎉" }));
    expect(await screen.findByText(/^The reaction didn't save:/)).toBeDefined();
  });

  test("a message's actions are in the tab order", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_hi", body: "Proofs at noon" }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    const react = within(item).getByRole("button", { name: "Add a reaction" });
    for (let i = 0; i < 60 && document.activeElement !== react; i += 1) await app.user.tab();
    expect(document.activeElement === react).toBe(true);
  });

  test("a channel followed for a run lets go after a reconnect when that run ended meanwhile", async () => {
    const server = newServer();
    server.chat.startRun({
      workspaceId: WS,
      runId: "run_gone",
      agentId: "agt_scout",
      channelId: "ch_general",
      initiatedBy: "usr_ana",
    });
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("region", { name: "Scout at work" });
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_print` }));
    await screen.findByRole("heading", { name: /print-queue/ });
    const follows = () => server.openSockets().some((socket) => socket.channels.includes("ch_general"));
    expect(follows()).toBe(true);
    // The connection drops, and the run ends while it is down: its end is never heard.
    await act(async () => server.dropConnections());
    server.chat.endRun("run_gone");
    await app.advance(60_000);
    await waitFor(() => expect(server.openSockets().length).toBeGreaterThan(0));
    await waitFor(() => expect(follows()).toBe(false));
  });
});

describe("a receipt for an agent that was held back", () => {
  const held = (author: string, blocked: { agentId: string; reason: string }[]) =>
    message({
      id: "msg_held",
      body: "@scout check this",
      author: { type: "person", id: author },
      receipts: { claimedBy: [], handled: [], viewedBy: [], blocked },
    });

  test("reads in the person's words, never the reason's code", async () => {
    const server = newServer();
    server.state.messages.push(
      held("usr_ana", [
        { agentId: "agt_scout", reason: "not_in_channel" },
        { agentId: "agt_ledger", reason: "something_new" },
      ]),
    );
    await open("/channel/ch_general", "usr_ana", server);
    expect(
      await screen.findByText("Scout isn't in this conversation. Add it to the channel to bring it in."),
    ).toBeDefined();
    expect(screen.getByText("Ledger was held back")).toBeDefined();
    expect(screen.queryByText(/not_in_channel|something_new/) === null).toBe(true);
  });

  test("names the author for anyone else, instead of saying you", async () => {
    const server = newServer();
    server.state.messages.push(held("usr_jonas", [{ agentId: "agt_scout", reason: "audience" }]));
    await open("/channel/ch_general", "usr_tomas", server);
    expect(await screen.findByText("Scout doesn't take requests from Jonas Lind here.")).toBeDefined();
    expect(screen.queryByText("Scout doesn't take requests from you here.") === null).toBe(true);
  });

  test("tells the author themselves with you", async () => {
    const server = newServer();
    server.state.messages.push(held("usr_ana", [{ agentId: "agt_scout", reason: "audience" }]));
    await open("/channel/ch_general", "usr_ana", server);
    expect(await screen.findByText("Scout doesn't take requests from you here.")).toBeDefined();
  });
});
