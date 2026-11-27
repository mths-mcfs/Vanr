// Skills (Agent Skills standard).

/** Skill draft built from a run. Saving it is `createSkill` with `sourceRunId`. */
export interface SkillDraft {
  agentId: string;
  body: string;
  description: string;
  /** The run happened in a private channel or a DM: the skill becomes visible to the whole workspace. */
  fromPrivate: boolean;
  name: string;
  runId: string;
  testModel: boolean;
}

export interface Skill {
  id: string;
  autoGrantNewAgents: boolean;
  /** Who created it. */
  createdBy: string | null;
  description: string;
  name: string;
  /** What keeps the SKILL.md from passing the standard's validator; empty = valid. */
  problems: string[];
  /** Name following the Agent Skills standard (the one in the exported SKILL.md). */
  slug: string;
  source: "builtin" | "custom" | "github";
  /** Run the skill came from ("save this flow as a skill"). */
  sourceRunId: string | null;
  sourceUrl: string | null;
  updatedAt: string;
  version: number;
}

export interface SkillDetail extends Skill {
  body: string;
  files: { mime: string; path: string; status: "ok" | "skipped" }[];
}

/** Body of `createSkill`. */
export interface SkillInput {
  autoGrantNewAgents?: boolean;
  body: string;
  description?: string;
  name: string;
  /** The run confirmed private: the whole workspace may read the skill made from it. */
  shareFromPrivate?: boolean;
  /** "Save this flow as a skill": the source run (whoever saves has to be able to read it). */
  sourceRunId?: string;
}

/** Body of `updateSkill`. */
export interface SkillPatch {
  autoGrantNewAgents?: boolean;
  body?: string;
  description?: string;
  name?: string;
}

/** Body of `importSkill`. */
export interface SkillImportInput {
  url: string;
}

/** Answer of `getSkillSkillMd`: the SKILL.md and the text files, as Claude Code or Codex read them. */
export interface SkillMarkdown {
  files: { path: string; text: string }[];
  markdown: string;
  name: string;
}
