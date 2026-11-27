import type {
  Channel,
  ChannelMember,
  DirectMessage,
  DirectoryMember,
  FileRef,
  MessageMeta,
  MessagePin,
  ReactionCount,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { channelName, parseMentions } from "@vanr/engine/text";
import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AgentRow, agentInWorkspace, agentNames } from "../agents";
import { assignmentPostMeta, assignmentRouting } from "../assignments/tools";
import { type ChannelRow, canReadChannel, openDm, readableChannel, writableChannel } from "../channels";
import { type AppDeps, type AppEnv, type Ctx, hasRuntime, requireRuntime } from "../context";
import { isUniqueViolation } from "../db-errors";
import { fileFor } from "../drive";
import { badRequest, conflict, forbidden, notFound, param, readJson, readQuery } from "../http";
import { log } from "../logger";
import {
  byClientId,
  ensureThread,
  hydrate,
  hydrateOne,
  listMessages,
  messageInWorkspace,
  postMessage,
  reactionsFor,
} from "../messages";
import { notifyReaction } from "../notify-sources";
import { requireCanTalk, withPlanOwners } from "../runners/plans";
import { route } from "../runtime/route";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const {
  agents,
  channels,
  channelMemberships,
  members,
  users,
  messages,
  emojiReactions,
  pins,
  threadSubscriptions,
} = schema;

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BODY = 20_000;
const topic = z.string().trim().max(250);
const channelNameInput = z
  .string()
  .max(120)
  .transform(channelName)
  .refine((n) => NAME_RE.test(n), "Use letters, numbers, - or _");
const memberTarget = z.union([
  z.object({ userId: z.string().min(1).max(64) }).strict(),
  z.object({ agentId: z.string().min(1).max(64) }).strict(),
]);

/** Unread messages per channel: from someone else, outside threads, after the last read. */
async function unreadByChannel(db: Db, userId: string, channelIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (channelIds.length === 0) return out;
  const rows = await db
    .select({ channelId: messages.channelId, n: count() })
    .from(messages)
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, messages.channelId),
        eq(channelMemberships.memberType, "person"),
        eq(channelMemberships.memberId, userId),
      ),
    )
    .where(
      and(
        inArray(messages.channelId, channelIds),
        isNull(messages.threadId),
        or(ne(messages.authorKind, "person"), ne(messages.authorId, userId)),
        or(isNull(channelMemberships.lastReadAt), gt(messages.createdAt, channelMemberships.lastReadAt)),
      ),
    )
    .groupBy(messages.channelId);
  for (const r of rows) out.set(r.channelId, r.n);
  return out;
}

const toChannel = (row: ChannelRow, isMember: boolean, generalId: string | null, unread = 0): Channel => ({
  id: row.id,
  name: row.name,
  topic: row.topic,
  visibility: row.visibility,
  isMember,
  // Nobody leaves #general and its name stays (PATCH and a member DELETE answer 409 channel.general).
  isGeneral: row.id === generalId,
  createdAt: row.createdAt.toISOString(),
  unreadCount: unread,
  budgetPerMonthUsd: row.budgetPerMonthUsd,
});

