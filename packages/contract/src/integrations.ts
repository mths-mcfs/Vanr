// Connectors, agent identity, mail, databases, GitHub and storage.

export type ToolAccess = "approval" | "off" | "read" | "write";

export interface ConnectorDef {
  id: string;
  auth: "api_key" | "none" | "oauth";
  /** Every accepted method (a connector can accept OAuth and a key). */
  authMethods: ("api_key" | "oauth")[];
  /** false: shown as "coming soon". */
  available: boolean;
  brandColor: string | null;
  category: string;
  description: string;
  iconUrl: string | null;
  kind: "api_key" | "builtin" | "hosted_mcp" | "oauth";
  label: string;
  needsServerUrl: boolean;
  oauthConfigured: boolean;
  scopes: { id: string; access: "read" | "write"; label: string }[];
  serverUrl: string | null;
  tools: { name: string; scope: string; sensitive: boolean }[];
}

export interface ConnectorCatalog {
  builtinScopes: { id: string; access: "read" | "write"; label: string }[];
  connectors: ConnectorDef[];
}

export interface Connection {
  id: string;
  accountDisplayName: string | null;
  connector: string;
  createdAt: string;
  label: string;
  revokedAt: string | null;
  /** The service asked for more scope and nobody granted it yet (extra step after `insufficient_scope`). */
  scopeRequest?: { scope: string; tool: string } | null;
  /** reauth_required: the service rejected the stored credential. */
  status: "active" | "reauth_required";
}

/** Restriction of an agent in a channel: `connectionId` is a connection or `*` (all). */
export type ChannelAccessLevel = "approval" | "off" | "read";

export interface ChannelAccessRule {
  channelId: string;
  connectionId: string;
  level: ChannelAccessLevel;
}

/** The agent's own identity: its accounts on services and the per-channel rules. */
export interface AgentIdentity {
  channels: ChannelAccessRule[];
  connections: Connection[];
}

export interface IdentityConnectInput {
  /** With a key it connects right away; without one, OAuth (the person signs in to the agent's account on the service). */
  apiKey?: string;
  connector: string;
  returnTo: string;
}

export type IdentityConnectStart =
  | { connection: Connection; status: "connected" }
  | { authorizeUrl: string; status: "oauth" };

export interface CustomServerTool {
  access: ToolAccess;
  /** The workspace already decided; a new tool without a decision stays off for agents. */
  confirmed: boolean;
  description: string;
  label: string;
  name: string;
  readOnlyHint: boolean;
  suggestedAccess: ToolAccess;
}

export interface CustomServer {
  id: string;
  createdAt: string;
  label: string;
  reviewedAt: string | null;
  serverUrl: string;
  tools: CustomServerTool[];
}

export type CustomConnectStart =
  | { authorizeUrl: string; serverId: string; status: "oauth" }
  | { serverId: string | null; status: "key_missing" }
  | { server: CustomServer; status: "server" };

export interface SaveToolsInput {
  label: string;
  tools: { access: ToolAccess; confirmed?: boolean; label: string; name: string }[];
}

export interface ScopeGrant {
  connectionId: string;
  scope: string;
}

export type AccessLevel = "custom" | "none" | "read" | "write";

export interface AgentAccess {
  all: boolean;
  builtins: { enabled: boolean; scope: string }[];
  connectors: {
    connectionId: string;
    connector: string;
    custom: boolean;
    label: string;
    scopes: string[];
    state: AccessLevel;
  }[];
  tools: { allow: string[]; deny: string[] };
}

export interface AccessInput {
  all?: boolean;
  connectors?: Record<string, boolean>;
  scopes?: ScopeGrant[];
  tools?: { allow: string[]; deny: string[] };
}

export interface GitHubAppInstallation {
  id: string;
  accountUsername: string;
  repoScope: "all" | "selected";
  suspended: boolean;
}

export interface GitHubRepositories {
  accounts: { login: string; repositories: { fullName: string; private: boolean }[] }[];
  connected: boolean;
}

