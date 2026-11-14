// Bases: writing. Rows carry a version each (409 with the current row when it changed), the schema has a
// version (409 when someone else saved first), and the formulas are recalculated.
//
// Recalculation: saving the schema bumps `calc_version` when a formula, a type or an option changes. Rows
// with a lower `calc_version` are stale; the recalculation takes batches with `FOR UPDATE SKIP LOCKED`,
// normalizes the values (a type change), recalculates and saves the version it calculated with. It can stop
// and start again at any moment (a crash, a deploy, two processes): it converges on its own. A small table
// recalculates inside the request; a big one goes to the background, with progress in the `base.recalc` event.
//
// Relation and rollup: a row's calculation loads the linked rows (`links.ts`) and computes the linked values
// and the rollups before its own formulas; every row write notes the dependent sources in its transaction
// and, after the commit, `settleLinks` marks the dependents and recalculates them (inside the request when
// the source is small, as for the schema).
import type { ActorRef, BaseViewType } from "@vanr/contract";
import { keyBetween, keysBetween } from "@vanr/engine/bases/position";
import { linkedValues, rollupReadable } from "@vanr/engine/bases/rollup";
import {
  checkFilter,
  effectiveFilter,
  filterKind,
  OPS_BY_KIND,
  pruneFilter,
  type QuickFilter,
  type ViewConfig,
  viewConfigSchema,
} from "@vanr/engine/bases/view";
import { type Db, schema } from "@vanr/engine/db";
import { evaluateRow, planFormulas, resultTypeOf, rewritePropRefs } from "@vanr/engine/formula";
import { newId, randomId } from "@vanr/engine/ids";
import {
  applyProps,
  COMPUTED_TYPES,
  checkDefs,
  normalizeProps,
  type PropDef,
  type PropError,
  type Props,
  parsePropText,
  rawText,
} from "@vanr/engine/props";
import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { AppDeps } from "../context";
import { pgCode } from "../db-errors";
import { conflict, HttpError, notFound } from "../http";
import { log } from "../logger";
import { reindexRows, unindexMany } from "../search-index";
import {
  type DatabaseRow,
  MAX_BODY,
  MAX_ROWS,
  MAX_VIEWS,
  type Names,
  namesOf,
  publishBase,
  publishRows,
  type RowRow,
  rowCounts,
  type TableRow,
  type Tx,
  toRow,
  toTable,
  type ViewRow,
} from "./core";
import {
  checkRelationIds,
  dependentsOf,
  type Linked,
  loadLinked,
  noteChanged,
  propagate,
  withRollupTypes,
} from "./links";
import { groupable, validateFilter, validateSorts } from "./query";

const { dbDatabases, dbTables, dbRows, dbViews, knowledgePages, files, members, agents } = schema;

/** Up to how many rows the recalculation runs inside the request (beyond that it goes to the background). */
const INLINE_RECALC = 2_000;
const BATCH = 500;

export const newPropId = () => `prop_${randomId(10)}`;
export const newOptionId = () => `opt_${randomId(8)}`;

const bad = (code: string, message: string, params?: Record<string, unknown>) =>
  new HttpError(400, code, message, params);

// ---------- locks ----------
//
// One lock order for every write of the bases: the rows of the databases the write reaches, in ascending id
// (lockDatabases); then their sources (db_tables); then the rows, the views and the search chunks under
// them. A write that can reach more than one database (deleting a source other databases show; any write on
// a view, which a delete of the view's source also takes by cascade) finds the whole set first and locks it
// here, before any statement that takes a row of another database, directly or by cascade.

/** Locks the databases' rows in ascending id; returns the ones that still exist. */
async function lockDatabases(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const id of [...new Set(ids)].sort()) {
    const [row] = await tx
      .select({ id: dbDatabases.id })
      .from(dbDatabases)
      .where(eq(dbDatabases.id, id))
      .for("update");
    if (row) found.add(row.id);
  }
  return found;
}

/** A point inside a write where the Postgres tests hold the transaction, to force an interleaving. */
export type LockPoint = "view:counted" | "view:moving" | "view:deleting" | "base:deleted";

/**
 * The seams of the Postgres tests (bases-postgres.test.ts), in the mold of `storageLock`: `databases` is the
 * lock of the order above (a test swaps it for a double without the order to prove the tests need it), and
 * `pause` is called at each `LockPoint` with the transaction (a no-op outside the tests).
 */
export const baseLocks = {
  databases: lockDatabases,
  pause: async (_point: LockPoint, _tx: Tx): Promise<void> => {},
};

const busy = () =>
  conflict("base.busy", "Someone else is changing this database right now; try again", { retryable: true });

/** A transaction of the bases: a deadlock (40P01) or a serialization failure (40001) is `base.busy`, never a 500. */
async function writeTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (err) {
    const code = pgCode(err);
    if (code === "40P01" || code === "40001") throw busy();
    throw err;
  }
}

/** The set of databases grew between finding it and locking it: the transaction starts over. */
class Regrown extends Error {}

/**
 * A transaction that first locks the databases `reach` finds (the write's own database first: the order
 * comes from the lock). Once the write holds its sources, it calls `recheck`: a database that joined the set
 * before the locks (a view created just then) makes the transaction start over with the new set, up to three
 * times, then `base.busy`.
 */
async function lockedTx<T>(
  deps: AppDeps,
  reach: (q: Db | Tx) => Promise<string[]>,
  fn: (tx: Tx, held: { found: Set<string>; recheck: () => Promise<void> }) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const want = await reach(deps.db);
    try {
      return await writeTx(deps.db, async (tx) => {
        const found = await baseLocks.databases(tx, want);
        const recheck = async () => {
          if ((await reach(tx)).some((id) => !want.includes(id))) throw new Regrown();
        };
        return fn(tx, { found, recheck });
      });
    } catch (err) {
      if (!(err instanceof Regrown)) throw err;
      if (attempt >= 3) throw busy();
    }
  }
}

/** The databases a write on these sources reaches: their owners, then every database with a view of them. */
async function reachOfSources(q: Db | Tx, owner: string, tableIds: readonly string[]): Promise<string[]> {
  if (!tableIds.length) return [owner];
  const viewers = await q
    .select({ id: dbViews.databaseId })
    .from(dbViews)
    .where(inArray(dbViews.tableId, [...tableIds]));
  return [owner, ...viewers.map((v) => v.id)];
}

/**
 * The databases deleting `id` reaches: itself, the owners of the sources its views show (their views go by
 * cascade too) and every database with a view of its own sources.
 */
async function reachOfDatabase(q: Db | Tx, id: string): Promise<string[]> {
  const shown = await q
    .select({ owner: dbTables.databaseId })
    .from(dbViews)
    .innerJoin(dbTables, eq(dbTables.id, dbViews.tableId))
    .where(eq(dbViews.databaseId, id));
  const own = await q.select({ id: dbTables.id }).from(dbTables).where(eq(dbTables.databaseId, id));
  return [
    ...(await reachOfSources(
      q,
      id,
      own.map((t) => t.id),
    )),
    ...shown.map((s) => s.owner),
  ];
}

// ---------- database ----------

export interface CreateDatabaseInput {
  workspaceId: string;
  title: string;
  icon?: string | null;
  pageSlug?: string | null;
  linkedTableId?: string | null;
  actor: ActorRef;
  /** Initial schema (an import); without it, only the title property. */
  defs?: PropDef[];
  titlePropId?: string;
  titleName?: string;
  sourceFileId?: string;
  /** Initial rows (CSV, Drive): they go in the same transaction as the database, or nothing stays. */
  rows?: Props[];
}

