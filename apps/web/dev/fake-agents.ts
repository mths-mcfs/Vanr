// Agents for the fake server, beyond the list and the active runs it keeps itself: the team, creating
// and changing an agent, the versions of its instructions, its harness, its skills, the lab (cases, a
// test run that is still running the first time it is read and done the next, drafts from a
// description) and its finished runs, which can be drafted into a skill. The answers follow the
// server's rules on who may do what; the model's answer is the prompt repeated, as the fake model does.
// Never part of the production build.
import type * as T from "@vanr/contract";
import { can } from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

export type FakeAgentRow = T.Agent & { workspaceId: string };
type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  /** The server's agents, the list `listAgents` answers from. */
  agents: () => FakeAgentRow[];
  /** The people of a workspace, for the team. */
  people: (workspaceId: string) => { userId: string; name: string; handle: string }[];
  /** Whether the agent has a run going now (the server's active runs). */
  busy: (agentId: string) => boolean;
};
type Extra = {
  channels: T.AgentChannel[];
  versions: T.InstructionVersion[];
  fallback: boolean;
  skills: Map<string, boolean>;
  cases: T.AgentTestCase[];
};
/** A test run keeps the cases it started with: one added meanwhile is not part of it. */
type FakeEval = T.AgentEval & { reads: number; after: string; before: string; cases: T.AgentTestCase[] };
type FakeSkill = T.SkillDetail & { workspaceId: string };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const notFound = (what: string) => fail(404, "not_found", `${what} not found`);
const forbidden = () => fail(403, "forbidden", "Forbidden");
const archived = () => fail(409, "agent.archived", "This agent was archived");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const words = (value: unknown) =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export const FAKE_MODELS: T.Model[] = [
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    advisors: ["claude-opus-5-5"],
    available: true,
    inputPricePerMillion: 0.1,
    outputPricePerMillion: 0.5,
    provider: "anthropic",
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    advisors: [],
    available: true,
    inputPricePerMillion: 4,
    outputPricePerMillion: 20,
    provider: "anthropic",
  },
];

export class FakeAgents {
  readonly extras = new Map<string, Extra>();
  skills: FakeSkill[] = [];
  evals: FakeEval[] = [];
  /** Finished runs, by agent, newest first. */
  runs: (T.Run & { workspaceId: string })[] = [];
  delegations: (T.Team["delegations"][number] & { workspaceId: string })[] = [];
  /** The run the next skill draft says it came from a private channel. */
  privateRuns = new Set<string>();

  constructor(private readonly host: Host) {}

  clear(): void {
    this.extras.clear();
    this.evals = [];
    this.skills = [];
    this.runs = [];
    this.delegations = [];
    this.privateRuns = new Set();
  }

  seed(): void {
    this.clear();
    const at = this.host.now().toISOString();
    this.skills = [
      this.skill(
        "skl_release",
        "workspace_birchwood",
        "Release notes",
        "Write release notes from merged changes.",
        "custom",
      ),
      this.skill(
        "skl_invoices",
        "workspace_birchwood",
        "Invoice check",
        "Match invoices against orders.",
        "github",
      ),
    ];
    this.runs = [
      this.run("run_scout_1", "agt_scout", "Summarized the print queue", "done", at),
      this.run("run_scout_0", "agt_scout", "Checked the paper stock", "failed", at),
    ];
    this.delegations = [
      {
        workspaceId: "workspace_birchwood",
        requesterAgentId: "agt_scout",
        delegateAgentId: "agt_ledger",
        status: "answered",
        at,
      },
    ];
  }

