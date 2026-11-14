// Immutable history of instructions and memory, and the review queue for memory
// written by a run that read outside content (flag A).
import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, type MemoryOrigin, memories } from "./agents";
import { createdAt, ts, updatedAt } from "./columns";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

const author = () => ({
  authorType: text("author_type", { enum: ["person", "agent", "system"] }).notNull(),
  /** userId, agentId or null (system: the starting version of a text that already existed). */
  authorId: text("author_id"),
});

/**
 * One version of an agent's instructions. Append-only: going back to a version writes a new one with its
 * text (`restore`, with `restoredFromSeq`).
 */
export const instructionVersions = pgTable(
  "instruction_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    ...author(),
    reason: text("reason").notNull().default(""),
    source: text("source", {
      enum: ["initial", "create", "edit", "proposal", "undo", "redo", "restore", "builder"],
    }).notNull(),
    proposalId: text("proposal_id"),
    restoredFromSeq: integer("restored_from_seq"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("instruction_versions_uq").on(t.agentId, t.seq)],
);

/** One version of a memory item: the full state after the change, with who, when, run and reason. */
export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    op: text("op", {
      enum: ["initial", "create", "update", "archive", "unarchive", "rename", "restore"],
    }).notNull(),
    text: text("text").notNull(),
    path: text("path"),
    archived: boolean("archived").notNull(),
    sha256: text("sha256").notNull(),
    ...author(),
    runId: text("run_id"),
    reason: text("reason").notNull().default(""),
    /** Approved in the review queue: who approved it. */
    approvedByUserId: text("approved_by_user_id"),
    restoredFromSeq: integer("restored_from_seq"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memory_versions_uq").on(t.memoryId, t.seq)],
);

/**
 * Memory write requested by a run with flag A on: it does not apply until a person approves. Stores the
 * operation, the resulting text and the hash of the base text (approving after the base changed fails).
 */
export const memoryReviews = pgTable(
  "memory_reviews",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    scope: text("scope", { enum: ["agent", "person"] }).notNull(),
    ownerUserId: text("owner_user_id"),
    op: text("op", { enum: ["create", "update", "archive", "rename"] }).notNull(),
    /** Item being changed; null on `create`. */
    memoryId: text("memory_id"),
    path: text("path"),
    newPath: text("new_path"),
    text: text("text").notNull(),
    kind: text("kind", { enum: ["fact", "decision", "preference", "lesson"] })
      .notNull()
      .default("fact"),
    about: text("about"),
    supersedes: text("supersedes"),
    /** SHA-256 of the item text when the run asked (null on `create`). */
    baseSha256: text("base_sha256"),
    /** What turned flag A on in the run (`mail_read account/INBOX/42`). */
    reasons: jsonb("reasons").$type<{ flag: string; source: string }[]>().notNull().default([]),
    origin: jsonb("origin").$type<MemoryOrigin>().notNull(),
    tool: text("tool").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "failed"] })
      .notNull()
      .default("pending"),
    deciderUserId: text("decider_user_id"),
    decidedAt: ts("decided_at"),
    /** Reason for the rejection or for the error when applying (`changed_since`). */
    note: text("note"),
    resultMemoryId: text("result_memory_id"),
    createdAt: createdAt(),
  },
  (t) => [index("memory_reviews_pending_idx").on(t.workspaceId, t.agentId).where(sql`status = 'pending'`)],
);

/**
 * An agent test case: a request and what the answer must contain or avoid. Runs before and after accepting
 * an instructions proposal (`agent_evals`).
 */
export const agentTestCases = pgTable(
  "agent_test_cases",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    input: text("input").notNull(),
    /** Snippets the answer must contain (case-insensitive). */
    mustInclude: jsonb("must_include").$type<string[]>().notNull().default([]),
    mustNotInclude: jsonb("must_not_include").$type<string[]>().notNull().default([]),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agent_test_cases_agent_idx").on(t.agentId)],
);

/** Answer of one side (instructions before or after) to a case. */
export interface EvalSide {
  text: string;
  pass: boolean;
  /** What failed: `include:snippet`, `exclude:snippet` or `error:code`. */
  failed: string[];
}

export interface EvalCaseResult {
  caseId: string;
  input: string;
  before: EvalSide;
  after: EvalSide;
}

export interface EvalSummary {
  cases: number;
  beforePass: number;
  afterPass: number;
  /** Cases that passed before and fail after. */
  regressions: number;
}

/**
 * One round of the cases with the current instructions (before) and the candidate ones (after). Advisory
 * only: accepting the proposal does not depend on it. One open round per agent.
 */
export const agentEvals = pgTable(
  "agent_evals",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id"),
    beforeText: text("before_text").notNull(),
    textAfter: text("text_after").notNull(),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    /** Cases in the round (results arrive one by one). */
    total: integer("total").notNull().default(0),
    results: jsonb("results").$type<EvalCaseResult[]>().notNull().default([]),
    summary: jsonb("summary").$type<EvalSummary>(),
    error: text("error"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("agent_evals_agent_idx").on(t.agentId, t.createdAt),
    uniqueIndex("agent_evals_running_uq").on(t.agentId).where(sql`status = 'running'`),
  ],
);

/** One item of the consolidated set, with its source items and the reason. */
export interface ConsolidatedItem {
  /** `keep`: unchanged; `merge`: several into one; `rewrite`: rewrites one; `drop`: archives. */
  action: "keep" | "merge" | "rewrite" | "drop";
  sources: string[];
  path: string | null;
  text: string;
  reason: string;
  /** Inherited: if any source came from an untrusted source, the result does too. */
  untrustedSource: boolean;
}

/**
 * Consolidation of an agent's memory: a server-side job reads the store and proposes a new set. Nothing
 * changes until a person applies it; applying checks that no source item changed.
 */
export const memoryConsolidations = pgTable(
  "memory_consolidations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "ready", "applied", "discarded", "failed"] })
      .notNull()
      .default("running"),
    items: jsonb("items").$type<ConsolidatedItem[]>().notNull().default([]),
    /** SHA-256 of each read item's text, by id: applying only works if all still match. */
    bases: jsonb("bases").$type<Record<string, string>>().notNull().default({}),
    /** Items read and items active in the store (reading is capped). */
    covered: integer("covered").notNull().default(0),
    total: integer("total").notNull().default(0),
    error: text("error"),
    runId: text("run_id"),
    createdBy: text("created_by"),
    deciderUserId: text("decider_user_id"),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    index("memory_consolidations_agent_idx").on(t.agentId, t.createdAt),
    uniqueIndex("memory_consolidations_open_uq").on(t.agentId).where(sql`status in ('running', 'ready')`),
  ],
);
