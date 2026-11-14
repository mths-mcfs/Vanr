import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { createdAt, ts, updatedAt } from "./columns";
import { workspaces } from "./workspaces";

const workspace = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

export type ToolAccessLevel = "read" | "write" | "approval" | "off";

/** A tool of an MCP server as stored: what the server said and what the workspace decided. */
export interface StoredTool {
  name: string;
  description: string;
  /** Name the workspace gave it (empty = the server's). */
  label: string;
  access: ToolAccessLevel;
  suggestedAccess: ToolAccessLevel;
  readOnlyHint: boolean;
  inputSchema: Record<string, unknown>;
  /** The workspace has decided on this tool; a new tool without a decision stays away from agents. */
  confirmed: boolean;
}

/** Workspace connection to a catalog connector or to its own MCP server (`custom`). */
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    /** Catalog id; "custom" for an own MCP server. */
    connector: text("connector").notNull(),
    custom: boolean("custom").notNull().default(false),
    label: text("label").notNull(),
    accountDisplayName: text("account_display_name"),
    /** MCP server address (from the catalog or entered). */
    serverUrl: text("server_url"),
    authKind: text("auth_kind", { enum: ["api_key", "oauth", "none"] }).notNull(),
    /** Sealed JSON: {apiKey} or the OAuth tokens. */
    secret: text("secret"),
    tools: jsonb("tools").$type<StoredTool[]>().notNull().default([]),
    reviewedAt: ts("reviewed_at"),
    /** `pending`: OAuth started and did not come back. */
    status: text("status", { enum: ["pending", "active", "reauth_required"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by"),
    /**
     * An agent's own account: only that agent uses it, instead of the workspace connection for the same
     * service. null = workspace connection.
     */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /**
     * The service asked for more scope (`insufficient_scope`): what is still to request and how many times
     * this same set was requested. Cleared when the person authorizes.
     */
    scopeRequest: jsonb("scope_request").$type<ScopeRequest | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("connections_workspace_idx").on(t.workspaceId), index("connections_agent_idx").on(t.agentId)],
);

/** Pending extra authorization step on an OAuth connection. */
export interface ScopeRequest {
  /** Union of the scope already requested and what the service required (RFC 6749 §3.3). */
  scope: string;
  /** Times this same set was requested; at the limit, it stops asking. */
  attempts: number;
  /** Tool that asked (for the card). */
  tool: string;
  at: string;
}

/** OAuth round trip (connector, own MCP server, GitHub App): the state is the key. */
export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    workspaceId: workspace(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["connector", "github_app", "mail"] }).notNull(),
    /** Connection (or mail account) the callback completes. */
    targetId: text("target_id"),
    /** Sealed JSON: PKCE verifier, client and token endpoint. */
    secret: text("secret"),
    returnTo: text("return_to").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_states_exp_idx").on(t.expiresAt)],
);

/**
 * An agent's permissions as raw scopes. `connectionId` is empty for built-ins and for the special ones: `*`
 * (everything), `tool:<name>` (allow) and `deny:<name>` (deny). On a connection: `connector:*` (the whole
 * connection) or a connector scope (`linear:read`).
 */
export const agentGrants = pgTable(
  "agent_grants",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: workspace(),
    connectionId: text("connection_id").notNull().default(""),
    scope: text("scope").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectionId, t.scope] })],
);

/**
 * An agent's restriction in a channel: the channel can only lower the level the workspace granted on a
 * connection (`*` = all). `off` removes it, `read` leaves read-only, `approval` requires a person for every
 * write.
 */
export const agentChannelAccess = pgTable(
  "agent_channel_access",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: workspace(),
    channelId: text("channel_id").notNull(),
    connectionId: text("connection_id").notNull(),
    level: text("level", { enum: ["off", "read", "approval"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.channelId, t.connectionId] })],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    /** GitHub installation id. An installation belongs to a single workspace. */
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    accountUsername: text("account_username").notNull(),
    suspended: boolean("suspended").notNull().default(false),
    repoScope: text("repo_scope", { enum: ["all", "selected"] })
      .notNull()
      .default("selected"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("github_installations_workspace_idx").on(t.workspaceId)],
);

