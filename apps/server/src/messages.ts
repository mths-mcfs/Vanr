// Messages: the API format, reactions and posting (used by the route and, later, by the agents).
import type {
  ActorRef,
  AgentAction,
  AgentActionKind,
  Message,
  MessageMemory,
  MessageMeta,
  MessageReceipts,
  ReactionCount,
  ReplyRef,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { parseMentions } from "@vanr/engine/text";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ChannelRow } from "./channels";
import type { AppDeps } from "./context";
import { isUniqueViolation } from "./db-errors";
import { badRequest } from "./http";
import { notifyForMessage } from "./notify-sources";
import { reindex } from "./search-index";
import { publishThread } from "./threads";

const {
  messages,
  emojiReactions,
  members,
  users,
  threads,
  threadSubscriptions,
  agents,
  memories,
  messageDispatches,
  reversibleActions,
} = schema;

export type MessageRow = typeof messages.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const EXCERPT = 140;
export const excerpt = (body: string) => (body.length > EXCERPT ? `${body.slice(0, EXCERPT - 1)}…` : body);

export async function reactionsFor(db: Db, messageIds: string[]): Promise<Map<string, ReactionCount[]>> {
  const out = new Map<string, ReactionCount[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(emojiReactions)
    .where(inArray(emojiReactions.messageId, messageIds))
    .orderBy(asc(emojiReactions.createdAt));
  for (const r of rows) {
    let list = out.get(r.messageId);
    if (!list) {
      list = [];
      out.set(r.messageId, list);
    }
    let entry = list.find((e) => e.reaction === r.reaction);
    if (!entry) {
      entry = { reaction: r.reaction, count: 0, userIds: [], agentIds: [] };
      list.push(entry);
    }
    entry.count++;
    (r.actorType === "person" ? entry.userIds : entry.agentIds).push(r.actorId);
  }
  return out;
}

export interface MessageExtras {
  reactions?: ReactionCount[];
  memories?: MessageMemory[];
  receipts?: MessageReceipts;
  actions?: AgentAction[];
}

const noReceipts = (): MessageReceipts => ({ viewedBy: [], claimedBy: [], handled: [] });

/**
 * The column is written only by the server, always from a `MessageMeta` (postMessage and the routes that
 * rewrite a card); the schema types it as a plain record.
 */
const metaOf = (row: MessageRow): MessageMeta => row.meta as MessageMeta;

export function toMessage(row: MessageRow, extras: MessageExtras = {}): Message {
  return {
    id: row.id,
    channelId: row.channelId,
    threadId: row.threadId,
    author: { type: row.authorKind, id: row.authorId },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    meta: metaOf(row),
    reactions: extras.reactions ?? [],
    memories: extras.memories ?? [],
    runId: row.runId,
    agentMentionIds: row.agentMentionIds,
    receipts: extras.receipts ?? noReceipts(),
    clientId: row.clientId,
    usage: row.usage ?? null,
    replyCount: row.replyCount,
    actions: extras.actions ?? [],
  };
}

/** Memories saved from each message (archived ones don't show). */
export async function memoriesFor(db: Db, messageIds: string[]): Promise<Map<string, MessageMemory[]>> {
  const out = new Map<string, MessageMemory[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      id: memories.id,
      agentId: memories.agentId,
      text: memories.text,
      messageId: memories.originMessageId,
    })
    .from(memories)
    // Only the agent's store: the person's is theirs and doesn't show in the conversation.
    .where(
      and(
        inArray(memories.originMessageId, messageIds),
        eq(memories.archived, false),
        eq(memories.scope, "agent"),
      ),
    )
    .orderBy(asc(memories.createdAt));
  for (const r of rows) {
    if (!r.messageId || !r.agentId) continue;
    const list = out.get(r.messageId) ?? [];
    list.push({ id: r.id, agentId: r.agentId, text: r.text });
    out.set(r.messageId, list);
  }
  return out;
}

