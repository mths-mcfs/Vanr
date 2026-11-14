// The workspace's issues: a short number per workspace, a board with columns by stage, acceptance criteria,
// a timeline (comments and events) and notices for whoever is assigned or opened the issue.
import type { ActorRef, Issue, IssueActivity, IssueColumn, IssueStage } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, eq, inArray, max, min, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "./context";
import { notFound } from "./http";
import { notify } from "./notifications";
import { reindex } from "./search-index";

const { issues, boardColumns, issueTimeline, debates, messages, channels } = schema;
export type IssueRow = typeof issues.$inferSelect;
type ColumnRow = typeof boardColumns.$inferSelect;
type TimelineValues = typeof issueTimeline.$inferInsert;

export const STAGES = [
  "todo",
  "in_progress",
  "reviewing",
  "done",
  "canceled",
] as const satisfies readonly IssueStage[];

export const toColumn = (r: ColumnRow): IssueColumn => ({
  id: r.id,
  name: r.name,
  stage: r.stage,
  position: r.position,
});

/** The workspace's columns in board order. A new workspace gets one column per stage (empty name = the stage's name). */
export async function columnsOf(db: Db, workspaceId: string): Promise<ColumnRow[]> {
  const list = () =>
    db
      .select()
      .from(boardColumns)
      .where(eq(boardColumns.workspaceId, workspaceId))
      .orderBy(asc(boardColumns.position));
  const rows = await list();
  if (rows.length > 0) return rows;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`board-columns:${workspaceId}`}))`);
    const [any] = await tx
      .select({ id: boardColumns.id })
      .from(boardColumns)
      .where(eq(boardColumns.workspaceId, workspaceId))
      .limit(1);
    if (any) return;
    await tx
      .insert(boardColumns)
      .values(
        STAGES.map((stage, position) => ({ id: newId("col"), workspaceId, name: "", stage, position })),
      );
  });
  return list();
}

/** Renumbers the positions and keeps the columns grouped in the order of the stages. */
export async function saveColumnOrder(db: Db, ordered: ColumnRow[]): Promise<void> {
  const sorted = [...ordered].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  for (const [i, col] of sorted.entries()) {
    if (col.position !== i)
      await db.update(boardColumns).set({ position: i }).where(eq(boardColumns.id, col.id));
  }
}

export function publishColumns(deps: AppDeps, workspaceId: string, rows: ColumnRow[]) {
  deps.hub.toWorkspace(workspaceId, { type: "issue_column.list_updated", columns: rows.map(toColumn) });
}

export async function issueById(db: Db, workspaceId: string, id: string): Promise<IssueRow> {
  const [row] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, id), eq(issues.workspaceId, workspaceId)));
  if (!row) throw notFound("Issue not found");
  return row;
}

export async function issueByNumber(db: Db, workspaceId: string, number: number): Promise<IssueRow> {
  const [row] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.number, number), eq(issues.workspaceId, workspaceId)));
  if (!row) throw notFound("Issue not found");
  return row;
}

/** What the issue says it came from, as saved (`source`): only the kinds the contract knows reach the API. */
const issueSource = z.object({
  kind: z.enum(["agent", "debate", "manual", "message"]),
  id: z.string().optional(),
});
/** The agent's work on the issue, as saved (`work`). */
const savedWork = z.object({
  state: z.enum(["blocked", "idle", "working"]),
  reason: z.string().nullable(),
  runId: z.string().nullable(),
});
/** The debate's origin, as saved: only the issue it was opened from matters here. */
const debateOrigin = z.object({ issueId: z.string() });

/** The issues in the API's shape, with the stage, the sub-issues and the linked debates. */
export async function toIssues(db: Db, workspaceId: string, rows: IssueRow[]): Promise<Issue[]> {
  if (rows.length === 0) return [];
  const cols = new Map((await columnsOf(db, workspaceId)).map((c) => [c.id, c]));
  const ids = rows.map((r) => r.id);
  const children = await db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      columnId: issues.columnId,
      parentId: issues.parentId,
    })
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), inArray(issues.parentId, ids)));
  const linked = await db
    .select({
      id: debates.id,
      title: debates.title,
      issueIds: debates.issueIds,
      origin: debates.origin,
    })
    .from(debates)
    .where(
      and(
        eq(debates.workspaceId, workspaceId),
        sql`(jsonb_array_length(${debates.issueIds}) > 0 or ${debates.origin}->>'issueId' is not null)`,
        // The whole workspace sees the issue (and it goes to everyone over the socket): a debate of a private
        // channel doesn't show on it, not even its title.
        sql`(${debates.channelId} is null or ${debates.channelId} in (
          select ${channels.id} from ${channels}
          where ${channels.kind} = 'channel' and ${channels.visibility} = 'public'))`,
      ),
    );
  const originIssue = (origin: unknown) => {
    const parsed = debateOrigin.safeParse(origin);
    return parsed.success ? parsed.data.issueId : null;
  };
  const stageOf = (columnId: string): IssueStage => cols.get(columnId)?.stage ?? "todo";
  return rows.map((r) => {
    const source = issueSource.safeParse(r.source);
    const work = savedWork.safeParse(r.work);
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      description: r.description,
      criteria: r.criteria,
      status: stageOf(r.columnId),
      columnId: r.columnId,
      boardPosition: r.boardPosition,
      priority: r.priority,
      assignee: r.assignee ?? null,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      dueDate: r.dueDate,
      labels: r.labels,
      source: source.success ? source.data : null,
      channelId: r.channelId,
      pullRequests: r.pullRequests,
      files: r.fileIds,
      subIssues: children
        .filter((ch) => ch.parentId === r.id)
        .map((ch) => ({ id: ch.id, number: ch.number, title: ch.title, status: stageOf(ch.columnId) })),
      debates: linked
        .filter((d) => d.issueIds.includes(r.id) || originIssue(d.origin) === r.id)
        .map((d) => ({ id: d.id, title: d.title })),
      work: work.success ? work.data : null,
    };
  });
}

export async function toIssue(db: Db, row: IssueRow): Promise<Issue> {
  const [issue] = await toIssues(db, row.workspaceId, [row]);
  if (!issue) throw new Error("toIssues returned nothing");
  return issue;
}

export function toActivity(r: typeof issueTimeline.$inferSelect): IssueActivity {
  return {
    id: r.id,
    kind: r.kind,
    event: r.event,
    textKey: r.textKey,
    textVars: r.textVars ?? null,
    text: r.text,
    author: r.author,
    createdAt: r.createdAt.toISOString(),
    auto: r.auto,
    attachments: r.attachments,
  };
}

interface TimelineEvent {
  issueId: string;
  author: ActorRef;
  event: string;
  text: string;
  vars?: Record<string, string | number>;
  auto?: boolean;
}

const eventValues = (at: Date, input: TimelineEvent): TimelineValues => ({
  id: newId("iact"),
  issueId: input.issueId,
  kind: "event",
  event: input.event,
  textKey: `issues.activity.${input.event}`,
  textVars: input.vars ?? null,
  text: input.text,
  author: input.author,
  auto: input.auto ?? false,
  createdAt: at,
});

/** An event on the timeline: a translatable key and its variables, with the English text as the fallback. */
export async function logEvent(deps: AppDeps, input: TimelineEvent) {
  await deps.db.insert(issueTimeline).values(eventValues(deps.now(), input));
}

interface NewIssue {
  workspaceId: string;
  title: string;
  description?: string;
  criteria?: string[];
  assignee?: ActorRef | null;
  priority?: IssueRow["priority"];
  dueDate?: string | null;
  labels?: string[];
  columnId?: string;
  channelId?: string | null;
  parentId?: string | null;
  source?: Issue["source"];
  author: ActorRef;
}

/**
 * Creates the issue with the workspace's next number, on top of its column. The number and the position are
 * read and written under the workspace's lock (one transaction), so issues created at the same time get
 * numbers one after another, without a repeat or a hole; a creation that fails takes no number.
 */
export async function createIssue(deps: AppDeps, input: NewIssue): Promise<IssueRow> {
  const { db } = deps;
  const cols = await columnsOf(db, input.workspaceId);
  const column = input.columnId
    ? cols.find((c) => c.id === input.columnId)
    : cols.find((c) => c.stage === "todo");
  if (!column) throw notFound("Column not found");
  const at = deps.now();
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue-number:${input.workspaceId}`}))`);
    const [top] = await tx
      .select({ n: max(issues.number) })
      .from(issues)
      .where(eq(issues.workspaceId, input.workspaceId));
    const [first] = await tx
      .select({ p: min(issues.boardPosition) })
      .from(issues)
      .where(eq(issues.columnId, column.id));
    const [inserted] = await tx
      .insert(issues)
      .values({
        id: newId("iss"),
        workspaceId: input.workspaceId,
        number: (top?.n ?? 0) + 1,
        title: input.title,
        description: input.description ?? "",
        criteria: (input.criteria ?? []).map((text) => ({ id: newId("crit"), text, done: false })),
        columnId: column.id,
        boardPosition: (first?.p ?? 1) - 1,
        priority: input.priority ?? "none",
        assignee: input.assignee ?? null,
        createdBy: input.author,
        dueDate: input.dueDate ?? null,
        labels: input.labels ?? [],
        source: input.source ?? null,
        channelId: input.channelId ?? null,
        parentId: input.parentId ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!inserted) throw new Error("issue insert returned nothing");
    await tx.insert(issueTimeline).values(
      eventValues(at, {
        issueId: inserted.id,
        author: input.author,
        event: "created",
        text: "created the issue",
      }),
    );
    return inserted;
  });
  if (row.assignee) await notifyAssigned(deps, row, input.author);
  await reindex(deps, { kind: "issue", id: row.id });
  return row;
}

const noticeSource = (row: IssueRow) => ({ issueId: row.id, issueSeq: row.number, label: `#${row.number}` });

