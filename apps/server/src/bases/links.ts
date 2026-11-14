// Bases: relation and rollup on the server. A relation keeps the ids of the linked rows (`dbr_…`, of a source
// of the same workspace); a rollup is calculated like a formula, from the value stored in the linked rows, and
// lives in `computed`.
//
// When a row changes, the rows of other sources that point to it (its dependents) go stale. The change writes
// a notice in `db_calc_dirty` in its own transaction; after the commit, `propagate` marks the dependents
// (a lower calc_version, as the schema's recalculation does) and deletes the notice.
//
// Locks: `propagate` never waits for a lock, so it can't close a deadlock with anyone. It takes the notices,
// then each dependent source, then its rows, all with `SKIP LOCKED`, in that order (the source before its
// rows, as every write of the bases). A source or a row some other write holds is skipped and its notice
// stays for the next round (the caller tries again shortly). A crash between the commit and the marking loses
// nothing: the server's start runs `propagate` again.
//
// No cycle: a rollup only reads a stored value or a formula that depends only on stored values
// (`rollupReadable`), and a recalculation only notifies when such a value changed, which a recalculation
// caused by a linked row never does: the propagation stops after one step.
import { type LinkedRow, type LinkedTable, rollupReadable, rollupType } from "@vanr/engine/bases/rollup";
import { type Db, schema } from "@vanr/engine/db";
import { planFormulas, propFType, resultTypeOf } from "@vanr/engine/formula";
import { newId } from "@vanr/engine/ids";
import type { PropDef, PropError, Props } from "@vanr/engine/props";
import { and, asc, count, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { type RowRow, relationTableIds, type TableRow, type Tx } from "./core";

const { dbTables, dbRows, dbCalcDirty } = schema;

type Q = Db | Tx;

/** Rows per statement: an `in` list, a notice and the dependents marked at once. */
const CHUNK = 500;
const MARK_CHUNK = 200;
/** Sources taken per round of `propagate`, and rounds before it leaves the rest for later. */
const SOURCES_PER_ROUND = 20;
const MAX_ROUNDS = 1000;

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export interface Linked {
  tables: Map<string, LinkedTable>;
  rows: Map<string, LinkedRow>;
}

const EMPTY: Linked = { tables: new Map(), rows: new Map() };

function asLinkedRow(r: RowRow): LinkedRow {
  return {
    id: r.id,
    tableId: r.tableId,
    props: r.props,
    computed: r.computed,
    createdAt: r.createdAt.toISOString(),
    editedAt: r.editedAt.toISOString(),
    createdBy: r.createdBy,
    editedBy: r.editedBy,
  };
}

/** The sources the relations of the schema link (only the workspace's own). */
export async function linkedTables(
  db: Q,
  workspaceId: string,
  defs: readonly PropDef[],
): Promise<Map<string, LinkedTable>> {
  const ids = relationTableIds(defs);
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: dbTables.id, defs: dbTables.defs, titlePropId: dbTables.titlePropId })
    .from(dbTables)
    .where(and(eq(dbTables.workspaceId, workspaceId), inArray(dbTables.id, ids)));
  return new Map(rows.map((t) => [t.id, { ...t, plan: planFormulas(t.defs) }]));
}

/** The rows linked to `rows` by the source's relations, to calculate the rollups and the formulas. */
export async function loadLinked(db: Q, table: TableRow, rows: readonly { props: Props }[]): Promise<Linked> {
  const rels = table.defs.filter((d) => d.type === "relation" && d.relation);
  if (!rels.length) return EMPTY;
  const tables = await linkedTables(db, table.workspaceId, table.defs);
  const want = new Set<string>();
  for (const r of rows) for (const rel of rels) for (const id of idsOf(r.props[rel.id])) want.add(id);
  const out = new Map<string, LinkedRow>();
  const tableIds = [...tables.keys()];
  if (!tableIds.length) return { tables, rows: out };
  for (const part of chunks([...want], CHUNK)) {
    const found = await db
      .select()
      .from(dbRows)
      .where(
        and(
          eq(dbRows.workspaceId, table.workspaceId),
          inArray(dbRows.tableId, tableIds),
          inArray(dbRows.id, part),
        ),
      );
    for (const r of found) out.set(r.id, asLinkedRow(r));
  }
  return { tables, rows: out };
}

/**
 * The new ids of a relation (the ones the row didn't have yet) have to be rows of the linked source, in the
 * same workspace. The ones already there pass: the linked row may have been deleted since, and the
 * calculation ignores it.
 */
export async function checkRelationIds(
  db: Q,
  table: TableRow,
  current: Props,
  write: Props,
): Promise<PropError[]> {
  const errors: PropError[] = [];
  for (const [id, v] of Object.entries(write)) {
    const def = table.defs.find((d) => d.id === id);
    if (def?.type !== "relation" || !def.relation || v === null) continue;
    const had = new Set(idsOf(current[id]));
    const fresh = idsOf(v).filter((x) => !had.has(x));
    if (!fresh.length) continue;
    const found = await db
      .select({ id: dbRows.id })
      .from(dbRows)
      .where(
        and(
          eq(dbRows.workspaceId, table.workspaceId),
          eq(dbRows.tableId, def.relation.tableId),
          inArray(dbRows.id, fresh),
        ),
      );
    if (found.length !== fresh.length) errors.push({ propId: id, code: "invalid" });
  }
  return errors;
}

