// Debates for the fake server: the list, one debate, opening one, the estimate of what it can cost and
// the numbers of the last days. The answers follow the server's rules: a debate of a channel the caller
// doesn't read is one that doesn't exist (unless they take part), an agent at an open table shows only
// by its pseudonym, the table has 1 to 8 live agents and 20 seats at most, an agent on someone's personal
// plan sits only at its owner's table, a debate opened from an issue of a private channel stays in that
// channel, and spend goes only to who may see usage. Never part of the production build.
import type * as T from "@vanr/contract";
import { can } from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  agents: (workspaceId: string) => T.Agent[];
  /** Whether the person reads the channel, which must be one of this workspace. */
  readsChannel: (userId: string, channelId: string, workspaceId: string) => boolean;
  isMember: (workspaceId: string, userId: string) => boolean;
  /** An issue the person sees, with the channel it lives in and whether that channel is public. */
  issue: (
    workspaceId: string,
    userId: string,
    issueId: string,
  ) => { number: number; channelId: string | null; publicChannel: boolean } | undefined;
};
export type StoredDebate = T.DebateDetail & { workspaceId: string; spent: number };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const missing = () => fail(404, "not_found", "Debate not found");
const invalid = (message: string) => fail(400, "invalid_request", message);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((each) => typeof each === "string") ? value : null;
const DAY_MS = 86_400_000;

export class FakeDebates {
  debates: StoredDebate[] = [];
  /** Who paired each personal-plan agent's runner, by agent id: only they can seat it. */
  planOwners = new Map<string, string>();
  /** Each person's blind pick, by `${debateId}/${userId}`; null once opened and not picked. */
  picks = new Map<string, "a" | "b" | "tie" | null>();

  constructor(private readonly host: Host) {}

  clear(): void {
    this.debates = [];
    this.planOwners = new Map();
    this.picks = new Map();
  }

  seed(): void {
    this.clear();
    const now = this.host.now().getTime();
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const ana = { type: "person" as const, id: "usr_ana" };
    this.debates = [
      this.make("workspace_birchwood", {
        id: "deb_paper",
        title: "Which paper supplier do we keep?",
        goal: "One supplier for the next quarter, with a reason the print room accepts.",
        createdBy: { type: "person", id: "usr_jonas" },
        requesterUserId: "usr_jonas",
        agentIds: ["agt_scout", "agt_ledger"],
        userIds: ["usr_ana"],
        speakers: [
          { type: "agent", id: "agt_scout" },
          { type: "agent", id: "agt_ledger" },
          { type: "person", id: "usr_ana" },
        ],
        phase: "human_turn",
        round: 1,
        roundLimit: 2,
        waitingUserIds: ["usr_ana"],
        awaitedUserId: "usr_ana",
        options: ["Northpaper", "Mill & Co"],
        updatedAt: ago(1),
      }),
      this.make("workspace_birchwood", {
        id: "deb_ink",
        title: "Should we switch to refillable ink?",
        goal: "A yes or no, with what it saves in a year.",
        createdBy: ana,
        requesterUserId: "usr_ana",
        agentIds: ["agt_scout", "agt_tally"],
        phase: "debating",
        round: 0,
        roundLimit: 1,
        engagedAgentIds: ["agt_tally"],
        updatedAt: ago(2),
      }),
      this.make("workspace_birchwood", {
        id: "deb_hours",
        title: "Do we open on Saturdays?",
        goal: "Decide whether weekend hours pay for themselves.",
        createdBy: { type: "person", id: "usr_iris" },
        requesterUserId: "usr_iris",
        agentIds: ["agt_ledger"],
        status: "stalled",
        phase: null,
        round: 1,
        roundLimit: 3,
        stallInfo: { agentId: "agt_ledger", reason: "The model did not answer", round: 1 },
        updatedAt: ago(5),
      }),
      this.make("workspace_birchwood", {
        id: "deb_logo",
        title: "Which logo goes on the new sign?",
        goal: "Pick the logo for the shop front.",
        createdBy: ana,
        requesterUserId: "usr_ana",
        agentIds: ["agt_scout", "agt_ledger"],
        status: "done",
        phase: null,
        round: 1,
        roundLimit: 1,
        endReason: "unanimous",
        anonymous: false,
        pseudonyms: { agt_scout: "A", agt_ledger: "B" },
        verdictState: { state: "accepted", acceptedAt: ago(20), endorsedBy: "usr_ana" },
        updatedAt: ago(24),
      }),
    ];
    const logo = this.debates[3];
    if (logo !== undefined) logo.spent = 0.0123;
  }