  private skill(
    id: string,
    workspaceId: string,
    name: string,
    description: string,
    source: T.Skill["source"],
  ): FakeSkill {
    return {
      id,
      workspaceId,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      description,
      body: `# ${name}\n\n${description}`,
      autoGrantNewAgents: false,
      createdBy: "usr_ana",
      problems: [],
      source,
      sourceRunId: null,
      sourceUrl: source === "github" ? "https://github.com/birchwood/skills/tree/main/invoices" : null,
      updatedAt: this.host.now().toISOString(),
      version: 1,
      files: source === "github" ? [{ path: "SKILL.md", mime: "text/markdown", status: "ok" }] : [],
    };
  }

  private run(id: string, agentId: string, what: string, status: T.RunStatus, at: string) {
    return {
      id,
      workspaceId: "workspace_birchwood",
      agentId,
      blockedRepo: null,
      cachedTokens: 0,
      channelId: "ch_general",
      costUsd: 0.01,
      createdAt: at,
      error: null,
      errorCode: null,
      errorVars: null,
      finishedAt: at,
      inputTokens: 10,
      outputTokens: 10,
      repo: null,
      sourceMessageId: null,
      status,
      threadId: null,
      what,
    };
  }

  /** What the server keeps about an agent beyond its row; made on first use. */
  extra(agent: FakeAgentRow): Extra {
    let found = this.extras.get(agent.id);
    if (found === undefined) {
      found = {
        channels: [{ id: "ch_general", autoAnswer: false }],
        versions: [this.version(agent.id, 1, agent.instructions, "initial", null, "")],
        fallback: false,
        skills: new Map(),
        cases: [],
      };
      this.extras.set(agent.id, found);
    }
    return found;
  }

  private version(
    agentId: string,
    seq: number,
    body: string,
    source: T.InstructionVersion["source"],
    authorId: string | null,
    reason: string,
    restoredFromSeq: number | null = null,
  ): T.InstructionVersion {
    return {
      id: `iv_${agentId}_${seq}`,
      agentId,
      seq,
      text: body,
      source,
      reason,
      proposalId: null,
      restoredFromSeq,
      author: authorId === null ? { id: null, type: "system" } : { id: authorId, type: "person" },
      createdAt: this.host.now().toISOString(),
    };
  }

  private agentOf(scope: Scope, params: Record<string, unknown>): FakeAgentRow | undefined {
    return this.host
      .agents()
      .find((agent) => agent.workspaceId === scope.workspaceId && agent.id === text(params.agentId));
  }

  /**
   * The agent as one person sees it. Whether they may talk to it follows its audience now, for them; a
   * test can still close an agent to everyone by setting `reachable` to false on the row.
   */
  private plain(agent: FakeAgentRow, viewerId: string): T.Agent {
    const { workspaceId: _workspace, ...rest } = agent;
    const audience =
      agent.audience.mode === "everyone" ||
      agent.ownerUserId === viewerId ||
      (agent.audience.mode === "people" && agent.audience.userIds.includes(viewerId));
    return { ...rest, busy: this.host.busy(agent.id), reachable: agent.reachable && audience };
  }

  private detail(agent: FakeAgentRow, viewerId: string): T.AgentDetail {
    return {
      ...this.plain(agent, viewerId),
      budgetInherited: true,
      budgetPerMonthUsd: 50,
      budgetSpentPct: 10,
      channels: this.extra(agent).channels,
      costThisMonthUsd: 5,
      credentialId: null,
      inheritedBudgetUsd: 50,
      monthRuns: this.runs.filter((run) => run.agentId === agent.id).length,
      monthTokens: 1000,
      queuedApprovals: 0,
    };
  }

  private editor(scope: Scope, agent: FakeAgentRow): boolean {
    return can(scope.role, "manage_agents") || agent.ownerUserId === scope.user.id;
  }

  private writeVersion(
    agent: FakeAgentRow,
    body: string,
    source: T.InstructionVersion["source"],
    userId: string,
    reason: string,
    restoredFromSeq: number | null = null,
  ): T.InstructionVersion {
    const extra = this.extra(agent);
    const seq = Math.max(0, ...extra.versions.map((version) => version.seq)) + 1;
    const version = this.version(agent.id, seq, body, source, userId, reason, restoredFromSeq);
    extra.versions.push(version);
    agent.instructions = body;
    return version;
  }

