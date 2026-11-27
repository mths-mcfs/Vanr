// Bases: the core. Loads a database, a source and a view always inside the workspace, builds the API shape,
// resolves names for the formulas, publishes events and gives the search the text of a row.
//
// Permission: like the wiki, a database belongs to the whole workspace. Every member reads and writes;
// deleting the database is for whoever created it or whoever has `configure`. An agent reads and writes with
// the `bases:read|write` scope.
import {
  type ActorRef,
  type Base,
  type BaseFormulaError,
  type BaseLinkedRow,
  type BaseRelationTarget,
  type BaseRow,
  type BaseSummary,
  type BaseTable,
  type BaseView,
  can,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { planFormulas } from "@vanr/engine/formula";
import { type PropActor, type PropDef, propText } from "@vanr/engine/props";
import type { ChunkInput } from "@vanr/engine/search";
import { textFacets } from "@vanr/engine/search-query";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDeps, WorkspaceMember } from "../context";
import { forbidden, notFound } from "../http";
import { readablePagesSql, type WikiViewer } from "../wiki-access";

const { dbDatabases, dbTables, dbRows, dbViews, members, users, agents, knowledgePages } = schema;

export type DatabaseRow = typeof dbDatabases.$inferSelect;
export type TableRow = typeof dbTables.$inferSelect;
export type RowRow = typeof dbRows.$inferSelect;
export type ViewRow = typeof dbViews.$inferSelect;
/** A transaction of the database, for whoever reads or writes inside the caller's one. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Rows per database: the 100 thousand cap. */
export const MAX_ROWS = 100_000;
export const MAX_BODY = 500_000;
export const MAX_VIEWS = 50;

export async function databaseById(db: Db, workspaceId: string, id: string): Promise<DatabaseRow> {
  const [row] = await db
    .select()
    .from(dbDatabases)
    .where(and(eq(dbDatabases.id, id), eq(dbDatabases.workspaceId, workspaceId)));
  if (!row) throw notFound("Database not found");
  return row;
}

/**
 * The source `tableId` as the database `databaseId` sees it: its own, or another database's that a view of
 * this one shows (a linked view). Anything else is a 404, even when the source exists in another database of
 * the workspace.
 */
