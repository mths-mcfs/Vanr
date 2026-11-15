import { describe, expect, test } from "bun:test";
import type { ChunkInput } from "@vanr/engine/search";
import { codeRanges } from "@vanr/engine/wiki/links";
import { excerptOf, type WikiRow } from "../src/wiki";
import { wikiChunks } from "../src/wiki-search";

const row = (body: string) => ({
  workspaceId: "workspace_1",
  slug: "p",
  title: "Page",
  body,
  updatedAt: new Date("2026-10-22T00:00:00Z"),
  updatedBy: { type: "person" as const, id: "u1" },
});

describe("wiki chunks for search", () => {
  test("cuts at headings, does not split code and carries the section heading", () => {
    const code = `\`\`\`\n${"# not a heading\n".repeat(5)}\`\`\``;
    const body = `Intro.\n\n# One\n\n${"a ".repeat(500)}\n\n${"b ".repeat(500)}\n\n# Two\n\n${code}\n`;
    const chunks = wikiChunks(row(body));
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]?.text).toBe("Intro.");
    expect(chunks[1]?.text.startsWith("# One")).toBe(true);
    expect(chunks[2]?.text).toMatch(/^One\n+b b/);
    expect(chunks.at(-1)?.text).toContain("# not a heading");
    expect(
      chunks.every((c) => c.scope.kind === "workspace" && c.url === "/workspace/workspace_1/wiki/p"),
    ).toBe(true);
  });

  test("an empty page still has one chunk (the title finds the page)", () => {
    expect(wikiChunks(row("")).map((c) => [c.title, c.text])).toEqual([["Page", ""]]);
  });

  test("a huge paragraph is cut and the total has a cap", () => {
    const chunks = wikiChunks(row("x".repeat(10_000)));
    expect(chunks.length).toBe(4);
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(3000);
    expect(wikiChunks(row("p\n\n".repeat(300_000))).length).toBeLessThanOrEqual(400);
  });
});

// The text scans that replaced expressions which backtracked: the old code is the oracle on small texts.
const TOKENS = ["```", "~~~", "\n", "\n\n", "# h\n", "[[", "]]", "![[", "]", "|", "#", "%%", "`", "a b", " "];
function randomTexts(count: number, seed = 5): string[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s;
  };
  return Array.from({ length: count }, () => {
    let t = "";
    const len = next() % 30;
    for (let i = 0; i < len; i++) t += TOKENS[next() % TOKENS.length];
    return t;
  });
}

function oldExcerpt(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/%%[\s\S]*?%%/g, " ")
    .replace(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
    .replace(/[#>*_`~[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain;
}

// The old chunks, verbatim: their search over the code blocks was linear per cut point.
const CHUNK = 1500;
const MAX_CHUNKS = 400;
function oldWikiChunks(
  row: Pick<WikiRow, "workspaceId" | "slug" | "title" | "body" | "updatedAt" | "updatedBy">,
) {
  const body = row.body;
  const code = codeRanges(body).filter(([a, b]) => /^ {0,3}(```|~~~)/.test(body.slice(a, b)));
  const inCode = (i: number) => code.some(([a, b]) => i > a && i < b);
  // Cut points: start of a heading or of a paragraph, outside code blocks.
  const cuts: { at: number; heading: string | null }[] = [{ at: 0, heading: null }];
  const re = /\n(?=(#{1,6})[ \t]+([^\n]*)|\n)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const at = m.index + 1;
    if (inCode(at)) continue;
    cuts.push({ at, heading: m[1] ? (m[2] ?? "").trim() : null });
  }
  const texts: string[] = [];
  let heading: string | null = null;
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) texts.push(t);
    current = "";
  };
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i] as (typeof cuts)[number];
    const piece = body.slice(cut.at, cuts[i + 1]?.at ?? body.length);
    if (cut.heading !== null) {
      flush();
      heading = cut.heading;
    }
    if (current.length + piece.length > CHUNK && current.trim()) flush();
    if (!current && heading && cut.heading === null) current = `${heading}\n`;
    // A paragraph longer than two chunks: cut it flat.
    for (let k = 0; k < piece.length; k += CHUNK * 2) {
      if (k > 0) flush();
      current += piece.slice(k, k + CHUNK * 2);
    }
  }
  flush();
  const updatedAt = row.updatedAt.toISOString();
  const chunks: ChunkInput[] = (texts.length ? texts : [""]).slice(0, MAX_CHUNKS).map((text, ordinal) => ({
    workspaceId: row.workspaceId,
    ordinal,
    title: row.title,
    text,
    scope: { kind: "workspace" },
    url: `/workspace/${encodeURIComponent(row.workspaceId)}/wiki/${encodeURIComponent(row.slug)}`,
    authorId: row.updatedBy.id,
    updatedAt,
  }));
  return chunks;
}

describe("linear scans of a page's text", () => {
  test("the excerpt and the chunks come out as with the old expressions", () => {
    for (const body of randomTexts(10_000)) {
      expect([body, excerptOf(body)]).toEqual([body, oldExcerpt(body)]);
      expect([body, wikiChunks(row(body))]).toEqual([body, oldWikiChunks(row(body))]);
    }
  });

  test("the worst texts at the page's maximum size take a few milliseconds", () => {
    const N = 500_000;
    const worst = {
      openLinks: `${"[[a".repeat(N / 3 - 1)}[[`,
      bangs: "![[".repeat(N / 3),
      fences: "```\n```\n\n".repeat(N / 9),
      backticks: "`".repeat(N),
    };
    for (const [name, body] of Object.entries(worst)) {
      const started = performance.now();
      excerptOf(body);
      wikiChunks(row(body));
      expect([name, performance.now() - started < 1_000]).toEqual([name, true]);
    }
  });
});
