import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { contrast, parseColorTokens, readStyles, type Theme } from "./tokens.ts";

/** 4.5:1 for body text, 3:1 for large text, icons, control borders and focus rings (WCAG 1.4.3, 1.4.11). */
const TEXT = 4.5;
const NON_TEXT = 3;

type Pair = { fg: string; bg: string; min: number; use: string };

const pairs: Pair[] = [];
function pair(fgs: string[], bgs: string[], min: number, use: string): void {
  for (const fg of fgs) for (const bg of bgs) pairs.push({ fg, bg, min, use });
}

const SURFACES = ["bg-canvas", "bg-raised", "bg-sunken", "bg-overlay", "bg-hover", "bg-active"];
const WASHES = ["info-wash", "success-wash", "warning-wash", "danger-wash", "neutral-wash", "accent-wash"];

// Text on every surface: body copy, labels, hints, menu items, table rows.
pair(["fg", "fg-muted"], SURFACES, TEXT, "text on surface");
// Placeholder and secondary metadata: inputs, menus, rows, the page.
pair(["fg-subtle"], ["bg-canvas", "bg-raised", "bg-overlay", "bg-hover"], TEXT, "placeholder and metadata");
// Disabled controls keep readable text; they are told apart by the dashed border and missing fill.
pair(["fg-disabled"], ["bg-canvas", "bg-raised", "bg-sunken", "bg-overlay"], TEXT, "disabled text");
// Tooltip.
pair(["fg-inverse"], ["bg-inverse"], TEXT, "tooltip");
// Primary and danger buttons, checkbox check, switch thumb.
pair(["on-accent"], ["accent", "accent-hover"], TEXT, "text on accent");
pair(["on-danger"], ["danger", "danger-hover"], TEXT, "text on danger");
// Links, selected tab, running status, agent sigil, selected chip.
pair(["accent-fg"], ["bg-canvas", "bg-raised", "bg-overlay", "bg-hover", "accent-wash"], TEXT, "accent text");
// Tone text on its own wash (callout title, status badge) and on plain overlays (toast title, icons).
for (const tone of ["info", "success", "warning", "danger", "neutral"]) {
  pair([`${tone}-fg`], [`${tone}-wash`], TEXT, `${tone} text on wash`);
  pair([`${tone}-fg`], ["bg-raised", "bg-overlay", "bg-canvas"], TEXT, `${tone} text on surface`);
}
// Field error text, danger menu item (hovered too).
pair(["danger-fg"], ["bg-hover"], TEXT, "danger item hovered");
// Callout body copy sits on the wash in the regular text color.
pair(["fg"], WASHES, TEXT, "callout body");
// Control boundaries: inputs, checkbox, radio, switch track, secondary button, chip.
pair(["line-control"], ["bg-canvas", "bg-raised", "bg-overlay", "bg-sunken"], NON_TEXT, "control border");
// Filled controls must stand out from the surface: checked checkbox, switch, radio dot.
pair(["accent"], ["bg-canvas", "bg-raised", "bg-overlay"], NON_TEXT, "filled control");
// Focus ring on every surface a focusable element can sit on.
pair(["focus"], [...SURFACES, "accent-wash"], NON_TEXT, "focus ring");

const tokens = parseColorTokens(readStyles("tokens.css"));
const THEMES: Theme[] = ["light", "dark"];

function color(name: string, theme: Theme): string {
  const token = tokens.get(name);
  if (token === undefined) throw new Error(`token --vr-${name} is not defined in tokens.css`);
  return token[theme];
}

describe("token contrast", () => {
  for (const theme of THEMES) {
    for (const p of pairs) {
      test(`${theme}: ${p.fg} on ${p.bg} (${p.use}) >= ${p.min}`, () => {
        const ratio = contrast(color(p.fg, theme), color(p.bg, theme));
        expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(p.min);
      });
    }
  }
});

// A color token a component paints with must be covered by the list above, so a new
// foreground or background cannot ship without a contrast check.
describe("component colors are covered by the pair list", () => {
  const dir = join(import.meta.dir, "..", "src", "styles", "components");
  const css = readdirSync(dir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => readStyles(join("components", file)))
    .join("\n");
  const foregrounds = new Set(pairs.map((p) => p.fg));
  const backgrounds = new Set(pairs.map((p) => p.bg));
  // Hairline dividers and separators carry no meaning on their own (WCAG 1.4.11 does not apply).
  const decorative = new Set(["line"]);

  const used = (property: RegExp): Set<string> => {
    const names = new Set<string>();
    for (const match of css.matchAll(property)) {
      for (const ref of (match[1] ?? "").matchAll(/var\(--vr-([a-z0-9-]+)\)/g)) {
        if (ref[1] !== undefined && tokens.has(ref[1])) names.add(ref[1]);
      }
    }
    return names;
  };

  test("every text color is a checked foreground", () => {
    const missing = [...used(/(?:^|[\s;{])(?:color|fill|stroke|--_ink):([^;]+);/g)].filter(
      (name) => !foregrounds.has(name) && !backgrounds.has(name),
    );
    expect(missing).toEqual([]);
  });

  test("every background is a checked background", () => {
    const missing = [...used(/(?:background(?:-color)?|--_wash):([^;]+);/g)].filter(
      (name) => !decorative.has(name) && !backgrounds.has(name),
    );
    expect(missing).toEqual([]);
  });

  test("every border color is a checked boundary or a decorative line", () => {
    const missing = [
      ...used(/(?:border(?:-[a-z]+)*|outline(?:-color)?|box-shadow|--_edge):([^;]+);/g),
    ].filter((name) => !decorative.has(name) && !foregrounds.has(name) && !backgrounds.has(name));
    expect(missing).toEqual([]);
  });

  test("every pair names a defined token", () => {
    const undefinedNames = pairs.flatMap((p) => [p.fg, p.bg]).filter((name) => !tokens.has(name));
    expect(undefinedNames).toEqual([]);
  });
});
