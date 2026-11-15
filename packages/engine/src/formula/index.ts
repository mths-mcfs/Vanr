// Formulas per column: our own engine, with the semantics of Notion Formulas 2.0. The same code runs on
// the server (recalculation, stored in `computed`) and in the browser (type and error while typing).
//
// planFormulas(defs) compiles every formula of the table: resolves `prop("…")` by id or name, builds the
// dependency graph, finds cycles and checks types in topological order. evaluateRow runs the plan on a
// row, with a step limit; an error in one formula becomes `{ err }` only there and in what depends on it.
import type { FormulaResultType, PropActor, PropDef, Props } from "../props";
import {
  type Checker,
  compare,
  type Evaluator,
  equal,
  FUNCTIONS,
  finite,
  type RuntimeErrorCode,
  show,
  type TScope,
  textOk,
  type VScope,
} from "./functions";
import {
  FORMULA_LIMITS,
  type FormulaError,
  type FormulaErrorCode,
  FormulaSyntaxError,
  type Node,
  parseFormula,
  type Span,
} from "./syntax";
import {
  type ComputedJson,
  type FType,
  type FValue,
  fits,
  isDate,
  jsonSize,
  parseIso,
  T,
  toJson,
  typeName,
  unify,
} from "./values";

export { FUNCTION_NAMES } from "./functions";
export {
  FORMULA_LIMITS,
  type FormulaError,
  type FormulaErrorCode,
  parseFormula,
  rewritePropRefs,
} from "./syntax";
export { type ComputedJson, type FType, type FValue, T, typeName } from "./values";

export function resultTypeOf(t: FType): FormulaResultType {
  return t.k === "empty" ? "any" : t.k;
}

/** Type of a property inside a formula. */
export function propFType(def: PropDef, formulaTypes?: ReadonlyMap<string, FType>): FType {
  switch (def.type) {
    case "number":
      return T.number;
    case "checkbox":
      return T.boolean;
    case "date":
    case "created_time":
    case "edited_time":
      return T.date;
    case "multi_select":
    case "file":
      return T.list(T.text);
    case "person":
      return T.list(T.person);
    case "creator":
    case "editor":
      return T.person;
    case "formula":
      return formulaTypes?.get(def.id) ?? T.any;
    case "relation":
      return T.list(T.text);
    case "rollup":
      return typeOfResult(def.rollup?.resultType);
    default:
      return T.text;
  }
}

/** The type saved in the schema (`resultType`) back as a formula type. */
function typeOfResult(r: FormulaResultType | undefined): FType {
  switch (r) {
    case "number":
      return T.number;
    case "text":
      return T.text;
    case "boolean":
      return T.boolean;
    case "date":
      return T.date;
    case "person":
      return T.person;
    case "list":
      return T.list(T.any);
    default:
      return T.any;
  }
}

/** Finds the property of `prop("…")`: id first, then exact name, then name without case. */
export function resolveProp(defs: readonly PropDef[], ref: string): PropDef | undefined {
  return (
    defs.find((d) => d.id === ref) ??
    defs.find((d) => d.name === ref) ??
    defs.find((d) => d.name.toLowerCase() === ref.toLowerCase())
  );
}

function collectRefs(n: Node, out: Node[] = []): Node[] {
  if (n.t === "prop") out.push(n);
  else if (n.t === "list") for (const x of n.items) collectRefs(x, out);
  else if (n.t === "call") for (const x of n.args) collectRefs(x, out);
  else if (n.t === "unary") collectRefs(n.arg, out);
  else if (n.t === "binary") {
    collectRefs(n.left, out);
    collectRefs(n.right, out);
  } else if (n.t === "cond") {
    collectRefs(n.test, out);
    collectRefs(n.then, out);
    collectRefs(n.else, out);
  }
  return out;
}

class TypeChecker implements Checker {
  errors: FormulaError[] = [];
  volatile = false;
  constructor(
    private readonly defs: readonly PropDef[],
    private readonly formulaTypes: ReadonlyMap<string, FType>,
  ) {}

