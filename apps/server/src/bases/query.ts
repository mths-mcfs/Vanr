// The rows query: filter, order and grouping become SQL over `props` and `computed`, with the same meaning
// as the `rowMatches` oracle of packages/engine/src/bases/view.ts (the tests compare both by fuzzing).
// Nothing from the user goes into the SQL text: a property id, a value and an option go as parameters, and
// the id only goes in after it was checked against the schema.
import type { ActorRef } from "@vanr/contract";
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
      if (c.op === "between") {
        const [a, b] = Array.isArray(v) ? v : [];
        const from = resolveDay(a, ctx.now);
        const to = resolveDay(b, ctx.now);
        if (!from || !to) throw bad("base.bad_filter", "Two dates expected", { prop: c.prop });
        return sql`(${d} >= ${from} and ${d} <= ${to})`;
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
      return textOf(cell);
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

export interface RowQuery {
  filter?: Filter | null;
  sorts?: Sort[];
  groupBy?: { prop: string; hideEmpty?: boolean } | null;
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface RowPage {
  rows: RowRow[];
  total: number;
  nextCursor: string | null;
  groups?: { key: string | null; count: number }[];
}

export async function queryRows(db: Db, table: TableRow, q: RowQuery, ctx: QueryCtx): Promise<RowPage> {
  const defs = table.defs;
  validateFilter(q.filter, defs);
  validateSorts(q.sorts, defs);
  const conds: SQL[] = [sql`${R.tableId} = ${table.id}`];
  if (q.filter) conds.push(filterSql(q.filter, defs, ctx));
  const search = q.search?.trim();
  if (search)
    conds.push(sql`${folded(sql`(${R.props} ->> ${table.titlePropId}::text)`)} like ${`%${like(search)}%`}`);
  const where = and(...conds) as SQL;
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
