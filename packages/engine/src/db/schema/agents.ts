import type { AgentAppearance } from "@vanr/contract";
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
import { createdAt, ts, updatedAt } from "./columns";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    /** Shares the namespace of people's handles: the server checks for clashes. */
    handle: text("handle").notNull(),
    role: text("role").notNull().default("custom"),
    instructions: text("instructions").notNull().default(""),
    model: text("model").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    visibilityMode: text("visibility_mode", { enum: ["everyone", "people", "owner"] })
      .notNull()
      .default("everyone"),
    audienceUserIds: jsonb("audience_user_ids").$type<string[]>().notNull().default([]),
    appearance: jsonb("appearance").$type<AgentAppearance>().notNull(),
    harnessKind: text("harness_kind", { enum: ["model", "claude_code", "codex"] })
      .notNull()
      .default("model"),
    /** Model of the local executor (claude_code/codex); null uses its default. */
    harnessModel: text("harness_model"),
    harnessFallback: boolean("harness_fallback").notNull().default(true),
    /** Advisor: a stronger model the executor can consult; null = off. */
    advisorModel: text("advisor_model"),
    advisorMaxUses: integer("advisor_max_uses").notNull().default(2),
    environmentId: text("environment_id"),
    /** Default autonomy for this agent's assignments. */
    assignmentCommandPolicy: text("assignment_command_policy", { enum: ["always", "when_safe", "never"] })
      .notNull()
      .default("when_safe"),
    /** GitHub repositories the agent uses ("owner/repo" or "owner/*"); empty = all. */
    repositories: jsonb("repositories").$type<string[]>().notNull().default([]),
    credentialId: text("credential_id"),
    /** null = the workspace's default budget. */
    budgetPerMonthUsd: doublePrecision("budget_per_month_usd"),
    /** Last budget warning sent ("warning:2026-10"), so it is not repeated within the month. */
    budgetNotice: text("budget_notice"),
    createdBy: text("created_by"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agents_handle_uq").on(t.workspaceId, t.handle),
    index("agents_workspace_idx").on(t.workspaceId),
  ],
);

export const credentials = pgTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    label: text("label").notNull(),
    provider: text("provider", { enum: ["anthropic", "openai"] }).notNull(),
    /** Encrypted key (AES-256-GCM with a key derived from the server secret). */
    secret: text("secret").notNull(),
    keyPreview: text("key_preview").notNull(),
    extra: jsonb("extra").$type<Record<string, string>>().notNull().default({}),
    createdBy: text("created_by"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("credentials_workspace_idx").on(t.workspaceId)],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id"),
    /**
     * Run with no channel of its own, requested from inside a channel (agent-to-agent delegation): whoever
     * cannot read that channel sees the run without the request text.
     */
    sourceChannelId: text("source_channel_id"),
    /**
     * Turn or synthesis of a debate: the run follows the debate's visibility and stays hidden while the
     * debate is anonymous.
     */
    debateId: text("debate_id"),
    threadId: text("thread_id"),
    sourceMessageId: text("source_message_id"),
    status: text("status", {
      enum: ["queued", "running", "paused_for_input", "paused_for_approval", "done", "failed", "canceled"],
    })
      .notNull()
      .default("queued"),
    what: text("what").notNull().default(""),
    model: text("model").notNull(),
    error: text("error"),
    errorCode: text("error_code"),
    errorVars: jsonb("error_vars").$type<Record<string, string | number>>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    lastPingAt: ts("last_ping_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("runs_agent_idx").on(t.workspaceId, t.agentId, t.createdAt),
    index("runs_active_idx")
      .on(t.channelId)
      .where(sql`status in ('queued','running','paused_for_input','paused_for_approval')`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: ["text", "tool_call", "tool_result"] }).notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/** Who picked up each message: routed, claimed, handled (with status) or blocked (audience, budget). */
export const messageDispatches = pgTable(
  "message_dispatches",
  {
    messageId: text("message_id").notNull(),
    agentId: text("agent_id").notNull(),
    state: text("state", { enum: ["routed", "claimed", "handled", "blocked"] }).notNull(),
    runId: text("run_id"),
    status: text("status", { enum: ["answered", "silent", "failed", "canceled", "blocked"] }),
    reason: text("reason"),
    at: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.agentId] })],
);

/**
 * Provenance of a memory: who wrote it, from where, in which run, and what outside content the run had
 * read.
 */