  error(code: FormulaErrorCode, at: Span, detail?: Record<string, string | number>) {
    this.errors.push(detail ? { code, at, detail } : { code, at });
  }

  infer(n: Node, scope: TScope): FType {
    switch (n.t) {
      case "num":
        return T.number;
      case "str":
        return T.text;
      case "bool":
        return T.boolean;
      case "list":
        return T.list(n.items.reduce<FType>((acc, x) => unify(acc, this.infer(x, scope)), T.empty));
      case "prop": {
        const def = resolveProp(this.defs, n.ref);
        if (!def) {
          this.error("unknown_prop", n.refAt, { name: n.ref });
          return T.any;
        }
        return propFType(def, this.formulaTypes);
      }
      case "var": {
        const t = scope.get(n.name);
        if (t) return t;
        this.error("unknown_identifier", n.at, { name: n.name });
        return T.any;
      }
      case "call": {
        const fn = FUNCTIONS[n.name];
        if (!fn) {
          this.error("unknown_function", n.nameAt, { name: n.name });
          for (const a of n.args) this.infer(a, scope);
          return T.any;
        }
        if (fn.volatile) this.volatile = true;
        const [min, max] = fn.arity;
        if (n.args.length < min || n.args.length > max) {
          this.error("arity", n.nameAt, { name: n.name, min, max: Number.isFinite(max) ? max : "∞" });
          return T.any;
        }
        return fn.infer(n.args, this, scope, n.at);
      }
      case "unary": {
        const t = this.infer(n.arg, scope);
        const want = n.op === "-" ? T.number : T.boolean;
        if (!fits(t, want))
          this.error("type_mismatch", n.arg.at, { expected: typeName(want), got: typeName(t) });
        return want;
      }
      case "cond": {
        const t = this.infer(n.test, scope);
        if (!fits(t, T.boolean))
          this.error("type_mismatch", n.test.at, { expected: "boolean", got: typeName(t) });
        return unify(this.infer(n.then, scope), this.infer(n.else, scope));
      }
      case "binary":
        return this.binary(n, scope);
    }
  }

  private binary(n: Extract<Node, { t: "binary" }>, scope: TScope): FType {
    const a = this.infer(n.left, scope);
    const b = this.infer(n.right, scope);
    const bad = (side: Node, t: FType, want: string) =>
      this.error("type_mismatch", side.at, { expected: want, got: typeName(t) });
    switch (n.op) {
      case "+":
        if (a.k === "text" || b.k === "text") return T.text;
        if (!fits(a, T.number)) bad(n.left, a, "number");
        else if (!fits(b, T.number)) bad(n.right, b, "number");
        return a.k === "any" || b.k === "any" ? T.any : T.number;
      case "-":
      case "*":
      case "/":
      case "%":
      case "^":
        if (!fits(a, T.number)) bad(n.left, a, "number");
        if (!fits(b, T.number)) bad(n.right, b, "number");
        return T.number;
      case "==":
      case "!=":
        return T.boolean;
      case "and":
      case "or":
        if (!fits(a, T.boolean)) bad(n.left, a, "boolean");
        if (!fits(b, T.boolean)) bad(n.right, b, "boolean");
        return T.boolean;
      default: {
        const ok = (t: FType) => ["number", "text", "date", "boolean", "any", "empty"].includes(t.k);
        if (!ok(a)) bad(n.left, a, "number");
        else if (!ok(b)) bad(n.right, b, "number");
        else if (a.k !== b.k && a.k !== "any" && b.k !== "any" && a.k !== "empty" && b.k !== "empty") {
          bad(n.right, b, typeName(a));
        }
        return T.boolean;
      }
    }
  }
}

export interface FormulaCheck {
  type: FType;
  errors: FormulaError[];
  /** Ids of the properties read. */
  deps: string[];
  volatile: boolean;
}

