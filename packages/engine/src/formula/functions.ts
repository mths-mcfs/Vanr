// Formulas, part 3: the function library. Each function knows how to infer its type (checked while
// typing) and how to run. The "lazy" ones (if, ifs, let, lets, map, filter, find, findIndex, some, every,
// sort, and, or) receive the argument trees: they evaluate only the branch that counts and bind `current`
// and `index` per item. Empty (`null`) comes in as the neutral value of the expected type (0, "", false,
// []); an empty date gives empty.
import { FORMULA_LIMITS, type FormulaErrorCode, type Node, type Span } from "./syntax";
import {
  type FDate,
  type FType,
  type FValue,
  fits,
  isDate,
  isoOf,
  isPerson,
  parseIso,
  T,
  typeName,
  typeOf,
  unify,
  utcMs,
} from "./values";

export type TScope = ReadonlyMap<string, FType>;

/**
 * A table looked up by a name the user wrote (function, unit): no prototype, so `toString` or
 * `constructor` are unknown names like any other, not inherited functions.
 */
function lookup<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}
export type VScope = ReadonlyMap<string, FValue>;

export interface Checker {
  infer(n: Node, scope: TScope): FType;
  error(code: FormulaErrorCode, at: Span, detail?: Record<string, string | number>): void;
}

export interface Evaluator {
  eval(n: Node, scope: VScope): FValue;
  /** Counts steps; fails with `too_many_steps`. */
  tick(n?: number): void;
  now(): number;
  rowId(): string;
  fail(code: RuntimeErrorCode, at: Span, detail?: Record<string, string | number>): never;
}

export type RuntimeErrorCode =
  | "type_mismatch"
  | "not_finite"
  | "division_by_zero"
  | "too_many_steps"
  | "list_too_long"
  | "text_too_long"
  | "invalid_date"
  | "invalid_unit"
  | "invalid_argument"
  | "dependency_error"
  | "too_large"
  | "internal";

export interface FnSpec {
  arity: [number, number];
  infer(args: Node[], c: Checker, scope: TScope, at: Span): FType;
  run(args: Node[], e: Evaluator, scope: VScope, at: Span): FValue;
  /** Changes with the clock (now, today): the stored result goes stale. */
  volatile?: boolean;
}

// ---------- runtime helpers ----------

function num(v: FValue, e: Evaluator, at: Span): number {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  return e.fail("type_mismatch", at, { expected: "number", got: typeName(typeOf(v)) });
}
/** Reading text costs by its length, like creating and comparing it: `length(x)` over 10 thousand references to x too. */
function str(v: FValue, e: Evaluator, at: Span): string {
  if (v === null) return "";
  if (typeof v === "string") {
    e.tick(Math.floor(v.length / FORMULA_LIMITS.textPerStep));
    return v;
  }
  return e.fail("type_mismatch", at, { expected: "text", got: typeName(typeOf(v)) });
}
/** Whole characters (an emoji counts as 1). Building the list allocates a string per character: it costs more than reading. */
function chars(v: FValue, e: Evaluator, at: Span): string[] {
  const s = str(v, e, at);
  e.tick(Math.floor(s.length / 10));
  return [...s];
}
function bool(v: FValue, e: Evaluator, at: Span): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  return e.fail("type_mismatch", at, { expected: "boolean", got: typeName(typeOf(v)) });
}
function list(v: FValue, e: Evaluator, at: Span): FValue[] {
  if (v === null) return [];
  if (Array.isArray(v)) return v;
  return e.fail("type_mismatch", at, { expected: "list", got: typeName(typeOf(v)) });
}
function date(v: FValue, e: Evaluator, at: Span): FDate | null {
  if (v === null) return null;
  if (isDate(v)) return v;
  return e.fail("type_mismatch", at, { expected: "date", got: typeName(typeOf(v)) });
}
export function finite(n: number, e: Evaluator, at: Span): number {
  if (!Number.isFinite(n)) e.fail("not_finite", at);
  return n;
}
export function textOk(s: string, e: Evaluator, at: Span): string {
  if (s.length > FORMULA_LIMITS.maxText) e.fail("text_too_long", at, { max: FORMULA_LIMITS.maxText });
  return s;
}
/** Length limit of a list being built. Its cost is charged once, on the finished value (`made` in index.ts). */
export function listOk(l: FValue[], e: Evaluator, at: Span): FValue[] {
  if (l.length > FORMULA_LIMITS.maxList) e.fail("list_too_long", at, { max: FORMULA_LIMITS.maxList });
  return l;
}
function dateOk(ms: number, e: Evaluator, at: Span): number {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) e.fail("invalid_date", at);
  return ms;
}