const ACTION_KINDS: Record<AgentActionKind, true> = {
  base_rows_upserted: true,
  calendar_event_created: true,
  channel_created: true,
  file_created: true,
  file_updated: true,
  issue_commented: true,
  issue_edited: true,
  issue_opened: true,
  mail_sent: true,
  memory_recorded: true,
  message_posted: true,
  proposal_applied: true,
  reminder_created: true,
  routine_scheduled: true,
  wiki_updated: true,
  wiki_written: true,
};
const isActionKind = (kind: string): kind is AgentActionKind => Object.hasOwn(ACTION_KINDS, kind);

/** The agent actions hanging from each message (undo); a row of a kind this server doesn't know is skipped. */
export function toAction(row: typeof reversibleActions.$inferSelect): AgentAction | null {
  const { kind } = row;
  if (!isActionKind(kind)) return null;
  return {
    id: row.id,
    kind,
    messageId: row.messageId,
    agentId: row.agentId,
    requesterUserId: row.requesterUserId,
    target: row.target,
    params: row.params,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    reverterUserId: row.reverterUserId,
    revertibleUntil: row.revertibleUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** message.actions_updated: the message's whole list of actions, in its channel. */
export async function publishActions(deps: AppDeps, messageId: string) {
  const [msg] = await deps.db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, messageId));
  if (!msg) return;
  const actions = (await actionsFor(deps.db, [messageId])).get(messageId) ?? [];
  deps.hub.toChannel(msg.channelId, { type: "message.actions_updated", messageId, actions });
}

export async function actionsFor(db: Db, messageIds: string[]): Promise<Map<string, AgentAction[]>> {
  const out = new Map<string, AgentAction[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(reversibleActions)
    .where(inArray(reversibleActions.messageId, messageIds))
    .orderBy(asc(reversibleActions.createdAt));
  for (const r of rows) {
    const action = toAction(r);
    if (!r.messageId || !action) continue;
    const list = out.get(r.messageId) ?? [];
    list.push(action);
    out.set(r.messageId, list);
  }
  return out;
}

/** Receipts: agents that saw it (routed), claimed it, handled it or could not answer. */
export async function receiptsFor(db: Db, messageIds: string[]): Promise<Map<string, MessageReceipts>> {
  const out = new Map<string, MessageReceipts>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(messageDispatches)
    .where(inArray(messageDispatches.messageId, messageIds))
    .orderBy(asc(messageDispatches.at));
  for (const r of rows) {
    const rec = out.get(r.messageId) ?? noReceipts();
    out.set(r.messageId, rec);
    if (r.state === "blocked") {
      rec.blocked = [...(rec.blocked ?? []), { agentId: r.agentId, reason: r.reason ?? "blocked" }];
      continue;
    }
    rec.viewedBy.push(r.agentId);
    if (r.state === "claimed" || r.state === "handled") rec.claimedBy.push(r.agentId);
    if (r.state === "handled" && r.runId && r.status) {
      rec.handled.push({ agentId: r.agentId, runId: r.runId, status: r.status });
    }
  }
  return out;
}

/** Attachments that went to the trash (or were deleted for good) show as removed. */
async function goneFiles(db: Db, rows: MessageRow[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const r of rows) for (const a of metaOf(r).files ?? []) ids.add(a.id);
  if (ids.size === 0) return ids;
  const live = await db
    .select({ id: schema.files.id })
    .from(schema.files)
    .where(and(inArray(schema.files.id, [...ids]), isNull(schema.files.deletedAt)));
  for (const { id } of live) ids.delete(id);
  return ids;
}

/** Messages in the API format, with reactions, memories and receipts. */
export async function hydrate(db: Db, rows: MessageRow[]): Promise<Message[]> {
  const ids = rows.map((r) => r.id);
  const [reactions, mems, receipts, actions, gone] = await Promise.all([
    reactionsFor(db, ids),
    memoriesFor(db, ids),
    receiptsFor(db, ids),
    actionsFor(db, ids),
    goneFiles(db, rows),
  ]);
  return rows.map((r) => {
    const message = toMessage(r, {
      reactions: reactions.get(r.id),
      memories: mems.get(r.id),
      receipts: receipts.get(r.id),
      actions: actions.get(r.id),
    });
    const refs = message.meta.files;
    if (!refs?.some((a) => gone.has(a.id))) return message;
    return {
      ...message,
      meta: { ...message.meta, files: refs.map((a) => ({ ...a, deleted: gone.has(a.id) })) },
    };
  });
}

export async function hydrateOne(db: Db, row: MessageRow): Promise<Message> {
  const [message] = await hydrate(db, [row]);
  if (!message) throw new Error("hydrate returned nothing");
  return message;
}

export async function messageInWorkspace(
  db: Db,
  workspaceId: string,
  messageId: string,
): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  return row ?? null;
}

