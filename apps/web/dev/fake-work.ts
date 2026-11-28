// Issues for the fake server: the board's columns, the issues with their criteria and timeline, and
// handing one to an agent. The answers follow the server's rules: an issue of a private channel the
// caller isn't in is a missing one, a title and a comment have their limits, and only an agent the
// caller may talk to is handed an issue. Never part of the production build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type Scope = { workspaceId: string; user: T.User; role: T.Role };
type Host = FilesHost & {
  /** The workspace's agents, as the caller sees them (with `reachable`). */
  agents: (workspaceId: string, userId: string) => T.Agent[];
  /** Whether the person reads the channel (public, or one they are in). */
  readsChannel: (userId: string, channelId: string) => boolean;
};
export type FakeIssue = T.Issue & { workspaceId: string };
type FakeColumn = T.IssueColumn & { workspaceId: string };
type FakeActivity = T.IssueActivity & { issueId: string };

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const missing = () => fail(404, "not_found", "Issue not found");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const STAGES: T.IssueStage[] = ["todo", "in_progress", "reviewing", "done", "canceled"];

export class FakeWork {
  columns: FakeColumn[] = [];
  issues: FakeIssue[] = [];
  activity: FakeActivity[] = [];

  constructor(private readonly host: Host) {}

  clear(): void {
    this.columns = [];
    this.issues = [];
    this.activity = [];
  }

  /** The board every workspace starts with: one column per stage, named after it. */
  private board(workspaceId: string): FakeColumn[] {
    let own = this.columns.filter((column) => column.workspaceId === workspaceId);
    if (own.length === 0) {
      own = STAGES.map((stage, position) => ({
        id: `col_${workspaceId}_${stage}`,
        workspaceId,
        name: "",
        position,
        stage,
      }));
      this.columns.push(...own);
    }
    return own.sort((a, b) => a.position - b.position);
  }

  seed(): void {
    this.clear();
    const ws = "workspace_birchwood";
    const cols = this.board(ws);
    const col = (stage: T.IssueStage) => cols.find((column) => column.stage === stage)?.id ?? "";
    const ana: T.ActorRef = { type: "person", id: "usr_ana" };
    this.add(ws, {
      title: "Reprint the spring catalogue",
      description: "The paper stock changed. Check the proofs before **Friday**.",
      criteria: [
        { id: "crit_proofs", text: "Proofs approved", done: true },
        { id: "crit_order", text: "Paper ordered", done: false },
      ],
      columnId: col("todo"),
      priority: "high",
      assignee: { type: "person", id: "usr_jonas" },
      createdBy: ana,
    });
    this.add(ws, {
      title: "Draft the release notes",
      columnId: col("in_progress"),
      assignee: { type: "agent", id: "agt_scout" },
      createdBy: ana,
      work: { state: "working", reason: null, runId: null },
    });
    this.add(ws, {
      title: "Archive the old invoices",
      columnId: col("done"),
      createdBy: ana,
      priority: "low",
    });
  }

  private add(
    workspaceId: string,
    fields: Partial<T.Issue> & Pick<T.Issue, "title" | "columnId" | "createdBy">,
  ) {
    const at = this.host.now().toISOString();
    const number =
      Math.max(0, ...this.issues.filter((i) => i.workspaceId === workspaceId).map((i) => i.number)) + 1;
    const top = Math.min(
      1024,
      ...this.issues.filter((i) => i.columnId === fields.columnId).map((i) => i.boardPosition),
    );
    const issue: FakeIssue = {
      id: this.host.id("iss"),
      workspaceId,
      number,
      assignee: null,
      boardPosition: top - 1024,
      channelId: null,
      createdAt: at,
      criteria: [],
      debates: [],
      description: "",
      dueDate: null,
      files: [],
      labels: [],
      priority: "none",
      pullRequests: [],
      source: { kind: "manual" },
      status: "todo",
      subIssues: [],
      updatedAt: at,
      work: null,
      ...fields,
    };
    issue.status = this.stageOf(issue.columnId);
    this.issues.push(issue);
    this.log(issue, fields.createdBy, "created", "created the issue");
    return issue;
  }

