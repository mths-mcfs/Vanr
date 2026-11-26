// Runtime validators for data that comes from outside the process: HTTP responses, socket frames and
// anything read back from storage. Each validator returns a fresh value holding only what it declares,
// so an extra field the server adds never leaks into the app as an untyped property.
//
// `Schema<T>` is invariant in T: `const x: Schema<Channel> = object({...})` only compiles when the object
// describes exactly the Channel type, which is how the generated schemas are held to @vanr/contract.

export interface Issue {
  /** Where in the value it failed, as a JSON path (`$.messages[3].author.id`). */
  path: string;
  expected: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issue: Issue };

export interface Schema<T> {
  readonly expected: string;
  check(value: unknown, path: string): Result<T>;
  /** Phantom member: makes the type invariant, so a schema can't stand for a wider or narrower type. */
  readonly __type?: (value: T) => T;
}

/** A field that may be absent. Only `object` reads the mark. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

/** Any schema, for generic constraints (no phantom member, so every Schema<T> fits). */
export interface AnySchema {
  readonly expected: string;
  check(value: unknown, path: string): Result<unknown>;
}

export type Infer<S> = S extends { check(value: unknown, path: string): Result<infer T> } ? T : never;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (path: string, expected: string): { ok: false; issue: Issue } => ({
  ok: false,
  issue: { path, expected },
});

function primitive<T>(expected: string, test: (v: unknown) => v is T): Schema<T> {
  return { expected, check: (v, path) => (test(v) ? ok(v) : fail(path, expected)) };
}

export const string = primitive("string", (v): v is string => typeof v === "string");
export const number = primitive("number", (v): v is number => typeof v === "number" && Number.isFinite(v));
export const boolean = primitive("boolean", (v): v is boolean => typeof v === "boolean");
export const nullValue = primitive("null", (v): v is null => v === null);
/** Any JSON value, passed through as is (the contract says `unknown`). */
export const unknown: Schema<unknown> = { expected: "any value", check: (v) => ok(v) };

type Literal = string | number | boolean;

export function literal<const L extends readonly Literal[]>(...values: L): Schema<L[number]> {
  const expected = values.map((v) => JSON.stringify(v)).join(" | ");
  const allowed: readonly unknown[] = values;
  return {
    expected,
    check: (v, path) => {
      const i = allowed.indexOf(v);
      return i === -1 ? fail(path, expected) : ok(values[i] as L[number]);
    },
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    get expected() {
      return `${inner.expected} | null`;
    },
    check: (v, path) => (v === null ? ok(null) : inner.check(v, path)),
  };
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    get expected() {
      return `${inner.expected} | undefined`;
    },
    optional: true,
    check: (v, path) => (v === undefined ? ok(undefined) : inner.check(v, path)),
  };
}

/**
 * An optional field that reads a value it doesn't accept as absent instead of failing the whole answer:
 * for closed lists that a newer server may extend (an agent's body, mouth, extra).
 */
