import { describe, expect, test } from "bun:test";
import { computedColors, derivePairs, SURFACES } from "./colorPairs.ts";
import { contrast, parseColorTokens, readStyles, type Theme } from "./tokens.ts";

// The pairs come from the component CSS itself (see colorPairs.ts): every element, every state
// the CSS distinguishes, on every surface a component can sit on. Nothing here is hand-listed.
const pairs = derivePairs();
const tokens = parseColorTokens(readStyles("tokens.css"));
const THEMES: Theme[] = ["light", "dark"];

function color(name: string, theme: Theme): string {
  const token = tokens.get(name);
  if (token === undefined) throw new Error(`token --vr-${name} is not defined in tokens.css`);
  return token[theme];
}

const has = (fg: string, bg: string) => pairs.some((p) => p.fg === fg && p.bg === bg);

describe("the derived pair list", () => {
  test("covers every surface a component can sit on", () => {
    for (const surface of SURFACES) expect(pairs.some((p) => p.bg === surface)).toBe(true);
  });

  test("names only defined tokens", () => {
    expect(pairs.flatMap((p) => [p.fg, p.bg]).filter((name) => !tokens.has(name))).toEqual([]);
  });

  // Pairs a hand-written list once missed; they must come out of the CSS on their own.
  test.each([
    ["line-control", "bg-active", "secondary button, pressed: border on its fill"],
    ["danger", "bg-overlay", "danger button inside a dialog"],
    ["danger", "bg-raised", "danger button on a card"],
    ["fg-disabled", "bg-sunken", "disabled control text and check mark"],
    ["on-accent", "accent", "primary button text, checkbox mark"],
    ["fg-inverse", "bg-inverse", "tooltip"],
    ["focus", "bg-overlay", "focus ring inside a dialog"],
  ])("includes %s on %s (%s)", (fg, bg) => {
    expect(has(fg, bg)).toBe(true);
  });
});

describe("token contrast", () => {
  for (const theme of THEMES) {
    for (const p of pairs) {
      test(`${theme}: ${p.fg} on ${p.bg} >= ${p.min} (${p.use})`, () => {
        const ratio = contrast(color(p.fg, theme), color(p.bg, theme));
        expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(p.min);
      });
    }
  }
});

describe("state colors", () => {
  test.each([["checked"], ["indeterminate"]])("a disabled %s checkbox drops the accent fill", (state) => {
    const c = computedColors(["vr-checkbox"], [":disabled", `[data-state="${state}"]`]);
    expect(c).toEqual({ color: "fg-disabled", background: "bg-sunken", border: "line-control" });
  });

  test("a pressed secondary button keeps a border that reads on its fill", () => {
    const c = computedColors(["vr-button", "vr-button--secondary"], [":active"]);
    expect(c.background).toBe("bg-active");
    expect(c.border).toBe("line-control");
  });
});
