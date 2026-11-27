import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, ts } from "./columns";
import { workspaces } from "./workspaces";

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    topic: text("topic").notNull().default(""),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    /** A DM is a private channel with two members; dmKey orders the pair so it is not duplicated. */
    kind: text("kind", { enum: ["channel", "dm"] })
      .notNull()
      .default("channel"),
    dmKey: text("dm_key"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
    /** Monthly cap on agent spend in this channel; null = no channel cap. */
    budgetPerMonthUsd: doublePrecision("budget_per_month_usd"),
    /** Last channel spend warning (`75:2026-10`, `90:…`, `exhausted:…`): one of each per month. */
    budgetNotice: text("budget_notice"),
  },
  (t) => [
    uniqueIndex("channels_name_uq").on(t.workspaceId, t.name).where(sql`kind = 'channel'`),
    uniqueIndex("channels_dm_uq").on(t.workspaceId, t.dmKey),
    index("channels_workspace_idx").on(t.workspaceId),
  ],
);

export const channelMemberships = pgTable(
  "channel_memberships",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    memberType: text("member_type", { enum: ["person", "agent"] }).notNull(),
    memberId: text("member_id").notNull(),
    /** Agents only: answers in this channel without needing a mention. */
    autoAnswer: boolean("auto_answer").notNull().default(false),
    lastReadAt: ts("last_read_at"),
    lastReadMessageId: text("last_read_message_id"),
    memberSince: ts("member_since").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.memberType, t.memberId] }),
    index("channel_memberships_member_idx").on(t.memberType, t.memberId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Id of the root message when this is a thread reply; null in the main conversation. */
    threadId: text("thread_id"),
    authorKind: text("author_kind", { enum: ["person", "agent"] }).notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    clientId: text("client_id"),
    runId: text("run_id"),
    agentMentionIds: jsonb("agent_mention_ids").$type<string[]>().notNull().default([]),
    mentionedUserIds: jsonb("mentioned_user_ids").$type<string[]>().notNull().default([]),
    usage: jsonb("usage").$type<{ model: string; inputTokens: number; outputTokens: number } | null>(),
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: ts("last_reply_at"),
    editedAt: ts("edited_at"),
    /**
     * Written true with the post and cleared once its effects ran (the search, the events, the thread, the
     * notices and, for a person's post, the join and the routing): a resend of its clientId runs what's missing.
     */
    effectsPending: boolean("effects_pending").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_channel_idx").on(t.channelId, t.createdAt),
    index("messages_thread_idx").on(t.threadId, t.createdAt),
    uniqueIndex("messages_client_uq").on(t.channelId, t.authorId, t.clientId),
  ],
);

export const emojiReactions = pgTable(
  "emoji_reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    reaction: text("reaction").notNull(),
    actorType: text("actor_type", { enum: ["person", "agent"] }).notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.reaction, t.actorType, t.actorId] })],
);

export const pins = pgTable(
  "pins",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    pinnedBy: text("pinned_by").notNull(),
    pinnedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.messageId] })],
);

/** Thread state (the id is the root message's). Created on the first reply or by threads.create. */
export const threads = pgTable(
  "threads",
  {
    id: text("id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Channel the thread came from, when it was moved. */
    sourceChannelId: text("source_channel_id"),
    state: text("state", { enum: ["open", "closed", "archived"] })
      .notNull()
      .default("open"),
    title: text("title").notNull().default(""),
    rootMessageId: text("root_message_id"),
    lastMessageId: text("last_message_id"),
    omittedMessageIds: jsonb("omitted_message_ids").$type<string[]>().notNull().default([]),
    createdByType: text("created_by_type", { enum: ["person", "agent"] }).notNull(),
    createdById: text("created_by_id").notNull(),
    resolvedSuggestion: boolean("resolved_suggestion").notNull().default(false),
    firstReplyAt: ts("first_reply_at"),
    lastTouchedAt: ts("last_touched_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("threads_workspace_activity_idx").on(t.workspaceId, t.lastTouchedAt)],
);

export const threadSubscriptions = pgTable(
  "thread_subscriptions",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    following: boolean("following").notNull(),
    updatedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
);
