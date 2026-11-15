// Generates src/contract-schemas.ts: one runtime validator per type declared in @vanr/contract.
//
//   bun run --cwd packages/client schemas
//
// The contract is plain TypeScript types, so this reads its source with a small parser for the subset it
// uses (interfaces with `extends`, literal unions, arrays, tuples, inline objects, `Record`, `Partial`,
// intersections, one index signature). Each schema is annotated with its contract type and `Schema<T>` is
// invariant, so the typechecker rejects a schema that doesn't describe exactly its type; a test regenerates
// the file and fails when the committed copy is stale.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Node =
  | { k: "kw"; name: "string" | "number" | "boolean" | "unknown" | "null" | "undefined" }
  | { k: "lit"; value: string | number | boolean }
  | { k: "ref"; name: string; args: Node[] }
  | { k: "array"; item: Node }
  | { k: "tuple"; items: Node[] }
  | { k: "object"; fields: Field[]; rest: Node | null }
  | { k: "union"; members: Node[] }
  | { k: "inter"; members: Node[] };

interface Field {
  name: string;
  optional: boolean;
  type: Node;
}

interface Decl {
  name: string;
  file: string;
  node: Node;
  /** Bases of an interface, merged before its own fields. */
  bases: string[];
}

const SKIP = new Set(["index.ts", "permissions.ts"]);

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = src.indexOf(c, i + 1);
      out += src.slice(i, end + 1);
      i = end + 1;
    } else if (src.startsWith("//", i)) {
      i = src.indexOf("\n", i);
      if (i === -1) break;
    } else if (src.startsWith("/*", i)) {
      i = src.indexOf("*/", i) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const TOKEN = /\s*([A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|\S)/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  for (;;) {
    const m = TOKEN.exec(src);
    if (!m?.[1]) break;
    out.push(m[1]);
  }
  return out;
}

class Parser {
  i = 0;
  constructor(readonly t: string[]) {}
  peek(o = 0): string | undefined {
    return this.t[this.i + o];
  }
  next(): string {
    const v = this.t[this.i++];
    if (v === undefined) throw new Error("unexpected end of type");
    return v;
  }
  eat(v: string): boolean {
    if (this.peek() !== v) return false;
    this.i++;
    return true;
  }
  expect(v: string): void {
    const got = this.next();
    if (got !== v)
      throw new Error(`expected ${v}, got ${got} near ${this.t.slice(this.i - 5, this.i + 5).join(" ")}`);
  }

  type(): Node {
    this.eat("|");
    const members = [this.inter()];
    while (this.eat("|")) members.push(this.inter());
    return members.length === 1 ? (members[0] as Node) : { k: "union", members };
  }
  inter(): Node {
    const members = [this.postfix()];
    while (this.eat("&")) members.push(this.postfix());
    return members.length === 1 ? (members[0] as Node) : { k: "inter", members };
  }
  postfix(): Node {
    let n = this.primary();
    while (this.peek() === "[" && this.peek(1) === "]") {
      this.i += 2;
      n = { k: "array", item: n };
    }
    return n;
  }
  primary(): Node {
    const tok = this.next();
    if (tok === "(") {
      const n = this.type();
      this.expect(")");
      return n;
    }
    if (tok === "{") return this.members();
    if (tok === "[") {
      const items: Node[] = [];
      while (!this.eat("]")) {
        items.push(this.type());
        this.eat(",");
      }
      return { k: "tuple", items };
    }
    if (tok.startsWith('"') || tok.startsWith("'"))
      return { k: "lit", value: JSON.parse(`"${tok.slice(1, -1)}"`) };
    if (/^-?\d/.test(tok)) return { k: "lit", value: Number(tok) };
    if (tok === "true" || tok === "false") return { k: "lit", value: tok === "true" };
    if (["string", "number", "boolean", "unknown", "null", "undefined"].includes(tok)) {
      return { k: "kw", name: tok as "string" };
    }
    if (tok === "readonly") return this.primary();
    const args: Node[] = [];
    if (this.eat("<")) {
      do args.push(this.type());
      while (this.eat(","));
      this.expect(">");
    }
    return { k: "ref", name: tok, args };
  }
  /** After `{`: fields up to the matching `}`. */
  members(): Node {
    const fields: Field[] = [];
    let rest: Node | null = null;
    while (!this.eat("}")) {
      this.eat("readonly");
      if (this.eat("[")) {
        this.next(); // key name
        this.expect(":");
        this.expect("string");
        this.expect("]");
        this.expect(":");
        rest = this.type();
      } else {
        const raw = this.next();
        const name = raw.startsWith('"') ? raw.slice(1, -1) : raw;
        const optional = this.eat("?");
        this.expect(":");
        fields.push({ name, optional, type: this.type() });
      }
      if (!this.eat(";")) this.eat(",");
    }
    return { k: "object", fields, rest };
  }
}

/** Every interface and `type X =` declared at the top of the contract sources, in file order. */
export function readContract(dir: string): Decl[] {
  const decls: Decl[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !SKIP.has(f))
    .sort();
  for (const file of files) {
    const p = new Parser(tokenize(stripComments(readFileSync(join(dir, file), "utf8"))));
    while (p.peek() !== undefined) {
      const at = p.peek() === "export" ? 1 : 0;
      const kind = p.peek(at);
      if (kind === "interface") {
        p.i += at + 1;
        const name = p.next();
        const bases: string[] = [];
        if (p.eat("extends")) {
          do bases.push(p.next());
          while (p.eat(","));
        }
        p.expect("{");
        decls.push({ name, file, node: p.members(), bases });
      } else if (kind === "type" && p.peek(at + 2) === "=") {
        p.i += at + 1;
        const name = p.next();
        p.expect("=");
        decls.push({ name, file, node: p.type(), bases: [] });
        p.eat(";");
      } else {
        p.i++;
      }
    }
  }
  return decls;
}

class Emitter {
  readonly byName: Map<string, Decl>;
  constructor(
    decls: Decl[],
    readonly exported: Set<string>,
  ) {
    this.byName = new Map(decls.map((d) => [d.name, d]));
  }

  /** The fields of an object-like type: an interface (with its bases), an inline object or an intersection. */
  fieldsOf(n: Node): { fields: Field[]; rest: Node | null } | null {
    if (n.k === "object") return { fields: n.fields, rest: n.rest };
    if (n.k === "inter") {
      const merged = new Map<string, Field>();
      let rest: Node | null = null;
      for (const m of n.members) {
        const f = this.fieldsOf(m);
        if (!f) return null;
        for (const x of f.fields) merged.set(x.name, x);
        rest ??= f.rest;
      }
      return { fields: [...merged.values()], rest };
    }
    if (n.k === "ref" && n.name === "Partial" && n.args[0]) {
      const f = this.fieldsOf(n.args[0]);
      return f && { fields: f.fields.map((x) => ({ ...x, optional: true })), rest: f.rest };
    }
    if (n.k === "ref" && n.args.length === 0) {
      const d = this.byName.get(n.name);
      if (!d) return null;
      return this.declFields(d);
    }
    return null;
  }

  declFields(d: Decl): { fields: Field[]; rest: Node | null } | null {
    const own = this.fieldsOf(d.node);
    if (!own) return null;
    if (d.bases.length === 0) return own;
    return this.fieldsOf({
      k: "inter",
      members: [...d.bases.map((name) => ({ k: "ref" as const, name, args: [] })), d.node],
    });
  }

  emit(n: Node): string {
    switch (n.k) {
      case "kw":
        return n.name === "null"
          ? "s.nullValue"
          : n.name === "undefined"
            ? "s.optional(s.unknown)"
            : `s.${n.name}`;
      case "lit":
        return `s.literal(${JSON.stringify(n.value)})`;
      case "array":
        return `s.array(${this.emit(n.item)})`;
      case "tuple":
        return `s.tuple(${n.items.map((x) => this.emit(x)).join(", ")})`;
      case "union": {
        const nonNull = n.members.filter((m) => !(m.k === "kw" && m.name === "null"));
        const inner: Node = nonNull.length === 1 ? (nonNull[0] as Node) : { k: "union", members: nonNull };
        if (nonNull.length !== n.members.length) return `s.nullable(${this.emit(inner)})`;
        if (nonNull.every((m) => m.k === "lit")) {
          return `s.literal(${nonNull.map((m) => JSON.stringify(m.k === "lit" ? m.value : null)).join(", ")})`;
        }
        return `s.union(${nonNull.map((m) => this.emit(m)).join(", ")})`;
      }
      case "object":
      case "inter":
        return this.emitObject(n);
      case "ref":
        return this.emitRef(n);
    }
  }

  emitObject(n: Node): string {
    const f = this.fieldsOf(n);
    if (!f) throw new Error(`not an object type: ${JSON.stringify(n).slice(0, 200)}`);
    const body = f.fields
      .map((x) => {
        const v = this.emit(x.type);
        return `${/^[A-Za-z_$][\w$]*$/.test(x.name) ? x.name : JSON.stringify(x.name)}: ${x.optional ? `s.optional(${v})` : v}`;
      })
      .join(", ");
    return f.rest ? `s.object({ ${body} }, ${this.emit(f.rest)})` : `s.object({ ${body} })`;
  }

  emitRef(n: Extract<Node, { k: "ref" }>): string {
    const [a, b] = n.args;
    if (n.name === "Record" && a && b) {
      if (a.k === "kw" && a.name === "string") return `s.record(${this.emit(b)})`;
      return `s.partialRecord(${this.emit(a)}, ${this.emit(b)})`;
    }
    if (n.name === "Partial" && a) {
      if (a.k === "ref" && a.name === "Record") {
        const [k, v] = a.args;
        if (k && v) return `s.partialRecord(${this.emit(k)}, ${this.emit(v)})`;
      }
      return this.emitObject(n);
    }
    if (n.name === "Exclude" && a && b) {
      // Only over literal unions: what is left of the first after taking out the second.
      const from = this.literalsOf(a);
      const out = this.literalsOf(b);
      if (!from || !out)
        throw new Error(`Exclude over non-literal types: ${JSON.stringify(n).slice(0, 200)}`);
      const left = from.filter((v) => !out.includes(v));
      return `s.literal(${left.map((v) => JSON.stringify(v)).join(", ")})`;
    }
    if (!this.byName.has(n.name)) throw new Error(`unknown type ${n.name}`);
    return `s.lazy(() => ${n.name})`;
  }

  /** The values of a literal union (through named aliases), or null when it isn't one. */
  literalsOf(n: Node): (string | number | boolean)[] | null {
    if (n.k === "lit") return [n.value];
    if (n.k === "union") {
      const all: (string | number | boolean)[] = [];
      for (const m of n.members) {
        const vs = this.literalsOf(m);
        if (!vs) return null;
        all.push(...vs);
      }
      return all;
    }
    if (n.k === "ref" && n.args.length === 0) {
      const d = this.byName.get(n.name);
      return d && d.bases.length === 0 ? this.literalsOf(d.node) : null;
    }
    return null;
  }

  declaration(d: Decl): string {
    const value =
      d.bases.length > 0 || d.node.k === "object"
        ? this.emitObject({
            k: "inter",
            members: [...d.bases.map((name) => ({ k: "ref" as const, name, args: [] })), d.node],
          })
        : this.emit(d.node);
    const type = this.exported.has(d.name) ? `: Schema<C.${d.name}>` : "";
    return `${this.exported.has(d.name) ? "export " : ""}const ${d.name}${type} = ${value};`;
  }
}

/** Type names the contract's index re-exports (the ones a client can name). */
export function exportedTypes(dir: string): Set<string> {
  const index = stripComments(readFileSync(join(dir, "index.ts"), "utf8"));
  const names = new Set<string>();
  for (const block of index.matchAll(/export type \{([^}]*)\}/g)) {
    for (const name of (block[1] ?? "").split(",")) if (name.trim()) names.add(name.trim());
  }
  return names;
}

export function generate(dir: string): string {
  const decls = readContract(dir);
  const exported = exportedTypes(dir);
  const e = new Emitter(decls, exported);
  const lines = [
    "// Generated by scripts/gen-schemas.ts from packages/contract/src. Do not edit: run",
    "// `bun run --cwd packages/client schemas` after changing the contract.",
    'import type * as C from "@vanr/contract";',
    'import * as s from "./schema.ts";',
    'import type { Schema } from "./schema.ts";',
    "",
  ];
  for (const d of decls) lines.push(e.declaration(d));
  return `${lines.join("\n")}\n`;
}

export const CONTRACT_DIR = join(import.meta.dir, "..", "..", "contract", "src");
export const OUTPUT = join(import.meta.dir, "..", "src", "contract-schemas.ts");

if (import.meta.main) {
  await Bun.write(OUTPUT, generate(CONTRACT_DIR));
  console.log(`wrote ${OUTPUT}`);
}
