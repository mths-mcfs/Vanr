import { describe, expect, test } from "bun:test";
import { applyProps, type PropDef } from "../props";
import { formatFrontmatter, splitFrontmatter } from "./frontmatter";
import { frontmatterToProps, propsToFrontmatter, WIKI_PROP_LIMITS } from "./props-vault";

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

test("editable references, date ranges and literal text survive YAML export and import", () => {
  const defs: PropDef[] = [
    { id: "d", name: "Due", type: "date" },
    { id: "p", name: "Owner", type: "person" },
    { id: "f", name: "Attachments", type: "file" },
    { id: "t", name: "Text", type: "text" },
  ];
  const props = {
    d: { start: "2026-11-01", end: "2026-11-02" },
    p: [
      { type: "person" as const, id: "u1" },
      { type: "agent" as const, id: "a1" },
    ],
    f: ["file_1", "file,2"],
    t: "  Keep this\n\n",
  };
  expect(applyProps(defs, {}, props).ok).toBe(true);
  const data = splitFrontmatter(formatFrontmatter(propsToFrontmatter(defs, props))).data;
  const result = frontmatterToProps(defs, data);
  expect(result.rejected).toEqual([]);
  expect(result.write).toEqual(props);
  expect(frontmatterToProps(defs, { Text: "" }).write).toEqual({ t: "" });
});

test("invalid imported fields are rejected separately from valid fields", () => {
  const defs: PropDef[] = [
    { id: "d", name: "Due", type: "date" },
    { id: "u", name: "URL", type: "url" },
    { id: "n", name: "Count", type: "number" },
  ];
  const result = frontmatterToProps(defs, { Due: "2026-02-30", URL: "https://", Count: 42 });
  expect(result.rejected).toEqual(["Due", "URL"]);
  expect(result.write).toEqual({ n: 42 });
  expect(applyProps(defs, {}, result.write).ok).toBe(true);
});

describe("the property route's caps", () => {
  const many = (n: number, from = 0) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${from + i}`, "x"]));

  test("past the definitions' cap a new property is rejected, not created; the ones that exist still take values", () => {
    const first = frontmatterToProps([], many(WIKI_PROP_LIMITS.defs - 1));
    const r = frontmatterToProps(first.defs, { ...many(3, 1000), p0: "kept" });
    expect(r.defs).toHaveLength(WIKI_PROP_LIMITS.defs);
    expect(r.created).toEqual(["p1000"]);
    expect(r.overLimit).toEqual(["p1001", "p1002"]);
    expect(r.rejected).toEqual(["p1001", "p1002"]);
    const p0 = r.defs.find((d) => d.name === "p0");
    expect(p0 && r.write[p0.id]).toBe("kept");
  });

  test("past the options' cap a value that needs a new option is rejected; a known option still goes in", () => {
    const def: PropDef = {
      id: "prop_s",
      name: "Stage",
      type: "select",
      options: Array.from({ length: WIKI_PROP_LIMITS.options }, (_, i) => ({
        id: `opt_${i}`,
        name: `o${i}`,
      })),
    };
    const tags: PropDef = { id: "prop_m", name: "Tags", type: "multi_select", options: def.options };
    const r = frontmatterToProps([def, tags], { Stage: "brand new", Tags: ["o1", "another new"] });
    expect(r.overLimit).toEqual(["Stage", "Tags"]);
    expect(r.write).toEqual({});
    expect(r.defs.every((d) => (d.options?.length ?? 0) <= WIKI_PROP_LIMITS.options)).toBe(true);
    expect(frontmatterToProps([def], { Stage: "o7" }).write).toEqual({ prop_s: "opt_7" });
  });
});