export async function createDatabase(deps: AppDeps, input: CreateDatabaseInput) {
  const { db } = deps;
  let pageId: string | null = null;
  if (input.pageSlug) {
    const [page] = await db
      .select({ id: knowledgePages.id })
      .from(knowledgePages)
      // A page in the trash gets no new base: it leaves the lists as if it didn't exist.
      .where(
        and(
          eq(knowledgePages.slug, input.pageSlug),
          eq(knowledgePages.workspaceId, input.workspaceId),
          isNull(knowledgePages.deletedAt),
        ),
      );
    if (!page) throw notFound("Page not found");
    pageId = page.id;
  }
  let linked: TableRow | null = null;
  if (input.linkedTableId) {
    const [found] = await db
      .select()
      .from(dbTables)
      .where(and(eq(dbTables.id, input.linkedTableId), eq(dbTables.workspaceId, input.workspaceId)));
    if (!found) throw notFound("Table not found");
    linked = found;
  }
  const id = newId("dbs");
  const tableId = newId("dbt");
  const titlePropId = input.titlePropId ?? newPropId();
  const defs = input.defs ?? [
    { id: titlePropId, name: input.titleName?.trim() || "Name", type: "text" as const },
  ];
  const at = deps.now();
  const w = input.rows?.length
    ? { actor: input.actor, names: await namesOf(db, input.workspaceId), at }
    : null;
  const { row, table, inserted } = await writeTx(db, async (tx) => {
    // a linked database: the source's database is locked, then the source read again (the lock order): a
    // delete of it meanwhile waits, then this answers 404 instead of a view pointing at nothing
    if (linked) {
      await baseLocks.databases(tx, [linked.databaseId]);
      const [source] = await tx
        .select({ id: dbTables.id })
        .from(dbTables)
        .where(eq(dbTables.id, linked.id))
        .for("share");
      if (!source) throw notFound("Table not found");
    }
    const [created] = await tx
      .insert(dbDatabases)
      .values({
        id,
        workspaceId: input.workspaceId,
        title: input.title,
        icon: input.icon ?? null,
        kind: linked ? "linked" : "database",
        pageId,
        sourceFileId: input.sourceFileId ?? null,
        createdBy: input.actor,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    let table: TableRow | null = null;
    if (!linked) {
      const [own] = await tx
        .insert(dbTables)
        .values({
          id: tableId,
          workspaceId: input.workspaceId,
          databaseId: id,
          name: input.title,
          defs: withResultTypes(defs),
          titlePropId,
          calcDay: today(deps),
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      table = own ?? null;
    }
    await tx.insert(dbViews).values({
      id: newId("dbv"),
      workspaceId: input.workspaceId,
      databaseId: id,
      tableId: linked?.id ?? tableId,
      name: "",
      type: "table",
      position: keyBetween(null, null),
      config: {},
      createdAt: at,
      updatedAt: at,
    });
    const inserted =
      table && w && input.rows
        ? await insertRowsTx(
            tx,
            table,
            input.rows.map((props) => ({ props })),
            w,
          )
        : [];
    if (!created) throw notFound("Database not found");
    return { row: created, table, inserted };
  });
  deps.hub.toWorkspace(input.workspaceId, { type: "base.created", baseId: row.id });
  if (table && w && inserted.length) {
    publishRows(deps, input.workspaceId, table, { rowIds: [], by: input.actor });
    await indexRows(deps, inserted);
  }
  return row;
}

export async function touchDatabase(db: Db, id: string, at: Date) {
  await db.update(dbDatabases).set({ updatedAt: at }).where(eq(dbDatabases.id, id));
}

// ---------- references outside the row (person, file) ----------

/** A person must be a member or an agent of the workspace; a file, the workspace's Drive's and out of the trash. */
async function checkRefs(
  db: Tx,
  workspaceId: string,
  defs: readonly PropDef[],
  write: Props,
): Promise<PropError[]> {
  const errors: PropError[] = [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const people = new Set<string>();
  const bots = new Set<string>();
  const fileIds = new Set<string>();
  for (const [id, v] of Object.entries(write)) {
    const def = byId.get(id);
    if (!def || v === null) continue;
    if (def.type === "person") {
      for (const a of v as ActorRef[]) (a.type === "person" ? people : bots).add(a.id);
    } else if (def.type === "file") for (const f of v as string[]) fileIds.add(f);
  }
  const okPeople = people.size
    ? new Set(
        (
          await db
            .select({ id: members.userId })
            .from(members)
            .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, [...people])))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const okBots = bots.size
    ? new Set(
        (
          await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, [...bots])))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const okFiles = fileIds.size
    ? new Set(
        (
          await db
            .select({ id: files.id })
            .from(files)
            .where(
              and(
                eq(files.workspaceId, workspaceId),
                inArray(files.id, [...fileIds]),
                isNull(files.deletedAt),
              ),
            )
        ).map((r) => r.id),
      )
    : new Set<string>();
  for (const [id, v] of Object.entries(write)) {
    const def = byId.get(id);
    if (!def || v === null) continue;
    if (
      def.type === "person" &&
      (v as ActorRef[]).some((a) => !(a.type === "person" ? okPeople : okBots).has(a.id))
    ) {
      errors.push({ propId: id, code: "invalid" });
    }
    if (def.type === "file" && (v as string[]).some((f) => !okFiles.has(f)))
      errors.push({ propId: id, code: "invalid" });
  }
  return errors;
}

async function validWrite(
  db: Tx,
  table: TableRow,
  current: Props,
  write: Record<string, unknown>,
): Promise<Props> {
  const applied = applyProps(table.defs, current, write);
  if (!applied.ok) throw bad("base.invalid_props", "Invalid property values", { errors: applied.errors });
  const refErrors = [
    ...(await checkRefs(db, table.workspaceId, table.defs, write as Props)),
    ...(await checkRelationIds(db, table, current, write as Props)),
  ];
  if (refErrors.length) throw bad("base.invalid_props", "Invalid property values", { errors: refErrors });
  return applied.props;
}

// ---------- position ----------

async function positionOf(tx: Tx | Db, tableId: string, rowId: string): Promise<string> {
  const [r] = await tx
    .select({ position: dbRows.position })
    .from(dbRows)
    .where(and(eq(dbRows.id, rowId), eq(dbRows.tableId, tableId)));
  if (!r) throw bad("base.bad_position", "Neighbor row not found");
  return r.position;
}

const C = (col: typeof dbRows.position) => sql`${col} collate "C"`;

/**
 * The key for the row to go after `afterId`, before `beforeId` or at the end. The neighbor on the other side
 * is the next different key: two rows with the same key (inserted at the same time) don't get stuck.
 */
async function positionFor(
  tx: Tx | Db,
  tableId: string,
  where: { afterId?: string | null; beforeId?: string | null; selfId?: string },
): Promise<string> {
  const others = where.selfId ? sql`${dbRows.id} <> ${where.selfId}` : sql`true`;
  if (where.afterId) {
    const a = await positionOf(tx, tableId, where.afterId);
    const [next] = await tx
      .select({ p: dbRows.position })
      .from(dbRows)
      .where(and(eq(dbRows.tableId, tableId), sql`${C(dbRows.position)} > ${a} collate "C"`, others))
      .orderBy(C(dbRows.position))
      .limit(1);
    return keyBetween(a, next?.p ?? null);
  }
  if (where.beforeId) {
    const b = await positionOf(tx, tableId, where.beforeId);
    const [prev] = await tx
      .select({ p: dbRows.position })
      .from(dbRows)
      .where(and(eq(dbRows.tableId, tableId), sql`${C(dbRows.position)} < ${b} collate "C"`, others))
      .orderBy(sql`${C(dbRows.position)} desc`)
      .limit(1);
    return keyBetween(prev?.p ?? null, b);
  }
  const [last] = await tx
    .select({ p: dbRows.position })
    .from(dbRows)
    .where(and(eq(dbRows.tableId, tableId), others))
    .orderBy(sql`${C(dbRows.position)} desc`)
    .limit(1);
  return keyBetween(last?.p ?? null, null);
}

// ---------- formulas ----------

function today(deps: AppDeps): string {
  return deps.now().toISOString().slice(0, 10);
}

/** Keeps each formula's inferred type in its definition (the filter, the order and the grid use it). */
function withResultTypes(defs: PropDef[]): PropDef[] {
  const plan = planFormulas(defs);
  return defs.map((d) =>
    d.type === "formula" && d.formula
      ? {
          ...d,
          formula: {
            expression: d.formula.expression,
            resultType: resultTypeOf(plan.types.get(d.id) ?? { k: "any" }),
          },
        }
      : d,
  );
}

type CalcRow = {
  id: string;
  props: Props;
  createdAt: Date;
  createdBy: ActorRef;
  editedAt: Date;
  editedBy: ActorRef;
};

/** A row's rollups and formulas, with the linked rows already loaded (`loadLinked`): the linked values first. */
function computeRow(
  table: TableRow,
  row: CalcRow,
  ctx: { now: number; names: Names; linked: Linked },
): Record<string, unknown> {
  const plan = planFormulas(table.defs);
  const links = linkedValues(table.defs, row.props, ctx.linked, ctx.names);
  if (!plan.order.length && !plan.errors.size) return links.computed;
  const formulas = evaluateRow(
    plan,
    table.defs,
    {
      id: row.id,
      props: row.props,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      editedAt: row.editedAt.toISOString(),
      editedBy: row.editedBy,
      extra: links.extra,
    },
    { now: ctx.now, names: ctx.names },
  ).computed;
  return { ...links.computed, ...formulas };
}

/**
 * What a dependent source can read of the row changed: a stored value, or a formula a rollup can read
 * (`rollupReadable`). A rollup and a formula over a relation can't be read across, so their change alone
 * notifies no one: that is what ends the propagation.
 */
function readableMoved(
  table: TableRow,
  before: { props: Props; computed: Record<string, unknown> },
  after: { props: Props; computed: Record<string, unknown> },
): boolean {
  if (JSON.stringify(before.props) !== JSON.stringify(after.props)) return true;
  const plan = planFormulas(table.defs);
  return plan.order.some(
    (f) =>
      rollupReadable(table.defs, f.propId, plan) &&
      JSON.stringify(before.computed[f.propId]) !== JSON.stringify(after.computed[f.propId]),
  );
}

// ---------- rows ----------

export interface RowWrite {
  props?: Record<string, unknown>;
  body?: string;
  afterId?: string | null;
  beforeId?: string | null;
}

/** Who writes, the names for the formulas and the time: read before the transaction. */
interface WriteCtx {
  actor: ActorRef;
  names: Names;
  at: Date;
}

/**
 * Locks the source until the commit. Creating a row, importing and undoing go through here: the row cap and
 * the schema read stay valid until the write (without it, 20 creations at the same time went past the cap).
 * Lock order: the source before its database's row, and the source before a row, everywhere.
 */
async function lockTable(tx: Tx, tableId: string): Promise<TableRow> {
  const [t] = await tx.select().from(dbTables).where(eq(dbTables.id, tableId)).for("update");
  if (!t) throw notFound("Table not found");
  return t;
}

async function rowTotal(tx: Tx, tableId: string): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(dbRows).where(eq(dbRows.tableId, tableId));
  return Number(r?.n ?? 0);
}

function checkBody(body: string | undefined | null) {
  if (body && body.length > MAX_BODY) throw bad("base.body_too_long", "Body too long");
}

/** Creates a row inside the caller's transaction, with the source already locked (no event or search). */
async function createRowTx(tx: Tx, table: TableRow, input: RowWrite, w: WriteCtx): Promise<RowRow> {
  if ((await rowTotal(tx, table.id)) >= MAX_ROWS)
    throw conflict("base.too_many_rows", "This database is full", { max: MAX_ROWS });
  checkBody(input.body);
  const props = await validWrite(tx, table, {}, input.props ?? {});
  const id = newId("dbr");
  const position = await positionFor(tx, table.id, input);
  const computed = computeRow(
    table,
    { id, props, createdAt: w.at, createdBy: w.actor, editedAt: w.at, editedBy: w.actor },
    { now: w.at.getTime(), names: w.names, linked: await loadLinked(tx, table, [{ props }]) },
  );
  const [created] = await tx
    .insert(dbRows)
    .values({
      id,
      workspaceId: table.workspaceId,
      tableId: table.id,
      position,
      props,
      computed,
      body: input.body ?? null,
      calcVersion: table.calcVersion,
      createdBy: w.actor,
      editedBy: w.actor,
      createdAt: w.at,
      editedAt: w.at,
    })
    .returning();
  await noteChanged(tx, table, [id]);
  return created as RowRow;
}

export async function createRow(
  deps: AppDeps,
  table: TableRow,
  input: RowWrite & { actor: ActorRef },
  names?: Names,
): Promise<RowRow> {
  const { db } = deps;
  checkBody(input.body);
  const w = { actor: input.actor, names: names ?? (await namesOf(db, table.workspaceId)), at: deps.now() };
  const row = await writeTx(db, async (tx) => createRowTx(tx, await lockTable(tx, table.id), input, w));
  publishRows(deps, table.workspaceId, table, { rowIds: [row.id], by: input.actor });
  await indexRows(deps, [row]);
  await settleLinks(deps, true);
  return row;
}

/** Edits a row inside the caller's transaction (no event or search). */
async function updateRowTx(
  tx: Tx,
  table: TableRow,
  rowId: string,
  input: RowWrite & { parentVersion?: number },
  w: WriteCtx,
): Promise<{ row: RowRow; before: RowRow }> {
  checkBody(input.body);
  // the source shared before the row (the lock order): a schema save waits, so the values are checked
  // against the schema that is there at the commit
  const [fresh] = await tx.select().from(dbTables).where(eq(dbTables.id, table.id)).for("share");
  if (!fresh) throw notFound("Table not found");
  const [current] = await tx
    .select()
    .from(dbRows)
    .where(and(eq(dbRows.id, rowId), eq(dbRows.tableId, table.id)))
    .for("update");
  if (!current) throw notFound("Row not found");
  if (input.parentVersion !== undefined && input.parentVersion !== current.version) {
    throw conflict("base.row_conflict", "Someone saved this row after you read it", {
      row: toRow(current, table.databaseId),
    });
  }
  // the row leaves with the source's calc_version, so the recalculation won't go over it again: if it was
  // still stale, the values that didn't change have to go to the new type here, as the recalculation would
  const was =
    current.calcVersion < fresh.calcVersion ? normalizeRowProps(fresh.defs, current.props) : current.props;
  const props = input.props ? await validWrite(tx, fresh, was, input.props) : was;
  const moved = input.afterId || input.beforeId;
  const position = moved
    ? await positionFor(tx, fresh.id, { ...input, selfId: current.id })
    : current.position;
  const computed = computeRow(
    fresh,
    {
      id: current.id,
      props,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      editedAt: w.at,
      editedBy: w.actor,
    },
    { now: w.at.getTime(), names: w.names, linked: await loadLinked(tx, fresh, [{ props }]) },
  );
  const [saved] = await tx
    .update(dbRows)
    .set({
      props,
      computed,
      position,
      ...(input.body !== undefined ? { body: input.body || null } : {}),
      version: current.version + 1,
      calcVersion: fresh.calcVersion,
      editedBy: w.actor,
      editedAt: w.at,
    })
    .where(eq(dbRows.id, current.id))
    .returning();
  await noteChanged(tx, fresh, [current.id]);
  return { row: saved as RowRow, before: current };
}

export async function updateRow(
  deps: AppDeps,
  table: TableRow,
  rowId: string,
  input: RowWrite & { actor: ActorRef; parentVersion?: number },
  names?: Names,
): Promise<{ row: RowRow; before: RowRow }> {
  const { db } = deps;
  checkBody(input.body);
  const w = { actor: input.actor, names: names ?? (await namesOf(db, table.workspaceId)), at: deps.now() };
  const result = await writeTx(db, async (tx) => updateRowTx(tx, table, rowId, input, w));
  publishRows(deps, table.workspaceId, table, { rowIds: [rowId], by: input.actor });
  await indexRows(deps, [result.row]);
  await settleLinks(deps, true);
  return result;
}

/** Deletes rows inside the caller's transaction and takes them out of the search in the same commit. */
async function deleteRowsTx(tx: Tx, table: TableRow, rowIds: string[]): Promise<RowRow[]> {
  if (!rowIds.length) return [];
  const gone = await tx
    .delete(dbRows)
    .where(and(eq(dbRows.tableId, table.id), inArray(dbRows.id, rowIds)))
    .returning();
  await unindexMany(
    tx,
    "db_row",
    gone.map((r) => r.id),
  );
  await noteChanged(
    tx,
    table,
    gone.map((r) => r.id),
  );
  return gone;
}

export async function deleteRows(deps: AppDeps, table: TableRow, rowIds: string[], actor: ActorRef) {
  if (!rowIds.length) return [];
  const gone = await writeTx(deps.db, async (tx) => deleteRowsTx(tx, table, rowIds));
  publishRows(deps, table.workspaceId, table, { deleted: gone.map((r) => r.id), by: actor });
  await settleLinks(deps, true);
  return gone;
}

// ---------- search ----------

/**
 * Reindexes the rows from the database after the commit (search-index.ts reads each locked row again, so a
 * delete that commits first leaves nothing behind). An index failure stays in the log; the boot's backfill
 * completes it.
 */
async function indexRows(deps: AppDeps, rows: readonly Pick<RowRow, "id">[]) {
  await reindexRows(
    deps,
    rows.map((r) => r.id),
  );
}

/**
 * Many rows at the end of the source, in batches, inside the caller's transaction: either all go in or none
 * does (importing again after a failure doesn't duplicate). `props` already validated against `table`.
 */
async function insertRowsTx(
  tx: Tx,
  table: TableRow,
  rows: { props: Props; body?: string | null }[],
  w: WriteCtx,
): Promise<RowRow[]> {
  if (!rows.length) return [];
  if ((await rowTotal(tx, table.id)) + rows.length > MAX_ROWS) {
    throw conflict("base.too_many_rows", "This database would pass the row limit", { max: MAX_ROWS });
  }
  const [last] = await tx
    .select({ p: dbRows.position })
    .from(dbRows)
    .where(eq(dbRows.tableId, table.id))
    .orderBy(sql`${C(dbRows.position)} desc`)
    .limit(1);
  const keys = keysBetween(last?.p ?? null, null, rows.length);
  const inserted: RowRow[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const linked = await loadLinked(tx, table, rows.slice(i, i + BATCH));
    const chunk = rows.slice(i, i + BATCH).map((r, j) => {
      const id = newId("dbr");
      return {
        id,
        workspaceId: table.workspaceId,
        tableId: table.id,
        position: keys[i + j] as string,
        props: r.props,
        computed: computeRow(
          table,
          { id, props: r.props, createdAt: w.at, createdBy: w.actor, editedAt: w.at, editedBy: w.actor },
          { now: w.at.getTime(), names: w.names, linked },
        ),
        body: r.body ?? null,
        calcVersion: table.calcVersion,
        createdBy: w.actor,
        editedBy: w.actor,
        createdAt: w.at,
        editedAt: w.at,
      };
    });
    inserted.push(...((await tx.insert(dbRows).values(chunk).returning()) as RowRow[]));
  }
  await noteChanged(
    tx,
    table,
    inserted.map((r) => r.id),
  );
  return inserted;
}

/**
 * Several row writes of the same source in one transaction, with the source locked before the rows: the undo
 * and redo of the agent's writes and the grid's bulk write. Returns the rows written, in order.
 */
export async function rewriteRows(
  deps: AppDeps,
  table: TableRow,
  actor: ActorRef,
  plan: (ops: {
    tx: Tx;
    table: TableRow;
    update: (rowId: string, input: RowWrite & { parentVersion?: number }) => Promise<RowRow>;
    create: (input: RowWrite) => Promise<RowRow>;
    remove: (rowIds: string[]) => Promise<RowRow[]>;
  }) => Promise<void>,
): Promise<RowRow[]> {
  const w = { actor, names: await namesOf(deps.db, table.workspaceId), at: deps.now() };
  const touched: RowRow[] = [];
  const gone: string[] = [];
  await writeTx(deps.db, async (tx) => {
    const fresh = await lockTable(tx, table.id);
    await plan({
      tx,
      table: fresh,
      update: async (rowId, input) => {
        const { row } = await updateRowTx(tx, fresh, rowId, input, w);
        touched.push(row);
        return row;
      },
      create: async (input) => {
        const row = await createRowTx(tx, fresh, input, w);
        touched.push(row);
        return row;
      },
      remove: async (rowIds) => {
        const rows = await deleteRowsTx(tx, fresh, rowIds);
        gone.push(...rows.map((r) => r.id));
        return rows;
      },
    });
  });
  publishRows(deps, table.workspaceId, table, { rowIds: touched.map((r) => r.id), deleted: gone, by: actor });
  await indexRows(deps, touched);
  await settleLinks(deps, true);
  return touched;
}

// ---------- the grid's bulk write ----------

/** Cap of the grid's bulk write (a paste, the fill handle, clearing a range): rows and cells per request. */
export const MAX_BULK_ROWS = 500;
export const MAX_BULK_CELLS = 5_000;

export interface BulkOp {
  /** Without an id: a new row at the end of the source. */
  rowId?: string;
  parentVersion?: number;
  /** Values already in the column's type (the fill handle, clearing). */
  props?: Record<string, unknown>;
  /** Pasted text, converted by the column's type as in the CSV; empty clears the cell. */
  text?: Record<string, string>;
}

const badBulk = (message: string, params?: Record<string, unknown>) => bad("base.bad_bulk", message, params);

/**
 * Writes a bulk of the grid in one transaction: all goes in, or nothing does (an old version of one row
 * answers 409 and undoes the rest). The caps, a row twice and the row cap of the source are rejected before
 * anything is written. Text that doesn't fit the type, or that falls on a computed column, is skipped and
 * counted, as in the import; an invalid typed value answers 400.
 */
export async function bulkRows(
  deps: AppDeps,
  table: TableRow,
  ops: BulkOp[],
  actor: ActorRef,
): Promise<{ rows: RowRow[]; skipped: number }> {
  if (ops.length > MAX_BULK_ROWS) throw badBulk("Too many rows", { max: MAX_BULK_ROWS });
  const cells = ops.reduce(
    (n, op) => n + Object.keys(op.props ?? {}).length + Object.keys(op.text ?? {}).length,
    0,
  );
  if (cells > MAX_BULK_CELLS) throw badBulk("Too many cells", { max: MAX_BULK_CELLS });
  const ids = ops.flatMap((op) => (op.rowId ? [op.rowId] : []));
  if (new Set(ids).size !== ids.length) throw badBulk("The same row twice in one bulk write");
  const creates = ops.length - ids.length;
  let skipped = 0;
  const rows = await rewriteRows(deps, table, actor, async ({ tx, table: fresh, update, create }) => {
    if (creates && (await rowTotal(tx, fresh.id)) + creates > MAX_ROWS)
      throw conflict("base.too_many_rows", "This database would pass the row limit", { max: MAX_ROWS });
    for (const op of ops) {
      const write: Record<string, unknown> = { ...op.props };
      for (const [propId, text] of Object.entries(op.text ?? {})) {
        const def = fresh.defs.find((d) => d.id === propId);
        if (!def)
          throw bad("base.invalid_props", "Invalid property values", {
            errors: [{ propId, code: "unknown_prop" }],
          });
        if (COMPUTED_TYPES.has(def.type)) {
          skipped++;
          continue;
        }
        if (!text.trim()) {
          write[propId] = null;
          continue;
        }
        const value = parsePropText(def, text);
        const ok = value === undefined ? null : applyProps([def], {}, { [def.id]: value });
        if (ok?.ok && ok.props[def.id] !== undefined) write[propId] = ok.props[def.id];
        else skipped++;
      }
      if (op.rowId)
        await update(op.rowId, {
          props: write,
          ...(op.parentVersion !== undefined ? { parentVersion: op.parentVersion } : {}),
        });
      else await create({ props: write });
    }
  });
  return { rows, skipped };
}

// ---------- schema ----------

const OPTION_TYPES = new Set(["select", "multi_select", "status"]);

/** What changes a computed or stored value, or the row's searchable text. */
function calcSignature(defs: readonly PropDef[]): string {
  return JSON.stringify(
    defs.map((d) => [
      d.id,
      d.name,
      d.type,
      d.options?.map((o) => [o.id, o.name]) ?? null,
      d.groups ?? null,
      d.formula?.expression ?? null,
      d.withTime ?? null,
      d.relation?.tableId ?? null,
      d.rollup ? [d.rollup.relationPropId, d.rollup.targetPropId, d.rollup.fn] : null,
    ]),
  );
}

/**
 * Saves a source's whole schema. `parentVersion` is the version read (409 if it changed). Formulas are kept
 * with their references by id; a type that starts having options gets the options of the current values.
 */
export async function saveSchema(
  deps: AppDeps,
  table: TableRow,
  input: { defs: PropDef[]; parentVersion: number },
): Promise<TableRow> {
  const at = deps.now();
  const saved = await lockedTx(
    deps,
    (q) => reachOfSources(q, table.databaseId, [table.id]),
    (tx, held) => writeSchemaTx(tx, deps, table, input.defs, input.parentVersion, at, held.recheck),
  );
  return afterSchema(deps, saved);
}

type PreparedSchema = { defs: PropDef[]; recalc: boolean };

/** Validates the schema and puts it in the stored shape (formula by id, options from the values, result type). */
async function prepareSchema(db: Db | Tx, table: TableRow, input: PropDef[]): Promise<PreparedSchema> {
  const problems = checkDefs(input);
  if (problems.length) throw bad("base.invalid_schema", "Invalid schema", { problems });
  const title = input.find((d) => d.id === table.titlePropId);
  if (title?.type !== "text") throw bad("base.title_required", "The title property must stay as text");
  // references by name become references by id (renaming later doesn't break the formula)
  let defs: PropDef[] = input.map((d) =>
    d.type === "formula" && d.formula
      ? {
          ...d,
          formula: {
            expression: rewritePropRefs(d.formula.expression, (ref) =>
              input.some((x) => x.id === ref)
                ? undefined
                : (
                    input.find((x) => x.name === ref) ??
                    input.find((x) => x.name.toLowerCase() === ref.toLowerCase())
                  )?.id,
            ),
          },
        }
      : d,
  );
  defs = await withOptionsFromValues(db, table, defs);
  defs = withResultTypes(defs);
  const linked = await withRollupTypes(db, table, defs);
  // a relation or a rollup saved before stays as it was when its source went away (the cell shows the
  // error): only a new or changed one has to close
  const unclosed = linked.problems.filter((p) => {
    const before = table.defs.find((d) => d.id === p.propId);
    const now = defs.find((d) => d.id === p.propId);
    return !before || JSON.stringify(linkShape(before)) !== JSON.stringify(now && linkShape(now));
  });
  if (unclosed.length) throw bad("base.invalid_schema", "Invalid schema", { problems: unclosed });
  defs = linked.defs;
  return { defs, recalc: calcSignature(defs) !== calcSignature(table.defs) };
}

/** What a relation or a rollup points to (their name, their color and the result type don't count). */
function linkShape(d: PropDef) {
  return [
    d.type,
    d.relation?.tableId ?? null,
    d.rollup ? [d.rollup.relationPropId, d.rollup.targetPropId, d.rollup.fn] : null,
  ];
}

/**
 * Saves the schema with the source locked and prunes the views, inside the caller's transaction, which holds
 * the source's database and every database with a view of it (`reachOfSources`, through `lockedTx`).
 */
async function writeSchemaTx(
  tx: Tx,
  deps: AppDeps,
  table: TableRow,
  input: PropDef[],
  parentVersion: number,
  at: Date,
  recheck: () => Promise<void>,
): Promise<{ table: TableRow; touched: Set<string>; recalc: boolean }> {
  const current = await lockTable(tx, table.id);
  await recheck();
  if (current.schemaVersion !== parentVersion) {
    throw conflict("base.schema_conflict", "Someone changed the properties after you read them", {
      table: toTable(current),
    });
  }
  const { defs, recalc } = await prepareSchema(tx, current, input);
  const [row] = await tx
    .update(dbTables)
    .set({
      defs,
      schemaVersion: current.schemaVersion + 1,
      ...(recalc ? { calcVersion: current.calcVersion + 1, calcDay: today(deps) } : {}),
      updatedAt: at,
    })
    .where(eq(dbTables.id, table.id))
    .returning();
  await tx.update(dbDatabases).set({ updatedAt: at }).where(eq(dbDatabases.id, table.databaseId));
  const touched = new Set([table.databaseId]);
  for (const v of await tx.select().from(dbViews).where(eq(dbViews.tableId, table.id))) {
    const pruned = pruneConfig(v.config, defs);
    if (JSON.stringify(pruned) === JSON.stringify(v.config)) continue;
    await tx.update(dbViews).set({ config: pruned, updatedAt: at }).where(eq(dbViews.id, v.id));
    touched.add(v.databaseId);
  }
  return { table: row as TableRow, touched, recalc };
}

/** After the commit: the recalculation, the events and the source as it ended up. */
async function afterSchema(
  deps: AppDeps,
  saved: { table: TableRow; touched: Set<string>; recalc: boolean },
): Promise<TableRow> {
  if (saved.recalc) await recalcPolicy(deps, saved.table);
  // whoever sums or reads this source by a relation recalculates whole: the target may have changed type or gone
  if (saved.recalc) for (const id of await refreshDependents(deps, saved.table)) saved.touched.add(id);
  for (const id of saved.touched) publishBase(deps, saved.table.workspaceId, id);
  const [after] = await deps.db.select().from(dbTables).where(eq(dbTables.id, saved.table.id));
  return after ?? saved.table;
}

/**
 * An import into a source that already exists: the new columns and the rows go in the same transaction, so a
 * rejected row (the cap, a value the database doesn't take) leaves no column behind. `rows` gets the source
 * already with the new schema.
 */
export async function importRows(
  deps: AppDeps,
  table: TableRow,
  input: { defs: PropDef[] | null; rows: (table: TableRow) => Props[]; actor: ActorRef },
): Promise<{ table: TableRow; created: number }> {
  const w = { actor: input.actor, names: await namesOf(deps.db, table.workspaceId), at: deps.now() };
  const done = await lockedTx(
    deps,
    // without new columns the import writes rows only: no database to lock
    async (q) => (input.defs ? reachOfSources(q, table.databaseId, [table.id]) : []),
    async (tx, held) => {
      const saved = input.defs
        ? await writeSchemaTx(tx, deps, table, input.defs, table.schemaVersion, w.at, held.recheck)
        : null;
      const fresh = saved?.table ?? (await lockTable(tx, table.id));
      if (fresh.schemaVersion !== (saved ? table.schemaVersion + 1 : table.schemaVersion))
        throw conflict("base.schema_conflict", "Someone changed the properties during the import", {
          table: toTable(fresh),
        });
      const rows = input.rows(fresh).map((props) => ({ props }));
      return { saved, fresh, inserted: await insertRowsTx(tx, fresh, rows, w) };
    },
  );
  const after = done.saved ? await afterSchema(deps, done.saved) : done.fresh;
  if (done.inserted.length) {
    publishRows(deps, table.workspaceId, after, { rowIds: [], by: input.actor });
    await indexRows(deps, done.inserted);
    await settleLinks(deps, true);
  }
  return { table: after, created: done.inserted.length };
}

/** A property that becomes select/multi/status without options gets one option per distinct value (up to 200). */
async function withOptionsFromValues(db: Db | Tx, table: TableRow, defs: PropDef[]): Promise<PropDef[]> {
  const out: PropDef[] = [];
  for (const d of defs) {
    const old = table.defs.find((x) => x.id === d.id);
    if (!old || old.type === d.type || !OPTION_TYPES.has(d.type) || d.options?.length) {
      out.push(d);
      continue;
    }
    const values = await db
      .selectDistinct({ v: sql<unknown>`${dbRows.props} -> ${d.id}::text` })
      .from(dbRows)
      .where(and(eq(dbRows.tableId, table.id), sql`(${dbRows.props} -> ${d.id}::text) is not null`))
      .limit(1000);
    const names = new Set<string>();
    for (const { v } of values) {
      const text =
        old.type === "select" || old.type === "status" || old.type === "multi_select"
          ? optionNames(old, v)
          : rawText(v).split(d.type === "multi_select" ? "," : "\u0000");
      for (const name of text.map((t) => t.trim()).filter(Boolean))
        if (names.size < 200) names.add(name.slice(0, 100));
    }
    const options = [...names].map(
      (name) => old.options?.find((o) => o.name === name) ?? { id: newOptionId(), name },
    );
    out.push({
      ...d,
      options,
      ...(d.type === "status"
        ? { groups: { todo: options.map((o) => o.id), inProgress: [], done: [] } }
        : {}),
    });
  }
  return out;
}

function optionNames(def: PropDef, v: unknown): string[] {
  const ids = Array.isArray(v) ? v.map(String) : [String(v)];
  return ids.map((id) => def.options?.find((o) => o.id === id)?.name ?? id);
}

/** Keep option IDs while adapting a single choice between scalar and list representations. */
function normalizeRowProps(defs: readonly PropDef[], props: Props): Props {
  const shaped = { ...props };
  for (const def of defs) {
    const value = props[def.id];
    if (def.type === "multi_select" && typeof value === "string" && def.options?.some((o) => o.id === value))
      shaped[def.id] = [value];
    else if (
      (def.type === "select" || def.type === "status") &&
      Array.isArray(value) &&
      value.length === 1 &&
      typeof value[0] === "string"
    )
      shaped[def.id] = value[0];
  }
  return normalizeProps(defs, shaped);
}

// ---------- recalculation ----------

const running = new WeakMap<AppDeps, Map<string, Promise<void>>>();
/** The propagations of the relations in progress (a request's, or a retry waiting for a held row). */
const settling = new WeakMap<AppDeps, Set<Promise<void>>>();
const halted = new WeakSet<AppDeps>();

/** One batch: up to 500 stale rows, locked without waiting for whoever is already on them. */
async function recalcBatch(
  deps: AppDeps,
  tableId: string,
  names: Names,
): Promise<{ done: boolean; changed: RowRow[]; busy?: boolean }> {
  const { db } = deps;
  return writeTx(db, async (tx) => {
    const [table] = await tx.select().from(dbTables).where(eq(dbTables.id, tableId));
    if (!table) return { done: true, changed: [] };
    const stale = await tx
      .select()
      .from(dbRows)
      .where(and(eq(dbRows.tableId, tableId), lt(dbRows.calcVersion, table.calcVersion)))
      .orderBy(asc(dbRows.id))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    if (!stale.length) {
      // "done" only if, in the same statement, no row is stale: a relation's propagation may have marked one
      // after the search above, and then its `least()` can't be undone by this update
      const [ok] = await tx
        .update(dbTables)
        .set({ calcDoneVersion: table.calcVersion })
        .where(
          and(
            eq(dbTables.id, tableId),
            eq(dbTables.calcVersion, table.calcVersion),
            sql`not exists (select 1 from ${dbRows} where ${dbRows.tableId} = ${tableId} and ${dbRows.calcVersion} < ${table.calcVersion})`,
          ),
        )
        .returning({ id: dbTables.id });
      if (ok) return { done: true, changed: [] };
      const [again] = await tx
        .select({ v: dbTables.calcVersion })
        .from(dbTables)
        .where(eq(dbTables.id, tableId));
      // the version moved (a new schema): another round; otherwise a stale row is held by another process
      return { done: false, changed: [], busy: again?.v === table.calcVersion };
    }
    const now = deps.now().getTime();
    const normalized = stale.map((r) => ({ ...r, props: normalizeRowProps(table.defs, r.props) }));
    const linked = await loadLinked(tx, table, normalized);
    const values = normalized.map((r, i) => {
      const old = stale[i] as RowRow;
      const changedProps = JSON.stringify(r.props) !== JSON.stringify(old.props);
      const computed = computeRow(table, r, { now, names, linked });
      const moved = readableMoved(table, old, { props: r.props, computed });
      return { id: r.id, props: r.props, computed, bump: changedProps ? 1 : 0, moved };
    });
    const rows = sql.join(
      values.map(
        (v) =>
          sql`(${v.id}::text, ${JSON.stringify(v.props)}::jsonb, ${JSON.stringify(v.computed)}::jsonb, ${v.bump}::int)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      update ${dbRows} as r
         set props = v.props, computed = v.computed, version = r.version + v.bump, calc_version = ${table.calcVersion}
        from (values ${rows}) as v(id, props, computed, bump)
       where r.id = v.id`);
    // only what dependents can read and that really changed notifies them: that is what ends the propagation
    await noteChanged(
      tx,
      table,
      values.filter((v) => v.moved).map((v) => v.id),
    );
    const changed = stale.map((r, i) => ({
      ...r,
      props: values[i]?.props ?? r.props,
      computed: values[i]?.computed ?? r.computed,
    }));
    return { done: false, changed };
  });
}

/** Recalculates until no stale row is left. Idempotent: running again changes nothing. */
export async function runRecalc(deps: AppDeps, tableId: string): Promise<void> {
  const [table] = await deps.db.select().from(dbTables).where(eq(dbTables.id, tableId));
  if (!table) return;
  const names = await namesOf(deps.db, table.workspaceId);
  let processed = 0;
  for (let spins = 0; !halted.has(deps); ) {
    const { done, changed, busy } = await recalcBatch(deps, tableId, names);
    if (done) break;
    if (!changed.length) {
      if (!busy) continue;
      // another process holds the rows left: wait a little and check again
      if (++spins > 50) break;
      await Bun.sleep(100);
      continue;
    }
    processed += changed.length;
    await indexRows(deps, changed);
    deps.hub.toWorkspace(table.workspaceId, {
      type: "base.recalc",
      baseId: table.databaseId,
      tableId,
      processed,
      done: false,
    });
  }
  const [after] = await deps.db.select().from(dbTables).where(eq(dbTables.id, tableId));
  if (after) {
    deps.hub.toWorkspace(after.workspaceId, {
      type: "base.recalc",
      baseId: after.databaseId,
      tableId,
      processed,
      done: after.calcDoneVersion >= after.calcVersion,
    });
    publishRows(deps, after.workspaceId, after, {});
  }
  // the dependents of this source recalculate in the background: waiting here could wait for itself
  await settleLinks(deps, false);
}

/**
 * Schedules a background recalculation of the source. It is the server's background work (`runtime.track`):
 * `settle` waits for it, and `stopRecalcs` halts it between two batches. With one already running, another
 * round is queued after it: the round in progress may have gone past the rows someone just marked.
 */
export function scheduleRecalc(deps: AppDeps, tableId: string): Promise<void> {
  let map = running.get(deps);
  if (!map) {
    map = new Map();
    running.set(deps, map);
  }
  const existing = map.get(tableId);
  const job = (async () => {
    if (existing) {
      await existing;
      if (halted.has(deps)) return;
      const [table] = await deps.db.select().from(dbTables).where(eq(dbTables.id, tableId));
      if (!table || table.calcDoneVersion >= table.calcVersion) return;
    }
    if (!halted.has(deps)) await runRecalc(deps, tableId);
  })()
    .catch((err) => log.error("base.recalc_failed", { tableId, err }))
    .finally(() => {
      if (map.get(tableId) === job) map.delete(tableId);
    });
  map.set(tableId, job);
  deps.runtime.track(job, "base.recalc");
  return job;
}

/** Small: recalculates now (the response goes out with everything right). Big: the background. */
async function recalcPolicy(deps: AppDeps, table: TableRow) {
  const n = (await rowCounts(deps.db, [table.id])).get(table.id) ?? 0;
  if (n <= INLINE_RECALC) await scheduleRecalc(deps, table.id);
  else void scheduleRecalc(deps, table.id);
}

/** A formula with now()/today() ages from one day to the next: the first query of the day recalculates. */
export async function refreshVolatile(deps: AppDeps, table: TableRow): Promise<TableRow> {
  const day = today(deps);
  if (table.calcDay === day || !planFormulas(table.defs).volatile) return table;
  const [bumped] = await deps.db
    .update(dbTables)
    .set({ calcVersion: sql`${dbTables.calcVersion} + 1`, calcDay: day })
    .where(and(eq(dbTables.id, table.id), sql`${dbTables.calcDay} is distinct from ${day}`))
    .returning();
  if (!bumped) return table;
  await recalcPolicy(deps, bumped);
  const [after] = await deps.db.select().from(dbTables).where(eq(dbTables.id, table.id));
  return after ?? bumped;
}

/** When the server starts: resumes the relations' notices and the recalculation left halfway (a crash, a deploy). */
export async function resumeRecalcs(deps: AppDeps) {
  await settleLinks(deps, false);
  const pending = await deps.db
    .select({ id: dbTables.id })
    .from(dbTables)
    .where(sql`${dbTables.calcDoneVersion} < ${dbTables.calcVersion}`);
  for (const t of pending) void scheduleRecalc(deps, t.id);
}

/**
 * Stops the recalculations (the server is about to close the database): each one ends after the batch it is
 * in, which commits whole, a propagation in progress ends its round, and a retry waiting for a held row
 * gives up. The rows left stay stale, and the notices left stay in the database, for `resumeRecalcs` on the
 * next start.
 */
export async function stopRecalcs(deps: AppDeps) {
  halted.add(deps);
  for (;;) {
    const jobs = [...(running.get(deps)?.values() ?? []), ...(settling.get(deps) ?? [])];
    if (!jobs.length) return;
    await Promise.allSettled(jobs);
  }
}

/** How long a notice left by a held row waits before the next try. */
export const LINK_RETRY_MS = 200;
/** Failed propagations in a row before the retries stop (the notice stays for later). */
export const MAX_LINK_FAILURES = 5;
const failures = new WeakMap<AppDeps, number>();

/**
 * After the commit: marks the rows that depend on what changed and recalculates their sources. `wait` (the
 * writer's request) recalculates the small sources now, as for the schema; without `wait` (inside a
 * recalculation, on the start) all goes to the background. A notice left by a held row, or a propagation that
 * failed (the write is committed: its error doesn't reach the writer), tries again in `LINK_RETRY_MS`.
 */
export function settleLinks(deps: AppDeps, wait: boolean): Promise<void> {
  if (halted.has(deps)) return Promise.resolve();
  const set = settling.get(deps) ?? new Set<Promise<void>>();
  settling.set(deps, set);
  const work: Promise<void> = (async () => {
    let pending = true;
    try {
      const done = await propagate(deps.db);
      pending = done.pending;
      for (const id of done.marked) {
        if (!wait) {
          void scheduleRecalc(deps, id);
          continue;
        }
        const [t] = await deps.db.select().from(dbTables).where(eq(dbTables.id, id));
        if (t) await recalcPolicy(deps, t);
      }
      failures.delete(deps);
    } catch (err) {
      // a failure that repeats (the database gone, a bug) stops trying after a few: the notice stays in the
      // database for the next write or the next start
      const n = (failures.get(deps) ?? 0) + 1;
      failures.set(deps, n);
      log.error("base.links_failed", { err, attempt: n });
      if (n >= MAX_LINK_FAILURES) {
        failures.delete(deps);
        pending = false;
      }
    }
    if (pending) retryLinks(deps);
  })().finally(() => set.delete(work));
  set.add(work);
  deps.runtime.track(work, "base.links");
  return work;
}

/** One retry at a time: it leaves the set before trying, so one that still finds a held row queues the next. */
const retries = new WeakMap<AppDeps, Promise<void>>();

function retryLinks(deps: AppDeps) {
  if (halted.has(deps) || retries.has(deps)) return;
  const set = settling.get(deps) ?? new Set<Promise<void>>();
  settling.set(deps, set);
  const retry: Promise<void> = Bun.sleep(LINK_RETRY_MS)
    .then(() => {
      retries.delete(deps);
      return settleLinks(deps, false);
    })
    .finally(() => set.delete(retry));
  retries.set(deps, retry);
  set.add(retry);
  deps.runtime.track(retry, "base.links");
}

/**
 * The schema of `table` changed: each source that reads this one by a relation recalculates whole (a rollup's
 * target may have changed type or gone) and gets its rollups' new result type, as a schema write of its own:
 * its database and the ones with a view of it locked first, then the source, read again under the lock (a
 * schema save of it meanwhile isn't overwritten). Returns the databases touched (for `base.updated`).
 */
async function refreshDependents(deps: AppDeps, table: Pick<TableRow, "id" | "workspaceId">) {
  const touched: string[] = [];
  for (const { table: y } of await dependentsOf(deps.db, table.workspaceId, table.id)) {
    if (y.id === table.id) continue;
    const saved = await lockedTx(
      deps,
      (q) => reachOfSources(q, y.databaseId, [y.id]),
      async (tx, held) => {
        const [current] = await tx.select().from(dbTables).where(eq(dbTables.id, y.id)).for("update");
        if (!current) return null;
        await held.recheck();
        const { defs } = await withRollupTypes(tx, current, current.defs);
        const changed = JSON.stringify(defs) !== JSON.stringify(current.defs);
        const at = deps.now();
        const [row] = await tx
          .update(dbTables)
          .set({
            ...(changed ? { defs, schemaVersion: current.schemaVersion + 1, updatedAt: at } : {}),
            calcVersion: current.calcVersion + 1,
          })
          .where(eq(dbTables.id, y.id))
          .returning();
        const views = new Set<string>();
        if (changed)
          for (const v of await tx.select().from(dbViews).where(eq(dbViews.tableId, y.id))) {
            const pruned = pruneConfig(v.config, defs);
            if (JSON.stringify(pruned) === JSON.stringify(v.config)) continue;
            await tx.update(dbViews).set({ config: pruned, updatedAt: at }).where(eq(dbViews.id, v.id));
            views.add(v.databaseId);
          }
        return row ? { row, changed, views } : null;
      },
    );
    if (!saved) continue;
    if (saved.changed) touched.push(saved.row.databaseId, ...saved.views);
    await recalcPolicy(deps, saved.row);
  }
  return touched;
}

// ---------- views ----------

/** A quick filter the schema accepts: the property exists, the operator fits and so does the value (if any). */
function quickOk(q: QuickFilter, defs: readonly PropDef[]): boolean {
  const def = defs.find((d) => d.id === q.prop);
  if (!def) return false;
  if (q.op && !(OPS_BY_KIND[filterKind(def)] as readonly string[]).includes(q.op)) return false;
  const cond = effectiveFilter({ quickFilters: [q] });
  return !cond || checkFilter(cond, defs).length === 0;
}

/**
 * The view's config without what the current schema doesn't accept. Saving the schema passes every view of
 * the source through here: a deleted column or a changed type doesn't leave a saved view that only errors.
 */
function pruneConfig(cfg: ViewConfig, defs: readonly PropDef[]): ViewConfig {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const known = (id: string | null | undefined) => id !== null && id !== undefined && byId.has(id);
  const out: ViewConfig = { ...cfg };
  if (cfg.filter) out.filter = pruneFilter(cfg.filter, defs);
  if (cfg.sorts) out.sorts = cfg.sorts.filter((s) => known(s.prop));
  if (cfg.groupBy) {
    const def = byId.get(cfg.groupBy.prop);
    if (!def || !groupable(def)) out.groupBy = null;
  }
  if (cfg.quickFilters) out.quickFilters = cfg.quickFilters.filter((q) => quickOk(q, defs));
  if (cfg.columns) out.columns = cfg.columns.filter((c) => known(c.prop));
  if (cfg.cover && !known(cfg.cover)) out.cover = null;
  if (cfg.dateProp && !known(cfg.dateProp)) out.dateProp = null;
  if (cfg.endProp && !known(cfg.endProp)) out.endProp = null;
  if (cfg.chart) {
    const chart = { ...cfg.chart };
    if (chart.x && !known(chart.x)) chart.x = null;
    if (chart.y && !known(chart.y)) chart.y = null;
    out.chart = chart;
  }
  if (cfg.formProps) out.formProps = cfg.formProps.filter(known);
  if (cfg.summaries)
    out.summaries = Object.fromEntries(Object.entries(cfg.summaries).filter(([k]) => known(k)));
  return out;
}

function validateViewConfig(config: unknown, table: TableRow): ViewConfig {
  const parsed = viewConfigSchema.safeParse(config ?? {});
  if (!parsed.success) throw bad("base.bad_view", "Invalid view settings");
  const cfg: ViewConfig = parsed.data;
  // the effective filter includes the quick filters with a value: what would error in the query isn't saved
  validateFilter(effectiveFilter(cfg), table.defs);
  validateSorts(cfg.sorts, table.defs);
  const known = new Set(table.defs.map((d) => d.id));
  const refs = [
    cfg.groupBy?.prop,
    cfg.cover,
    cfg.dateProp,
    cfg.endProp,
    cfg.chart?.x,
    cfg.chart?.y,
    ...(cfg.quickFilters ?? []).map((q) => q.prop),
  ].filter((x): x is string => typeof x === "string");
  const unknown = refs.filter((r) => !known.has(r));
  if (unknown.length) throw bad("base.bad_view", "Unknown property in view", { props: unknown });
  // the rest (a quick filter's operator without a value, grouping by multi or file, columns) by the same rule
  if (JSON.stringify(pruneConfig(cfg, table.defs)) !== JSON.stringify(cfg))
    throw bad("base.bad_view", "Invalid view settings");
  return cfg;
}

/** Reads the source again inside the transaction, under the locks: the schema a view is checked against. */
async function sourceNow(tx: Tx, tableId: string): Promise<TableRow> {
  const [table] = await tx.select().from(dbTables).where(eq(dbTables.id, tableId)).for("share");
  if (!table) throw notFound("Table not found");
  return table;
}

// A view belongs to its database and shows a source of maybe another one: deleting that source takes the view
// by cascade. So every view write locks both databases (own first; the lock sorts them), then reads the
// source and checks the settings against the schema that is there at the commit.

export async function createView(
  deps: AppDeps,
  database: DatabaseRow,
  table: TableRow,
  input: { name: string; type: BaseViewType; config?: unknown },
): Promise<ViewRow> {
  validateViewConfig(input.config, table);
  const at = deps.now();
  const view = await lockedTx(
    deps,
    async () => [database.id, table.databaseId],
    async (tx, held) => {
      if (!held.found.has(database.id)) throw notFound("Database not found");
      const source = await sourceNow(tx, table.id);
      const config = validateViewConfig(input.config, source);
      const existing = await tx
        .select({ position: dbViews.position })
        .from(dbViews)
        .where(eq(dbViews.databaseId, database.id))
        .orderBy(desc(sql`${dbViews.position} collate "C"`));
      if (existing.length >= MAX_VIEWS)
        throw conflict("base.too_many_views", "Too many views", { max: MAX_VIEWS });
      await baseLocks.pause("view:counted", tx);
      const [created] = await tx
        .insert(dbViews)
        .values({
          id: newId("dbv"),
          workspaceId: database.workspaceId,
          databaseId: database.id,
          tableId: table.id,
          name: input.name,
          type: input.type,
          position: keyBetween(existing[0]?.position ?? null, null),
          config,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      await tx.update(dbDatabases).set({ updatedAt: at }).where(eq(dbDatabases.id, database.id));
      if (!created) throw notFound("View not found");
      return created;
    },
  );
  publishBase(deps, database.workspaceId, database.id);
  return view;
}

export async function updateView(
  deps: AppDeps,
  database: DatabaseRow,
  view: ViewRow,
  table: TableRow,
  input: { name?: string; type?: BaseViewType; config?: unknown; afterId?: string | null },
): Promise<ViewRow> {
  if (input.config !== undefined) validateViewConfig(input.config, table);
  const saved = await lockedTx(
    deps,
    async () => [database.id, table.databaseId],
    async (tx) => {
      const patch: Partial<typeof dbViews.$inferInsert> = { updatedAt: deps.now() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.type !== undefined) patch.type = input.type;
      if (input.config !== undefined)
        patch.config = validateViewConfig(input.config, await sourceNow(tx, table.id));
      if (input.afterId !== undefined) {
        // the neighbors are read and the new key written with the database locked: two moves at once don't
        // compute their keys from the same neighbors
        const all = await tx
          .select({ id: dbViews.id, position: dbViews.position })
          .from(dbViews)
          .where(eq(dbViews.databaseId, database.id))
          .orderBy(sql`${dbViews.position} collate "C"`, dbViews.id);
        await baseLocks.pause("view:moving", tx);
        const rest = all.filter((v) => v.id !== view.id);
        const i = input.afterId === null ? -1 : rest.findIndex((v) => v.id === input.afterId);
        if (input.afterId !== null && i < 0) throw bad("base.bad_position", "View not found");
        const a = i >= 0 ? (rest[i]?.position ?? null) : null;
        let b = rest[i + 1]?.position ?? null;
        if (a !== null && b !== null && a >= b) b = null;
        patch.position = keyBetween(a, b);
      }
      const [row] = await tx
        .update(dbViews)
        .set(patch)
        .where(and(eq(dbViews.id, view.id), eq(dbViews.databaseId, database.id)))
        .returning();
      if (!row) throw notFound("View not found");
      return row;
    },
  );
  publishBase(deps, database.workspaceId, database.id);
  return saved;
}

export async function deleteView(deps: AppDeps, database: DatabaseRow, view: ViewRow) {
  const [source] = await deps.db
    .select({ owner: dbTables.databaseId })
    .from(dbTables)
    .where(eq(dbTables.id, view.tableId));
  await lockedTx(
    deps,
    async () => [database.id, ...(source ? [source.owner] : [])],
    async (tx) => {
      const [n] = await tx.select({ n: count() }).from(dbViews).where(eq(dbViews.databaseId, database.id));
      if (Number(n?.n ?? 0) <= 1) throw conflict("base.last_view", "A database needs at least one view");
      await baseLocks.pause("view:deleting", tx);
      await tx.delete(dbViews).where(and(eq(dbViews.id, view.id), eq(dbViews.databaseId, database.id)));
    },
  );
  publishBase(deps, database.workspaceId, database.id);
}

export async function viewIn(db: Db, database: DatabaseRow, viewId: string): Promise<ViewRow> {
  const [view] = await db
    .select()
    .from(dbViews)
    .where(and(eq(dbViews.id, viewId), eq(dbViews.databaseId, database.id)));
  if (!view) throw notFound("View not found");
  return view;
}

/**
 * Deletes a database. The views other databases had of its sources go by cascade, and so do its own views of
 * other databases' sources: every database reached (`reachOfDatabase`) is locked first, in the one order. A
 * linked database left with no view shows nothing more and goes with it; a database with a source of its own
 * gets its source's default view back (otherwise it would be left without a view, which deleteView doesn't
 * allow). The sweep looks only at the databases locked. The sources are locked next (a row or a view created
 * now waits and then fails), so the rows read are all the rows that leave, and they leave the search in the
 * same commit. A database already gone (deleted by a delete of its source just before) is a no-op.
 */
export async function deleteDatabase(deps: AppDeps, database: DatabaseRow) {
  const at = deps.now();
  const result = await lockedTx(
    deps,
    (q) => reachOfDatabase(q, database.id),
    async (tx, held) => {
      if (!held.found.has(database.id)) return null;
      const tables = await tx
        .select({ id: dbTables.id })
        .from(dbTables)
        .where(eq(dbTables.databaseId, database.id))
        .orderBy(asc(dbTables.id))
        .for("update");
      // with the sources locked no view of them can come in: the set is final here
      await held.recheck();
      const rowIds = tables.length
        ? (
            await tx
              .select({ id: dbRows.id })
              .from(dbRows)
              .where(
                inArray(
                  dbRows.tableId,
                  tables.map((t) => t.id),
                ),
              )
          ).map((r) => r.id)
        : [];
      await tx.delete(dbDatabases).where(eq(dbDatabases.id, database.id));
      await baseLocks.pause("base:deleted", tx);
      // the rows went by cascade above; their chunks after them (rows before chunks, as reindex locks them)
      await unindexMany(tx, "db_row", rowIds);
      const sources = tables.map((t) => t.id);
      const reached = [...held.found].filter((id) => id !== database.id);
      if (!reached.length) return { gone: [], healed: [], sources };
      const bare = sql`not exists (select 1 from ${dbViews} where ${dbViews.databaseId} = ${dbDatabases.id})`;
      const gone = await tx
        .delete(dbDatabases)
        .where(and(inArray(dbDatabases.id, reached), eq(dbDatabases.kind, "linked"), bare))
        .returning({ id: dbDatabases.id });
      const own = await tx
        .select({ databaseId: dbTables.databaseId, tableId: dbTables.id })
        .from(dbTables)
        .innerJoin(dbDatabases, eq(dbDatabases.id, dbTables.databaseId))
        .where(and(inArray(dbDatabases.id, reached), bare))
        .orderBy(asc(dbTables.createdAt));
      const healed = [...new Map(own.map((o) => [o.databaseId, o.tableId])).entries()];
      if (healed.length)
        await tx.insert(dbViews).values(
          healed.map(([databaseId, tableId]) => ({
            id: newId("dbv"),
            workspaceId: database.workspaceId,
            databaseId,
            tableId,
            name: "",
            type: "table" as const,
            position: keyBetween(null, null),
            config: {},
            createdAt: at,
            updatedAt: at,
          })),
        );
      return { gone, healed: healed.map(([id]) => id), sources };
    },
  );
  if (!result) return;
  for (const id of result.healed) publishBase(deps, database.workspaceId, id);
  for (const id of [database.id, ...result.gone.map((g) => g.id)])
    deps.hub.toWorkspace(database.workspaceId, { type: "base.deleted", baseId: id });
  // the sources of other databases that pointed to these: the relation empty, the rollup with an error
  const touched = new Set<string>();
  for (const id of result.sources)
    for (const t of await refreshDependents(deps, { id, workspaceId: database.workspaceId })) touched.add(t);
  for (const id of touched) publishBase(deps, database.workspaceId, id);
}
