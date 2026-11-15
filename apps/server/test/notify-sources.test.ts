// Where the conversation's notices come from (notify-sources): a mention, a DM, a reply in a followed thread
// and a reaction, with the reading fence of a private channel. The messages are written straight to the
// database, as chat would (the chat routes come with slice S6).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import type { ChannelRow } from "../src/channels";
import { createWorkspace, joinWorkspace } from "../src/members";
import { notifyForMessage, notifyReaction } from "../src/notify-sources";
import type { RunningServer } from "../src/server";
import { startTestServer } from "./harness";

// Many HTTP calls per test against a real server: a loaded host needs more than the default 5 s.
setDefaultTimeout(30_000);

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.stop());

let n = 0;
async function person(workspaceId: string | null, name: string) {
  const id = `u_${name.toLowerCase()}${++n}`;
  await server.deps.db.insert(schema.users).values({ id, name, email: `${id}@sources.test` });
  if (workspaceId) await joinWorkspace(server.deps.db, { workspaceId, userId: id, name, role: "member" });
  return { id, name };
}

async function setup() {
  const db = server.deps.db;
  const ana = await person(null, "Ana");
  const { workspaceId, defaultChannelId } = await createWorkspace(db, {
    name: "Sources",
    context: "",
    user: ana,
  });
  const beto = await person(workspaceId, "Beto");
  const caio = await person(workspaceId, "Caio");
  const channel = async (kind: "channel" | "dm", visibility: "public" | "private", memberIds: string[]) => {
    const [row] = await db
      .insert(schema.channels)
      .values({ id: newId("ch"), workspaceId, name: `c${++n}`, visibility, kind, createdBy: ana.id })
      .returning();
    if (!row) throw new Error("channel insert failed");
    for (const id of memberIds) {
      await db
        .insert(schema.channelMemberships)
        .values({ channelId: row.id, memberType: "person", memberId: id });
    }
    return row;
  };
  const [general] = await db.select().from(schema.channels).where(eq(schema.channels.id, defaultChannelId));
  if (!general) throw new Error("no #general");
  return { workspaceId, general, ana, beto, caio, channel };
}

async function post(
  channel: ChannelRow,
  author: { type: "person" | "agent"; id: string },
  body: string,
  extra: { mentionedUserIds?: string[]; threadId?: string } = {},
) {
  const [row] = await server.deps.db
    .insert(schema.messages)
    .values({
      id: newId("msg"),
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      authorKind: author.type,
      authorId: author.id,
      body,
      mentionedUserIds: extra.mentionedUserIds ?? [],
      threadId: extra.threadId ?? null,
    })
    .returning();
  if (!row) throw new Error("message insert failed");
  await notifyForMessage(server.deps, { row, channel, author });
  return row;
}

async function noticesOf(workspaceId: string, userId: string) {
  return server.deps.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.userId, userId)));
}

