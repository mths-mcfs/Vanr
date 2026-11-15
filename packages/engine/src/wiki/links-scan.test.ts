import { describe, expect, test } from "bun:test";
import { codeRanges, parseLinkInner, parseWikiLinks } from "./links";

// The expressions the one-pass scans replaced: the oracle for what they find, on inputs small enough for
// their backtracking.
function oldCodeRanges(md: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open: { char: string; len: number; start: number } | null = null;
  for (const m of md.matchAll(fence)) {
    const mark = m[1] ?? "";
    const at = m.index ?? 0;
    if (!open) {
      if (mark[0] === "`" && /`/.test(m[0].slice(m[0].indexOf(mark) + mark.length))) continue;
      open = { char: mark[0] ?? "`", len: mark.length, start: at };
    } else if (mark[0] === open.char && mark.length >= open.len && m[0].trim() === mark) {
      ranges.push([open.start, at + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, md.length]);
  const inFence = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const extra: [number, number][] = [];
  for (const m of md.matchAll(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)|%%[\s\S]*?%%/g)) {
    const at = m.index ?? 0;
    if (inFence(at)) continue;
    if (m[0].startsWith("`") && /\n\s*\n/.test(m[0])) continue;
    extra.push([at, at + m[0].length]);
  }
  return [...ranges, ...extra].sort((a, b) => a[0] - b[0]);
}

function oldParseWikiLinks(md: string) {
  const skip = oldCodeRanges(md);
  const inside = (at: number) => skip.some(([a, b]) => at >= a && at < b);
  const out: ReturnType<typeof parseWikiLinks> = [];
  for (const m of md.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const start = m.index ?? 0;
    if (inside(start)) continue;
    if (start > 0 && md[start - 1] === "\\") continue;
    const parsed = parseLinkInner(m[2] ?? "");
    if (!parsed.target && !parsed.anchor) continue;
    out.push({ raw: m[0], embed: m[1] === "!", start, end: start + m[0].length, ...parsed });
  }
  return out;
}

const TOKENS = [
  "`",
  "``",
  "```",
  "~~~",
  "%",
  "%%",
  "[[",
  "]]",
  "![[",
  "]",
  "[",
  "a",
  "B",
  "#h",
  "|",
  "\\",
  " ",
  "\n",
  "\n\n",
  "\t",
  "x y",
];

function randomTexts(count: number, seed = 11): string[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s;
  };
  return Array.from({ length: count }, () => {
    let t = "";
    const len = next() % 40;
    for (let i = 0; i < len; i++) t += TOKENS[next() % TOKENS.length];
    return t;
  });
}

describe("the link parser's scans", () => {
  test("find the same code ranges and links as the old expressions", () => {
    const fixed = [
      "a `code [[x]]` b [[y]]",
      "``` js\n[[in fence]]\n```\n[[out]]",
      "``a`` `b` ```c``` [[d]]",
      "`` a ` b `` [[e]]",
      "``` a `` b ` c",
      "`one\n\ntwo` [[f]]",
      "%% hide [[g]] %% [[h]] %%",
      "![[img.png]] \\[[not]] [[#Self]] [[|]]",
      "[[[[a]]]] [[b\n]] [[c]",
      "~~~\n[[a]]\n~~~~\n[[b]]",
    ];
    for (const md of [...fixed, ...randomTexts(20_000)]) {
      expect([md, codeRanges(md)]).toEqual([md, oldCodeRanges(md)]);
      expect([md, parseWikiLinks(md)]).toEqual([md, oldParseWikiLinks(md)]);
    }
  });

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
