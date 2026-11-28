// The workspace's connections for the fake server: services from the catalog connected with a key or
// a sign-in, the workspace's own MCP servers with the access each of their tools gets, and the GitHub
// App's installations. As on the server, reading is open to members and every change needs `configure`.
// A key or a sign-in never comes back in an answer. Never part of the production build.
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

export class FakeConnections {
  servers: FakeMcpServer[] = [];
  installations: FakeInstallation[] = [];
  /** Whether this server has a GitHub App set up. */
  githubInstallable = true;
  /** Addresses that answer like a server that wants a key, or a sign-in. */
  keyServers = new Set<string>();
  oauthServers = new Set<string>();

  constructor(private readonly host: Host) {}

  clear(): void {
    this.servers = [];
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

    return {
      createConnector: within((scope, params) => {
        const def = FAKE_CATALOG.connectors.find((each) => each.id === text(params.connector));
        if (def === undefined) return fail(400, "connector.unknown", "Unknown connector");
        if (!def.authMethods.includes("api_key")) {
          return fail(400, "connector.key_unsupported", "This connector connects with OAuth");
        }
        const key = text(params.apiKey)?.trim() ?? "";
        if (key.length < 8) return fail(400, "validation", "Invalid body");
        if (key === "rejected-key") return fail(400, "connector.invalid_key", "The key was rejected");
        const shared = this.host.shared();
        const old = shared.findIndex(
          (each) => each.workspaceId === scope.workspaceId && each.connector === def.id,
        );
        const connection: Shared = {
          id: old >= 0 ? (shared[old]?.id ?? this.host.id("con")) : this.host.id("con"),
          workspaceId: scope.workspaceId,
          connector: def.id,
          label: def.label,
          accountDisplayName: null,
          createdAt: this.host.now().toISOString(),
          revokedAt: null,
          status: "active",
          scopeRequest: null,
        };
        if (old >= 0) shared.splice(old, 1, connection);
        else shared.push(connection);
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