/** Does the source's relation `relId` change the calculation of anything (a rollup by it or a formula reading it)? */
function relationUsed(defs: readonly PropDef[], relId: string): boolean {
  if (defs.some((d) => d.type === "rollup" && d.rollup?.relationPropId === relId)) return true;
  const plan = planFormulas(defs);
  const deps = new Map(plan.order.map((f) => [f.propId, f.deps]));
  const reaches = (id: string, seen: Set<string>): boolean => {
    if (id === relId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (deps.get(id) ?? []).some((d) => reaches(d, seen));
  };
  return plan.order.some((f) => reaches(f.propId, new Set()));
}

/** The workspace's sources with a relation to `tableId` that the calculation uses, with those relations. */
export async function dependentsOf(
  db: Q,
  workspaceId: string,
  tableId: string,
): Promise<{ table: TableRow; rels: PropDef[] }[]> {
  const probe = JSON.stringify([{ relation: { tableId } }]);
  const tables = await db
    .select()
    .from(dbTables)
    .where(and(eq(dbTables.workspaceId, workspaceId), sql`${dbTables.defs} @> ${probe}::jsonb`))
    .orderBy(asc(dbTables.id));
  const out: { table: TableRow; rels: PropDef[] }[] = [];
  for (const t of tables) {
    const rels = t.defs.filter(
      (d) => d.type === "relation" && d.relation?.tableId === tableId && relationUsed(t.defs, d.id),
    );
    if (rels.length) out.push({ table: t, rels });
  }
  return out;
}

/** In the change's transaction: notes that these rows changed, if some source depends on this one. */
export async function noteChanged(
  tx: Tx,
  table: Pick<TableRow, "id" | "workspaceId">,
  rowIds: readonly string[],
) {
  if (!rowIds.length) return;
  if (!(await dependentsOf(tx, table.workspaceId, table.id)).length) return;
  for (const part of chunks(rowIds, CHUNK)) {
    await tx
      .insert(dbCalcDirty)
      .values({ id: newId("dcd"), workspaceId: table.workspaceId, tableId: table.id, rowIds: part });
  }
}

/** "The relation `relId` points to one of these ids" (uses the GIN index of `props`). */
function linksAny(relId: string, ids: readonly string[]) {
  return sql`(${sql.join(
    ids.map(
      (id) => sql`${dbRows.props} @> jsonb_build_object(${relId}::text, jsonb_build_array(${id}::text))`,
    ),
    sql` or `,
  )})`;
}

/** Takes the dependent source for the marking, without waiting: false when another write holds it. */
async function claimSource(tx: Tx, tableId: string): Promise<boolean> {
  const [got] = await tx
    .select({ id: dbTables.id })
    .from(dbTables)
    .where(eq(dbTables.id, tableId))
    .for("no key update", { skipLocked: true });
  return got !== undefined;
}

/**
 * The seam of the Postgres tests (bases-postgres.test.ts), in the mold of `baseLocks`: a test swaps
 * `claimSource` for a double that doesn't take the source first, and `lockRows` for one that waits for a held
 * row, to prove the tests need them.
 */
/** Takes the dependent rows that match, skipping the ones another write holds. */
async function lockRows(tx: Tx, where: SQL | undefined): Promise<{ id: string }[]> {
  return tx.select({ id: dbRows.id }).from(dbRows).where(where).for("update", { skipLocked: true });
}

export const linkLocks = { claimSource, lockRows };

/**
 * Marks the dependents of the rows `rowIds` of the source `tableId`. Returns whether every dependent was
 * marked (false: a dependent source or row was held, so the notice has to stay).
 */
async function markDependents(
  tx: Tx,
  workspaceId: string,
  tableId: string,
  rowIds: readonly string[],
  marked: Set<string>,
): Promise<boolean> {
  let complete = true;
  for (const { table: y, rels } of await dependentsOf(tx, workspaceId, tableId)) {
    if (!(await linkLocks.claimSource(tx, y.id))) {
      // held by another write: next round; gone meanwhile (its database deleted): nothing to mark
      const [still] = await tx.select({ id: dbTables.id }).from(dbTables).where(eq(dbTables.id, y.id));
      if (still) complete = false;
      continue;
    }
    // the source read again under its lock: its calc_version is the one the marking uses
    const [now] = await tx
      .select({ calcVersion: dbTables.calcVersion })
      .from(dbTables)
      .where(eq(dbTables.id, y.id));
    if (!now) continue;
    let touched = false;
    for (const rel of rels) {
      for (const part of chunks(rowIds, MARK_CHUNK)) {
        const fresh = and(
          eq(dbRows.tableId, y.id),
          gte(dbRows.calcVersion, now.calcVersion),
          linksAny(rel.id, part),
        );
        const got = await linkLocks.lockRows(tx, fresh);
        if (got.length) {
          await tx
            .update(dbRows)
            .set({ calcVersion: now.calcVersion - 1 })
            .where(
              inArray(
                dbRows.id,
                got.map((g) => g.id),
              ),
            );
          touched = true;
        }
        // what is left with the version up to date was held by another write
        const [left] = await tx.select({ n: count() }).from(dbRows).where(fresh);
        if (Number(left?.n ?? 0) > 0) complete = false;
      }
    }
    if (touched) {
      await tx
        .update(dbTables)
        .set({ calcDoneVersion: sql`least(${dbTables.calcDoneVersion}, ${dbTables.calcVersion} - 1)` })
        .where(eq(dbTables.id, y.id));
      marked.add(y.id);
    }
  }
  return complete;
}

/**
 * Marks the dependents of the pending notices. The work is chosen by source, not by arrival: each round takes
 * the next sources with notices (oldest first) that this call hasn't seen, so a source whose dependents are
 * held is passed over and the others are handled in the same call; no free source waits for a held one. The
 * notices of one source are merged into one (each row once), so a source held for a long time keeps one
 * notice, as big as its changed rows, however many writes it gets. Returns the sources marked (the caller
 * schedules their recalculation) and whether a notice was left because something was held (the caller tries
 * again).
 */
export async function propagate(db: Db): Promise<{ marked: Set<string>; pending: boolean }> {
  const marked = new Set<string>();
  const seen = new Set<string>();
  let pending = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const sources = await db
      .select({ tableId: dbCalcDirty.tableId, workspaceId: dbCalcDirty.workspaceId })
      .from(dbCalcDirty)
      .where(
        seen.size
          ? sql`${dbCalcDirty.tableId} not in (${sql.join(
              [...seen].map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`true`,
      )
      .groupBy(dbCalcDirty.tableId, dbCalcDirty.workspaceId)
      .orderBy(sql`min(${dbCalcDirty.createdAt})`, dbCalcDirty.tableId)
      .limit(SOURCES_PER_ROUND);
    if (!sources.length) return { marked, pending };
    for (const source of sources) {
      seen.add(source.tableId);
      const left = await db.transaction(async (tx) => {
        const notices = await tx
          .select()
          .from(dbCalcDirty)
          .where(eq(dbCalcDirty.tableId, source.tableId))
          .orderBy(asc(dbCalcDirty.createdAt), asc(dbCalcDirty.id))
          .for("update", { skipLocked: true });
        if (!notices.length) return false;
        const rowIds = [...new Set(notices.flatMap((n) => n.rowIds))];
        const complete = await markDependents(tx, source.workspaceId, source.tableId, rowIds, marked);
        await tx.delete(dbCalcDirty).where(
          inArray(
            dbCalcDirty.id,
            notices.map((n) => n.id),
          ),
        );
        // what is left goes back as one notice, as old as the oldest one (its turn doesn't move back)
        if (!complete)
          for (const part of chunks(rowIds, CHUNK))
            await tx.insert(dbCalcDirty).values({
              id: newId("dcd"),
              workspaceId: source.workspaceId,
              tableId: source.tableId,
              rowIds: part,
              createdAt: notices[0]?.createdAt ?? new Date(),
            });
        return !complete;
      });
      if (left) pending = true;
    }
  }
  return { marked, pending: true };
}

type SchemaProblem = { code: "bad_rollup" | "missing_relation"; propId: string };

/**
 * The result type of each rollup, read from the linked source's schema. A relation whose source isn't in the
 * workspace and a rollup that doesn't close (its relation gone, a target that doesn't exist or that a rollup
 * can't read, a function that doesn't fit the type) come back in `problems`, the rollup unchanged.
 */
export async function withRollupTypes(
  db: Q,
  self: Pick<TableRow, "id" | "workspaceId" | "titlePropId">,
  defs: PropDef[],
): Promise<{ defs: PropDef[]; problems: SchemaProblem[] }> {
  const tables = await linkedTables(db, self.workspaceId, defs);
  // a relation to its own source: the rollup reads the new schema, not the saved one
  if (relationTableIds(defs).includes(self.id))
    tables.set(self.id, { id: self.id, defs, titlePropId: self.titlePropId, plan: planFormulas(defs) });
  const problems: SchemaProblem[] = [];
  for (const d of defs) {
    if (d.type === "relation" && d.relation && !tables.has(d.relation.tableId))
      problems.push({ code: "missing_relation", propId: d.id });
  }
  const out = defs.map((d) => {
    if (d.type !== "rollup" || !d.rollup) return d;
    const rel = defs.find((x) => x.id === d.rollup?.relationPropId);
    const t = rel?.relation ? tables.get(rel.relation.tableId) : undefined;
    const target = t?.defs.find((x) => x.id === d.rollup?.targetPropId);
    const type =
      t && target && rollupReadable(t.defs, target.id, t.plan)
        ? rollupType(d.rollup.fn, propFType(target, t.plan?.types))
        : null;
    if (!type) {
      problems.push({ code: "bad_rollup", propId: d.id });
      return d;
    }
    return { ...d, rollup: { ...d.rollup, resultType: resultTypeOf(type) } };
  });
  return { defs: out, problems };
}
