// The rows query: filter, order and grouping become SQL over `props` and `computed`, with the same meaning
// as the `rowMatches` oracle of packages/engine/src/bases/view.ts (the tests compare both by fuzzing).
// Nothing from the user goes into the SQL text: a property id, a value and an option go as parameters, and
// the id only goes in after it was checked against the schema.
import type { ActorRef } from "@vanr/contract";
import { type ChartAgg, type SummaryFn, summaryFns } from "@vanr/engine/bases/summary";
import {
  checkFilter,
  countConditions,
  type Filter,
  type FilterCondition,
  FOLD_LOWER,
  FOLD_UPPER,
  filterKind,
  foldCase,
  MAX_FILTER_CONDITIONS,
  resolveDay,
  type Sort,
} from "@vanr/engine/bases/view";
import { type Db, schema } from "@vanr/engine/db";
import type { PropDef } from "@vanr/engine/props";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "../http";
import type { RowRow, TableRow } from "./core";

const { dbRows: R } = schema;

const MAX_LIMIT = 500;
const PER_GROUP = 100;
const MAX_GROUPED_ROWS = 2_000;

const bad = (code: string, message: string, params?: Record<string, unknown>) =>
  new HttpError(400, code, message, params);

/** The cell's JSON value. A formula with an error counts as empty (as in the oracle). */
function jcell(def: PropDef): SQL {
  switch (def.type) {
    case "formula":
    case "rollup":
      return sql`(case when (${R.computed} -> ${def.id}::text) ->> 'err' is not null then null else ${R.computed} -> ${def.id}::text end)`;
    case "creator":
      return sql`${R.createdBy}`;
    case "editor":
      return sql`${R.editedBy}`;
    default:
      return sql`(${R.props} -> ${def.id}::text)`;
  }
}

const textOf = (c: SQL) => sql`(case when jsonb_typeof(${c}) = 'string' then ${c} #>> '{}' end)`;
const numOf = (c: SQL) => sql`(case when jsonb_typeof(${c}) = 'number' then (${c} #>> '{}')::numeric end)`;
const emptyOf = (c: SQL) =>
  sql`(${c} is null or ${c} = 'null'::jsonb or ${c} = '""'::jsonb or ${c} = '[]'::jsonb)`;