/** The channel's "#name", or "DM". For the origin of memories. */
export async function channelNameOf(db: Db, channelId: string): Promise<string> {
  const [row] = await db
    .select({ name: schema.channels.name, kind: schema.channels.kind })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId));
  return row?.kind === "channel" ? `#${row.name}` : "DM";
}

/** The display name of an author, person or agent. */
export async function actorName(db: Db, workspaceId: string, actor: ActorRef): Promise<string> {
  if (actor.type === "person") {
    const [row] = await db
      .select({ name: users.name })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, actor.id)));
    return row?.name ?? "";
  }
  const [row] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, actor.id)));
  return row?.name ?? "";
}

export interface PostMessageInput {
  workspaceId: string;
  channel: ChannelRow;
  author: ActorRef;
  body: string;
  /** Id generated by the client: the same clientId returns the same message (safe resend). */
  clientId: string | null;
  threadId?: string | null;
  replyTo?: string | null;
  meta?: MessageMeta;
  runId?: string | null;
  usage?: MessageRow["usage"];
  /** The caller's part of the post (a person's join and routing): see `PostEffects`. */
  then?: PostEffects;
}

/**
 * The caller's part of a post, run after the post's own effects. A resend of the clientId runs it again while
 * the post isn't settled (a first request that failed before or inside it); once it resolves, the post is, unless
 * it resolves false (a part that failed without failing the request, like a person's routing).
 */
export type PostEffects = (message: Message) => Promise<boolean | undefined>;

export interface PostedMessage {
  message: Message;
  created: boolean;
}

export async function postMessage(deps: AppDeps, input: PostMessageInput): Promise<PostedMessage> {
  const { db } = deps;
  const { workspaceId, channel, author } = input;
  if (input.clientId) {
    const existing = await byClientId(db, channel.id, author.id, input.clientId);
    if (existing) return { message: await resumePost(deps, existing, channel, input.then), created: false };
  }

  let root: MessageRow | null = null;
  if (input.threadId) {
    root = await messageInWorkspace(db, workspaceId, input.threadId);
    if (!root || root.channelId !== channel.id || root.threadId !== null) {
      throw badRequest("Thread not found in this channel", { field: "threadId" });
    }
  }

  const meta: MessageMeta = { ...(input.meta ?? {}) };
  if (input.replyTo) meta.replyTo = await replyRef(db, workspaceId, channel.id, input.replyTo);

  const handles = parseMentions(input.body);
  const agentMentionIds = handles.length
    ? (
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, workspaceId),
              inArray(agents.handle, handles),
              isNull(agents.archivedAt),
            ),
          )
      )
        .map((r) => r.id)
        .filter((id) => !(author.type === "agent" && id === author.id))
    : [];
  const mentionedUserIds = handles.length
    ? (
        await db
          .select({ userId: members.userId })
          .from(members)
          .where(and(eq(members.workspaceId, workspaceId), inArray(members.handle, handles)))
      )
        .map((r) => r.userId)
        .filter((id) => !(author.type === "person" && id === author.id))
    : [];

  let row: MessageRow;
  try {
    const insert = async (q: Db | Tx) => {
      const [inserted] = await q
        .insert(messages)
        .values({
          id: newId("msg"),
          workspaceId,
          channelId: channel.id,
          threadId: root?.id ?? null,
          authorKind: author.type,
          authorId: author.id,
          body: input.body,
          meta,
          clientId: input.clientId,
          runId: input.runId ?? null,
          agentMentionIds,
          mentionedUserIds,
          usage: input.usage ?? null,
          effectsPending: true,
        })
        .returning();
      if (!inserted) throw new Error("insert returned nothing");
      return inserted;
    };
    const thread = root;
    // A reply's count on the root goes in with the reply: the one effect that isn't safe to run twice.
    row = thread
      ? await db.transaction(async (tx) => {
          const inserted = await insert(tx);
          await countReply(tx, thread, deps.now());
          return inserted;
        })
      : await insert(db);
  } catch (err) {
    // Two sends of the same clientId at once: the unique index picks one and the other returns it.
    if (input.clientId && isUniqueViolation(err)) {
      const existing = await byClientId(db, channel.id, author.id, input.clientId);
      if (existing) return { message: await resumePost(deps, existing, channel, input.then), created: false };
    }
    throw err;
  }
  const message = toMessage(row);
  await settlePost(deps, row, message, channel, root, input.then);
  return { message, created: true };
}

