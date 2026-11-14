// Typed properties. One format for wiki page properties, database rows and issue fields: the
// definition (PropDef), the value stored in `props jsonb` keyed by the property id (so a rename does
// not break anything), validation on write and formatting on read.
//
// Formulas are a property type here; their engine lives in `formula/`.
import { z } from "zod";

export const PROP_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "person",
  "url",
  "file",
  "created_time",
  "creator",
  "edited_time",
  "editor",
  "formula",
] as const;
export type PropType = (typeof PROP_TYPES)[number];

/** Types the system fills in: writes are rejected. */
export const COMPUTED_TYPES: ReadonlySet<PropType> = new Set([
  "created_time",
  "creator",
  "edited_time",
  "editor",
  "formula",
]);

export interface PropOption {
  id: string;
  name: string;
  /** A tone name from packages/ui (neutral, agent, waiting, done, danger) or a free color. */
  color?: string;
}

export interface PropDef {
  /** Stable id (`prop_…`): the key in `props`. */
  id: string;
  name: string;
  type: PropType;
  /** select, multi_select and status. */
  options?: PropOption[];
  /** status: groups (to do, in progress, done) with the option ids. */
  groups?: { todo: string[]; inProgress: string[]; done: string[] };
  /** number: display format. */
  numberFormat?: "plain" | "percent" | "currency_brl" | "currency_usd";
  /** date: also stores the time. */
  withTime?: boolean;
  /**
   * formula: the expression keeps references by id (`prop("prop_…")`) so a rename does not break it;
   * the screen shows them by name. `resultType` is the type inferred on the last schema save. The value
   * lives in `computed`, not in `props` (engine in `formula/`).
   */
  formula?: { expression: string; resultType?: FormulaResultType };
}

/** Type of a formula result (the same as in `formula/index.ts`). */
export type FormulaResultType = "number" | "text" | "boolean" | "date" | "person" | "list" | "any";

/** A person or an agent: the same shape as the client's `ActorRef` (`person` is the user id). */
export interface PropActor {
  type: "person" | "agent";
  id: string;
}

export type PropValue =
  | string
  | number
  | boolean
  | string[]
  | { start: string; end?: string }
  | PropActor
  | PropActor[]
  | null;

/** Stored value: `{ [propId]: value }`. A property without a value is absent (not `null`). */
export type Props = Record<string, PropValue>;

/**
 * Checkbox words, one list for every reader (CSV inference and parsing, front matter). Case is ignored.
 * Portuguese yes/no stay accepted on import.
 */
export const CHECKED_WORDS = ["true", "yes", "sim", "x", "1", "✓", "✔"] as const;
export const UNCHECKED_WORDS = ["false", "no", "não", "nao", "0"] as const;
const CHECKED: ReadonlySet<string> = new Set(CHECKED_WORDS);
const CHECKBOX_WORDS: ReadonlySet<string> = new Set([...CHECKED_WORDS, ...UNCHECKED_WORDS]);

/** The text means a checked box. */
export const isChecked = (text: string) => CHECKED.has(text.trim().toLowerCase());
/** The text is a checkbox word, checked or not. */
export const isCheckboxWord = (text: string) => CHECKBOX_WORDS.has(text.trim().toLowerCase());

export type PropError = { propId: string; code: "unknown_prop" | "read_only" | "invalid" | "unknown_option" };

// NUL and a lone surrogate half: Postgres rejects them in text and jsonb, and the insert would fail with a 500.
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what gets rejected
const BAD_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BAD_TEXT_ALL = new RegExp(BAD_TEXT.source, "g");

/** A value Postgres stores: no text inside it (keys included) has a NUL or a lone surrogate half. */
export function isStorable(v: unknown): boolean {
  if (typeof v === "string") return !BAD_TEXT.test(v);
  if (Array.isArray(v)) return v.every(isStorable);
  if (v && typeof v === "object")
    return Object.entries(v).every(([k, x]) => !BAD_TEXT.test(k) && isStorable(x));
  return true;
}

/** Text Postgres stores: NUL is dropped, a lone surrogate half becomes U+FFFD. */
export function storableText(s: string): string {
  return s.replace(BAD_TEXT_ALL, (c) => (c === "\u0000" ? "" : "\uFFFD"));
}