async function notifyAssigned(deps: AppDeps, row: IssueRow, by: ActorRef) {
  const a = row.assignee;
  if (a?.type !== "person" || (by.type === "person" && by.id === a.id)) return;
  await notify(deps, {
    workspaceId: row.workspaceId,
    userId: a.id,
    kind: "issue_ownership",
    groupKey: `issue_ownership:${row.id}`,
    actor: by,
    source: noticeSource(row),
    latest: { title: row.title },
  });
}

/** Who follows the issue: the assignee and whoever opened it (people), minus whoever made the change. */
function watchers(row: IssueRow, by: ActorRef): string[] {
  const out = new Set<string>();
  for (const a of [row.assignee, row.createdBy]) if (a?.type === "person") out.add(a.id);
  if (by.type === "person") out.delete(by.id);
  return [...out];
}

export async function notifyComment(deps: AppDeps, row: IssueRow, by: ActorRef, text: string) {
  for (const userId of watchers(row, by)) {
    await notify(deps, {
      workspaceId: row.workspaceId,
      userId,
      kind: "issue_discussion",
      groupKey: `issue_discussion:${row.id}`,
      actor: by,
      source: noticeSource(row),
      latest: { title: row.title, text: text.length > 160 ? `${text.slice(0, 159)}…` : text },
    });
  }
}

