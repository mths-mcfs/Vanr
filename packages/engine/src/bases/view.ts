// Database views: type, filters, sorting, grouping, columns and quick filters, in the shape of the Notion
// Views API. The server translates the filter to SQL over `props`/`computed`; `rowMatches` here is the
// oracle of the same rule (the server test compares the two by fuzzing) and lets the front end update the
// screen before the response arrives.
import { z } from "zod";
import { parseIso, utcMs } from "../formula/values";
import { isCalendarIso, type PropActor, type PropDef } from "../props";

export const VIEW_TYPES = [
  "table",
  "board",
  "list",
  "gallery",
  "calendar",
  "timeline",
  "chart",
  "form",
] as const;

/** Operator family of a property. */
export type FilterKind =
  | "text"
  | "number"
  | "option"
  | "status"
  | "multi"
  | "person"
  | "date"
  | "checkbox"
  | "file";

export const OPS_BY_KIND = {
  text: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "empty", "not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"],
  option: ["eq", "neq", "in", "not_in", "empty", "not_empty"],
  status: ["eq", "neq", "in", "not_in", "group", "empty", "not_empty"],
  multi: ["has", "has_not", "has_any", "has_all", "empty", "not_empty"],
  person: ["has", "has_not", "empty", "not_empty"],
  date: ["eq", "before", "after", "on_or_before", "on_or_after", "between", "overlaps", "empty", "not_empty"],
  checkbox: ["eq"],
  file: ["empty", "not_empty"],
} as const satisfies Record<FilterKind, readonly string[]>;

/** Family of the property (formula and rollup: by the result type; relation: a list of row ids). */
export function filterKind(def: PropDef): FilterKind {
  switch (def.type) {
    case "relation":
      return "multi";
    case "number":
      return "number";
    case "select":
      return "option";
    case "status":
      return "status";
    case "multi_select":
      return "multi";
    case "person":
    case "creator":
    case "editor":
      return "person";
    case "date":
    case "created_time":
    case "edited_time":
      return "date";
    case "checkbox":
      return "checkbox";
    case "file":
      return "file";
    case "formula":
    case "rollup":
      switch ((def.type === "formula" ? def.formula : def.rollup)?.resultType) {
        case "number":
          return "number";
        case "boolean":
          return "checkbox";
        case "date":
          return "date";
        case "list":
          return "file";
        case "person":
          return "person";
        default:
          return "text";
      }
    default:
      return "text";
  }
}

/** A date relative to today (UTC), resolved when the query runs. */
export const RELATIVE_DATES = [
  "today",
  "tomorrow",
  "yesterday",
  "one_week_ago",
  "one_week_from_now",
  "one_month_ago",
  "one_month_from_now",
] as const;
export type RelativeDate = (typeof RELATIVE_DATES)[number];

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarIso);
const dateValue = z.union([day, z.object({ rel: z.enum(RELATIVE_DATES) }).strict()]);
const actor = z.object({ type: z.enum(["person", "agent"]), id: z.string().min(1).max(100) }).strict();

export const conditionSchema = z
  .object({
    prop: z.string().min(1).max(64),
    op: z.string().min(1).max(20),
    value: z
      .union([
        z.string().max(1000),
        z.number().finite(),
        z.boolean(),
        z.array(z.string().max(200)).max(200),
        z.tuple([dateValue, dateValue]),
        z.object({ rel: z.enum(RELATIVE_DATES) }).strict(),
        actor,
        z.literal("me"),
      ])
      .optional(),
  })
  .strict();
export type FilterCondition = z.infer<typeof conditionSchema>;

export type Filter = FilterCondition | { and: Filter[] } | { or: Filter[] };

export const MAX_FILTER_DEPTH = 3;
export const MAX_FILTER_CONDITIONS = 50;

export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ and: z.array(filterSchema).max(MAX_FILTER_CONDITIONS) }).strict(),
    z.object({ or: z.array(filterSchema).max(MAX_FILTER_CONDITIONS) }).strict(),
  ]),
);

export const sortSchema = z
  .object({ prop: z.string().min(1).max(64), dir: z.enum(["asc", "desc"]).default("asc") })
  .strict();
export type Sort = z.infer<typeof sortSchema>;

export const quickFilterSchema = z
  .object({
    prop: z.string().min(1).max(64),
    op: z.string().max(20).optional(),
    value: conditionSchema.shape.value,
  })
  .strict();
export type QuickFilter = z.infer<typeof quickFilterSchema>;

