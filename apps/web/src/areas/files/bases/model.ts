// What the base screens work out without the server: the text of each cell, the columns of a view in
// their saved order, the filter operators of each type, the group a row falls in on a board, and the
// formula preview, from the same engine the server runs.
import type {
  ActorRef,
  BaseFilter,
  BaseFilterCondition,
  BaseLinkedRow,
  BasePropDef,
  BaseRow,
  BaseTable,
  BaseViewConfig,
} from "@vanr/contract";
import { filterKind, OPS_BY_KIND } from "@vanr/engine/bases/view";
import { previewFormula } from "@vanr/engine/formula";
import { rewritePropRefs } from "@vanr/engine/formula/syntax";
import { typeName } from "@vanr/engine/formula/values";
import type { PropDef } from "@vanr/engine/props";

export type Names = (actor: ActorRef) => string;

/** What a cell's text needs besides the row: names of people and agents, file titles, linked rows. */
export type CellContext = {
  names: Names;
  locale: string;
  files?: (id: string) => string;
  linked?: Readonly<Record<string, BaseLinkedRow>>;
};

/** The colors an option may take, as stored; each one is drawn with one of the interface's tones. */
export const OPTION_COLORS = ["neutral", "agent", "waiting", "done", "danger"] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

/** The color of an option: the stored one, or by its status group (done green, in progress amber). */
export function optionColor(def: BasePropDef, optionId: string): OptionColor {
  const color = def.options?.find((option) => option.id === optionId)?.color;
  if ((OPTION_COLORS as readonly string[]).includes(color ?? "")) return color as OptionColor;
  if (def.type === "status" && def.groups !== undefined) {
    if (def.groups.done.includes(optionId)) return "done";
    if (def.groups.inProgress.includes(optionId)) return "waiting";
  }
  return "neutral";
}

export const optionName = (def: BasePropDef, id: string) =>
  def.options?.find((option) => option.id === id)?.name ?? id;

const COMPUTED = new Set<BasePropDef["type"]>([
  "created_time",
  "creator",
  "edited_time",
  "editor",
  "formula",
  "rollup",
]);
/** A value the server works out: shown, never edited. */
export const isComputed = (def: BasePropDef) => COMPUTED.has(def.type);

/** Numbers, dates and numeric results line up on the right. */
export const isTabular = (def: BasePropDef) => {
  const result = def.formula?.resultType ?? def.rollup?.resultType;
  return (
    def.type === "number" ||
    def.type === "created_time" ||
    def.type === "edited_time" ||
    ((def.type === "formula" || def.type === "rollup") && (result === "number" || result === "date"))
  );
};

/** The cell's raw value: its prop, the computed value of a formula or rollup, or a system column. */
export function rawCell(def: BasePropDef, row: BaseRow): unknown {
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
    case "rollup":
      return row.computed[def.id];
    default:
      return row.props[def.id];
  }
}

/** The error code of a formula or rollup that failed on this row, or null. */
export function computedError(value: unknown): string | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "err" in value
    ? String((value as { err: unknown }).err)
    : null;
}

const isActor = (value: unknown): value is ActorRef =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  "id" in value &&
  typeof (value as ActorRef).id === "string";

export function formatNumber(n: number, format: BasePropDef["numberFormat"], locale: string): string {
  switch (format) {
    case "percent":
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(n);
    case "currency_brl":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(n);
    case "currency_usd":
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(n);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }).format(n);
  }
}

/** A day ("2026-11-01") or an instant, in the interface language; a day never moves with the time zone. */
export function formatDay(iso: string, locale: string, withTime = false): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const date = new Date(day ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime && !day ? { hour: "2-digit", minute: "2-digit" } : {}),
    ...(day ? { timeZone: "UTC" } : {}),
  }).format(date);
}

/** The text of a computed value: a number, a date, a person, or a list of them. */
function computedText(value: unknown, context: CellContext): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return formatNumber(value, "plain", context.locale);
  if (typeof value === "boolean") return value ? "✓" : "✗";
  if (Array.isArray(value)) return value.map((each) => computedText(each, context)).join(", ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.start === "string") {
      const start = formatDay(object.start, context.locale, object.start.length > 10);
      return typeof object.end === "string"
        ? `${start} → ${formatDay(object.end, context.locale, true)}`
        : start;
    }
    if (isActor(object)) return context.names(object);
    if (typeof object.name === "string") return object.name;
    return "";
  }
  return String(value);
}

