// The workspace's issues: a short number per workspace, a board with columns by stage, acceptance criteria,
// a timeline (comments and events) and notices for whoever is assigned or opened the issue.
import type { ActorRef, Issue, IssueActivity, IssueColumn, IssueStage } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, desc, eq, gte, inArray, isNull, lt, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "./context";
import { HttpError, notFound } from "./http";
import { log } from "./logger";
import { notify } from "./notifications";
import { fireRoutineEvent } from "./routines";
import { reindex } from "./search-index";

const { issues, boardColumns, issueTimeline, debates, messages, channels, members, agents, files } = schema;
export type IssueRow = typeof issues.$inferSelect;
type ColumnRow = typeof boardColumns.$inferSelect;
type TimelineValues = typeof issueTimeline.$inferInsert;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
export async function saveColumnOrder(db: Db | Tx, ordered: ColumnRow[]): Promise<void> {
  const sorted = [...ordered].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  for (const [i, col] of sorted.entries()) {
    if (col.position !== i)
      await db.update(boardColumns).set({ position: i }).where(eq(boardColumns.id, col.id));
  }
}

export function publishColumns(deps: AppDeps, workspaceId: string, rows: ColumnRow[]) {
  deps.hub.toWorkspace(workspaceId, { type: "issue_column.list_updated", columns: rows.map(toColumn) });
}

/**
 * The lock of a workspace's column list: every change of the columns (add, rename, move, delete) reads the list,
 * decides and writes under it, so two changes at once never lay out positions from a stale list. The seeding in
 * `columnsOf` takes the same lock. A change that also moves issues takes the board's lock first.
 */
