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

const listed = (app: Awaited<ReturnType<typeof open>>) =>
  app.runtime.queryClient
    .getQueryCache()
    .findAll()
    .filter((query) => query.queryKey[2] === "listChannels")
    .flatMap((query) => (Array.isArray(query.state.data) ? query.state.data : []))
    .map((channel: { id: string }) => channel.id);

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
    // Nobody, other than an agent, is removed from #general.
    const list = within(dialog).getByRole("list", { name: "In this channel" });
    for (const person of ["Jonas Lind", "Íris Valença", "Tomás Eriksen"])
      expect(within(list).queryByRole("button", { name: `Remove ${person} from the channel` }) === null).toBe(
        true,
      );
    expect(within(list).getByRole("button", { name: "Remove Scout from the channel" })).toBeDefined();
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
    expect(
      within(dialog).getByText(
        "Use an amount from 0 to 100,000, written like 1.50, with no thousands separator.",
      ),
    ).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("a channel's budget in English", () => {
  test("a thousands separator is refused, a point is the decimal mark", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_jonas", server);
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings for #print-queue" });
    const budget = within(dialog).getByRole("textbox", { name: /Monthly budget/ });
    await app.user.type(budget, "10,000");
    expect(within(dialog).getByText(/^Use an amount from 0 to 100,000/)).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    // Nor is the comma a decimal mark in English.
    await app.user.clear(budget);
    await app.user.type(budget, "1,5");
    expect(within(dialog).getByText(/^Use an amount from 0 to 100,000/)).toBeDefined();
    await app.user.clear(budget);
    await app.user.type(budget, "1.5");
    await app.user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.method === "updateChannel")?.params.budgetPerMonthUsd).toBe(
        1.5,
      ),
    );
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
    expect(listed(app)).toContain("ch_board");
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
    expect(listed(app)).not.toContain("ch_board");
    expect(listed(app)).toContain("ch_general");
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

describe("a sidebar dialog and a workspace switch", () => {
  for (const [button, title] of [
    ["Make a channel", "Make a channel"],
    ["Browse channels", "Browse channels"],
    ["Message someone", "Message someone"],
  ] as const)
    test(`"${button}" opened in one workspace closes when another opens`, async () => {
      const server = newServer();
      const app = await open("/channel/ch_general", "usr_ana", server);
      const sidebar = await screen.findByRole("complementary");
      await app.user.click(await within(sidebar).findByRole("button", { name: button }));
      const dialog = await screen.findByRole("dialog", { name: title });
      if (button === "Make a channel")
        await app.user.type(within(dialog).getByRole("textbox", { name: "Name" }), "birch-only");
      await act(() => app.runtime.router.navigate({ to: "/workspace/workspace_nightshift" }));
      await waitFor(() => expect(app.address()).toBe("/workspace/workspace_nightshift"));
      expect(screen.queryByRole("dialog", { name: title }) === null).toBe(true);
      expect(server.state.channels.some((channel) => channel.name === "birch-only")).toBe(false);
    });
});