export interface MailPolicyRow {
  folders: string[];
  senders: string[];
  windowDays: number | null;
  allowedRecipients: string[];
  dailySendCap: number;
  sendWithoutAsking: boolean;
  fromAddress: string | null;
}

export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    provider: text("provider").notNull(),
    preset: text("preset"),
    via: text("via", { enum: ["composio", "imap"] }).notNull(),
    address: text("address").notNull(),
    label: text("label").notNull(),
    status: text("status", { enum: ["pending", "active", "reauth_required"] })
      .notNull()
      .default("active"),
    /** Sealed JSON: servers and password (IMAP) or the hosted account. */
    secret: text("secret"),
    disabledActions: jsonb("disabled_actions").$type<string[]>().notNull().default([]),
    confirmActions: jsonb("confirm_actions").$type<string[]>().notNull().default([]),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mail_accounts_address_uq").on(t.workspaceId, t.address)],
);

export const agentMailboxes = pgTable(
  "agent_mailboxes",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    workspaceId: workspace(),
    level: text("level", { enum: ["none", "read", "read_write"] }).notNull(),
    canDelete: boolean("can_delete").notNull().default(false),
    policy: jsonb("policy").$type<MailPolicyRow>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.accountId] })],
);

export interface DatabasePolicyRow {
  tables: string[];
  hiddenColumns: string[];
  dailyQueryCap: number | null;
  timeoutSeconds: 15 | 30 | 60;
}

export const databaseConnections = pgTable(
  "database_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    label: text("label").notNull(),
    provider: text("provider").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(5432),
    database: text("database").notNull(),
    username: text("username").notNull(),
    sslmode: text("sslmode", { enum: ["disable", "require", "verify-full"] })
      .notNull()
      .default("require"),
    /** Sealed password. */
    secret: text("secret").notNull(),
    status: text("status", { enum: ["active", "reauth_required"] })
      .notNull()
      .default("active"),
    /** The database user can write: we warn that a read-only user is better. */
    canWrite: boolean("can_write").notNull().default(false),
    disabledActions: jsonb("disabled_actions").$type<string[]>().notNull().default([]),
    hiddenSuggestion: jsonb("hidden_suggestion").$type<string[]>().notNull().default([]),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("database_connections_workspace_idx").on(t.workspaceId)],
);

export const agentDatabases = pgTable(
  "agent_databases",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => databaseConnections.id, { onDelete: "cascade" }),
    workspaceId: workspace(),
    level: text("level", { enum: ["none", "read"] }).notNull(),
    policy: jsonb("policy").$type<DatabasePolicyRow>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectionId] })],
);

/** Usage with a daily quota: sending email and querying databases. */
export const integrationUsage = pgTable(
  "integration_usage",
  {
    id: text("id").primaryKey(),
    workspaceId: workspace(),
    agentId: text("agent_id").notNull(),
    resourceId: text("resource_id").notNull(),
    kind: text("kind", { enum: ["mail_send", "db_query"] }).notNull(),
    at: ts("at").notNull(),
  },
  (t) => [index("integration_usage_idx").on(t.agentId, t.resourceId, t.kind, t.at)],
);

export interface S3ConfigRow {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string | null;
  pathStyle: boolean;
}

export interface StorageMigrationRow {
  status: "running" | "done" | "failed";
  copied: number;
  total: number;
  error: string | null;
}

export const workspaceStorage = pgTable("workspace_storage", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["builtin", "s3"] }).notNull(),
  s3: jsonb("s3").$type<S3ConfigRow>(),
  /** Sealed JSON: {accessKeyId, secretAccessKey}. */
  secret: text("secret"),
  accessKeyIdPreview: text("access_key_id_preview"),
  secretPreview: text("secret_preview"),
  migration: jsonb("migration").$type<StorageMigrationRow>(),
  updatedAt: updatedAt(),
});