export interface MemoryOrigin {
  by: { type: "person" | "agent"; id: string } | null;
  name: string | null;
  channel: string | null;
  at: string;
  /** Run that wrote it (agent write). */
  runId?: string | null;
  /** Untrusted sources the run had read (flag A): email, web page, connector. */
  untrusted?: string[];
}

/**
 * Memory item: a short memory or a memory file. Three stores: the agent's (`scope = agent`, `agentId`), a
 * person's (`person`, `ownerUserId`; `agentId` is the agent that wrote it) and the workspace's
 * (`workspace`, no agent; only people write, agents read). `path` is the path inside the store
 * (`clients/acme.md`); without it the item is a short memory from `remember`. Every change becomes an
 * immutable row in `memory_versions`.
 */
export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    /** Owner in the agent store; author in a person's store; null in the workspace store. */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["agent", "person", "workspace"] })
      .notNull()
      .default("agent"),
    /** Owner of a `person` store. */
    ownerUserId: text("owner_user_id"),
    path: text("path"),
    text: text("text").notNull(),
    kind: text("kind", { enum: ["fact", "decision", "preference", "lesson"] })
      .notNull()
      .default("fact"),
    /** Who or what it is about (a person's handle, a client name). */
    about: text("about"),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    untrustedSource: boolean("untrusted_source").notNull().default(false),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: ts("last_used_at"),
    /** Last applied consolidation that read the item: the next one starts with unread and oldest items. */
    vettedAt: ts("vetted_at"),
    source: text("source"),
    origin: jsonb("origin").$type<MemoryOrigin>(),
    originMessageId: text("origin_message_id"),
    /**
     * A lesson confined to the channel it was learned in (feedback given in a private channel or a DM): it is used
     * in that channel's runs and shown only to whoever reads it. Null: the whole store sees it.
     */
    channelId: text("channel_id"),
    replaces: text("replaces"),
    /** Text before a person's last edit: "revert" goes back to it. */
    textBefore: text("text_before"),
    editorUserId: text("editor_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("memories_agent_idx").on(t.agentId),
    index("memories_store_idx").on(t.workspaceId, t.scope, t.ownerUserId),
    uniqueIndex("memories_agent_path_uq")
      .on(t.agentId, t.path)
      .where(sql`scope = 'agent' and archived = false and path is not null`),
    uniqueIndex("memories_person_path_uq")
      .on(t.workspaceId, t.ownerUserId, t.path)
      .where(sql`scope = 'person' and archived = false and path is not null`),
    uniqueIndex("memories_workspace_path_uq")
      .on(t.workspaceId, t.path)
      .where(sql`scope = 'workspace' and archived = false and path is not null`),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    source: text("source", { enum: ["custom", "github", "builtin"] })
      .notNull()
      .default("custom"),
    sourceUrl: text("source_url"),
    /** Run the skill came from ("save this flow as a skill"). */
    sourceRunId: text("source_run_id"),
    version: integer("version").notNull().default(1),
    autoGrantNewAgents: boolean("auto_grant_new_agents").notNull().default(false),
    body: text("body").notNull().default(""),
    files: jsonb("files")
      .$type<{ path: string; status: "ok" | "skipped"; mime: string; text?: string }[]>()
      .notNull()
      .default([]),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("skills_name_uq").on(t.workspaceId, t.name)],
);

export const skillGrants = pgTable(
  "skill_grants",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const reminders = pgTable(
  "reminders",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id"),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    text: text("text").notNull(),
    at: ts("at").notNull(),
    status: text("status", { enum: ["scheduled", "sent", "canceled"] })
      .notNull()
      .default("scheduled"),
    createdByType: text("created_by_type", { enum: ["person", "agent"] }).notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
  },
  (t) => [index("reminders_due_idx").on(t.at).where(sql`status = 'scheduled'`)],
);

/** An agent asking another agent in the middle of a run. */
export const delegations = pgTable(
  "delegations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    requesterAgentId: text("requester_agent_id").notNull(),
    delegateAgentId: text("delegate_agent_id").notNull(),
    runId: text("run_id"),
    channelId: text("channel_id"),
    question: text("question").notNull(),
    answer: text("answer"),
    status: text("status", { enum: ["open", "answered", "expired", "failed"] })
      .notNull()
      .default("open"),
    createdAt: createdAt(),
    answeredAt: ts("answered_at"),
  },
  (t) => [index("delegations_workspace_idx").on(t.workspaceId, t.createdAt)],
);