describe("the dev fake answers members as the server does", () => {
  test("adds and removals the server refuses are refused", async () => {
    const server = newServer();
    const app = await open("/channel/ch_general", "usr_ana", server);
    await screen.findByRole("complementary");
    const { client } = app.runtime.api;
    const status = async (call: () => Promise<unknown>) => {
      try {
        await call();
        return 204;
      } catch (error) {
        return (error as { status?: number }).status;
      }
    };
    const add = (channelId: string, body: { agentId: string } | { userId: string }) =>
      status(() => client.call("createChannelMember", { workspaceId: WS, channelId, body }));
    // Another workspace's agent, one that doesn't exist, a person who isn't in the workspace.
    expect(await add("ch_general", { agentId: "agt_fjell" })).toBe(404);
    expect(await add("ch_general", { agentId: "agt_nope" })).toBe(404);
    expect(await add("ch_general", { userId: "usr_nobody" })).toBe(404);
    // An archived agent.
    const tally = server.agents.find((agent) => agent.id === "agt_tally");
    if (tally !== undefined) tally.archivedAt = new Date(TEST_NOW.getTime() - 60_000).toISOString();
    expect(await add("ch_general", { agentId: "agt_tally" })).toBe(404);
    // Someone not in the channel can't be removed.
    const remove = (kind: "Person" | "Agent", channelId: string, id: string) =>
      status(() =>
        kind === "Person"
          ? client.call("deleteChannelMemberPerson", { workspaceId: WS, channelId, personId: id })
          : client.call("deleteChannelMemberAgent", { workspaceId: WS, channelId, agentId: id }),
      );
    expect(await remove("Person", "ch_print", "usr_nobody")).toBe(404);
    expect(await remove("Agent", "ch_print", "agt_nope")).toBe(404);
    // A direct message keeps its two.
    const { channelId: dm } = await client.call("createDm", {
      workspaceId: WS,
      body: { userId: "usr_iris" },
    });
    expect(await add(dm, { userId: "usr_tomas" })).toBe(403);
    expect(await remove("Person", dm, "usr_iris")).toBe(403);
    expect(await remove("Agent", dm, "agt_scout")).toBe(403);
    // What the server takes, the fake still takes.
    expect(await add("ch_print", { agentId: "agt_ledger" })).toBe(204);
    expect(await remove("Agent", "ch_print", "agt_ledger")).toBe(204);
  });
});

describe("a channel's people, round one of the access check", () => {
  const board = (server: ReturnType<typeof newServer>) => {
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
  };

  test("offers only the agents this person can talk to", async () => {
    const server = newServer();
    server.chat.agentMembers.set("ch_print", new Set());
    const tally = server.agents.find((agent) => agent.id === "agt_tally");
    if (tally !== undefined) tally.reachable = false;
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    const search = within(dialog).getByRole("searchbox", { name: "Add someone" });
    await app.user.type(search, "ledger");
    expect(await within(dialog).findByRole("button", { name: "Add Ledger" })).toBeDefined();
    await app.user.clear(search);
    await app.user.type(search, "tally");
    expect(await within(dialog).findByText("Nobody outside the channel matches “tally”.")).toBeDefined();
  });

  test("leaving a private channel forgets it even when the dialog is closed before the answer", async () => {
    const server = newServer();
    board(server);
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4%")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #board-room" });
    expect(listed(app)).toContain("ch_board");
    server.force("listChannels", { kind: "offline" }, 20);
    const held = server.hold("deleteChannelMemberPerson");
    await app.user.click(await within(dialog).findByRole("button", { name: "Leave channel" }));
    await app.user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "People in #board-room" }) === null).toBe(true),
    );
    await act(async () => held.release());
    // The dialog is gone, so nothing leads away; what the channel held is forgotten all the same.
    await waitFor(() => expect(screen.queryByText("Raise it 4%") === null).toBe(true));
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
    expect(listed(app)).not.toContain("ch_board");
    expect(listed(app)).toContain("ch_general");
  });

  test("the channel lost on the socket before the leave answers still takes the person home", async () => {
    const server = newServer();
    board(server);
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4%")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #board-room" });
    // The leave is done at once but answered late; the server stops sending the channel in between,
    // so the page finds it lost and the dialog goes with it.
    const held = server.delay("deleteChannelMemberPerson");
    await app.user.click(await within(dialog).findByRole("button", { name: "Leave channel" }));
    await waitFor(() =>
      expect(server.state.channels.find((c) => c.id === "ch_board")?.memberIds).toEqual(["usr_ana"]),
    );
    await act(async () => server.dropFromChannel("usr_iris", "ch_board"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "People in #board-room" }) === null).toBe(true),
    );
    await act(async () => held.release());
    await waitFor(() => expect(app.address()).toBe(`/workspace/${WS}`));
  });

  test("someone who moved on before the leave answers stays where they went", async () => {
    const server = newServer();
    board(server);
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4%")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #board-room" });
    const held = server.delay("deleteChannelMemberPerson");
    await app.user.click(await within(dialog).findByRole("button", { name: "Leave channel" }));
    await act(() => app.runtime.router.navigate({ to: `/workspace/${WS}/channel/ch_general` }));
    await waitFor(() => expect(app.address()).toBe(`/workspace/${WS}/channel/ch_general`));
    const leaves = () =>
      app.runtime.queryClient
        .getMutationCache()
        .getAll()
        .filter((mutation) => {
          const variables: unknown = mutation.state.variables;
          return typeof variables === "object" && variables !== null && "personId" in variables;
        })
        .map((mutation) => mutation.state.status);
    expect(leaves()).toContain("pending");
    await act(async () => held.release());
    // The leave has finished, and whatever it decided is done.
    await waitFor(() => expect(leaves()).toEqual(["success"]));
    await waitFor(() => expect(screen.queryByText("Raise it 4%") === null).toBe(true));
    expect(app.address()).toBe(`/workspace/${WS}/channel/ch_general`);
  });

  test("a second click on Remove sends nothing more", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    const remove = await within(dialog).findByRole("button", { name: "Remove Scout from the channel" });
    const held = server.hold("deleteChannelMemberAgent");
    await app.user.click(remove);
    await app.user.click(remove);
    await act(async () => held.release());
    await waitFor(() => expect(within(dialog).queryByText("Scout") === null).toBe(true));
    expect(server.calls.filter((call) => call.method === "deleteChannelMemberAgent").length).toBe(1);
  });

  test("adding one shows only that one as busy", async () => {
    const server = newServer();
    server.chat.agentMembers.set("ch_print", new Set());
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Add someone" }), "l");
    const ledger = await within(dialog).findByRole("button", { name: "Add Ledger" });
    const held = server.hold("createChannelMember");
    await app.user.click(ledger);
    await waitFor(() => expect(ledger.getAttribute("aria-busy")).toBe("true"));
    expect(within(dialog).getByRole("button", { name: "Add Tally" }).getAttribute("aria-busy") === null).toBe(
      true,
    );
    await act(async () => held.release());
  });

  test("with everyone in already, it says there's nobody left to add", async () => {
    const app = await open("/channel/ch_general", "usr_ana");
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #general" });
    expect(
      await within(dialog).findByText("Everyone who could join is in the channel already."),
    ).toBeDefined();
  });
});