describe("notices of a new message", () => {
  test("a DM tells every other person in it, as one row per DM; the author gets nothing", async () => {
    const { workspaceId, ana, beto, caio, channel } = await setup();
    const dm = await channel("dm", "private", [ana.id, beto.id, caio.id]);
    await post(dm, { type: "person", id: ana.id }, "first");
    await post(dm, { type: "person", id: ana.id }, "second");
    for (const who of [beto, caio]) {
      const [row, ...rest] = await noticesOf(workspaceId, who.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        kind: "dm",
        groupKey: `dm:${dm.id}`,
        count: 2,
        tab: "action_needed",
        source: { channelId: dm.id, dmId: dm.id },
        latest: { text: "second" },
        actors: [{ type: "person", id: ana.id }],
      });
      expect(row?.source.label).toBeUndefined();
    }
    expect(await noticesOf(workspaceId, ana.id)).toEqual([]);
  });

  test("a mention tells whoever can read the channel; a mention of yourself or of an outsider to a private channel doesn't", async () => {
    const { workspaceId, general, ana, beto, caio, channel } = await setup();
    const long = "x".repeat(200);
    await post(general, { type: "person", id: ana.id }, long, { mentionedUserIds: [beto.id, ana.id] });
    const [mention] = await noticesOf(workspaceId, beto.id);
    expect(mention).toMatchObject({ kind: "mention", source: { label: `#${general.name}` } });
    expect(String(mention?.latest.text).length).toBe(160);
    expect(String(mention?.latest.text).endsWith("…")).toBe(true);
    expect(await noticesOf(workspaceId, ana.id)).toEqual([]);

    const secret = await channel("channel", "private", [ana.id, beto.id]);
    await post(secret, { type: "person", id: ana.id }, "only for us", {
      mentionedUserIds: [beto.id, caio.id],
    });
    expect((await noticesOf(workspaceId, beto.id)).length).toBe(2);
    expect(await noticesOf(workspaceId, caio.id)).toEqual([]);
  });

  test("a reply in a followed thread tells the followers once, not who left the private channel or unfollowed", async () => {
    const { workspaceId, ana, beto, caio, channel } = await setup();
    const db = server.deps.db;
    const room = await channel("channel", "private", [ana.id, beto.id, caio.id]);
    const root = await post(room, { type: "person", id: ana.id }, "root");
    await db.insert(schema.threads).values({
      id: root.id,
      workspaceId,
      channelId: room.id,
      createdByType: "person",
      createdById: ana.id,
      lastTouchedAt: new Date(),
    });
    const dora = await person(workspaceId, "Dora");
    await db.insert(schema.threadSubscriptions).values([
      { threadId: root.id, userId: beto.id, following: true },
      { threadId: root.id, userId: caio.id, following: true },
      { threadId: root.id, userId: dora.id, following: false },
      { threadId: root.id, userId: ana.id, following: true },
    ]);
    // Caio left the private channel after following.
    await db
      .delete(schema.channelMemberships)
      .where(
        and(
          eq(schema.channelMemberships.channelId, room.id),
          eq(schema.channelMemberships.memberId, caio.id),
        ),
      );
    await post(room, { type: "agent", id: "ag_helper" }, "reply one", {
      threadId: root.id,
      mentionedUserIds: [beto.id],
    });
    await post(room, { type: "agent", id: "ag_helper" }, "reply two", { threadId: root.id });

    const beto2 = await noticesOf(workspaceId, beto.id);
    expect(beto2.map((r) => r.kind).sort()).toEqual(["mention", "thread_followup"]);
    expect(beto2.find((r) => r.kind === "thread_followup")).toMatchObject({
      groupKey: `thread:${root.id}`,
      count: 1,
      source: { threadId: root.id },
    });
    // An agent's reply notifies the author of the root too (only a person never hears of their own message).
    expect((await noticesOf(workspaceId, ana.id)).map((r) => r.count)).toEqual([2]);
    expect(await noticesOf(workspaceId, caio.id)).toEqual([]);
    expect(await noticesOf(workspaceId, dora.id)).toEqual([]);
  });
});