  private stageOf(columnId: string): T.IssueStage {
    return this.columns.find((column) => column.id === columnId)?.stage ?? "todo";
  }

  private log(
    issue: FakeIssue,
    author: T.ActorRef,
    event: string,
    said: string,
    vars?: Record<string, string>,
  ) {
    this.activity.push({
      id: this.host.id("iact"),
      issueId: issue.id,
      attachments: [],
      author,
      auto: false,
      createdAt: this.host.now().toISOString(),
      event,
      kind: "event",
      text: said,
      textKey: `issues.activity.${event}`,
      textVars: vars ?? null,
    });
  }

  private sees(scope: Scope, issue: FakeIssue): boolean {
    return (
      issue.workspaceId === scope.workspaceId &&
      (issue.channelId === null || this.host.readsChannel(scope.user.id, issue.channelId))
    );
  }

  private view(issue: FakeIssue): T.Issue {
    const { workspaceId: _, ...rest } = issue;
    return { ...rest, status: this.stageOf(issue.columnId) };
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (handler: (scope: Scope, params: Record<string, unknown>) => FilesReply) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const withIssue = (
      handler: (scope: Scope, issue: FakeIssue, params: Record<string, unknown>) => FilesReply,
    ) =>
      within((scope, params) => {
        const issue = this.issues.find((each) => each.id === params.issueId);
        return issue === undefined || !this.sees(scope, issue) ? missing() : handler(scope, issue, params);
      });
    const me = (scope: Scope): T.ActorRef => ({ type: "person", id: scope.user.id });
    const talks = (scope: Scope, agentId: string) =>
      this.host
        .agents(scope.workspaceId, scope.user.id)
        .find((agent) => agent.id === agentId && agent.reachable);

    return {
      listIssueColumns: within((scope) =>
        reply(200, { columns: this.board(scope.workspaceId).map(({ workspaceId: _, ...c }) => c) }),
      ),
      listIssues: within((scope, params) => {
        this.board(scope.workspaceId);
        const q = text(params.q)?.trim().replace(/^#/, "").toLowerCase() ?? "";
        const found = this.issues
          .filter((issue) => this.sees(scope, issue))
          .filter(
            (issue) =>
              q === "" ||
              issue.title.toLowerCase().includes(q) ||
              issue.description.toLowerCase().includes(q) ||
              String(issue.number).includes(q),
          )
          .sort((a, b) => a.boardPosition - b.boardPosition || b.number - a.number);
        return reply(200, { issues: found.map((issue) => this.view(issue)) });
      }),
      getIssueBySeq: within((scope, params) => {
        const issue = this.issues.find(
          (each) => String(each.number) === params.issueSeq && this.sees(scope, each),
        );
        return issue === undefined ? missing() : reply(200, this.view(issue));
      }),
      createIssue: within((scope, params) => {
        const title = text(params.title)?.trim() ?? "";
        if (title === "" || title.length > 300)
          return fail(400, "invalid_request", "A title of 1 to 300 characters");
        const cols = this.board(scope.workspaceId);
        const column =
          cols.find((each) => each.id === params.columnId) ?? cols.find((each) => each.stage === "todo");
        if (column === undefined) return fail(404, "not_found", "Column not found");
        const assignee = (params.assignee as T.ActorRef | null | undefined) ?? null;
        if (assignee?.type === "agent" && talks(scope, assignee.id) === undefined) {
          return fail(403, "forbidden", "You can't talk to this agent");
        }
        const criteria = Array.isArray(params.criteria) ? params.criteria.map(String) : [];
        const issue = this.add(scope.workspaceId, {
          title,
          description: text(params.description) ?? "",
          criteria: criteria.map((each) => ({ id: this.host.id("crit"), text: each, done: false })),
          columnId: column.id,
          priority: (params.priority as T.IssuePriority | undefined) ?? "none",
          assignee,
          createdBy: me(scope),
          ...(assignee?.type === "agent" && { work: { state: "working", reason: null, runId: null } }),
        });
        return reply(201, this.view(issue));
      }),
      updateIssue: withIssue((scope, issue, params) => {
        const by = me(scope);
        if (typeof params.title === "string") issue.title = params.title;
        if (typeof params.description === "string") issue.description = params.description;
        if (typeof params.columnId === "string" && params.columnId !== issue.columnId) {
          const from = this.stageOf(issue.columnId);
          if (!this.columns.some((column) => column.id === params.columnId)) {
            return fail(404, "not_found", "Column not found");
          }
          issue.columnId = params.columnId;
          const to = this.stageOf(issue.columnId);
          if (from !== to) this.log(issue, by, "status", `moved from ${from} to ${to}`, { from, to });
        }
        if (typeof params.boardPosition === "number") issue.boardPosition = params.boardPosition;
        if ("assignee" in params) {
          issue.assignee = (params.assignee as T.ActorRef | null) ?? null;
          if (issue.assignee === null) this.log(issue, by, "unassigned", "removed the assignee");
          else this.log(issue, by, "assigned", "changed the assignee", { ...issue.assignee });
        }
        if (typeof params.priority === "string") {
          const from = issue.priority;
          issue.priority = params.priority as T.IssuePriority;
          this.log(issue, by, "priority", `set priority to ${issue.priority}`, { from, to: issue.priority });
        }
        if ("dueDate" in params) {
          issue.dueDate = (params.dueDate as string | null) ?? null;
          this.log(issue, by, "due", "changed the due date", { date: issue.dueDate ?? "" });
        }
        issue.status = this.stageOf(issue.columnId);
        issue.updatedAt = this.host.now().toISOString();
        return reply(200, this.view(issue));
      }),
      replaceIssueCriterion: withIssue((scope, issue, params) => {
        const criterion = issue.criteria.find((each) => each.id === params.criterionId);
        if (criterion === undefined) return fail(404, "not_found", "Criterion not found");
        criterion.done = params.done === true;
        this.log(issue, me(scope), criterion.done ? "criterion_done" : "criterion_undone", "", {
          text: criterion.text,
        });
        return reply(200, this.view(issue));
      }),
      getIssueActivity: withIssue((_scope, issue) =>
        reply(200, {
          activity: this.activity
            .filter((each) => each.issueId === issue.id)
            .map(({ issueId: _, ...rest }) => rest),
        }),
      ),
      createIssueComment: withIssue((scope, issue, params) => {
        const said = text(params.text)?.trim() ?? "";
        if (said === "" || said.length > 20_000)
          return fail(400, "invalid_request", "A comment of 1 to 20000 characters");
        const entry: FakeActivity = {
          id: this.host.id("iact"),
          issueId: issue.id,
          attachments: [],
          author: me(scope),
          auto: false,
          createdAt: this.host.now().toISOString(),
          event: null,
          kind: "comment",
          text: said,
          textKey: null,
          textVars: null,
        };
        this.activity.push(entry);
        const { issueId: _, ...shown } = entry;
        return reply(201, shown);
      }),
      askIssueAgent: withIssue((scope, issue, params) => {
        const agent = talks(scope, text(params.agentId) ?? "");
        if (agent === undefined) return fail(403, "forbidden", "You can't talk to this agent");
        issue.assignee = { type: "agent", id: agent.id };
        const working = this.columns.find(
          (c) => c.workspaceId === scope.workspaceId && c.stage === "in_progress",
        );
        if (this.stageOf(issue.columnId) === "todo" && working !== undefined) issue.columnId = working.id;
        issue.work = { state: "working", reason: null, runId: null };
        this.log(issue, me(scope), "assigned", "changed the assignee", { type: "agent", id: agent.id });
        return reply(200, this.view(issue));
      }),
    };
  }
}