describe("pins where they apply", () => {
  test("a direct message reads no pins", async () => {
    const server = newServer();
    const app = await open("/channel/ch_general", "usr_ana", server);
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Message someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Message someone" });
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Name or handle" }), "iris");
    await app.user.click(await within(dialog).findByRole("button", { name: /Íris Valença/ }));
    expect(await screen.findByRole("heading", { name: "Íris Valença" })).toBeDefined();
    await screen.findByRole("textbox", { name: /Write/ });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const pinReads = server.calls.filter(
      (call) => call.method === "listChannelPinnedMessages" && call.params.channelId !== "ch_general",
    );
    expect(pinReads.length).toBe(0);
  });

  test("unpinning what someone else already unpinned ends unpinned, without an error", async () => {
    const server = newServer();
    server.state.messages.push(message("msg_pin", "Kiln B runs hot"));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    const toggle = within(item).getByRole("button", { name: "Pin to the channel" });
    await app.user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    // Someone else unpins it; this page still shows it pinned.
    server.chat.pins = [];
    await app.user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect(screen.queryByText("That no longer exists.") === null).toBe(true);
  });
});

describe("starting a direct message, who is around", () => {
  test("shows each person's presence in plain sight", async () => {
    const app = await open("/channel/ch_general");
    const sidebar = await screen.findByRole("complementary");
    await app.user.click(await within(sidebar).findByRole("button", { name: "Message someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Message someone" });
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Name or handle" }), "iris");
    const row = await within(dialog).findByRole("button", { name: /Íris Valença/ });
    const presence = within(row).getByText(/^(online|away)$/);
    expect(presence.closest(".vr-visually-hidden") === null).toBe(true);
  });
});

describe("what CodeRabbit found on round two", () => {
  const board = (server: ReturnType<typeof newServer>) => {
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
  };

  test("leaving a private channel clears it and goes home without waiting for anything read again", async () => {
    const server = newServer();
    board(server);
    const app = await open("/channel/ch_board", "usr_iris", server);
    expect(await screen.findByText("Raise it 4%")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #board-room" });
    // Every read of the channel list hangs from now on.
    const hung = server.hold("listChannels");
    await app.user.click(await within(dialog).findByRole("button", { name: "Leave channel" }));
    await waitFor(() => expect(app.address()).toBe(`/workspace/${WS}`));
    expect(listed(app)).not.toContain("ch_board");
    await act(async () => hung.release());
  });

  test("without the channel's own list, nobody is offered to add", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    server.force("listChannelMembers", { kind: "offline" }, 100);
    await act(async () => {
      app.runtime.queryClient.removeQueries({
        predicate: (query) => query.queryKey[2] === "listChannelMembers",
      });
    });
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Add someone" }), "a");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(within(dialog).queryAllByRole("button", { name: /^Add / }).length).toBe(0);
  });

  test("each row stays busy until its own removal answers", async () => {
    const server = newServer();
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    const scout = await within(dialog).findByRole("button", { name: "Remove Scout from the channel" });
    const ledger = within(dialog).getByRole("button", { name: "Remove Ledger from the channel" });
    const held = server.hold("deleteChannelMemberAgent");
    await app.user.click(scout);
    await app.user.click(ledger);
    await waitFor(() => expect(ledger.getAttribute("aria-busy")).toBe("true"));
    expect(scout.getAttribute("aria-busy")).toBe("true");
    await act(async () => held.release());
  });

  test("an add that fails while another succeeds still says why", async () => {
    const server = newServer();
    server.chat.agentMembers.set("ch_print", new Set());
    const app = await open("/channel/ch_print", "usr_ana", server);
    await app.user.click(await screen.findByRole("button", { name: /in the channel/ }));
    const dialog = await screen.findByRole("dialog", { name: "People in #print-queue" });
    await app.user.type(within(dialog).getByRole("searchbox", { name: "Add someone" }), "l");
    const ledger = await within(dialog).findByRole("button", { name: "Add Ledger" });
    const tally = within(dialog).getByRole("button", { name: "Add Tally" });
    server.force(
      "createChannelMember",
      { kind: "error", status: 404, code: "not_found", message: "Agent not found" },
      1,
      (params) => params.agentId === "agt_ledger",
    );
    const held = server.hold("createChannelMember");
    await app.user.click(ledger);
    await app.user.click(tally);
    await act(async () => held.release());
    expect(await within(dialog).findByRole("alert")).toBeDefined();
  });

  test("a budget the field can't write, left alone, neither blocks saving nor is sent", async () => {
    const server = newServer();
    const print = server.state.channels.find((channel) => channel.id === "ch_print");
    if (print !== undefined) print.budgetPerMonthUsd = 1.005;
    const app = await open("/channel/ch_print", "usr_jonas", server);
    await app.user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings for #print-queue" });
    await app.user.type(within(dialog).getByRole("textbox", { name: "What it's about" }), " and plates");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(false);
    await app.user.click(save);
    await waitFor(() => expect(server.calls.some((call) => call.method === "updateChannel")).toBe(true));
    const body = server.calls.find((call) => call.method === "updateChannel")?.params;
    expect(body !== undefined && "budgetPerMonthUsd" in body).toBe(false);
  });

  test("a pin can't be toggled before the pins are known", async () => {
    const server = newServer();
    server.state.messages.push(message("msg_pin", "Kiln B runs hot"));
    const held = server.hold("listChannelPinnedMessages");
    await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    const toggle = within(item).getByRole("button", { name: "Pin to the channel" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    await act(async () => held.release());
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  });

  test("a pin someone else removed leaves at once, even when the pins can't be read again", async () => {
    const server = newServer();
    server.state.messages.push(message("msg_pin", "Kiln B runs hot"));
    const app = await open("/channel/ch_general", "usr_ana", server);
    const item = await screen.findByRole("article", { name: /Jonas Lind/ });
    const toggle = within(item).getByRole("button", { name: "Pin to the channel" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    await app.user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    server.chat.pins = [];
    server.force("listChannelPinnedMessages", { kind: "offline" }, 100);
    await app.user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
  });
});
