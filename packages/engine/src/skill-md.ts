// SKILL.md in the open Agent Skills standard: read the frontmatter, validate it by the reference validator's
// rules (`skills-ref validate`, agentskills/agentskills@69ef37e) and write it back, so the same skill works
// in the Claude Code or Codex of the customer's environment.
//
// Rules (validator.py): allowed fields name, description, license, allowed-tools, metadata, compatibility;
// any other field is an error. name: 1 to 64 characters, lowercase letters, digits and hyphens, no hyphen at
// either end nor doubled, equal to the folder name. description: 1 to 1024. compatibility: up to 500.

const SKILL_FIELDS = [
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
] as const;
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_COMPATIBILITY_MAX = 500;

type ParsedSkillMd =
  | { ok: true; frontmatter: Record<string, unknown>; body: string }
  | { ok: false; problems: string[] };

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Splits the YAML frontmatter from the body. Errors use the reference validator's text. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n") && src !== "---")
    return { ok: false, problems: ["SKILL.md must start with YAML frontmatter (---)"] };
  const end = src.indexOf("\n---", 3);
  if (end === -1) return { ok: false, problems: ["SKILL.md frontmatter not properly closed with ---"] };
  const head = src.slice(4, end);
  const after = src.slice(end + 4);
  if (after !== "" && !after.startsWith("\n"))
    return { ok: false, problems: ["SKILL.md frontmatter not properly closed with ---"] };
  let data: unknown;
  try {
    data = Bun.YAML.parse(head);
  } catch (err) {
    return {
      ok: false,
      problems: [`Invalid YAML in frontmatter: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (!isMapping(data)) return { ok: false, problems: ["SKILL.md frontmatter must be a YAML mapping"] };
  return { ok: true, frontmatter: data, body: after.replace(/^\n/, "").trim() };
}

function validateSkillName(name: unknown, dirName?: string): string[] {
  if (typeof name !== "string" || name.trim() === "") return ["Field 'name' must be a non-empty string"];
  const n = name.normalize("NFKC").trim();
  const out: string[] = [];
  if (n.length > SKILL_NAME_MAX)
    out.push(`Skill name '${n}' exceeds ${SKILL_NAME_MAX} character limit (${n.length} chars)`);
  if (n !== n.toLowerCase()) out.push(`Skill name '${n}' must be lowercase`);
  if (n.startsWith("-") || n.endsWith("-")) out.push("Skill name cannot start or end with a hyphen");
  if (n.includes("--")) out.push("Skill name cannot contain consecutive hyphens");
  if (![...n].every((c) => c === "-" || /[\p{L}\p{N}]/u.test(c)))
    out.push(`Skill name '${n}' contains invalid characters. Only letters, digits, and hyphens are allowed.`);
  if (dirName !== undefined && dirName.normalize("NFKC") !== n)
    out.push(`Directory name '${dirName}' must match skill name '${n}'`);
  return out;
}

function validateSkillDescription(description: unknown): string[] {
  if (typeof description !== "string" || description.trim() === "")
    return ["Field 'description' must be a non-empty string"];
  return description.length > SKILL_DESCRIPTION_MAX
    ? [`Description exceeds ${SKILL_DESCRIPTION_MAX} character limit (${description.length} chars)`]
    : [];
}

/** All the frontmatter rules. Empty list = valid. */
export function validateSkillFrontmatter(fm: Record<string, unknown>, dirName?: string): string[] {
  const out: string[] = [];
  const extra = Object.keys(fm).filter((k) => !(SKILL_FIELDS as readonly string[]).includes(k));
  if (extra.length)
    out.push(
      `Unexpected fields in frontmatter: ${extra.sort().join(", ")}. Only ${JSON.stringify([...SKILL_FIELDS].sort())} are allowed.`,
    );
  if (!("name" in fm)) out.push("Missing required field in frontmatter: name");
  else out.push(...validateSkillName(fm.name, dirName));
  if (!("description" in fm)) out.push("Missing required field in frontmatter: description");
  else out.push(...validateSkillDescription(fm.description));
  if ("compatibility" in fm) {
    if (typeof fm.compatibility !== "string") out.push("Field 'compatibility' must be a string");
    else if (fm.compatibility.length > SKILL_COMPATIBILITY_MAX)
      out.push(
        `Compatibility exceeds ${SKILL_COMPATIBILITY_MAX} character limit (${fm.compatibility.length} chars)`,
      );
  }
  if (
    "metadata" in fm &&
    (fm.metadata === null || typeof fm.metadata !== "object" || Array.isArray(fm.metadata))
  )
    out.push("Field 'metadata' must be a mapping");
  return out;
}

/** Standard name from the name the workspace gave ("Tom de voz" → "tom-de-voz"). */
export function skillSlug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SKILL_NAME_MAX)
    .replace(/-$/, "");
  return s || "skill";
}

/** Safe one-line YAML value: double-quoted, escaped. */
const yamlString = (v: string) => JSON.stringify(v);

/** The skill's SKILL.md, valid by the standard (name in the standard's format, description required). */
export function toSkillMd(skill: {
  name: string;
  description: string;
  body: string;
  license?: string | null;
}): string {
  const lines = ["---", `name: ${skillSlug(skill.name)}`, `description: ${yamlString(skill.description)}`];
  if (skill.license) lines.push(`license: ${yamlString(skill.license)}`);
  lines.push("---", "", skill.body.trim(), "");
  return lines.join("\n");
}

/** Problems of a stored skill, as it would come out in SKILL.md. */
export function skillProblems(skill: { name: string; description: string; body: string }): string[] {
  const parsed = parseSkillMd(toSkillMd(skill));
  if (!parsed.ok) return parsed.problems;
  return validateSkillFrontmatter(parsed.frontmatter);
}
