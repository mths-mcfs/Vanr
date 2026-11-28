// The control center for the fake server: approvals with their trail, "always allow" rules, the gate's
// numbers, proposals, and undo and redo of what agents changed. Who may decide, see and undo follows the
// real server: the agent's owner decides its approvals (someone who manages agents when the owner left),
// a private channel's approval shows only to its members and to whoever decides, and an action is undone
// by whoever asked, the agent's owner or someone who manages agents. Approving runs the action at once:
// a post waits in the send queue, as the real one does. Never part of the production build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };

/** What the control center needs from the fake server beyond the files' host. */
export type ControlHost = FilesHost & {
  agentOwner: (agentId: string) => string | undefined;
  isMember: (workspaceId: string, userId: string) => boolean;
  /** A channel's members and visibility, or undefined when it does not exist. */
  channel: (channelId: string) => { memberIds: string[]; visibility: string } | undefined;
  channelWorkspace: (channelId: string) => string | undefined;
  /** The conversation's messages; answers with receipts are added here. */
  messages: () => T.Message[];
  emitTo: (workspaceId: string, event: { type: string } & Record<string, unknown>, channelId: string) => void;
};

type Stored = { workspaceId: string; approval: Omit<T.Approval, "decidable"> };
type StoredRule = { workspaceId: string; rule: T.ApprovalRule };
type StoredProposal = { workspaceId: string; proposal: Omit<T.Proposal, "decidable" | "canUndo"> };

const HOUR_MS = 3_600_000;
const SEND_WINDOW_MS = 30_000;
const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const manages = (role: T.Role) => role === "owner" || role === "admin";

export class FakeControl {
  approvals: Stored[] = [];
  rules: StoredRule[] = [];
  proposals: StoredProposal[] = [];
  stats: T.ApprovalStatsRow[] = [];
  /** The agents' open and closed questions (the conversation's cards). */
  questions: { workspaceId: string; question: T.AgentQuestion }[] = [];

  constructor(private readonly host: ControlHost) {}

  private at(ms: number): string {
    return new Date(this.host.now().getTime() + ms).toISOString();
  }

  /* ---------- who may ---------- */

  private decides(scope: Scope, agentId: string): boolean {
    const owner = this.host.agentOwner(agentId);
    if (owner !== undefined && this.host.isMember(scope.workspaceId, owner)) return owner === scope.user.id;
    return manages(scope.role);
  }

  private reads(scope: Scope, channelId: string): boolean {
    const channel = this.host.channel(channelId);
    if (channel === undefined) return false;
    return channel.visibility !== "private" || channel.memberIds.includes(scope.user.id);
  }

  private view(scope: Scope, stored: Stored): T.Approval | undefined {
    const approval = { ...stored.approval, decidable: this.decides(scope, stored.approval.agentId) };
    const sees =
      approval.ownerUserId === scope.user.id ||
      approval.decidable ||
      approval.channelId === null ||
      this.reads(scope, approval.channelId);
    return sees ? approval : undefined;
  }

  private decidesProposal(scope: Scope, proposal: StoredProposal["proposal"]): boolean {
    if (proposal.target.kind === "agent_prompt") {
      return manages(scope.role) || this.host.agentOwner(proposal.target.agentId) === scope.user.id;
    }
    return manages(scope.role);
  }

  private proposalView(scope: Scope, stored: StoredProposal): T.Proposal {
    const decidable = stored.proposal.status === "pending" && this.decidesProposal(scope, stored.proposal);
    const canUndo =
      stored.proposal.status === "accepted" &&
      stored.proposal.actionId !== null &&
      this.decidesProposal(scope, stored.proposal);
    return { ...stored.proposal, decidable, canUndo };
  }

  private mayUndo(scope: Scope, action: T.AgentAction): boolean {
    return (
      action.requesterUserId === scope.user.id ||
      this.host.agentOwner(action.agentId) === scope.user.id ||
      manages(scope.role)
    );
  }

  /* ---------- data ---------- */