/** Does the day exist in the (proleptic Gregorian) calendar? Years 0 to 9999 as written, no shift. */
export function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const d = new Date(0);
  // setUTCFullYear, unlike Date.UTC, does not turn years 0 to 99 into 1900 to 1999
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** The `YYYY-MM-DD` at the start of an ISO text names a day that exists. */
export function isCalendarIso(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return !!m && isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/)
  .refine(isCalendarIso);
const actor = z.object({ type: z.enum(["person", "agent"]), id: z.string().min(1).max(100) }).strict();

function schemaFor(def: PropDef): z.ZodType<PropValue> {
  switch (def.type) {
    case "text":
      return z.string().max(100_000);
    case "number":
      return z.number().finite();
    case "select":
    case "status":
      return z.string().min(1);
    case "multi_select":
      return z.array(z.string().min(1)).max(100);
    case "date":
      return z.object({ start: isoDate, end: isoDate.optional() }).strict();
    case "checkbox":
      return z.boolean();
    case "person":
      return z.array(actor).max(100);
    case "url":
      return z.url({ protocol: /^https?$/ }).max(2048);
    case "file":
      // ids of files in the Drive
      return z.array(z.string().min(1)).max(100);
    default:
      return z.never();
  }
}

/**
 * Validates a (partial) write: only the keys sent. `null` clears the value. Rejects an unknown
 * property, a computed type and an option that does not exist. Returns the new props (old + write).
 */
export function applyProps(
  defs: readonly PropDef[],
  current: Props,
  write: Record<string, unknown>,
): { ok: true; props: Props } | { ok: false; errors: PropError[] } {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const errors: PropError[] = [];
  const next: Props = { ...current };
  for (const [propId, raw] of Object.entries(write)) {
    const def = byId.get(propId);
    if (!def) {
      errors.push({ propId, code: "unknown_prop" });
      continue;
    }
    if (COMPUTED_TYPES.has(def.type)) {
      errors.push({ propId, code: "read_only" });
      continue;
    }
    if (raw === null) {
      delete next[propId];
      continue;
    }
    const parsed = isStorable(raw) ? schemaFor(def).safeParse(raw) : null;
    if (!parsed?.success) {
      errors.push({ propId, code: "invalid" });
      continue;
    }
    const value = parsed.data;
    if (def.type === "select" || def.type === "status" || def.type === "multi_select") {
      const known = new Set((def.options ?? []).map((o) => o.id));
      const ids = Array.isArray(value) ? (value as string[]) : [value as string];
      if (ids.some((id) => !known.has(id))) {
        errors.push({ propId, code: "unknown_option" });
        continue;
      }
    }
    next[propId] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, props: next };
}

/** Short text for tables, CSV and search. Dates and numbers in a stable format (the front end localizes). */
export function propText(
  def: PropDef,
  value: PropValue | undefined,
  names?: (a: PropActor) => string,
): string {
  if (value === undefined || value === null) return "";
  const option = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
  switch (def.type) {
    case "select":
    case "status":
      return option(String(value));
    case "multi_select":
      return (value as string[]).map(option).join(", ");
    case "checkbox":
      return value ? "true" : "false";
    case "date": {
      const d = value as { start: string; end?: string };
      return d.end ? `${d.start} → ${d.end}` : d.start;
    }
    case "person":
    case "creator":
    case "editor": {
      const list = Array.isArray(value) ? (value as PropActor[]) : [value as PropActor];
      return list.map((a) => names?.(a) ?? `${a.type}:${a.id}`).join(", ");
    }
    case "file":
      return (value as string[]).join(", ");
    default:
      return String(value);
  }
}

/** Reads text (CSV, front matter): the inverse of propText for the editable types. */
export function parsePropText(def: PropDef, text: string): PropValue | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const byName = (name: string) => def.options?.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id;
  switch (def.type) {
    case "text":
    case "url":
      return t;
    case "number": {
      const n = Number(t.replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    }
    case "checkbox":
      return isChecked(t);
    case "select":
    case "status":
      return byName(t);
    case "multi_select": {
      const ids = t.split(",").map((s) => byName(s.trim()));
      return ids.every((id) => id) ? (ids as string[]) : undefined;
    }
    case "date": {
      const [start, end] = t.split(/\s*→\s*/);
      return start ? (end ? { start, end } : { start }) : undefined;
    }
    default:
      return undefined;
  }
}