/** Checks a single formula (the editor calls it on every keystroke). */
export function checkFormula(
  src: string,
  defs: readonly PropDef[],
  formulaTypes: ReadonlyMap<string, FType> = new Map(),
): FormulaCheck & { ast?: Node } {
  let ast: Node;
  try {
    ast = parseFormula(src);
  } catch (err) {
    if (err instanceof FormulaSyntaxError)
      return { type: T.any, errors: [err.error], deps: [], volatile: false };
    throw err;
  }
  const checker = new TypeChecker(defs, formulaTypes);
  const type = checker.infer(ast, new Map());
  const deps = [
    ...new Set(
      collectRefs(ast)
        .map((r) => resolveProp(defs, (r as { ref: string }).ref)?.id)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  return { type, errors: checker.errors, deps, volatile: checker.volatile, ast };
}

export interface CompiledFormula {
  propId: string;
  ast: Node;
  type: FType;
  deps: string[];
  volatile: boolean;
}

export interface FormulaPlan {
  /** Formulas without errors, in calculation order (dependencies first). */
  order: CompiledFormula[];
  /** Errors per formula (syntax, type, unknown property, cycle). */
  errors: Map<string, FormulaError[]>;
  types: Map<string, FType>;
  volatile: boolean;
}

/** Compiles every formula of the table, in dependency graph order. */
export function planFormulas(defs: readonly PropDef[]): FormulaPlan {
  const formulas = defs.filter((d) => d.type === "formula");
  const errors = new Map<string, FormulaError[]>();
  const types = new Map<string, FType>();
  const asts = new Map<string, Node>();
  const deps = new Map<string, string[]>();
  for (const d of formulas) {
    try {
      const ast = parseFormula(d.formula?.expression ?? "");
      asts.set(d.id, ast);
      const ids = collectRefs(ast)
        .map((r) => resolveProp(defs, (r as { ref: string }).ref))
        .filter((x): x is PropDef => x?.type === "formula")
        .map((x) => x.id);
      deps.set(d.id, [...new Set(ids)]);
    } catch (err) {
      if (!(err instanceof FormulaSyntaxError)) throw err;
      errors.set(d.id, [err.error]);
    }
  }
  // topological order with cycle detection (three-color DFS)
  const color = new Map<string, 0 | 1 | 2>();
  const sorted: string[] = [];
  const inCycle = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    const c = color.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      for (const x of stack.slice(stack.indexOf(id))) inCycle.add(x);
      return;
    }
    color.set(id, 1);
    for (const dep of deps.get(id) ?? []) if (asts.has(dep)) visit(dep, [...stack, id]);
    color.set(id, 2);
    sorted.push(id);
  };
  for (const id of asts.keys()) visit(id, []);
  const order: CompiledFormula[] = [];
  let volatile = false;
  const bad = new Set(errors.keys());
  for (const id of sorted) {
    const ast = asts.get(id) as Node;
    if (inCycle.has(id)) {
      errors.set(id, [{ code: "cycle", at: ast.at }]);
      bad.add(id);
      continue;
    }
    const checker = new TypeChecker(defs, types);
    const type = checker.infer(ast, new Map());
    types.set(id, type);
    if (checker.errors.length) {
      errors.set(id, checker.errors);
      bad.add(id);
      continue;
    }
    volatile ||= checker.volatile;
    const allDeps = [
      ...new Set(
        collectRefs(ast)
          .map((r) => resolveProp(defs, (r as { ref: string }).ref)?.id)
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    order.push({ propId: id, ast, type, deps: allDeps, volatile: checker.volatile });
  }
  return { order, errors, types, volatile };
}

// ---------- execution ----------

export class FormulaRuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    readonly at: Span,
    readonly detail?: Record<string, string | number>,
  ) {
    super(code);
  }
}

