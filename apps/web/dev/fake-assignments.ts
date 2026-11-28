// Assignments for the fake server: the list with its counts, creating one, starting, pausing, resuming,
// stopping and closing it, its plan, trail, decisions, results, reviews, commands, people and files. The
// answers follow the server's rules: an assignment of a channel the caller doesn't read is a missing one,
// only its owner and the people who decide act on it, and only its owner (or an admin) manages its people.
// Never part of the production build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  agents: (workspaceId: string) => T.Agent[];
  readsChannel: (userId: string, channelId: string) => boolean;
  nameOf: (userId: string) => string;
};
type Stored = Omit<T.Assignment, "role" | "actionable" | "manageable"> & {
  workspaceId: string;
  people: { userId: string; role: T.ParticipantRole }[];
  requests: T.AssignmentJoinRequest[];
  decisions: T.AssignmentDecision[];
  submissions: T.AssignmentSubmission[];
  reviews: T.AssignmentReview[];
  commands: T.AssignmentCommand[];
  events: T.AssignmentEvent[];
  seen: Map<string, number>;
};

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const missing = () => fail(404, "not_found", "Assignment not found");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const NO_PENDING = { commands: 0, decisions: 0, joinRequests: 0, provisional: 0, reviews: 0, submissions: 0 };

export class FakeAssignments {
  assignments: Stored[] = [];

  constructor(private readonly host: Host) {}

  clear(): void {
    this.assignments = [];
  }

  seed(): void {
    this.clear();
    const at = this.host.now().toISOString();
    const agent = { type: "agent" as const, id: "agt_scout" };
    const paper = this.make("workspace_birchwood", {
      id: "asg_paper",
      title: "Restock the paper room",
      goal: "Every printer has a week of paper.",
      agentId: "agt_scout",
      ownerId: "usr_ana",
      channelId: "ch_general",
      status: "active",
      startedAt: at,
      runningJobs: 1,
    });
    paper.plan = {
      done: 1,
      passed: 1,
      total: 2,
      version: 2,
      waiting: 0,
      items: [
        this.item("it_count", "Count what is left", "done", true),
        this.item("it_order", "Order what is missing", "doing", null),
      ],
    };
    paper.people = [{ userId: "usr_jonas", role: "decide" }];
    paper.decisions = [
      {
        id: "dec_supplier",
        blocking: true,
        chosen: null,
        impact: "Delivery in two days or five.",
        messageId: null,
        opinions: [],
        options: ["Northpaper", "Mill & Co"],
        question: "Which supplier?",
        recommendation: "Northpaper",
        selectedAt: null,
        selectedBy: null,
        status: "pending",
        why: "Cheaper this month.",
      },
    ];
    paper.submissions = [
      {
        id: "sub_1",
        auto: false,
        changesNote: null,
        checklist: [
          { id: "chk_a", text: "Every printer counted", verifiedBy: null },
          { id: "chk_b", text: "Order placed", verifiedBy: null },
        ],
        createdAt: at,
        fileIds: [],
        note: "Counted all **six** printers and ordered the rest.",
        status: "pending",
      },
    ];
    paper.commands = [
      {
        id: "cmd_1",
        always: false,
        command: "lpstat -p",
        createdAt: at,
        jobId: "job_1",
        rules: [],
        state: "pending",
        tool: "shell",
      },
    ];
    paper.events = [
      { actor: { type: "person", id: "usr_ana" }, at, data: {}, itemId: null, kind: "started", seq: 1 },
      { actor: agent, at, data: {}, itemId: "it_count", kind: "item_done", seq: 2 },
      { actor: agent, at, data: {}, itemId: null, kind: "decision_asked", seq: 3 },
    ];
    paper.pending = { ...NO_PENDING, decisions: 1, submissions: 1, commands: 1 };
    const old = this.make("workspace_birchwood", {
      id: "asg_old",
      title: "Archive last year's jobs",
      goal: "The job archive is in Files.",
      agentId: "agt_ledger",
      ownerId: "usr_ana",
      channelId: "ch_print",
      status: "done",
      closedAt: at,
      outcome: "done",
    });
    this.assignments = [paper, old];
  }

  private item(
    id: string,
    title: string,
    status: T.PlanItemStatus,
    passes: boolean | null,
  ): T.AssignmentPlanItem {
    const at = this.host.now().toISOString();
    const agent = { type: "agent" as const, id: "agt_scout" };
    return {
      id,
      createdBy: agent,
      criteria: "",
      fixes: null,
      kind: "work",
      milestone: null,
      passes,
      stallReason: null,
      state: status === "done" ? "done" : "running",
      status,
      summary: null,
      title,
      updatedAt: at,
      updatedBy: agent,
      verdict: null,
      verifiedAt: null,
    } as T.AssignmentPlanItem;
  }