export async function tableIn(
  db: Db,
  workspaceId: string,
  databaseId: string,
  tableId: string,
): Promise<TableRow> {
  const [table] = await db
    .select()
    .from(dbTables)
    .where(and(eq(dbTables.id, tableId), eq(dbTables.workspaceId, workspaceId)));
  if (!table) throw notFound("Table not found");
  if (table.databaseId === databaseId) return table;
  const [view] = await db
    .select({ id: dbViews.id })
    .from(dbViews)
    .where(
      and(
        eq(dbViews.databaseId, databaseId),
        eq(dbViews.tableId, tableId),
        eq(dbViews.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!view) throw notFound("Table not found");
  return table;
}

/** The row and its source, as the database `databaseId` sees them (the same rule as `tableIn`). */
export async function rowIn(
  db: Db,
  workspaceId: string,
  databaseId: string,
  rowId: string,
): Promise<{ row: RowRow; table: TableRow }> {
  const [row] = await db
    .select()
    .from(dbRows)
    .where(and(eq(dbRows.id, rowId), eq(dbRows.workspaceId, workspaceId)));
  if (!row) throw notFound("Row not found");
  const table = await tableIn(db, workspaceId, databaseId, row.tableId).catch(() => {
    throw notFound("Row not found");
  });
  return { row, table };
}

function canDeleteDatabase(row: DatabaseRow, me: WorkspaceMember): boolean {
  return (row.createdBy.type === "person" && row.createdBy.id === me.userId) || can(me.role, "configure");
}

export function requireDeleter(row: DatabaseRow, me: WorkspaceMember) {
  if (!canDeleteDatabase(row, me)) throw forbidden("Only who created the database or an admin can delete it");
}

// ---------- API shape ----------

export function toTable(t: TableRow): BaseTable {
  const plan = planFormulas(t.defs);
  const formulaErrors: Record<string, BaseFormulaError[]> = {};
  for (const [id, errs] of plan.errors) formulaErrors[id] = errs;
  return {
    id: t.id,
    databaseId: t.databaseId,
    name: t.name,
    defs: t.defs,
    titlePropId: t.titlePropId,
    schemaVersion: t.schemaVersion,
    recalc: { version: t.calcVersion, done: t.calcDoneVersion, pending: t.calcDoneVersion < t.calcVersion },
    formulaErrors,
  };
}

export function toView(v: ViewRow): BaseView {
  return {
    id: v.id,
    databaseId: v.databaseId,
    tableId: v.tableId,
    name: v.name,
    type: v.type,
    position: v.position,
    config: v.config,
  };
}

const iso = (d: Date) => d.toISOString();

export function toRow(r: RowRow, databaseId: string): BaseRow {
  return {
    id: r.id,
    tableId: r.tableId,
    databaseId,
    position: r.position,
    props: r.props,
    computed: r.computed,
    version: r.version,
    hasBody: Boolean(r.body),
    createdAt: iso(r.createdAt),
    createdBy: r.createdBy,
    editedAt: iso(r.editedAt),
    editedBy: r.editedBy,
  };
}

export async function rowCounts(db: Db, tableIds: string[]): Promise<Map<string, number>> {
  if (!tableIds.length) return new Map();
  const rows = await db
    .select({ tableId: dbRows.tableId, n: sql<number>`count(*)::int` })
    .from(dbRows)
    .where(inArray(dbRows.tableId, tableIds))
    .groupBy(dbRows.tableId);
  return new Map(rows.map((r) => [r.tableId, Number(r.n)]));
}

function pageOf(pages: { id: string; slug: string; title: string }[], id: string | null) {
  const p = id ? pages.find((x) => x.id === id) : undefined;
  return p ? { slug: p.slug, title: p.title } : null;
}

/** `viewer` decides the page each database sits on: a restricted page they don't read shows as none. */
export async function toSummaries(db: Db, rows: DatabaseRow[], viewer: WikiViewer): Promise<BaseSummary[]> {
  if (!rows.length) return [];
  const tables = await db
    .select({ id: dbTables.id, databaseId: dbTables.databaseId })
    .from(dbTables)
    .where(
      inArray(
        dbTables.databaseId,
        rows.map((r) => r.id),
      ),
    );
  const counts = await rowCounts(
    db,
    tables.map((t) => t.id),
  );
  const pageIds = [...new Set(rows.map((r) => r.pageId).filter((p): p is string => Boolean(p)))];
  const pages = pageIds.length
    ? await db
        .select({ id: knowledgePages.id, slug: knowledgePages.slug, title: knowledgePages.title })
        .from(knowledgePages)
        .where(and(inArray(knowledgePages.id, pageIds), readablePagesSql(viewer)))
    : [];
  const byDb = new Map<string, number>();
  for (const t of tables) byDb.set(t.databaseId, (byDb.get(t.databaseId) ?? 0) + (counts.get(t.id) ?? 0));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    kind: r.kind,
    tableId: tables.find((t) => t.databaseId === r.id)?.id ?? null,
    page: pageOf(pages, r.pageId),
    rowCount: byDb.get(r.id) ?? 0,
    createdBy: r.createdBy,
    updatedAt: iso(r.updatedAt),
  }));
}

export async function toBase(db: Db, row: DatabaseRow, me: WorkspaceMember | null): Promise<Base> {
  const views = await db
    .select()
    .from(dbViews)
    .where(eq(dbViews.databaseId, row.id))
    .orderBy(sql`${dbViews.position} collate "C"`, dbViews.id);
  const own = await db.select().from(dbTables).where(eq(dbTables.databaseId, row.id));
  const linkedIds = [...new Set(views.map((v) => v.tableId))].filter((id) => !own.some((t) => t.id === id));
  const linked = linkedIds.length
    ? await db.select().from(dbTables).where(inArray(dbTables.id, linkedIds))
    : [];
  const viewer = me ? { workspaceId: me.workspaceId, userId: me.userId } : { workspaceId: row.workspaceId };
  const [summary] = await toSummaries(db, [row], viewer);
  if (!summary) throw notFound("Database not found");
  const tables = [...own, ...linked];
  return {
    ...summary,
    tables: tables.map(toTable),
    views: views.map(toView),
    deletable: me ? canDeleteDatabase(row, me) : false,
    relationTargets: await relationTargets(db, row.workspaceId, tables),
  };
}

