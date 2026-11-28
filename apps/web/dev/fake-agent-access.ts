// An agent's memory and its own identity for the fake server: memory notes and files with their
// versions, the agent's accounts on services and its per-channel rules. Like the server, the rules a
// person sees are only those on channels they may read, and a save replaces only those. Never part of
// the production build.
import type * as T from "@vanr/contract";
import { can } from "@vanr/contract";
import type { FakeAgentRow } from "./fake-agents.ts";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  agents: () => FakeAgentRow[];
  /** Whether a person may read a channel (a member of a private one, anyone for a public one). */
  readsChannel: (userId: string, channelId: string) => boolean;
};
type Rule = T.ChannelAccessRule & { agentId: string };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const forbidden = () => fail(403, "forbidden", "Forbidden");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export const FAKE_CATALOG: T.ConnectorCatalog = {
  nativeScopes: [],
  connectors: [
    {
      id: "linear",
      label: "Linear",
      accentColor: null,
      askServerUrl: false,
      auth: "oauth",
      authMethods: ["oauth", "api_key"],
      available: true,
      category: "work",
      description: "Issues and projects",
      iconUrl: null,
      kind: "hosted_mcp",
      oauthReady: true,
      scopes: [],
      serverUrl: null,
      tools: [],
    },
    {
      id: "stripe",
      label: "Stripe",
      accentColor: null,
      askServerUrl: false,
      auth: "api_key",
      authMethods: ["api_key"],
      available: true,
      category: "finance",
      description: "Payments",
      iconUrl: null,
      kind: "api_key",
      oauthReady: false,
      scopes: [],
      serverUrl: null,
      tools: [],
    },
  ],
};

export class FakeAgentAccess {
  memories: T.Memory[] = [];
  versions: T.MemoryVersion[] = [];
  /** The agents' own accounts, by agent id. */
  accounts = new Map<string, T.Connection[]>();
  /** The workspace's shared connections. */
  shared: (T.Connection & { workspaceId: string })[] = [];
  rules: Rule[] = [];

  constructor(private readonly host: Host) {}

  clear(): void {
    this.memories = [];
    this.versions = [];
    this.accounts = new Map();
    this.shared = [];
    this.rules = [];
  }

  seed(): void {
    this.clear();
    const at = this.host.now().toISOString();
    const note = (id: string, kind: T.MemoryKind, body: string, extra: Partial<T.Memory> = {}): T.Memory => ({
      id,
      about: null,
      agentId: "agt_scout",
      archived: false,
      createdAt: at,
      editorUserId: null,
      kind,
      lastUsedAt: null,
      origin: { at, by: null, channel: "general", name: null },
      path: null,
      pinned: false,
      replaces: null,
      scope: "agent",
      sha256: id,
      source: null,
      text: body,
      untrustedSource: false,
      updatedAt: at,
      uses: 0,
      verified: false,
      ...extra,
    });
    this.memories = [
      note("mem_paper", "fact", "The shop orders paper on Mondays.", { about: "paper", uses: 3 }),
      note("mem_tone", "preference", "Ana prefers short answers.", { about: "tone", pinned: true }),
      note("mem_late", "decision", "Late orders go to Jonas.", { editorUserId: "usr_ana" }),
      note("mem_old", "lesson", "The old printer jams on card stock.", { archived: true }),
      note("mem_file", "fact", "# Acme\nPrefers matte.", { path: "clients/acme.md" }),
    ];
    this.versions = this.memories.map((memory) => ({
      id: `mv_${memory.id}_1`,
      memoryId: memory.id,
      seq: 1,
      op: "create",
      text: memory.text,
      path: memory.path,
      archived: memory.archived,
      author: { id: null, type: "agent" },
      approvedByUserId: null,
      createdAt: at,
      reason: "",
      restoredFromSeq: null,
      runId: null,
      sha256: memory.sha256,
    }));
    this.accounts.set("agt_scout", [
      {
        id: "con_scout_linear",
        connector: "linear",
        label: "Linear",
        accountDisplayName: "scout@birchwood.example",
        createdAt: at,
        revokedAt: null,
        status: "active",
        scopeRequest: null,
      },
    ]);
    this.shared = [
      {
        id: "con_github",
        workspaceId: "workspace_birchwood",
        connector: "linear",
        label: "Team Linear",
        accountDisplayName: null,
        createdAt: at,
        revokedAt: null,
        status: "active",
      },
    ];
    this.rules = [
      { agentId: "agt_scout", channelId: "ch_general", connectionId: "*", level: "read" },
      { agentId: "agt_scout", channelId: "ch_secret", connectionId: "con_github", level: "off" },
    ];
  }

  private visible(scope: Scope, agentId: string): T.ChannelAccessRule[] {
    return this.rules
      .filter((rule) => rule.agentId === agentId && this.host.readsChannel(scope.user.id, rule.channelId))
      .map(({ agentId: _agent, ...rest }) => rest);
  }