async function notifyProgress(deps: AppDeps, row: IssueRow, by: ActorRef, from: IssueStage, to: IssueStage) {
  for (const userId of watchers(row, by)) {
    await notify(deps, {
      workspaceId: row.workspaceId,
      userId,
      kind: "issue_progress",
      groupKey: `issue_progress:${row.id}`,
      actor: by,
      source: noticeSource(row),
      latest: { title: row.title, previousStatus: from, newStatus: to },
    });
  }
}

export interface IssueChange {
  title?: string;
  description?: string;
  columnId?: string;
  boardPosition?: number;
  assignee?: ActorRef | null;
  priority?: IssueRow["priority"];
  dueDate?: string | null;
  labels?: string[];
  pullRequests?: string[];
  fileIds?: string[];
}

const sameActor = (a: ActorRef | null | undefined, b: ActorRef | null | undefined) =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.type === b.type && a.id === b.id);

/**
 * Applies the change, records one event per field that changed and tells whoever follows the issue. The row is
 * read again under its lock in the same transaction as the write and the events, so two changes at the same
 * time are compared each with the issue as the other one left it (a move from "todo" then from "in progress",
 * never two moves from "todo"). `row` only names the issue. The lock is FOR NO KEY UPDATE: a comment going into
 * the timeline at the same time (a foreign key to the issue) doesn't wait for it.
 */
