// Formulas, part 1: text → tree. Syntax in the style of Notion Formulas 2.0: literals, `prop("Name")`,
// operators, function calls, dot notation (`x.f(a)` is `f(x, a)`), lists `[a, b]` and `/* … */` and
// `// …` comments. The parser is recursive descent with limits on length, depth and nodes: a user's
// formula is data, never code (no eval, no access to the host).

export const FORMULA_LIMITS = {
  /** Characters of the expression. */
  maxLength: 10_000,
  /** Nesting of the tree (parentheses, calls, operators). */
  maxDepth: 64,
  /** Nodes of the tree. */
  maxNodes: 2_000,
  /**
   * Evaluation steps per row, summing all of its formulas (each evaluated node counts one; text produced
   * counts one every `textPerStep` characters). Per formula, 200 formulas would make 20 million.
   */
  maxSteps: 100_000,
  textPerStep: 100,
  /** Characters of the JSON stored in a row's `computed`, summing all formulas. */
  maxRowOutput: 100_000,
  /** Items of a list produced by the formula. */
  maxList: 10_000,
  /** Characters of a text produced by the formula. */
  maxText: 100_000,
} as const;

export type Span = [start: number, end: number];

export type FormulaErrorCode =
  | "too_long"
  | "too_deep"
  | "too_many_nodes"
  | "unexpected_char"
  | "unterminated_string"
  | "unterminated_comment"
  | "unexpected_token"
  | "expected"
  | "empty"
  | "unknown_function"
  | "unknown_prop"
  | "unknown_identifier"
  | "arity"
  | "type_mismatch"
  | "bad_variable"
  | "cycle"
  | "invalid_unit";

export interface FormulaError {
  code: FormulaErrorCode;
  at: Span;
  /** Message data: function name, expected and received type, arity… */
  detail?: Record<string, string | number>;
}

export class FormulaSyntaxError extends Error {
  constructor(readonly error: FormulaError) {
    super(error.code);
  }
}

type TokenKind = "num" | "str" | "ident" | "op" | "eof";
export interface Token {
  kind: TokenKind;
  value: string;
  at: Span;
}

const OPS = [
  "==",
  "!=",
  ">=",
  "<=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  ">",
  "<",
  "!",
  "?",
  ":",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
];

export function tokenize(src: string): Token[] {
  if (src.length > FORMULA_LIMITS.maxLength) {
    throw new FormulaSyntaxError({
      code: "too_long",
      at: [0, src.length],
      detail: { max: FORMULA_LIMITS.maxLength },
    });
  }
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new FormulaSyntaxError({ code: "unterminated_comment", at: [i, src.length] });
      i = end + 2;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i, i + 400));
      const text = m?.[0] ?? c;
      out.push({ kind: "num", value: text, at: [i, i + text.length] });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= src.length)
          throw new FormulaSyntaxError({ code: "unterminated_string", at: [i, src.length] });
        const d = src[j] as string;
        if (d === c) break;
        if (d === "\\") {
          const e = src[j + 1];
          if (e === undefined)
            throw new FormulaSyntaxError({ code: "unterminated_string", at: [i, src.length] });
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
          continue;
        }
        value += d;
        j++;
      }
      out.push({ kind: "str", value, at: [i, j + 1] });
      i = j + 1;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i, i + 200));
      const text = m?.[0] ?? c;
      out.push({ kind: "ident", value: text, at: [i, i + text.length] });
      i += text.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaSyntaxError({ code: "unexpected_char", at: [i, i + 1], detail: { char: c } });
    out.push({ kind: "op", value: op, at: [i, i + op.length] });
    i += op.length;
  }
  out.push({ kind: "eof", value: "", at: [src.length, src.length] });
  return out;
}

export type Node =
  | { t: "num"; value: number; at: Span }
  | { t: "str"; value: string; at: Span }
  | { t: "bool"; value: boolean; at: Span }
  | { t: "list"; items: Node[]; at: Span }
  /** `prop("Name or id")`: the reference is resolved by the checker. */
  | { t: "prop"; ref: string; at: Span; refAt: Span }
  | { t: "var"; name: string; at: Span }
  | { t: "call"; name: string; args: Node[]; at: Span; nameAt: Span }
  | { t: "unary"; op: "-" | "not"; arg: Node; at: Span }
  | { t: "binary"; op: BinaryOp; left: Node; right: Node; at: Span }
  | { t: "cond"; test: Node; then: Node; else: Node; at: Span };

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "and"
  | "or";

