// Where the conversation's notices come from: a mention, a DM, a reply in a thread the person follows and a
// reaction to their message. Whoever wrote never gets a notice of what they did themselves.
import { type Db, schema } from "@vanr/engine/db";
import { and, desc, eq } from "drizzle-orm";
import { type ChannelRow, canReadChannel } from "./channels";
import type { AppDeps } from "./context";
import { shownBody } from "./messages";
import { notify, shrinkGroup } from "./notifications";

const { channelMemberships, threadSubscriptions, messages, emojiReactions } = schema;
type MessageRow = typeof messages.$inferSelect;
type Actor = { type: "person" | "agent"; id: string };

const EXCERPT = 160;
const excerpt = (body: string) => (body.length > EXCERPT ? `${body.slice(0, EXCERPT - 1)}…` : body);

async function dmPartners(db: Db, channelId: string): Promise<string[]> {
  const rows = await db
    .select({ id: channelMemberships.memberId })
    .from(channelMemberships)
    .where(and(eq(channelMemberships.channelId, channelId), eq(channelMemberships.memberType, "person")));
  return rows.map((r) => r.id);
}

/** Notices of a new message. */
export async function notifyForMessage(
  deps: AppDeps,
  input: { row: MessageRow; channel: ChannelRow; author: Actor },
): Promise<void> {
  const { row, channel, author } = input;
  const { db } = deps;
  const notified = new Set<string>();
  if (author.type === "person") notified.add(author.id);
  const source = {
    channelId: channel.id,
    messageId: row.id,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    label: channel.kind === "dm" ? undefined : `#${channel.name}`,
  };
  const latest = { text: excerpt(row.body) };

  if (channel.kind === "dm") {
    for (const userId of await dmPartners(db, channel.id)) {
      if (notified.has(userId)) continue;
      notified.add(userId);
      await notify(deps, {
        workspaceId: row.workspaceId,
        userId,
        kind: "dm",
        groupKey: `dm:${channel.id}`,
        actor: author,
        source: { ...source, dmId: channel.id },
        latest,
      });
    }
    return;
  }

  for (const userId of row.mentionedUserIds) {
    if (notified.has(userId)) continue;
    notified.add(userId);
    // A mention in a private channel of someone who isn't in it doesn't become a notice (they couldn't open it).
    if (!(await canReadChannel(db, { workspaceId: row.workspaceId, userId, channelId: channel.id })))
      continue;
    await notify(deps, {
      workspaceId: row.workspaceId,
      userId,
      kind: "mention",
      groupKey: `mention:${row.id}`,
      actor: author,
      source,
      latest,
    });
  }

  if (row.threadId) {
    const followers = await db
      .select({ userId: threadSubscriptions.userId })
      .from(threadSubscriptions)
      .where(and(eq(threadSubscriptions.threadId, row.threadId), eq(threadSubscriptions.following, true)));
    for (const { userId } of followers) {
      if (notified.has(userId)) continue;
      notified.add(userId);
      // Whoever followed and left the private channel no longer gets the replies' text.
      if (!(await canReadChannel(db, { workspaceId: row.workspaceId, userId, channelId: channel.id })))
        continue;
      await notify(deps, {
        workspaceId: row.workspaceId,
        userId,
        kind: "thread_followup",
        groupKey: `thread:${row.threadId}`,
        actor: author,
        source,
        latest,
      });
    }
  }
}

/** A reaction to a person's message: tells the author (reactions to the same message become a single row). */
export async function notifyReaction(
  deps: AppDeps,
  input: { message: MessageRow; actor: Actor; reaction: string; added: boolean },
): Promise<void> {
  const { message, actor } = input;
  if (message.authorKind !== "person") return;
  if (actor.type === "person" && actor.id === message.authorId) return;
  const groupKey = `reaction:${message.id}`;
  // An author who lost access to the channel (left the private one) gets no notice with the message's excerpt.
  if (
    !(await canReadChannel(deps.db, {
      workspaceId: message.workspaceId,
      userId: message.authorId,
      channelId: message.channelId,
    }))
  )
    return;
  if (!input.added) {
    // The notice now counts what is left on the message (without the author's own reactions).
    const rows = await deps.db
      .select({
        type: emojiReactions.actorType,
        id: emojiReactions.actorId,
        reaction: emojiReactions.reaction,
      })
      .from(emojiReactions)
      .where(eq(emojiReactions.messageId, message.id))
      .orderBy(desc(emojiReactions.createdAt));
    const others = rows.filter((r) => !(r.type === "person" && r.id === message.authorId));
    const actors = [...new Map(others.map(({ type, id }) => [`${type}:${id}`, { type, id }])).values()];
    const emojis = [...new Set(others.map((r) => r.reaction))];
    await shrinkGroup(deps, message.workspaceId, groupKey, { count: others.length, actors, emojis });
    return;
  }
  await notify(deps, {
    workspaceId: message.workspaceId,
    userId: message.authorId,
    kind: "reaction",
    groupKey,
    actor,
    source: {
      channelId: message.channelId,
      messageId: message.id,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    },
    latest: { quote: excerpt(shownBody(message)), emojis: [input.reaction] },
  });
}