/** The ids of the sources the relations of `defs` point to. */
export function relationTableIds(defs: readonly PropDef[]): string[] {
  return [...new Set(defs.flatMap((d) => (d.type === "relation" && d.relation ? [d.relation.tableId] : [])))];
}

/** The sources the relations point to (only the workspace's own), with the database of each. */
async function relationTargets(
  db: Db,
  workspaceId: string,
  tables: readonly TableRow[],
): Promise<BaseRelationTarget[]> {
  const ids = relationTableIds(tables.flatMap((t) => t.defs));
  if (!ids.length) return [];
  return db
    .select({
      tableId: dbTables.id,
      databaseId: dbTables.databaseId,
      databaseTitle: dbDatabases.title,
      titlePropId: dbTables.titlePropId,
    })
    .from(dbTables)
    .innerJoin(dbDatabases, eq(dbDatabases.id, dbTables.databaseId))
    .where(and(eq(dbTables.workspaceId, workspaceId), inArray(dbTables.id, ids)));
}

/** Rows looked up per statement (the size of an `in` list). */
const LOOKUP_CHUNK = 500;

/**
 * Title and place of the rows the relations of `rows` link (the ones that exist, of the right source and of
 * the same workspace): a relation cell shows the name, not the id.
 */
export async function linkedTitles(
  db: Db,
  table: TableRow,
  rows: readonly Pick<RowRow, "props">[],
): Promise<Record<string, BaseLinkedRow>> {
  const want = new Map<string, Set<string>>();
  for (const rel of table.defs) {
    if (rel.type !== "relation" || !rel.relation) continue;
    const set = want.get(rel.relation.tableId) ?? new Set<string>();
    for (const r of rows) {
      const v = r.props[rel.id];
      if (Array.isArray(v)) for (const x of v) if (typeof x === "string") set.add(x);
    }
    want.set(rel.relation.tableId, set);
  }
  const out: Record<string, BaseLinkedRow> = {};
  for (const [tableId, idSet] of want) {
    const ids = [...idSet];
    if (!ids.length) continue;
    const [t] = await db
      .select({ databaseId: dbTables.databaseId, titlePropId: dbTables.titlePropId })
      .from(dbTables)
      .where(and(eq(dbTables.id, tableId), eq(dbTables.workspaceId, table.workspaceId)));
    if (!t) continue;
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const found = await db
        .select({ id: dbRows.id, title: sql<string | null>`${dbRows.props} ->> ${t.titlePropId}::text` })
        .from(dbRows)
        .where(
          and(
            eq(dbRows.tableId, tableId),
            eq(dbRows.workspaceId, table.workspaceId),
            inArray(dbRows.id, ids.slice(i, i + LOOKUP_CHUNK)),
          ),
        );
      for (const f of found) out[f.id] = { title: f.title ?? "", tableId, databaseId: t.databaseId };
    }
  }
  return out;
}

// ---------- names (the `name()` formula, CSV, search) ----------

export type Names = (a: PropActor) => string;

/** The name of each person and agent of the workspace, for formulas and text. */
export async function namesOf(db: Db | Tx, workspaceId: string): Promise<Names> {
  const people = await db
    .select({ id: members.userId, name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.workspaceId, workspaceId));
  const bots = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  const map = new Map<string, string>();
  for (const p of people) map.set(`person:${p.id}`, p.name);
  for (const a of bots) map.set(`agent:${a.id}`, a.name);
  return (a) => map.get(`${a.type}:${a.id}`) ?? a.id;
}

// ---------- events ----------