export async function updateIssue(
  deps: AppDeps,
  row: IssueRow,
  change: IssueChange,
  by: ActorRef,
): Promise<IssueRow> {
  const { db } = deps;
  const cols = await columnsOf(db, row.workspaceId);
  const target = change.columnId ?? row.columnId;
  if (!cols.some((c) => c.id === target)) throw notFound("Column not found");
  const at = deps.now();
  const { before, updated, progress } = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, row.id), eq(issues.workspaceId, row.workspaceId)))
      .for("no key update");
    if (!current) throw notFound("Issue not found");
    const [next] = await tx
      .update(issues)
      .set({ ...change, updatedAt: at })
      .where(eq(issues.id, current.id))
      .returning();
    if (!next) throw notFound("Issue not found");
    const events: TimelineValues[] = [];
    const log = (event: string, text: string, vars?: Record<string, string | number>) =>
      events.push(eventValues(at, { issueId: current.id, author: by, event, text, vars }));
    if (change.title !== undefined && change.title !== current.title)
      log("title", `renamed the issue to "${change.title}"`, { from: current.title, to: change.title });
    if (change.description !== undefined && change.description !== current.description)
      log("description", "edited the description");
    const fromCol = cols.find((c) => c.id === current.columnId);
    const toCol = cols.find((c) => c.id === next.columnId);
    let moved: { from: IssueStage; to: IssueStage } | null = null;
    if (fromCol && toCol && toCol.id !== fromCol.id) {
      if (toCol.stage !== fromCol.stage) {
        log("status", `moved from ${fromCol.stage} to ${toCol.stage}`, {
          from: fromCol.stage,
          to: toCol.stage,
        });
        moved = { from: fromCol.stage, to: toCol.stage };
      } else {
        log("column", `moved to ${toCol.name || toCol.stage}`, { column: toCol.name || toCol.stage });
      }
    }
    if (change.assignee !== undefined && !sameActor(change.assignee, current.assignee)) {
      if (change.assignee)
        log("assigned", "changed the assignee", { type: change.assignee.type, id: change.assignee.id });
      else log("unassigned", "removed the assignee");
    }
    if (change.priority !== undefined && change.priority !== current.priority)
      log("priority", `set priority to ${change.priority}`, { from: current.priority, to: change.priority });
    if (change.dueDate !== undefined && change.dueDate !== current.dueDate)
      log("due", change.dueDate ? `set the due date to ${change.dueDate}` : "removed the due date", {
        date: change.dueDate ?? "",
      });
    if (change.labels !== undefined && change.labels.join("\u0000") !== current.labels.join("\u0000"))
      log("labels", "changed the labels", { labels: change.labels.join(", ") });
    if (events.length > 0) await tx.insert(issueTimeline).values(events);
    return { before: current, updated: next, progress: moved };
  });
  if (progress) await notifyProgress(deps, updated, by, progress.from, progress.to);
  if (change.assignee !== undefined && !sameActor(change.assignee, before.assignee))
    await notifyAssigned(deps, updated, by);
  await reindex(deps, { kind: "issue", id: updated.id });
  return updated;
}

/** The issue an "Ask an agent" message asked to work on (`meta.workedIssue`), as saved. */
const workedIssueMeta = z.object({ workedIssue: z.object({ issueId: z.string() }) });

/**
 * End of the work asked with "Ask an agent" (`meta.workedIssue` on the request's message): when the run that
 * served the message ends, the issue leaves "working"; if the agent didn't even start (budget, personal plan,
 * audience), the run failed or the server went down in the middle, it stays "blocked" with the reason. It only
 * touches an issue still "working" for the same message: a request asked again of another agent isn't closed by
 * the old run.
 */
export async function settleIssueWork(
  db: Db,
  workspaceId: string,
  messageIds: readonly string[],
  next: { state: "idle" | "blocked"; reason: string | null; runId: string | null },
): Promise<void> {
  if (messageIds.length === 0) return;
  const rows = await db
    .select({ id: messages.id, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), inArray(messages.id, [...messageIds])));
  for (const r of rows) {
    const meta = workedIssueMeta.safeParse(r.meta);
    if (!meta.success) continue;
    await db
      .update(issues)
      .set({ work: { ...next, messageId: r.id } })
      .where(
        and(
          eq(issues.workspaceId, workspaceId),
          eq(issues.id, meta.data.workedIssue.issueId),
          sql`${issues.work}->>'state' = 'working'`,
          sql`coalesce(${issues.work}->>'messageId', ${r.id}) = ${r.id}`,
        ),
      );
  }
}
