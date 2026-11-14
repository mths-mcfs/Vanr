// Derives the color pairs the components actually paint, straight from their CSS, so the contrast
// test cannot drift from the styles. A small model of the cascade:
//
// 1. Elements: every `className` in src/components, expanded over its template and conditional
//    parts (`vr-button--${variant}` becomes one element per variant class the CSS defines).
// 2. States: every attribute or pseudo-class qualifier the CSS uses on that element or its
//    ancestors (hover, :active, :disabled, data-state, aria-pressed...), combined up to three at a
//    time, one value per attribute.
// 3. Cascade: for each element, state set and surface, the winning declaration of each color
//    property by specificity and source order, with color and custom properties inherited from
//    the block element a `block__part` class belongs to.
// 4. Pairs: text on its background, border and box-shadow lines on the background inside and the
//    surface outside, SVG fills on their background, filled dots on their container, and the
//    focus ring on every surface.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Pair = { fg: string; bg: string; min: number; use: string };

const ROOT = join(import.meta.dir, "..", "src");

/** Where a component can sit: page, card, dialog or menu, panel, and inside each callout tone. */
export const SURFACES = [
  "bg-canvas",
  "bg-raised",
  "bg-overlay",
  "bg-sunken",
  "info-wash",
  "success-wash",
  "warning-wash",
  "danger-wash",
];

/** Backgrounds that are a surface, not a colored fill: a border on them has to carry the edge. */
const NEUTRAL = new Set([...SURFACES, "bg-hover", "bg-active", "accent-wash", "neutral-wash"]);

const TEXT = 4.5;
const NON_TEXT = 3;

/** Graphics with no text of their own: they need 3:1 (WCAG 1.4.11), not 4.5:1. */
const GRAPHIC =
  /(__icon|__chevron|__thumb|__dot|__indicator|__remove|__close|__mark|__strokes|__joint|__track|__head|--icon)$|^vr-(checkbox|radio|switch|spinner|skeleton|icon|sigil)$/;

/* ---------- CSS ---------- */

type Rule = { selector: string; decls: Map<string, string>; order: number };

function matchClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  throw new Error("unbalanced braces");
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((part) => part.trim()).filter(Boolean);
}

function parseBlock(css: string, rules: Rule[]): void {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) return;
    const close = matchClose(css, open);
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, close);
    i = close + 1;
    if (prelude.startsWith("@keyframes")) continue;
    if (prelude.startsWith("@")) {
      parseBlock(body, rules);
      continue;
    }
    const decls = new Map<string, string>();
    for (const decl of splitTop(body, ";")) {
      const colon = decl.indexOf(":");
      if (colon > 0)
        decls.set(
          decl.slice(0, colon).trim(),
          decl
            .slice(colon + 1)
            .trim()
            .replace(/\s+/g, " "),
        );
    }
    for (const selector of splitTop(prelude, ",")) rules.push({ selector, decls, order: rules.length });
  }
}

export function componentCss(): string {
  const dir = join(ROOT, "styles", "components");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".css"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/* ---------- Selectors ---------- */

type Qual = string; // normalized: ':hover', '[data-state="checked"]', '[aria-pressed="true"]', ':has(...)'
type Compound = { classes: string[]; quals: Qual[]; nots: Qual[][] };
type Selector = { subject: Compound; ancestors: Compound[]; specificity: number };

/** Expands `a:is(b, c)` into `ab` and `ac`. */
function expandIs(selector: string): string[] {
  const at = selector.indexOf(":is(");
  if (at === -1) return [selector];
  let depth = 0;
  let end = at + 3;
  for (; end < selector.length; end++) {
    if (selector[end] === "(") depth++;
    else if (selector[end] === ")" && --depth === 0) break;
  }
  const inner = selector.slice(at + 4, end);
  return splitTop(inner, ",").flatMap((alt) =>
    expandIs(selector.slice(0, at) + alt + selector.slice(end + 1)),
  );
}

function parseCompound(text: string): { compound: Compound; weight: number; typeOnly: boolean } {
  const compound: Compound = { classes: [], quals: [], nots: [] };
  let weight = 0;
  let hasClass = false;
  const token = /\.([\w-]+)|\[([^\]]+)\]|(::?)([\w-]+)(\((?:[^()]|\([^()]*\))*\))?|^([a-z][\w-]*)/g;
  for (const m of text.matchAll(token)) {
    if (m[1] !== undefined) {
      compound.classes.push(m[1]);
      hasClass = true;
      weight++;
    } else if (m[2] !== undefined) {
      compound.quals.push(`[${m[2].replace(/\s/g, "")}]`);
      weight++;
    } else if (m[4] !== undefined) {
      const name = m[4];
      const arg = m[5]?.slice(1, -1) ?? "";
      if (m[3] === "::") compound.quals.push(`::${name}`);
      else if (name === "not") {
        const alts = splitTop(arg, ",").map((alt) => parseCompound(alt).compound.quals);
        compound.nots.push(alts.flat());
        weight++;
      } else if (name === "has") {
        compound.quals.push(`:has(${arg.trim()})`);
        weight++;
      } else if (name === "first-child") {
        weight++;
      } else {
        compound.quals.push(`:${name}`);
        weight++;
      }
    }
  }
  return { compound, weight, typeOnly: !hasClass };
}

