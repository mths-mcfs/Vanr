import { describe, expect, test } from "bun:test";
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