export interface MailProviders {
  /** Providers Composio serves on this server (each needs its own auth config). */
  composio: ("gmail" | "outlook")[];
  imap: boolean;
  presets: { id: string; appPasswordUrl: string | null; host: string; label: string; port: number }[];
}

export type MailLevel = "none" | "read" | "read_write";

export interface MailAccount {
  id: string;
  address: string;
  agents: { agentId: string; level: MailLevel }[];
  confirmActions: string[];
  disabledActions: string[];
  label: string;
  preset: string | null;
  provider: string;
  status: "active" | "pending" | "reauth_required";
  via: "composio" | "imap";
}

export interface MailFolder {
  id: string;
  name: string;
  role: "archive" | "drafts" | "inbox" | "other" | "sent" | "trash";
}

export interface MailPolicy {
  allowedRecipients: string[];
  dailySendCap: number;
  folders: string[];
  fromAddress: string | null;
  senders: string[];
  sendWithoutAsking: boolean;
  /** null = no day limit. */
  windowDays: number | null;
}

export interface AgentMailbox {
  accountId: string;
  canDelete: boolean;
  level: MailLevel;
  policy: MailPolicy;
}

export interface ConnectImapInput {
  address: string;
  /** Only for the "other" preset: servers the person entered. */
  imapHost?: string;
  imapPort?: number;
  password: string;
  preset: string;
  smtpHost?: string;
  smtpPort?: number;
  username?: string;
}

export interface MailUpdateInput {
  confirmActions?: string[];
  disabledActions?: string[];
  label?: string;
  password?: string;
}

export interface SetAgentMailInput {
  canDelete?: boolean;
  level: MailLevel;
  policy?: Partial<MailPolicy>;
}

export type DatabaseProvider = "neon" | "other" | "railway" | "rds" | "render" | "supabase";

export interface DatabaseConnection {
  id: string;
  agents: { agentId: string; level: "none" | "read" }[];
  canWrite: boolean;
  database: string;
  disabledActions: string[];
  hiddenSuggestion: string[];
  host: string;
  label: string;
  provider: DatabaseProvider;
  status: "active" | "reauth_required";
  username: string;
}

export interface DatabaseTable {
  name: string;
  schema: string;
}

export interface DatabasePolicy {
  /** null = no limit. */
  dailyQueryCap: number | null;
  hiddenColumns: string[];
  tables: string[];
  timeoutSeconds: 15 | 30 | 60;
}

export interface AgentDatabase {
  connectionId: string;
  level: "none" | "read";
  policy: DatabasePolicy;
}

export interface DatabaseConnectInput {
  database?: string;
  host?: string;
  label?: string;
  password?: string;
  port?: number;
  provider: DatabaseProvider;
  sslmode?: "disable" | "require" | "verify-full";
  url?: string;
  username?: string;
}

export interface DatabaseUpdateInput {
  disabledActions?: string[];
  label?: string;
  password?: string;
}

export interface SetAgentDatabaseInput {
  level: "none" | "read";
  policy?: Partial<DatabasePolicy>;
}

export interface S3Config {
  bucket: string;
  endpoint: string;
  pathStyle: boolean;
  prefix: string | null;
  region: string;
}

/** S3 form: keys may be missing when a configuration is already saved (the current ones are kept). */
export type S3Input = S3Config & { accessKeyId?: string; secretAccessKey?: string };

export interface StorageMigration {
  copied: number;
  error: string | null;
  status: "done" | "failed" | "running";
  total: number;
}

export interface StorageConfig {
  kind: "builtin" | "s3";
  migration: StorageMigration | null;
  s3: (S3Config & { accessKeyIdPreview: string; secretPreview: string }) | null;
}

export type StorageInput = { kind: "builtin" } | { kind: "s3"; s3: S3Input };

export interface StorageTestResult {
  ok: boolean;
  steps: { error?: string; ok: boolean; step: "delete" | "list" | "read" | "write" }[];
}
