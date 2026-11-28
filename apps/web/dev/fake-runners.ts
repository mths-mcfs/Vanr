// Runners for the fake server: the paired computers, pairing by code, and what an agent has on its
// runner (where it works, its secrets, the domains its commands asked for, its browser's policy and a
// person taking the browser over). The answers follow the server's rules on who may do what. Never
// part of the production build.
import type * as T from "@vanr/contract";
import { can } from "@vanr/contract";
import type { FakeAgentRow } from "./fake-agents.ts";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  agents: () => FakeAgentRow[];
  /** The signed-in person of a session, for the pairing routes outside a workspace. */
  user: (session: string | undefined) => T.User | undefined;
  /** The person's role in each workspace they are in. */
  roles: (userId: string) => T.Role[];
};
export type FakeRunner = T.Runner & { workspaceId: string };
export type FakePairing = T.RunnerPairing & { status: "pending" | "approved" | "denied" };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const forbidden = () => fail(403, "forbidden", "Forbidden");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const MINUTE_MS = 60_000;

export class FakeRunners {
  runners: FakeRunner[] = [];
  pairings: FakePairing[] = [];
  /** Where each agent works, by agent id: a runner id, or null for none. */
  targets = new Map<string, string | null>();
  secrets: (T.AgentSecret & { agentId: string })[] = [];
  domains: T.NetworkRequest[] = [];
  browser = new Map<string, T.AgentBrowserSettings>();
  interventions: T.BrowserIntervention[] = [];
  /** Agents whose browser was closed, in order. */
  readonly stopped: string[] = [];

  constructor(private readonly host: Host) {}

  clear(): void {
    this.runners = [];
    this.pairings = [];
    this.targets = new Map();
    this.secrets = [];
    this.domains = [];
    this.browser = new Map();
    this.interventions = [];
  }

  seed(): void {
    this.clear();
    const at = this.host.now().toISOString();
    this.runners = [
      this.runner("rnr_studio", "Studio Mac", "usr_ana", "Ana Beatriz Souza", true, ["agt_scout"]),
      this.runner("rnr_shed", "Shed box", "usr_jonas", "Jonas Lind", false, []),
    ];
    this.targets.set("agt_scout", "rnr_studio");
    this.secrets = [
      {
        agentId: "agt_scout",
        name: "PRINT_API_KEY",
        runnerId: "rnr_studio",
        target: { kind: "env" },
        browser: null,
        fulfilledAt: at,
        fulfilledByUserId: "usr_ana",
      },
    ];
    this.domains = [
      {
        id: "net_paper",
        agentId: "agt_scout",
        channelId: "ch_general",
        context: "curl paper.example.com",
        createdAt: at,
        decidedAt: null,
        deciderUserId: null,
        domain: "paper.example.com",
        messageId: null,
        status: "pending",
        threadId: null,
      },
    ];
    this.pairings = [
      {
        userCode: "BIRCH7",
        name: "Garage laptop",
        hostname: "garage.local",
        os: "linux",
        arch: "x64",
        coarseLocation: null,
        createdAt: at,
        expiresAt: new Date(this.host.now().getTime() + 9 * MINUTE_MS).toISOString(),
        reconnect: null,
        status: "pending",
      },
    ];
  }

  runner(
    id: string,
    name: string,
    pairedByUserId: string,
    pairedByName: string,
    online: boolean,
    agents: string[],
    workspaceId = "workspace_birchwood",
  ): FakeRunner {
    return {
      id,
      workspaceId,
      name,
      access: { folders: [], tools: { browser: true, claude: true, codex: false, commands: true } },
      agents,
      arch: "arm64",
      browser: true,
      cli: {},
      createdAt: this.host.now().toISOString(),
      credentialRotatedAt: null,
      executors: ["claude_code"],
      hostname: `${id}.local`,
      lastOnlineAt: online ? this.host.now().toISOString() : null,
      manageable: true,
      online,
      os: "darwin",
      pairedByName,
      pairedByUserId,
      paused: false,
      revokedAt: null,
      revokedReason: null,
      runnerRelease: "1.4.0",
      sandbox: { engine: "seatbelt", reason: null, state: "on" },
      shellAllowed: true,
      workDir: "~/vanr",
    };
  }

  /** Who may manage a runner: whoever paired it, or whoever configures the workspace. */
  private manages(scope: Scope, runner: FakeRunner): boolean {
    return runner.pairedByUserId === scope.user.id || can(scope.role, "configure");
  }

  private plain(scope: Scope, runner: FakeRunner): T.Runner {
    const { workspaceId: _workspace, ...rest } = runner;
    return {
      ...rest,
      manageable: this.manages(scope, runner),
      agents: this.host
        .agents()
        .filter((agent) => this.targets.get(agent.id) === runner.id)
        .map((agent) => agent.id),
    };
  }

  private targetOf(agentId: string): T.EnvironmentTarget | null {
    const runnerId = this.targets.get(agentId) ?? null;
    const runner = this.runners.find((each) => each.id === runnerId);
    if (runner === undefined) return null;
    return { kind: "runner", runnerId: runner.id, name: runner.name, online: runner.online };
  }