async function defaultChannelId(db: Db, workspaceId: string): Promise<string | null> {
  const [workspace] = await db
    .select({ id: schema.workspaces.defaultChannelId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  return workspace?.id ?? null;
}

async function memberChannelIds(db: Db, userId: string, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channelMemberships.memberType, "person"),
        eq(channelMemberships.memberId, userId),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function directoryOf(db: Db, workspaceId: string, channelId: string): Promise<DirectoryMember[]> {
  const rows = await db
    .select({
      type: channelMemberships.memberType,
      id: channelMemberships.memberId,
      autoAnswer: channelMemberships.autoAnswer,
      name: users.name,
      handle: members.handle,
    })
    .from(channelMemberships)
    .leftJoin(
      members,
      and(
        eq(channelMemberships.memberType, "person"),
        eq(members.userId, channelMemberships.memberId),
        eq(members.workspaceId, workspaceId),
      ),
    )
    .leftJoin(users, eq(users.id, members.userId))
    .where(eq(channelMemberships.channelId, channelId))
    .orderBy(asc(channelMemberships.memberSince));
  const agentInfo = await agentNames(
    db,
    rows.filter((r) => r.type === "agent").map((r) => r.id),
  );
  return rows.map((r) =>
    r.type === "person"
      ? { type: "person", id: r.id, name: r.name ?? "", handle: r.handle }
      : {
          type: "agent",
          id: r.id,
          name: agentInfo.get(r.id)?.name ?? "",
          handle: agentInfo.get(r.id)?.handle ?? null,
          autoAnswer: r.autoAnswer,
        },
  );
}

/** The pins with their messages, hydrated in one pass, in the order given. */
async function pinsOf(db: Db, rows: (typeof pins.$inferSelect)[]): Promise<MessagePin[]> {
  if (rows.length === 0) return [];
  const found = await db
    .select()
    .from(messages)
    .where(
      inArray(
        messages.id,
        rows.map((r) => r.messageId),
      ),
    );
  const byId = new Map((await hydrate(db, found)).map((m) => [m.id, m]));
  return rows.flatMap((row) => {
    const message = byId.get(row.messageId);
    if (!message) return [];
    return [
      {
        channelId: row.channelId,
        messageId: row.messageId,
        pinnedBy: row.pinnedBy,
        pinnedAt: row.pinnedAt.toISOString(),
        message,
      },
    ];
  });
}

/**
 * Whether an agent would answer this post, by the runtime's routing rule (runtime/route): the mentioned agents of
 * the channel, else the DM's agent, else the agents that already spoke in the thread, else the channel's agents
 * that answer without a mention; only those the author may talk to, and not a suggestion or a paused assignment.
 */
async function agentWouldAnswer(
  deps: AppDeps,
  channel: ChannelRow,
  post: { authorId: string; body: string; threadId: string | null; meta: MessageMeta },
): Promise<boolean> {
  const { db } = deps;
  if (!(await assignmentRouting(deps, post))) return false;
  const handles = parseMentions(post.body);
  const mentioned = handles.length
    ? await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, channel.workspaceId),
            inArray(agents.handle, handles),
            isNull(agents.archivedAt),
          ),
        )
    : [];
  const inChannel = await db
    .select({ agent: agents, autoAnswer: channelMemberships.autoAnswer })
    .from(channelMemberships)
    .innerJoin(agents, eq(agents.id, channelMemberships.memberId))
    .where(
      and(
        eq(channelMemberships.channelId, channel.id),
        eq(channelMemberships.memberType, "agent"),
        isNull(agents.archivedAt),
      ),
    );
  if (mentioned.length === 0 && inChannel.length === 0) return false;
  const threadAgentIds = post.threadId
    ? (
        await db
          .selectDistinct({ id: messages.authorId })
          .from(messages)
          .where(
            and(
              eq(messages.authorKind, "agent"),
              or(eq(messages.threadId, post.threadId), eq(messages.id, post.threadId)),
            ),
          )
      ).map((r) => r.id)
    : [];
  const talkers = new Map(
    (await withPlanOwners(db, [...mentioned, ...inChannel.map((m) => m.agent)])).map((a) => [a.id, a]),
  );
  const talker = (a: AgentRow) => talkers.get(a.id) ?? { ...a, planOwnerUserId: null };
  const routed = route({
    authorUserId: post.authorId,
    mentioned: mentioned.map(talker),
    inChannel: inChannel.map((m) => ({ agent: talker(m.agent), autoAnswer: m.autoAnswer })),
    isDm: channel.kind === "dm",
    threadAgentIds,
  });
  return routed.targets.length > 0;
}

/** The person joins the channel (nothing when they already are a member). */
async function joinChannel(db: Db, channelId: string, userId: string) {
  await db
    .insert(channelMemberships)
    .values({ channelId, memberType: "person", memberId: userId })
    .onConflictDoNothing();
}

/**
 * A message the person can read (its channel must be readable). A missing message and one of a channel they don't
 * read answer the same 404, text included.
 */
async function readableMessage(c: Ctx, messageId: string, missing = "Message not found") {
  const me = requireMember(c);
  const { db } = c.get("deps");
  const row = await messageInWorkspace(db, me.workspaceId, messageId);
  if (
    !row ||
    !(await canReadChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId: row.channelId }))
  )
    throw notFound(missing);
  return row;
}

async function reactionsOf(db: Db, messageId: string): Promise<ReactionCount[]> {
  return (await reactionsFor(db, [messageId])).get(messageId) ?? [];
}