  /** A debate as the server would keep it, with the defaults of a fresh one. */
  make(
    workspaceId: string,
    fields: Partial<T.DebateDetail> & Pick<T.DebateDetail, "id" | "title">,
  ): StoredDebate {
    const at = this.host.now().toISOString();
    const agentIds = fields.agentIds ?? [];
    const debate: StoredDebate = {
      workspaceId,
      spent: 0,
      goal: fields.title,
      agentIds,
      anonymous: true,
      awaitedUserId: null,
      channelId: null,
      createdAt: at,
      createdBy: { type: "person", id: "usr_ana" },
      deadline: null,
      endReason: null,
      engagedAgentIds: [],
      format: "decision",
      leadAgentId: agentIds[0] ?? null,
      leadUserId: null,
      options: [],
      origin: { kind: "manual" },
      phase: "debating",
      pseudonyms: null,
      requesterUserId: null,
      round: 0,
      roundLimit: 1,
      speakers: agentIds.map((id) => ({ type: "agent", id })),
      spendCapPercent: null,
      spendCapUsd: null,
      stallInfo: null,
      status: "open",
      updatedAt: at,
      userIds: [],
      verdictState: null,
      waitingUserIds: [],
      issues: [],
      posts: [],
      sealedCount: 0,
      spentUsd: 0,
      synthesis: null,
      track: { roundLimit: [], synthesis: null },
      ...fields,
    };
    return debate;
  }

  post(
    id: string,
    round: number,
    author: T.ActorRef | null,
    pseudonym: string | null,
    body: string,
    claimData: T.DebateClaim | null,
    kind: T.DebatePost["kind"] = author?.type === "person" ? "speaker" : "turn",
  ): T.DebatePost {
    return {
      id,
      author,
      body,
      claimData,
      createdAt: this.host.now().toISOString(),
      kind,
      meta: {},
      pseudonym,
      replyTo: null,
      round,
      runId: null,
      wantsExtraRound: false,
    };
  }

  claim(answer: string, confidence: number | null): T.DebateClaim {
    return { answer, key: answer.toLowerCase(), confidence, changed: false, evidence: [], reason: "" };
  }

  /** The server's rule: a debate without a channel, or of a channel the person reads, or one they take part in. */
  sees(scope: Scope, row: StoredDebate): boolean {
    if (row.workspaceId !== scope.workspaceId) return false;
    const me = scope.user.id;
    const part =
      row.requesterUserId === me ||
      row.leadUserId === me ||
      (row.createdBy.type === "person" && row.createdBy.id === me) ||
      row.userIds.includes(me);
    return row.channelId === null || part || this.host.readsChannel(me, row.channelId, row.workspaceId);
  }

  /** The list's shape: what `toDebate` sends, without the detail's fields. */
  summary(row: StoredDebate): T.Debate {
    const {
      workspaceId: _workspace,
      spent: _spent,
      issues: _issues,
      posts: _posts,
      sealedCount: _sealed,
      spentUsd: _spentUsd,
      synthesis: _synthesis,
      track: _track,
      ...debate
    } = row;
    return debate;
  }