  private harness(agent: FakeAgentRow): T.AgentHarness {
    const remote = (kind: "claude_code" | "codex"): T.HarnessOption => ({
      kind,
      available: false,
      reason: "no_environment",
      defaultModel: "",
      models: [],
    });
    return {
      harness: agent.harness.kind,
      environment: agent.harness.environment,
      fallback: this.extra(agent).fallback,
      resolvedModel: agent.model,
      options: [
        {
          kind: "model",
          available: true,
          reason: null,
          defaultModel: "claude-haiku-5-5",
          models: FAKE_MODELS.map((model) => ({ label: model.label, value: model.id })),
        },
        remote("claude_code"),
        remote("codex"),
      ],
      runners: [],
    };
  }

  private evaluate(item: T.AgentTestCase, instructions: string): T.AgentEvalSide {
    // The fake model repeats the prompt; a [[fail]] in the instructions makes it fail, as the real one.
    if (instructions.includes("[[fail]]")) return { pass: false, text: "", failed: ["error:fake_failure"] };
    const answer = item.input;
    const lower = answer.toLowerCase();
    const failed = [
      ...item.mustInclude
        .filter((snippet) => !lower.includes(snippet.toLowerCase()))
        .map((s) => `include:${s}`),
      ...item.mustNotInclude
        .filter((snippet) => lower.includes(snippet.toLowerCase()))
        .map((s) => `exclude:${s}`),
    ];
    return { pass: failed.length === 0, text: answer, failed };
  }

  private shownEval(row: FakeEval): T.AgentEval {
    const { reads: _reads, after: _after, before: _before, cases: _cases, ...rest } = row;
    return rest;
  }

  private skillOf(scope: Scope, params: Record<string, unknown>) {
    return this.skills.find(
      (skill) => skill.workspaceId === scope.workspaceId && skill.id === text(params.skillId),
    );
  }

  private plainSkill({ body: _body, files: _files, workspaceId: _workspace, ...rest }: FakeSkill): T.Skill {
    return rest;
  }

