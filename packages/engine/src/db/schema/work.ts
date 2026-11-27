// Workspace work: issues with a board, routines, calendar and notifications.

import type { RecurrenceRule } from "@vanr/contract";
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { createdAt, ts, updatedAt } from "./columns";
import type { Actor } from "./content";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ---- Issues ----

export const boardColumns = pgTable(
  "board_columns",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    stage: text("stage", { enum: ["todo", "in_progress", "reviewing", "done", "canceled"] }).notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("board_columns_workspace_idx").on(t.workspaceId, t.position)],
);

export const issues = pgTable(
  "issues",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    /** Short number within the workspace (#12); unique per workspace. */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    criteria: jsonb("criteria").$type<{ id: string; text: string; done: boolean }[]>().notNull().default([]),
    columnId: text("column_id").notNull(),
    boardPosition: doublePrecision("board_position").notNull().default(0),
    priority: text("priority", { enum: ["none", "low", "medium", "high", "urgent"] })
      .notNull()
      .default("none"),
    assignee: jsonb("assignee").$type<Actor>(),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    dueDate: text("due_date"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    source: jsonb("source").$type<{ kind: string; id?: string }>(),
    channelId: text("channel_id"),
    parentId: text("parent_id"),
    pullRequests: jsonb("pull_requests").$type<string[]>().notNull().default([]),
    fileIds: jsonb("file_ids").$type<string[]>().notNull().default([]),
    // messageId: the "Ask an agent" message that opened the work (only its run closes it).
    work: jsonb("work").$type<{
      state: string;
      reason: string | null;
      runId: string | null;
      messageId?: string | null;
    }>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("issues_number_uq").on(t.workspaceId, t.number),
    index("issues_column_idx").on(t.columnId),
  ],
);

export const issueTimeline = pgTable(
  "issue_timeline",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["comment", "event"] }).notNull(),
    event: text("event"),
    textKey: text("text_key"),
    textVars: jsonb("text_vars").$type<Record<string, string | number>>(),
    text: text("text").notNull(),
    author: jsonb("author").$type<Actor>().notNull(),
    auto: boolean("auto").notNull().default(false),
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    /** Write order: events from the same edit land in the same millisecond. */
    seq: serial("seq").notNull(),
  },
  (t) => [index("issue_timeline_issue_idx").on(t.issueId, t.seq)],
);

// ---- Routines ----

export const routines = pgTable(
  "routines",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(true),
    nextFireAt: ts("next_fire_at"),
    /** While running, when it started (prevents two executions at once). */
    runningSince: ts("running_since"),
    /**
     * Until when the current execution may run (the time cap as of its start). Past that plus a grace
     * period, the lock counts as free: changing the cap mid-run does not release the running one's lock.
     */
    runningUntil: ts("running_until"),
    /** Public webhook id in the path. Not a credential: the signature is the proof. */
    hookId: text("webhook_token"),
    /** Webhook `whsec_` secret, encrypted (`seal`). Shown only once, by the route that generates it. */
    webhookSecret: text("webhook_secret"),
    /** Email trigger: how far the folder has been read ({uidValidity, lastUid}) and which account and folder. */
    cursor: jsonb("cursor").$type<{
      uidValidity: number | null;
      lastUid: number;
      folder?: string;
      accountId?: string;
    }>(),
    /**
     * Missed run, overlap, cap, retry and pause policy (`RoutinePolicy`; anything missing comes from the
     * default).
     */
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Start of the series when the rule has no `start`: creation or the last trigger change. Without it,
     * `count` and the hourly step would restart on every fire and the series would never end.
     */
    scheduleFrom: ts("schedule_from"),
    /** Why the routine turned itself off (`failures`: N failures in a row). Turning it on again clears it. */
    pausedReason: text("paused_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("routines_workspace_idx").on(t.workspaceId),
    index("routines_due_idx").on(t.nextFireAt).where(sql`active`),
    uniqueIndex("routines_hook_uq").on(t.hookId),
  ],
);