/** What the formula reads from the row. */
export interface RowData {
  id: string;
  props: Props;
  createdAt: string;
  createdBy: PropActor | null;
  editedAt: string;
  editedBy: PropActor | null;
  /**
   * What comes from other rows: the titles of the linked rows (relation) and the rollup's value, by the
   * property id. Whoever runs the formula loads them first; without them a relation is an empty list.
   */
  extra?: Readonly<Record<string, FValue>>;
}

export interface EvalContext {
  /** ms of "now" (now, today): one per recalculation, so the whole row sees the same instant. */
  now: number;
  names?: (a: PropActor) => string;
}

function actorValue(a: PropActor, names?: (a: PropActor) => string): FValue {
  return { kind: "person", type: a.type, id: a.id, name: names?.(a) ?? a.id };
}

/** An instant recorded by the system (created/edited at): always with a time. */
function instant(text: string | undefined): FValue {
  const ms = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(ms) ? { kind: "date", start: ms, time: true } : null;
}

/** Value of a stored property, as the formula sees it. */
export function propValue(def: PropDef, row: RowData, names?: (a: PropActor) => string): FValue {
  const v = row.props[def.id];
  const option = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
  switch (def.type) {
    case "created_time":
      return instant(row.createdAt);
    case "edited_time":
      return instant(row.editedAt);
    case "creator":
      return row.createdBy ? actorValue(row.createdBy, names) : null;
    case "editor":
      return row.editedBy ? actorValue(row.editedBy, names) : null;
    case "relation":
      return row.extra?.[def.id] ?? [];
    case "rollup":
      return row.extra?.[def.id] ?? null;
    default:
      break;
  }
  if (v === undefined || v === null)
    return def.type === "multi_select" || def.type === "person" || def.type === "file" ? [] : null;
  switch (def.type) {
    case "select":
    case "status":
      return option(String(v));
    case "multi_select":
      return (v as string[]).map(option);
    case "date": {
      const d = v as { start: string; end?: string };
      const s = parseIso(d.start);
      if (!s) return null;
      const e = d.end ? parseIso(d.end) : null;
      return e
        ? { kind: "date", start: s.ms, end: e.ms, time: s.time }
        : { kind: "date", start: s.ms, time: s.time };
    }
    case "person":
      return (v as PropActor[]).map((a) => actorValue(a, names));
    case "file":
      return [...(v as string[])];
    case "number":
    case "checkbox":
    case "text":
    case "url":
      return v as FValue;
    default:
      return null;
  }
}

class RowEvaluator implements Evaluator {
  steps = 0;
  constructor(
    private readonly defs: readonly PropDef[],
    private readonly row: RowData,
    private readonly ctx: EvalContext,
    private readonly formulaValues: ReadonlyMap<string, FValue | FormulaRuntimeError>,
    /** Steps already spent by the row's other formulas. */
    private readonly rowBudget: { steps: number },
  ) {}

  tick(n = 1) {
    this.steps += n;
    this.rowBudget.steps += n;
    if (this.rowBudget.steps > FORMULA_LIMITS.maxSteps)
      this.fail("too_many_steps", [0, 0], { max: FORMULA_LIMITS.maxSteps });
  }

  /**
   * The single check on every value a function or operator makes, and on every property read. New text costs by its length: without
   * this, `map(list, repeat("b", 100000))` fit in the steps. A new list costs one step per item, whichever
   * function copied it: without this, `map(xs, reverse(xs))` copied millions of items for a few thousand
   * steps. A number that is not finite is an error, never a value (it would be stored as null).
   */
  private made(v: FValue, at: Span): FValue {
    if (typeof v === "string" && v.length >= FORMULA_LIMITS.textPerStep)
      this.tick(Math.floor(v.length / FORMULA_LIMITS.textPerStep));
    else if (Array.isArray(v)) this.tick(v.length);
    else if (typeof v === "number" && !Number.isFinite(v)) this.fail("not_finite", at);
    return v;
  }
  now() {
    return this.ctx.now;
  }
  rowId() {
    return this.row.id;
  }
  fail(code: RuntimeErrorCode, at: Span, detail?: Record<string, string | number>): never {
    throw new FormulaRuntimeError(code, at, detail);
  }