async function dmPartner(db: Db, channelId: string, userId: string): Promise<DirectMessage["with"]> {
  const rows = await db
    .select({ type: channelMemberships.memberType, id: channelMemberships.memberId, name: users.name })
    .from(channelMemberships)
    .leftJoin(
      users,
      and(eq(channelMemberships.memberType, "person"), eq(users.id, channelMemberships.memberId)),
    )
    .where(eq(channelMemberships.channelId, channelId));
  // A DM with oneself has a single row.
  const other = rows.find((r) => !(r.type === "person" && r.id === userId)) ?? rows[0];
  if (!other) return { type: "person", id: userId, name: "" };
  if (other.type === "agent") {
    const info = await agentNames(db, [other.id]);
    return { type: "agent", id: other.id, name: info.get(other.id)?.name ?? "" };
  }
  return { type: "person", id: other.id, name: other.name ?? "" };
}

export function registerChat(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/channels`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const mine = await memberChannelIds(db, me.userId, me.workspaceId);
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, me.workspaceId),
          isNull(channels.archivedAt),
          or(
            and(eq(channels.kind, "channel"), eq(channels.visibility, "public")),
            mine.size ? inArray(channels.id, [...mine]) : sql`false`,
          ),
        ),
      )
      .orderBy(asc(channels.kind), asc(channels.name), asc(channels.createdAt));
    const unread = await unreadByChannel(db, me.userId, [...mine]);
    const general = await defaultChannelId(db, me.workspaceId);
    return c.json({
      channels: rows.map((r) => toChannel(r, mine.has(r.id), general, unread.get(r.id) ?? 0)),
    });
  });

  app.post(`${WORKSPACE}/channels`, async (c) => {
    const me = requirePermission(c, "create_channels");
    const input = await readJson(
      c,
      z.object({
        name: channelNameInput,
        topic: topic.optional(),
        visibility: z.enum(["public", "private"]).default("public"),
      }),
    );
    const { db } = c.get("deps");
    const id = newId("ch");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(channels).values({
          id,
          workspaceId: me.workspaceId,
          name: input.name,
          topic: input.topic ?? "",
          visibility: input.visibility,
          createdBy: me.userId,
        });
        await tx
          .insert(channelMemberships)
          .values({ channelId: id, memberType: "person", memberId: me.userId });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("channel.name_taken", "A channel with this name already exists", { name: input.name });
      }
      throw err;
    }
    const [row] = await db.select().from(channels).where(eq(channels.id, id));
    if (!row) throw notFound("Channel not found");
    return c.json(toChannel(row, true, null), 201);
  });

  app.post(`${WORKSPACE}/channels/:channelId/join`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    if (channel.kind === "dm") throw forbidden("You can't join a direct message");
    await db
      .insert(channelMemberships)
      .values({ channelId: channel.id, memberType: "person", memberId: me.userId })
      .onConflictDoNothing();
    return c.body(null, 204);
  });

  // Name and topic: the channel's members change them. #general keeps its name.
  app.patch(`${WORKSPACE}/channels/:channelId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel, isMember } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    if (!isMember && !can(me.role, "configure")) throw forbidden("Join the channel to edit it");
    if (channel.kind === "dm") throw forbidden("Direct messages can't be renamed");
    const input = await readJson(
      c,
      z.object({
        name: channelNameInput.optional(),
        topic: topic.optional(),
        budgetPerMonthUsd: z.number().min(0).max(100_000).nullable().optional(),
      }),
    );
    // The channel's spend cap is the workspace's money: only whoever configures the workspace changes it.
    if (input.budgetPerMonthUsd !== undefined && !can(me.role, "configure"))
      throw forbidden("Only admins change the channel budget");
    const general = await defaultChannelId(db, me.workspaceId);
    if (input.name && input.name !== channel.name && general === channel.id) {
      throw conflict("channel.general", "#general can't be renamed");
    }
    try {
      await db
        .update(channels)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          // A new cap: the 75% and 90% notices apply to it again.
          ...(input.budgetPerMonthUsd !== undefined
            ? { budgetPerMonthUsd: input.budgetPerMonthUsd, budgetNotice: null }
            : {}),
        })
        .where(eq(channels.id, channel.id));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("channel.name_taken", "A channel with this name already exists", { name: input.name });
      }
      throw err;
    }
    const [row] = await db.select().from(channels).where(eq(channels.id, channel.id));
    if (!row) throw notFound("Channel not found");
    // The web app replaces the whole channel in its cache: the unread count must be the real one, not zero.
    const unread = isMember ? await unreadByChannel(db, me.userId, [row.id]) : new Map<string, number>();
    return c.json(toChannel(row, isMember, general, unread.get(row.id) ?? 0));
  });

  app.get(`${WORKSPACE}/channels/:channelId/directory`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    return c.json({ members: await directoryOf(db, me.workspaceId, channel.id) });
  });

  app.get(`${WORKSPACE}/channels/:channelId/members`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    const rows = await db
      .select({ type: channelMemberships.memberType, id: channelMemberships.memberId })
      .from(channelMemberships)
      .where(eq(channelMemberships.channelId, channel.id))
      .orderBy(asc(channelMemberships.memberSince));
    return c.json({ members: rows satisfies ChannelMember[] });
  });

  // Adding someone (a person or an agent): whoever is already in the channel adds them.
  app.post(`${WORKSPACE}/channels/:channelId/members`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel, isMember } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    if (channel.kind === "dm") throw forbidden("Direct messages have fixed members");
    if (!isMember) throw forbidden("Join the channel to add people");
    const target = await readJson(c, memberTarget);
    if ("agentId" in target) {
      const agent = await agentInWorkspace(db, me.workspaceId, target.agentId);
      if (agent.archivedAt) throw notFound("Agent not found");
      await db
        .insert(channelMemberships)
        .values({ channelId: channel.id, memberType: "agent", memberId: agent.id })
        .onConflictDoNothing();
      return c.body(null, 204);
    }
    const [person] = await db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, target.userId)));
    if (!person) throw notFound("Member not found");
    await db
      .insert(channelMemberships)
      .values({ channelId: channel.id, memberType: "person", memberId: person.userId })
      .onConflictDoNothing();
    return c.body(null, 204);
  });

  const removeMember = async (c: Ctx, type: "person" | "agent", id: string) => {
    const me = requireMember(c);
    const { db, hub } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    if (channel.kind === "dm") throw forbidden("Direct messages have fixed members");
    const self = type === "person" && id === me.userId;
    if (!self && !can(me.role, "manage_members")) throw forbidden();
    if (type === "person" && (await defaultChannelId(db, me.workspaceId)) === channel.id) {
      throw conflict("channel.general", "Everyone stays in #general");
    }
    const removed = await db
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.memberType, type),
          eq(channelMemberships.memberId, id),
        ),
      )
      .returning({ id: channelMemberships.memberId });
    if (removed.length === 0) throw notFound("Member not found");
    if (type === "person" && channel.visibility === "private") hub.dropUser(me.workspaceId, id, channel.id);
    return c.body(null, 204);
  };
  app.delete(`${WORKSPACE}/channels/:channelId/members/people/:personId`, (c) =>
    removeMember(c, "person", param(c, "personId")),
  );
  app.delete(`${WORKSPACE}/channels/:channelId/members/agents/:agentId`, (c) =>
    removeMember(c, "agent", param(c, "agentId")),
  );

  app.get(`${WORKSPACE}/channels/:channelId/messages`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    const q = readQuery(
      c,
      z.object({
        threadId: z.string().min(1).max(64).optional(),
        before: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
    );
    const rows = await listMessages(db, { channelId: channel.id, ...q });
    // In a thread, the root comes before the first page.
    if (q.threadId && !q.before) {
      const root = await messageInWorkspace(db, me.workspaceId, q.threadId);
      if (root && root.channelId === channel.id && root.threadId === null) rows.unshift(root);
    }
    // Private history: no cache keeps it for another session of the same browser.
    return c.json({ messages: await hydrate(db, rows) }, 200, { "cache-control": "private, no-store" });
  });

  app.post(`${WORKSPACE}/channels/:channelId/messages`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z.object({
        body: z.string().max(MAX_BODY),
        clientId: z.string().min(1).max(100),
        threadId: z.string().min(1).max(64).optional(),
        replyTo: z.string().min(1).max(64).optional(),
        attachments: z.array(z.string().min(1).max(64)).max(10).optional(),
        spawnsThread: z.boolean().optional(),
      }),
    );
    const body = input.body.trim();
    if (!body && !input.attachments?.length) throw badRequest("Message is empty", { field: "body" });
    // Read only: a channel that isn't readable answers 404 first, and the person joins a public channel only once
    // the post was accepted (a post rejected below, or a bad attachment or thread, doesn't make them a member).
    const { channel, isMember } = await readableChannel(deps.db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    // A resend of a post already accepted answers it as it is, whatever changed in the channel since.
    const resent = await byClientId(deps.db, channel.id, me.userId, input.clientId);
    if (resent) {
      // The first request may have failed after the post was written: the resend finishes joining.
      if (!isMember) await joinChannel(deps.db, channel.id, me.userId);
      return c.json(await hydrateOne(deps.db, resent), 200);
    }
    const assignment = await assignmentPostMeta(deps, me, input.threadId, body);
    // Without the agent runtime (slice S6) a post an agent would answer is rejected before it is written: it would
    // stay unanswered with no sign why. A post no agent answers goes out as usual.
    const routes = hasRuntime(deps.runtime, "onPersonMessage");
    if (
      !routes &&
      (await agentWouldAnswer(deps, channel, {
        authorId: me.userId,
        body,
        threadId: input.threadId ?? null,
        meta: assignment,
      }))
    )
      requireRuntime(deps.runtime, "onPersonMessage");
    // An attachment is a file of this channel (or of the whole workspace): whoever reads the message can open it.
    const attached: FileRef[] = [];
    for (const id of new Set(input.attachments ?? [])) {
      const file = await fileFor(deps.db, me.workspaceId, id, { type: "person", id: me.userId });
      if (file.channelId && file.channelId !== channel.id)
        throw badRequest("Attach files from this conversation", { field: "attachments", fileId: id });
      attached.push({ id: file.id, version: file.version, title: file.title, deleted: false });
    }
    const { message, created } = await postMessage(deps, {
      workspaceId: me.workspaceId,
      channel,
      author: { type: "person", id: me.userId },
      body,
      clientId: input.clientId,
      threadId: input.threadId ?? null,
      replyTo: input.replyTo ?? null,
      meta: {
        ...(input.spawnsThread ? { spawnsThread: true } : {}),
        ...(attached.length ? { files: attached } : {}),
        ...assignment,
      },
    });
    if (!isMember) await joinChannel(deps.db, channel.id, me.userId);
    // A resend of the same clientId doesn't route again. A routing failure doesn't fail the post.
    if (created && routes) {
      await deps.runtime
        .onPersonMessage({ workspaceId: me.workspaceId, channel, message })
        .catch((err) => log.error("runtime.route_failed", { messageId: message.id, err }));
    }
    return c.json(message, created ? 201 : 200);
  });

  app.get(`${WORKSPACE}/messages/:messageId/reactions`, async (c) => {
    const row = await readableMessage(c, param(c, "messageId"));
    return c.json({ reactions: await reactionsOf(c.get("deps").db, row.id) });
  });

  const reaction = z.string().trim().min(1).max(64);
  const publishReactions = (c: Ctx, row: { id: string; channelId: string }, reactions: ReactionCount[]) => {
    c.get("deps").hub.toChannel(row.channelId, {
      type: "message.reactions_updated",
      messageId: row.id,
      reactions,
    });
  };

  app.post(`${WORKSPACE}/messages/:messageId/reactions`, async (c) => {
    const me = requireMember(c);
    const row = await readableMessage(c, param(c, "messageId"));
    const input = await readJson(c, z.object({ reaction }));
    const { db } = c.get("deps");
    const added = await db
      .insert(emojiReactions)
      .values({ messageId: row.id, reaction: input.reaction, actorType: "person", actorId: me.userId })
      .onConflictDoNothing()
      .returning({ messageId: emojiReactions.messageId });
    const reactions = await reactionsOf(db, row.id);
    publishReactions(c, row, reactions);
    if (added.length) {
      const actor = { type: "person" as const, id: me.userId };
      await notifyReaction(c.get("deps"), { message: row, actor, reaction: input.reaction, added: true });
    }
    return c.json({ reactions });
  });

  app.delete(`${WORKSPACE}/messages/:messageId/reactions`, async (c) => {
    const me = requireMember(c);
    const row = await readableMessage(c, param(c, "messageId"));
    const q = readQuery(c, z.object({ reaction }));
    const { db } = c.get("deps");
    await db
      .delete(emojiReactions)
      .where(
        and(
          eq(emojiReactions.messageId, row.id),
          eq(emojiReactions.reaction, q.reaction),
          eq(emojiReactions.actorType, "person"),
          eq(emojiReactions.actorId, me.userId),
        ),
      );
    const reactions = await reactionsOf(db, row.id);
    publishReactions(c, row, reactions);
    const actor = { type: "person" as const, id: me.userId };
    await notifyReaction(c.get("deps"), { message: row, actor, reaction: q.reaction, added: false });
    return c.json({ reactions });
  });

  // DMs
  app.get(`${WORKSPACE}/dms`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.memberType, "person"),
          eq(channelMemberships.memberId, me.userId),
        ),
      )
      .where(and(eq(channels.workspaceId, me.workspaceId), eq(channels.kind, "dm")))
      .orderBy(asc(channels.createdAt));
    const unread = await unreadByChannel(
      db,
      me.userId,
      rows.map((r) => r.id),
    );
    const dms: DirectMessage[] = [];
    for (const r of rows) {
      dms.push({
        channelId: r.id,
        with: await dmPartner(db, r.id, me.userId),
        unread: unread.get(r.id) ?? 0,
      });
    }
    return c.json({ dms });
  });

  // Opens (or reuses) the DM. The key sorts the pair so both sides land in the same channel.
  app.post(`${WORKSPACE}/dms`, async (c) => {
    const me = requireMember(c);
    const target = await readJson(c, memberTarget);
    const { db } = c.get("deps");
    let other: { type: "person" | "agent"; id: string };
    if ("agentId" in target) {
      const agent = await agentInWorkspace(db, me.workspaceId, target.agentId);
      if (agent.archivedAt) throw notFound("Agent not found");
      await requireCanTalk(db, agent, me.userId);
      // The agent answers every message of its DM: without the runtime (slice S6) the DM isn't opened at all.
      requireRuntime(c.get("deps").runtime, "onPersonMessage");
      other = { type: "agent", id: agent.id };
    } else {
      const [person] = await db
        .select({ userId: members.userId })
        .from(members)
        .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, target.userId)));
      if (!person) throw notFound("Member not found");
      other = { type: "person", id: person.userId };
    }
    return c.json({ channelId: await openDm(db, { workspaceId: me.workspaceId, userId: me.userId, other }) });
  });

  app.post(`${WORKSPACE}/channels/:channelId/read`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel, isMember } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    if (!isMember) return c.body(null, 204);
    const [last] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), isNull(messages.threadId)))
      .orderBy(sql`${messages.createdAt} desc, ${messages.id} desc`)
      .limit(1);
    await db
      .update(channelMemberships)
      .set({ lastReadAt: sql`now()`, lastReadMessageId: last?.id ?? null })
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.memberType, "person"),
          eq(channelMemberships.memberId, me.userId),
        ),
      );
    return c.body(null, 204);
  });

  // Pins
  app.get(`${WORKSPACE}/channels/:channelId/pinned-messages`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    const rows = await db
      .select()
      .from(pins)
      .where(eq(pins.channelId, channel.id))
      .orderBy(sql`${pins.pinnedAt} desc`);
    return c.json({ pins: await pinsOf(db, rows) }, 200, { "cache-control": "private, no-store" });
  });

  app.post(`${WORKSPACE}/channels/:channelId/pinned-messages/:messageId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const channel = await writableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    const row = await messageInWorkspace(db, me.workspaceId, param(c, "messageId"));
    if (!row || row.channelId !== channel.id) throw notFound("Message not found");
    await db
      .insert(pins)
      .values({ channelId: channel.id, messageId: row.id, pinnedBy: me.userId })
      .onConflictDoNothing();
    const [pin] = await db
      .select()
      .from(pins)
      .where(and(eq(pins.channelId, channel.id), eq(pins.messageId, row.id)));
    if (!pin) throw notFound("Pin not found");
    const [shown] = await pinsOf(db, [pin]);
    if (!shown) throw notFound("Message not found");
    return c.json(shown);
  });

  app.delete(`${WORKSPACE}/channels/:channelId/pinned-messages/:messageId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const channel = await writableChannel(db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: param(c, "channelId"),
    });
    const removed = await db
      .delete(pins)
      .where(and(eq(pins.channelId, channel.id), eq(pins.messageId, param(c, "messageId"))))
      .returning({ id: pins.messageId });
    if (removed.length === 0) throw notFound("Pin not found");
    return c.body(null, 204);
  });

  // Following a thread: the root message must exist and be readable.
  const follow = async (c: Ctx, following: boolean) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const root = await readableMessage(c, param(c, "threadId"), "Thread not found");
    if (root.threadId !== null) throw notFound("Thread not found");
    const at = deps.now();
    await ensureThread(deps.db, { root, by: { type: "person", id: me.userId }, at, title: "" });
    await deps.db
      .insert(threadSubscriptions)
      .values({ threadId: root.id, userId: me.userId, following, updatedAt: at })
      .onConflictDoUpdate({
        target: [threadSubscriptions.threadId, threadSubscriptions.userId],
        set: { following, updatedAt: at },
      });
    return c.json({ threadId: root.id, following });
  };
  app.put(`${WORKSPACE}/threads/:threadId/follow`, (c) => follow(c, true));
  app.delete(`${WORKSPACE}/threads/:threadId/follow`, (c) => follow(c, false));
}