export const routineExecutions = pgTable(
  "routine_executions",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** When it was recorded (the fire). */
    at: ts("at").notNull(),
    /**
     * `pending`: recorded, not its turn yet; `queued`: waiting for the previous one to finish or for the
     * retry time (`notBefore`); `running`: running. The rest are final.
     */
    status: text("status", {
      enum: ["pending", "queued", "running", "ok", "silent", "failed", "skipped"],
    }).notNull(),
    /** What fired it: schedule, once, event, webhook, email, manual, retry. */
    trigger: text("trigger"),
    /** Scheduled time (schedule and "once"): unique per routine. */
    scheduledFor: ts("scheduled_for"),
    /** Dedupe key of the fire (event id, `webhook-id`, email UID, client key). */
    dedupeKey: text("dedupe_key"),
    /** Reason for the skip or the failure (`missed`, `overlap`, `budget`, `step_limit`, `interrupted`...). */
    reason: text("reason"),
    notBefore: ts("not_before"),
    startedAt: ts("started_at"),
    /** Time cap in effect when it started: recovery only closes it as `interrupted` after that. */
    deadlineAt: ts("deadline_at"),
    finishedAt: ts("finished_at"),
    attempt: integer("attempt").notNull().default(1),
    /** First attempt of the retry chain (the effects' idempotency key derives from it). */
    retryOf: text("retry_of"),
    /** This failure already has a retry scheduled (it does not count toward "N failures in a row"). */
    retried: boolean("retried").notNull().default(false),
    /** Fire context (text and outside origin), so the retry runs with the same payload. */
    payload: jsonb("payload").$type<{ text: string; untrusted?: string }>(),
    summary: text("summary"),
    summaryKey: text("summary_key"),
    summaryVars: jsonb("summary_vars").$type<Record<string, string | number>>(),
    /** The session: channel and thread the agent worked in, the message and the run. */
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    messageId: text("message_id"),
    runId: text("run_id"),
  },
  (t) => [
    index("routine_executions_routine_idx").on(t.routineId, t.at),
    uniqueIndex("routine_executions_slot_uq")
      .on(t.routineId, t.scheduledFor)
      .where(sql`scheduled_for is not null`),
    uniqueIndex("routine_executions_dedupe_uq")
      .on(t.routineId, t.dedupeKey)
      .where(sql`dedupe_key is not null`),
    // "Queue one": at most one execution waiting for the previous one (retries are not counted).
    uniqueIndex("routine_executions_queued_uq")
      .on(t.routineId)
      .where(sql`status = 'queued' and trigger is distinct from 'retry'`),
    index("routine_executions_queue_idx").on(t.notBefore).where(sql`status = 'queued'`),
  ],
);

/**
 * External effect done by a run with an idempotency key (routine with retry): the key is the original
 * execution's plus the hash of the tool and payload. A second attempt with the same effect does not redo
 * it; it gets the stored result (or "maybe already done" if the first one died midway).
 */
export const effectKeys = pgTable("effect_keys", {
  key: text("key").primaryKey(),
  workspaceId: workspace(),
  tool: text("tool").notNull(),
  runId: text("run_id"),
  status: text("status", { enum: ["pending", "done", "failed"] }).notNull(),
  output: jsonb("output").$type<{ content: string; isError: boolean }>(),
  createdAt: createdAt(),
});

// ---- Calendar ----

export const calendarEntries = pgTable(
  "calendar_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    title: text("title").notNull(),
    start: ts("start").notNull(),
    end: ts("end").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    timezone: text("timezone").notNull().default("UTC"),
    rule: jsonb("rule").$type<RecurrenceRule>(),
    /** Occurrences removed from the series (ISO start of each one). */
    exdates: jsonb("exdates").$type<string[]>().notNull().default([]),
    /** Source series when the series was split ("this and following"). */
    seriesId: text("series_id"),
    participants: jsonb("participants").$type<Actor[]>().notNull().default([]),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    location: text("location"),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("calendar_entries_workspace_idx").on(t.workspaceId, t.start)],
);

