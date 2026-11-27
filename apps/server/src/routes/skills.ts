// The workspace's skills: written by hand, saved from a run ("save this flow as a skill") or imported from a
// GitHub folder (SKILL.md and text files).
import type {
  Skill,
  SkillDetail,
  SkillImportInput,
  SkillInput,
  SkillMarkdown,
  SkillPatch,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { skillProblems, skillSlug, toSkillMd } from "@vanr/engine/skill-md";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { isUniqueViolation } from "../db-errors";
import { importSkill, parseGithubUrl } from "../github";
import { conflict, HttpError, notFound, param, readJson } from "../http";
import { repoReadToken } from "../integrations/github-app";
import { readableRun } from "../run-access";
import { runIsPrivate } from "../skill-drafts";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { skills } = schema;
type SkillRow = typeof skills.$inferSelect;

export function toSkill(row: SkillRow): Skill {
  return {
    slug: skillSlug(row.name),
    problems: skillProblems(row),
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    sourceUrl: row.sourceUrl,
    version: row.version,
    autoGrantNewAgents: row.autoGrantNewAgents,
    sourceRunId: row.sourceRunId,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: SkillRow): SkillDetail {
  return {
    ...toSkill(row),
    body: row.body,
    files: row.files.map((f) => ({ path: f.path, status: f.status, mime: f.mime })),
  };
}

const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, "Use letters, numbers, spaces, - or _");
const fields = {
  name,
  description: z.string().trim().max(1000),
  body: z.string().max(100_000),
  autoGrantNewAgents: z.boolean(),
};

export const createSkillBody = z
  .object({
    name: fields.name,
    description: fields.description.optional(),
    body: fields.body,
    autoGrantNewAgents: fields.autoGrantNewAgents.optional(),
    sourceRunId: z.string().min(1).max(64).optional(),
    shareFromPrivate: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<SkillInput>;
export const updateSkillBody = z.object(fields).partial().strict() satisfies z.ZodType<SkillPatch>;
const importBody = z
  .object({ url: z.string().min(1).max(500) })
  .strict() satisfies z.ZodType<SkillImportInput>;

const nameTaken = (n: string) =>
  conflict("skill.name_taken", "A skill with this name already exists", { name: n });

/**
 * A skill written by hand has to make a valid SKILL.md by the standard (description required and up to 1024
 * characters; the standard's name comes from the name the workspace gave). An invalid older one stays editable, as
 * long as the edit doesn't touch the name, the description or the body.
 */
function requireValid(skill: { name: string; description: string; body: string }) {
  const problems = skillProblems(skill);
  if (problems.length)
    throw new HttpError(400, "skill.invalid", `Invalid SKILL.md: ${problems.join("; ")}`, { problems });
}

async function byId(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, id)));
  if (!row) throw notFound("Skill not found");
  return row;
}

type NewSkill = Omit<typeof skills.$inferInsert, "id"> & { sourceRunId: string | null };

/**
 * Saves a skill. One saved from a run's draft again (a double click, a retry, another name) gives back the skill
 * that run already made: under the run's lock, "is there one already" and the insert are one step.
 */