// ---------- property definitions (the schema of a table) ----------

export const MAX_PROPS = 200;
export const MAX_OPTIONS = 200;

const optionSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,64}$/),
    name: z.string().trim().min(1).max(100),
    color: z.string().max(40).optional(),
  })
  .strict();

/** A definition received from outside (API, agent tool). */
export const propDefSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,64}$/),
    name: z.string().trim().min(1).max(100),
    type: z.enum(PROP_TYPES),
    options: z.array(optionSchema).max(MAX_OPTIONS).optional(),
    groups: z
      .object({
        todo: z.array(z.string()).max(MAX_OPTIONS),
        inProgress: z.array(z.string()).max(MAX_OPTIONS),
        done: z.array(z.string()).max(MAX_OPTIONS),
      })
      .strict()
      .optional(),
    numberFormat: z.enum(["plain", "percent", "currency_brl", "currency_usd"]).optional(),
    withTime: z.boolean().optional(),
    formula: z
      .object({
        expression: z.string().max(10_000),
        resultType: z.enum(["number", "text", "boolean", "date", "person", "list", "any"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DefsError =
  | { code: "duplicate_id"; propId: string }
  | { code: "duplicate_name"; propId: string }
  | { code: "duplicate_option"; propId: string }
  | { code: "unknown_group_option"; propId: string }
  | { code: "missing_formula"; propId: string }
  | { code: "too_many_props" };

/**
 * Checks a whole schema: unique ids and names (names compared without case), unique options, status
 * groups only with options that exist, formulas with an expression. Formula types belong to the engine
 * (`formula/`).
 */
export function checkDefs(defs: readonly PropDef[]): DefsError[] {
  const errors: DefsError[] = [];
  if (defs.length > MAX_PROPS) errors.push({ code: "too_many_props" });
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const d of defs) {
    if (ids.has(d.id)) errors.push({ code: "duplicate_id", propId: d.id });
    ids.add(d.id);
    const name = d.name.trim().toLowerCase();
    if (names.has(name)) errors.push({ code: "duplicate_name", propId: d.id });
    names.add(name);
    const opts = new Set<string>();
    for (const o of d.options ?? []) {
      if (opts.has(o.id)) errors.push({ code: "duplicate_option", propId: d.id });
      opts.add(o.id);
    }
    if (
      d.groups &&
      [...d.groups.todo, ...d.groups.inProgress, ...d.groups.done].some((id) => !opts.has(id))
    ) {
      errors.push({ code: "unknown_group_option", propId: d.id });
    }
    if (d.type === "formula" && !d.formula?.expression.trim())
      errors.push({ code: "missing_formula", propId: d.id });
  }
  return errors;
}

/** Text of any stored value, without looking at the type (the basis of the conversion when the type changes). */
export function rawText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(rawText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.start === "string") return typeof o.end === "string" ? `${o.start} → ${o.end}` : o.start;
    if (typeof o.id === "string") return o.id;
    return "";
  }
  return String(value);
}

/**
 * Brings the values in line with the current schema: drops deleted properties and computed types, keeps
 * what is valid and converts the rest through text (a number in text becomes a number, an option name
 * becomes the option). What does not convert is dropped. Runs on the recalculation after a type change.
 */
export function normalizeProps(defs: readonly PropDef[], props: Props): Props {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: Props = {};
  for (const [id, value] of Object.entries(props)) {
    const def = byId.get(id);
    if (!def || COMPUTED_TYPES.has(def.type) || value === null) continue;
    const ok = applyProps([def], {}, { [id]: value });
    if (ok.ok) {
      const v = ok.props[id];
      if (v !== undefined) out[id] = v;
      continue;
    }
    const parsed = parsePropText(def, rawText(value));
    if (parsed === undefined) continue;
    const again = applyProps([def], {}, { [id]: parsed });
    if (again.ok && again.props[id] !== undefined) out[id] = again.props[id] as PropValue;
  }
  return out;
}