/** Posts settling in this process now: a resend that comes meanwhile leaves them to the request that posted. */
const settling = new Map<string, Promise<void>>();

/**
 * A resend of a post already written: what the first request left undone runs now (it failed, or the server fell
 * in the middle). A request still at it is waited for, and its failure leaves the work to this one. Returns the
 * message as it is.
 */
export async function resumePost(
  deps: AppDeps,
  row: MessageRow,
  channel: ChannelRow,
  then?: PostEffects,
): Promise<Message> {
  await settling.get(row.id)?.catch(() => {});
  if (row.effectsPending) {
    const root = row.threadId ? await messageInWorkspace(deps.db, row.workspaceId, row.threadId) : null;
    await settlePost(deps, row, toMessage(row), channel, root, then, row.createdAt);
  }
  return hydrateOne(deps.db, row);
}

/**
 * The post's effects, then the caller's; the post is settled once they all ran. One settle per post at a time: a
 * resend joins the one under way, and a resend's settle reads the mark again first (another may have just
 * finished). Each effect is safe to run again except the notices, whose count a resend after a failure past them
 * can raise once more. `at` is the reply's time for the thread (the post's own, on a resend).
 */
function settlePost(
  deps: AppDeps,
  row: MessageRow,
  message: Message,
  channel: ChannelRow,
  root: MessageRow | null,
  then: PostEffects | undefined,
  resent: Date | null = null,
): Promise<void> {
  const running = settling.get(row.id);
  if (running) return running;
  const work = (async () => {
    if (resent) {
      const [mark] = await deps.db
        .select({ pending: messages.effectsPending })
        .from(messages)
        .where(eq(messages.id, row.id));
      if (!mark?.pending) return;
    }
    const author = { type: row.authorKind, id: row.authorId };
    await reindex(deps, { kind: "message", id: row.id });
    deps.hub.toChannel(channel.id, { type: "message.posted", message });
    if (!row.threadId) await announceUnread(deps, channel.id, author);
    if (root) await touchThread(deps, { root, reply: row, author, at: resent ?? deps.now() });
    await notifyForMessage(deps, { row, channel, author });
    if ((await then?.(message)) === false) return;
    await deps.db.update(messages).set({ effectsPending: false }).where(eq(messages.id, row.id));
  })().finally(() => {
    if (settling.get(row.id) === work) settling.delete(row.id);
  });
  settling.set(row.id, work);
  return work;
}

/**
 * `message.posted` only reaches whoever has the channel open (subscribed). The other members get
 * `channel.unread` so the sidebar fetches the counter again; without it the counter stood still until the poll.
 */
async function announceUnread(deps: AppDeps, channelId: string, author: { type: string; id: string }) {
  const people = await deps.db
    .select({ id: schema.channelMemberships.memberId, workspaceId: schema.channels.workspaceId })
    .from(schema.channelMemberships)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMemberships.channelId))
    .where(
      and(
        eq(schema.channelMemberships.channelId, channelId),
        eq(schema.channelMemberships.memberType, "person"),
      ),
    );
  for (const p of people)
    if (!(author.type === "person" && author.id === p.id))
      deps.hub.toUser(p.workspaceId, p.id, { type: "channel.unread", channelId });
}

/** The message this author already posted in the channel with this clientId (a resend), if any. */
export async function byClientId(db: Db, channelId: string, authorId: string, clientId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.authorId, authorId),
        eq(messages.clientId, clientId),
      ),
    );
  return row ?? null;
}