/** The ids a relation cell holds. */
export const relationIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** A cell's text for reading (grid, card, board). Empty is "". */
export function cellText(def: BasePropDef, row: BaseRow, context: CellContext): string {
  const value = rawCell(def, row);
  if (value === undefined || value === null || value === "") return "";
  switch (def.type) {
    case "number":
      return typeof value === "number" ? formatNumber(value, def.numberFormat, context.locale) : "";
    case "select":
    case "status":
      return optionName(def, String(value));
    case "multi_select":
      return Array.isArray(value) ? value.map((id) => optionName(def, String(id))).join(", ") : "";
    case "checkbox":
      return value === true ? "✓" : "";
    case "date": {
      const range = value as { start?: string; end?: string };
      if (range.start === undefined) return "";
      const start = formatDay(range.start, context.locale, def.withTime);
      return range.end === undefined
        ? start
        : `${start} → ${formatDay(range.end, context.locale, def.withTime)}`;
    }
    case "created_time":
    case "edited_time":
      return formatDay(String(value), context.locale, true);
    case "person":
      return Array.isArray(value) ? value.filter(isActor).map(context.names).join(", ") : "";
    case "creator":
    case "editor":
      return isActor(value) ? context.names(value) : "";
    case "file":
      return Array.isArray(value)
        ? value.map((id) => context.files?.(String(id)) ?? String(id)).join(", ")
        : "";
    case "relation":
      return relationIds(value)
        .flatMap((id) => {
          const linked = context.linked?.[id];
          return linked === undefined ? [] : [linked.title];
        })
        .join(", ");
    case "formula":
    case "rollup":
      return computedError(value) !== null ? "" : computedText(value, context);
    default:
      return String(value);
  }
}

/** The view's columns: the title first, then the saved order, then the ones added since. Hidden ones out. */
export function viewColumns(table: BaseTable, config: BaseViewConfig): BasePropDef[] {
  const saved = config.columns ?? [];
  const byId = new Map(table.defs.map((def) => [def.id, def]));
  const out: { def: BasePropDef; hidden: boolean }[] = [];
  const title = byId.get(table.titlePropId);
  if (title !== undefined) out.push({ def: title, hidden: false });
  for (const column of saved) {
    const def = byId.get(column.prop);
    if (def !== undefined && def.id !== table.titlePropId && !out.some((each) => each.def.id === def.id)) {
      out.push({ def, hidden: column.hidden === true });
    }
  }
  for (const def of table.defs)
    if (!out.some((each) => each.def.id === def.id)) out.push({ def, hidden: false });
  return out.filter((each) => !each.hidden).map((each) => each.def);
}

/** Shows or hides a column in the view; the title never hides. */
export function toggleColumn(table: BaseTable, config: BaseViewConfig, propId: string): BaseViewConfig {
  if (propId === table.titlePropId) return config;
  const columns = [...(config.columns ?? [])];
  const at = columns.findIndex((column) => column.prop === propId);
  const current = columns[at];
  if (current === undefined) columns.push({ prop: propId, hidden: true });
  else columns[at] = { ...current, hidden: current.hidden !== true };
  return { ...config, columns };
}

export const isHidden = (config: BaseViewConfig, propId: string) =>
  config.columns?.find((column) => column.prop === propId)?.hidden === true;

/** The operators that fit the property (the server's own list). */
export function operatorsFor(def: BasePropDef): readonly string[] {
  return OPS_BY_KIND[filterKind(def as PropDef)];
}

/** An operator that takes no value. */
export const takesNoValue = (op: string) => op === "empty" || op === "not_empty";

/** A new condition with the type's first operator and a value that already fits it. */
export function newCondition(def: BasePropDef): BaseFilterCondition {
  switch (filterKind(def as PropDef)) {
    case "checkbox":
      return { prop: def.id, op: "eq", value: true };
    case "option":
    case "status":
      return { prop: def.id, op: "eq", value: def.options?.[0]?.id ?? "" };
    case "multi":
      return def.type === "relation"
        ? { prop: def.id, op: "not_empty" }
        : { prop: def.id, op: "has", value: def.options?.[0]?.id ?? "" };
    case "person":
      return { prop: def.id, op: "has", value: "me" };
    case "date":
      return { prop: def.id, op: "eq", value: { rel: "today" } };
    case "number":
      return { prop: def.id, op: "eq", value: 0 };
    case "file":
      return { prop: def.id, op: "not_empty" };
    default:
      return { prop: def.id, op: "contains", value: "" };
  }
}

