import { describe, expect, test } from "bun:test";
import { parseSkillMd, skillProblems, skillSlug, toSkillMd, validateSkillFrontmatter } from "./skill-md";

const fm = (text: string) => {
  const p = parseSkillMd(text);
  if (!p.ok) throw new Error(p.problems.join("; "));
  return p.frontmatter;
};

describe("SKILL.md in the Agent Skills standard", () => {
  test("valid: minimal frontmatter and body", () => {
    const p = parseSkillMd("---\nname: pdf-tools\ndescription: Lê PDF.\n---\n\n# Como\nPasso 1\n");
    expect(p).toEqual({
      ok: true,
      frontmatter: { name: "pdf-tools", description: "Lê PDF." },
      body: "# Como\nPasso 1",
    });
    if (p.ok) expect(validateSkillFrontmatter(p.frontmatter, "pdf-tools")).toEqual([]);
  });

  test("no frontmatter, not closed, invalid YAML, not a mapping", () => {
    expect(parseSkillMd("# só corpo")).toEqual({
      ok: false,
      problems: ["SKILL.md must start with YAML frontmatter (---)"],
    });
    expect(parseSkillMd("---\nname: a\n")).toEqual({
      ok: false,
      problems: ["SKILL.md frontmatter not properly closed with ---"],
    });
    const bad = parseSkillMd("---\nname: [a\n---\n");
    expect(bad.ok).toBe(false);
    expect(parseSkillMd("---\n- a\n- b\n---\n")).toEqual({
      ok: false,
      problems: ["SKILL.md frontmatter must be a YAML mapping"],
    });
  });

  test.each([
    ["Tom-De-Voz", "must be lowercase"],
    ["-pdf", "cannot start or end with a hyphen"],
    ["pdf-", "cannot start or end with a hyphen"],
    ["pdf--x", "consecutive hyphens"],
    ["pdf tools", "invalid characters"],
    ["pdf_tools", "invalid characters"],
    ["a".repeat(65), "exceeds 64 character limit"],
  ])("name %p is rejected (%s)", (name, msg) => {
    expect(validateSkillFrontmatter({ name, description: "x" }).join("\n")).toContain(msg);
  });

  test("description required and capped; an unknown field is an error; name equal to the folder", () => {
    expect(validateSkillFrontmatter({ name: "a" })).toContain(
      "Missing required field in frontmatter: description",
    );
    expect(validateSkillFrontmatter({ name: "a", description: " " })).toContain(
      "Field 'description' must be a non-empty string",
    );
    expect(validateSkillFrontmatter({ name: "a", description: "x".repeat(1025) }).join()).toContain("1024");
    expect(validateSkillFrontmatter({ name: "a", description: "x", run: "rm -rf /" }).join()).toContain(
      "Unexpected fields in frontmatter: run",
    );
    expect(validateSkillFrontmatter({ name: "a", description: "x" }, "b")).toEqual([
      "Directory name 'b' must match skill name 'a'",
    ]);
    expect(
      validateSkillFrontmatter(fm("---\nname: a\ndescription: x\nmetadata:\n  author: b\n---\n")),
    ).toEqual([]);
  });

  test("round trip: what we export is valid, including a description with colons and line breaks", () => {
    const md = toSkillMd({
      name: "Tom de Voz (BR)",
      description: 'Use: "sempre"\n---\nfim',
      body: "Corpo\n---\nmais",
    });
    const p = parseSkillMd(md);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.frontmatter).toEqual({ name: "tom-de-voz-br", description: 'Use: "sempre"\n---\nfim' });
    expect(p.body).toBe("Corpo\n---\nmais");
    expect(validateSkillFrontmatter(p.frontmatter)).toEqual([]);
    expect(skillSlug("Ação rápida")).toBe("acao-rapida");
    expect(skillSlug("!!!")).toBe("skill");
  });

  test("problems of a stored skill: empty description", () => {
    expect(skillProblems({ name: "x", description: "", body: "b" })).toEqual([
      "Field 'description' must be a non-empty string",
    ]);
    expect(skillProblems({ name: "x", description: "d", body: "b" })).toEqual([]);
  });
});