  seed(): void {
    const workspaceId = "workspace_birchwood";
    const trail = (
      code: NonNullable<T.ApprovalTrailEntry["code"]>,
      ms: number,
      params: Record<string, string>,
    ) => ({
      at: this.at(ms),
      code,
      params,
      text: code,
    });
    const base = {
      appliedAt: null,
      connector: null,
      decidedAt: null,
      deciderUserId: null,
      edited: false,
      flags: [],
      issue: null,
      linkedAccount: null,
      messageId: null,
      reason: null,
      result: null,
      threadId: null,
    };
    this.approvals = [
      {
        workspaceId,
        approval: {
          ...base,
          id: "apr_post",
          agentId: "agt_scout",
          ownerUserId: "usr_ana",
          channelId: "ch_general",
          runId: "run_post",
          createdAt: this.at(-20 * 60_000),
          expiresAt: this.at(3 * HOUR_MS),
          tool: "post_message",
          scope: "chat:post_message",
          title: "Post in #print-queue",
          params: { channel: "#print-queue", text: "The Hartley proofs are ready for pickup." },
          detail: "The Hartley proofs are ready for pickup.",
          effect: "K2",
          gateReason: "policy",
          preview: {
            title: "Post in #print-queue",
            body: "The Hartley proofs are ready for pickup.",
            links: [],
          },
          input: { channel: "#print-queue", text: "The Hartley proofs are ready for pickup." },
          editable: ["text"],
          payloadHash: "hash_post_1",
          rememberLabel: "#print-queue",
          status: "pending",
          why: "Íris asked to let the print room know.",
          trail: [trail("requested", -20 * 60_000, { name: "Scout" })],
        },
      },
      {
        workspaceId,
        approval: {
          ...base,
          id: "apr_invoices",
          agentId: "agt_tally",
          ownerUserId: "usr_jonas",
          channelId: "ch_print",
          runId: "run_invoices",
          createdAt: this.at(-60 * 60_000),
          expiresAt: this.at(40 * 60_000),
          tool: "send_email",
          scope: "mail:send",
          title: "Email the October invoices",
          params: {},
          detail: "Hello, the October invoices are attached. Pay at https://pay.example/birchwood",
          effect: "K3",
          gateReason: "irreversible",
          flags: [{ flag: "A", source: "email from billing@hartley.example" }],
          preview: {
            title: "Email the October invoices",
            recipients: ["billing@hartley.example"],
            body: "Hello, the October invoices are attached. Pay at https://pay.example/birchwood",
            links: ["https://pay.example/birchwood → https://pay-example.invalid/login"],
          },
          input: { to: ["billing@hartley.example"], text: "Hello" },
          editable: [],
          payloadHash: "hash_mail_1",
          rememberLabel: null,
          status: "pending",
          why: "",
          trail: [trail("requested", -60 * 60_000, { name: "Tally" })],
        },
      },
      {
        workspaceId,
        approval: {
          ...base,
          id: "apr_done",
          agentId: "agt_ledger",
          ownerUserId: "usr_ana",
          channelId: "ch_general",
          runId: "run_done",
          createdAt: this.at(-5 * HOUR_MS),
          expiresAt: this.at(19 * HOUR_MS),
          decidedAt: this.at(-4 * HOUR_MS),
          deciderUserId: "usr_ana",
          appliedAt: this.at(-4 * HOUR_MS),
          result: { ok: true, text: "Posted in #design (message msg_done_post)." },
          tool: "post_message",
          scope: "chat:post_message",
          title: "Post in #design",
          params: { channel: "#design", text: "New paper stock arrived." },
          detail: "New paper stock arrived.",
          effect: "K2",
          gateReason: "policy",
          preview: { title: "Post in #design", body: "New paper stock arrived." },
          input: { channel: "#design", text: "New paper stock arrived." },
          editable: ["text"],
          payloadHash: "hash_done",
          rememberLabel: "#design",
          status: "approved",
          why: "",
          trail: [
            trail("requested", -5 * HOUR_MS, { name: "Ledger" }),
            trail("approved", -4 * HOUR_MS, { name: "Ana Beatriz Souza" }),
            trail("executed", -4 * HOUR_MS, {}),
          ],
        },
      },
    ];
    this.host.messages().push(
      this.answer("ch_general", "agt_ledger", "run_done", [
        {
          id: "act_done",
          agentId: "agt_ledger",
          createdAt: this.at(-4 * HOUR_MS),
          kind: "message_posted",
          messageId: "msg_run_done",
          params: { channelId: "ch_design" },
          requesterUserId: "usr_iris",
          revertedAt: null,
          reverterUserId: null,
          revertibleUntil: this.at(20 * HOUR_MS),
          target: { id: "msg_done_post", title: "#design", type: "message" },
        },
      ]),
    );
    this.rules = [
      {
        workspaceId,
        rule: {
          id: "rule_design",
          agentId: "agt_ledger",
          createdAt: this.at(-4 * HOUR_MS),
          createdByUserId: "usr_ana",
          expiresAt: this.at(29 * 24 * HOUR_MS),
          label: "#design",
          lastUsedAt: null,
          tool: "post_message",
          uses: 2,
        },
      },
    ];
    this.stats = [
      {
        effect: "K1",
        calls: 40,
        auto: 38,
        asked: 2,
        denied: 0,
        approved: 2,
        edited: 0,
        rejected: 0,
        expired: 0,
        p50Ms: 90_000,
        p90Ms: 300_000,
      },
      {
        effect: "K2",
        calls: 12,
        auto: 4,
        asked: 8,
        denied: 0,
        approved: 5,
        edited: 1,
        rejected: 1,
        expired: 1,
        p50Ms: 600_000,
        p90Ms: 3_600_000,
      },
    ];
    this.proposals = [
      {
        workspaceId,
        proposal: {
          id: "prop_tone",
          actionId: null,
          agentId: "agt_scout",
          target: { kind: "agent_prompt", agentId: "agt_scout" },
          title: "Answer print questions with the shop's hours",
          before: "You help the print shop.\nBe brief.",
          after: "You help the print shop.\nBe brief.\nEnd with the opening hours: 9 to 18.",
          why: "Three people asked for the hours this week.",
          evidence: "Questions in #general on Monday and Wednesday.",
          stale: false,
          status: "pending",
          createdAt: this.at(-2 * HOUR_MS),
          decidedAt: null,
          decidedBy: null,
          undone: false,
          trail: [
            {
              at: this.at(-2 * HOUR_MS),
              code: "proposed",
              params: { name: "Scout" },
              text: "Scout proposed",
            },
          ],
        },
      },
      {
        workspaceId,
        proposal: {
          id: "prop_old",
          actionId: null,
          agentId: "agt_ledger",
          target: { kind: "workspace_context" },
          title: "Mention the new address",
          before: "We build tools for small print shops.",
          after: "We build tools for small print shops, from Rua Nova 12.",
          why: "",
          evidence: "",
          stale: true,
          status: "pending",
          createdAt: this.at(-26 * HOUR_MS),
          decidedAt: null,
          decidedBy: null,
          undone: false,
          trail: [],
        },
      },
    ];
  }

