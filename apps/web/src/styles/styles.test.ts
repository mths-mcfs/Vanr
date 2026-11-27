// The web draws only with the design tokens, and the text pairs it uses keep their contrast in
// both themes.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, parseColorTokens, readStyles } from "../../../../packages/ui/test/tokens.ts";

const css = readdirSync(import.meta.dir)
  .filter((file) => file.endsWith(".css"))
  .map((file) => readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
  .join("\n");
const declarations = [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map((match) => ({
  property: match[1] ?? "",
  value: (match[2] ?? "").trim(),
}));
const tokens = parseColorTokens(readStyles("tokens.css"));

describe("the web's own styles", () => {
  test("no color is written by hand", () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/i;
    expect(declarations.filter(({ value }) => literal.test(value))).toEqual([]);
    const named = /^(color|background|background-color|border-color|outline-color|fill|stroke)$/;
    const keywords = new Set(["none", "currentColor", "transparent", "inherit"]);
    const offenders = declarations.filter(
      ({ property, value }) => named.test(property) && !value.includes("var(--vr-") && !keywords.has(value),
    );
    expect(offenders).toEqual([]);
  });

  test("no face or size of type is written by hand", () => {
    const offenders = declarations.filter(
      ({ property, value }) =>
        (property === "font-family" || property === "font-weight" || property === "line-height") &&
        !value.startsWith("var(--vr-"),
    );
    expect(offenders).toEqual([]);
    // 0.92em is the package's own ratio for mono text set inside sans text.
    const sizes = declarations.filter(({ property }) => property === "font-size").map(({ value }) => value);
    expect(sizes.filter((value) => !value.startsWith("var(--vr-text-") && value !== "0.92em")).toEqual([]);
  });

  test("every token it names exists", () => {
    const defined = readStyles("tokens.css");
    const used = new Set([...css.matchAll(/var\((--vr-[a-z0-9-]+)\)/g)].map((match) => match[1] ?? ""));
    expect([...used].filter((name) => !defined.includes(`${name}:`))).toEqual([]);
  });

  test("motion is left to the components: the web's layout does not animate", () => {
    expect(declarations.filter(({ property }) => /^(animation|transition)/.test(property))).toEqual([]);
  });

  // Text color on the surface it sits on, as written in app.css and files.css.
  const PAIRS: [text: string, surface: string, where: string][] = [
    ["fg", "bg-canvas", "page text"],
    ["fg-muted", "bg-canvas", "the reason under a title, muted page text"],
    ["fg-subtle", "bg-canvas", "an agent's handle"],
    ["accent-fg", "bg-canvas", "links"],
    ["fg", "bg-sunken", "sidebar names"],
    ["fg-muted", "bg-sunken", "sidebar links and counts"],
    ["fg-subtle", "bg-sunken", "sidebar band titles and quiet lines"],
    ["accent-fg", "bg-sunken", "the retry link in the sidebar"],
    ["fg", "bg-hover", "a hovered sidebar link"],
    ["fg", "bg-active", "the open sidebar link"],
    ["fg-muted", "bg-raised", "the search field"],
    ["fg", "bg-overlay", "the skip link"],
    ["fg", "bg-raised", "a file's card, the answer to a question"],
    ["fg", "bg-active", "the open version of a file"],
    ["fg", "accent-wash", "the query's words marked in a snippet, a source's number"],
    ["warning-fg", "bg-canvas", "the last days of a file in the trash"],
    ["danger-fg", "bg-sunken", "an upload that failed, a formula's errors"],
    ["neutral-fg", "neutral-wash", "a gray option"],
    ["info-fg", "info-wash", "a blue option"],
    ["warning-fg", "warning-wash", "an amber option"],
    ["success-fg", "success-wash", "a green option"],
    ["danger-fg", "danger-wash", "a red option"],
    ["fg", "danger-wash", "the part of a formula an error points at"],
  ];
  for (const [text, surface, where] of PAIRS) {
    for (const theme of ["light", "dark"] as const) {
      test(`${theme}: ${text} on ${surface} reads (${where})`, () => {
        const fg = tokens.get(text)?.[theme];
        const bg = tokens.get(surface)?.[theme];
        if (fg === undefined || bg === undefined) throw new Error(`unknown token in ${text} on ${surface}`);
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("the open link's marker and the lit sigil stand out from the sidebar", () => {
    for (const theme of ["light", "dark"] as const) {
      const accent = tokens.get("accent")?.[theme] ?? "";
      expect(contrast(accent, tokens.get("bg-active")?.[theme] ?? "")).toBeGreaterThanOrEqual(3);
      expect(contrast(accent, tokens.get("bg-sunken")?.[theme] ?? "")).toBeGreaterThanOrEqual(3);
    }
  });
});