export const viewConfigSchema = z
  .object({
    filter: filterSchema.nullable().optional(),
    sorts: z.array(sortSchema).max(10).optional(),
    groupBy: z
      .object({ prop: z.string().min(1).max(64), hideEmpty: z.boolean().optional() })
      .strict()
      .nullable()
      .optional(),
    columns: z
      .array(
        z
          .object({
            prop: z.string().min(1).max(64),
            width: z.number().int().min(40).max(1200).optional(),
            hidden: z.boolean().optional(),
          })
          .strict(),
      )
      .max(250)
      .optional(),
    quickFilters: z.array(quickFilterSchema).max(20).optional(),
    frozen: z.number().int().min(0).max(5).optional(),
    cover: z.string().max(64).nullable().optional(),
    cardSize: z.enum(["small", "medium", "large"]).optional(),
    openMode: z.enum(["side", "center", "full"]).optional(),
    wrap: z.boolean().optional(),
    /** Calendar and timeline (dates), chart, form and per-column summaries. */
    dateProp: z.string().max(64).nullable().optional(),
    endProp: z.string().max(64).nullable().optional(),
    chart: z
      .object({
        kind: z.enum(["bar", "column", "line", "donut", "number"]),
        x: z.string().max(64).nullable().optional(),
        y: z.string().max(64).nullable().optional(),
        agg: z.enum(["count", "sum", "avg", "min", "max"]).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    summaries: z.record(z.string().max(64), z.string().max(30)).optional(),
    formProps: z.array(z.string().max(64)).max(250).optional(),
  })
  .strict();
export type ViewConfig = z.infer<typeof viewConfigSchema>;

const optionId = z.string().max(200);
const optionIds = z.array(optionId).max(200);
const word = z.string().max(1000);
const num = z.number().finite();
const who = z.union([actor, z.literal("me")]);

/**
 * The value each operator accepts, per family; empty and not empty ignore the value. Without this, `eq`
 * with a list on a select was true in SQL and false in the oracle, and a person with a list became invalid SQL.
 */
const VALUES: { [K in FilterKind]: Partial<Record<(typeof OPS_BY_KIND)[K][number], z.ZodType>> } = {
  text: { eq: word, neq: word, contains: word, not_contains: word, starts_with: word, ends_with: word },
  number: { eq: num, neq: num, gt: num, gte: num, lt: num, lte: num },
  option: { eq: optionId, neq: optionId, in: optionIds, not_in: optionIds },
  status: {
    eq: optionId,
    neq: optionId,
    in: optionIds,
    not_in: optionIds,
    group: z.enum(["todo", "inProgress", "done"]),
  },
  multi: { has: optionId, has_not: optionId, has_any: optionIds, has_all: optionIds },
  person: { has: who, has_not: who },
  date: {
    eq: dateValue,
    before: dateValue,
    after: dateValue,
    on_or_before: dateValue,
    on_or_after: dateValue,
    between: z.tuple([dateValue, dateValue]),
    /** The date's span (start and end) touches [from, to]: the calendar and the timeline ask for the window. */
    overlaps: z.tuple([dateValue, dateValue]),
  },
  checkbox: { eq: z.boolean() },
  file: {},
};

/** Problems of a filter against the schema (a property that does not exist, an operator or value that does not fit). */
export function checkFilter(filter: Filter, defs: readonly PropDef[], depth = 1): string[] {
  if (depth > MAX_FILTER_DEPTH) return ["too_deep"];
  if ("and" in filter || "or" in filter) {
    const parts = "and" in filter ? filter.and : filter.or;
    return parts.flatMap((f) => checkFilter(f, defs, depth + 1));
  }
  const def = defs.find((d) => d.id === filter.prop);
  if (!def) return [`unknown_prop:${filter.prop}`];
  const kind = filterKind(def);
  const ops = OPS_BY_KIND[kind] as readonly string[];
  if (!ops.includes(filter.op)) return [`bad_op:${filter.prop}:${filter.op}`];
  const value = (VALUES[kind] as Partial<Record<string, z.ZodType>>)[filter.op];
  if (value && !value.safeParse(filter.value).success) return [`bad_value:${filter.prop}:${filter.op}`];
  if (
    value &&
    def.type !== "relation" &&
    (kind === "option" || kind === "status" || kind === "multi") &&
    filter.op !== "group"
  ) {
    const ids = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (ids.some((id) => !def.options?.some((o) => o.id === id)))
      return [`bad_value:${filter.prop}:${filter.op}`];
  }
  return [];
}

/** The filter without the conditions the current schema rejects (a deleted column, a changed type or option). */
export function pruneFilter(filter: Filter | null | undefined, defs: readonly PropDef[]): Filter | null {
  if (!filter) return null;
  if ("and" in filter || "or" in filter) {
    const parts = ("and" in filter ? filter.and : filter.or)
      .map((f) => pruneFilter(f, defs))
      .filter((f): f is Filter => f !== null);
    if (!parts.length) return null;
    return "and" in filter ? { and: parts } : { or: parts };
  }
  return checkFilter(filter, defs).length ? null : filter;
}

export function countConditions(filter: Filter): number {
  if ("and" in filter) return filter.and.reduce((n, f) => n + countConditions(f), 0);
  if ("or" in filter) return filter.or.reduce((n, f) => n + countConditions(f), 0);
  return 1;
}

/** The view's effective filter: the saved one AND the quick filters that have a value. */
export function effectiveFilter(
  config: ViewConfig,
  defs: readonly PropDef[],
  extra?: Filter | null,
): Filter | null {
  const parts: Filter[] = [];
  if (config.filter) parts.push(config.filter);
  for (const q of config.quickFilters ?? []) {
    if (q.value === undefined && q.op !== "empty" && q.op !== "not_empty") continue;
    parts.push({
      prop: q.prop,
      op:
        q.op ??
        defaultOp(
          defs.find((d) => d.id === q.prop),
          q.value,
        ),
      ...(q.value === undefined ? {} : { value: q.value }),
    });
  }
  if (extra) parts.push(extra);
  if (!parts.length) return null;
  return parts.length === 1 ? (parts[0] as Filter) : { and: parts };
}

function defaultOp(def: PropDef | undefined, value: unknown): string {
  const kind = def && filterKind(def);
  if (kind === "person") return "has";
  if (kind === "multi") return Array.isArray(value) ? "has_any" : "has";
  if (Array.isArray(value)) return kind === "date" ? "between" : "in";
  return "eq";
}

// ---------- oracle ----------

/**
 * Upper case the text filter ignores: ASCII and Latin-1 (all of Portuguese, for one). SQL does the same
 * mapping with `translate`, which does not depend on the database locale (ILIKE in a database with the C
 * locale does not match "Á" with "á").
 */
export const FOLD_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ";
export const FOLD_LOWER = "abcdefghijklmnopqrstuvwxyzàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ";

export function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const i = FOLD_UPPER.indexOf(ch);
    out += i >= 0 ? (FOLD_LOWER[i] as string) : ch;
  }
  return out;
}

