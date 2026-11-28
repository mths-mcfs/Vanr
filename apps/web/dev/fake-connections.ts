// The workspace's connections for the fake server: services from the catalog connected with a key or
// a sign-in, the workspace's own MCP servers with the access each of their tools gets, and the GitHub
// App's installations, the mail accounts and the customer databases. As on the server, reading is open to
// members and every change needs `configure`. A key, a password or a sign-in never comes back in an answer.
// Never part of the production build.
import type * as T from "@vanr/contract";
import { can } from "@vanr/contract";
import { FAKE_CATALOG } from "./fake-agent-access.ts";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Shared = T.Connection & { workspaceId: string };
type Host = FilesHost & {
  /** The workspace's shared connections, kept with the agents' own accounts. */
  shared: () => Shared[];
};
export type FakeMcpServer = T.CustomServer & { workspaceId: string; needsKey: boolean; oauth: boolean };
export type FakeInstallation = T.GitHubAppInstallation & {
  workspaceId: string;
  repositories: { fullName: string; private: boolean }[];
};

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const ACCESS = new Set<T.ToolAccess>(["read", "write", "approval", "off"]);

/** The tools a probe of an own server finds, by the address's path. */
export const FAKE_SERVER_TOOLS: T.CustomServerTool[] = [
  {
    name: "find_invoice",
    description: "Looks an invoice up by number",
    label: "",
    access: "read",
    proposedAccess: "read",
    confirmed: false,
    readOnlyHint: true,
  },
  {
    name: "void_invoice",
    description: "Cancels an invoice",
    label: "",
    access: "approval",
    proposedAccess: "approval",
    confirmed: false,
    readOnlyHint: false,
  },
];

export type FakeMailAccount = T.MailAccount & { workspaceId: string };
export type FakeDatabase = T.DatabaseConnection & { workspaceId: string; sslmode: string; port: number };

export const FAKE_MAIL_PROVIDERS: T.MailProviders = {
  composio: ["gmail"],
  imap: true,
  presets: [
    {
      id: "gmail",
      label: "Gmail",
      host: "imap.gmail.com",
      port: 993,
      appPasswordGuide: "https://myaccount.google.com/apppasswords",
    },
    { id: "other", label: "Other", host: "", port: 993, appPasswordGuide: null },
  ],
};
const MAIL_ACTIONS = new Set([
  "search",
  "read",
  "folders",
  "draft",
  "organize",
  "send",
  "reply",
  "forward",
  "delete",
]);
const DB_ACTIONS = new Set(["tables", "describe", "query"]);
const PROVIDERS = new Set<T.DatabaseProvider>(["neon", "other", "railway", "rds", "render", "supabase"]);

export class FakeConnections {
  servers: FakeMcpServer[] = [];
  mail: FakeMailAccount[] = [];
  databases: FakeDatabase[] = [];
  installations: FakeInstallation[] = [];
  /** Whether this server has a GitHub App set up. */
  githubInstallable = true;
  /** Addresses that answer like a server that wants a key, or a sign-in. */
  keyServers = new Set<string>();
  oauthServers = new Set<string>();

  constructor(private readonly host: Host) {}