  private detailSkill({ workspaceId: _workspace, ...rest }: FakeSkill): T.SkillDetail {
    return rest;
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
        const agent = this.agentOf(scope, params);
        return agent === undefined ? notFound("Agent") : handler(scope, agent, params);
      });
    const asEditor = (
      handler: (scope: Scope, agent: FakeAgentRow, params: Record<string, unknown>) => FilesReply,
    ) =>
      withAgent((scope, agent, params) =>
        this.editor(scope, agent) ? handler(scope, agent, params) : forbidden(),
      );
    // A write to an archived agent is refused, as the server does.
    const asLiveEditor = (
      handler: (scope: Scope, agent: FakeAgentRow, params: Record<string, unknown>) => FilesReply,
    ) =>
      asEditor((scope, agent, params) =>
        agent.archivedAt === null ? handler(scope, agent, params) : archived(),
      );
    const asManager = (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      within((scope, params) => (can(scope.role, "manage_agents") ? handler(scope, params) : forbidden()));

    return {
      listModels: () => reply(200, { models: FAKE_MODELS, defaultModel: "claude-haiku-5-5" }),

      getTeam: within((scope) => {
        const agents = this.host
          .agents()
          .filter((agent) => agent.workspaceId === scope.workspaceId && agent.archivedAt === null);
        const team: T.Team = {
          agents: agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            handle: agent.handle,
            role: agent.role,
            ownerUserId: agent.ownerUserId,
            busy: this.host.busy(agent.id),
            reachable: this.plain(agent, scope.user.id).reachable,
            appearance: agent.appearance,
            capabilities: [],
            useWhen: agent.instructions.split(/(?<=\.)\s/)[0] ?? "",
          })),
          people: this.host.people(scope.workspaceId).map((person) => ({
            userId: person.userId,
            name: person.name,
            handle: person.handle,
            image: null,
          })),
          delegations: this.delegations
            .filter((delegation) => delegation.workspaceId === scope.workspaceId)
            .map(({ workspaceId: _workspace, ...rest }) => rest),
        };
        return reply(200, team);
      }),

      createAgent: asManager((scope, params) => {
        const name = text(params.name)?.trim() ?? "";
        const handle = text(params.handle)?.trim().toLowerCase() ?? "";
        if (name === "" || name.length > 60 || !HANDLE_RE.test(handle))
          return fail(400, "invalid_request", "Invalid body");
        const taken = [
          ...this.host
            .agents()
            .filter((agent) => agent.workspaceId === scope.workspaceId)
            .map((agent) => agent.handle),
          ...this.host.people(scope.workspaceId).map((person) => person.handle),
        ];
        if (taken.includes(handle)) return fail(409, "agent.handle_taken", "That @ is already in use");
        const audience = params.audience as T.AgentAudience | undefined;
        const agent: FakeAgentRow = {
          id: this.host.id("agt"),
          workspaceId: scope.workspaceId,
          name,
          handle,
          role: (text(params.role) ?? "assistant") as T.AgentRole,
          instructions: text(params.instructions) ?? "",
          model: text(params.model) ?? "claude-haiku-5-5",
          ownerUserId: text(params.ownerUserId) ?? scope.user.id,
          audience: audience ?? { mode: "everyone", userIds: [] },
          appearance: (params.appearance as T.AgentAppearance | undefined) ?? {
            color: "teal",
            eyes: "dots",
            adornment: "none",
          },
          advisor: null,
          archivedAt: null,
          busy: false,
          createdAt: this.host.now().toISOString(),
          harness: { environment: null, kind: "model", model: text(params.model) ?? "claude-haiku-5-5" },
          reachable: true,
          testModel: false,
        };
        this.host.agents().push(agent);
        const extra = this.extra(agent);
        extra.channels = words(params.channelIds).map((id) => ({ id, autoAnswer: false }));
        for (const skill of this.skills) {
          if (skill.workspaceId === scope.workspaceId && skill.autoGrantNewAgents)
            extra.skills.set(skill.id, true);
        }
        return reply(201, this.plain(agent, scope.user.id));
      }),

      getAgent: withAgent((scope, agent) => reply(200, this.detail(agent, scope.user.id))),

      updateAgent: asEditor((scope, agent, params) => {
        if (agent.archivedAt !== null) return fail(409, "agent.archived", "This agent was archived");
        const keys = [
          "name",
          "role",
          "instructions",
          "model",
          "ownerUserId",
          "audience",
          "appearance",
        ].filter((key) => params[key] !== undefined);
        if (
          !can(scope.role, "manage_agents") &&
          keys.some((key) => key !== "appearance" && key !== "audience")
        ) {
          return forbidden();
        }
        const instructions = text(params.instructions);
        if (instructions !== undefined && instructions !== agent.instructions) {
          this.writeVersion(
            agent,
            instructions,
            "edit",
            scope.user.id,
            text(params.instructionsReason) ?? "",
          );
        }
        if (text(params.name) !== undefined) agent.name = text(params.name)?.trim() ?? agent.name;
        if (text(params.role) !== undefined) agent.role = text(params.role) as T.AgentRole;
        if (text(params.ownerUserId) !== undefined)
          agent.ownerUserId = text(params.ownerUserId) ?? agent.ownerUserId;
        if (text(params.model) !== undefined) agent.model = text(params.model) ?? agent.model;
        if (params.audience !== undefined) agent.audience = params.audience as T.AgentAudience;
        if (params.appearance !== undefined) agent.appearance = params.appearance as T.AgentAppearance;
        return reply(200, this.plain(agent, scope.user.id));
      }),

      deleteAgent: asManager((scope, params) => {
        const agent = this.agentOf(scope, params);
        if (agent === undefined) return notFound("Agent");
        agent.archivedAt = this.host.now().toISOString();
        return reply(204, null);
      }),

      listAgentInstructionVersions: withAgent((_scope, agent) =>
        reply(200, { versions: [...this.extra(agent).versions].reverse() }),
      ),

      restoreAgentInstructionVersion: asManager((scope, params) => {
        const agent = this.agentOf(scope, params);
        if (agent === undefined) return notFound("Agent");
        if (agent.archivedAt !== null) return archived();
        const old = this.extra(agent).versions.find(
          (version) => version.id === text(params.instructionVersionId),
        );
        if (old === undefined) return notFound("Version");
        return reply(
          200,
          this.writeVersion(agent, old.text, "restore", scope.user.id, text(params.reason) ?? "", old.seq),
        );
      }),

      getAgentRuntime: withAgent((_scope, agent) => reply(200, this.harness(agent))),

      setAgentRuntime: asLiveEditor((scope, agent, params) => {
        const harness = text(params.harness) as T.HarnessKind | undefined;
        const model = text(params.model);
        const manager = can(scope.role, "manage_agents");
        if (!manager && (harness !== agent.harness.kind || (model !== undefined && model !== agent.model))) {
          return forbidden();
        }
        if (harness !== undefined && harness !== "model") {
          return fail(409, "harness.unavailable", "This harness is not available on the agent's environment");
        }
        if (manager && model !== undefined) {
          agent.model = model;
          agent.harness = { ...agent.harness, model };
        }
        if (typeof params.fallback === "boolean") this.extra(agent).fallback = params.fallback;
        return reply(200, this.harness(agent));
      }),

      getAgentInbox: withAgent((_scope, agent) =>
        reply(200, {
          waiting: [],
          recent: this.runs
            .filter((run) => run.agentId === agent.id)
            .map((run) => ({
              at: run.createdAt,
              channelId: run.channelId,
              runId: run.id,
              status: run.status,
              threadId: null,
              what: run.what,
            })),
        }),
      ),

      listRuns: within((scope, params) =>
        reply(200, {
          runs: this.runs
            .filter(
              (run) =>
                run.workspaceId === scope.workspaceId &&
                (params.agentId === undefined || run.agentId === params.agentId),
            )
            .map(({ workspaceId: _workspace, ...rest }) => rest),
        }),
      ),

      createRunSkillDraft: asManager((scope, params) => {
        const run = this.runs.find(
          (candidate) => candidate.workspaceId === scope.workspaceId && candidate.id === text(params.runId),
        );
        if (run === undefined) return notFound("Run");
        const draft: T.SkillDraft = {
          agentId: run.agentId,
          runId: run.id,
          name: run.what,
          description: `Do what this run did: ${run.what.toLowerCase()}.`,
          body: `# ${run.what}\n\n1. Read the request.\n2. ${run.what}.`,
          fromPrivate: this.privateRuns.has(run.id),
          testModel: true,
        };
        return reply(200, draft);
      }),

      listAgentSkills: withAgent((scope, agent) =>
        reply(200, {
          skills: this.skills
            .filter((skill) => skill.workspaceId === scope.workspaceId)
            .map((skill) => ({
              ...this.plainSkill(skill),
              enabled: this.extra(agent).skills.get(skill.id) ?? false,
            })),
        }),
      ),

      setAgentSkills: asLiveEditor((scope, agent, params) => {
        const asked = Array.isArray(params.skills)
          ? (params.skills as { id: string; enabled: boolean }[])
          : [];
        if (
          asked.some(
            (each) =>
              !this.skills.some((skill) => skill.id === each.id && skill.workspaceId === scope.workspaceId),
          )
        ) {
          return fail(400, "invalid_request", "Unknown skill");
        }
        for (const each of asked) this.extra(agent).skills.set(each.id, each.enabled);
        return reply(200, {
          skills: this.skills
            .filter((skill) => skill.workspaceId === scope.workspaceId)
            .map((skill) => ({
              ...this.plainSkill(skill),
              enabled: this.extra(agent).skills.get(skill.id) ?? false,
            })),
        });
      }),

      listSkills: within((scope) =>
        reply(200, {
          skills: this.skills
            .filter((skill) => skill.workspaceId === scope.workspaceId)
            .map((skill) => this.plainSkill(skill)),
        }),
      ),
      getSkill: within((scope, params) => {
        const skill = this.skillOf(scope, params);
        return skill === undefined ? notFound("Skill") : reply(200, this.detailSkill(skill));
      }),
      getSkillSkillMd: within((scope, params) => {
        const skill = this.skillOf(scope, params);
        if (skill === undefined) return notFound("Skill");
        return reply(200, {
          name: skill.slug,
          markdown: `---\nname: ${skill.slug}\ndescription: ${skill.description}\n---\n\n${skill.body}`,
          files: [],
        });
      }),
      createSkill: asManager((scope, params) => {
        const name = text(params.name)?.trim() ?? "";
        if (name === "" || text(params.body) === undefined)
          return fail(400, "invalid_request", "Invalid body");
        if (this.skills.some((skill) => skill.workspaceId === scope.workspaceId && skill.name === name)) {
          return fail(409, "skill.name_taken", "A skill with that name exists");
        }
        const run = this.runs.find((candidate) => candidate.id === text(params.sourceRunId));
        if (run !== undefined && this.privateRuns.has(run.id) && params.shareFromPrivate !== true) {
          return fail(409, "skill.private_source", "Confirm sharing a skill made from a private run");
        }
        const skill: FakeSkill = {
          ...this.skill(
            this.host.id("skl"),
            scope.workspaceId,
            name,
            text(params.description) ?? "",
            "custom",
          ),
          body: text(params.body) ?? "",
          autoGrantNewAgents: params.autoGrantNewAgents === true,
          sourceRunId: run?.id ?? null,
        };
        this.skills.push(skill);
        return reply(201, this.detailSkill(skill));
      }),
      importSkill: asManager((scope, params) => {
        const url = text(params.url) ?? "";
        if (!url.startsWith("https://github.com/"))
          return fail(400, "skill.import_url", "Use a GitHub address");
        const name = url.split("/").filter(Boolean).pop() ?? "imported";
        const skill = {
          ...this.skill(this.host.id("skl"), scope.workspaceId, name, `Imported from ${url}`, "github"),
          sourceUrl: url,
        };
        this.skills.push(skill);
        return reply(201, this.detailSkill(skill));
      }),
      updateSkill: asManager((scope, params) => {
        const skill = this.skillOf(scope, params);
        if (skill === undefined) return notFound("Skill");
        if (text(params.name) !== undefined) skill.name = text(params.name)?.trim() ?? skill.name;
        if (text(params.description) !== undefined) skill.description = text(params.description) ?? "";
        if (text(params.body) !== undefined) skill.body = text(params.body) ?? "";
        if (typeof params.autoGrantNewAgents === "boolean")
          skill.autoGrantNewAgents = params.autoGrantNewAgents;
        skill.version += 1;
        return reply(200, this.detailSkill(skill));
      }),
      reimportSkill: asManager((scope, params) => {
        const skill = this.skillOf(scope, params);
        if (skill === undefined) return notFound("Skill");
        skill.version += 1;
        return reply(200, this.detailSkill(skill));
      }),
      deleteSkill: asManager((scope, params) => {
        const skill = this.skillOf(scope, params);
        if (skill === undefined) return notFound("Skill");
        this.skills = this.skills.filter((candidate) => candidate !== skill);
        return reply(204, null);
      }),

      listAgentTestCases: asLiveEditor((_scope, agent) => reply(200, { cases: this.extra(agent).cases })),
      createAgentTestCase: asLiveEditor((_scope, agent, params) => {
        const input = text(params.input)?.trim() ?? "";
        if (input === "") return fail(400, "invalid_request", "Invalid body");
        const cases = this.extra(agent).cases;
        if (cases.length >= 50)
          return fail(409, "agent_test_case.full", "An agent holds up to 50 test cases");
        const at = this.host.now().toISOString();
        const item: T.AgentTestCase = {
          id: this.host.id("tcs"),
          agentId: agent.id,
          input,
          mustInclude: words(params.mustInclude),
          mustNotInclude: words(params.mustNotInclude),
          createdAt: at,
          updatedAt: at,
        };
        cases.push(item);
        return reply(201, item);
      }),
      deleteAgentTestCase: asLiveEditor((_scope, agent, params) => {
        const extra = this.extra(agent);
        extra.cases = extra.cases.filter((item) => item.id !== text(params.testCaseId));
        return reply(204, null);
      }),
      createAgentEval: asLiveEditor((scope, agent, params) => {
        if (!can(scope.role, "manage_agents")) return forbidden();
        const cases = this.extra(agent).cases;
        if (cases.length === 0) return fail(409, "agent_eval.no_cases", "Add a test case first");
        if (this.evals.some((row) => row.agentId === agent.id && row.status === "running")) {
          return fail(409, "agent_eval.running", "A test run is already going");
        }
        const row: FakeEval = {
          id: this.host.id("evl"),
          agentId: agent.id,
          costUsd: 0,
          createdAt: this.host.now().toISOString(),
          done: 0,
          error: null,
          finishedAt: null,
          proposalId: null,
          results: [],
          status: "running",
          summary: null,
          total: cases.length,
          reads: 0,
          cases: [...cases],
          before: agent.instructions,
          after: text(params.instructions) ?? "",
        };
        this.evals.unshift(row);
        return reply(201, this.shownEval(row));
      }),
      listAgentEvals: asLiveEditor((_scope, agent) =>
        reply(200, {
          evals: this.evals.filter((row) => row.agentId === agent.id).map((row) => this.shownEval(row)),
        }),
      ),
      getAgentEval: asLiveEditor((_scope, agent, params) => {
        const row = this.evals.find(
          (candidate) => candidate.agentId === agent.id && candidate.id === text(params.evalId),
        );
        if (row === undefined) return notFound("Test run");
        row.reads += 1;
        // Still running the first time it is read; done from the second read on.
        if (row.status === "running" && row.reads > 1) this.finish(row);
        return reply(200, this.shownEval(row));
      }),

      createAgentDraft: asManager((_scope, params) => {
        const description = text(params.description)?.trim() ?? "";
        if (description === "") return fail(400, "invalid_request", "Invalid body");
        const draft: T.AgentDraft = {
          name: "Courier",
          handle: "courier",
          role: "support",
          instructions: `You help with this: ${description}`,
          model: "claude-haiku-5-5",
          skillIds: ["skl_release"],
          testModel: true,
          why: "A support agent fits what you described.",
        };
        return reply(200, draft);
      }),
    };
  }

  /** Ends a running test run now, with its results. */
  finish(row: FakeEval): void {
    const results = row.cases.map((item) => ({
      caseId: item.id,
      input: item.input,
      before: this.evaluate(item, row.before),
      after: this.evaluate(item, row.after),
    }));
    row.results = results;
    row.done = results.length;
    row.status = "done";
    row.finishedAt = this.host.now().toISOString();
    row.summary = {
      cases: results.length,
      beforePass: results.filter((result) => result.before.pass).length,
      afterPass: results.filter((result) => result.after.pass).length,
      regressions: results.filter((result) => result.before.pass && !result.after.pass).length,
    };
  }
}