/** Comparing text costs by its length: a thousand references to the same big text are not free. */
function textCost(a: FValue, b: FValue, e: Evaluator) {
  if (typeof a === "string" && typeof b === "string")
    e.tick(Math.floor(Math.min(a.length, b.length) / FORMULA_LIMITS.textPerStep));
}

/** Deep equality, counting steps (lists repeated inside lists do not blow up). */
export function equal(a: FValue, b: FValue, e: Evaluator): boolean {
  e.tick();
  textCost(a, b, e);
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => equal(x, b[i] as FValue, e));
  }
  if (isDate(a) && isDate(b)) return a.start === b.start && a.end === b.end;
  if (isPerson(a) && isPerson(b)) return a.type === b.type && a.id === b.id;
  return false;
}

const KIND_ORDER = ["number", "text", "boolean", "date", "person", "list", "empty"];

/** Total order used by sort and the comparison operators: number, text, date, boolean. */
export function compare(a: FValue, b: FValue, e: Evaluator): number {
  e.tick();
  textCost(a, b, e);
  const ka = typeOf(a).k;
  const kb = typeOf(b).k;
  if (ka !== kb) return KIND_ORDER.indexOf(ka) - KIND_ORDER.indexOf(kb);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (isDate(a) && isDate(b)) return a.start - b.start;
  if (isPerson(a) && isPerson(b)) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i] as FValue, b[i] as FValue, e);
      if (c) return c;
    }
    return a.length - b.length;
  }
  return 0;
}

export function formatNumber(n: number): string {
  return String(Number(n.toPrecision(15)));
}

/** Text of any value (format, concatenation with +). */
export function show(v: FValue, e: Evaluator, at: Span): string {
  e.tick();
  if (v === null) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    let out = "";
    for (const [i, x] of v.entries()) {
      out += (i ? ", " : "") + show(x, e, at);
      textOk(out, e, at);
    }
    return out;
  }
  if (v.kind === "person") return v.name;
  const start = isoOf(v.start, v.time)
    .replace("T", " ")
    .replace(/:00Z$|Z$/, "");
  if (v.end === undefined) return start;
  return `${start} → ${isoOf(v.end, v.time)
    .replace("T", " ")
    .replace(/:00Z$|Z$/, "")}`;
}

// ---------- builders ----------

interface Overload {
  params: FType[];
  /** How many of the last params are optional. */
  optional?: number;
  /** Type repeated after the params (variadic). */
  rest?: FType;
  ret: FType | ((args: FType[]) => FType);
}

function arityOf(overloads: Overload[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const o of overloads) {
    min = Math.min(min, o.params.length - (o.optional ?? 0));
    max = Math.max(max, o.rest ? Number.POSITIVE_INFINITY : o.params.length);
  }
  return [min, max];
}

function pick(overloads: Overload[], types: FType[]): Overload | { mismatch: number; expected: FType } {
  let best: { mismatch: number; expected: FType } | null = null;
  for (const o of overloads) {
    const min = o.params.length - (o.optional ?? 0);
    if (types.length < min || (!o.rest && types.length > o.params.length)) continue;
    const bad = types.findIndex((t, i) => !fits(t, o.params[i] ?? (o.rest as FType)));
    if (bad < 0) return o;
    if (!best) best = { mismatch: bad, expected: o.params[bad] ?? (o.rest as FType) };
  }
  return best ?? { mismatch: 0, expected: overloads[0]?.params[0] ?? T.any };
}

/** A plain function: evaluates every argument and calls `impl`. */
function eager(
  overloads: Overload[],
  impl: (vals: FValue[], e: Evaluator, at: Span, args: Node[]) => FValue,
  opts: { volatile?: boolean } = {},
): FnSpec {
  return {
    arity: arityOf(overloads),
    volatile: opts.volatile,
    infer(args, c, scope) {
      const types = args.map((a) => c.infer(a, scope));
      const o = pick(overloads, types);
      if ("mismatch" in o) {
        const arg = args[o.mismatch] as Node;
        c.error("type_mismatch", arg.at, {
          expected: typeName(o.expected),
          got: typeName(types[o.mismatch] as FType),
          arg: o.mismatch + 1,
        });
        return T.any;
      }
      return typeof o.ret === "function" ? o.ret(types) : o.ret;
    },
    run(args, e, scope, at) {
      return impl(
        args.map((a) => e.eval(a, scope)),
        e,
        at,
        args,
      );
    },
  };
}

const { number: N, text: S, boolean: B, date: D, person: P, any: A } = T;
const L = T.list(T.any);
const elem = (t: FType | undefined): FType => (t?.k === "list" ? t.of : T.any);