  eval(n: Node, scope: VScope): FValue {
    this.tick();
    switch (n.t) {
      case "num":
        return n.value;
      case "str":
        return n.value;
      case "bool":
        return n.value;
      case "list": {
        const out = n.items.map((x) => this.eval(x, scope));
        this.tick(out.length);
        return out;
      }
      case "prop": {
        // A property read is a door through which a list enters: a stored list is copied on every read
        // (propValue) and another formula's list is handed over. Both pay per item, like a made value.
        const def = resolveProp(this.defs, n.ref);
        if (!def) return this.fail("dependency_error", n.at, { name: n.ref });
        if (def.type === "formula") {
          const v = this.formulaValues.get(def.id);
          if (v instanceof FormulaRuntimeError || v === undefined)
            this.fail("dependency_error", n.at, { name: def.name });
          return this.made(v as FValue, n.at);
        }
        return this.made(propValue(def, this.row, this.ctx.names), n.at);
      }
      case "var":
        return scope.get(n.name) ?? null;
      case "call": {
        const fn = FUNCTIONS[n.name];
        if (!fn) return this.fail("invalid_argument", n.at, { name: n.name });
        return this.made(fn.run(n.args, this, scope, n.at), n.at);
      }
      case "unary": {
        const v = this.eval(n.arg, scope);
        if (n.op === "not") {
          if (v !== null && typeof v !== "boolean")
            this.fail("type_mismatch", n.arg.at, { expected: "boolean" });
          return !v;
        }
        if (v === null) return null;
        if (typeof v !== "number") this.fail("type_mismatch", n.arg.at, { expected: "number" });
        return -(v as number);
      }
      case "cond": {
        const t = this.eval(n.test, scope);
        if (t !== null && typeof t !== "boolean")
          this.fail("type_mismatch", n.test.at, { expected: "boolean" });
        return t ? this.eval(n.then, scope) : this.eval(n.else, scope);
      }
      case "binary":
        return this.made(this.binary(n, scope), n.at);
    }
  }

  private number(v: FValue, at: Span): number {
    if (v === null) return 0;
    if (typeof v !== "number") this.fail("type_mismatch", at, { expected: "number" });
    return v as number;
  }

  private binary(n: Extract<Node, { t: "binary" }>, scope: VScope): FValue {
    if (n.op === "and" || n.op === "or") {
      const a = this.eval(n.left, scope);
      if (a !== null && typeof a !== "boolean")
        this.fail("type_mismatch", n.left.at, { expected: "boolean" });
      if (n.op === "and" ? !a : a) return Boolean(a);
      const b = this.eval(n.right, scope);
      if (b !== null && typeof b !== "boolean")
        this.fail("type_mismatch", n.right.at, { expected: "boolean" });
      return Boolean(b);
    }
    const a = this.eval(n.left, scope);
    const b = this.eval(n.right, scope);
    switch (n.op) {
      case "+":
        if (typeof a === "string" || typeof b === "string") {
          return textOk(show(a, this, n.at) + show(b, this, n.at), this, n.at);
        }
        if (a === null && b === null) return null;
        return finite(this.number(a, n.left.at) + this.number(b, n.right.at), this, n.at);
      case "-":
        return finite(this.number(a, n.left.at) - this.number(b, n.right.at), this, n.at);
      case "*":
        return finite(this.number(a, n.left.at) * this.number(b, n.right.at), this, n.at);
      case "/": {
        const d = this.number(b, n.right.at);
        if (d === 0) this.fail("division_by_zero", n.at);
        return finite(this.number(a, n.left.at) / d, this, n.at);
      }
      case "%": {
        const d = this.number(b, n.right.at);
        if (d === 0) this.fail("division_by_zero", n.at);
        return this.number(a, n.left.at) % d;
      }
      case "^":
        return finite(this.number(a, n.left.at) ** this.number(b, n.right.at), this, n.at);
      case "==":
        return equal(a, b, this);
      case "!=":
        return !equal(a, b, this);
      default: {
        const [x, y] = coerceForCompare(a, b);
        if (x === null || y === null) return false;
        if (typeof x !== typeof y || isDate(x) !== isDate(y) || Array.isArray(x) || Array.isArray(y)) {
          this.fail("type_mismatch", n.right.at, {});
        }
        const c = compare(x, y, this);
        return n.op === ">" ? c > 0 : n.op === ">=" ? c >= 0 : n.op === "<" ? c < 0 : c <= 0;
      }
    }
  }
}