const selectorCache = new Map<string, Selector[]>();

function parseSelector(text: string): Selector[] {
  const cached = selectorCache.get(text);
  if (cached !== undefined) return cached;
  const result = expandIs(text).map((alt) => {
    const parts = splitTop(alt.replace(/\s*([>+~])\s*/g, " ").replace(/\s+/g, " "), " ").map(parseCompound);
    let specificity = 0;
    for (const part of parts) specificity += part.weight;
    // A trailing type selector (`span`, `svg`) styles a node inside the element: fold it into
    // the last compound that names a class.
    while (parts.length > 1 && parts[parts.length - 1]?.typeOnly) {
      const last = parts.pop();
      const prev = parts[parts.length - 1];
      if (last !== undefined && prev !== undefined) prev.compound.quals.push(...last.compound.quals);
    }
    const compounds = parts.map((part) => part.compound);
    const subject = compounds.pop() ?? { classes: [], quals: [], nots: [] };
    return { subject, ancestors: compounds, specificity };
  });
  selectorCache.set(text, result);
  return result;
}

/* ---------- Elements ---------- */

type Element = { file: string; classes: string[] };

function classNameExpressions(source: string): string[] {
  const out: string[] = [];
  const marker = /className=/g;
  for (const m of source.matchAll(marker)) {
    let i = (m.index ?? 0) + m[0].length;
    if (source[i] === '"') {
      out.push(source.slice(i, source.indexOf('"', i + 1) + 1));
      continue;
    }
    if (source[i] !== "{") continue;
    let depth = 0;
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    out.push(source.slice(start + 1, i));
  }
  return out;
}

function expandClassName(expr: string, known: string[]): string[][] {
  const inner = expr.match(/^cx\(([\s\S]*)\)$/)?.[1] ?? expr;
  let variants: string[][] = [[]];
  // Two templates on one prefix (`vr-button--${variant}`, `vr-button--${size}`) would pair every
  // option with every other; the first one is expanded and the others add nothing.
  const prefixes = new Set<string>();
  for (const arg of splitTop(inner, ",")) {
    const literal = arg.match(/^"([^"]+)"$/)?.[1];
    const conditional = arg.match(/&&\s*"([^"]+)"$/)?.[1];
    const template = arg.match(/^`([\w-]+)\$\{[^}]+\}`$/)?.[1];
    if (literal !== undefined) variants = variants.map((v) => [...v, ...literal.split(/\s+/)]);
    else if (conditional !== undefined) variants = variants.flatMap((v) => [v, [...v, conditional]]);
    else if (template !== undefined && !prefixes.has(template)) {
      prefixes.add(template);
      const options = known.filter((name) => name.startsWith(template));
      if (options.length > 0) variants = variants.flatMap((v) => options.map((option) => [...v, option]));
    }
  }
  return variants.filter((v) => v.length > 0);
}