async function replyRef(
  db: Db,
  workspaceId: string,
  channelId: string,
  messageId: string,
): Promise<ReplyRef> {
  const target = await messageInWorkspace(db, workspaceId, messageId);
  if (!target || target.channelId !== channelId) {
    throw badRequest("Quoted message not found in this channel", { field: "replyTo" });
  }
  const author = { type: target.authorKind, id: target.authorId };
  return {
    messageId: target.id,
    threadId: target.threadId,
    author,
    authorName: await actorName(db, workspaceId, author),
    excerpt: excerpt(target.body),
  };
}

/** A thread reply: counts on the root, creates the thread state if missing and follows who took part. */
/** The root's reply count and last reply, in the reply's own transaction. */
async function countReply(tx: Tx, root: MessageRow, at: Date) {
  await tx
    .update(messages)
    .set({
      replyCount: sql`${messages.replyCount} + 1`,
      lastReplyAt: sql`greatest(${messages.lastReplyAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(messages.id, root.id));
}

/** The thread's state for a new reply: every step is safe to run again (a resend that settles the reply). */
async function touchThread(
  deps: AppDeps,
  input: { root: MessageRow; reply: MessageRow; author: ActorRef; at: Date },
) {
  const { db } = deps;
  const { root, reply, author, at } = input;
  const atSql = sql`${at.toISOString()}::timestamptz`;
  await ensureThread(db, { root, by: author, at });
  // One statement each, and only forward: two replies at once leave the later one (in the page's order, created
  // at then id) as the last message, whichever update lands last.
  await db
    .update(threads)
    .set({
      firstReplyAt: sql`coalesce(${threads.firstReplyAt}, ${atSql})`,
      lastTouchedAt: sql`greatest(${threads.lastTouchedAt}, ${atSql})`,
      // Both times as stored (microseconds): the reply's JS date has only milliseconds.
      lastMessageId: sql`case when coalesce((
          select (l.created_at, l.id) < (r.created_at, r.id)
          from ${messages} l, ${messages} r where l.id = ${threads.lastMessageId} and r.id = ${reply.id}
        ), true) then ${reply.id} else ${threads.lastMessageId} end`,
    })
    .where(eq(threads.id, root.id));
  const followers = [author, { type: root.authorKind, id: root.authorId }].filter((a) => a.type === "person");
  for (const f of followers) {
    await db
      .insert(threadSubscriptions)
      .values({ threadId: root.id, userId: f.id, following: true, updatedAt: at })
      .onConflictDoNothing();
  }
  await publishThread(deps, root.id);
}

/**
 * Creates the thread's state row if it doesn't exist yet, and says whether it did. The root must be a top-level
 * message. An existing thread is never touched: its title, state and opener stay.
 */
export async function ensureThread(
  db: Db,
  input: { root: MessageRow; by: ActorRef; at: Date; title?: string },
): Promise<boolean> {
  const { root, by, at } = input;
  const created = await db
    .insert(threads)
    .values({
      id: root.id,
      workspaceId: root.workspaceId,
      channelId: root.channelId,
      title: input.title ?? "",
      createdByType: by.type,
      createdById: by.id,
      lastTouchedAt: at,
      firstReplyAt: input.title === undefined ? at : null,
    })
    .onConflictDoNothing()
    .returning({ id: threads.id });
  return created.length > 0;
}

/** A channel's messages, in posting order. `before` is the id of the message used as the cursor. */
export async function listMessages(
  db: Db,
  input: { channelId: string; threadId?: string; before?: string; limit: number },
): Promise<MessageRow[]> {
  const where = [eq(messages.channelId, input.channelId)];
  where.push(input.threadId ? eq(messages.threadId, input.threadId) : isNull(messages.threadId));
  if (!input.threadId) {
    where.push(sql`not exists (
      select 1 from ${threads} t where t.id = ${messages.id} and t.source_channel_id is not null)`);
  }
  if (input.before) {
    const [cursor] = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, input.before), eq(messages.channelId, input.channelId)));
    if (!cursor) throw badRequest("Unknown cursor", { field: "before" });
    where.push(
      sql`(${messages.createdAt}, ${messages.id}) < (select created_at, id from messages where id = ${cursor.id})`,
    );
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(...where))
    .orderBy(sql`${messages.createdAt} desc, ${messages.id} desc`)
    .limit(input.limit);
  return rows.reverse();
}
