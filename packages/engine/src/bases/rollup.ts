// Rollup: a function over the value of a property in the rows a relation links. The server gathers the values
// (one per linked row, as a formula sees them) and calls `rollupValue`; the result type comes from
// `rollupType` when the schema is saved, for the filter, the order and the grid.
import {
  FORMULA_LIMITS,
  type FormulaPlan,
  planFormulas,
  propFType,
  propValue,
  type RowData,
} from "../formula/index";
import {
  type ComputedJson,
  type FType,
  type FValue,
  fromJson,
  isDate,
  isPerson,
  jsonSize,
  T,
  toJson,
} from "../formula/values";
import type { PropActor, PropDef, RollupFn } from "../props";

/** The rollup's result type; `null` when the function doesn't fit the target property's type. */
export function rollupType(fn: RollupFn, target: FType): FType | null {
  const item = target.k === "list" ? target.of : target;
  const loose = item.k === "any" || item.k === "empty";
  switch (fn) {
    case "show_original":
    case "show_unique":
      return T.list(loose ? T.any : item);
    case "count":
    case "count_values":
    case "count_unique":
    case "count_empty":
    case "count_not_empty":
    case "percent_empty":
    case "percent_not_empty":
      return T.number;
    case "sum":
    case "average":
    case "median":
    case "min":
    case "max":
    case "range":
      return item.k === "number" || loose ? T.number : null;
    case "earliest":
    case "latest":
    case "date_range":
      return item.k === "date" || loose ? T.date : null;
    case "checked":
    case "unchecked":
    case "percent_checked":
    case "percent_unchecked":
      return item.k === "boolean" || loose ? T.number : null;
  }
}

const isEmpty = (v: FValue) => v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Equality key (unique): dates by the instant, a person by type and id. */
function keyOf(v: FValue): string {
  if (isDate(v)) return `d:${v.start}:${v.end ?? ""}`;
  if (isPerson(v)) return `p:${v.type}:${v.id}`;
  return JSON.stringify(v);
}

function unique(values: FValue[]): FValue[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = keyOf(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Sum the serialized decimal coefficients, as jsonb/numeric does, before rounding or dividing. */
export function exactSum(nums: readonly number[], divisor = 1): number {
  let total = 0n;
  for (const x of nums) {
    const [mantissa = "0", exponent = "0"] = String(x).split("e");
    const places = mantissa.includes(".") ? mantissa.length - mantissa.indexOf(".") - 1 : 0;
    total += BigInt(mantissa.replace(".", "")) * 10n ** BigInt(324 + Number(exponent) - places);
  }
  // 10^-324 covers every serialized double; extra division digits keep rounding at the final conversion.
  return Number(`${(total * 10n ** 20n) / BigInt(divisor)}e-344`);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const at = (i: number) => sorted[i] ?? 0;
  return sorted.length % 2 ? at(mid) : exactSum([at(mid - 1), at(mid)], 2);
}

/**
 * The rollup's value. `values` has one item per linked row that exists (the target property's value, `null`
 * when empty; a list for multi, person, file and a list formula). With no linked row: counts give 0, the sum
 * gives 0, the rest stays empty.
 */
export function rollupValue(fn: RollupFn, values: readonly FValue[]): FValue {
  const flat = values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => !isEmpty(v));
  const nums = flat.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const dates = flat.filter(isDate);
  const empties = values.filter(isEmpty).length;
  const share = (n: number) => (values.length ? n / values.length : null);
  const checked = values.filter((v) => v === true || (Array.isArray(v) && v.includes(true))).length;
  switch (fn) {
    case "show_original":
      return flat;
    case "show_unique":
      return unique(flat);
    case "count":
      return values.length;
    case "count_values":
      return flat.length;
    case "count_unique":
      return unique(flat).length;
    case "count_empty":
      return empties;
    case "count_not_empty":
      return values.length - empties;
    case "percent_empty":
      return share(empties);
    case "percent_not_empty":
      return share(values.length - empties);
    case "sum":
      return exactSum(nums);
    case "average":
      return nums.length ? exactSum(nums, nums.length) : null;
    case "median":
      return nums.length ? median([...nums].sort((a, b) => a - b)) : null;
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? exactSum([Math.max(...nums), -Math.min(...nums)]) : null;
    case "earliest": {
      const d = dates.reduce<(typeof dates)[number] | null>(
        (a, b) => (!a || b.start < a.start ? b : a),
        null,
      );
      return d ? { kind: "date", start: d.start, time: d.time } : null;
    }
    case "latest": {
      const d = dates.reduce<(typeof dates)[number] | null>(
        (a, b) => (!a || (b.end ?? b.start) > (a.end ?? a.start) ? b : a),
        null,
      );
      return d ? { kind: "date", start: d.end ?? d.start, time: d.time } : null;
    }
    case "date_range": {
      if (!dates.length) return null;
      const start = Math.min(...dates.map((d) => d.start));
      const end = Math.max(...dates.map((d) => d.end ?? d.start));
      return { kind: "date", start, end, time: dates.some((d) => d.time) };
    }
    case "checked":
      return checked;
    case "unchecked":
      return values.length - checked;
    case "percent_checked":
      return share(checked);
    case "percent_unchecked":
      return share(values.length - checked);
  }
}

/** The error of a result that doesn't fit a number (a sum or a range past ±1.8e308), as a formula's. */
export const NOT_FINITE = { err: "not_finite" } as const;

/**
 * The rollup's value as it is stored and answered: its JSON, `null` when empty, and `{ err: "not_finite" }`
 * when a number doesn't fit (the footer's summary answers the same).
 */
export function rollupJson(fn: RollupFn, values: readonly FValue[]): ComputedJson | null {
  const v = rollupValue(fn, values);
  if (typeof v === "number" && !Number.isFinite(v)) return NOT_FINITE;
  return toJson(v) ?? null;
}

/**
 * A property a rollup can read in the linked row: a value stored in it, or a formula that depends only on
 * that. A relation, a rollup and a formula that reads one of them stay out: that is what rules out a cycle
 * between sources (A sums B that sums A) and a recalculation chain without end. A formula with an error stays
 * out too, and so does one that uses now() or today(): its value moves with the clock, not with the row, and
 * two sources rolling up each other's clock would recalculate each other forever.
 */
export function rollupReadable(
  defs: readonly PropDef[],
  targetId: string,
  plan: FormulaPlan = planFormulas(defs),
): boolean {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const compiled = new Map(plan.order.map((f) => [f.propId, f]));
  const seen = new Set<string>();
  const ok = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const d = byId.get(id);
    if (!d || d.type === "relation" || d.type === "rollup") return false;
    if (d.type !== "formula") return true;
    const f = compiled.get(id);
    return f !== undefined && !f.volatile && f.deps.every(ok);
  };
  return ok(targetId);
}