function dayOf(def: PropDef): SQL {
  if (def.type === "created_time") return sql`to_char(${R.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  if (def.type === "edited_time") return sql`to_char(${R.editedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  return sql`left(${jcell(def)} ->> 'start', 10)`;
}

/** End day of the span (the date's `end`); without an end, null, and the `greatest` keeps the start. */
function endDayOf(def: PropDef): SQL {
  if (def.type === "created_time" || def.type === "edited_time") return sql`null::text`;
  return sql`nullif(left(${jcell(def)} ->> 'end', 10), '')`;
}

function isEmptySql(def: PropDef): SQL {
  if (def.type === "created_time" || def.type === "edited_time") return sql`false`;
  return emptyOf(jcell(def));
}

const like = (s: string) => foldCase(s).replace(/[\\%_]/g, (c) => `\\${c}`);
/** Text folded as in the oracle (`foldCase`), for a LIKE that ignores case. */
const folded = (t: SQL) => sql`translate(${t}, ${FOLD_UPPER}::text, ${FOLD_LOWER}::text)`;
const list = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );

export interface QueryCtx {
  now: number;
  me: ActorRef;
}

function condition(c: FilterCondition, defs: readonly PropDef[], ctx: QueryCtx): SQL {
  const def = defs.find((d) => d.id === c.prop) as PropDef;
  if (c.op === "empty") return isEmptySql(def);
  if (c.op === "not_empty") return sql`not ${isEmptySql(def)}`;
  const cell = jcell(def);
  const v = c.value;
  switch (filterKind(def)) {
    case "text": {
      const t = textOf(cell);
      const w = String(v ?? "");
      switch (c.op) {
        case "eq":
          return sql`${t} = ${w}`;
        case "neq":
          return sql`coalesce(${t}, '') <> ${w}`;
        case "contains":
          return sql`${folded(t)} like ${`%${like(w)}%`}`;
        case "not_contains":
          return sql`${folded(sql`coalesce(${t}, '')`)} not like ${`%${like(w)}%`}`;
        case "starts_with":
          return sql`${folded(t)} like ${`${like(w)}%`}`;
        case "ends_with":
          return sql`${folded(t)} like ${`%${like(w)}`}`;
      }
      break;
    }
    case "number": {
      const n = numOf(cell);
      const w = Number(v);
      if (!Number.isFinite(w)) throw bad("base.bad_filter", "Number expected", { prop: c.prop });
      const p = sql`${String(w)}::numeric`;
      switch (c.op) {
        case "eq":
          return sql`${n} = ${p}`;
        case "neq":
          return sql`(${n} is null or ${n} <> ${p})`;
        case "gt":
          return sql`${n} > ${p}`;
        case "gte":
          return sql`${n} >= ${p}`;
        case "lt":
          return sql`${n} < ${p}`;
        case "lte":
          return sql`${n} <= ${p}`;
      }
      break;
    }
    case "option":
    case "status": {
      const t = textOf(cell);
      const ids = Array.isArray(v) ? v.map(String) : [];
      switch (c.op) {
        case "eq":
          return sql`${t} = ${String(v ?? "")}`;
        case "neq":
          return sql`${t} is distinct from ${String(v ?? "")}`;
        case "in":
          return ids.length ? sql`${t} in (${list(ids)})` : sql`false`;
        case "not_in":
          return ids.length ? sql`(${t} is null or ${t} not in (${list(ids)}))` : sql`true`;
        case "group": {
          const g = def.groups?.[v as "todo" | "inProgress" | "done"] ?? [];
          return g.length ? sql`${t} in (${list(g)})` : sql`false`;
        }
      }
      break;
    }
    case "multi": {
      const has = (x: string) =>
        sql`(jsonb_typeof(${cell}) = 'array' and ${cell} @> jsonb_build_array(${x}::text))`;
      const ids = Array.isArray(v) ? v.map(String) : [];
      switch (c.op) {
        case "has":
          return has(String(v ?? ""));
        case "has_not":
          return sql`not coalesce(${has(String(v ?? ""))}, false)`;
        case "has_any":
          return ids.length ? sql`(${sql.join(ids.map(has), sql` or `)})` : sql`false`;
        case "has_all":
          return ids.length ? sql`(${sql.join(ids.map(has), sql` and `)})` : sql`true`;
      }
      break;
    }
    case "person": {
      const who = v === "me" ? ctx.me : (v as ActorRef | undefined);
      if (!who || typeof who !== "object") throw bad("base.bad_filter", "Person expected", { prop: c.prop });
      const obj = sql`jsonb_build_object('type', ${who.type}::text, 'id', ${who.id}::text)`;
      const has = sql`(case jsonb_typeof(${cell}) when 'array' then ${cell} @> jsonb_build_array(${obj}) when 'object' then ${cell} @> ${obj} else false end)`;
      if (c.op === "has") return has;
      if (c.op === "has_not") return sql`not coalesce(${has}, false)`;
      break;
    }
    case "date": {
      const d = dayOf(def);
      if (c.op === "between" || c.op === "overlaps") {
        const [a, b] = Array.isArray(v) ? v : [];
        const from = resolveDay(a, ctx.now);
        const to = resolveDay(b, ctx.now);
        if (!from || !to) throw bad("base.bad_filter", "Two dates expected", { prop: c.prop });
        if (c.op === "between") return sql`(${d} >= ${from} and ${d} <= ${to})`;
        return sql`(${d} <= ${to} and greatest(${d}, ${endDayOf(def)}) >= ${from})`;
      }
      const w = resolveDay(v, ctx.now);
      if (!w) throw bad("base.bad_filter", "Date expected", { prop: c.prop });
      switch (c.op) {
        case "eq":
          return sql`${d} = ${w}`;
        case "before":
          return sql`${d} < ${w}`;
        case "after":
          return sql`${d} > ${w}`;
        case "on_or_before":
          return sql`${d} <= ${w}`;
        case "on_or_after":
          return sql`${d} >= ${w}`;
      }
      break;
    }
    case "checkbox":
      if (c.op === "eq") {
        const on = sql`coalesce(${cell} = 'true'::jsonb, false)`;
        return v === true ? on : sql`not ${on}`;
      }
      break;
    case "file":
      break;
  }
  return sql`false`;
}

/** Filter → SQL condition (already checked against the schema). An empty group doesn't restrict. */
function filterSql(filter: Filter, defs: readonly PropDef[], ctx: QueryCtx): SQL {
  if ("and" in filter) {
    if (!filter.and.length) return sql`true`;
    return sql`(${sql.join(
      filter.and.map((f) => filterSql(f, defs, ctx)),
      sql` and `,
    )})`;
  }
  if ("or" in filter) {
    if (!filter.or.length) return sql`true`;
    return sql`(${sql.join(
      filter.or.map((f) => filterSql(f, defs, ctx)),
      sql` or `,
    )})`;
  }
  return sql`coalesce((${condition(filter, defs, ctx)}), false)`;
}

export function validateFilter(filter: Filter | null | undefined, defs: readonly PropDef[]) {
  if (!filter) return;
  if (countConditions(filter) > MAX_FILTER_CONDITIONS) throw bad("base.bad_filter", "Too many conditions");
  const problems = checkFilter(filter, defs);
  if (problems.length) throw bad("base.bad_filter", "Invalid filter", { problems });
}

/** The property's order expression (empty always last, in both directions). */
function sortExprs(def: PropDef): SQL[] {
  const cell = jcell(def);
  switch (def.type) {
    case "created_time":
      return [sql`${R.createdAt}`];
    case "edited_time":
      return [sql`${R.editedAt}`];
    case "creator":
    case "editor":
      return [sql`${cell} ->> 'id'`];
    default:
      break;
  }
  switch (filterKind(def)) {
    case "number":
      return [numOf(cell)];
    case "option":
    case "status":
      return def.options?.length
        ? [sql`array_position(array[${list(def.options.map((o) => o.id))}]::text[], ${textOf(cell)})`]
        : [textOf(cell)];
    case "multi":
      return def.options?.length
        ? [sql`array_position(array[${list(def.options.map((o) => o.id))}]::text[], ${cell} ->> 0)`]
        : [sql`${cell} ->> 0`];
    case "person":
      return [sql`${cell} -> 0 ->> 'id'`];
    case "date":
      return [sql`${cell} ->> 'start'`];
    case "checkbox":
      return [sql`coalesce(${cell} = 'true'::jsonb, false)`];
    case "file":
      return [sql`jsonb_array_length(case when jsonb_typeof(${cell}) = 'array' then ${cell} end)`];
    default:
      return [sql`lower(${textOf(cell)})`, textOf(cell)];
  }
}

export function validateSorts(sorts: readonly Sort[] | undefined, defs: readonly PropDef[]) {
  for (const s of sorts ?? []) {
    if (!defs.some((d) => d.id === s.prop)) throw bad("base.bad_sort", "Unknown property", { prop: s.prop });
  }
}

function orderSql(sorts: readonly Sort[] | undefined, defs: readonly PropDef[]): SQL[] {
  const out: SQL[] = [];
  for (const s of sorts ?? []) {
    const def = defs.find((d) => d.id === s.prop) as PropDef;
    for (const e of sortExprs(def))
      out.push(s.dir === "desc" ? sql`${e} desc nulls last` : sql`${e} asc nulls last`);
  }
  out.push(sql`${R.position} collate "C"`, sql`${R.id}`);
  return out;
}

/** Types a view can group by (multi-select and file are out: a row would fall into several groups). */
export function groupable(def: PropDef): boolean {
  const kind = filterKind(def);
  return kind !== "multi" && kind !== "file";
}

function groupKey(def: PropDef): SQL {
  const cell = jcell(def);
  switch (def.type) {
    case "creator":
    case "editor":
      return sql`(${cell} ->> 'type') || ':' || (${cell} ->> 'id')`;
    default:
      break;
  }
  switch (filterKind(def)) {
    case "checkbox":
      return sql`(case when ${cell} = 'true'::jsonb then 'true' else 'false' end)`;
    case "person":
      return sql`(${cell} -> 0 ->> 'type') || ':' || (${cell} -> 0 ->> 'id')`;
    case "date":
      return dayOf(def);
    case "number":
      return sql`(case when jsonb_typeof(${cell}) = 'number' then ${cell} #>> '{}' end)`;
    default:
      return sql`nullif(${textOf(cell)}, '')`;
  }
}

function groupOrder(def: PropDef, key: SQL): SQL[] {
  const kind = filterKind(def);
  if ((kind === "option" || kind === "status") && def.options?.length) {
    return [
      sql`array_position(array[${list(def.options.map((o) => o.id))}]::text[], ${key}) asc nulls first`,
    ];
  }
  if (kind === "number") return [sql`(${key})::numeric asc nulls first`];
  return [sql`${key} asc nulls first`];
}

/**
 * The narrowing of the rows (the query, the summary and the chart). `within` is the calendar's and the
 * timeline's window: it is ANDed to the filter but checked on its own, so adding the window to a saved filter
 * of 3 levels doesn't pass the depth cap of either.
 */
interface Narrowing {
  filter?: Filter | null;
  within?: Filter | null;
  search?: string;
}

export interface RowQuery extends Narrowing {
  sorts?: Sort[];
  groupBy?: { prop: string; hideEmpty?: boolean } | null;
  limit?: number;
  cursor?: string | null;
}

export interface RowPage {
  rows: RowRow[];
  total: number;
  nextCursor: string | null;
  groups?: { key: string | null; count: number }[];
}

/** The table's rows that pass the filter, the window and the title search. */
function rowsWhere(table: TableRow, q: Narrowing, ctx: QueryCtx): SQL {
  validateFilter(q.filter, table.defs);
  validateFilter(q.within, table.defs);
  const conds: SQL[] = [sql`${R.tableId} = ${table.id}`];
  if (q.filter) conds.push(filterSql(q.filter, table.defs, ctx));
  if (q.within) conds.push(filterSql(q.within, table.defs, ctx));
  const search = q.search?.trim();
  if (search)
    conds.push(sql`${folded(sql`(${R.props} ->> ${table.titlePropId}::text)`)} like ${`%${like(search)}%`}`);
  return and(...conds) as SQL;
}

export async function queryRows(db: Db, table: TableRow, q: RowQuery, ctx: QueryCtx): Promise<RowPage> {
  const defs = table.defs;
  validateSorts(q.sorts, defs);
  const where = rowsWhere(table, q, ctx);
  const order = orderSql(q.sorts, defs);

  if (q.groupBy) {
    const def = defs.find((d) => d.id === q.groupBy?.prop);
    if (!def || !groupable(def))
      throw bad("base.bad_group", "Can't group by this property", { prop: q.groupBy.prop });
    const key = groupKey(def);
    // GROUP BY 1: the repeated expression would have parameters with other numbers and Postgres wouldn't match them
    const grouped = db
      .select({ key: sql<string | null>`${key}`.as("k"), n: sql<number>`count(*)::int`.as("n") })
      .from(R)
      .where(where)
      .groupBy(sql`1`)
      .as("g");
    const counts = await db
      .select({ key: grouped.key, n: grouped.n })
      .from(grouped)
      .orderBy(...groupOrder(def, sql`${grouped.key}`));
    const groups = counts
      .map((g) => ({ key: g.key, count: Number(g.n) }))
      .filter((g) => !(q.groupBy?.hideEmpty && g.key === null));
    const sub = db
      .select({
        id: R.id,
        key: sql<string | null>`${key}`.as("k"),
        rn: sql<number>`row_number() over (partition by ${key} order by ${sql.join(order, sql`, `)})`.as(
          "rn",
        ),
      })
      .from(R)
      .where(where)
      .as("q");
    const picked = await db
      .select({ id: sub.id, key: sub.key })
      .from(sub)
      .where(sql`${sub.rn} <= ${PER_GROUP}`)
      .orderBy(...groupOrder(def, sql`${sub.key}`), sub.rn)
      .limit(MAX_GROUPED_ROWS);
    const visible = picked.filter((p) => !(q.groupBy?.hideEmpty && p.key === null));
    const rows = await rowsById(
      db,
      table.id,
      visible.map((p) => p.id),
    );
    return { rows, total: groups.reduce((n, g) => n + g.count, 0), nextCursor: null, groups };
  }

  const limit = Math.min(Math.max(q.limit ?? 200, 1), MAX_LIMIT);
  const offset = q.cursor ? Number.parseInt(q.cursor, 10) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw bad("base.bad_cursor", "Invalid cursor");
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(R).where(where);
  const rows = await db
    .select()
    .from(R)
    .where(where)
    .orderBy(...order)
    .limit(limit + 1)
    .offset(offset);
  const more = rows.length > limit;
  return {
    rows: more ? rows.slice(0, limit) : rows,
    total: Number(count?.n ?? 0),
    nextCursor: more ? String(offset + limit) : null,
  };
}

/** Rows in the order of the ids asked for. */
async function rowsById(db: Db, tableId: string, ids: string[]): Promise<RowRow[]> {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(R)
    .where(and(eq(R.tableId, tableId), inArray(R.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is RowRow => Boolean(r));
}

// ---------- the footer's summary and the chart ----------

const ARRAY_KINDS: ReadonlySet<string> = new Set(["multi", "person", "file"]);
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const timeCol = (def: PropDef) => (def.type === "created_time" ? R.createdAt : R.editedAt);
const isTime = (def: PropDef) => def.type === "created_time" || def.type === "edited_time";

/** Start and end of the cell's date, as ISO text (the same that is stored). */
function dateEnds(def: PropDef): { start: SQL; end: SQL } {
  if (isTime(def)) {
    const at = sql`to_char(${timeCol(def)} at time zone 'UTC', ${sql.raw(ISO)})`;
    return { start: at, end: at };
  }
  const c = jcell(def);
  return { start: sql`(${c} ->> 'start')`, end: sql`coalesce(${c} ->> 'end', ${c} ->> 'start')` };
}

/** The SQL of one summary over the rows of the `where` (a column of the select). */
function summarySql(def: PropDef, fn: SummaryFn): SQL {
  const c = jcell(def);
  const empty = isEmptySql(def);
  const all = sql`count(*)::float8`;
  const ratio = (part: SQL) => sql`(${part})::float8 / nullif(count(*), 0)`;
  const n = numOf(c);
  const on = sql`coalesce(${c} = 'true'::jsonb, false)`;
  switch (fn) {
    case "count":
      return all;
    case "count_values":
      if (isTime(def)) return all;
      return sql`coalesce(sum(case when jsonb_typeof(${c}) = 'array' then jsonb_array_length(${c}) when ${empty} then 0 else 1 end), 0)::float8`;
    case "count_unique":
      if (isTime(def)) return sql`count(distinct ${timeCol(def)})::float8`;
      // a list (tags, people, files, a relation) counts its items, in a statement of its own (uniqueItems)
      if (ARRAY_KINDS.has(filterKind(def))) return sql`null::float8`;
      return sql`count(distinct ${c}) filter (where not ${empty})::float8`;
    case "count_empty":
      return sql`count(*) filter (where ${empty})::float8`;
    case "count_not_empty":
      return sql`count(*) filter (where not ${empty})::float8`;
    case "percent_empty":
      return ratio(sql`count(*) filter (where ${empty})`);
    case "percent_not_empty":
      return ratio(sql`count(*) filter (where not ${empty})`);
    case "sum":
      return sql`coalesce(sum(${n}), 0)::float8`;
    case "average":
      return sql`avg(${n})::float8`;
    case "median":
      return sql`(percentile_cont(0.5) within group (order by ${n}))::float8`;
    case "min":
      return sql`min(${n})::float8`;
    case "max":
      return sql`max(${n})::float8`;
    case "range":
      return sql`(max(${n}) - min(${n}))::float8`;
    case "earliest":
      return sql`min(${dateEnds(def).start})`;
    case "latest":
      return sql`max(${dateEnds(def).end})`;
    case "date_range": {
      const d = dateEnds(def);
      return sql`case when count(${d.start}) = 0 then null else jsonb_build_object('start', min(${d.start}), 'end', max(${d.end})) end`;
    }
    case "checked":
      return sql`count(*) filter (where ${on})::float8`;
    case "unchecked":
      return sql`count(*) filter (where not ${on})::float8`;
    case "percent_checked":
      return ratio(sql`count(*) filter (where ${on})`);
    case "percent_unchecked":
      return ratio(sql`count(*) filter (where not ${on})`);
  }
}

/** Summaries per request: one per column, and a view has at most the schema's columns. */
export const MAX_SUMMARIES = 50;

/** One summary as the database answers it: a number (float8 may come as text), a date's text or a span. */
const summaryCell = z.union([
  z.number(),
  z.string(),
  z.object({ start: z.string(), end: z.string() }).strict(),
  z.null(),
]);

/** The first row of a raw statement, on PGlite and on postgres.js alike. */
function firstRow(result: unknown): unknown {
  if (Array.isArray(result)) return result[0];
  const rows = z.object({ rows: z.array(z.unknown()) }).safeParse(result);
  return rows.success ? rows.data.rows[0] : undefined;
}

/**
 * The footer's summary: one function per column, over the rows the filter keeps (not only the page the screen
 * shows). A column or a function that doesn't fit the type is a 400. A date comes back as `{ start }` (with
 * `end`, for the span), like a formula's value.
 */
export async function summarizeRows(
  db: Db,
  table: TableRow,
  q: Narrowing & { summaries: Record<string, string> },
  ctx: QueryCtx,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(q.summaries);
  if (entries.length > MAX_SUMMARIES)
    throw bad("base.bad_summary", "Too many summaries", { max: MAX_SUMMARIES });
  const where = rowsWhere(table, q, ctx);
  const picked: { def: PropDef; fn: SummaryFn }[] = [];
  for (const [prop, name] of entries) {
    const def = table.defs.find((d) => d.id === prop);
    const fn = def ? summaryFns(def).find((f) => f === name) : undefined;
    if (!def || !fn)
      throw bad("base.bad_summary", "This summary doesn't fit the property", { prop, fn: name });
    picked.push({ def, fn });
  }
  if (!picked.length) return {};
  const cols = picked.map((p, i) => sql`${summarySql(p.def, p.fn)} as ${sql.raw(`"s${i}"`)}`);
  const row = z
    .record(z.string(), summaryCell)
    .parse(firstRow(await db.execute(sql`select ${sql.join(cols, sql`, `)} from ${R} where ${where}`)));
  const out: Record<string, unknown> = {};
  for (const [i, p] of picked.entries()) {
    const v =
      p.fn === "count_unique" && ARRAY_KINDS.has(filterKind(p.def))
        ? await uniqueItems(db, p.def, where)
        : (row[`s${i}`] ?? null);
    if (p.fn === "earliest" || p.fn === "latest") out[p.def.id] = typeof v === "string" ? { start: v } : null;
    else if (p.fn === "date_range") out[p.def.id] = typeof v === "object" ? v : null;
    else out[p.def.id] = typeof v === "string" ? Number(v) : v;
  }
  return out;
}

/** The distinct items of a list column over the rows of the `where`. */
async function uniqueItems(db: Db, def: PropDef, where: SQL): Promise<number> {
  const c = jcell(def);
  const row = z
    .object({ n: z.union([z.number(), z.string()]) })
    .parse(
      firstRow(
        await db.execute(
          sql`select count(distinct e)::float8 as n from ${R}, jsonb_array_elements(case when jsonb_typeof(${c}) = 'array' then ${c} else '[]'::jsonb end) as e where ${where}`,
        ),
      ),
    );
  return Number(row.n);
}

/**
 * The chart: the filter's rows grouped by the column `x` (the same key as the grid's grouping), with the
 * count or the sum, average, minimum or maximum of the number column `y`. Without `x`, one value. Up to 100
 * groups, in the grouping's order.
 */
export async function aggregateRows(
  db: Db,
  table: TableRow,
  q: Narrowing & { x?: string | null; y?: string | null; agg: ChartAgg },
  ctx: QueryCtx,
): Promise<{ groups: { key: string | null; value: number | null }[]; total: number }> {
  const defs = table.defs;
  const where = rowsWhere(table, q, ctx);
  let value: SQL = sql`count(*)::float8`;
  if (q.agg !== "count") {
    const y = defs.find((d) => d.id === q.y);
    if (!y || filterKind(y) !== "number")
      throw bad("base.bad_chart", "Pick a number property to add up", { prop: q.y ?? null });
    const n = numOf(jcell(y));
    value = {
      sum: sql`coalesce(sum(${n}), 0)::float8`,
      avg: sql`avg(${n})::float8`,
      min: sql`min(${n})::float8`,
      max: sql`max(${n})::float8`,
    }[q.agg];
  }
  const num = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(R).where(where);
  const total = Number(count?.n ?? 0);
  if (!q.x) {
    const [one] = await db
      .select({ v: sql<number | string | null>`${value}` })
      .from(R)
      .where(where);
    return { groups: [{ key: null, value: num(one?.v) }], total };
  }
  const def = defs.find((d) => d.id === q.x);
  if (!def || !groupable(def)) throw bad("base.bad_chart", "Can't group by this property", { prop: q.x });
  const key = groupKey(def);
  const grouped = db
    .select({ key: sql<string | null>`${key}`.as("k"), v: sql<number | string | null>`${value}`.as("v") })
    .from(R)
    .where(where)
    .groupBy(sql`1`)
    .as("g");
  const rows = await db
    .select({ key: grouped.key, v: grouped.v })
    .from(grouped)
    .orderBy(...groupOrder(def, sql`${grouped.key}`))
    .limit(MAX_CHART_GROUPS);
  return { groups: rows.map((r) => ({ key: r.key, value: num(r.v) })), total };
}

/** Groups a chart returns. */
export const MAX_CHART_GROUPS = 100;
