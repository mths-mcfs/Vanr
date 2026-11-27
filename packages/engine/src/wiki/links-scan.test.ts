import { describe, expect, test } from "bun:test";
import { parseWikiLinks } from "./links";

// The link parser on the worst texts at a page's maximum size: one pass, no backtracking. What it finds is
// fixed by links.test.ts.
describe("the link parser's scans", () => {
  test("the worst inputs at the page's maximum size finish in a few milliseconds", () => {
    const N = 500_000;
    let ascending = "";
    for (let k = 1; ascending.length + k + 1 <= N; k++) ascending += `${"`".repeat(k)}a`;
    const worst = {
      backticks: "`".repeat(N),
      ascendingRuns: ascending,
      openLinks: "[[a".repeat(N / 3),
      brackets: "[".repeat(N),
      codeAndLinks: "`a`[[x]]".repeat(N / 8),
      fencesAndLinks: "```\n```\n[[x]]\n".repeat(N / 14),
    };
    parseWikiLinks("`warm` [[up]]");
    for (const [name, md] of Object.entries(worst)) {
      const started = performance.now();
      parseWikiLinks(md);
      const ms = performance.now() - started;
      expect([name, ms < 500]).toEqual([name, true]);
    }
  });
});
