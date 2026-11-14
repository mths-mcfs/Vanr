// Reads the color tokens out of tokens.css so tests check the values the browser gets.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Theme = "light" | "dark";

const STYLES = join(import.meta.dir, "..", "src", "styles");

export function readStyles(file: string): string {
  return readFileSync(join(STYLES, file), "utf8");
}

/** Every `--vr-*: light-dark(#light, #dark)` declaration in tokens.css, by token name without `--vr-`. */
export function parseColorTokens(css: string): Map<string, Record<Theme, string>> {
  const tokens = new Map<string, Record<Theme, string>>();
  const pattern = /--vr-([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)\s*;/gi;
  for (const match of css.matchAll(pattern)) {
    const [, name, light, dark] = match;
    if (name === undefined || light === undefined || dark === undefined) continue;
    tokens.set(name, { light: light.toLowerCase(), dark: dark.toLowerCase() });
  }
  return tokens;
}

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a #rrggbb color. */
export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG 2.x contrast ratio between two #rrggbb colors, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