const isCondition = (filter: BaseFilter): filter is BaseFilterCondition => "prop" in filter;

/** The screen's filter: a flat list of conditions joined by "and" or by "or". */
export function flatFilter(filter: BaseFilter | null | undefined): {
  mode: "and" | "or";
  conditions: BaseFilterCondition[];
} {
  if (filter === null || filter === undefined) return { mode: "and", conditions: [] };
  if ("and" in filter) return { mode: "and", conditions: filter.and.filter(isCondition) };
  if ("or" in filter) return { mode: "or", conditions: filter.or.filter(isCondition) };
  return { mode: "and", conditions: [filter] };
}

export function toFilter(mode: "and" | "or", conditions: BaseFilterCondition[]): BaseFilter | null {
  if (conditions.length === 0) return null;
  return mode === "and" ? { and: conditions } : { or: conditions };
}

/** A formula as stored (references by id) written with the properties' names, as the editor shows it. */
export function formulaByName(expression: string, defs: readonly BasePropDef[]): string {
  return rewritePropRefs(expression, (ref) => defs.find((def) => def.id === ref)?.name);
}

export type Preview =
  | { kind: "value"; text: string; type: string }
  | {
      kind: "errors";
      errors: { code: string; at: [number, number]; detail?: Record<string, string | number> }[];
    }
  | { kind: "runtime"; code: string; type: string };

/** The formula on the first row (or on an empty one), with the server's own engine. */
export function previewOf(
  expression: string,
  defs: readonly BasePropDef[],
  row: BaseRow | null,
  context: { now: number; names: Names; locale: string; selfId?: string },
): Preview {
  const others = defs.filter((def) => def.id !== context.selfId) as PropDef[];
  const now = new Date(context.now).toISOString();
  const result = previewFormula(
    expression,
    others,
    {
      id: row?.id ?? "preview",
      props: (row?.props ?? {}) as never,
      createdAt: row?.createdAt ?? now,
      createdBy: row?.createdBy ?? null,
      editedAt: row?.editedAt ?? now,
      editedBy: row?.editedBy ?? null,
    },
    { now: context.now, names: (actor) => context.names(actor) },
  );
  if ("errors" in result) return { kind: "errors", errors: result.errors };
  if ("runtime" in result) return { kind: "runtime", code: result.runtime, type: typeName(result.type) };
  return { kind: "value", text: computedText(result.value, context), type: typeName(result.type) };
}

/** The type's key for "Result: …" (list<number> is a list). */
export const typeKey = (type: string) => (type.startsWith("list") ? "list" : type);

/** The group a row falls in, as the server keys it. No value is null. */
export function groupKeyOf(def: BasePropDef, row: BaseRow): string | null {
  const value = rawCell(def, row);
  if (def.type === "creator" || def.type === "editor")
    return isActor(value) ? `${value.type}:${value.id}` : null;
  if (computedError(value) !== null) return null;
  switch (filterKind(def as PropDef)) {
    case "checkbox":
      return value === true ? "true" : "false";
    case "person": {
      const first = Array.isArray(value) ? value[0] : undefined;
      return isActor(first) ? `${first.type}:${first.id}` : null;
    }
    case "date": {
      if (def.type === "created_time" || def.type === "edited_time") return String(value).slice(0, 10);
      const start = typeof value === "object" && value !== null && "start" in value ? value.start : null;
      return typeof start === "string" ? start.slice(0, 10) : null;
    }
    case "number":
      return typeof value === "number" ? String(value) : null;
    default:
      return typeof value === "string" ? value : null;
  }
}

/** The value that puts a row in a group (dragging on a board); undefined when the row can't move there. */
export function valueForGroup(def: BasePropDef, key: string | null): unknown {
  switch (def.type) {
    case "select":
    case "status":
      return key;
    case "checkbox":
      return key === "true";
    case "person": {
      if (key === null) return null;
      const [type, id] = key.split(":");
      return [{ type: type === "agent" ? "agent" : "person", id }];
    }
    default:
      return undefined;
  }
}

/** The properties a board can group by: the ones a card can be dragged across. */
export const groupable = (def: BasePropDef) =>
  def.type === "select" || def.type === "status" || def.type === "checkbox" || def.type === "person";
