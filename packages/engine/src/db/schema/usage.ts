// Usage ledger, caps and telemetry of effect decisions.
//
// usage_lines: one row per model call (or per iteration of it: the advisor gets its own row).
// usage_reservations + usage_reservation_scopes: reservations opened before each call.
// budget_counters: recorded spend per scope and period; a reservation locks the counter row
// (`FOR UPDATE`), so parallel reservations on the same scope go through one at a time.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, ts } from "./columns";
import type { CredentialRef } from "./json";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

const micros = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

export const usageLines = pgTable(
  "usage_lines",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id"),
    userId: text("user_id"),
    channelId: text("channel_id"),
    assignmentId: text("assignment_id"),
    runId: text("run_id"),
    /** Reservation that paid for the call (null: recorded without a cap, e.g. the runner plan). */
    reservationId: text("reservation_id"),
    seq: integer("seq").notNull().default(0),
    source: text("source").notNull(),
    iteration: text("iteration").notNull().default("message"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    cacheWrite5mTokens: integer("cache_write_5m_tokens").notNull().default(0),
    cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    batch: boolean("batch").notNull().default(false),
    speed: text("speed").notNull().default("standard"),
    inferenceGeo: text("inference_geo"),
    serviceTier: text("service_tier"),
    keySource: text("key_source", { enum: ["platform", "org", "plan"] })
      .notNull()
      .default("platform"),
    /** Cost in millionths of a dollar (integer: sums without floating point error). */
    costMicros: micros("cost_micros"),
    priceVersion: text("price_version"),
    at: ts("at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_lines_workspace_idx").on(t.workspaceId, t.at),
    index("usage_lines_agent_idx").on(t.agentId, t.at),
    index("usage_lines_run_idx").on(t.runId),
    // Seed for the channel counter (the month's spend before the counter existed).
    index("usage_lines_channel_idx").on(t.channelId, t.at),
    uniqueIndex("usage_lines_reservation_uq")
      .on(t.reservationId, t.seq)
      .where(sql`reservation_id is not null`),
  ],
);

export const usageReservations = pgTable(
  "usage_reservations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    estimateMicros: micros("estimate_micros"),
    status: text("status", { enum: ["open", "settled", "released"] })
      .notNull()
      .default("open"),
    scopes: jsonb("scopes")
      .$type<{ kind: string; id: string; limitUsd: number; period: "month" | "total" }[]>()
      .notNull(),
    at: ts("at").notNull(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("usage_reservations_open_idx").on(t.expiresAt).where(sql`status = 'open'`)],
);

/** One row per reservation scope, to add up the open reservations of a scope. */
export const usageReservationScopes = pgTable(
  "usage_reservation_scopes",
  {
    reservationId: text("reservation_id")
      .notNull()
      .references(() => usageReservations.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    period: text("period").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reservationId, t.scope] }),
    index("usage_reservation_scopes_idx").on(t.scope, t.period),
  ],
);

/** Recorded spend by scope (`agent:ag_1`) and period (`2026-10` or `total`). */
export const budgetCounters = pgTable(
  "budget_counters",
  {
    scope: text("scope").notNull(),
    period: text("period").notNull(),
    workspaceId: workspace(),
    spentMicros: micros("spent_micros"),
  },
  (t) => [primaryKey({ columns: [t.scope, t.period] })],
);

/**
 * Gate telemetry: one row per tool call that went through it (class, decision, reason, flags). The outcome
 * of the request and the decision time come from the linked approval.
 */
export const toolDecisions = pgTable(
  "tool_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id").notNull(),
    runId: text("run_id"),
    tool: text("tool").notNull(),
    effect: text("effect", { enum: ["K0", "K1", "K2", "K3"] }).notNull(),
    decision: text("decision", { enum: ["allow", "ask", "deny"] }).notNull(),
    reason: text("reason"),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    approvalId: text("approval_id"),
    /** Who requested the run (null for routines) and the action's credential, for audit and revocation. */
    requestedBy: text("requested_by"),
    credential: jsonb("credential").$type<CredentialRef | null>(),
    /** Who resolved the request without a person: an "always allow" rule or the model reviewer. */
    by: text("by", { enum: ["rule", "reviewer"] }),
    ruleId: text("rule_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("tool_decisions_workspace_idx").on(t.workspaceId, t.createdAt),
    index("tool_decisions_approval_idx").on(t.approvalId),
    index("tool_decisions_reviewer_idx").on(t.agentId, t.createdAt).where(sql`by = 'reviewer'`),
  ],
);
