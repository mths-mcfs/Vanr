// The coverage table stays true to the journeys: every file and test title it names exists, and each of
// the 31 journeys has one entry. It runs in the web's `bun test`, not in Playwright.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE } from "./coverage.ts";

const JOURNEYS = 31;

/** The titles of the `test("…")` calls in a journey file, as their string literals spell them. */
function titlesIn(file: string): string[] {
  const source = readFileSync(join(import.meta.dir, file), "utf8");
  return [...source.matchAll(/\btest\(\s*("(?:[^"\\\n]|\\.)*")/g)].map((match) => JSON.parse(match[1] ?? ""));
}

test("each journey of the spec has one entry, in order", () => {
  expect(COVERAGE.map((entry) => entry.journey)).toEqual(Array.from({ length: JOURNEYS }, (_, at) => at + 1));
});

test("every test the table names exists in its file", () => {
  const missing: string[] = [];
  for (const entry of COVERAGE) {
    if (entry.status === "pending") continue;
    expect(entry.by.length > 0).toBe(true);
    for (const { file, test: title } of entry.by) {
      if (!existsSync(join(import.meta.dir, file))) missing.push(`journey ${entry.journey}: no file ${file}`);
      else if (!titlesIn(file).includes(title))
        missing.push(`journey ${entry.journey}: no "${title}" in ${file}`);
    }
  }
  expect(missing).toEqual([]);
});