const lockColumns = (tx: Tx, workspaceId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`board-columns:${workspaceId}`}))`);

const columnsIn = (tx: Tx, workspaceId: string) =>
  tx
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.workspaceId, workspaceId))
    .orderBy(asc(boardColumns.position));

/** Runs a change of the columns under their lock and answers the list as it ended. */
async function changeColumns(
  db: Db,
  workspaceId: string,
  change: (tx: Tx, cols: ColumnRow[]) => Promise<void>,
  opts: { movesIssues?: boolean } = {},
): Promise<ColumnRow[]> {
  await columnsOf(db, workspaceId);
  return db.transaction(async (tx) => {
    if (opts.movesIssues) await lockBoard(tx, workspaceId);
    await lockColumns(tx, workspaceId);
    await change(tx, await columnsIn(tx, workspaceId));
    return columnsIn(tx, workspaceId);
  });
}

/** A new column right after `afterId` (of the same stage), or at the end of its stage's columns. */
export function addColumn(
  db: Db,
  workspaceId: string,
  input: { name: string; stage: IssueStage; afterId?: string },
): Promise<ColumnRow[]> {
  return changeColumns(db, workspaceId, async (tx, cols) => {
    const after = input.afterId ? cols.find((x) => x.id === input.afterId) : undefined;
    if (input.afterId && (!after || after.stage !== input.stage))
      throw new HttpError(400, "issue.column_stage", "Put the column next to one of the same stage");
    const [col] = await tx
      .insert(boardColumns)
      .values({ id: newId("col"), workspaceId, name: input.name, stage: input.stage, position: cols.length })
      .returning();
    if (!col) throw new Error("column insert returned nothing");
    const sameStage = cols.filter((x) => x.stage === input.stage);
    const anchor = after ?? sameStage[sameStage.length - 1];
    const ordered = [...cols];
    ordered.splice(anchor ? ordered.indexOf(anchor) + 1 : ordered.length, 0, col);
    await saveColumnOrder(tx, ordered);
  });
}

/** Renames a column and/or moves it to `index`; it only moves inside its own stage (the board stays grouped). */
export function changeColumn(
  db: Db,
  workspaceId: string,
  columnId: string,
  input: { name?: string; index?: number },
): Promise<ColumnRow[]> {
  return changeColumns(db, workspaceId, async (tx, cols) => {
    const col = cols.find((x) => x.id === columnId);
    if (!col) throw notFound("Column not found");
    if (input.name !== undefined)
      await tx.update(boardColumns).set({ name: input.name }).where(eq(boardColumns.id, col.id));
    if (input.index !== undefined) {
      const ordered = cols.filter((x) => x.id !== col.id);
      const first = cols.findIndex((x) => x.stage === col.stage);
      const count = cols.filter((x) => x.stage === col.stage).length;
      ordered.splice(Math.min(Math.max(input.index, first), first + count - 1), 0, col);
      await saveColumnOrder(tx, ordered);
    }
  });
}

/**
 * Deletes a column and moves its issues to `moveTo`, below the cards already there and in their order, under the
 * board's lock (positions in a column stay unique). Each stage keeps at least one column.
 */
export function deleteColumn(
  db: Db,
  workspaceId: string,
  columnId: string,
  moveTo: string,
): Promise<ColumnRow[]> {
  return changeColumns(
    db,
    workspaceId,
    async (tx, cols) => {
      const col = cols.find((x) => x.id === columnId);
      const target = cols.find((x) => x.id === moveTo);
      if (!col) throw notFound("Column not found");
      if (!target || target.id === col.id)
        throw new HttpError(400, "issue.column_move_to", "Pick another column");
      if (cols.filter((x) => x.stage === col.stage).length === 1)
        throw new HttpError(409, "issue.column_last_of_stage", "Each stage keeps at least one column");
      await tx.execute(sql`
        update ${issues} set "column_id" = ${target.id}, "board_position" = m.top + v.rn
        from (
          select "id", row_number() over (order by "board_position", "number" desc) as rn
          from ${issues} where "column_id" = ${col.id}
        ) as v,
        (select coalesce(max("board_position"), -1) as top from ${issues} where "column_id" = ${target.id}) as m
        where ${issues.id} = v."id"`);
      await tx.delete(boardColumns).where(eq(boardColumns.id, col.id));
      await saveColumnOrder(
        tx,
        cols.filter((x) => x.id !== col.id),
      );
    },
    { movesIssues: true },
  );
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
 * The board's lock of a workspace: every creation (the number and the position) and every change of where an issue
 * sits (its column or its position) takes it first, before any row lock, so they happen one after another and the
 * lock order is always the same.
 */
const lockBoard = (tx: Tx, workspaceId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue-board:${workspaceId}`}))`);

/** What an issue points to by id: each one has to be of the issue's workspace. */
interface Links {
  columnId?: string;
  channelId?: string | null;
  parentId?: string | null;
  assignee?: ActorRef | null;
  source?: Issue["source"];
  fileIds?: string[];
}

/**
 * Checks, in the transaction that writes, that every id the issue points to is of its workspace: the column, the
 * channel, the parent issue, the assignee (a member, or an agent that isn't archived), what it came from and its
 * files. One that isn't answers "not found" for its kind, the same as an id that doesn't exist anywhere.
 */
async function checkLinks(tx: Tx, workspaceId: string, links: Links): Promise<void> {
  const one = async (found: Promise<unknown[]>, what: string) => {
    if ((await found).length === 0) throw notFound(`${what} not found`);
  };
  if (links.columnId !== undefined)
    await one(
      tx
        .select({ id: boardColumns.id })
        .from(boardColumns)
        .where(and(eq(boardColumns.id, links.columnId), eq(boardColumns.workspaceId, workspaceId))),
      "Column",
    );
  if (links.channelId)
    await one(
      tx
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, links.channelId), eq(channels.workspaceId, workspaceId))),
      "Channel",
    );
  if (links.parentId)
    await one(
      tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, links.parentId), eq(issues.workspaceId, workspaceId))),
      "Issue",
    );
  const a = links.assignee;
  if (a?.type === "person")
    await one(
      tx
        .select({ id: members.userId })
        .from(members)
        .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, a.id))),
      "Member",
    );
  if (a?.type === "agent")
    await one(
      tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, a.id), eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt))),
      "Agent",
    );
  const src = links.source;
  if (src?.id && src.kind === "agent")
    await one(
      tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, src.id), eq(agents.workspaceId, workspaceId))),
      "Agent",
    );
  if (src?.id && src.kind === "debate")
    await one(
      tx
        .select({ id: debates.id })
        .from(debates)
        .where(and(eq(debates.id, src.id), eq(debates.workspaceId, workspaceId))),
      "Debate",
    );
  if (src?.id && src.kind === "message")
    await one(
      tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, src.id), eq(messages.workspaceId, workspaceId))),
      "Message",
    );
  const wanted = [...new Set(links.fileIds ?? [])];
  if (wanted.length > 0) {
    const found = await tx
      .select({ id: files.id })
      .from(files)
      .where(and(inArray(files.id, wanted), eq(files.workspaceId, workspaceId), isNull(files.deletedAt)));
    if (found.length !== wanted.length) throw notFound("File not found");
  }
}

/** Where in a column: right under another issue of it (`after`, null = on top) or at a position asked for. */
type Spot = { after: string | null } | { position: number };

/**
 * Where an issue lands in a column, under the board's lock. Without a spot it goes on top. With `after` it goes
 * right under that issue; with a position, right before the first other card at or past it. Only the two cards
 * around the spot are read. When the gap between them is used up (the position would equal a neighbor's: the
 * halves ran out of precision), the column is renumbered 0, 1, 2... in its order with the issue in its slot, in one
 * statement. Every creation and move goes through here under the same lock, so positions in a column stay unique.
 */
async function placeIn(tx: Tx, columnId: string, issueId: string | null, spot?: Spot): Promise<number> {
  const inColumn = and(eq(issues.columnId, columnId), issueId ? ne(issues.id, issueId) : undefined);
  const card = { id: issues.id, position: issues.boardPosition };
  const first = (where: ReturnType<typeof and>) =>
    tx
      .select(card)
      .from(issues)
      .where(where)
      .orderBy(asc(issues.boardPosition), desc(issues.number))
      .limit(1);
  let lo: { id: string; position: number } | undefined;
  let hi: { id: string; position: number } | undefined;
  let asked: number | undefined;
  if (spot && "position" in spot && Number.isFinite(spot.position)) {
    asked = spot.position;
    [hi] = await first(and(inColumn, gte(issues.boardPosition, asked)));
    [lo] = await tx
      .select(card)
      .from(issues)
      .where(and(inColumn, lt(issues.boardPosition, asked)))
      .orderBy(desc(issues.boardPosition), asc(issues.number))
      .limit(1);
  } else if (spot && "after" in spot && spot.after !== null) {
    [lo] = await tx
      .select(card)
      .from(issues)
      .where(and(inColumn, eq(issues.id, spot.after)));
    if (!lo) throw notFound("Issue not found");
    [hi] = await first(and(inColumn, sql`${issues.boardPosition} > ${lo.position}`));
  } else {
    [hi] = await first(inColumn);
  }
  const between = (p: number) => (!lo || p > lo.position) && (!hi || p < hi.position);
  const candidate =
    asked !== undefined && between(asked)
      ? asked
      : lo && hi
        ? lo.position + (hi.position - lo.position) / 2
        : lo
          ? lo.position + 1
          : hi
            ? hi.position - 1
            : 0;
  if (between(candidate)) return candidate;
  const others = await tx
    .select(card)
    .from(issues)
    .where(inColumn)
    .orderBy(asc(issues.boardPosition), desc(issues.number));
  const at = hi ? others.findIndex((o) => o.id === hi.id) : others.length;
  const renumbered = others.flatMap((o, i) => {
    const next = i < at ? i : i + 1;
    return o.position === next ? [] : [sql`(${o.id}, ${next}::double precision)`];
  });
  if (renumbered.length > 0)
    await tx.execute(
      sql`update ${issues} set "board_position" = v.p from (values ${sql.join(renumbered, sql`, `)}) as v(id, p) where ${issues.id} = v.id`,
    );
  return at;
}

/**
 * Creates the issue with the workspace's next number, on top of its column. The number and the position are read
 * and written under the board's lock (one transaction), so issues created at the same time get numbers one after
 * another, without a repeat or a hole, and positions that don't repeat; a creation that fails takes no number.
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
    await lockBoard(tx, input.workspaceId);
    const [top] = await tx
      .select({ n: max(issues.number) })
      .from(issues)
      .where(eq(issues.workspaceId, input.workspaceId));
    await checkLinks(tx, input.workspaceId, {
      columnId: column.id,
      channelId: input.channelId,
      parentId: input.parentId,
      assignee: input.assignee,
      source: input.source,
    });
    const position = await placeIn(tx, column.id, null);
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
        boardPosition: position,
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
  await issueCreated(deps, row, input.author);
  return row;
}

/**
 * Tells the routines subscribed to `issue.created`, once the issue is saved (never inside the transaction that
 * could still undo it). Only an issue a person opened fires: one an agent opened doesn't (an agent that opens
 * issues from a routine would feed itself forever). The issue's id is the event's id, so a routine runs once
 * per issue. The issue already exists, so a failure here is logged and doesn't fail its creation.
 */
async function issueCreated(deps: AppDeps, row: IssueRow, by: ActorRef) {
  if (by.type !== "person") return;
  await fireRoutineEvent(deps, {
    workspaceId: row.workspaceId,
    event: "issue.created",
    eventId: row.id,
    context: `Issue #${row.number}: ${row.title}\n\n${row.description}`.trim(),
  }).catch((err) => log.error("routine.issue_event_failed", { issueId: row.id, err }));
}