describe("notices of a reaction", () => {
  test("reactions to one message add up in one row; removing them shrinks it and the last one hides it", async () => {
    const { workspaceId, general, ana, beto, caio } = await setup();
    const db = server.deps.db;
    const msg = await post(general, { type: "person", id: ana.id }, "my message");
    const react = async (who: { id: string }, reaction: string) => {
      await db
        .insert(schema.emojiReactions)
        .values({ messageId: msg.id, reaction, actorType: "person", actorId: who.id });
      await notifyReaction(server.deps, {
        message: msg,
        actor: { type: "person", id: who.id },
        reaction,
        added: true,
      });
    };
    const unreact = async (who: { id: string }, reaction: string) => {
      await db
        .delete(schema.emojiReactions)
        .where(
          and(
            eq(schema.emojiReactions.messageId, msg.id),
            eq(schema.emojiReactions.actorId, who.id),
            eq(schema.emojiReactions.reaction, reaction),
          ),
        );
      await notifyReaction(server.deps, {
        message: msg,
        actor: { type: "person", id: who.id },
        reaction,
        added: false,
      });
    };
    await react(beto, "🎉");
    await react(caio, "👍");
    // The author's own reaction tells nobody and doesn't count.
    await react(ana, "👀");
    let [row] = await noticesOf(workspaceId, ana.id);
    expect(row).toMatchObject({
      kind: "reaction",
      groupKey: `reaction:${msg.id}`,
      tab: "fyi",
      count: 2,
      latest: { quote: "my message", emojis: ["🎉", "👍"] },
    });
    expect(row?.actors.map((a) => a.id)).toEqual([caio.id, beto.id]);

    await unreact(caio, "👍");
    [row] = await noticesOf(workspaceId, ana.id);
    expect(row).toMatchObject({ count: 1, doneAt: null, latest: { quote: "my message", emojis: ["🎉"] } });
    expect(row?.actors.map((a) => a.id)).toEqual([beto.id]);
    await unreact(beto, "🎉");
    [row] = await noticesOf(workspaceId, ana.id);
    expect(row).toMatchObject({ count: 0, actors: [], latest: { quote: "my message", emojis: [] } });
    expect(row?.doneAt).not.toBeNull();
  });

  test("removing a reaction after the author leaves a private channel reveals no new activity", async () => {
    const { workspaceId, ana, beto, caio, channel } = await setup();
    const db = server.deps.db;
    const room = await channel("channel", "private", [ana.id, beto.id, caio.id]);
    const msg = await post(room, { type: "person", id: ana.id }, "private message");
    const react = async (id: string, added: boolean) => {
      if (added) {
        await db
          .insert(schema.emojiReactions)
          .values({ messageId: msg.id, actorType: "person", actorId: id, reaction: "👍" });
      } else {
        await db
          .delete(schema.emojiReactions)
          .where(and(eq(schema.emojiReactions.messageId, msg.id), eq(schema.emojiReactions.actorId, id)));
      }
      await notifyReaction(server.deps, {
        message: msg,
        actor: { type: "person", id },
        reaction: "👍",
        added,
      });
      await server.deps.runtime.settle();
    };
    await react(beto.id, true);
    const before = await noticesOf(workspaceId, ana.id);
    expect(before[0]).toMatchObject({ count: 1, actors: [{ type: "person", id: beto.id }] });
    await db
      .delete(schema.channelMemberships)
      .where(
        and(eq(schema.channelMemberships.channelId, room.id), eq(schema.channelMemberships.memberId, ana.id)),
      );
    const events: string[] = [];
    const stop = server.deps.hub.onPublish((target, event) => {
      if (target === `user:${workspaceId}:${ana.id}`) events.push(event.type);
    });
    try {
      await react(caio.id, true);
      await react(beto.id, false);
      expect(await noticesOf(workspaceId, ana.id)).toEqual(before);
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a reaction to an agent's message, or by an author who can no longer read the channel, tells nobody", async () => {
    const { workspaceId, general, ana, beto, channel } = await setup();
    const fromAgent = await post(general, { type: "agent", id: "ag_x" }, "agent says");
    await notifyReaction(server.deps, {
      message: fromAgent,
      actor: { type: "person", id: beto.id },
      reaction: "👍",
      added: true,
    });
    const room = await channel("channel", "private", [beto.id]);
    const [old] = await server.deps.db
      .insert(schema.messages)
      .values({
        id: newId("msg"),
        workspaceId,
        channelId: room.id,
        authorKind: "person",
        authorId: ana.id,
        body: "old",
      })
      .returning();
    if (!old) throw new Error("message insert failed");
    await notifyReaction(server.deps, {
      message: old,
      actor: { type: "person", id: beto.id },
      reaction: "👍",
      added: true,
    });
    expect(await noticesOf(workspaceId, ana.id)).toEqual([]);
  });
});
