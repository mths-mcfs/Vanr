// Threads against the fake server: beside a channel and on their own page, following and managing
// them, the list with its tabs, filters and search, and correcting an agent's answer.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Message } from "@vanr/contract";
import type { FakeServer } from "../../../dev/fake-server.ts";
import { newServer, renderApp, TEST_NOW } from "../../../test/app.tsx";
import { SEARCH_WAIT_MS } from "./Threads.tsx";

const WS = "workspace_birchwood";
const at = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * 60_000).toISOString();

function message(fields: Partial<Message> & Pick<Message, "id" | "body">): Message {
  return {
    actions: [],
    agentMentionIds: [],
    author: { type: "person", id: "usr_jonas" },
    channelId: "ch_general",
    clientId: null,
    createdAt: at(-10),
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

/** A root by Jonas with one reply by Scout. */
function seedThread(server: FakeServer, record = true) {
  server.state.messages.push(
    message({ id: "msg_root", body: "Which paper for the Hartley cards?", replyCount: 1 }),
    message({
      id: "msg_reply",
      body: "Matte, like last time.",
      author: { type: "agent", id: "agt_scout" },
      threadId: "msg_root",
      createdAt: at(-8),
    }),
  );
  if (record) server.chat.thread("msg_root", "usr_jonas", { title: "Hartley paper" });
}

const open = (path: string, signedInAs = "usr_ana", server = newServer()) =>
  renderApp({ path: `/workspace/${WS}${path}`, server, signedInAs });

describe("a thread beside its channel", () => {
  test("opens from a message, shows the replies, and answers inside the thread", async () => {
    const server = newServer();
    seedThread(server);
    const app = await open("/channel/ch_general", "usr_ana", server);
    const root = await screen.findByRole("article", { name: /Jonas Lind/ });
    await app.user.click(within(root).getByRole("button", { name: "1 reply" }));
    const panel = await screen.findByRole("region", { name: "Thread" });
    expect(app.address()).toContain("thread=msg_root");
    expect(within(panel).getByRole("heading", { name: "Hartley paper" })).toBeDefined();
    expect(await within(panel).findByText("Matte, like last time.")).toBeDefined();
    const field = within(panel).getByRole("textbox", { name: "Reply in the thread" });
    // An agent that already spoke in the thread answers when nobody is mentioned.
    await app.user.type(field, "Thanks");
    expect(within(panel).getByText("Scout will answer")).toBeDefined();
    await app.user.type(field, "{Enter}");
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "createChannelMessage")?.params.threadId).toBe(
        "msg_root",
      ),
    );
    await app.user.click(within(panel).getByRole("button", { name: "Hide the thread" }));
    expect(screen.queryByRole("region", { name: "Thread" }) === null).toBe(true);
    expect(app.address()).not.toContain("thread=");
  });

  test("a message without a thread record still opens one, and following it makes the record", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_lone", body: "Kiln B is warm" }));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    await app.user.click(within(item).getByRole("button", { name: "Reply in a thread" }));
    const panel = await screen.findByRole("region", { name: "Thread" });
    expect(await within(panel).findByText("No replies yet.")).toBeDefined();
    const follow = within(panel).getByRole("button", { name: "Follow" });
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    await app.user.click(follow);
    expect(await within(panel).findByRole("button", { name: "Following" })).toBeDefined();
    expect(server.chat.threads.some((each) => each.id === "msg_lone")).toBe(true);
    expect(server.chat.followers.get("msg_lone")?.has("usr_ana")).toBe(true);
  });

  test("whoever manages the thread closes and reopens it; anyone else gets no such button", async () => {
    const server = newServer();
    seedThread(server);
    const app = await open("/channel/ch_general?thread=msg_root", "usr_jonas", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    await app.user.click(await within(panel).findByRole("button", { name: "Close the thread" }));
    expect(await within(panel).findByText("Closed")).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Reopen" })).toBeDefined();
    app.unmount();

    await open("/channel/ch_general?thread=msg_root", "usr_tomas", server);
    const seen = await screen.findByRole("region", { name: "Thread" });
    await within(seen).findByText("Matte, like last time.");
    expect(within(seen).queryByRole("button", { name: "Reopen" }) === null).toBe(true);
  });
});

