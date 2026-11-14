import { describe, expect, test } from "bun:test";
import { applyProps, type PropDef } from "../props";
import { frontmatterToProps, propsToFrontmatter } from "./props-vault";

describe("front matter ↔ properties", () => {
  test("creates definitions with the inferred type, as Obsidian does", () => {
    const r = frontmatterToProps([], {
      score: 7,
      done: true,
      due: "2026-11-01",
      when: "2026-11-01T10:00:00Z",
      site: "https://example.com",
      authors: ["Ana", "Beto", "Ana"],
      summary: "text",
      empty: "",
      nothing: null,
    });
    expect(r.defs.map((d) => [d.name, d.type])).toEqual([
      ["score", "number"],
      ["done", "checkbox"],
      ["due", "date"],
      ["when", "date"],
      ["site", "url"],
      ["authors", "multi_select"],
      ["summary", "text"],
    ]);
    expect(r.created).toHaveLength(7);
    const authors = r.defs.find((d) => d.name === "authors") as PropDef;
    expect(authors.options?.map((o) => o.name)).toEqual(["Ana", "Beto"]);
    // The result passes the typed properties validation.
    expect(applyProps(r.defs, {}, r.write).ok).toBe(true);
  });

  test("uses the definition that already exists (without case) and rejects what does not fit the type", () => {
    const defs: PropDef[] = [
      { id: "p1", name: "Score", type: "number" },
      { id: "p2", name: "Status", type: "select", options: [{ id: "o1", name: "Active" }] },
      { id: "p3", name: "Created", type: "created_time" },
    ];
    const r = frontmatterToProps(defs, { score: "abc", status: "active", created: "2026-01-01", SCORE2: 1 });
    expect(r.write).toEqual({ p2: "o1", [r.defs[3]?.id ?? ""]: 1 });
    expect(r.rejected).toEqual(["score"]);
    expect(r.created).toEqual(["SCORE2"]);
    // A new option becomes an option of the definition.
    const r2 = frontmatterToProps(defs, { status: "Paused" });
    expect(r2.defs[1]?.options?.map((o) => o.name)).toEqual(["Active", "Paused"]);
    expect(defs[1]?.options).toHaveLength(1);
  });

  test("round trip: properties → YAML → properties", () => {
    const first = frontmatterToProps([], {
      score: 7.5,
      done: false,
      due: "2026-11-01",
      tags2: ["a", "b"],
      site: "https://x.dev",
    });
    const yaml = propsToFrontmatter(first.defs, first.write);
    expect(yaml).toEqual({
      score: 7.5,
      done: false,
      due: "2026-11-01",
      tags2: ["a", "b"],
      site: "https://x.dev",
    });
    const again = frontmatterToProps(first.defs, yaml);
    expect(again.write).toEqual(first.write);
    expect(again.created).toEqual([]);
  });
});
