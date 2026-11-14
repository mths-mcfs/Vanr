import type { BrowserLevel, RunnerCli, RunnerSandbox, SecretBrowserBinding } from "@vanr/contract";
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, ts, updatedAt } from "./columns";
import type { BlockedLoad } from "./json";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export interface RunnerAccessRow {
  folders: { path: string; agents: string[] }[];
  tools: { claude: boolean; codex: boolean; commands: boolean; browser: boolean };
}

/**
 * Runner paired by device code. The runner keeps a device credential (only its hash is stored here) that
 * can only mint short sessions (`runner_sessions`); each minted session rotates the credential: the new one
 * stays pending until first use, and reusing the previous one revokes everything (someone copied the
 * credential).
 */
export const runners = pgTable(
  "runners",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    name: text("name").notNull(),
    os: text("os").notNull().default(""),
    arch: text("arch").notNull().default(""),
    hostname: text("hostname").notNull().default(""),
    runnerRelease: text("runner_release").notNull().default(""),
    tokenHash: text("token_hash").notNull(),
    /** New credential handed out with the last session and not used yet. */
    tokenPendingHash: text("token_pending_hash"),
    /** Credential the current one replaced: if used again, it revokes the runner. */
    tokenPrevHash: text("token_prev_hash"),
    credentialRotatedAt: ts("credential_rotated_at"),
    /** Revoked credentials (by a person or by reuse): the runner stays listed until paired again. */
    revokedAt: ts("revoked_at"),
    revokedReason: text("revoked_reason", { enum: ["manual", "reuse"] }),
    /** Isolation of the agent's processes, as the runner reported in `hello`. */
    sandbox: jsonb("sandbox").$type<RunnerSandbox>(),
    /** Key for the secrets stored on the runner, sealed with the server key. */
    storeKey: text("store_key").notNull(),
    pairedByUserId: text("paired_by_user_id").notNull(),
    workDir: text("work_dir"),
    access: jsonb("access")
      .$type<RunnerAccessRow>()
      .notNull()
      .default({ folders: [], tools: { claude: false, codex: false, commands: false, browser: false } }),
    executors: jsonb("executors").$type<("claude_code" | "codex")[]>().notNull().default([]),
    /** Claude Code and Codex login on the runner (subscription, API key, none). */
    cli: jsonb("cli").$type<{ claude_code?: RunnerCli; codex?: RunnerCli }>().notNull().default({}),
    browser: boolean("browser").notNull().default(false),
    paused: boolean("paused").notNull().default(false),
    lastOnlineAt: ts("last_online_at"),
    /** When it went offline (for runner-offline notices). */
    disconnectedAt: ts("disconnected_at"),
    removedAt: ts("removed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("runners_token_uq").on(t.tokenHash),
    index("runners_token_pending_idx").on(t.tokenPendingHash),
    index("runners_token_prev_idx").on(t.tokenPrevHash),
    index("runners_workspace_idx").on(t.workspaceId),
  ],
);

/** Single-use session for the WebSocket `hello` (2 minutes). */
export const runnerSessions = pgTable(
  "runner_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    /**
     * Hash of the new credential handed out with this session. Using the session proves the runner received
     * (and stored) that credential: it becomes the current one, and the previous one revokes if it shows up
     * again.
     */
    credentialHash: text("credential_hash"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
  },
  (t) => [index("runner_sessions_runner_idx").on(t.runnerId)],
);

/**
 * Domain an agent process tried to reach and the sandbox proxy blocked. It becomes a card in the
 * conversation; once allowed, it joins the agent's network list (`allowed`) until someone removes it.
 */
export const networkRequests = pgTable(
  "network_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status", { enum: ["pending", "allowed", "denied", "removed"] })
      .notNull()
      .default("pending"),
    /** What the agent was running when it hit the block (command or job title). */
    context: text("context").notNull().default(""),
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    messageId: text("message_id"),
    runId: text("run_id"),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("network_requests_agent_idx").on(t.agentId, t.status),
    uniqueIndex("network_requests_open_uq")
      .on(t.agentId, t.domain)
      .where(sql`${t.status} in ('pending', 'allowed')`),
  ],
);