  make(
    workspaceId: string,
    fields: Partial<Stored> & Pick<Stored, "id" | "title" | "goal" | "agentId" | "ownerId" | "channelId">,
  ): Stored {
    const at = this.host.now().toISOString();
    return {
      workspaceId,
      ceiling: null,
      checkoutPath: null,
      closedAt: null,
      commandPolicy: "when_safe",
      createdAt: at,
      dueAt: null,
      executor: "agent",
      findings: [],
      lastTouchedAt: at,
      limits: { dollars: null, minutes: null, steps: null },
      needsEnvironment: false,
      outcome: null,
      overdue: false,
      pausedAt: null,
      pending: { ...NO_PENDING },
      pendingJoin: false,
      pendingQuestion: null,
      plan: { done: 0, items: [], passed: 0, total: 0, version: 0, waiting: 0 },
      resumeJobs: false,
      runner: null,
      runningJobs: 0,
      stale: false,
      startedAt: null,
      state: "running",
      status: "proposed",
      threadId: `thr_${fields.id}`,
      unseen: 0,
      usage: { dollars: 0.42, jobTokens: 0, minutes: 12, steps: 7, unmeasuredJobs: 0 },
      waitReason: null,
      wakeAt: null,
      people: [],
      requests: [],
      decisions: [],
      submissions: [],
      reviews: [],
      commands: [],
      events: [],
      seen: new Map(),
      ...fields,
    } as Stored;
  }

  private roleOf(scope: Scope, row: Stored): T.AssignmentRole {
    if (row.ownerId === scope.user.id) return "owner";
    return row.people.find((person) => person.userId === scope.user.id)?.role ?? "view";
  }

  private view(scope: Scope, row: Stored): T.Assignment {
    const {
      workspaceId: _w,
      people: _p,
      requests,
      decisions: _d,
      submissions: _s,
      reviews: _r,
      commands: _c,
      events,
      seen,
      ...rest
    } = row;
    const role = this.roleOf(scope, row);
    const last = events.reduce((most, event) => Math.max(most, event.seq), 0);
    return {
      ...rest,
      role,
      actionable: role === "owner" || role === "decide",
      manageable: role === "owner" || scope.role !== "member",
      pendingJoin: requests.some(
        (request) => request.userId === scope.user.id && request.status === "pending",
      ),
      unseen: last - (seen.get(scope.user.id) ?? 0),
    };
  }