  private policyOf(agentId: string): T.AgentBrowserSettings {
    return (
      this.browser.get(agentId) ?? {
        level: "balanced",
        permittedDomains: [],
        privateRanges: [],
        privateRangesRunnerId: null,
        sites: [],
      }
    );
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const withAgent = (
      handler: (scope: Scope, agent: FakeAgentRow, params: Record<string, unknown>) => FilesReply,
    ) =>
      within((scope, params) => {
        const agent = this.host
          .agents()
          .find((each) => each.workspaceId === scope.workspaceId && each.id === text(params.agentId));
        return agent === undefined
          ? fail(404, "not_found", "Agent not found")
          : handler(scope, agent, params);
      });
    const asEditor = (
      handler: (scope: Scope, agent: FakeAgentRow, params: Record<string, unknown>) => FilesReply,
    ) =>
      withAgent((scope, agent, params) =>
        can(scope.role, "manage_agents") || agent.ownerUserId === scope.user.id
          ? handler(scope, agent, params)
          : forbidden(),
      );
    const withRunner = (
      handler: (scope: Scope, runner: FakeRunner, params: Record<string, unknown>) => FilesReply,
    ) =>
      within((scope, params) => {
        const runner = this.runners.find(
          (each) => each.workspaceId === scope.workspaceId && each.id === text(params.runnerId),
        );
        if (runner === undefined) return fail(404, "not_found", "Runner not found");
        return this.manages(scope, runner) ? handler(scope, runner, params) : forbidden();
      });
    const pending = (code: unknown) =>
      this.pairings.find(
        (each) =>
          each.userCode === text(code) &&
          each.status === "pending" &&
          Date.parse(each.expiresAt) > this.host.now().getTime(),
      );
    const invalid = () => fail(404, "runner.pairing_invalid", "This code expired or was already used");

    return {
      listRunners: within((scope) =>
        reply(200, {
          runners: this.runners
            .filter((runner) => runner.workspaceId === scope.workspaceId)
            .map((runner) => this.plain(scope, runner)),
        }),
      ),
      updateRunner: withRunner((_scope, runner, params) => {
        runner.name = text(params.name)?.trim() || runner.name;
        return reply(200, { id: runner.id, name: runner.name });
      }),
      revokeRunner: withRunner((scope, runner) => {
        runner.revokedAt = this.host.now().toISOString();
        runner.revokedReason = "manual";
        runner.online = false;
        return reply(200, this.plain(scope, runner));
      }),
      deleteRunner: withRunner((_scope, runner) => {
        this.runners = this.runners.filter((each) => each !== runner);
        return reply(204, null);
      }),
      reduceRunnerAccess: withRunner((_scope, runner, params) => {
        const tool = text(params.disableTool);
        if (tool === "browser" || tool === "claude" || tool === "codex" || tool === "commands") {
          runner.access = { ...runner.access, tools: { ...runner.access.tools, [tool]: false } };
        }
        return reply(200, runner.access);
      }),
      moveRunnerAgents: withRunner((_scope, runner, params) => {
        const to = text(params.toRunnerId) ?? null;
        const moved = [...this.targets]
          .filter(([, runnerId]) => runnerId === runner.id)
          .map(([agentId]) => agentId);
        for (const agentId of moved) this.targets.set(agentId, to);
        return reply(200, { moved, queued: 0, restarted: 0, skipped: [] });
      }),

      getRunnerPairing: (params, session) => {
        if (this.host.user(session) === undefined) return fail(401, "unauthorized", "Sign in to continue");
        const found = pending(params.pairingCode);
        if (found === undefined) return invalid();
        const { status: _status, ...rest } = found;
        return reply(200, rest);
      },
      denyRunnerPairing: (params, session) => {
        const user = this.host.user(session);
        if (user === undefined) return fail(401, "unauthorized", "Sign in to continue");
        if (!this.host.roles(user.id).some((role) => can(role, "post"))) return forbidden();
        const found = pending(params.pairingCode);
        if (found === undefined) return invalid();
        found.status = "denied";
        return reply(204, null);
      },
      confirmRunnerPairing: within((scope, params) => {
        if (!can(scope.role, "post")) return forbidden();
        const found = pending(params.pairingCode);
        if (found === undefined) return invalid();
        found.status = "approved";
        const runner = this.runner(
          this.host.id("rnr"),
          text(params.name)?.trim() || found.name,
          scope.user.id,
          scope.user.name,
          false,
          [],
          scope.workspaceId,
        );
        this.runners.push(runner);
        this.host.emit(scope.workspaceId, { type: "runner.paired", runnerId: runner.id });
        return reply(200, this.plain(scope, runner));
      }),

      getAgentEnvironment: withAgent((_scope, agent) =>
        reply(200, {
          lastUsedAt: null,
          network: "allowlist",
          status: this.targets.get(agent.id) ? "running" : "none",
          storageGib: 0,
          target: this.targetOf(agent.id),
        }),
      ),
      setAgentEnvironmentTarget: asEditor((scope, agent, params) => {
        if (agent.archivedAt !== null) return fail(409, "agent.archived", "This agent was archived");
        const runnerId = text(params.runnerId) ?? null;
        const runner = this.runners.find(
          (each) => each.id === runnerId && each.workspaceId === scope.workspaceId,
        );
        if (runnerId !== null && runner === undefined) return fail(404, "not_found", "Runner not found");
        if (
          runner !== undefined &&
          runner.pairedByUserId !== scope.user.id &&
          !can(scope.role, "manage_agents")
        ) {
          return forbidden();
        }
        this.targets.set(agent.id, runnerId);
        agent.harness = { ...agent.harness, environment: runnerId };
        return reply(
          200,
          this.targetOf(agent.id) ?? { kind: "cloud", runnerId: null, name: null, online: false },
        );
      }),
      listAgentSecrets: withAgent((_scope, agent) =>
        reply(200, {
          secrets: this.secrets
            .filter((secret) => secret.agentId === agent.id)
            .map(({ agentId: _agent, ...rest }) => rest),
        }),
      ),
      deleteAgentSecret: withAgent((scope, agent, params) => {
        const runner = this.runners.find((each) => each.id === text(params.runnerId));
        const allowed =
          can(scope.role, "manage_agents") ||
          agent.ownerUserId === scope.user.id ||
          can(scope.role, "configure") ||
          runner?.pairedByUserId === scope.user.id;
        if (!allowed) return forbidden();
        this.secrets = this.secrets.filter(
          (secret) => !(secret.agentId === agent.id && secret.name === text(params.secretId)),
        );
        return reply(204, null);
      }),
      listAgentEnvironmentDomains: withAgent((_scope, agent) =>
        reply(200, { domains: this.domains.filter((request) => request.agentId === agent.id) }),
      ),
      allowNetworkRequest: within((scope, params) => this.decide(scope, params, "allowed")),
      denyNetworkRequest: within((scope, params) => this.decide(scope, params, "denied")),
      deleteNetworkRequest: within((scope, params) => this.decide(scope, params, "removed")),

      getAgentBrowser: withAgent((_scope, agent) => reply(200, this.policyOf(agent.id))),
      setAgentBrowserPolicy: asEditor((_scope, agent, params) => {
        const sites = Array.isArray(params.sites) ? (params.sites as T.SiteRule[]) : [];
        const ranges = Array.isArray(params.privateRanges) ? (params.privateRanges as string[]) : undefined;
        const before = this.policyOf(agent.id);
        const next: T.AgentBrowserSettings = {
          level: (text(params.level) as T.BrowserLevel | undefined) ?? before.level,
          sites,
          permittedDomains: sites.filter((site) => site.access === "write").map((site) => site.pattern),
          privateRanges: ranges ?? before.privateRanges,
          privateRangesRunnerId:
            ranges === undefined ? before.privateRangesRunnerId : (this.targets.get(agent.id) ?? null),
        };
        this.browser.set(agent.id, next);
        return reply(200, next);
      }),
      listAgentBrowserInterventions: withAgent((_scope, agent) =>
        reply(200, {
          intervention:
            this.interventions.find(
              (each) => each.agentId === agent.id && (each.status === "active" || each.status === "pending"),
            ) ?? null,
        }),
      ),
      startAgentBrowserIntervention: withAgent((scope, agent) => {
        if (!agent.reachable) return forbidden();
        const at = this.host.now();
        const started: T.BrowserIntervention = {
          id: this.host.id("bri"),
          agentId: agent.id,
          channelId: null,
          controllingUserId: scope.user.id,
          createdAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + 15 * MINUTE_MS).toISOString(),
          handledAt: null,
          instructions: "",
          kind: "intervention",
          note: null,
          runnerId: this.targets.get(agent.id) ?? null,
          status: "active",
          targetUserId: scope.user.id,
          url: null,
        };
        this.interventions.push(started);
        return reply(200, started);
      }),
      completeBrowserIntervention: within((scope, params) => {
        const found = this.interventions.find((each) => each.id === text(params.interventionId));
        if (found === undefined) return fail(404, "not_found", "Not found");
        if (found.controllingUserId !== scope.user.id) return forbidden();
        found.status = "done";
        found.handledAt = this.host.now().toISOString();
        return reply(200, found);
      }),
      stopAgentBrowser: withAgent((_scope, agent) => {
        this.stopped.push(agent.id);
        return reply(204, null);
      }),
    };
  }

  private decide(
    scope: Scope,
    params: Record<string, unknown>,
    status: T.NetworkRequest["status"],
  ): FilesReply {
    const request = this.domains.find((each) => each.id === text(params.networkRequestId));
    if (request === undefined) return fail(404, "not_found", "Not found");
    const agent = this.host.agents().find((each) => each.id === request.agentId);
    if (agent === undefined || (!can(scope.role, "manage_agents") && agent.ownerUserId !== scope.user.id)) {
      return forbidden();
    }
    request.status = status;
    request.decidedAt = this.host.now().toISOString();
    request.deciderUserId = scope.user.id;
    return reply(200, request);
  }
}