/** What the oracle needs from the row (the same the SQL query reads). */
export interface RowView {
  props: Record<string, unknown>;
  computed: Record<string, unknown>;
  createdAt: string;
  editedAt: string;
  createdBy: PropActor | null;
  editedBy: PropActor | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The day (UTC) of a date filter value, absolute or relative to `now`. */
export function resolveDay(value: unknown, now: number): string | null {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  if (!value || typeof value !== "object" || !("rel" in value)) return null;
  const d = new Date(now);
  const at = (days: number, months = 0) =>
    isoDay(utcMs(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate() + days));
  switch ((value as { rel: RelativeDate }).rel) {
    case "today":
      return at(0);
    case "tomorrow":
      return at(1);
    case "yesterday":
      return at(-1);
    case "one_week_ago":
      return at(-7);
    case "one_week_from_now":
      return at(7);
    case "one_month_ago":
      return at(0, -1);
    case "one_month_from_now":
      return at(0, 1);
  }
}

/** Raw value of the cell as the query reads it (props, computed or a system column). A formula error = empty. */
export function cellOf(def: PropDef, row: RowView): unknown {
  switch (def.type) {
    case "created_time":
      return row.createdAt;
    case "edited_time":
      return row.editedAt;
    case "creator":
      return row.createdBy;
    case "editor":
      return row.editedBy;
    case "formula":
    case "rollup": {
      const v = row.computed[def.id];
      return v && typeof v === "object" && !Array.isArray(v) && "err" in v ? undefined : v;
    }
    default:
      return row.props[def.id];
  }
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/**
 * The calendar day of a date's text: a day as written; a date with a time, the UTC day of its instant (so
 * `2026-11-01T00:30+02:00` is October 31st, the same day as `2026-10-31T22:30Z`). An invalid time: null.
 */
export function dayOfText(text: string): string | null {
  if (!text.includes("T")) return text.slice(0, 10);
  const p = parseIso(text);
  return p ? isoDay(p.ms) : null;
}

/** Day of a date cell: `start` (props, formula) or the recorded instant (created/edited at). */
function dayOf(def: PropDef, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (def.type === "created_time" || def.type === "edited_time") {
    // A recorded instant that doesn't parse has no day (Date.parse would give NaN).
    const parsed = parseIso(String(v));
    return parsed ? isoDay(parsed.ms) : null;
  }
  if (typeof v === "object" && "start" in v && typeof v.start === "string") return dayOfText(v.start);
  return null;
}

/** End day of a date's span (`{start, end}`); without an end, null. */
function endDayOf(v: unknown): string | null {
  if (typeof v !== "object" || v === null || !("end" in v)) return null;
  return typeof v.end === "string" && v.end ? dayOfText(v.end) : null;
}

const sameActor = (a: unknown, b: PropActor) =>
  typeof a === "object" && a !== null && (a as PropActor).type === b.type && (a as PropActor).id === b.id;

/** Does the row match the filter? `me` is who is querying (for "person is me"). */
export function rowMatches(
  filter: Filter | null | undefined,
  defs: readonly PropDef[],
  row: RowView,
  ctx: { now: number; me?: PropActor },
): boolean {
  if (!filter) return true;
  if ("and" in filter) return filter.and.every((f) => rowMatches(f, defs, row, ctx));
  if ("or" in filter) return filter.or.length === 0 || filter.or.some((f) => rowMatches(f, defs, row, ctx));
  const def = defs.find((d) => d.id === filter.prop);
  if (!def) return false;
  const v = cellOf(def, row);
  const want = filter.value;
  if (filter.op === "empty") return isEmpty(v);
  if (filter.op === "not_empty") return !isEmpty(v);
  switch (filterKind(def)) {
    case "text": {
      const s = typeof v === "string" ? v : "";
      const w = String(want ?? "");
      const lower = foldCase;
      switch (filter.op) {
        case "eq":
          return typeof v === "string" && v === w;
        case "neq":
          return s !== w;
        case "contains":
          return typeof v === "string" && lower(s).includes(lower(w));
        case "not_contains":
          return !lower(s).includes(lower(w));
        case "starts_with":
          return typeof v === "string" && lower(s).startsWith(lower(w));
        case "ends_with":
          return typeof v === "string" && lower(s).endsWith(lower(w));
      }
      return false;
    }
    case "number": {
      const n = typeof v === "number" ? v : null;
      const w = Number(want);
      switch (filter.op) {
        case "eq":
          return n !== null && n === w;
        case "neq":
          return n === null || n !== w;
        case "gt":
          return n !== null && n > w;
        case "gte":
          return n !== null && n >= w;
        case "lt":
          return n !== null && n < w;
        case "lte":
          return n !== null && n <= w;
      }
      return false;
    }
    case "option":
    case "status": {
      const s = typeof v === "string" ? v : null;
      const list = Array.isArray(want) ? (want as string[]) : [];
      switch (filter.op) {
        case "eq":
          return s !== null && s === want;
        case "neq":
          return s !== want;
        case "in":
          return s !== null && list.includes(s);
        case "not_in":
          return s === null || !list.includes(s);
        case "group": {
          // the group name comes from the filter: only the three own keys, never an inherited one
          const g =
            want === "todo" || want === "inProgress" || want === "done" ? (def.groups?.[want] ?? []) : [];
          return s !== null && g.includes(s);
        }
      }
      return false;
    }
    case "multi": {
      const have = Array.isArray(v) ? (v as string[]) : [];
      const list = Array.isArray(want) ? (want as string[]) : [];
      switch (filter.op) {
        case "has":
          return have.includes(String(want));
        case "has_not":
          return !have.includes(String(want));
        case "has_any":
          return list.some((x) => have.includes(x));
        case "has_all":
          return list.every((x) => have.includes(x));
      }
      return false;
    }
    case "person": {
      const who = want === "me" ? ctx.me : (want as PropActor | undefined);
      if (!who) return false;
      const list = Array.isArray(v) ? v : v ? [v] : [];
      const has = list.some((a) => sameActor(a, who));
      return filter.op === "has" ? has : filter.op === "has_not" ? !has : false;
    }
    case "date": {
      const d = dayOf(def, v);
      if (filter.op === "between" || filter.op === "overlaps") {
        const [a, b] = Array.isArray(want) ? want : [];
        const from = resolveDay(a, ctx.now);
        const to = resolveDay(b, ctx.now);
        if (d === null || from === null || to === null) return false;
        if (filter.op === "between") return d >= from && d <= to;
        const end = endDayOf(v) ?? d;
        return d <= to && (end > d ? end : d) >= from;
      }
      const w = resolveDay(want, ctx.now);
      if (d === null || w === null) return false;
      switch (filter.op) {
        case "eq":
          return d === w;
        case "before":
          return d < w;
        case "after":
          return d > w;
        case "on_or_before":
          return d <= w;
        case "on_or_after":
          return d >= w;
      }
      return false;
    }
    case "checkbox":
      return filter.op === "eq" && (v === true) === (want === true);
    case "file":
      return false;
  }
}