function math(fn: (n: number) => number): FnSpec {
  return eager([{ params: [N], ret: N }], ([v], e, at) =>
    v == null ? null : finite(fn(num(v, e, at)), e, at),
  );
}

/** Numbers from loose arguments or lists (sum(1, 2), sum([1, 2]), sum(prop("List"))). */
function numbers(vals: FValue[], e: Evaluator, at: Span): number[] {
  const out: number[] = [];
  for (const v of vals) {
    if (Array.isArray(v)) for (const x of v) out.push(num(x, e, at));
    else if (v !== null) out.push(num(v, e, at));
    // the numbers are copied out of the lists: one step per item, as for any list built
    e.tick(Array.isArray(v) ? v.length : 1);
  }
  return out;
}
const aggregate = (fn: (ns: number[]) => FValue): FnSpec =>
  eager([{ params: [], rest: A, ret: N }], (vals, e, at) => {
    const ns = numbers(vals, e, at);
    const r = fn(ns);
    return typeof r === "number" ? finite(r, e, at) : r;
  });

// ---------- dates ----------

const UNITS = lookup<string>({
  year: "years",
  years: "years",
  quarter: "quarters",
  quarters: "quarters",
  month: "months",
  months: "months",
  week: "weeks",
  weeks: "weeks",
  day: "days",
  days: "days",
  hour: "hours",
  hours: "hours",
  minute: "minutes",
  minutes: "minutes",
  second: "seconds",
  seconds: "seconds",
  millisecond: "milliseconds",
  milliseconds: "milliseconds",
});
const FIXED_MS = lookup<number>({
  weeks: 7 * 864e5,
  days: 864e5,
  hours: 36e5,
  minutes: 6e4,
  seconds: 1e3,
  milliseconds: 1,
});

function unitOf(v: FValue, e: Evaluator, at: Span): string {
  const u = UNITS[str(v, e, at)];
  if (!u) e.fail("invalid_unit", at, { unit: String(v) });
  return u as string;
}

