// Formulas, part 2: static types (checked while typing) and runtime values, with the conversion to and
// from the JSON stored in `computed`. Dates in UTC.
import { type PropActor, storableText } from "../props";

export type FType =
  | { k: "number" }
  | { k: "text" }
  | { k: "boolean" }
  | { k: "date" }
  | { k: "person" }
  | { k: "empty" }
  | { k: "any" }
  | { k: "list"; of: FType };

export const T = {
  number: { k: "number" } as FType,
  text: { k: "text" } as FType,
  boolean: { k: "boolean" } as FType,
  date: { k: "date" } as FType,
  person: { k: "person" } as FType,
  empty: { k: "empty" } as FType,
  any: { k: "any" } as FType,
  list: (of: FType): FType => ({ k: "list", of }),
};

export function typeName(t: FType): string {
  return t.k === "list" ? `list<${typeName(t.of)}>` : t.k;
}

/** Does `actual` fit where `expected` is wanted? `any` and `empty` fit everything. */
export function fits(actual: FType, expected: FType): boolean {
  if (expected.k === "any" || actual.k === "any" || actual.k === "empty") return true;
  if (expected.k === "list") return actual.k === "list" && fits(actual.of, expected.of);
  return actual.k === expected.k;
}

/** Common type of two branches (if, ifs, list items): the same one, or `any`. */
export function unify(a: FType, b: FType): FType {
  if (a.k === "empty") return b;
  if (b.k === "empty") return a;
  if (a.k === "list" && b.k === "list") return T.list(unify(a.of, b.of));
  return a.k === b.k ? a : T.any;
}

export interface FDate {
  kind: "date";
  /** ms since 1970 (UTC). */
  start: number;
  end?: number;
  /** With a time (otherwise, only the date). */
  time: boolean;
}

export interface FPerson {
  kind: "person";
  type: "person" | "agent";
  id: string;
  name: string;
}

export type FValue = null | number | string | boolean | FDate | FPerson | FValue[];

export function isDate(v: FValue): v is FDate {
  return typeof v === "object" && v !== null && !Array.isArray(v) && v.kind === "date";
}
export function isPerson(v: FValue): v is FPerson {
  return typeof v === "object" && v !== null && !Array.isArray(v) && v.kind === "person";
}

export function typeOf(v: FValue): FType {
  if (v === null) return T.empty;
  if (typeof v === "number") return T.number;
  if (typeof v === "string") return T.text;
  if (typeof v === "boolean") return T.boolean;
  if (Array.isArray(v)) return T.list(v.length ? typeOf(v[0] as FValue) : T.any);
  return v.kind === "date" ? T.date : T.person;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function isoOf(ms: number, time: boolean): string {
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!time) return day;
  return `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** ISO (`2026-10-22`, `2026-10-22T10:00Z`, with an offset) → ms; invalid → null. */
export function parseIso(text: string): { ms: number; time: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text.trim());
  if (!m) return null;
  const ms = m[4]
    ? Date.parse(m[7] ? text.trim() : `${text.trim()}Z`)
    : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms)) return null;
  // Date.UTC turns 2026-02-31 into March: reject it
  if (!m[4]) {
    const d = new Date(ms);
    if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  }
  return { ms, time: Boolean(m[4]) };
}

/** JSON stored in `computed[propId]`. An error becomes `{ err: code }`. */
export type ComputedJson =
  | number
  | string
  | boolean
  | { start: string; end?: string }
  | PropActor
  | (ComputedJson | null)[]
  | { err: string };

// what JSON escapes: a quote or a backslash becomes 2 characters; a control character, up to 6 (\u0001)
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters JSON escapes
const ESCAPED = /["\\\u0000-\u001f]/g;
const escapedSize = (s: string) => {
  let n = s.length + 2;
  for (const m of s.matchAll(ESCAPED)) n += m[0] < " " ? 5 : 1;
  return n;
};

/**
 * Upper bound of the size of `v` as JSON, without building the text; stops as soon as it passes `cap`.
 * A list with 10 thousand references to the same text takes little memory, but would become 1 GB of JSON.
 */
export function jsonSize(v: FValue, cap: number): number {
  let n = 0;
  const walk = (x: FValue) => {
    if (x === null || typeof x === "boolean") n += 5;
    else if (typeof x === "number") n += 24;
    else if (typeof x === "string") n += escapedSize(x);
    else if (Array.isArray(x)) {
      n += 2;
      for (const y of x) {
        if (n > cap) return;
        n += 1;
        walk(y);
      }
    } else n += 80;
  };
  walk(v);
  return n;
}

export function toJson(v: FValue): ComputedJson | undefined {
  if (v === null) return undefined;
  // the text goes to jsonb: what Postgres rejects is removed here, wherever it came from
  if (typeof v === "string") return storableText(v);
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => toJson(x) ?? null);
  if (v.kind === "date") {
    return v.end === undefined
      ? { start: isoOf(v.start, v.time) }
      : { start: isoOf(v.start, v.time), end: isoOf(v.end, v.time) };
  }
  return { type: v.type, id: v.id };
}