/** Pairing request (device code, 10 minutes). The token is sealed until the runner fetches it. */
export const runnerPairings = pgTable(
  "runner_pairings",
  {
    userCode: text("user_code").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    name: text("name").notNull().default(""),
    os: text("os").notNull(),
    arch: text("arch").notNull(),
    hostname: text("hostname").notNull(),
    version: text("version").notNull(),
    previousRunnerId: text("previous_runner_id"),
    status: text("status", { enum: ["pending", "approved", "denied", "claimed"] })
      .notNull()
      .default("pending"),
    workspaceId: text("workspace_id"),
    runnerId: text("runner_id"),
    signedOffBy: text("signed_off_by"),
    /** Token sealed between confirmation and the runner's fetch; cleared once it fetches. */
    tokenSealed: text("token_sealed"),
    lastPollAt: ts("last_poll_at"),
    intervalSeconds: integer("interval_seconds").notNull().default(3),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("runner_pairings_code_uq").on(t.deviceCodeHash)],
);

export interface TaskUsageRow {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** What the CLI says it would cost through the API (Claude Code reports it; Codex does not). Not billed. */
  costUsd: number | null;
}

/** A job on a runner (assignment executor or long command). */
export const runnerJobs = pgTable(
  "runner_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    runnerId: text("runner_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id"),
    threadId: text("thread_id"),
    channelId: text("channel_id"),
    title: text("title").notNull(),
    executor: text("executor", { enum: ["claude_code", "codex", "shell"] }).notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed", "interrupted", "canceled"] })
      .notNull()
      .default("queued"),
    resumedJobId: text("resumed_job_id"),
    branch: text("branch"),
    prUrl: text("pr_url"),
    files: jsonb("files").$type<string[]>().notNull().default([]),
    exitCode: integer("exit_code"),
    tailLine: text("tail_line"),
    result: text("result"),
    session: text("session"),
    /** Last lines kept, to show while the runner is offline. */
    outputTail: jsonb("output_tail").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    lastSignalAt: ts("last_signal_at"),
    /** Assignment plan item the job works on. */
    planItemId: text("plan_item_id"),
    /** Tokens the CLI reported at the end (the pairing person's plan: no USD here). */
    usage: jsonb("usage").$type<TaskUsageRow | null>(),
    /**
     * Commands the permission check blocked (they become cards on the assignment). Stored at the end: the
     * engine rereads them from here.
     */
    denied: jsonb("denied").$type<string[]>().notNull().default([]),
    /** `git diff` at the end of the job (truncated on the runner); becomes a proof on the assignment. */
    diff: text("diff"),
    /**
     * The assignment finished processing the end (event, finding, proofs, cards): the engine continues from
     * here.
     */
    settledAt: ts("settled_at"),
    /**
     * The `usage` tokens are already in the ledger (an end reprocessed after a crash does not record them
     * again).
     */
    costRecordedAt: ts("cost_recorded_at"),
  },
  (t) => [
    index("runner_jobs_thread_idx").on(t.threadId),
    index("runner_jobs_runner_idx").on(t.runnerId),
    index("runner_jobs_assignment_idx").on(t.assignmentId),
  ],
);

/** State of the agent's environment. The target (runner) is in `agents.environment_id`. */
export const agentEnvironments = pgTable("agent_environments", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  workspaceId: workspace(),
  status: text("status", { enum: ["none", "running", "stopped", "archived"] })
    .notNull()
    .default("none"),
  lastUsedAt: ts("last_used_at"),
  updatedAt: updatedAt(),
});

/** Cloud environment of the workspace (sandbox). This installation has no provider: it stays unavailable. */
export const sandboxPolicies = pgTable("sandbox_policies", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  network: text("network", { enum: ["off", "allowlist", "open"] })
    .notNull()
    .default("allowlist"),
  permittedDomains: jsonb("permitted_domains").$type<string[]>().notNull().default([]),
  minutesPerDay: integer("minutes_per_day").notNull().default(120),
  commandTimeoutSec: integer("command_timeout_sec").notNull().default(120),
  requireApproval: boolean("require_approval").notNull().default(false),
  updatedAt: updatedAt(),
});