  clear(): void {
    this.servers = [];
    this.mail = [];
    this.databases = [];
    this.installations = [];
    this.githubInstallable = true;
    this.keyServers = new Set();
    this.oauthServers = new Set();
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply, configure = false) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        if ("status" in scope) return scope;
        if (configure && !can(scope.role, "configure")) return fail(403, "forbidden", "Forbidden");
        return handler(scope, params);
      };
    const serverOf = (scope: Scope, id: unknown) =>
      this.servers.find((each) => each.workspaceId === scope.workspaceId && each.id === text(id));
    const view = ({ workspaceId: _w, needsKey: _k, oauth: _o, ...server }: FakeMcpServer): T.CustomServer =>
      server;

    const mailOf = (scope: Scope, id: unknown) =>
      this.mail.find((each) => each.workspaceId === scope.workspaceId && each.id === text(id));
    const databaseOf = (scope: Scope, id: unknown) =>
      this.databases.find((each) => each.workspaceId === scope.workspaceId && each.id === text(id));
    const mailView = ({ workspaceId: _w, ...account }: FakeMailAccount): T.MailAccount => account;
    const databaseView = ({
      workspaceId: _w,
      sslmode: _s,
      port: _p,
      ...db
    }: FakeDatabase): T.DatabaseConnection => db;
    const actions = (value: unknown, known: Set<string>) =>
      Array.isArray(value) && value.every((each) => typeof each === "string" && known.has(each))
        ? [...new Set(value as string[])]
        : undefined;

    return {
      listMailProviders: within(() => reply(200, FAKE_MAIL_PROVIDERS)),
      listMailAccounts: within((scope) =>
        reply(200, {
          accounts: this.mail.filter((each) => each.workspaceId === scope.workspaceId).map(mailView),
        }),
      ),
      createMailAccountImap: within((scope, params) => {
        const address = text(params.address)?.trim() ?? "";
        const preset = text(params.preset) ?? "";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
          return fail(400, "mail.invalid_address", "Use a full e-mail address");
        }
        if (!FAKE_MAIL_PROVIDERS.presets.some((each) => each.id === preset)) {
          return fail(400, "mail.unknown_preset", "Unknown provider");
        }
        if (preset === "other" && (params.imapHost === undefined || params.smtpHost === undefined)) {
          return fail(400, "mail.servers_required", "Enter the IMAP and SMTP servers");
        }
        if (text(params.password) === "wrong-password") {
          return fail(400, "mail.auth", "The mail server rejected the password");
        }
        if (this.mail.some((each) => each.workspaceId === scope.workspaceId && each.address === address)) {
          return fail(409, "mail.exists", "This address is already connected");
        }
        const account: FakeMailAccount = {
          id: this.host.id("mail"),
          workspaceId: scope.workspaceId,
          address,
          label: address,
          preset,
          provider: preset,
          via: "imap",
          status: "active",
          agents: [],
          confirmActions: [],
          disabledActions: [],
        };
        this.mail.push(account);
        return reply(201, { account: mailView(account) });
      }, true),
      createMailAccountComposio: within((_scope, params) => {
        const provider = text(params.provider);
        if (provider === undefined || !FAKE_MAIL_PROVIDERS.composio.some((each) => each === provider)) {
          return fail(400, "mail.composio_unavailable", "Composio is not set up on this server");
        }
        return reply(200, {
          accountId: this.host.id("mail"),
          redirectUrl: `https://${provider}.example/consent`,
        });
      }, true),
      updateMailAccount: within((scope, params) => {
        const account = mailOf(scope, params.accountId);
        if (account === undefined) return fail(404, "not_found", "Mail account not found");
        const disabled =
          params.disabledActions === undefined ? [] : actions(params.disabledActions, MAIL_ACTIONS);
        const confirm =
          params.confirmActions === undefined ? [] : actions(params.confirmActions, MAIL_ACTIONS);
        if (disabled === undefined || confirm === undefined) return fail(400, "validation", "Invalid body");
        if (text(params.label) !== undefined) account.label = text(params.label)?.trim() ?? account.label;
        if (params.disabledActions !== undefined) account.disabledActions = disabled;
        if (params.confirmActions !== undefined) account.confirmActions = confirm;
        if (text(params.password) !== undefined) {
          if (params.password === "wrong-password") {
            return fail(400, "mail.auth", "The mail server rejected the password");
          }
          account.status = "active";
        }
        return reply(200, { account: mailView(account) });
      }, true),
      deleteMailAccount: within((scope, params) => {
        const account = mailOf(scope, params.accountId);
        if (account === undefined) return fail(404, "not_found", "Mail account not found");
        this.mail = this.mail.filter((each) => each !== account);
        return reply(204, null);
      }, true),

      listDatabases: within((scope) =>
        reply(200, {
          connections: this.databases
            .filter((each) => each.workspaceId === scope.workspaceId)
            .map(databaseView),
        }),
      ),
      createDatabase: within((scope, params) => {
        let host = text(params.host)?.trim();
        let database = text(params.database)?.trim();
        let username = text(params.username)?.trim();
        let password = text(params.password);
        let sslmode = text(params.sslmode) ?? "require";
        let port = typeof params.port === "number" ? params.port : 5432;
        const url = text(params.url)?.trim();
        if (url !== undefined && url !== "") {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return fail(400, "database.invalid_url", "That is not a valid connection URL");
          }
          if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
            return fail(400, "database.invalid_url", "Use a postgres:// URL");
          }
          host = parsed.hostname;
          port = parsed.port === "" ? 5432 : Number(parsed.port);
          database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
          username = decodeURIComponent(parsed.username);
          password = password ?? decodeURIComponent(parsed.password);
          sslmode = parsed.searchParams.get("sslmode") ?? sslmode;
        }
        if (!host || !database || !username || password === undefined) {
          return fail(400, "database.fields_required", "Enter host, database, user and password");
        }
        if (password === "wrong-password") {
          return fail(400, "database.auth", "The database rejected the user or password");
        }
        const provider = text(params.provider);
        const connection: FakeDatabase = {
          id: this.host.id("dbc"),
          workspaceId: scope.workspaceId,
          label: text(params.label)?.trim() || `${database} @ ${host}`,
          provider: PROVIDERS.has(provider as T.DatabaseProvider)
            ? (provider as T.DatabaseProvider)
            : "other",
          host,
          port,
          database,
          username,
          sslmode,
          status: "active",
          canWrite: false,
          hiddenSuggestion: ['public.customers."card_number"'],
          disabledActions: [],
          agents: [],
        };
        this.databases.push(connection);
        return reply(201, { connection: databaseView(connection) });
      }, true),
      updateDatabase: within((scope, params) => {
        const connection = databaseOf(scope, params.databaseId);
        if (connection === undefined) return fail(404, "not_found", "Database not found");
        const disabled =
          params.disabledActions === undefined ? [] : actions(params.disabledActions, DB_ACTIONS);
        if (disabled === undefined) return fail(400, "validation", "Invalid body");
        if (text(params.password) === "wrong-password") {
          return fail(400, "database.auth", "The database rejected the user or password");
        }
        if (text(params.label) !== undefined)
          connection.label = text(params.label)?.trim() ?? connection.label;
        if (params.disabledActions !== undefined) connection.disabledActions = disabled;
        if (text(params.password) !== undefined) connection.status = "active";
        return reply(200, { connection: databaseView(connection) });
      }, true),
      deleteDatabase: within((scope, params) => {
        const connection = databaseOf(scope, params.databaseId);
        if (connection === undefined) return fail(404, "not_found", "Database not found");
        this.databases = this.databases.filter((each) => each !== connection);
        return reply(204, null);
      }, true),

      createConnector: within((scope, params) => {
        const def = FAKE_CATALOG.connectors.find((each) => each.id === text(params.connector));
        if (def === undefined) return fail(400, "connector.unknown", "Unknown connector");
        if (!def.authMethods.includes("api_key")) {
          return fail(400, "connector.key_unsupported", "This connector connects with OAuth");
        }
        const key = text(params.apiKey)?.trim() ?? "";
        if (key.length < 8) return fail(400, "validation", "Invalid body");
        if (key === "rejected-key") return fail(400, "connector.invalid_key", "The key was rejected");
        // Like the server, every connect is a new connection, even for a service already connected.
        const connection: Shared = {
          id: this.host.id("con"),
          workspaceId: scope.workspaceId,
          connector: def.id,
          label: def.label,
          accountDisplayName: null,
          createdAt: this.host.now().toISOString(),
          revokedAt: null,
          status: "active",
          scopeRequest: null,
        };
        this.host.shared().push(connection);
        const { workspaceId: _w, ...rest } = connection;
        return reply(200, rest);
      }, true),
      startConnectorOauth: within((_scope, params) => {
        const def = FAKE_CATALOG.connectors.find((each) => each.id === text(params.connectorId));
        if (def === undefined) return fail(400, "connector.unknown", "Unknown connector");
        if (!def.authMethods.includes("oauth")) {
          return fail(400, "connector.oauth_unavailable", "This connector connects with a key");
        }
        return reply(200, { consentUrl: `https://${def.id}.example/authorize` });
      }, true),
      createConnectorScope: within((scope, params) => {
        const row = this.host
          .shared()
          .find((each) => each.workspaceId === scope.workspaceId && each.id === text(params.connectorId));
        if (row === undefined) return fail(404, "not_found", "Connection not found");
        if (row.scopeRequest == null) {
          return fail(400, "connector.no_scope_request", "This connection is not waiting for permission");
        }
        return reply(200, { consentUrl: `https://${row.connector}.example/authorize?more=1` });
      }, true),
      deleteConnector: within((scope, params) => {
        const shared = this.host.shared();
        const at = shared.findIndex(
          (each) => each.workspaceId === scope.workspaceId && each.id === text(params.connectorId),
        );
        if (at < 0) return fail(404, "not_found", "Connection not found");
        shared.splice(at, 1);
        return reply(204, null);
      }, true),

      getConnectorCustom: within((scope) =>
        reply(200, {
          servers: this.servers.filter((each) => each.workspaceId === scope.workspaceId).map(view),
        }),
      ),
      createConnectorCustom: within((scope, params) => {
        const address = text(params.serverUrl)?.trim() ?? "";
        if (!/^https?:\/\/[^\s/]+/.test(address)) {
          return fail(400, "invalid_url", "That is not a valid address");
        }
        const key = text(params.apiKey);
        if (this.keyServers.has(address) && key === undefined) {
          return reply(200, { status: "key_missing", serverId: null });
        }
        if (this.oauthServers.has(address) && key === undefined) {
          return reply(200, {
            status: "oauth",
            serverId: this.host.id("con"),
            consentUrl: "https://mcp.example/authorize",
          });
        }
        const server: FakeMcpServer = {
          id: this.host.id("con"),
          workspaceId: scope.workspaceId,
          label: text(params.label)?.trim() || new URL(address).hostname,
          serverUrl: address,
          createdAt: this.host.now().toISOString(),
          vettedAt: null,
          tools: FAKE_SERVER_TOOLS.map((tool) => ({ ...tool })),
          needsKey: key !== undefined,
          oauth: false,
        };
        this.servers.push(server);
        return reply(200, { status: "server", server: view(server) });
      }, true),
      refreshConnectorCustom: within((scope, params) => {
        const server = serverOf(scope, params.customId);
        if (server === undefined) return fail(404, "not_found", "Server not found");
        return reply(200, view(server));
      }, true),
      setConnectorCustomTools: within((scope, params) => {
        const server = serverOf(scope, params.customId);
        if (server === undefined) return fail(404, "not_found", "Server not found");
        const asked = Array.isArray(params.tools)
          ? (params.tools as { name: string; access: T.ToolAccess; label: string; confirmed?: boolean }[])
          : [];
        const unknown = asked.find((each) => !server.tools.some((tool) => tool.name === each.name));
        if (unknown !== undefined)
          return fail(400, "connector.unknown_tool", "That tool is not on this server");
        if (asked.some((each) => !ACCESS.has(each.access))) return fail(400, "validation", "Invalid body");
        server.label = text(params.label)?.trim() || server.label;
        server.tools = server.tools.map((tool) => {
          const change = asked.find((each) => each.name === tool.name);
          return change === undefined
            ? tool
            : {
                ...tool,
                access: change.access,
                label: change.label,
                confirmed: change.confirmed ?? tool.confirmed,
              };
        });
        server.vettedAt = this.host.now().toISOString();
        return reply(200, view(server));
      }, true),
      deleteConnectorCustom: within((scope, params) => {
        const server = serverOf(scope, params.customId);
        if (server === undefined) return fail(404, "not_found", "Server not found");
        this.servers = this.servers.filter((each) => each !== server);
        return reply(204, null);
      }, true),

      getGithubApp: within((scope) =>
        reply(200, {
          installable: this.githubInstallable,
          installations: this.installations
            .filter((each) => each.workspaceId === scope.workspaceId)
            .map(({ workspaceId: _w, repositories: _r, ...rest }) => rest),
        }),
      ),
      installGithubApp: within(() => {
        if (!this.githubInstallable) {
          return fail(400, "github_app.not_configured", "The GitHub App is not set up on this server");
        }
        return reply(200, { installUrl: "https://github.example/apps/vanr/installations/new" });
      }, true),
      deleteGithubAppInstallation: within((scope, params) => {
        const found = this.installations.find(
          (each) => each.workspaceId === scope.workspaceId && each.id === text(params.installationId),
        );
        if (found === undefined) return fail(404, "not_found", "Installation not found");
        this.installations = this.installations.filter((each) => each !== found);
        return reply(204, null);
      }, true),
      listGithubRepositories: within((scope) => {
        const mine = this.installations.filter((each) => each.workspaceId === scope.workspaceId);
        return reply(200, {
          connected: mine.length > 0,
          accounts: mine
            .filter((each) => !each.suspended)
            .map((each) => ({ login: each.accountUsername, repositories: each.repositories })),
        });
      }),
    };
  }
}
