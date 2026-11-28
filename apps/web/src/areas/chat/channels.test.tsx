// Channels against the fake server: making one, finding and joining one, starting a direct message,
// the people of a channel, its settings and its pins. Each control shows only to who the server lets.
import { describe, expect, test } from "bun:test";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { Message } from "@vanr/contract";
import { newServer, renderApp, TEST_NOW } from "../../../test/app.tsx";

const WS = "workspace_birchwood";

const open = (path: string, signedInAs = "usr_ana", server = newServer()) =>
  renderApp({ path: `/workspace/${WS}${path}`, server, signedInAs });

function message(id: string, body: string): Message {
  return {
    id,
    body,
    actions: [],
    agentMentionIds: [],
    author: { type: "person", id: "usr_jonas" },
    channelId: "ch_general",
    clientId: null,
    createdAt: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
    editedAt: null,
    memories: [],
    meta: {},
    reactions: [],
    receipts: { claimedBy: [], handled: [], viewedBy: [] },
    replyCount: 0,
    runId: null,
    threadId: null,
    usage: null,
  };
}

describe("making a channel", () => {
  test("shows the name it will have, and opens it once made", async () => {
    const app = await open("/channel/ch_general");
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Make a channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a channel" });
    const make = within(dialog).getByRole("button", { name: "Make channel" });
    expect(make.hasAttribute("disabled")).toBe(true);
    await app.user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Kiln Room");
    expect(within(dialog).getByText("It will be #kiln-room")).toBeDefined();
    await app.user.click(within(dialog).getByRole("radio", { name: /Only the people added/ }));
    await app.user.click(make);
    expect(await screen.findByRole("heading", { name: /kiln-room/ })).toBeDefined();
    const made = app.server.state.channels.find((channel) => channel.name === "kiln-room");
    expect(made?.visibility).toBe("private");
    expect(app.address()).toBe(`/workspace/${WS}/channel/${made?.id}`);
  });

  test("a name the server refuses keeps the dialog open with why", async () => {
    const app = await open("/channel/ch_general");
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Make a channel" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a channel" });
    await app.user.type(within(dialog).getByRole("textbox", { name: "Name" }), "design");
    await app.user.click(within(dialog).getByRole("button", { name: "Make channel" }));
    expect(await within(dialog).findByRole("alert")).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Make a channel" })).toBeDefined();
  });
});

describe("finding a channel", () => {
  test("lists the channels, opens one already joined and joins another", async () => {
    const server = newServer();
    const design = server.state.channels.find((channel) => channel.id === "ch_design");
    if (design !== undefined) design.memberIds = design.memberIds.filter((id) => id !== "usr_tomas");
    const app = await open("/channel/ch_general", "usr_tomas", server);
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Browse channels" }));
    const dialog = await screen.findByRole("dialog", { name: "Browse channels" });
    expect(await within(dialog).findByRole("button", { name: "Open #general" })).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Join #design" }));
    expect(await screen.findByRole("heading", { name: /design/ })).toBeDefined();
    expect(design?.memberIds.includes("usr_tomas")).toBe(true);
  });
});

describe("starting a direct message", () => {
  test("searches people by name or handle and opens the conversation", async () => {
    const app = await open("/channel/ch_general");
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Message someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Message someone" });
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Name or handle" }), "iris");
    await app.user.click(await within(dialog).findByRole("button", { name: /Íris Valença/ }));
    expect(await screen.findByRole("heading", { name: "Íris Valença" })).toBeDefined();
    await app.user.click(within(sidebar).getByRole("button", { name: "Message someone" }));
    const again = await screen.findByRole("dialog", { name: "Message someone" });
    await app.user.type(within(again).getByRole("searchbox", { name: "Name or handle" }), "zzz");
    expect(within(again).getByText("Nobody matches “zzz”.")).toBeDefined();
  });
});