/** A row of another source, as the server loads it for the relation and the rollup. */
export interface LinkedRow extends Omit<RowData, "extra"> {
  tableId: string;
  computed: Record<string, unknown>;
}

/** The linked source: its schema, its title and the plan of its formulas. */
export interface LinkedTable {
  id: string;
  defs: readonly PropDef[];
  titlePropId: string;
  plan?: FormulaPlan;
}

/**
 * What the row takes from the linked rows: the title of each one (the relation, for the formulas) and each
 * rollup. `extra` goes to `RowData.extra`; `computed` has the rollup in JSON (or `{err}`), next to the
 * formulas'. An id that finds no row (deleted, of another source) is ignored.
 */
export function linkedValues(
  defs: readonly PropDef[],
  props: Record<string, unknown>,
  linked: { tables: ReadonlyMap<string, LinkedTable>; rows: ReadonlyMap<string, LinkedRow> },
  names?: (a: PropActor) => string,
): { extra: Record<string, FValue>; computed: Record<string, unknown>; output: number } {
  let output = 0;
  const extra: Record<string, FValue> = {};
  const computed: Record<string, unknown> = {};
  const rowsOf = (rel: PropDef): LinkedRow[] => {
    const ids = props[rel.id];
    if (!Array.isArray(ids) || !rel.relation) return [];
    const tableId = rel.relation.tableId;
    return ids
      .map((id) => linked.rows.get(String(id)))
      .filter((r): r is LinkedRow => r !== undefined && r.tableId === tableId);
  };
  for (const rel of defs) {
    if (rel.type !== "relation" || !rel.relation) continue;
    const table = linked.tables.get(rel.relation.tableId);
    extra[rel.id] = rowsOf(rel).map((r) => String(r.props[table?.titlePropId ?? ""] ?? ""));
  }
  for (const def of defs) {
    if (def.type !== "rollup" || !def.rollup) continue;
    const rel = defs.find((d) => d.id === def.rollup?.relationPropId);
    const table = rel?.relation ? linked.tables.get(rel.relation.tableId) : undefined;
    const target = table?.defs.find((d) => d.id === def.rollup?.targetPropId);
    if (
      !rel ||
      !table ||
      !target ||
      !rollupReadable(table.defs, target.id, table.plan) ||
      !rollupType(def.rollup.fn, propFType(target, table.plan?.types))
    ) {
      extra[def.id] = null;
      computed[def.id] = { err: "bad_rollup" };
      continue;
    }
    const values = rowsOf(rel).map((r) =>
      target.type === "formula" ? fromJson(r.computed[target.id], names) : propValue(target, r, names),
    );
    const v = rollupValue(def.rollup.fn, values);
    output += v === null ? 0 : jsonSize(v, FORMULA_LIMITS.maxRowOutput - output);
    const err =
      output > FORMULA_LIMITS.maxRowOutput
        ? "too_large"
        : typeof v === "number" && !Number.isFinite(v)
          ? "not_finite"
          : null;
    extra[def.id] = err ? null : v;
    const json = err ? { err } : toJson(v);
    if (json !== undefined) computed[def.id] = json;
  }
  return { extra, computed, output };
}
