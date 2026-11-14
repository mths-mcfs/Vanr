// Connectors, the agent's own identity, GitHub, mail accounts, databases and the workspace's storage.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";

const Consent = s.object({ consentUrl: s.string });

export const integrations = {
  getConnectorCatalog: e("GET", "/api/v1/connectors/catalog", C.ConnectorCatalog),
  listConnectors: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/connectors",
    s.field("connections", s.array(C.Connection)),
  ),
  createConnector: e("POST", "/api/v1/workspaces/:workspaceId/connectors", C.Connection).body<{
    connector: string;
    apiKey: string;
    serverUrl?: string;
    label?: string;
  }>(),
  startConnectorOauth: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/connectors/:connectorId/oauth/start",
    Consent,
  ).body<{ nextPath: string; serverUrl?: string }>(),
  /** Grants the extra scope a service asked for; answers with the consent page to send the person to. */
  createConnectorScope: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/connectors/:connectorId/scope",
    Consent,
  ).body<{
    nextPath: string;
  }>(),
  deleteConnector: e("DELETE", "/api/v1/workspaces/:workspaceId/connectors/:connectorId", NOTHING),
  getConnectorCustom: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/connectors/custom",
    s.field("servers", s.array(C.CustomServer)),
  ),
  createConnectorCustom: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/connectors/custom",
    C.CustomConnectStart,
  ).body<{ serverUrl: string; apiKey?: string; label?: string; nextPath: string }>(),
  refreshConnectorCustom: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/connectors/custom/:customId/refresh",
    C.CustomServer,
  ),
  setConnectorCustomTools: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/connectors/custom/:customId/tools",
    C.CustomServer,
  ).body<T.SaveToolsInput>(),
  deleteConnectorCustom: e("DELETE", "/api/v1/workspaces/:workspaceId/connectors/custom/:customId", NOTHING),

  getAgentIdentity: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId/identity", C.AgentIdentity),
  createAgentIdentityConnection: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/identity/connections",
    C.IdentityConnectStart,
  ).body<T.IdentityConnectInput>(),
  revokeAgentIdentity: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/identity/revoke",
    s.object({ revoked: s.number }),
  ),
  setAgentIdentityChannels: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/identity/channels",
    s.field("channels", s.array(C.ChannelAccessRule)),
  ).body<{ channels: T.ChannelAccessRule[] }>(),
  getAgentAccess: e("GET", "/api/v1/workspaces/:workspaceId/agents/:agentId/access", C.AgentAccess),
  setAgentAccess: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/access",
    C.AgentAccess,
  ).body<T.AccessInput>(),
  listAgentScopes: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/scopes",
    s.field("scopes", s.array(C.ScopeGrant)),
  ),
  setAgentScopes: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/scopes",
    s.field("scopes", s.array(C.ScopeGrant)),
  ).body<{ scopes: T.ScopeGrant[] }>(),

  getGithubApp: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/github-app",
    s.object({ installable: s.boolean, installations: s.array(C.GitHubAppInstallation) }),
  ),
  installGithubApp: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/github-app/install",
    s.field("installUrl", s.string),
  ).body<{ nextPath: string }>(),
  deleteGithubAppInstallation: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/github-app/installations/:installationId",
    NOTHING,
  ),
  listGithubRepositories: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/github/repositories",
    C.GitHubRepositories,
  ),
  listAgentRepositories: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/repositories",
    s.field("repositories", s.array(s.string)),
  ),
  setAgentRepositories: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/repositories",
    s.field("repositories", s.array(s.string)),
  ).body<{ repositories: string[] }>(),

  listMailProviders: e("GET", "/api/v1/workspaces/:workspaceId/mail/providers", C.MailProviders),
  listMailAccounts: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/mail/accounts",
    s.field("accounts", s.array(C.MailAccount)),
  ),
  createMailAccountImap: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/mail/accounts/imap",
    s.field("account", C.MailAccount),
  ).body<T.ConnectImapInput>(),
  createMailAccountComposio: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/mail/accounts/composio",
    s.object({ accountId: s.string, redirectUrl: s.string }),
  ).body<{ provider: "gmail" | "outlook"; label?: string }>(),
  updateMailAccount: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/mail/accounts/:accountId",
    s.field("account", C.MailAccount),
  ).body<T.MailUpdateInput>(),
  deleteMailAccount: e("DELETE", "/api/v1/workspaces/:workspaceId/mail/accounts/:accountId", NOTHING),
  listMailAccountFolders: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/mail/accounts/:accountId/folders",
    s.field("folders", s.array(C.MailFolder)),
  ),
  getAgentMail: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/mail",
    s.field("mailboxes", s.array(C.AgentMailbox)),
  ),
  replaceAgentMail: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/mail/:mailId",
    C.AgentMailbox,
  ).body<T.SetAgentMailInput>(),

  listDatabases: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/databases",
    s.field("connections", s.array(C.DatabaseConnection)),
  ),
  createDatabase: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/databases",
    s.field("connection", C.DatabaseConnection),
  ).body<T.DatabaseConnectInput>(),
  updateDatabase: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/databases/:databaseId",
    s.field("connection", C.DatabaseConnection),
  ).body<T.DatabaseUpdateInput>(),
  deleteDatabase: e("DELETE", "/api/v1/workspaces/:workspaceId/databases/:databaseId", NOTHING),
  listDatabaseTables: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/databases/:databaseId/tables",
    s.field("tables", s.array(C.DatabaseTable)),
  ),
  listAgentDatabases: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/databases",
    s.field("databases", s.array(C.AgentDatabase)),
  ),
  replaceAgentDatabase: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/databases/:databaseId",
    C.AgentDatabase,
  ).body<T.SetAgentDatabaseInput>(),

  getStorage: e("GET", "/api/v1/workspaces/:workspaceId/storage", C.StorageConfig),
  setStorage: e("PUT", "/api/v1/workspaces/:workspaceId/storage", C.StorageConfig).body<T.StorageInput>(),
  testStorage: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/storage/test",
    C.StorageTestResult,
  ).body<T.S3Input>(),
  migrateStorage: e("POST", "/api/v1/workspaces/:workspaceId/storage/migrate", C.StorageMigration),
  listStorageMigrationStatus: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/storage/migration-status",
    s.nullable(C.StorageMigration),
  ),
};