export function lenient<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    get expected() {
      return `${inner.expected} | undefined`;
    },
    optional: true,
    check: (v, path) => {
      const r = v === undefined ? undefined : inner.check(v, path);
      return r?.ok ? r : ok(undefined);
    },
  };
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return {
    get expected() {
      return `${item.expected}[]`;
    },
    check: (v, path) => {
      if (!Array.isArray(v)) return fail(path, "array");
      const out: T[] = [];
      for (let i = 0; i < v.length; i++) {
        const r = item.check(v[i], `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    },
  };
}

type TupleOf<S extends readonly AnySchema[]> = { -readonly [K in keyof S]: Infer<S[K]> };

export function tuple<const S extends readonly AnySchema[]>(...items: S): Schema<TupleOf<S>> {
  return {
    get expected() {
      return `[${items.map((s) => s.expected).join(", ")}]`;
    },
    check: (v, path) => {
      if (!Array.isArray(v) || v.length !== items.length) return fail(path, `tuple of ${items.length}`);
      const out: unknown[] = [];
      for (const [i, s] of items.entries()) {
        const r = s.check(v[i], `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out as TupleOf<S>);
    },
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Sets an own property whatever its name. A plain `out[k] = v` with k = "__proto__" would replace the
 * object's prototype instead (and drop the key); defining the property keeps it as data, like JSON.parse.
 */
function put(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The value of `key` only when the object has it itself (never one inherited from Object.prototype). */
const own = (v: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(v, key) ? v[key] : undefined;

export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  return {
    get expected() {
      return `Record<string, ${value.expected}>`;
    },
    check: (v, path) => {
      if (!isPlainObject(v)) return fail(path, "object");
      const out: Record<string, T> = {};
      for (const [k, item] of Object.entries(v)) {
        const r = value.check(item, `${path}.${k}`);
        if (!r.ok) return r;
        put(out, k, r.value);
      }
      return ok(out);
    },
  };
}

/**
 * A map keyed by a closed set (`Partial<Record<Kind, V>>`). A key outside the set is dropped rather than
 * rejected: a newer server may know a kind this client doesn't, and the typed value stays correct.
 */
export function partialRecord<K extends string, T>(
  keys: Schema<K>,
  value: Schema<T>,
): Schema<Partial<Record<K, T>>> {
  return {
    get expected() {
      return `Partial<Record<${keys.expected}, ${value.expected}>>`;
    },
    check: (v, path) => {
      if (!isPlainObject(v)) return fail(path, "object");
      const out: Partial<Record<K, T>> = {};
      for (const [k, item] of Object.entries(v)) {
        const key = keys.check(k, path);
        if (!key.ok) continue;
        const r = value.check(item, `${path}.${k}`);
        if (!r.ok) return r;
        put(out, key.value, r.value);
      }
      return ok(out);
    },
  };
}

type Shape = Record<string, AnySchema>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type Flatten<T> = { [K in keyof T]: T[K] };
export type InferShape<S extends Shape> = Flatten<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

export function object<S extends Shape>(shape: S): Schema<InferShape<S>>;
/** With `rest`, keys outside the shape are kept and checked against it (an index signature). */
export function object<S extends Shape, R>(
  shape: S,
  rest: Schema<R>,
): Schema<InferShape<S> & { [key: string]: R }>;
export function object(shape: Shape, rest?: AnySchema): Schema<Record<string, unknown>> {
  const entries = Object.entries(shape);
  const expected = `{ ${entries.map(([k]) => k).join(", ")} }`;
  return {
    expected,
    check: (v, path) => {
      if (!isPlainObject(v)) return fail(path, "object");
      const out: Record<string, unknown> = {};
      for (const [k, s] of entries) {
        const r = s.check(own(v, k), `${path}.${k}`);
        if (!r.ok) return r;
        if (r.value !== undefined) put(out, k, r.value);
      }
      if (rest) {
        for (const [k, item] of Object.entries(v)) {
          if (Object.hasOwn(shape, k)) continue;
          const r = rest.check(item, `${path}.${k}`);
          if (!r.ok) return r;
          put(out, k, r.value);
        }
      }
      return ok(out);
    },
  };
}

const depth = (path: string) => (path.match(/[.[]/g) ?? []).length;

/** The first member that accepts the value wins; a discriminated union is checked by its tag first. */
export function union<const S extends readonly AnySchema[]>(...members: S): Schema<Infer<S[number]>> {
  const expected = () => members.map((m) => m.expected).join(" | ");
  return {
    get expected() {
      return expected();
    },
    check: (v, path) => {
      let deepest: Issue | null = null;
      for (const m of members) {
        const r = m.check(v, path);
        if (r.ok) return ok(r.value as Infer<S[number]>);
        if (!deepest || depth(r.issue.path) > depth(deepest.path)) deepest = r.issue;
      }
      // The member that got furthest says the most about what was wrong.
      return {
        ok: false,
        issue: deepest && deepest.path !== path ? deepest : { path, expected: expected() },
      };
    },
  };
}

/** Both object schemas over the same value, their outputs merged (`Base & { extra }`). */
export function merge<A extends object, B extends object>(a: Schema<A>, b: Schema<B>): Schema<A & B> {
  return {
    get expected() {
      return `${a.expected} & ${b.expected}`;
    },
    check: (v, path) => {
      const ra = a.check(v, path);
      if (!ra.ok) return ra;
      const rb = b.check(v, path);
      if (!rb.ok) return rb;
      // Spreading defines own properties (it never runs the __proto__ setter), so every key survives.
      return ok({ ...ra.value, ...rb.value });
    },
  };
}

/** A reference resolved on first use, so schemas can refer to each other in any order (and recursively). */
export function lazy<T>(get: () => Schema<T>): Schema<T> {
  let cached: Schema<T> | null = null;
  const resolve = () => {
    cached ??= get();
    return cached;
  };
  return {
    get expected() {
      return resolve().expected;
    },
    check: (v, path) => resolve().check(v, path),
  };
}

/** A value checked by `inner` and then turned into another (`{ channels: [...] }` into the array). */
export function map<A, B>(inner: Schema<A>, to: (a: A) => B): Schema<B> {
  return {
    get expected() {
      return inner.expected;
    },
    check: (v, path) => {
      const r = inner.check(v, path);
      return r.ok ? ok(to(r.value)) : r;
    },
  };
}

/** `{ [key]: T }` checked and unwrapped to T: most list routes answer `{ channels: Channel[] }`. */
export function field<K extends string, T>(key: K, inner: Schema<T>): Schema<T> {
  return map(object({ [key]: inner } as Record<K, Schema<T>>), (o) => (o as Record<K, T>)[key]);
}

export class ValidationError extends Error {
  constructor(readonly issue: Issue) {
    super(`Expected ${issue.expected} at ${issue.path}`);
    this.name = "ValidationError";
  }
}

/** Checks a whole value and throws ValidationError when it doesn't match. */
export function parse<T>(schema: Schema<T>, value: unknown): T {
  const r = schema.check(value, "$");
  if (!r.ok) throw new ValidationError(r.issue);
  return r.value;
}