describe("a thread on its own page", () => {
  test("has the way back to the list and into its channel", async () => {
    const server = newServer();
    seedThread(server);
    await open("/threads/msg_root", "usr_ana", server);
    expect(await screen.findByRole("link", { name: "All threads" })).toBeDefined();
    const inChannel = screen.getByRole("link", { name: "Open in #general" });
    expect(inChannel.getAttribute("href")).toBe(`/workspace/${WS}/channel/ch_general?thread=msg_root`);
    expect(await screen.findByText("Matte, like last time.")).toBeDefined();
  });

  test("a thread that isn't there, or isn't readable, answers the same", async () => {
    await open("/threads/msg_nope");
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
  });
});

describe("the list of threads", () => {
  test("lists threads with their signals, and searches after a pause", async () => {
    const server = newServer();
    seedThread(server);
    server.chat.thread("msg_other", "usr_ana", {
      title: "Kiln schedule",
      channelId: "ch_general",
      channelName: "general",
      working: true,
      actionNeeded: true,
    });
    const app = await open("/threads", "usr_ana", server);
    const list = await screen.findByRole("list", { name: "Threads" });
    expect(within(list).getByRole("link", { name: "Hartley paper" })).toBeDefined();
    expect(within(list).getByText("Agent at work")).toBeDefined();
    expect(within(list).getByText("Needs you")).toBeDefined();
    await app.user.type(screen.getByRole("searchbox", { name: "Search threads" }), "kiln");
    expect(within(list).getByRole("link", { name: "Hartley paper" })).toBeDefined();
    await app.advance(SEARCH_WAIT_MS);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Hartley paper" }) === null).toBe(true));
    expect(screen.getByRole("link", { name: "Kiln schedule" })).toBeDefined();
    expect(server.calls.some((call) => call.method === "listThreads" && call.params.q === "kiln")).toBe(true);
  });

  test("the filters go with the tab, and an empty result says so", async () => {
    const server = newServer();
    seedThread(server);
    const app = await open("/threads", "usr_ana", server);
    await screen.findByRole("list", { name: "Threads" });
    await app.user.click(screen.getByRole("checkbox", { name: "Mine" }));
    expect(await screen.findByText("No threads here")).toBeDefined();
    await app.user.click(screen.getByRole("tab", { name: "Assignments" }));
    expect(screen.queryByRole("checkbox", { name: "Mine" }) === null).toBe(true);
    const last = () => server.calls.filter((call) => call.method === "listThreads").at(-1)?.params;
    await waitFor(() => expect(last()?.tab).toBe("assignments"));
    expect(last()?.mine).toBeUndefined();
  });

  test("more pages come on demand", async () => {
    const server = newServer();
    for (let i = 0; i < 31; i += 1)
      server.chat.thread(`msg_${i}`, "usr_ana", {
        title: `Thread ${i}`,
        channelId: "ch_general",
        channelName: "general",
      });
    const app = await open("/threads", "usr_ana", server);
    const list = await screen.findByRole("list", { name: "Threads" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    await app.user.click(screen.getByRole("button", { name: "Show more threads" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(31));
    expect(screen.queryByRole("button", { name: "Show more threads" }) === null).toBe(true);
  });

  test("a list that fails offers a retry", async () => {
    const server = newServer();
    server.force("listThreads", { kind: "error", status: 500, code: "internal" }, 8);
    await open("/threads", "usr_ana", server);
    expect(await screen.findByText("Threads didn't load")).toBeDefined();
  });
});

describe("correcting an agent's answer", () => {
  test("sends a correction of at most 4,000 characters", async () => {
    const server = newServer();
    server.state.messages.push(
      message({ id: "msg_wrong", author: { type: "agent", id: "agt_scout" }, body: "Gloss, always." }),
    );
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Scout/ });
    await app.user.click(within(item).getByRole("button", { name: "Correct this answer" }));
    const dialog = await screen.findByRole("dialog", { name: "Correct Scout" });
    const send = within(dialog).getByRole("button", { name: "Send correction" });
    expect(send.hasAttribute("disabled")).toBe(true);
    const field = within(dialog).getByRole("textbox", { name: "Your correction" });
    fireEvent.change(field, { target: { value: "x".repeat(4001) } });
    expect(within(dialog).getByText("Keep it to 4,000 characters.")).toBeDefined();
    expect(send.hasAttribute("disabled")).toBe(true);
    await app.user.clear(field);
    await app.user.type(field, "Hartley always takes matte.");
    await app.user.click(send);
    await waitFor(() =>
      expect(server.chat.feedback).toEqual([{ messageId: "msg_wrong", body: "Hartley always takes matte." }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  });
});

/** A private board-room with a thread: its root and one reply. Íris is in it, then is taken out. */
function seedBoard(server: FakeServer) {
  server.state.channels.push({
    id: "ch_board",
    workspaceId: WS,
    name: "board-room",
    topic: "",
    isGeneral: false,
    visibility: "private",
    budgetPerMonthUsd: null,
    createdAt: at(-60),
    memberIds: ["usr_ana", "usr_iris"],
  });
  server.state.messages.push(
    message({ id: "msg_broot", channelId: "ch_board", body: "Secret pricing", replyCount: 1 }),
    message({
      id: "msg_breply",
      channelId: "ch_board",
      body: "Agreed, quietly",
      threadId: "msg_broot",
      createdAt: at(-9),
    }),
  );
  server.chat.thread("msg_broot", "usr_ana", {
    title: "Secret pricing",
    channelId: "ch_board",
    channelName: "board-room",
  });
  return () => {
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    server.dropFromChannel("usr_iris", "ch_board");
  };
}

describe("losing a thread's channel", () => {
  test("on the thread's page, nothing of it stays: title, channel, controls", async () => {
    const server = newServer();
    const remove = seedBoard(server);
    await open("/threads/msg_broot", "usr_iris", server);
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    await act(async () => remove());
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    expect(screen.queryAllByText(/Secret pricing|board-room|Agreed/).length).toBe(0);
    expect(screen.queryByRole("button", { name: "Follow" }) === null).toBe(true);
  });

  test("beside the channel, the thread leaves the cache too, so its page later draws nothing of it", async () => {
    const server = newServer();
    const remove = seedBoard(server);
    const app = await open("/channel/ch_board?thread=msg_broot", "usr_iris", server);
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    await act(async () => remove());
    expect(await screen.findByText("There's no conversation here")).toBeDefined();
    const cachedThreads = () =>
      app.runtime.queryClient
        .getQueryCache()
        .findAll()
        .filter((query) => query.queryKey[2] === "getThread" && query.state.data !== undefined).length;
    expect(cachedThreads()).toBe(0);
    // The server's answer is held back: whatever shows now could only come from the cache.
    server.force("getThread", { kind: "offline" }, 2);
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/threads/msg_broot` }));
    expect(screen.queryAllByText(/Secret pricing|board-room/).length).toBe(0);
  });

  test("a root of another channel never shows in a readable channel's panel", async () => {
    const server = newServer();
    seedBoard(server);
    await open("/channel/ch_general?thread=msg_broot", "usr_tomas", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    expect(
      await within(panel).findByText("The message that started this thread isn't here anymore."),
    ).toBeDefined();
    expect(screen.queryAllByText(/Secret pricing|Agreed/).length).toBe(0);
  });
});

describe("the thread list holds what it showed", () => {
  const seed31 = () => {
    const server = newServer();
    for (let i = 0; i < 31; i += 1)
      server.chat.thread(`msg_${i}`, "usr_ana", {
        title: `Thread ${i}`,
        channelId: "ch_general",
        channelName: "general",
      });
    return server;
  };

  test("a failed next page keeps the list and says so under it", async () => {
    const server = seed31();
    const app = await open("/threads", "usr_ana", server);
    const list = await screen.findByRole("list", { name: "Threads" });
    server.force("listThreads", { kind: "error", status: 500, code: "internal" }, 8);
    await app.user.click(screen.getByRole("button", { name: "Show more threads" }));
    expect(await screen.findByText(/^Part of the list didn't load:/)).toBeDefined();
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    expect(screen.queryByText("Threads didn't load") === null).toBe(true);
  });

  test("a failed refresh keeps the list too", async () => {
    const server = seed31();
    const app = await open("/threads", "usr_ana", server);
    await screen.findByRole("list", { name: "Threads" });
    server.force("listThreads", { kind: "error", status: 500, code: "internal" }, 8);
    await act(async () => {
      await app.runtime.queryClient.refetchQueries({
        predicate: (query) => query.queryKey[2] === "listThreads",
      });
    });
    expect(await screen.findByText(/^Part of the list didn't load:/)).toBeDefined();
    expect(screen.getByRole("list", { name: "Threads" })).toBeDefined();
  });

  test("Closed shows the closed threads and not the open ones", async () => {
    const server = newServer();
    server.chat.thread("msg_open", "usr_ana", {
      title: "Still going",
      channelId: "ch_general",
      channelName: "general",
    });
    server.chat.thread("msg_done", "usr_ana", {
      title: "All wrapped up",
      channelId: "ch_general",
      channelName: "general",
      state: "closed",
    });
    const app = await open("/threads", "usr_ana", server);
    // All holds both (only the archive leaves it); Closed holds only the closed one.
    const list = await screen.findByRole("list", { name: "Threads" });
    expect(within(list).getByRole("link", { name: "Still going" })).toBeDefined();
    await app.user.click(screen.getByRole("tab", { name: "Closed" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Threads" })).getByRole("link", { name: "All wrapped up" }),
      ).toBeDefined(),
    );
    expect(screen.queryByRole("link", { name: "Still going" }) === null).toBe(true);
  });
});

describe("a thread with no record yet", () => {
  test("opens beside its channel, without a page of its own to go to", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_fresh", body: "Anyone checked the kiln?" }));
    await open("/channel/ch_general?thread=msg_fresh", "usr_ana", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    await within(panel).findByRole("log", { name: "Messages in this thread" });
    expect(within(panel).queryByRole("link", { name: "Open the thread on its own page" }) === null).toBe(
      true,
    );
  });
});

describe("a held-back receipt read by someone else", () => {
  test("names the author instead of saying you", async () => {
    const server = newServer();
    server.state.messages.push(
      message({
        id: "msg_held",
        body: "@scout price it",
        receipts: {
          claimedBy: [],
          handled: [],
          viewedBy: [],
          blocked: [{ agentId: "agt_scout", reason: "audience" }],
        },
      }),
    );
    await open("/channel/ch_general", "usr_tomas", server);
    expect(await screen.findByText("Scout doesn't take requests from Jonas Lind here.")).toBeDefined();
    expect(screen.queryByText("Scout doesn't take requests from you here.") === null).toBe(true);
  });
});

describe("a lost thread, and the next one", () => {
  test("the loss stays with that thread: another opens, and the first loads again once re-added", async () => {
    const server = newServer();
    seedBoard(server);
    seedThread(server);
    const app = await open("/threads/msg_broot", "usr_iris", server);
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    // The history answers 404 first: the panel finds the loss before anything else does.
    await act(async () => {
      await app.runtime.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "listChannelMessages",
      });
    });
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/threads/msg_root` }));
    expect(await screen.findByText("Matte, like last time.")).toBeDefined();
    if (board !== undefined) board.memberIds = ["usr_ana", "usr_iris"];
    // The thread answers first; the fresh channel list comes only later.
    const later = server.delay("listChannels");
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/threads/msg_broot` }));
    // The thread's answer against the old list: its channel isn't in it, so the page says gone.
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    await act(async () => later.release());
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
  });

  test("after the loss, the list of threads draws no row of the lost channel, even offline", async () => {
    const server = newServer();
    const remove = seedBoard(server);
    const app = await open("/threads", "usr_iris", server);
    expect(await screen.findByRole("link", { name: "Secret pricing" })).toBeDefined();
    await act(() =>
      app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_board?thread=msg_broot` }),
    );
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    await act(async () => remove());
    expect(await screen.findByText("There's no conversation here")).toBeDefined();
    server.force("listThreads", { kind: "offline" }, 4);
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/threads` }));
    expect(await screen.findByRole("heading", { name: "Threads" })).toBeDefined();
    expect(screen.queryAllByText(/Secret pricing|board-room/).length).toBe(0);
  });
});

describe("what CodeRabbit found on the thread round", () => {
  test("following is each person's own", async () => {
    const server = newServer();
    seedThread(server);
    server.chat.followers.set("msg_root", new Set(["usr_iris"]));
    await open("/channel/ch_general?thread=msg_root", "usr_tomas", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    expect(await within(panel).findByRole("button", { name: "Follow" })).toBeDefined();
  });

  test("replies far apart keep their own header, even from one author", async () => {
    const server = newServer();
    server.state.messages.push(
      message({ id: "msg_root", body: "Kiln log", replyCount: 2 }),
      message({ id: "msg_a", body: "First look", threadId: "msg_root", createdAt: at(-3 * 24 * 60) }),
      message({ id: "msg_b", body: "Second look", threadId: "msg_root", createdAt: at(-62) }),
      message({ id: "msg_c", body: "Third look", threadId: "msg_root", createdAt: at(-2) }),
    );
    await open("/channel/ch_general?thread=msg_root", "usr_ana", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    // Days apart, then an hour apart: each keeps its header and its time.
    for (const text of ["Second look", "Third look"]) {
      const item = (await within(panel).findByText(text)).closest("article");
      expect(item?.getAttribute("data-continued") === null).toBe(true);
    }
  });

  test("the panel holds at most a page of replies, live ones pushing the oldest out", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_root", body: "Kiln log", replyCount: 100 }));
    for (let i = 1; i <= 100; i += 1)
      server.state.messages.push(
        message({ id: `msg_r${i}`, body: `reply ${i}`, threadId: "msg_root", createdAt: at(-200 + i) }),
      );
    await open("/channel/ch_general?thread=msg_root", "usr_ana", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    await within(panel).findByText("reply 100");
    const fresh = message({ id: "msg_r101", body: "reply 101", threadId: "msg_root", createdAt: at(-1) });
    server.state.messages.push(fresh);
    await act(async () => server.emit(WS, { type: "message.posted", message: fresh }, "ch_general"));
    expect(await within(panel).findByText("reply 101")).toBeDefined();
    expect(within(panel).queryByText("reply 1") === null).toBe(true);
    // The root stays at the top, whatever the cap pushes out.
    const log = within(panel).getByRole("log", { name: "Messages in this thread" });
    expect(within(log).getByText("Kiln log")).toBeDefined();
  });

  test("the search takes no more than the server accepts", async () => {
    const app = await open("/threads");
    const search = await screen.findByRole("searchbox", { name: "Search threads" });
    await app.user.click(search);
    await app.user.paste("k".repeat(250));
    expect((search as HTMLInputElement).value.length).toBe(200);
  });

  test("a person added back opens the thread even when the channel list in cache predates it", async () => {
    const server = newServer();
    seedBoard(server);
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    // The list is read while the person is out of the channel, then they are added back.
    const app = await open("/channel/ch_general", "usr_iris", server);
    await screen.findByRole("textbox", { name: "Write in #general" });
    if (board !== undefined) board.memberIds = ["usr_ana", "usr_iris"];
    // The thread answers first; the fresh channel list comes only later.
    const later = server.delay("listChannels");
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/threads/msg_broot` }));
    // The thread's answer against the old list: its channel isn't in it, so the page says gone.
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    await act(async () => later.release());
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
  });

  test("a channel left out of the list keeps the page gone when the thread can't be read again", async () => {
    const server = newServer();
    seedBoard(server);
    const app = await open("/threads/msg_broot", "usr_iris", server);
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    // Out of the channel with no word on the socket: only a fresh list tells, and then the thread
    // itself can't be read again.
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    server.force("getThread", { kind: "offline" }, 20);
    await act(async () => {
      void app.runtime.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "listChannels",
      });
    });
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    await waitFor(() =>
      expect(server.calls.filter((call) => call.method === "getThread").length).toBeGreaterThan(1),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByRole("heading", { name: "There's no thread here" })).toBeDefined();
    expect(screen.queryByText("This thread didn't load") === null).toBe(true);
    expect(screen.queryAllByText(/Secret pricing|board-room|Agreed/).length).toBe(0);
  });

  test("the count is the thread's, though the panel draws only the latest page", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_root", body: "Kiln log", replyCount: 102 }));
    for (let i = 1; i <= 102; i += 1)
      server.state.messages.push(
        message({ id: `msg_r${i}`, body: `reply ${i}`, threadId: "msg_root", createdAt: at(-300 + i * 2) }),
      );
    server.chat.thread("msg_root", "usr_jonas", { title: "Kiln log", replyCount: 102 });
    await open("/channel/ch_general?thread=msg_root", "usr_ana", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    await within(panel).findByText("reply 102");
    expect(within(panel).queryByText("reply 1") === null).toBe(true);
    const log = within(panel).getByRole("log", { name: "Messages in this thread" });
    expect(within(log).getByText("102 replies")).toBeDefined();
    expect(within(panel).getAllByText("102 replies").length).toBe(2);
    expect(within(panel).queryByText("100 replies") === null).toBe(true);
  });

  test("replies close together from one author run on under one header", async () => {
    const server = newServer();
    server.state.messages.push(
      message({ id: "msg_root", body: "Kiln log", replyCount: 3 }),
      message({ id: "msg_a", body: "First look", threadId: "msg_root", createdAt: at(-5) }),
      message({ id: "msg_b", body: "Second look", threadId: "msg_root", createdAt: at(-4) }),
      message({
        id: "msg_c",
        body: "Scout's look",
        author: { type: "agent", id: "agt_scout" },
        threadId: "msg_root",
        createdAt: at(-3),
      }),
    );
    await open("/channel/ch_general?thread=msg_root", "usr_ana", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    const item = async (text: string) => (await within(panel).findByText(text)).closest("article");
    expect((await item("First look"))?.getAttribute("data-continued") === null).toBe(true);
    expect((await item("Second look"))?.getAttribute("data-continued") === null).toBe(false);
    // Another author starts a header of its own.
    expect((await item("Scout's look"))?.getAttribute("data-continued") === null).toBe(true);
  });
});