function checkUnitLiteral(args: Node[], i: number, c: Checker) {
  const n = args[i];
  if (n?.t === "str" && !UNITS[n.value]) c.error("invalid_unit", n.at, { unit: n.value });
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(
    utcMs(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()),
  );
  const last = new Date(utcMs(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.getTime();
}

function shift(ms: number, amount: number, unit: string): number {
  if (unit === "years") return addMonths(ms, Math.trunc(amount) * 12);
  if (unit === "quarters") return addMonths(ms, Math.trunc(amount) * 3);
  if (unit === "months") return addMonths(ms, Math.trunc(amount));
  return ms + amount * (FIXED_MS[unit] as number);
}

function monthsBetween(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  let months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth());
  // an incomplete month does not count (as in moment.diff): 01-31 → 02-28 is 0 months
  if (months > 0 && addMonths(b, months) > a) months--;
  if (months < 0 && addMonths(b, months) < a) months++;
  return months;
}

function between(a: number, b: number, unit: string): number {
  if (unit === "years") return Math.trunc(monthsBetween(a, b) / 12);
  if (unit === "quarters") return Math.trunc(monthsBetween(a, b) / 3);
  if (unit === "months") return monthsBetween(a, b);
  return Math.trunc((a - b) / (FIXED_MS[unit] as number));
}

function isoWeek(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = utcMs(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = utcMs(year, 0, 4);
  const firstDay = (new Date(firstThursday).getUTCDay() + 6) % 7;
  return 1 + Math.round((thursday - (firstThursday - firstDay * 864e5 + 3 * 864e5)) / (7 * 864e5));
}

/** formatDate: YYYY YY MM M DD D HH H hh h mm ss A; text between [brackets] comes out literally. */
export function formatDate(d: FDate, fmt: string): string {
  const one = (ms: number) => {
    const x = new Date(ms);
    const h = x.getUTCHours();
    const map: Record<string, string> = {
      YYYY: String(x.getUTCFullYear()),
      YY: String(x.getUTCFullYear()).slice(-2),
      MM: pad2(x.getUTCMonth() + 1),
      M: String(x.getUTCMonth() + 1),
      DD: pad2(x.getUTCDate()),
      D: String(x.getUTCDate()),
      HH: pad2(h),
      H: String(h),
      hh: pad2(h % 12 || 12),
      h: String(h % 12 || 12),
      mm: pad2(x.getUTCMinutes()),
      ss: pad2(x.getUTCSeconds()),
      A: h < 12 ? "AM" : "PM",
    };
    return fmt.replace(
      /\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|ss|A/g,
      (tok, lit) => lit ?? map[tok] ?? tok,
    );
  };
  return d.end === undefined ? one(d.start) : `${one(d.start)} → ${one(d.end)}`;
}
const pad2 = (n: number) => String(n).padStart(2, "0");

const datePart = (fn: (x: Date) => number): FnSpec =>
  eager([{ params: [D], ret: N }], ([v], e, at) => {
    const d = date(v as FValue, e, at);
    return d ? fn(new Date(d.start)) : null;
  });

// ---------- lazy ----------

function lambdaInfer(args: Node[], c: Checker, scope: TScope, itemType: FType): FType {
  const inner = new Map(scope);
  inner.set("current", itemType);
  inner.set("index", T.number);
  return c.infer(args[1] as Node, inner);
}

function each(
  args: Node[],
  e: Evaluator,
  scope: VScope,
  at: Span,
  fn: (item: FValue, result: FValue, i: number) => boolean | undefined,
) {
  const items = list(e.eval(args[0] as Node, scope), e, at);
  const inner = new Map(scope);
  for (const [i, item] of items.entries()) {
    inner.set("current", item);
    inner.set("index", i);
    if (fn(item, e.eval(args[1] as Node, inner), i) === false) return;
  }
}

function lazyList(
  ret: (item: FType, body: FType, listType: FType) => FType,
  run: (args: Node[], e: Evaluator, scope: VScope, at: Span) => FValue,
  arity: [number, number] = [2, 2],
  predicate = false,
): FnSpec {
  return {
    arity,
    infer(args, c, scope) {
      const lt = c.infer(args[0] as Node, scope);
      if (!fits(lt, L))
        c.error("type_mismatch", (args[0] as Node).at, { expected: "list", got: typeName(lt), arg: 1 });
      const body = args[1] ? lambdaInfer(args, c, scope, elem(lt)) : T.any;
      if (predicate && !fits(body, B))
        c.error("type_mismatch", (args[1] as Node).at, { expected: "boolean", got: typeName(body), arg: 2 });
      return ret(elem(lt), body, lt.k === "list" ? lt : L);
    },
    run,
  };
}

function bindName(n: Node | undefined, c: Checker): string | null {
  if (n?.t === "var" && n.name !== "current" && n.name !== "index") return n.name;
  if (n) c.error("bad_variable", n.at);
  return null;
}

const LAZY: Record<string, FnSpec> = {
  if: {
    arity: [3, 3],
    infer(args, c, scope) {
      const [t, a, b] = args.map((x) => c.infer(x, scope)) as [FType, FType, FType];
      if (!fits(t, B))
        c.error("type_mismatch", (args[0] as Node).at, { expected: "boolean", got: typeName(t), arg: 1 });
      return unify(a, b);
    },
    run(args, e, scope, at) {
      return bool(e.eval(args[0] as Node, scope), e, at)
        ? e.eval(args[1] as Node, scope)
        : e.eval(args[2] as Node, scope);
    },
  },
  ifs: {
    arity: [3, Number.POSITIVE_INFINITY],
    infer(args, c, scope, at) {
      if (args.length % 2 === 0) c.error("arity", at, { min: 3, max: "odd" });
      let out: FType = T.empty;
      for (let i = 0; i < args.length; i++) {
        const t = c.infer(args[i] as Node, scope);
        const isTest = i % 2 === 0 && i < args.length - 1;
        if (isTest && !fits(t, B))
          c.error("type_mismatch", (args[i] as Node).at, {
            expected: "boolean",
            got: typeName(t),
            arg: i + 1,
          });
        if (!isTest) out = unify(out, t);
      }
      return out;
    },
    run(args, e, scope, at) {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (bool(e.eval(args[i] as Node, scope), e, at)) return e.eval(args[i + 1] as Node, scope);
      }
      return args.length % 2 ? e.eval(args[args.length - 1] as Node, scope) : null;
    },
  },
  and: {
    arity: [2, Number.POSITIVE_INFINITY],
    infer: (args, c, scope) => boolArgs(args, c, scope),
    run(args, e, scope, at) {
      for (const a of args) if (!bool(e.eval(a, scope), e, at)) return false;
      return true;
    },
  },
  or: {
    arity: [2, Number.POSITIVE_INFINITY],
    infer: (args, c, scope) => boolArgs(args, c, scope),
    run(args, e, scope, at) {
      for (const a of args) if (bool(e.eval(a, scope), e, at)) return true;
      return false;
    },
  },
  let: {
    arity: [3, 3],
    infer(args, c, scope) {
      const name = bindName(args[0], c);
      const inner = new Map(scope);
      inner.set(name ?? "", c.infer(args[1] as Node, scope));
      return c.infer(args[2] as Node, inner);
    },
    run(args, e, scope) {
      const inner = new Map(scope);
      inner.set((args[0] as { name: string }).name, e.eval(args[1] as Node, scope));
      return e.eval(args[2] as Node, inner);
    },
  },
  lets: {
    arity: [3, Number.POSITIVE_INFINITY],
    infer(args, c, scope, at) {
      if (args.length % 2 === 0) c.error("arity", at, { min: 3, max: "odd" });
      const inner = new Map(scope);
      for (let i = 0; i + 1 < args.length; i += 2) {
        const name = bindName(args[i], c);
        inner.set(name ?? "", c.infer(args[i + 1] as Node, inner));
      }
      return c.infer(args[args.length - 1] as Node, inner);
    },
    run(args, e, scope) {
      const inner = new Map(scope);
      for (let i = 0; i + 1 < args.length; i += 2) {
        inner.set((args[i] as { name: string }).name, e.eval(args[i + 1] as Node, inner));
      }
      return e.eval(args[args.length - 1] as Node, inner);
    },
  },
  map: lazyList(
    (_item, body) => T.list(body),
    (args, e, scope, at) => {
      const out: FValue[] = [];
      each(args, e, scope, at, (_i, r) => {
        out.push(r);
        return undefined;
      });
      return listOk(out, e, at);
    },
  ),
  filter: lazyList(
    (_item, _body, lt) => lt,
    (args, e, scope, at) => {
      const out: FValue[] = [];
      each(args, e, scope, at, (item, r) => {
        if (bool(r, e, at)) out.push(item);
        return undefined;
      });
      return out;
    },
    [2, 2],
    true,
  ),
  find: lazyList(
    (item) => item,
    (args, e, scope, at) => {
      let found: FValue = null;
      each(args, e, scope, at, (item, r) => {
        if (bool(r, e, at)) {
          found = item;
          return false;
        }
        return undefined;
      });
      return found;
    },
    [2, 2],
    true,
  ),
  findIndex: lazyList(
    () => N,
    (args, e, scope, at) => {
      let found = -1;
      each(args, e, scope, at, (_item, r, i) => {
        if (bool(r, e, at)) {
          found = i;
          return false;
        }
        return undefined;
      });
      return found;
    },
    [2, 2],
    true,
  ),
  some: lazyList(
    () => B,
    (args, e, scope, at) => {
      let hit = false;
      each(args, e, scope, at, (_item, r) => {
        if (bool(r, e, at)) {
          hit = true;
          return false;
        }
        return undefined;
      });
      return hit;
    },
    [2, 2],
    true,
  ),
  every: lazyList(
    () => B,
    (args, e, scope, at) => {
      let all = true;
      each(args, e, scope, at, (_item, r) => {
        if (!bool(r, e, at)) {
          all = false;
          return false;
        }
        return undefined;
      });
      return all;
    },
    [2, 2],
    true,
  ),
  sort: lazyList(
    (_item, _body, lt) => lt,
    (args, e, scope, at) => {
      const items = list(e.eval(args[0] as Node, scope), e, at);
      let keys: FValue[] = items;
      if (args[1]) {
        const inner = new Map(scope);
        keys = items.map((item, i) => {
          inner.set("current", item);
          inner.set("index", i);
          return e.eval(args[1] as Node, inner);
        });
      }
      const order = items.map((_, i) => i);
      order.sort((a, b) => compare(keys[a] as FValue, keys[b] as FValue, e) || a - b);
      return order.map((i) => items[i] as FValue);
    },
    [1, 2],
  ),
};

function boolArgs(args: Node[], c: Checker, scope: TScope): FType {
  for (const [i, a] of args.entries()) {
    const t = c.infer(a, scope);
    if (!fits(t, B)) c.error("type_mismatch", a.at, { expected: "boolean", got: typeName(t), arg: i + 1 });
  }
  return B;
}

// ---------- plain ----------

const firstType = (ts: FType[]) => ts[0] ?? T.any;

const EAGER: Record<string, FnSpec> = {
  not: eager([{ params: [B], ret: B }], ([v], e, at) => !bool(v as FValue, e, at)),
  empty: eager([{ params: [A], ret: B }], ([v]) => {
    const x = v as FValue;
    return x === null || x === "" || x === 0 || (Array.isArray(x) && x.length === 0);
  }),
  equal: eager([{ params: [A, A], ret: B }], ([a, b], e) => equal(a as FValue, b as FValue, e)),
  unequal: eager([{ params: [A, A], ret: B }], ([a, b], e) => !equal(a as FValue, b as FValue, e)),

  abs: math(Math.abs),
  ceil: math(Math.ceil),
  floor: math(Math.floor),
  sqrt: math(Math.sqrt),
  cbrt: math(Math.cbrt),
  exp: math(Math.exp),
  ln: math(Math.log),
  log10: math(Math.log10),
  log2: math(Math.log2),
  sign: math(Math.sign),
  round: eager([{ params: [N, N], optional: 1, ret: N }], ([v, p], e, at) => {
    if (v === null) return null;
    const places = Math.max(-15, Math.min(15, Math.trunc(num(p ?? 0, e, at))));
    const f = 10 ** places;
    return finite(Math.round(num(v as FValue, e, at) * f) / f, e, at);
  }),
  pi: eager([{ params: [], ret: N }], () => Math.PI),
  e: eager([{ params: [], ret: N }], () => Math.E),
  mod: eager([{ params: [N, N], ret: N }], ([a, b], e, at) => {
    const d = num(b as FValue, e, at);
    if (d === 0) e.fail("division_by_zero", at);
    return num(a as FValue, e, at) % d;
  }),
  pow: eager([{ params: [N, N], ret: N }], ([a, b], e, at) =>
    finite(num(a as FValue, e, at) ** num(b as FValue, e, at), e, at),
  ),
  sum: aggregate((ns) => ns.reduce((s, n) => s + n, 0)),
  min: aggregate((ns) => (ns.length ? Math.min(...ns) : null)),
  max: aggregate((ns) => (ns.length ? Math.max(...ns) : null)),
  mean: aggregate((ns) => (ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : null)),
  median: aggregate((ns) => {
    if (!ns.length) return null;
    const s = [...ns].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
  }),
  toNumber: eager([{ params: [A], ret: N }], ([v], e, at) => {
    const x = v as FValue;
    if (x === null || typeof x === "number") return x;
    if (typeof x === "boolean") return x ? 1 : 0;
    if (typeof x === "string") {
      const t = str(x, e, at).trim();
      const n = t === "" ? Number.NaN : Number(t.replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    if (isDate(x)) return x.start;
    return null;
  }),

  length: eager(
    [
      { params: [S], ret: N },
      { params: [L], ret: N },
    ],
    ([v], e, at) => {
      const x = v as FValue;
      if (Array.isArray(x)) return x.length;
      return chars(x, e, at).length;
    },
  ),
  substring: eager([{ params: [S, N, N], optional: 1, ret: S }], ([t, a, b], e, at) => {
    const all = chars(t as FValue, e, at);
    return all.slice(num(a as FValue, e, at), b === undefined ? undefined : num(b, e, at)).join("");
  }),
  slice: eager(
    [
      { params: [S, N, N], optional: 1, ret: S },
      { params: [L, N, N], optional: 1, ret: (ts) => firstType(ts) },
    ],
    ([v, a, b], e, at) => {
      const x = v as FValue;
      const start = num(a as FValue, e, at);
      const end = b === undefined ? undefined : num(b, e, at);
      if (Array.isArray(x)) return x.slice(start, end);
      return chars(x, e, at).slice(start, end).join("");
    },
  ),
  contains: eager([{ params: [S, S], ret: B }], ([t, s], e, at) =>
    str(t as FValue, e, at).includes(str(s as FValue, e, at)),
  ),
  // A literal pattern, no regex: a user's regex opens ReDoS (exponential backtracking on the server).
  test: eager([{ params: [S, S], ret: B }], ([t, s], e, at) =>
    str(t as FValue, e, at).includes(str(s as FValue, e, at)),
  ),
  startsWith: eager([{ params: [S, S], ret: B }], ([t, s], e, at) =>
    str(t as FValue, e, at).startsWith(str(s as FValue, e, at)),
  ),
  endsWith: eager([{ params: [S, S], ret: B }], ([t, s], e, at) =>
    str(t as FValue, e, at).endsWith(str(s as FValue, e, at)),
  ),
  replace: eager([{ params: [S, S, S], ret: S }], ([t, f, r], e, at) =>
    textOk(
      str(t as FValue, e, at).replace(str(f as FValue, e, at), () => str(r as FValue, e, at)),
      e,
      at,
    ),
  ),
  replaceAll: eager([{ params: [S, S, S], ret: S }], ([t, f, r], e, at) => {
    const find = str(f as FValue, e, at);
    const text = str(t as FValue, e, at);
    if (find === "") return text;
    const parts = text.split(find);
    e.tick(parts.length);
    const by = str(r as FValue, e, at);
    // the size comes from arithmetic before building: 20 thousand replacements by 50 thousand characters would be 1 GB
    if (text.length + (parts.length - 1) * (by.length - find.length) > FORMULA_LIMITS.maxText)
      e.fail("text_too_long", at, { max: FORMULA_LIMITS.maxText });
    return parts.join(by);
  }),
  // "ß" becomes "SS": changing case can grow the text
  lower: eager([{ params: [S], ret: S }], ([t], e, at) =>
    textOk(str(t as FValue, e, at).toLowerCase(), e, at),
  ),
  upper: eager([{ params: [S], ret: S }], ([t], e, at) =>
    textOk(str(t as FValue, e, at).toUpperCase(), e, at),
  ),
  trim: eager([{ params: [S], ret: S }], ([t], e, at) => str(t as FValue, e, at).trim()),
  repeat: eager([{ params: [S, N], ret: S }], ([t, n], e, at) => {
    const text = str(t as FValue, e, at);
    const times = Math.max(0, Math.trunc(num(n as FValue, e, at)));
    if (text.length * times > FORMULA_LIMITS.maxText)
      e.fail("text_too_long", at, { max: FORMULA_LIMITS.maxText });
    return text.repeat(times);
  }),
  padStart: eager([{ params: [S, N, S], optional: 1, ret: S }], ([t, n, p], e, at) => {
    const len = num(n as FValue, e, at);
    if (len > FORMULA_LIMITS.maxText) e.fail("text_too_long", at, { max: FORMULA_LIMITS.maxText });
    return str(t as FValue, e, at).padStart(len, p === undefined ? " " : str(p, e, at));
  }),
  padEnd: eager([{ params: [S, N, S], optional: 1, ret: S }], ([t, n, p], e, at) => {
    const len = num(n as FValue, e, at);
    if (len > FORMULA_LIMITS.maxText) e.fail("text_too_long", at, { max: FORMULA_LIMITS.maxText });
    return str(t as FValue, e, at).padEnd(len, p === undefined ? " " : str(p, e, at));
  }),
  split: eager([{ params: [S, S], optional: 1, ret: T.list(S) }], ([t, s], e, at) => {
    const text = str(t as FValue, e, at);
    const sep = s === undefined ? " " : str(s, e, at);
    return listOk(sep === "" ? chars(text, e, at) : text.split(sep), e, at);
  }),
  join: eager([{ params: [L, S], optional: 1, ret: S }], ([l, s], e, at) => {
    const items = list(l as FValue, e, at);
    const sep = s === undefined ? ", " : str(s, e, at);
    let out = "";
    for (const [i, x] of items.entries()) {
      out += (i ? sep : "") + show(x, e, at);
      textOk(out, e, at);
    }
    return out;
  }),
  format: eager([{ params: [A], ret: S }], ([v], e, at) => textOk(show(v as FValue, e, at), e, at)),
  concat: eager(
    [{ params: [L], rest: L, ret: (ts) => ts.reduce((a, b) => unify(a, b), T.empty as FType) }],
    (vals, e, at) => {
      const out: FValue[] = [];
      for (const v of vals) {
        for (const x of list(v, e, at)) out.push(x);
        listOk(out, e, at);
      }
      return out;
    },
  ),

  now: eager([{ params: [], ret: D }], (_v, e) => ({ kind: "date", start: e.now(), time: true }), {
    volatile: true,
  }),
  today: eager(
    [{ params: [], ret: D }],
    (_v, e) => {
      const d = new Date(e.now());
      return {
        kind: "date",
        start: utcMs(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
        time: false,
      };
    },
    { volatile: true },
  ),
  year: datePart((x) => x.getUTCFullYear()),
  month: datePart((x) => x.getUTCMonth() + 1),
  date: datePart((x) => x.getUTCDate()),
  day: datePart((x) => ((x.getUTCDay() + 6) % 7) + 1),
  hour: datePart((x) => x.getUTCHours()),
  minute: datePart((x) => x.getUTCMinutes()),
  week: datePart((x) => isoWeek(x.getTime())),
  timestamp: eager([{ params: [D], ret: N }], ([v], e, at) => date(v as FValue, e, at)?.start ?? null),
  fromTimestamp: eager([{ params: [N], ret: D }], ([v], e, at) =>
    v === null ? null : { kind: "date", start: dateOk(num(v as FValue, e, at), e, at), time: true },
  ),
  dateAdd: dateShift(1),
  dateSubtract: dateShift(-1),
  dateBetween: {
    ...eager([{ params: [D, D, S], ret: N }], ([a, b, u], e, at) => {
      const x = date(a as FValue, e, at);
      const y = date(b as FValue, e, at);
      const unit = unitOf(u as FValue, e, at);
      return x && y ? between(x.start, y.start, unit) : null;
    }),
    infer(args, c, scope, at) {
      checkUnitLiteral(args, 2, c);
      return eager([{ params: [D, D, S], ret: N }], () => null).infer(args, c, scope, at);
    },
  },
  dateRange: eager([{ params: [D, D], ret: D }], ([a, b], e, at) => {
    const x = date(a as FValue, e, at);
    const y = date(b as FValue, e, at);
    if (!x || !y) return x ?? y;
    return { kind: "date", start: x.start, end: y.start, time: x.time || y.time };
  }),
  dateStart: eager([{ params: [D], ret: D }], ([v], e, at) => {
    const d = date(v as FValue, e, at);
    return d ? { kind: "date", start: d.start, time: d.time } : null;
  }),
  dateEnd: eager([{ params: [D], ret: D }], ([v], e, at) => {
    const d = date(v as FValue, e, at);
    return d ? { kind: "date", start: d.end ?? d.start, time: d.time } : null;
  }),
  formatDate: eager([{ params: [D, S], optional: 1, ret: S }], ([v, f], e, at) => {
    const d = date(v as FValue, e, at);
    if (!d) return "";
    const fmt = f === undefined ? (d.time ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD") : str(f, e, at);
    if (fmt.length > 200) e.fail("invalid_argument", at);
    return formatDate(d, fmt);
  }),
  parseDate: eager([{ params: [S], ret: D }], ([v], e, at) => {
    const t = str(v as FValue, e, at);
    if (t.trim() === "") return null;
    const p = parseIso(t);
    if (!p) e.fail("invalid_date", at);
    return { kind: "date", start: (p as { ms: number }).ms, time: (p as { time: boolean }).time };
  }),

  at: eager([{ params: [L, N], ret: (ts) => elem(ts[0]) }], ([l, i], e, at) => {
    const items = list(l as FValue, e, at);
    const idx = Math.trunc(num(i as FValue, e, at));
    return items.at(idx) ?? null;
  }),
  first: eager(
    [{ params: [L], ret: (ts) => elem(ts[0]) }],
    ([l], e, at) => list(l as FValue, e, at)[0] ?? null,
  ),
  last: eager(
    [{ params: [L], ret: (ts) => elem(ts[0]) }],
    ([l], e, at) => list(l as FValue, e, at).at(-1) ?? null,
  ),
  reverse: eager([{ params: [L], ret: (ts) => firstType(ts) }], ([l], e, at) =>
    [...list(l as FValue, e, at)].reverse(),
  ),
  includes: eager([{ params: [L, A], ret: B }], ([l, v], e, at) =>
    list(l as FValue, e, at).some((x) => equal(x, v as FValue, e)),
  ),
  unique: eager([{ params: [L], ret: (ts) => firstType(ts) }], ([l], e, at) => {
    const out: FValue[] = [];
    for (const x of list(l as FValue, e, at)) if (!out.some((y) => equal(x, y, e))) out.push(x);
    return out;
  }),
  flat: eager(
    [{ params: [L], ret: (ts) => (elem(ts[0]).k === "list" ? elem(ts[0]) : (ts[0] ?? L)) }],
    ([l], e, at) => {
      const out: FValue[] = [];
      for (const x of list(l as FValue, e, at)) {
        if (Array.isArray(x)) out.push(...x);
        else out.push(x);
        listOk(out, e, at);
      }
      return out;
    },
  ),

  name: eager([{ params: [P], ret: S }], ([v], e, at) => {
    const x = v as FValue;
    if (x === null) return "";
    if (!isPerson(x)) e.fail("type_mismatch", at, { expected: "person", got: typeName(typeOf(x)) });
    return (x as { name: string }).name;
  }),
  id: eager(
    [
      { params: [], ret: S },
      { params: [P], ret: S },
    ],
    ([v], e, at) => {
      if (v === undefined) return e.rowId();
      if (v === null) return "";
      if (!isPerson(v)) e.fail("type_mismatch", at, { expected: "person", got: typeName(typeOf(v)) });
      return (v as { id: string }).id;
    },
  ),
};

function dateShift(sign: 1 | -1): FnSpec {
  const base = eager([{ params: [D, N, S], ret: D }], ([v, n, u], e, at) => {
    const d = date(v as FValue, e, at);
    if (!d) return null;
    const unit = unitOf(u as FValue, e, at);
    const amount = sign * num(n as FValue, e, at);
    const start = dateOk(shift(d.start, amount, unit), e, at);
    const end = d.end === undefined ? undefined : dateOk(shift(d.end, amount, unit), e, at);
    const time = d.time || start % 86_400_000 !== 0 || (end !== undefined && end % 86_400_000 !== 0);
    return end === undefined ? { kind: "date", start, time } : { kind: "date", start, end, time };
  });
  return {
    ...base,
    infer(args, c, scope, at) {
      checkUnitLiteral(args, 2, c);
      return base.infer(args, c, scope, at);
    },
  };
}

export const FUNCTIONS = lookup<FnSpec>({ ...EAGER, ...LAZY });
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