describe("a channel's people", () => {
  test("a member adds someone; only whoever manages members removes anyone", async () => {
    const server = newServer();
    const print = server.state.channels.find((channel) => channel.id === "ch_print");
    if (print !== undefined) print.memberIds = ["usr_ana", "usr_iris"];
    const app = await open("/channel/ch_print", "usr_iris", server);
    // Two people and the workspace's three agents.
    await app.user.click(await screen.findByRole("button", { name: "5 in the channel" }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    expect(within(dialog).queryByRole("button", { name: /^Remove / }) === null).toBe(true);
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Add someone" }), "tom");
    await app.user.click(await within(dialog).findByRole("button", { name: "Add Tomás Eriksen" }));
    await waitFor(() => expect(print?.memberIds.includes("usr_tomas")).toBe(true));
    expect(await within(dialog).findByText("Tomás Eriksen")).toBeDefined();
    app.unmount();

    const owner_ = await open("/channel/ch_print", "usr_ana", server);
    await owner_.user.click(await screen.findByRole("button", { name: "6 in the channel" }));
    const owner = await screen.findByRole("dialog", { name: "People in #print-queue" });
    expect(
      await within(owner).findByRole("button", { name: "Remove Tomás Eriksen from the channel" }),
    ).toBeDefined();
  });

  test("leaving is offered everywhere but #general", async () => {
    const app = await open("/channel/ch_general");
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #general" });
    await within(dialog).findByRole("list", { name: "In this channel" });
    expect(within(dialog).queryByRole("button", { name: "Leave channel" }) === null).toBe(true);
    expect(within(dialog).queryByRole("button", { name: /^Remove .* Ana/ }) === null).toBe(true);
  });
});

describe("a channel's settings", () => {
  test("name and topic for a member; the budget only for whoever configures", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_iris", server);
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings for #print-queue" });
    expect(within(dialog).queryByRole("textbox", { name: /Monthly budget/ }) === null).toBe(true);
    await app.user.clear(within(dialog).getByRole("textbox", { name: "What it's about" }));
    await app.user.type(
      within(dialog).getByRole("textbox", { name: "What it's about" }),
      "Proofs and plates",
    );
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Proofs and plates")).toBeDefined();
    app.unmount();

    const admin = await open("/channel/ch_general", "usr_jonas", server);
    await admin.user.click(await screen.findByRole("button", { name: "Settings" }));
    const general = await screen.findByRole("dialog", { name: "Settings for #general" });
    expect(within(general).getByText("The workspace's general channel keeps its name.")).toBeDefined();
    expect(within(general).getByRole("textbox", { name: "Name" }).hasAttribute("readonly")).toBe(true);
    expect(within(general).getByRole("textbox", { name: /Monthly budget/ })).toBeDefined();
  });

  test("a budget that isn't an amount can't be saved", async () => {
    const app = await open("/channel/ch_print", "usr_jonas");
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings for #print-queue" });
    await app.user.type(within(dialog).getByRole("textbox", { name: /Monthly budget/ }), "lots");
    expect(within(dialog).getByText("Use an amount from 0 to 100,000.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("pins", () => {
  test("a member pins a message and finds it among the pinned", async () => {
    const server = newServer();
    server.state.messages.push(message("msg_pin", "Kiln B runs hot"));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    await app.user.click(within(item).getByRole("button", { name: "Pin to the channel" }));
    await waitFor(() => expect(server.chat.pins.map((pin) => pin.messageId)).toEqual(["msg_pin"]));
    await app.user.click(screen.getByRole("button", { name: "Pinned" }));
    const dialog = await screen.findByRole("dialog", { name: "Pinned messages" });
    expect(await within(dialog).findByText("Kiln B runs hot")).toBeDefined();
  });

  test("no pins says how to add one", async () => {
    const app = await open("/channel/ch_general");
    await app.user.click(await screen.findByRole("button", { name: "Pinned" }));
    const dialog = await screen.findByRole("dialog", { name: "Pinned messages" });
    expect(
      await within(dialog).findByText("Nothing is pinned here yet. Pin a message from its actions."),
    ).toBeDefined();
  });
});

describe("leaving a private channel", () => {
  test("goes home and keeps nothing of the channel", async () => {
    const server = newServer();
    server.state.channels.push({
      id: "ch_board",
      workspaceId: WS,
      name: "board-room",
      topic: "",
      isGeneral: false,
      visibility: "private",
      budgetPerMonthUsd: null,
      createdAt: new Date(TEST_NOW.getTime() - 3_600_000).toISOString(),
      memberIds: ["usr_ana", "usr_iris"],
    });
    server.state.messages.push({ ...message("msg_secret", "Raise it 4%"), channelId: "ch_board" });
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4%")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "5 in the channel" }));
    const dialog = await screen.findByRole("dialog", { name: "People in #board-room" });
    // The channel list can't be read again: only the leave itself can clear what was cached.
    server.force("listChannels", { kind: "offline" }, 20);
    await app.user.click(await within(dialog).findByRole("button", { name: "Leave channel" }));
    await waitFor(() => expect(app.address()).toBe(`/workspace/${WS}`));
    const left = app.runtime.queryClient
      .getQueryCache()
      .findAll()
      .filter((query) => {
        const args = query.queryKey[3];
        return (
          typeof args === "object" && args !== null && "channelId" in args && args.channelId === "ch_board"
        );
      })
      .filter((query) => query.state.data !== undefined);
    expect(left.length).toBe(0);
  });
});

describe("what CodeRabbit found on the channels round", () => {
  test("saving the settings sends only what the person changed, not a topic someone else changed meanwhile", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_iris", server);
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings for #print-queue" });
    // Someone else changes the topic while the dialog is open, and the list comes in again.
    const print = server.state.channels.find((channel) => channel.id === "ch_print");
    if (print !== undefined) print.topic = "Plates only";
    await act(async () => {
      await app.runtime.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "listChannels",
      });
    });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await app.user.clear(name);
    await app.user.type(name, "print-room");
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.calls.some((call) => call.method === "updateChannel")).toBe(true));
    const body = server.calls.find((call) => call.method === "updateChannel")?.params;
    expect(body?.name).toBe("print-room");
    expect(body !== undefined && "topic" in body).toBe(false);
    await waitFor(() => expect(print?.topic).toBe("Plates only"));
  });

  test("browsing channels when the direct messages can't be read says so, and retries", async () => {
    const server = newServer();
    server.force("getDms", { kind: "offline" }, 100);
    const app = await open("/channel/ch_general", "usr_ana", server);
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Browse channels" }));
    const dialog = await screen.findByRole("dialog", { name: "Browse channels" });
    expect(await within(dialog).findByRole("alert")).toBeDefined();
    expect(within(dialog).queryByRole("list", { name: "Channels" }) === null).toBe(true);
    server.unforce("getDms");
    await app.user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByRole("button", { name: "Open #general" })).toBeDefined();
  });

  test("taking one agent out of a channel never changed before keeps the others", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_ana", server);
    const field = await screen.findByRole("textbox", { name: "Write in #print-queue" });
    await act(async () => {
      await app.runtime.api.client.call("deleteChannelMemberAgent", {
        workspaceId: WS,
        channelId: "ch_print",
        agentId: "agt_scout",
      });
      await app.runtime.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[2] === "getChannelDirectory",
      });
    });
    await app.user.type(field, "@ledger check it");
    expect(await screen.findByText("Ledger will answer")).toBeDefined();
    await app.user.clear(field);
    await app.user.type(field, "@scout check it");
    expect(screen.queryByText("Scout will answer") === null).toBe(true);
  });

  test("a channel's people list its agents too, and removing one keeps the rest", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    const list = await within(dialog).findByRole("list", { name: "In this channel" });
    expect(await within(list).findByText("Scout")).toBeDefined();
    expect(within(list).getByText("Ledger")).toBeDefined();
    await app.user.click(within(dialog).getByRole("button", { name: "Remove Scout from the channel" }));
    await waitFor(() => expect(within(list).queryByText("Scout") === null).toBe(true));
    expect(within(list).getByText("Ledger")).toBeDefined();
  });

  test("an agent taken out of a channel no longer answers there", async () => {
    const server = newServer();
    // The channel's agents were changed: only Ledger is in #general now.
    server.chat.agentMembers.set("ch_general", new Set(["agt_ledger"]));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const field = await screen.findByRole("textbox", { name: "Write in #general" });
    await app.user.type(field, "@ledger check it");
    expect(await screen.findByText("Ledger will answer")).toBeDefined();
    await app.user.clear(field);
    await app.user.type(field, "@scout check it");
    expect(screen.queryByText("Scout will answer") === null).toBe(true);
  });
});
