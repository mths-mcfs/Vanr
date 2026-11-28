// Threads against the fake server: beside a channel and on their own page, following and managing
// them, the list with its tabs, filters and search, and correcting an agent's answer.
import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    expect(server.chat.threads.find((each) => each.id === "msg_lone")?.following).toBe(true);
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