export const calendarProposals = pgTable(
  "calendar_proposals",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    start: ts("start").notNull(),
    end: ts("end").notNull(),
    participants: jsonb("participants").$type<Actor[]>().notNull().default([]),
    note: text("note"),
    status: text("status", { enum: ["pending", "confirmed", "dismissed"] })
      .notNull()
      .default("pending"),
    eventId: text("event_id"),
    createdAt: createdAt(),
  },
  (t) => [index("calendar_proposals_workspace_idx").on(t.workspaceId, t.start)],
);

// ---- Notifications ----

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    /** Groups notices from the same source (e.g. reactions to the same message) into a single row. */
    groupKey: text("group_key").notNull(),
    waiting: boolean("waiting").notNull().default(false),
    readAt: ts("read_at"),
    doneAt: ts("done_at"),
    mutedUntil: ts("muted_until"),
    /** Saved: excluded from the 3-month retention. */
    savedAt: ts("saved_at"),
    /** Tab (`action_needed` or `fyi`), already applying the person's rules. */
    tab: text("tab", { enum: ["action_needed", "fyi"] })
      .notNull()
      .default("fyi"),
    /** Breaks through quiet hours: open approval request, direct question or failure. */
    critical: boolean("critical").notNull().default(false),
    /** Reason shown on the row. */
    reason: text("reason").notNull().default(""),
    /** The person's rule that chose the tab (null: default). */
    ruleId: text("rule_id"),
    /** Priority requested by the notifier (to recompute the tab when the rules change). */
    priority: text("priority", { enum: ["critical", "action_needed", "fyi"] }),
    /** Reminder: goes back to the top at this time without disappearing before. */
    remindAt: ts("remind_at"),
    count: integer("count").notNull().default(1),
    actors: jsonb("actors").$type<Actor[]>().notNull().default([]),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    latest: jsonb("latest").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("notifications_group_uq").on(t.workspaceId, t.userId, t.groupKey),
    index("notifications_user_idx").on(t.workspaceId, t.userId, t.updatedAt),
    index("notifications_waiting_idx").on(t.id).where(sql`${t.waiting}`),
    index("notifications_remind_idx").on(t.remindAt).where(sql`${t.remindAt} is not null`),
  ],
);

/** The person's notification preferences in that workspace (NotificationSettings, validated by the route). */
export const notificationSettings = pgTable(
  "notification_settings",
  {
    workspaceId: workspace(),
    userId: text("user_id").notNull(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notification_settings_uq").on(t.workspaceId, t.userId)],
);

/** Web Push subscription of one browser. Applies to all of the person's workspaces. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    failures: integer("failures").notNull().default(0),
    lastSuccessAt: ts("last_success_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("push_subscriptions_uq").on(t.userId, t.endpoint)],
);

/**
 * Out-of-app delivery queue (push and email). One row per notification and channel while pending; the tick
 * takes the due rows with `FOR UPDATE SKIP LOCKED`, checks again that they still apply, and sends.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    userId: text("user_id").notNull(),
    notificationId: text("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: ["push", "email"] }).notNull(),
    /** `reminder`: a reminder the person asked for (the push goes out even under "fyi"). */
    cause: text("cause", { enum: ["event", "reminder"] })
      .notNull()
      .default("event"),
    status: text("status", { enum: ["pending", "sending", "sent", "skipped", "failed"] })
      .notNull()
      .default("pending"),
    dueAt: ts("due_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lockedAt: ts("locked_at"),
    sentAt: ts("sent_at"),
    /** Why it did not go out (skipped/failed): read, resolved, preference, no subscription, error. */
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notification_deliveries_open_uq")
      .on(t.notificationId, t.channel)
      .where(sql`${t.status} in ('pending', 'sending')`),
    index("notification_deliveries_due_idx").on(t.dueAt).where(sql`${t.status} = 'pending'`),
  ],
);