describe("a thread's page against a list it can't trust", () => {
  const count = (server: FakeServer, method: string) =>
    server.calls.filter((call) => call.method === method).length;

  test("a stale list that can't be read again shows gone once, without asking again and again", async () => {
    const server = newServer();
    seedBoard(server);
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    // The list is read while the person is out, then they are added back and the list stops answering.
    const app = await open("/channel/ch_general", "usr_iris", server);
    await screen.findByRole("textbox", { name: "Write in #general" });
    if (board !== undefined) board.memberIds = ["usr_ana", "usr_iris"];
    server.force("listChannels", { kind: "offline" }, 1000);
    const threads = count(server, "getThread");
    const lists = count(server, "listChannels");
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/threads/msg_broot` }));
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1000)));
    expect(screen.getByRole("heading", { name: "There's no thread here" })).toBeDefined();
    expect(count(server, "getThread") - threads).toBeLessThanOrEqual(3);
    expect(count(server, "listChannels") - lists).toBeLessThanOrEqual(6);
  });

  test("gone while the thread couldn't be read, then added back: the thread opens without a retry", async () => {
    const server = newServer();
    seedBoard(server);
    const app = await open("/threads/msg_broot", "usr_iris", server);
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    server.force("getThread", { kind: "offline" }, 1000);
    const relist = () =>
      act(async () => {
        void app.runtime.queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[2] === "listChannels",
        });
      });
    await relist();
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    // Every read of the thread has failed by now, retries included.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByRole("heading", { name: "There's no thread here" })).toBeDefined();
    if (board !== undefined) board.memberIds = ["usr_ana", "usr_iris"];
    server.unforce("getThread");
    await relist();
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    expect(screen.queryByText("This thread didn't load") === null).toBe(true);
  });

  test("added back while the thread still can't be read: one more read, then the error with its retry", async () => {
    const server = newServer();
    seedBoard(server);
    const app = await open("/threads/msg_broot", "usr_iris", server);
    expect(await screen.findByText("Agreed, quietly")).toBeDefined();
    const board = server.state.channels.find((channel) => channel.id === "ch_board");
    if (board !== undefined) board.memberIds = ["usr_ana"];
    server.force("getThread", { kind: "offline" }, 100_000);
    const relist = () =>
      act(async () => {
        void app.runtime.queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[2] === "listChannels",
        });
      });
    await relist();
    expect(await screen.findByRole("heading", { name: "There's no thread here" })).toBeDefined();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    if (board !== undefined) board.memberIds = ["usr_ana", "usr_iris"];
    const before = count(server, "getThread");
    await relist();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2000)));
    // The read and its retries, and no more.
    expect(count(server, "getThread") - before).toBeLessThanOrEqual(5);
    expect(screen.getByRole("heading", { name: "This thread didn't load" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  }, 15_000);

  test("replies loaded past the record's count are counted", async () => {
    const server = newServer();
    server.state.messages.push(message({ id: "msg_root", body: "Kiln log", replyCount: 3 }));
    for (let i = 1; i <= 3; i += 1)
      server.state.messages.push(
        message({ id: `msg_r${i}`, body: `reply ${i}`, threadId: "msg_root", createdAt: at(-60 + i * 10) }),
      );
    // The record was read before the last two replies came in.
    server.chat.thread("msg_root", "usr_jonas", { title: "Kiln log", replyCount: 1 });
    await open("/channel/ch_general?thread=msg_root", "usr_ana", server);
    const panel = await screen.findByRole("region", { name: "Thread" });
    await within(panel).findByText("reply 3");
    const log = within(panel).getByRole("log", { name: "Messages in this thread" });
    expect(within(log).getByText("3 replies")).toBeDefined();
  });
});
