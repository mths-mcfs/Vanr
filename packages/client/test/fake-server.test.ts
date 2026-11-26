// The client against the in-memory server: the sample data comes back through the real schemas, writes
// show up on the next read, and failures arrive as the server's error envelope.
import { describe, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";
import { ApiError } from "../src/errors.ts";
import { createFakeServer } from "../src/testing/fake-server.ts";

function setup() {
  const server = createFakeServer({ now: () => new Date("2026-11-03T10:00:00.000Z") });
  const client = createClient({ baseUrl: "http://fake.vanr", fetch: server.fetch });
  return { server, client, api: client.api, workspaceId: server.sample.workspaceId };
}

describe("fake server", () => {
  test("the sample workspace reads back through the client's schemas", async () => {
    const { api, workspaceId } = setup();
    const me = await api.getMe();
    expect(me?.user.name).toBe("Ada Park");
    expect(me?.workspaces).toEqual([{ id: workspaceId, name: "Harbor Labs", logo: null, role: "owner" }]);
    const channels = await api.listChannels({ workspaceId });
    expect(channels.map((c) => c.name)).toEqual(["general", "firmware", "field-tests"]);
    expect(channels.find((c) => c.name === "general")?.unreadCount).toBe(1);
    expect(await api.listMembers({ workspaceId })).toHaveLength(2);
    expect(await api.getPeople({ workspaceId })).toHaveLength(2);
  });

  test("a posted message is listed, a retried post is stored once, and reading clears the unread count", async () => {
    const { api, workspaceId, server } = setup();
    const channelId = server.sample.defaultChannelId;
    const post = { workspaceId, channelId, body: { body: "Buoy is charged.", clientId: "p_1" } };
    const first = await api.createChannelMessage(post);
    const again = await api.createChannelMessage(post);
    expect(again.id).toBe(first.id);
    const messages = await api.listChannelMessages({ workspaceId, channelId });
    expect(messages.map((m) => m.body)).toContain("Buoy is charged.");
    expect(messages.filter((m) => m.clientId === "p_1")).toHaveLength(1);
    await api.markChannelRead({ workspaceId, channelId });
    expect((await api.listChannels({ workspaceId })).find((c) => c.id === channelId)?.unreadCount).toBe(0);
  });

  test("creating a workspace makes its #general and lists it in getMe", async () => {
    const { api } = setup();
    const created = await api.createWorkspace({ body: { name: "Dune Works" } });
    const channels = await api.listChannels({ workspaceId: created.workspace.id });
    expect(channels).toHaveLength(1);
    expect(channels[0]?.id).toBe(created.defaultChannelId);
    expect((await api.getMe())?.workspaces.map((w) => w.name)).toContain("Dune Works");
  });

  test("reactions add up per person and come off again", async () => {
    const { api, workspaceId } = setup();
    const added = await api.createMessageReaction({
      workspaceId,
      messageId: "msg_1",
      body: { reaction: "🌊" },
    });
    expect(added).toEqual([{ reaction: "🌊", count: 1, userIds: ["user_ada"], agentIds: [] }]);
    const removed = await api.clearMessageReactions({
      workspaceId,
      messageId: "msg_1",
      query: { reaction: "🌊" },
    });
    expect(removed).toEqual([]);
  });

  test("failures use the server's error envelope", async () => {
    const { api, workspaceId, server } = setup();
    const taken = await api
      .createChannel({ workspaceId, body: { name: "general", visibility: "public" } })
      .catch((e) => e);
    expect(taken).toBeInstanceOf(ApiError);
    expect(taken).toMatchObject({ status: 409, code: "channel.name_taken", params: { name: "general" } });

    const missing = await api.getWorkspace({ workspaceId: "workspace_nope" }).catch((e) => e);
    expect(missing).toMatchObject({ status: 404, code: "not_found" });

    const bad = await api
      .createChannel({ workspaceId, body: { name: "x", visibility: "secret" as "public" } })
      .catch((e) => e);
    expect(bad).toMatchObject({ status: 400, code: "invalid_request" });

    const notYet = await api.listAgents({ workspaceId }).catch((e) => e);
    expect(notYet).toMatchObject({ status: 501, code: "route_not_found" });

    server.signIn(null);
    expect(await api.getMe()).toBeNull();
    expect(await api.listChannels({ workspaceId }).catch((e) => e)).toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  test("a person who isn't a member can't read a private channel", async () => {
    const { api, workspaceId, server } = setup();
    const secret = await api.createChannel({ workspaceId, body: { name: "board", visibility: "private" } });
    const msg = await api.createChannelMessage({
      workspaceId,
      channelId: secret.id,
      body: { body: "private", clientId: "secret" },
    });
    server.signIn("user_sam");
    expect((await api.listChannels({ workspaceId })).map((c) => c.id)).not.toContain(secret.id);
    const err = await api.listChannelMessages({ workspaceId, channelId: secret.id }).catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: "not_found" });
    const args = { workspaceId, messageId: msg.id };
    const results = await Promise.allSettled([
      api.listMessageReactions(args),
      api.createMessageReaction({ ...args, body: { reaction: "x" } }),
      api.clearMessageReactions({ ...args, query: { reaction: "x" } }),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ status: "rejected", reason: { code: "not_found" } });
    server.signIn("user_ada");
    expect(await api.listMessageReactions(args)).toEqual([]);
  });
});