  private version(memory: T.Memory, op: T.MemoryVersion["op"], userId: string): void {
    const seq = Math.max(0, ...this.versions.filter((v) => v.memoryId === memory.id).map((v) => v.seq)) + 1;
    this.versions.push({
      id: `mv_${memory.id}_${seq}`,
      memoryId: memory.id,
      seq,
      op,
      text: memory.text,
      path: memory.path,
      archived: memory.archived,
      author: { id: userId, type: "person" },
      approvedByUserId: null,
      createdAt: this.host.now().toISOString(),
      reason: "",
      restoredFromSeq: null,
      runId: null,
      sha256: memory.sha256,
    });
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const agentOf = (scope: Scope, id: unknown) =>
      this.host.agents().find((agent) => agent.workspaceId === scope.workspaceId && agent.id === text(id));
    const editor = (scope: Scope, agent: FakeAgentRow) =>
      can(scope.role, "manage_agents") || agent.ownerUserId === scope.user.id;
    const withAgent = (
      handler: (scope: Scope, agent: FakeAgentRow, params: Record<string, unknown>) => FilesReply,
      edit = false,
    ) =>
      within((scope, params) => {
        const agent = agentOf(scope, params.agentId);
        if (agent === undefined) return fail(404, "not_found", "Agent not found");
        if (edit && !editor(scope, agent)) return forbidden();
        return handler(scope, agent, params);
      });
    // The three edits of a note share one route on the server; one handler answers them all.
    const patchMemory = within((scope, params) => {
      const memory = this.memories.find((each) => each.id === text(params.memoryId));
      const agent = memory === undefined ? undefined : agentOf(scope, memory.agentId);
      if (memory === undefined || agent === undefined) return fail(404, "not_found", "Memory not found");
      if (!editor(scope, agent)) return forbidden();
      const expected = text(params.expectedSha256);
      if (expected !== undefined && expected !== memory.sha256) {
        return fail(409, "memory.changed", "The memory changed since it was read");
      }
      if (text(params.text) !== undefined) {
        memory.text = text(params.text) ?? memory.text;
        memory.sha256 = `${memory.id}-${this.versions.length + 1}`;
        memory.editorUserId = scope.user.id;
        this.version(memory, "update", scope.user.id);
      }
      if (typeof params.pinned === "boolean") memory.pinned = params.pinned;
      if (typeof params.archived === "boolean") {
        memory.archived = params.archived;
        this.version(memory, params.archived ? "archive" : "unarchive", scope.user.id);
      }
      memory.updatedAt = this.host.now().toISOString();
      return reply(200, memory);
    });

    return {
      listAgentMemories: withAgent((_scope, agent) =>
        reply(200, { memories: this.memories.filter((memory) => memory.agentId === agent.id) }),
      ),
      updateMemory: patchMemory,
      updateMemoryText: patchMemory,
      setMemoryPinned: patchMemory,
      setMemoryArchived: patchMemory,
      revertMemory: within((scope, params) => {
        const memory = this.memories.find((each) => each.id === text(params.memoryId));
        const agent = memory === undefined ? undefined : agentOf(scope, memory.agentId);
        if (memory === undefined || agent === undefined) return fail(404, "not_found", "Memory not found");
        if (!editor(scope, agent)) return forbidden();
        const first = this.versions.find((each) => each.memoryId === memory.id && each.seq === 1);
        memory.text = first?.text ?? memory.text;
        memory.editorUserId = null;
        this.version(memory, "restore", scope.user.id);
        return reply(200, memory);
      }),
      listMemoryVersions: within((_scope, params) =>
        reply(200, { versions: this.versions.filter((each) => each.memoryId === text(params.memoryId)) }),
      ),

      getConnectorCatalog: () => reply(200, FAKE_CATALOG),
      listConnectors: within((scope) =>
        reply(200, {
          connections: this.shared
            .filter((each) => each.workspaceId === scope.workspaceId)
            .map(({ workspaceId: _workspace, ...rest }) => rest),
        }),
      ),
      getAgentIdentity: withAgent((scope, agent) =>
        reply(200, {
          connections: this.accounts.get(agent.id) ?? [],
          channels: this.visible(scope, agent.id),
        }),
      ),
      createAgentIdentityConnection: withAgent((_scope, agent, params) => {
        const connector = FAKE_CATALOG.connectors.find((each) => each.id === text(params.connector));
        if (connector === undefined) return fail(400, "connector.unknown", "Unknown connector");
        const own = this.accounts.get(agent.id) ?? [];
        if (own.some((each) => each.connector === connector.id)) {
          return fail(409, "identity.already_connected", "The agent already has an account there");
        }
        const key = text(params.apiKey);
        if (key === undefined)
          return reply(200, { status: "oauth", consentUrl: `https://${connector.id}.example/consent` });
        const connection: T.Connection = {
          id: this.host.id("con"),
          connector: connector.id,
          label: connector.label,
          accountDisplayName: null,
          createdAt: this.host.now().toISOString(),
          revokedAt: null,
          status: "active",
          scopeRequest: null,
        };
        this.accounts.set(agent.id, [...own, connection]);
        return reply(200, { status: "connected", connection });
      }, true),
      revokeAgentIdentity: withAgent((_scope, agent) => {
        const revoked = (this.accounts.get(agent.id) ?? []).length;
        this.accounts.set(agent.id, []);
        return reply(200, { revoked });
      }, true),
      setAgentIdentityChannels: withAgent((scope, agent, params) => {
        const asked = Array.isArray(params.channels) ? (params.channels as T.ChannelAccessRule[]) : [];
        const hidden = asked.find((rule) => !this.host.readsChannel(scope.user.id, rule.channelId));
        if (hidden !== undefined) return fail(400, "identity.unknown_channel", "Unknown channel");
        // Rules on channels hidden from this person stay as they are.
        this.rules = [
          ...this.rules.filter(
            (rule) => rule.agentId !== agent.id || !this.host.readsChannel(scope.user.id, rule.channelId),
          ),
          ...asked.map((rule) => ({ ...rule, agentId: agent.id })),
        ];
        return reply(200, { channels: this.visible(scope, agent.id) });
      }, true),
    };
  }
}