/** Something in the database changed (title, views, schema): the client fetches the database again. */
export function publishBase(deps: AppDeps, workspaceId: string, databaseId: string) {
  deps.hub.toWorkspace(workspaceId, { type: "base.updated", baseId: databaseId });
}

/** Rows changed (created, edited, deleted): the client reloads the queries of the source. */
export function publishRows(
  deps: AppDeps,
  workspaceId: string,
  table: Pick<TableRow, "id" | "databaseId">,
  change: { rowIds?: string[]; deleted?: string[]; by?: ActorRef },
) {
  deps.hub.toWorkspace(workspaceId, {
    type: "base.rows",
    baseId: table.databaseId,
    tableId: table.id,
    rowIds: change.rowIds ?? [],
    deleted: change.deleted ?? [],
    ...(change.by ? { by: change.by } : {}),
  });
}

// ---------- search ----------

const actorKey = (a: ActorRef) => `${a.type === "person" ? "user" : "agent"}:${a.id}`;

/**
 * The row's text for the search (search-index.ts reads the row and calls this): the title and each property
 * with a value, then the body. The database belongs to the whole workspace, and so does its row.
 */
export function rowChunks(
  table: TableRow,
  row: Pick<
    RowRow,
    "id" | "workspaceId" | "props" | "computed" | "body" | "createdAt" | "createdBy" | "editedAt" | "editedBy"
  >,
  names: Names,
): ChunkInput[] {
  const title = String(row.props[table.titlePropId] ?? "").trim() || "Untitled";
  const lines: string[] = [];
  for (const def of table.defs) {
    if (def.id === table.titlePropId) continue;
    const text = cellText(def, row, names);
    if (text) lines.push(`${def.name}: ${text}`);
  }
  const text = [lines.join("\n"), row.body ?? ""].filter(Boolean).join("\n\n").slice(0, 20_000);
  return [
    {
      workspaceId: row.workspaceId,
      ordinal: 0,
      title,
      text,
      scope: { kind: "workspace" },
      url: `/workspace/${row.workspaceId}/bases/${table.databaseId}?row=${row.id}`,
      authorId: actorKey(row.createdBy),
      updatedAt: row.editedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      facets: { has: textFacets(`${title}\n${text}`) },
    },
  ];
}

/** The columns of the row a cell can read: its values, its formulas and who created and edited it, when. */
export type CellRow = Pick<
  RowRow,
  "props" | "computed" | "createdAt" | "createdBy" | "editedAt" | "editedBy"
>;

/**
 * The text of a cell (a formula's and a rollup's too, by the computed value). The automatic properties live in
 * the row's columns, not in `props`: the times go out as ISO instants, the people by name. A relation becomes
 * the titles of the linked rows when `linked` comes; without it, it stays out (an id says nothing to a reader).
 */
export function cellText(
  def: PropDef,
  row: CellRow,
  names: Names,
  linked?: Readonly<Record<string, BaseLinkedRow>>,
): string {
  switch (def.type) {
    case "relation": {
      const ids = row.props[def.id];
      if (!linked || !Array.isArray(ids)) return "";
      return ids
        .map((id) => linked[String(id)]?.title)
        .filter((t): t is string => Boolean(t))
        .join(", ");
    }
    case "formula":
    case "rollup": {
      const v = row.computed[def.id];
      if (v === undefined || v === null) return "";
      if (typeof v === "object" && !Array.isArray(v) && "err" in v) return `#${String(v.err)}`;
      return formulaText(v, names);
    }
    case "created_time":
      return row.createdAt.toISOString();
    case "edited_time":
      return row.editedAt.toISOString();
    case "creator":
      return propText(def, row.createdBy, names);
    case "editor":
      return propText(def, row.editedBy, names);
    default:
      return propText(def, row.props[def.id], names);
  }
}

function formulaText(v: unknown, names: Names): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => formulaText(x, names)).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.start === "string") return typeof o.end === "string" ? `${o.start} → ${o.end}` : o.start;
    if ((o.type === "person" || o.type === "agent") && typeof o.id === "string")
      return names({ type: o.type, id: o.id });
    return "";
  }
  return String(v);
}
