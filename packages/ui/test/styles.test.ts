import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = join(import.meta.dir, "..", "src", "styles");

function packageCss(): Array<{ file: string; css: string }> {
  const files = [
    "tokens.css",
    "base.css",
    ...readdirSync(join(STYLES, "components")).map((f) => join("components", f)),
  ];
  return files
    .filter((f) => f.endsWith(".css"))
    .map((file) => ({
      file,
      css: readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
    }));
}

/** Every animation or transition declaration, with the at-rules that enclose it. */
function motionDeclarations(css: string): Array<{ decl: string; context: string[] }> {
  const found: Array<{ decl: string; context: string[] }> = [];
  const stack: string[] = [];
  let buffer = "";
  for (const ch of css) {
    if (ch === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (ch === "}") {
      stack.pop();
      buffer = "";
    } else if (ch === ";") {
      const decl = buffer.trim();
      if (/^(animation|transition)(-[a-z-]+)?\s*:/.test(decl)) found.push({ decl, context: [...stack] });
      buffer = "";
    } else buffer += ch;
  }
  return found;
}

describe("reduced motion", () => {
  test("every animation and transition lives under prefers-reduced-motion: no-preference", () => {
    const outside = packageCss().flatMap(({ file, css }) =>
      motionDeclarations(css)
        .filter(
          ({ context }) =>
            !context.some((c) => /^@media[^{]*prefers-reduced-motion:\s*no-preference/.test(c)),
        )
        .map(({ decl, context }) => `${file}: ${context.at(-1)} { ${decl} }`),
    );
    expect(outside).toEqual([]);
  });

  test("the package does animate when motion is allowed", () => {
    const all = packageCss().flatMap(({ css }) => motionDeclarations(css));
    expect(all.some(({ decl }) => decl.startsWith("animation"))).toBe(true);
    expect(all.some(({ decl }) => decl.startsWith("transition"))).toBe(true);
  });
});

describe("layers", () => {
  const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
  const z = (name: string) => Number(tokens.match(new RegExp(`--vr-z-${name}:\\s*(\\d+)`))?.[1]);
  const overlays = readFileSync(join(STYLES, "components", "overlays.css"), "utf8");

  test("lists, menus and tooltips opened from a dialog sit above it and its scrim", () => {
    for (const floating of ["dropdown", "tooltip"]) {
      expect(z(floating)).toBeGreaterThan(z("modal"));
      expect(z(floating)).toBeGreaterThan(z("overlay"));
    }
  });

  test("toasts stay above dialogs", () => {
    expect(z("toast")).toBeGreaterThan(z("modal"));
  });

  test("select lists and menus use the dropdown layer, tooltips the tooltip layer", () => {
    const zOf = (selector: string) =>
      overlays.match(
        new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*z-index:\\s*var\\(--vr-z-([a-z]+)\\)`),
      )?.[1];
    expect(zOf(".vr-popover")).toBe("dropdown");
    expect(zOf(".vr-tooltip")).toBe("tooltip");
    expect(zOf(".vr-dialog")).toBe("modal");
  });
});