export function componentElements(css: string): Element[] {
  const known = [...new Set([...css.matchAll(/\.(vr-[\w-]+)/g)].map((m) => m[1] ?? ""))];
  const dir = join(ROOT, "components");
  const elements: Element[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const expr of classNameExpressions(source)) {
      for (const classes of expandClassName(expr, known)) {
        const key = `${file}:${[...classes].sort().join(" ")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        elements.push({ file, classes });
      }
    }
  }
  return elements;
}

/* ---------- Cascade ---------- */

type Model = { rules: Rule[]; elements: Element[] };

const COLOR_PROPS = ["color", "background", "border", "fill", "stroke", "box-shadow"];

function propKind(prop: string): string | null {
  if (prop.startsWith("--_")) return prop;
  if (prop === "color" || prop === "fill" || prop === "stroke") return prop;
  if (prop === "background" || prop === "background-color") return "background";
  if (prop === "box-shadow") return "box-shadow";
  if (prop.startsWith("border") && !/(width|radius|style)$/.test(prop)) return "border";
  return null;
}

function holds(quals: Qual[], nots: Qual[][], state: Set<Qual>): boolean {
  return quals.every((q) => state.has(q)) && nots.every((alts) => alts.every((q) => !state.has(q)));
}

function matches(sel: Selector, own: Set<string>, ancestorClasses: Set<string>, state: Set<Qual>): boolean {
  if (!sel.subject.classes.every((c) => own.has(c))) return false;
  if (sel.subject.classes.length === 0) return false;
  if (!holds(sel.subject.quals, sel.subject.nots, state)) return false;
  return sel.ancestors.every(
    (a) => a.classes.every((c) => ancestorClasses.has(c)) && holds(a.quals, a.nots, state),
  );
}

type Computed = Map<string, string>;

function cascade(model: Model, own: Set<string>, ancestors: Set<string>, state: Set<Qual>): Computed {
  const winners = new Map<string, { spec: number; order: number; value: string }>();
  for (const rule of model.rules) {
    for (const sel of parseSelector(rule.selector)) {
      if (!matches(sel, own, ancestors, state)) continue;
      for (const [prop, value] of rule.decls) {
        const kind = propKind(prop);
        if (kind === null) continue;
        const current = winners.get(kind);
        if (
          current === undefined ||
          sel.specificity > current.spec ||
          (sel.specificity === current.spec && rule.order > current.order)
        ) {
          winners.set(kind, { spec: sel.specificity, order: rule.order, value });
        }
      }
    }
  }
  return new Map([...winners].map(([k, v]) => [k, v.value]));
}

/** The relevant qualifiers for an element: everything a matching-by-class selector checks. */
function candidateQuals(model: Model, own: Set<string>, ancestors: Set<string>): Qual[] {
  const quals = new Set<Qual>();
  for (const rule of model.rules) {
    if (![...rule.decls.keys()].some((p) => propKind(p) !== null)) continue;
    for (const sel of parseSelector(rule.selector)) {
      if (sel.subject.classes.length === 0 || !sel.subject.classes.every((c) => own.has(c))) continue;
      if (!sel.ancestors.every((a) => a.classes.every((c) => ancestors.has(c)))) continue;
      for (const c of [sel.subject, ...sel.ancestors]) {
        for (const q of c.quals) quals.add(q);
        for (const alts of c.nots) for (const q of alts) quals.add(q);
      }
    }
  }
  return [...quals].sort();
}

function attrName(q: Qual): string | null {
  return q.match(/^\[([\w-]+)/)?.[1] ?? null;
}

function stateSets(quals: Qual[], max = 3): Set<Qual>[] {
  const out: Set<Qual>[] = [new Set()];
  const walk = (start: number, picked: Qual[]) => {
    if (picked.length === max) return;
    for (let i = start; i < quals.length; i++) {
      const q = quals[i] as Qual;
      const name = attrName(q);
      if (name !== null && picked.some((p) => attrName(p) === name)) continue;
      const next = [...picked, q];
      out.push(new Set(next));
      walk(i + 1, next);
    }
  };
  walk(0, []);
  return out;
}

/* ---------- Values ---------- */

type Resolved = { token: string } | { none: true } | { current: true } | { decorative: true };

function resolve(value: string | undefined, vars: Computed): Resolved {
  if (value === undefined) return { none: true };
  if (/transparent|none/.test(value) && !/var\(/.test(value)) return { none: true };
  if (/color-mix/.test(value)) return { decorative: true };
  if (/currentColor/i.test(value)) return { current: true };
  const local = value.match(/var\((--_[\w-]+)\)/)?.[1];
  if (local !== undefined) return resolve(vars.get(local), vars);
  const token = [...value.matchAll(/var\(--vr-([\w-]+)\)/g)]
    .map((m) => m[1] ?? "")
    .filter((name) => !/^(border|ring|radius|space|control|duration|ease|z-|text|weight|font)/.test(name))
    .pop();
  return token === undefined ? { none: true } : { token };
}

/* ---------- Pairs ---------- */

export function derivePairs(): Pair[] {
  const css = componentCss();
  const rules: Rule[] = [];
  parseBlock(css, rules);
  const model: Model = { rules, elements: componentElements(css) };
  const pairs = new Map<string, Pair>();
  const add = (fg: string, bg: string, min: number, use: string) => {
    const key = `${fg}|${bg}|${min}`;
    if (!pairs.has(key)) pairs.set(key, { fg, bg, min, use });
  };

  const blockOf = (classes: string[]) =>
    classes.map((c) => c.match(/^(vr-[\w-]+?)__/)?.[1]).find((b): b is string => b !== undefined);

  for (const element of model.elements) {
    const own = new Set(element.classes);
    const block = blockOf(element.classes);
    // Parents: same-file elements that carry the block class. A part with no parent in its file
    // (a portalled panel) is evaluated on the surfaces alone.
    const parents =
      block === undefined
        ? [undefined]
        : (() => {
            const found = model.elements.filter((e) => e.file === element.file && e.classes.includes(block));
            return found.length > 0 ? found : [undefined];
          })();
    for (const parent of parents) {
      const parentOwn = new Set(parent?.classes ?? []);
      const quals = candidateQuals(model, own, parentOwn);
      const parentQuals = parent === undefined ? [] : candidateQuals(model, parentOwn, new Set());
      const allQuals = [...new Set([...quals, ...parentQuals])].sort();
      for (const state of stateSets(allQuals)) {
        const mine = cascade(model, own, parentOwn, state);
        if (![...mine.keys()].some((k) => COLOR_PROPS.includes(k) || k.startsWith("--_"))) continue;
        const inherited =
          parent === undefined ? new Map<string, string>() : cascade(model, parentOwn, new Set(), state);
        const vars: Computed = new Map([...inherited, ...mine]);
        const use = `${element.classes.join(".")} ${[...state].join("")}`.trim();
        const graphic = element.classes.some((c) => GRAPHIC.test(c));

        const colorValue = mine.get("color") ?? inherited.get("color") ?? "var(--vr-fg)";
        const fg = resolve(colorValue, vars);
        const ownBg = resolve(mine.get("background"), vars);
        const parentBg = resolve(inherited.get("background"), vars);
        const outside = "token" in parentBg ? [parentBg.token] : SURFACES;
        const behind = "token" in ownBg ? [ownBg.token] : outside;

        // Scrims, tints and hairline separators carry no content.
        if ("decorative" in ownBg || ("token" in ownBg && ownBg.token === "line")) continue;
        if ("current" in ownBg) {
          // A filled shape painted in the text color: it must stand out from its container.
          if ("token" in fg) for (const bg of outside) add(fg.token, bg, NON_TEXT, `${use} fill`);
          continue;
        }
        // A graphic that never sets its own color paints nothing with the inherited one.
        const paintsText = !graphic || mine.has("color");
        if ("token" in fg && paintsText)
          for (const bg of behind) add(fg.token, bg, graphic ? NON_TEXT : TEXT, use);

        // A colored fill (accent, danger) must stand out from the surface by itself; on a neutral
        // background it is the border that has to carry the edge.
        const filled = "token" in ownBg && !NEUTRAL.has(ownBg.token);
        if (filled) for (const bg of outside) add(ownBg.token, bg, NON_TEXT, `${use} fill outside`);
        for (const prop of ["border", "box-shadow"]) {
          const line = resolve(mine.get(prop), vars);
          if (!("token" in line) || line.token === "line") continue;
          if ("token" in ownBg && !filled) add(line.token, ownBg.token, NON_TEXT, `${use} ${prop} inside`);
          for (const bg of outside) add(line.token, bg, NON_TEXT, `${use} ${prop} outside`);
        }
        for (const prop of ["fill", "stroke"]) {
          const paint = resolve(mine.get(prop), vars);
          const color = "current" in paint ? fg : paint;
          if ("token" in color && !("current" in paint && !mine.has(prop))) {
            for (const bg of behind) add(color.token, bg, NON_TEXT, `${use} ${prop}`);
          }
        }
      }
    }
  }
  // The focus ring sits outside the element, on whatever surface holds it.
  for (const bg of SURFACES) add("focus", bg, NON_TEXT, "focus ring");
  return [...pairs.values()];
}

/** The resolved color tokens of an element (its classes) in a state (its qualifiers). */
export function computedColors(classes: string[], state: Qual[]): Record<string, string | undefined> {
  const css = componentCss();
  const rules: Rule[] = [];
  parseBlock(css, rules);
  const model: Model = { rules, elements: [] };
  const computed = cascade(model, new Set(classes), new Set(), new Set(state));
  const out: Record<string, string | undefined> = {};
  for (const prop of ["color", "background", "border"]) {
    const value = resolve(computed.get(prop), computed);
    out[prop] = "token" in value ? value.token : undefined;
  }
  return out;
}