  /** The detail as the person reads it: spend only to who may see usage, null for everyone else. */
  detail(scope: Scope, row: StoredDebate): T.DebateDetail {
    const { workspaceId: _workspace, spent, ...debate } = row;
    return { ...debate, spentUsd: can(scope.role, "view_usage") ? spent : null };
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const visible = (scope: Scope) => this.debates.filter((row) => this.sees(scope, row));

    return {
      listDebates: within((scope) =>
        reply(200, {
          debates: visible(scope)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((row) => this.summary(row)),
        }),
      ),
      getDebate: within((scope, params) => {
        const row = visible(scope).find((each) => each.id === params.debateId);
        return row === undefined ? missing() : reply(200, this.detail(scope, row));
      }),
      estimateDebate: within((scope, params) => {
        const ids = typeof params.agentIds === "string" ? params.agentIds.split(",").filter(Boolean) : [];
        // An archived agent costs nothing: it never takes a turn.
        const known = this.host
          .agents(scope.workspaceId)
          .filter((agent) => agent.archivedAt === null && ids.includes(agent.id));
        const rounds = Math.max(0, Math.min(10, Number(params.rounds ?? 3) || 0));
        const calls = known.length * (rounds + 1) + (known.length > 0 ? 1 : 0);
        return reply(200, { calls, upToUsd: Math.round(calls * 0.0425 * 10_000) / 10_000 });
      }),
      listDebateMetrics: within((scope, params) => {
        const days = Math.max(1, Math.min(365, Number(params.days ?? 90) || 90));
        const since = this.host.now().getTime() - days * DAY_MS;
        const done = visible(scope).filter(
          (row) => row.status === "done" && Date.parse(row.updatedAt) >= since,
        );
        // A debate counts as challenged once it had a round after the opening, and as changed when a
        // position moved in one of them.
        const challenged = done.filter((row) =>
          row.posts.some((post) => post.kind === "turn" && post.round > 0),
        );
        const changed = challenged.filter((row) =>
          row.posts.some((post) => post.kind === "turn" && post.claimData?.changed === true),
        );
        const endReasons: Partial<Record<T.DebateEndReason, number>> = {};
        for (const row of done)
          if (row.endReason !== null) endReasons[row.endReason] = (endReasons[row.endReason] ?? 0) + 1;
        const blindReviews = { debate: 0, single: 0, tie: 0 };
        for (const [key, pick] of this.picks) {
          const row = done.find((each) => key.startsWith(`${each.id}/`));
          // The fake shows the synthesis first, so "a" is the debate's own answer.
          if (row !== undefined && pick !== null)
            blindReviews[pick === "a" ? "debate" : pick === "b" ? "single" : "tie"]++;
        }
        const cost = done.reduce((sum, row) => sum + row.spent, 0);
        const metrics: T.DebateMetrics = {
          days,
          settled: done.length,
          accepted: done.filter((row) => row.verdictState !== null).length,
          reverted30: done.filter((row) => row.verdictState?.state === "reverted").length,
          changedDebates: changed.length,
          challenged: challenged.length,
          endReasons,
          blindReviews,
          meanCostUsd: can(scope.role, "view_usage") ? (done.length === 0 ? 0 : cost / done.length) : null,
          theater: challenged.length >= 10 && changed.length / challenged.length < 0.1,
        };
        return reply(200, metrics);
      }),
      createDebate: within((scope, params) => {
        const title = typeof params.title === "string" ? params.title.trim() : "";
        const goal = typeof params.goal === "string" ? params.goal.trim() : "";
        const agentIds = strings(params.agentIds) ?? [];
        const userIds = strings(params.userIds) ?? [];
        if (title === "" || title.length > 200) return invalid("The question must have 1 to 200 characters");
        if (goal === "" || goal.length > 4000) return invalid("The goal must have 1 to 4000 characters");
        if (agentIds.length < 1 || agentIds.length > 8) return invalid("Pick 1 to 8 agents");
        const speakers = Array.isArray(params.speakers)
          ? (params.speakers as T.DebateSpeaker[])
          : agentIds.map((id) => ({ type: "agent" as const, id }));
        const seatedAgents = [
          ...new Set([...agentIds, ...speakers.filter((s) => s.type === "agent").map((s) => s.id)]),
        ];
        const live = this.host
          .agents(scope.workspaceId)
          .filter((agent) => agent.archivedAt === null && seatedAgents.includes(agent.id));
        if (live.length !== seatedAgents.length) return fail(404, "not_found", "Agent not found");
        if (seatedAgents.some((id) => (this.planOwners.get(id) ?? scope.user.id) !== scope.user.id))
          return fail(403, "agent.personal_plan", "This agent runs on someone else's personal plan");
        const people = [...userIds, ...speakers.filter((s) => s.type === "person").map((s) => s.id)];
        if (people.some((id) => !this.host.isMember(scope.workspaceId, id)))
          return fail(404, "not_found", "Member not found");
        if (agentIds.length + userIds.length > 20) return invalid("At most 20 seats");
        const options = strings(params.options);
        if (options !== null && (options.length < 2 || options.length > 8))
          return invalid("Give 2 to 8 options");
        const cap = params.spendCapPercent;
        if (cap !== undefined && (typeof cap !== "number" || cap < 0.1 || cap > 100))
          return invalid("The cap must be from 0.1 to 100");
        // A channel the person doesn't read is refused as one that doesn't exist.
        const channelId = typeof params.channelId === "string" ? params.channelId : null;
        if (channelId !== null && !this.host.readsChannel(scope.user.id, channelId, scope.workspaceId))
          return fail(404, "not_found", "Channel not found");
        // An issue of a private channel (or a DM) is debated in that channel, never somewhere wider.
        const source = typeof params.sourceIssueId === "string" ? params.sourceIssueId : null;
        const issue = source === null ? undefined : this.host.issue(scope.workspaceId, scope.user.id, source);
        if (source !== null && issue === undefined) return fail(404, "not_found", "Issue not found");
        const issueChannel = issue?.channelId != null && !issue.publicChannel ? issue.channelId : null;
        if (issueChannel !== null && channelId !== null && channelId !== issueChannel)
          return fail(400, "debate.issue_channel", "Debate this issue in the channel it belongs to");
        const deadline = typeof params.deadline === "string" ? params.deadline : null;
        if (deadline !== null && Date.parse(deadline) <= this.host.now().getTime())
          return fail(400, "debate.deadline_past", "The deadline must be in the future");
        const rounds = typeof params.rounds === "number" ? params.rounds : 1;
        const format = params.format === "plan" ? "plan" : "decision";
        const row = this.make(scope.workspaceId, {
          id: this.host.id("deb"),
          title,
          goal,
          format,
          agentIds,
          userIds,
          speakers,
          roundLimit: rounds,
          deadline,
          options: options ?? [],
          spendCapPercent: typeof cap === "number" ? cap : null,
          channelId: issueChannel ?? channelId,
          origin: issue === undefined ? { kind: "manual" } : { kind: "issue", issueSeq: issue.number },
          createdBy: { type: "person", id: scope.user.id },
          requesterUserId: scope.user.id,
          engagedAgentIds: agentIds,
          pseudonyms: null,
        });
        this.debates.push(row);
        this.host.emit(scope.workspaceId, { type: "debate.updated", debateId: row.id });
        return reply(201, this.detail(scope, row));
      }),
    };
  }
}
