// Control over agent actions: approvals, proposals, questions and undoable actions.
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, ts } from "./columns";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

const agent = () =>
  text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" });

/** An agent's request to use a tool that needs a person. */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: agent(),
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    /** Message of the card in the conversation. */
    messageId: text("message_id"),
    runId: text("run_id"),
    tool: text("tool").notNull(),
    scope: text("scope").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    why: text("why").notNull().default(""),
    issue: jsonb("issue").$type<{ number: number; title: string }>(),
    connector: text("connector"),
    linkedAccount: text("linked_account"),
    status: text("status", { enum: ["pending", "approved", "refused", "expired", "canceled"] })
      .notNull()
      .default("pending"),
    /** Effect class of the call; null for approvals that predate the gate. */
    effect: text("effect", { enum: ["K0", "K1", "K2", "K3"] }),
    /** Why the gate asked: irreversible, rule_of_two, destination_not_allowed, untrusted_public, policy. */
    gateReason: text("gate_reason"),
    /** Run flags with the reason for each (A read outside content, B secret, C acts outside). */
    flags: jsonb("flags").$type<{ flag: string; source: string }[]>().notNull().default([]),
    /** The exact effect the person sees: full text, recipients, links, diff. */
    preview: jsonb("preview").$type<{
      title: string;
      body?: string;
      recipients?: string[];
      links?: string[];
      diff?: string;
    }>(),
    /** Input that runs on approval (the person's edited version, after an edit). */
    input: jsonb("input").$type<unknown>(),
    /** The agent's original input, kept when the person edited it. */
    originalInput: jsonb("original_input").$type<unknown>(),
    /** SHA-256 of tool + payload in canonical JSON: only this payload executes. */
    payloadHash: text("payload_hash"),
    /** Input fields the person may edit on the card. */
    editable: jsonb("editable").$type<string[]>().notNull().default([]),
    edited: boolean("edited").notNull().default(false),
    /**
     * Predicate for "always allow" on this call (channel, account and recipients, exact command); null =
     * the person cannot remember it (K3, risk-flagged request, run with flag A, tool without a predicate).
     */
    ruleKey: text("rule_key"),
    /** The predicate as text, for the "Approve and remember" button and the rules list. */
    ruleLabel: text("rule_label"),
    /** Who asked the agent (author of the message that started the run). */
    requesterUserId: text("requester_user_id"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    deciderUserId: text("decider_user_id"),
    reason: text("reason"),
    executedAt: ts("executed_at"),
    result: jsonb("result").$type<{ ok: boolean; text: string }>(),
    trail: jsonb("trail")
      .$type<{ at: string; text: string; code?: string; params?: Record<string, string> }[]>()
      .notNull()
      .default([]),
  },
  (t) => [
    index("approvals_workspace_idx").on(t.workspaceId, t.createdAt),
    index("approvals_pending_idx").on(t.expiresAt).where(sql`status = 'pending'`),
  ],
);

/** Change the agent suggests to its own instructions or to the workspace context. */
export const proposals = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: agent(),
    targetKind: text("target_kind", { enum: ["agent_prompt", "workspace_context", "org_memory"] }).notNull(),
    /** Agent whose instructions change (`agent_prompt` only). */
    targetAgentId: text("target_agent_id"),
    /** Workspace memory file that changes (`org_memory` only; empty `before` = new file). */
    targetPath: text("target_path"),
    title: text("title").notNull(),
    before: text("before").notNull(),
    after: text("after").notNull(),
    why: text("why").notNull().default(""),
    evidence: text("evidence").notNull().default(""),
    status: text("status", { enum: ["pending", "accepted", "refused"] })
      .notNull()
      .default("pending"),
    channelId: text("channel_id"),
    messageId: text("message_id"),
    runId: text("run_id"),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    /** Created, accepted (with or without edits), rejected, undone: each step with who and when. */
    trail: jsonb("trail")
      .$type<{ at: string; text: string; code?: string; params?: Record<string, string> }[]>()
      .notNull()
      .default([]),
  },
  (t) => [index("proposals_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/** Question the agent asks mid-run (`ask_user`). */
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: agent(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id"),
    runId: text("run_id"),
    messageId: text("message_id"),
    /** Who asked the agent: the person the question "needs". */
    askedUserId: text("asked_user_id"),
    text: text("text").notNull(),
    choices: jsonb("choices").$type<string[]>().notNull().default([]),
    status: text("status", { enum: ["open", "answered", "expired"] })
      .notNull()
      .default("open"),
    answer: text("answer"),
    responderUserId: text("responder_user_id"),
    createdAt: createdAt(),
    answeredAt: ts("answered_at"),
  },
  (t) => [index("questions_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/** Something the agent changed outside the conversation that can be undone for a while. */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: agent(),
    runId: text("run_id"),
    /** Agent message where the receipt shows; null until the run posts. */
    messageId: text("message_id"),
    requesterUserId: text("requester_user_id"),
    kind: text("kind").notNull(),
    target: jsonb("target")
      .$type<{ type: string; id: string; number?: number; slug?: string; title?: string }>()
      .notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    undoableUntil: ts("undoable_until"),
    undoneAt: ts("undone_at"),
    reverterUserId: text("reverter_user_id"),
  },
  (t) => [index("agent_actions_message_idx").on(t.messageId), index("agent_actions_run_idx").on(t.runId)],
);

/**
 * Narrow "always allow": the agent runs this tool with this predicate without asking, for 30 days. Only
 * applies where the request would come from a workspace rule, at K1/K2, and in a run without flag A.
 */
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: agent(),
    tool: text("tool").notNull(),
    ruleKey: text("rule_key").notNull(),
    label: text("label").notNull(),
    /** The approval where the person chose to remember. */
    approvalId: text("approval_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokedByUserId: text("revoked_by_user_id"),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [
    // One live rule per predicate: remembering again renews it (30 days from now).
    uniqueIndex("approval_rules_match_uq").on(t.agentId, t.tool, t.ruleKey).where(sql`revoked_at is null`),
    index("approval_rules_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

/**
 * Send with an undo window: the agent's emails and posts wait until `sendAt` before going out. Undoing
 * within the window cancels and nothing is sent.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: agent(),
    runId: text("run_id"),
    kind: text("kind", { enum: ["mail", "post"] }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    sendAt: ts("send_at").notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "canceled", "failed"] })
      .notNull()
      .default("pending"),
    error: text("error"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
    canceledByUserId: text("canceled_by_user_id"),
  },
  (t) => [index("outbox_pending_idx").on(t.sendAt).where(sql`status = 'pending'`)],
);