/** Empty against a number/text/boolean becomes the other side's neutral value; against a date, the comparison is false. */
function coerceForCompare(a: FValue, b: FValue): [FValue, FValue] {
  const neutral = (other: FValue): FValue =>
    typeof other === "number"
      ? 0
      : typeof other === "string"
        ? ""
        : typeof other === "boolean"
          ? false
          : null;
  if (a === null && b === null) return [0, 0];
  if (a === null) return [neutral(b), b];
  if (b === null) return [a, neutral(a)];
  return [a, b];
}

export interface RowResult {
  /** JSON values per formula id (absent = empty). */
  computed: Record<string, ComputedJson>;
  /** Steps spent (sum over the formulas). */
  steps: number;
}

/** Runs the table's formulas on a row. */
export function evaluateRow(
  plan: FormulaPlan,
  defs: readonly PropDef[],
  row: RowData,
  ctx: EvalContext,
  output = 0,
): RowResult {
  const values = new Map<string, FValue | FormulaRuntimeError>();
  const computed: Record<string, ComputedJson> = {};
  const budget = { steps: 0 };
  let steps = 0;
  for (const [id, errs] of plan.errors) computed[id] = { err: errs[0]?.code ?? "invalid" };
  for (const f of plan.order) {
    const ev = new RowEvaluator(defs, row, ctx, values, budget);
    try {
      const v = ev.eval(f.ast, new Map());
      output += v === null ? 0 : jsonSize(v, FORMULA_LIMITS.maxRowOutput - output);
      if (output > FORMULA_LIMITS.maxRowOutput)
        throw new FormulaRuntimeError("too_large", f.ast.at, { max: FORMULA_LIMITS.maxRowOutput });
      const json = toJson(v);
      values.set(f.propId, v);
      if (json !== undefined) computed[f.propId] = json;
    } catch (err) {
      if (!(err instanceof FormulaRuntimeError)) {
        // a stack overflow in JS itself (or a bug of ours): the formula fails, the row goes on
        values.set(f.propId, new FormulaRuntimeError("internal", f.ast.at));
        computed[f.propId] = { err: "internal" };
      } else {
        values.set(f.propId, err);
        computed[f.propId] = { err: err.code };
      }
    }
    steps += ev.steps;
  }
  return { computed, steps };
}

/** Evaluates a standalone formula on a row (preview in the editor). */
export function previewFormula(
  src: string,
  defs: readonly PropDef[],
  row: RowData,
  ctx: EvalContext,
):
  | { ok: true; value: ComputedJson | null; type: FType }
  | { ok: false; errors: FormulaError[] }
  | { ok: false; runtime: string; type: FType } {
  const self = "__preview__";
  const withSelf: PropDef[] = [
    ...defs,
    { id: self, name: self, type: "formula", formula: { expression: src } },
  ];
  const plan = planFormulas(withSelf);
  const errs = plan.errors.get(self);
  if (errs) return { ok: false, errors: errs };
  const type = plan.types.get(self) ?? T.any;
  const v = evaluateRow(plan, withSelf, row, ctx).computed[self];
  if (v && typeof v === "object" && "err" in v) return { ok: false, runtime: v.err, type };
  return { ok: true, value: v ?? null, type };
}