  /** An agent's answer carrying the receipt of what its run changed. */
  private answer(channelId: string, agentId: string, runId: string, actions: T.AgentAction[]): T.Message {
    return {
      id: `msg_${runId}`,
      actions,
      agentMentionIds: [],
      author: { type: "agent", id: agentId },
      body: "Done.",
      channelId,
      clientId: null,
      createdAt: this.at(0),
      editedAt: null,
      memories: [],
      meta: {},
      reactions: [],
      receipts: { claimedBy: [], handled: [], viewedBy: [] },
      replyCount: 0,
      runId,
      threadId: null,
      usage: null,
    };
  }

  /** Approving runs the action: a post waits in the send queue, and the run's answer carries its receipt. */
  private carryOut(stored: Stored, requesterUserId: string): void {
    const approval = stored.approval;
    approval.appliedAt = this.at(0);
    approval.result = { ok: true, text: "Queued." };
    approval.trail = [...approval.trail, { at: this.at(0), code: "executed", params: {}, text: "Done" }];
    if (approval.channelId === null || approval.runId === null) return;
    const title = typeof approval.params.channel === "string" ? approval.params.channel : approval.title;
    this.host.messages().push(
      this.answer(approval.channelId, approval.agentId, approval.runId, [
        {
          id: `act_${approval.id}`,
          agentId: approval.agentId,
          createdAt: this.at(0),
          kind: "message_posted",
          messageId: `msg_${approval.runId}`,
          params: { outboxId: `out_${approval.id}`, sendAt: this.at(SEND_WINDOW_MS) },
          requesterUserId,
          revertedAt: null,
          reverterUserId: null,
          revertibleUntil: this.at(24 * HOUR_MS),
          target: { id: `out_${approval.id}`, title, type: "outbox" },
        },
      ]),
    );
  }