export async function saveSkill(db: Db, values: NewSkill): Promise<{ row: SkillRow; created: boolean }> {
  const runId = values.sourceRunId;
  return db.transaction(async (tx) => {
    if (runId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`skill-from-run:${values.workspaceId}:${runId}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.workspaceId, values.workspaceId), eq(skills.sourceRunId, runId)))
        .limit(1);
      if (existing) return { row: existing, created: false };
    }
    const [row] = await tx
      .insert(skills)
      .values({ id: newId("skl"), ...values })
      .returning();
    if (!row) throw new Error("skill insert returned nothing");
    return { row, created: true };
  });
}

export function registerSkills(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/skills`, async (c) => {
    const me = requireMember(c);
    const rows = await c
      .get("deps")
      .db.select()
      .from(skills)
      .where(eq(skills.workspaceId, me.workspaceId))
      .orderBy(asc(skills.name));
    return c.json({ skills: rows.map(toSkill) });
  });

  app.get(`${WORKSPACE}/skills/:skillId`, async (c) => {
    const me = requireMember(c);
    return c.json(toDetail(await byId(c.get("deps").db, me.workspaceId, param(c, "skillId"))));
  });

  app.post(`${WORKSPACE}/skills`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db } = c.get("deps");
    const input = await readJson(c, createSkillBody);
    requireValid({ name: input.name, description: input.description ?? "", body: input.body });
    // From a run: whoever saves has to read the run (a skill can't be tied to a run from outside), and one from a
    // private channel or a DM only with the confirmation that the whole workspace will read the flow.
    if (input.sourceRunId) {
      const run = await readableRun(me.workspaceId, me.userId, input.sourceRunId, db);
      if ((await runIsPrivate(db, run)) && input.shareFromPrivate !== true)
        throw conflict("skill.private_source", "This flow came from a private conversation", {
          runId: run.id,
        });
    }
    try {
      const saved = await saveSkill(db, {
        workspaceId: me.workspaceId,
        name: input.name,
        description: input.description ?? "",
        body: input.body,
        autoGrantNewAgents: input.autoGrantNewAgents ?? false,
        sourceRunId: input.sourceRunId ?? null,
        createdBy: me.userId,
      });
      return c.json(toDetail(saved.row), saved.created ? 201 : 200);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(input.name);
      throw err;
    }
  });

  app.post(`${WORKSPACE}/skills/import`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const input = await readJson(c, importBody);
    const ref = parseGithubUrl(input.url);
    const token = await repoReadToken(deps, me.workspaceId, ref.owner);
    const imported = await importSkill(deps.fetchExternal, ref, token);
    try {
      const [row] = await deps.db
        .insert(skills)
        .values({
          id: newId("skl"),
          workspaceId: me.workspaceId,
          name: imported.name,
          description: imported.description,
          body: imported.body,
          files: imported.files,
          source: "github",
          sourceUrl: input.url.trim(),
          createdBy: me.userId,
        })
        .returning();
      if (!row) throw new Error("skill insert returned nothing");
      return c.json(toDetail(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(imported.name);
      throw err;
    }
  });

  app.patch(`${WORKSPACE}/skills/:skillId`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db, now } = c.get("deps");
    const current = await byId(db, me.workspaceId, param(c, "skillId"));
    const input = await readJson(c, updateSkillBody);
    if (input.name !== undefined || input.description !== undefined || input.body !== undefined)
      requireValid({
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        body: input.body ?? current.body,
      });
    try {
      // The version goes up when the body changes, decided in the statement itself (two edits at once count two).
      const version =
        input.body !== undefined
          ? sql`case when ${skills.body} is distinct from ${input.body} then ${skills.version} + 1 else ${skills.version} end`
          : undefined;
      const [row] = await db
        .update(skills)
        .set({ ...input, ...(version ? { version } : {}), updatedAt: now() })
        .where(and(eq(skills.id, current.id), eq(skills.workspaceId, me.workspaceId)))
        .returning();
      if (!row) throw notFound("Skill not found");
      return c.json(toDetail(row));
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(input.name ?? current.name);
      throw err;
    }
  });

  // Reads GitHub again and raises the version. Keeps the name the workspace gave.
  app.post(`${WORKSPACE}/skills/:skillId/reimport`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const deps = c.get("deps");
    const current = await byId(deps.db, me.workspaceId, param(c, "skillId"));
    if (current.source !== "github" || !current.sourceUrl) {
      throw conflict("skill.not_imported", "Only skills imported from GitHub can be reimported");
    }
    const ref = parseGithubUrl(current.sourceUrl);
    const token = await repoReadToken(deps, me.workspaceId, ref.owner);
    const imported = await importSkill(deps.fetchExternal, ref, token);
    const [row] = await deps.db
      .update(skills)
      .set({
        description: imported.description,
        body: imported.body,
        files: imported.files,
        version: sql`${skills.version} + 1`,
        updatedAt: deps.now(),
      })
      .where(and(eq(skills.id, current.id), eq(skills.workspaceId, me.workspaceId)))
      .returning();
    if (!row) throw notFound("Skill not found");
    return c.json(toDetail(row));
  });

  // SKILL.md in the Agent Skills standard and the text files: the same skill in Claude Code or in Codex.
  app.get(`${WORKSPACE}/skills/:skillId/skill-md`, async (c) => {
    const me = requireMember(c);
    const row = await byId(c.get("deps").db, me.workspaceId, param(c, "skillId"));
    const out: SkillMarkdown = {
      name: skillSlug(row.name),
      markdown: toSkillMd(row),
      files: row.files.flatMap((f) =>
        f.status === "ok" && f.text !== undefined ? [{ path: f.path, text: f.text }] : [],
      ),
    };
    return c.json(out);
  });

  app.delete(`${WORKSPACE}/skills/:skillId`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const { db } = c.get("deps");
    const current = await byId(db, me.workspaceId, param(c, "skillId"));
    await db.delete(skills).where(eq(skills.id, current.id));
    return c.body(null, 204);
  });
}