/** Secret request: the public key belongs to the runner; the server only relays the sealed box. */
export const secretPrompts = pgTable(
  "secret_prompts",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runnerId: text("runner_id").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    target: text("target", { enum: ["env", "file"] }).notNull(),
    /** File path, relative to the agent's folder (target `file`). */
    filePath: text("file_path"),
    status: text("status", { enum: ["pending", "delivered", "declined", "expired", "canceled"] })
      .notNull()
      .default("pending"),
    targetUserId: text("target_user_id"),
    publicKey: text("public_key").notNull(),
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    messageId: text("message_id"),
    runId: text("run_id"),
    decidedBy: text("decided_by"),
    /** Browser secret: only typed on these sites and in this kind of field (sealed along with the value). */
    browser: jsonb("browser").$type<SecretBrowserBinding>(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    fulfilledAt: ts("fulfilled_at"),
  },
  (t) => [index("secret_prompts_agent_idx").on(t.agentId)],
);

/** What the agent has stored on each runner (name only: the value never passes here in the clear). */
export const runnerSecrets = pgTable(
  "runner_secrets",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runnerId: text("runner_id").notNull(),
    name: text("name").notNull(),
    workspaceId: workspace(),
    target: text("target", { enum: ["env", "file"] }).notNull(),
    filePath: text("file_path"),
    deliveredBy: text("delivered_by"),
    browser: jsonb("browser").$type<SecretBrowserBinding>(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.runnerId, t.name] })],
);

/** The agent's request for a person to act in its browser (sign in to an account), or control taken over. */
export const browserInterventions = pgTable(
  "browser_interventions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runnerId: text("runner_id").notNull(),
    kind: text("kind", { enum: ["login", "captcha", "confirm", "other", "intervention"] }).notNull(),
    status: text("status", { enum: ["pending", "active", "done", "failed", "canceled", "expired"] })
      .notNull()
      .default("pending"),
    instructions: text("instructions").notNull().default(""),
    url: text("url"),
    controllingUserId: text("controlling_user_id"),
    targetUserId: text("target_user_id"),
    note: text("note"),
    channelId: text("channel_id"),
    threadId: text("thread_id"),
    messageId: text("message_id"),
    runId: text("run_id"),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    handledAt: ts("handled_at"),
  },
  (t) => [index("browser_interventions_agent_idx").on(t.agentId)],
);

export const browserPolicies = pgTable("browser_policies", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  workspaceId: workspace(),
  /** Read-write sites (the agent clicks and types). */
  permittedDomains: jsonb("permitted_domains").$type<string[]>().notNull().default([]),
  /** Read-only sites (the agent reads, scrolls and follows links). */
  readDomains: jsonb("read_domains").$type<string[]>().notNull().default([]),
  /**
   * What applies outside the lists. Empty = a row from before levels existed: strict with a list, the
   * default without one (it used to be "empty list = any site"; now any site is read-only).
   */
  level: text("level").$type<BrowserLevel>(),
  /** Private network ranges allowed (CIDR). They only apply on the runner where they were allowed. */
  privateRanges: jsonb("private_ranges").$type<string[]>().notNull().default([]),
  privateRangesRunnerId: text("private_ranges_runner_id"),
  updatedAt: updatedAt(),
});

/**
 * The agent's browser log, one entry per action. Append-only: a database trigger rejects UPDATE and DELETE
 * (`browser_log_entries_append_only`), and no route writes here. No foreign key: deleting an agent or a
 * workspace does not take the log with it. Thumbnails live in the blob store, outside the files
 * (`browser-log/<workspace>/<agent>/<entry>.jpg`).
 */
export const browserLogEntries = pgTable(
  "browser_log_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    runnerId: text("runner_id").notNull(),
    runId: text("run_id"),
    channelId: text("channel_id"),
    /** Tool (`browser_click`) and what it asked for, without secret values. */
    tool: text("tool").notNull(),
    action: jsonb("action").$type<Record<string, unknown>>().notNull(),
    url: text("url"),
    outcome: text("outcome", { enum: ["ok", "error", "blocked"] }).notNull(),
    message: text("message"),
    blocked: jsonb("blocked").$type<BlockedLoad[]>().notNull().default([]),
    shotKey: text("shot_key"),
    at: ts("at").notNull(),
  },
  (t) => [
    index("browser_log_entries_agent_idx").on(t.agentId, t.at),
    index("browser_log_entries_run_idx").on(t.runId),
  ],
);