  private log(row: Stored, scope: Scope, kind: T.AssignmentEventKind) {
    const seq = row.events.reduce((most, event) => Math.max(most, event.seq), 0) + 1;
    row.events.push({
      actor: { type: "person", id: scope.user.id },
      at: this.host.now().toISOString(),
      data: {},
      itemId: null,
      kind,
      seq,
    });
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const withOne = (
      handler: (scope: Scope, row: Stored, params: Record<string, unknown>) => FilesReply,
      need?: "act" | "manage",
    ) =>
      within((scope, params) => {
        const row = this.assignments.find(
          (each) =>
            each.id === params.assignmentId &&
            each.workspaceId === scope.workspaceId &&
            this.host.readsChannel(scope.user.id, each.channelId),
        );
        if (row === undefined) return missing();
        const shown = this.view(scope, row);
        if (need === "act" && !shown.actionable)
          return fail(403, "forbidden", "Only the owner and who decides can act");
        if (need === "manage" && !shown.manageable)
          return fail(403, "forbidden", "Only the owner manages the people");
        return handler(scope, row, params);
      });
    const answer = (scope: Scope, row: Stored, status = 200) => reply(status, this.view(scope, row));
    const closed = (row: Stored) => row.status === "done" || row.status === "canceled";

    return {
      listAssignments: within((scope, params) => {
        const visible = this.assignments.filter(
          (row) =>
            row.workspaceId === scope.workspaceId && this.host.readsChannel(scope.user.id, row.channelId),
        );
        const q = text(params.q)?.toLowerCase() ?? "";
        const waitsOn = (row: Stored) =>
          Object.values(row.pending).some((count) => count > 0) && this.view(scope, row).actionable;
        const counts = {
          active: visible.filter((row) => !closed(row)).length,
          closed: visible.filter(closed).length,
          blockedOnYou: visible.filter((row) => !closed(row) && waitsOn(row)).length,
        };
        const status = text(params.status) ?? "open";
        const shown = visible
          .filter((row) =>
            status === "closed"
              ? closed(row)
              : status === "blocked_on_you"
                ? !closed(row) && waitsOn(row)
                : !closed(row),
          )
          .filter(
            (row) => q === "" || row.title.toLowerCase().includes(q) || row.goal.toLowerCase().includes(q),
          );
        return reply(200, { assignments: shown.map((row) => this.view(scope, row)), counts });
      }),
      listAssignmentEligibleAgents: within((scope) =>
        reply(200, {
          agents: this.host.agents(scope.workspaceId).map((agent) => ({
            agentId: agent.id,
            executors: ["agent"],
            manageable: true,
            qualifies: agent.reachable,
            reason: null,
            runner: null,
          })),
        }),
      ),
      createAssignment: within((scope, params) => {
        const goal = text(params.goal)?.trim() ?? "";
        if (goal === "") return fail(400, "invalid_request", "A goal is needed");
        const channelId = text(params.channelId) ?? "";
        if (!this.host.readsChannel(scope.user.id, channelId))
          return fail(404, "not_found", "Channel not found");
        const row = this.make(scope.workspaceId, {
          id: this.host.id("asg"),
          title: text(params.title)?.trim() || goal.slice(0, 60),
          goal,
          agentId: text(params.agentId) ?? "",
          ownerId: scope.user.id,
          channelId,
          commandPolicy: (params.commandPolicy as T.CommandPolicy | undefined) ?? "when_safe",
        });
        this.assignments.push(row);
        return answer(scope, row, 201);
      }),
      getAssignment: withOne((scope, row) => answer(scope, row)),
      runActionOnAssignment: withOne((scope, row, params) => {
        const action = text(params.action);
        if (action === "start" && row.status === "proposed") {
          row.status = "active";
          this.log(row, scope, "started");
        } else if (action === "pause" && row.status === "active") {
          row.status = "paused";
          this.log(row, scope, "paused");
        } else if (action === "resume" && row.status === "paused") {
          row.status = "active";
          this.log(row, scope, "resumed");
        } else if (action === "stop") {
          const canceledJobs = row.runningJobs;
          row.runningJobs = 0;
          return reply(200, { ...this.view(scope, row), canceledJobs });
        } else return fail(409, "assignment.state", "Not in this state");
        return answer(scope, row);
      }, "act"),
      closeAssignment: withOne((scope, row, params) => {
        row.status = params.outcome === "canceled" ? "canceled" : "done";
        row.outcome = row.status;
        row.closedAt = this.host.now().toISOString();
        row.runningJobs = 0;
        this.log(row, scope, "closed");
        return answer(scope, row);
      }, "act"),
      getAssignmentSummary: withOne((_scope, row) =>
        reply(200, {
          plan: {
            done: row.plan.done,
            total: row.plan.total,
            inProgress: row.plan.items.filter((item) => item.status === "doing").length,
            waiting: row.plan.waiting,
          },
          running: row.runningJobs,
          pendingDecisions: row.pending.decisions,
          provisionalDecisions: row.pending.provisional,
          pendingReviews: row.pending.reviews,
        }),
      ),
      getAssignmentPlan: withOne((_scope, row) =>
        reply(200, {
          current: row.plan.items.length === 0 ? null : { version: row.plan.version, items: row.plan.items },
        }),
      ),
      retryAssignmentItem: withOne((_scope, row, params) => {
        const item = row.plan.items.find((each) => each.id === params.itemId);
        return item === undefined ? fail(404, "not_found", "Item not found") : reply(200, item);
      }, "act"),
      listAssignmentEvents: withOne((scope, row) => {
        const lastSeq = row.events.reduce((most, event) => Math.max(most, event.seq), 0);
        return reply(200, {
          events: [...row.events].sort((a, b) => b.seq - a.seq),
          seenSeq: row.seen.get(scope.user.id) ?? 0,
          lastSeq,
        });
      }),
      markAssignmentSeen: withOne((scope, row, params) => {
        row.seen.set(scope.user.id, Number(params.seq) || 0);
        return reply(200, { seenSeq: row.seen.get(scope.user.id) ?? 0 });
      }),
      listAssignmentDecisions: withOne((_scope, row) => reply(200, { decisions: row.decisions })),
      chooseAssignmentDecision: withOne((scope, row, params) => {
        const decision = row.decisions.find((each) => each.id === params.decisionId);
        if (decision === undefined) return fail(404, "not_found", "Decision not found");
        decision.status = "taken";
        decision.chosen = text(params.option) ?? null;
        decision.selectedBy = scope.user.id;
        row.pending.decisions = Math.max(0, row.pending.decisions - 1);
        return reply(200, decision);
      }, "act"),
      opinionAssignmentDecision: withOne((scope, row, params) => {
        const decision = row.decisions.find((each) => each.id === params.decisionId);
        if (decision === undefined) return fail(404, "not_found", "Decision not found");
        decision.opinions.push({
          at: this.host.now().toISOString(),
          option: text(params.option) ?? "",
          userId: scope.user.id,
        });
        return reply(200, decision);
      }),
      approveAssignmentDecisionProvisional: withOne(
        (_scope, row) => reply(200, { decisions: row.decisions }),
        "act",
      ),
      listAssignmentSubmissions: withOne((_scope, row) => reply(200, row.submissions)),
      replaceAssignmentSubmissionChecklist: withOne((scope, row, params) => {
        const submission = row.submissions.find((each) => each.id === params.submissionId);
        const item = submission?.checklist.find((each) => each.id === params.itemId);
        if (submission === undefined || item === undefined) return fail(404, "not_found", "Not found");
        item.verifiedBy = params.checked === true ? scope.user.id : null;
        return reply(200, submission);
      }, "act"),
      acceptAssignmentSubmission: withOne((scope, row, params) => {
        const submission = row.submissions.find((each) => each.id === params.submissionId);
        if (submission === undefined) return fail(404, "not_found", "Submission not found");
        submission.status = "accepted";
        row.status = "done";
        row.outcome = "done";
        row.pending.submissions = 0;
        this.log(row, scope, "closed");
        return answer(scope, row);
      }, "act"),
      requestAssignmentSubmissionChanges: withOne((scope, row, params) => {
        const submission = row.submissions.find((each) => each.id === params.submissionId);
        if (submission === undefined) return fail(404, "not_found", "Submission not found");
        submission.status = "changes_requested";
        submission.changesNote = text(params.note) ?? "";
        row.pending.submissions = 0;
        return answer(scope, row);
      }, "act"),
      listAssignmentReviews: withOne((_scope, row) => reply(200, { reviews: row.reviews })),
      runActionOnAssignmentReview: withOne((scope, row, params) => {
        const review = row.reviews.find((each) => each.id === params.reviewId);
        if (review === undefined) return fail(404, "not_found", "Review not found");
        review.status = params.action === "approve" ? "approved" : "changes_requested";
        review.note = text(params.note) ?? null;
        review.decidedBy = scope.user.id;
        return reply(200, review);
      }, "act"),
      listAssignmentCommands: withOne((_scope, row) => reply(200, { commands: row.commands, rules: [] })),
      decideAssignmentCommand: withOne((_scope, row, params) => {
        const command = row.commands.find((each) => each.id === params.commandId);
        if (command === undefined) return fail(404, "not_found", "Command not found");
        command.state = params.decision === "deny" ? "denied" : "allowed";
        row.pending.commands = Math.max(0, row.pending.commands - 1);
        return reply(200, command);
      }, "act"),
      retryAssignmentCommand: withOne(() => reply(200, { rules: [], delivered: true }), "act"),
      listAssignmentParticipants: withOne((_scope, row) =>
        reply(200, {
          owner: { userId: row.ownerId, name: this.host.nameOf(row.ownerId) },
          participants: row.people.map((person) => ({ ...person, name: this.host.nameOf(person.userId) })),
        }),
      ),
      updateAssignmentParticipant: withOne((_scope, row, params) => {
        const person = row.people.find((each) => each.userId === params.participantId);
        if (person === undefined) return fail(404, "not_found", "Not a participant");
        person.role = params.role === "decide" ? "decide" : "comment";
        return reply(200, {
          owner: { userId: row.ownerId, name: this.host.nameOf(row.ownerId) },
          participants: row.people.map((each) => ({ ...each, name: this.host.nameOf(each.userId) })),
        });
      }, "manage"),
      deleteAssignmentParticipant: withOne((scope, row, params) => {
        if (params.participantId !== scope.user.id && !this.view(scope, row).manageable)
          return fail(403, "forbidden", "Forbidden");
        row.people = row.people.filter((each) => each.userId !== params.participantId);
        return reply(204, null);
      }),
      listAssignmentJoinRequests: withOne((_scope, row) => reply(200, { requests: row.requests }), "manage"),
      createAssignmentJoinRequest: withOne((scope, row) => {
        const request: T.AssignmentJoinRequest = {
          createdAt: this.host.now().toISOString(),
          name: scope.user.name,
          role: null,
          status: "pending",
          userId: scope.user.id,
        };
        row.requests.push(request);
        return reply(200, request);
      }),
      runActionOnAssignmentJoinRequest: withOne((_scope, row, params) => {
        const request = row.requests.find((each) => each.userId === params.joinRequestId);
        if (request === undefined) return fail(404, "not_found", "Request not found");
        request.status = params.action === "accept" ? "accepted" : "declined";
        if (request.status === "accepted")
          row.people.push({ userId: request.userId, role: params.role === "decide" ? "decide" : "comment" });
        return reply(200, request);
      }, "manage"),
      listAssignmentFiles: withOne(() =>
        reply(200, {
          files: [
            {
              name: "assignment.md",
              content: "# Paper\nSix printers.",
              updatedAt: this.host.now().toISOString(),
              writtenAt: null,
            },
          ],
          editedOnRunner: [],
        }),
      ),
    };
  }
}