  private announce(stored: Stored, type: "approval.resolved"): void {
    const event = { type, approvalId: stored.approval.id, agentId: stored.approval.agentId };
    this.host.emit(stored.workspaceId, event);
    if (stored.approval.channelId !== null)
      this.host.emitTo(stored.workspaceId, event, stored.approval.channelId);
  }

  private findAction(workspaceId: string, actionId: unknown) {
    for (const message of this.host.messages()) {
      if (this.host.channel(message.channelId) === undefined) continue;
      const action = message.actions.find((each) => each.id === actionId);
      if (action !== undefined && this.inWorkspace(workspaceId, message.channelId))
        return { message, action };
    }
    return undefined;
  }

  private inWorkspace(workspaceId: string, channelId: string): boolean {
    return this.host.channelWorkspace(channelId) === workspaceId;
  }

  /* ---------- operations ---------- */

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const approvalOf = (scope: Scope, id: unknown) =>
      this.approvals.find((each) => each.workspaceId === scope.workspaceId && each.approval.id === id);
    const decide = (
      scope: Scope,
      params: Record<string, unknown>,
      decision: "approved" | "rejected",
      edit?: Record<string, unknown>,
    ): FilesReply => {
      const stored = approvalOf(scope, params.approvalId);
      const view = stored === undefined ? undefined : this.view(scope, stored);
      if (stored === undefined || view === undefined) return fail(404, "not_found", "Approval not found");
      if (!view.decidable) return fail(403, "forbidden", "Only the agent's owner decides");
      if (stored.approval.status !== "pending")
        return fail(409, "approval.already_resolved", "Already decided");
      const approval = stored.approval;
      if (decision === "approved" && params.payloadHash !== approval.payloadHash)
        return fail(409, "approval.changed", "The request changed");
      const remembers = decision === "approved" && params.remember === true;
      if (remembers && approval.rememberLabel === null)
        return fail(400, "approval.not_rememberable", "This request can't be remembered");
      const name = scope.user.name;
      approval.status = decision;
      approval.decidedAt = this.at(0);
      approval.deciderUserId = scope.user.id;
      approval.reason = text(params.reason) ?? null;
      if (edit !== undefined) {
        approval.edited = true;
        approval.input = { ...approval.input, ...edit };
        const body = text(edit.text);
        if (body !== undefined && approval.preview !== null) approval.preview = { ...approval.preview, body };
        approval.trail = [
          ...approval.trail,
          { at: this.at(0), code: "edited", params: { name }, text: "Edited" },
        ];
      }
      approval.trail = [
        ...approval.trail,
        { at: this.at(0), code: decision, params: { name }, text: decision },
        ...(remembers
          ? [
              {
                at: this.at(0),
                code: "remembered" as const,
                params: { name, label: approval.rememberLabel ?? "" },
                text: "remembered",
              },
            ]
          : []),
      ];
      if (remembers) {
        this.rules.unshift({
          workspaceId: scope.workspaceId,
          rule: {
            id: this.host.id("rule"),
            agentId: approval.agentId,
            createdAt: this.at(0),
            createdByUserId: scope.user.id,
            expiresAt: this.at(30 * 24 * HOUR_MS),
            label: approval.rememberLabel ?? "",
            lastUsedAt: null,
            tool: approval.tool,
            uses: 0,
          },
        });
      }
      if (decision === "approved") this.carryOut(stored, scope.user.id);
      this.announce(stored, "approval.resolved");
      return reply(200, this.view(scope, stored));
    };
    const toggle = (
      scope: Scope,
      params: Record<string, unknown>,
      direction: "undo" | "redo",
    ): FilesReply => {
      const proposal = this.proposals.find(
        (each) => each.workspaceId === scope.workspaceId && each.proposal.actionId === params.actionId,
      );
      if (proposal !== undefined) {
        if (!this.decidesProposal(scope, proposal.proposal))
          return fail(403, "action.not_yours", "Not your action");
        proposal.proposal.undone = direction === "undo";
        const name = scope.user.name;
        proposal.proposal.trail = [
          ...proposal.proposal.trail,
          {
            at: this.at(0),
            code: direction === "undo" ? "undone" : "redone",
            params: { name },
            text: direction,
          },
        ];
        return reply(200, {
          ...actionOfProposal(proposal.proposal, this.at(0)),
          revertedAt: proposal.proposal.undone ? this.at(0) : null,
        });
      }
      const found = this.findAction(scope.workspaceId, params.actionId);
      if (found === undefined) return fail(404, "not_found", "Action not found");
      const { message, action } = found;
      if (!this.mayUndo(scope, action)) return fail(403, "action.not_yours", "Not your action");
      if (action.revertibleUntil === null || Date.parse(action.revertibleUntil) <= this.host.now().getTime())
        return fail(409, "action.expired", "Too late to undo");
      if ((direction === "undo") === (action.revertedAt !== null))
        return fail(409, "action.changed_since", "Already done");
      action.revertedAt = direction === "undo" ? this.at(0) : null;
      action.reverterUserId = direction === "undo" ? scope.user.id : null;
      this.host.emitTo(
        scope.workspaceId,
        { type: "message.actions_updated", messageId: message.id, actions: message.actions },
        message.channelId,
      );
      return reply(200, action);
    };