/**
 * Checks or unchecks one acceptance criterion. The issue is read again under its row lock in the transaction that
 * writes the list and the event, so two criteria changed at once both stay (neither writes the list it read
 * before the other one's change).
 */
export async function setCriterion(
  deps: AppDeps,
  row: IssueRow,
  criterionId: string,
  done: boolean,
  by: ActorRef,
): Promise<IssueRow> {
  const at = deps.now();
  return deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, row.id), eq(issues.workspaceId, row.workspaceId)))
      .for("no key update");
    if (!current) throw notFound("Issue not found");
    const crit = current.criteria.find((x) => x.id === criterionId);
    if (!crit) throw notFound("Criterion not found");
    if (crit.done === done) return current;
    const [updated] = await tx
      .update(issues)
      .set({ criteria: current.criteria.map((x) => (x.id === crit.id ? { ...x, done } : x)), updatedAt: at })
      .where(eq(issues.id, current.id))
      .returning();
    if (!updated) throw notFound("Issue not found");
    await tx.insert(issueTimeline).values(
      eventValues(at, {
        issueId: current.id,
        author: by,
        event: done ? "criterion_done" : "criterion_undone",
        text: `${done ? "checked" : "unchecked"} "${crit.text}"`,
        vars: { text: crit.text },
      }),
    );
    return updated;
  });
}