class Parser {
  private pos = 0;
  private depth = 0;
  nodes = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.pos] as Token;
  }
  private next(): Token {
    const t = this.toks[this.pos] as Token;
    if (t.kind !== "eof") this.pos++;
    return t;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return t.kind === "ident" && t.value === v;
  }
  private expect(v: string): Token {
    const t = this.peek();
    if (t.kind === "op" && t.value === v) return this.next();
    throw new FormulaSyntaxError({
      code: "expected",
      at: t.at,
      detail: { expected: v, got: t.value || "end" },
    });
  }
  private node<N extends Node>(n: N): N {
    this.nodes++;
    if (this.nodes > FORMULA_LIMITS.maxNodes) {
      throw new FormulaSyntaxError({
        code: "too_many_nodes",
        at: n.at,
        detail: { max: FORMULA_LIMITS.maxNodes },
      });
    }
    return n;
  }
  private enter(at: Span) {
    this.depth++;
    if (this.depth > FORMULA_LIMITS.maxDepth) {
      throw new FormulaSyntaxError({ code: "too_deep", at, detail: { max: FORMULA_LIMITS.maxDepth } });
    }
  }
  private leave() {
    this.depth--;
  }

  parse(): Node {
    if (this.peek().kind === "eof") throw new FormulaSyntaxError({ code: "empty", at: [0, 0] });
    const n = this.expr();
    const t = this.peek();
    if (t.kind !== "eof")
      throw new FormulaSyntaxError({ code: "unexpected_token", at: t.at, detail: { token: t.value } });
    return n;
  }

  private expr(): Node {
    this.enter(this.peek().at);
    try {
      return this.ternary();
    } finally {
      this.leave();
    }
  }

  private ternary(): Node {
    const test = this.or();
    if (!this.isOp("?")) return test;
    this.next();
    const then = this.expr();
    this.expect(":");
    const other = this.expr();
    return this.node({ t: "cond", test, then, else: other, at: [test.at[0], other.at[1]] });
  }

  private or(): Node {
    let left = this.and();
    while (this.isOp("||") || this.isWord("or")) {
      this.next();
      const right = this.and();
      left = this.node({ t: "binary", op: "or", left, right, at: [left.at[0], right.at[1]] });
    }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.isOp("&&") || this.isWord("and")) {
      this.next();
      const right = this.not();
      left = this.node({ t: "binary", op: "and", left, right, at: [left.at[0], right.at[1]] });
    }
    return left;
  }

  private not(): Node {
    // `not(x)` is the function (a call, high precedence); `not x` and `!x` are the operator
    const call = this.toks[this.pos + 1]?.kind === "op" && this.toks[this.pos + 1]?.value === "(";
    if (this.isOp("!") || (this.isWord("not") && !call)) {
      const t = this.next();
      this.enter(t.at);
      try {
        const arg = this.not();
        return this.node({ t: "unary", op: "not", arg, at: [t.at[0], arg.at[1]] });
      } finally {
        this.leave();
      }
    }
    return this.cmp();
  }

  private cmp(): Node {
    let left = this.add();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || !["==", "!=", ">", ">=", "<", "<="].includes(t.value)) return left;
      this.next();
      const right = this.add();
      left = this.node({ t: "binary", op: t.value as BinaryOp, left, right, at: [left.at[0], right.at[1]] });
    }
  }

  private add(): Node {
    let left = this.mul();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.value !== "+" && t.value !== "-")) return left;
      this.next();
      const right = this.mul();
      left = this.node({ t: "binary", op: t.value, left, right, at: [left.at[0], right.at[1]] });
    }
  }

  private mul(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.value !== "*" && t.value !== "/" && t.value !== "%")) return left;
      this.next();
      const right = this.unary();
      left = this.node({ t: "binary", op: t.value, left, right, at: [left.at[0], right.at[1]] });
    }
  }

  private unary(): Node {
    if (this.isOp("-")) {
      const t = this.next();
      this.enter(t.at);
      try {
        const arg = this.unary();
        return this.node({ t: "unary", op: "-", arg, at: [t.at[0], arg.at[1]] });
      } finally {
        this.leave();
      }
    }
    if (this.isOp("+")) {
      this.next();
      return this.unary();
    }
    return this.pow();
  }

  private pow(): Node {
    const base = this.postfix();
    if (!this.isOp("^")) return base;
    const t = this.next();
    this.enter(t.at);
    try {
      const exp = this.unary(); // right-associative: 2^3^2 = 2^(3^2)
      return this.node({ t: "binary", op: "^", left: base, right: exp, at: [base.at[0], exp.at[1]] });
    } finally {
      this.leave();
    }
  }

  private postfix(): Node {
    let target = this.primary();
    while (this.isOp(".")) {
      this.next();
      const name = this.peek();
      if (name.kind !== "ident") {
        throw new FormulaSyntaxError({
          code: "expected",
          at: name.at,
          detail: { expected: "function", got: name.value || "end" },
        });
      }
      this.next();
      this.enter(name.at);
      try {
        const rest = this.isOp("(") ? this.args() : { args: [], end: name.at[1] };
        target = this.node({
          t: "call",
          name: name.value,
          args: [target, ...rest.args],
          at: [target.at[0], rest.end],
          nameAt: name.at,
        });
      } finally {
        this.leave();
      }
    }
    return target;
  }

  private args(): { args: Node[]; end: number } {
    this.expect("(");
    const args: Node[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.expr());
        if (this.isOp(",")) {
          this.next();
          continue;
        }
        break;
      }
    }
    const close = this.expect(")");
    return { args, end: close.at[1] };
  }

  private primary(): Node {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      return this.node({ t: "num", value: Number(t.value), at: t.at });
    }
    if (t.kind === "str") {
      this.next();
      return this.node({ t: "str", value: t.value, at: t.at });
    }
    if (t.kind === "op" && t.value === "(") {
      this.next();
      const inner = this.expr();
      this.expect(")");
      return inner;
    }
    if (t.kind === "op" && t.value === "[") {
      this.next();
      this.enter(t.at);
      try {
        const items: Node[] = [];
        if (!this.isOp("]")) {
          for (;;) {
            items.push(this.expr());
            if (this.isOp(",")) {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.expect("]");
        return this.node({ t: "list", items, at: [t.at[0], close.at[1]] });
      } finally {
        this.leave();
      }
    }
    if (t.kind === "ident") {
      this.next();
      if (t.value === "true" || t.value === "false")
        return this.node({ t: "bool", value: t.value === "true", at: t.at });
      if (this.isOp("(")) {
        this.enter(t.at);
        try {
          if (t.value === "prop") {
            this.expect("(");
            const ref = this.peek();
            if (ref.kind !== "str") {
              throw new FormulaSyntaxError({
                code: "expected",
                at: ref.at,
                detail: { expected: "text", got: ref.value || "end" },
              });
            }
            this.next();
            const close = this.expect(")");
            return this.node({ t: "prop", ref: ref.value, at: [t.at[0], close.at[1]], refAt: ref.at });
          }
          const { args, end } = this.args();
          return this.node({ t: "call", name: t.value, args, at: [t.at[0], end], nameAt: t.at });
        } finally {
          this.leave();
        }
      }
      return this.node({ t: "var", name: t.value, at: t.at });
    }
    throw new FormulaSyntaxError({ code: "unexpected_token", at: t.at, detail: { token: t.value || "end" } });
  }
}

export function parseFormula(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

/**
 * Replaces the `prop("…")` references with what `map` returns (id ↔ name), touching only the quoted
 * text: comments and formatting stay. A reference `map` does not know stays as it is.
 */
export function rewritePropRefs(src: string, map: (ref: string) => string | undefined): string {
  let toks: Token[];
  try {
    toks = tokenize(src);
  } catch {
    return src;
  }
  let out = "";
  let last = 0;
  for (let i = 0; i + 3 < toks.length; i++) {
    const [a, b, c, d] = [toks[i], toks[i + 1], toks[i + 2], toks[i + 3]] as Token[];
    if (
      a?.kind !== "ident" ||
      a.value !== "prop" ||
      b?.value !== "(" ||
      c?.kind !== "str" ||
      d?.value !== ")"
    )
      continue;
    const next = map(c.value);
    if (next === undefined || next === c.value) continue;
    out += `${src.slice(last, c.at[0])}"${next.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    last = c.at[1];
  }
  return out + src.slice(last);
}