    return {
      listApprovals: within((scope, params) => {
        const query = text(params.status);
        const list = this.approvals
          .filter((each) => each.workspaceId === scope.workspaceId)
          .filter(
            (each) =>
              query === undefined ||
              (query === "pending" ? each.approval.status === "pending" : each.approval.status !== "pending"),
          )
          .flatMap((each) => this.view(scope, each) ?? []);
        return reply(200, { approvals: list });
      }),
      getApproval: within((scope, params) => {
        const stored = approvalOf(scope, params.approvalId);
        const view = stored === undefined ? undefined : this.view(scope, stored);
        return view === undefined ? fail(404, "not_found", "Approval not found") : reply(200, view);
      }),
      approveApproval: within((scope, params) => decide(scope, params, "approved")),
      rejectApproval: within((scope, params) => decide(scope, params, "rejected")),
      editApproval: within((scope, params) => {
        const input = typeof params.input === "object" && params.input !== null ? params.input : {};
        return decide(scope, params, "approved", input as Record<string, unknown>);
      }),
      listApprovalStats: within((scope) =>
        manages(scope.role)
          ? reply(200, { since: this.at(-30 * 24 * HOUR_MS), byEffect: this.stats })
          : fail(403, "forbidden", "Only who sees usage"),
      ),
      listApprovalRules: within((scope) =>
        reply(200, {
          rules: this.rules
            .filter((each) => each.workspaceId === scope.workspaceId)
            .filter(
              (each) => manages(scope.role) || this.host.agentOwner(each.rule.agentId) === scope.user.id,
            )
            .map((each) => each.rule),
        }),
      ),
      deleteApprovalRule: within((scope, params) => {
        const index = this.rules.findIndex(
          (each) => each.workspaceId === scope.workspaceId && each.rule.id === params.approvalRuleId,
        );
        const stored = this.rules[index];
        if (stored === undefined) return fail(404, "not_found", "Rule not found");
        if (!manages(scope.role) && this.host.agentOwner(stored.rule.agentId) !== scope.user.id)
          return fail(403, "forbidden", "Only who answers for the agent revokes its rules");
        this.rules.splice(index, 1);
        return reply(204, null);
      }),

      listProposals: within((scope) =>
        reply(200, {
          proposals: this.proposals
            .filter((each) => each.workspaceId === scope.workspaceId)
            .map((each) => this.proposalView(scope, each)),
        }),
      ),
      acceptProposal: within((scope, params) => this.decideProposal(scope, params, "accepted")),
      rejectProposal: within((scope, params) => this.decideProposal(scope, params, "rejected")),

      answerQuestion: within((scope, params) => {
        const stored = this.questions.find(
          (each) => each.workspaceId === scope.workspaceId && each.question.id === params.questionId,
        );
        if (stored === undefined) return fail(404, "not_found", "Question not found");
        const question = stored.question;
        if (question.askedUserId !== null && question.askedUserId !== scope.user.id)
          return fail(403, "forbidden", "Only the person who was asked can answer");
        if (question.status !== "open") return fail(409, "question.closed", "The question is no longer open");
        const answer = text(params.choice) ?? text(params.text) ?? "";
        stored.question = { ...question, status: "answered", answer, responderUserId: scope.user.id };
        return reply(200, stored.question);
      }),

      undoAction: within((scope, params) => toggle(scope, params, "undo")),
      redoAction: within((scope, params) => toggle(scope, params, "redo")),
      undoMessageAction: within((scope, params) => {
        const message = this.host.messages().find((each) => each.id === params.messageId);
        if (message === undefined) return fail(404, "not_found", "No actions on this message");
        const mine = message.actions.filter((action) => this.mayUndo(scope, action));
        if (mine.length === 0) return fail(404, "not_found", "No actions on this message");
        for (const action of mine) {
          if (action.revertedAt !== null) continue;
          action.revertedAt = this.at(0);
          action.reverterUserId = scope.user.id;
        }
        return reply(200, { actions: mine, failed: [] });
      }),
    };
  }

  private decideProposal(
    scope: Scope,
    params: Record<string, unknown>,
    decision: "accepted" | "rejected",
  ): FilesReply {
    const stored = this.proposals.find(
      (each) => each.workspaceId === scope.workspaceId && each.proposal.id === params.proposalId,
    );
    if (stored === undefined) return fail(404, "not_found", "Proposal not found");
    const proposal = stored.proposal;
    if (!this.decidesProposal(scope, proposal)) return fail(403, "forbidden", "Forbidden");
    if (proposal.status !== "pending") return fail(409, "proposal.decided", "Already decided");
    if (decision === "accepted" && proposal.stale)
      return fail(409, "proposal.stale", "The text changed since");
    const edited = text(params.text);
    if (decision === "accepted" && edited !== undefined) proposal.after = edited;
    proposal.status = decision;
    proposal.decidedAt = this.at(0);
    proposal.decidedBy = scope.user.id;
    if (decision === "accepted") proposal.actionId = this.host.id("act");
    proposal.trail = [
      ...proposal.trail,
      { at: this.at(0), code: decision, params: { name: scope.user.name }, text: decision },
    ];
    return reply(200, this.proposalView(scope, stored));
  }
}

/** The undo action behind an accepted proposal, as the undo routes answer it. */
function actionOfProposal(proposal: StoredProposal["proposal"], at: string): T.AgentAction {
  return {
    id: proposal.actionId ?? "",
    agentId: proposal.agentId,
    createdAt: at,
    kind: "proposal_applied",
    messageId: null,
    params: {},
    requesterUserId: null,
    revertedAt: null,
    reverterUserId: null,
    revertibleUntil: at,
    target: { id: proposal.id, title: proposal.title, type: "proposal" },
  };
}