/** A comment on the timeline (with the files it attaches, already checked) and a notice to whoever follows the issue. */
export async function addComment(
  deps: AppDeps,
  row: IssueRow,
  input: { text: string; attachments: string[] },
  by: ActorRef,
): Promise<IssueActivity> {
  const at = deps.now();
  const act = await deps.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(issueTimeline)
      .values({
        id: newId("iact"),
        issueId: row.id,
        kind: "comment",
        text: input.text,
        author: by,
        attachments: input.attachments,
        createdAt: at,
      })
      .returning();
    if (!inserted) throw new Error("comment insert returned nothing");
    await tx.update(issues).set({ updatedAt: at }).where(eq(issues.id, row.id));
    return inserted;
  });
  // The comment is saved: a failed notice is logged, not answered as a failure the client would retry (and
  // post the comment twice).
  await notifyComment(deps, row, by, input.text).catch((err) =>
    log.error("issue.comment_notify_failed", { issueId: row.id, err }),
  );
  return toActivity(act);
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
  /** A position asked for in the column (ties go before the card already there). */
  boardPosition?: number;
  /** Right under this issue of the column (null: on top); the server works out the position. */
  after?: string | null;
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
 * the timeline at the same time (a foreign key to the issue) doesn't wait for it. A change of column or position
 * takes the board's lock before it and places the issue in its column there (`placeIn`); every id the change
 * points to is checked against the workspace in the same transaction.
 */
export async function updateIssue(
  deps: AppDeps,
  row: IssueRow,
  change: IssueChange,
  by: ActorRef,
): Promise<IssueRow> {
  const { db } = deps;
  const cols = await columnsOf(db, row.workspaceId);
  const at = deps.now();
  const { after, ...fields } = change;
  const places = change.columnId !== undefined || change.boardPosition !== undefined || after !== undefined;
  const { before, updated, progress } = await db.transaction(async (tx) => {
    if (places) await lockBoard(tx, row.workspaceId);
    const [current] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, row.id), eq(issues.workspaceId, row.workspaceId)))
      .for("no key update");
    if (!current) throw notFound("Issue not found");
    await checkLinks(tx, current.workspaceId, {
      columnId: change.columnId,
      assignee: change.assignee,
      fileIds: change.fileIds,
    });
    const columnId = change.columnId ?? current.columnId;
    const spot: Spot | undefined =
      after !== undefined
        ? { after }
        : change.boardPosition !== undefined
          ? { position: change.boardPosition }
          : undefined;
    const staysPut = columnId === current.columnId && spot === undefined;
    const boardPosition =
      places && !staysPut ? await placeIn(tx, columnId, current.id, spot) : current.boardPosition;
    const [next] = await tx
      .update(issues)
      .set({ ...fields, columnId, boardPosition, updatedAt: at })
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
