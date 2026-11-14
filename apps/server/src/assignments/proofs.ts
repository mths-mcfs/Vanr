// Proofs of the work: the diff and files a job changed (the runner sends them at the end), a test log,
// a screenshot (a Drive file) and a preview (a link). The reviewer checks what was done, not only the report.
import type { AssignmentProof } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../context";
import { fileFor } from "../drive";
import { HttpError } from "../http";

const { assignmentProofs } = schema;
type AssignmentActor = schema.AssignmentActor;

export type ProofRow = typeof assignmentProofs.$inferSelect;
/** Text cap per proof (a large diff or log keeps its start and its end). */
export const PROOF_TEXT_MAX = 200_000;

export const proofInput = z
  .object({
    kind: z.enum(["diff", "test_log", "screenshot", "preview"]),
    title: z.string().trim().min(1).max(200),
    text: z.string().max(PROOF_TEXT_MAX).optional(),
    // Only http(s): the preview becomes a link on screen, and z.url() alone accepts javascript: and data:.
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
    fileId: z.string().max(64).optional(),
  })
  .superRefine((p, ctx) => {
    if ((p.kind === "diff" || p.kind === "test_log") && !p.text?.trim())
      ctx.addIssue({ code: "custom", message: `${p.kind} needs text`, path: ["text"] });
    if (p.kind === "preview" && !p.url)
      ctx.addIssue({ code: "custom", message: "preview needs url", path: ["url"] });
    if (p.kind === "screenshot" && !p.fileId)
      ctx.addIssue({ code: "custom", message: "screenshot needs fileId", path: ["fileId"] });
  });
export type ProofInput = z.infer<typeof proofInput>;

/** Cuts the middle, keeping the start and the end (the end of a log usually has the error). */
export function clip(text: string, max = PROOF_TEXT_MAX): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n\n… (${text.length - 2 * half} chars cut) …\n\n${text.slice(-half)}`;
}

export function toProof(row: ProofRow): AssignmentProof {
  return {
    id: row.id,
    itemId: row.itemId,
    jobId: row.jobId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    fileId: row.fileId,
    url: row.url,
    by: { type: row.by.type, id: row.by.id },
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Saves proofs of the assignment. A screenshot is a Drive file the agent sees and that whoever reads the
 * assignment also sees (the whole workspace's, the assignment channel's or its thread's): another channel's file doesn't leak.
 * The whole batch is checked before anything is written and saved in one statement: a rejected batch leaves no row.
 */
export async function addProofs(
  deps: AppDeps,
  assignment: { id: string; workspaceId: string; channelId: string; threadId: string; agentId: string },
  input: { itemId: string | null; jobId?: string | null; by: AssignmentActor; proofs: readonly ProofInput[] },
): Promise<ProofRow[]> {
  for (const p of input.proofs) {
    if (p.kind === "screenshot" && p.fileId) {
      const art = await fileFor(deps.db, assignment.workspaceId, p.fileId, {
        type: "agent",
        id: assignment.agentId,
      }).catch(() => null);
      const shared =
        art &&
        (art.channelId === null ||
          art.channelId === assignment.channelId ||
          art.threadId === assignment.threadId);
      if (!art || !shared)
        throw new HttpError(400, "assignment.proof_file", "That file is not visible in this assignment", {
          fileId: p.fileId,
        });
    }
  }
  if (input.proofs.length === 0) return [];
  const at = deps.now();
  return deps.db
    .insert(assignmentProofs)
    .values(
      input.proofs.map((p) => ({
        id: newId("apf"),
        assignmentId: assignment.id,
        itemId: input.itemId,
        jobId: input.jobId ?? null,
        kind: p.kind,
        title: p.title,
        body: p.text ? clip(p.text) : null,
        fileId: p.kind === "screenshot" ? (p.fileId ?? null) : null,
        url: p.kind === "preview" ? (p.url ?? null) : null,
        by: input.by,
        createdAt: at,
      })),
    )
    .returning();
}

/** The diff and file list of a job that ended (the runner sends them in the snapshot). */
export async function addJobProofs(
  deps: AppDeps,
  assignmentId: string,
  job: { id: string; itemId: string | null; files: string[]; diff: string | null; agentId: string },
): Promise<void> {
  const by: AssignmentActor = { type: "agent", id: job.agentId };
  const rows: (typeof assignmentProofs.$inferInsert)[] = [];
  if (job.files.length)
    rows.push({
      id: `apf_${job.id}_files`,
      assignmentId,
      itemId: job.itemId,
      jobId: job.id,
      kind: "files",
      title: `${job.files.length} file(s) changed`,
      body: job.files.join("\n"),
      by,
      createdAt: deps.now(),
    });
  if (job.diff?.trim())
    rows.push({
      id: `apf_${job.id}_diff`,
      assignmentId,
      itemId: job.itemId,
      jobId: job.id,
      kind: "diff",
      title: "git diff",
      body: clip(job.diff),
      by,
      createdAt: deps.now(),
    });
  // A fixed id per job: an end that arrives again (the runner reconnected) doesn't duplicate.
  if (rows.length) await deps.db.insert(assignmentProofs).values(rows).onConflictDoNothing();
}

export async function proofsOf(deps: AppDeps, assignmentId: string, itemId?: string): Promise<ProofRow[]> {
  return deps.db
    .select()
    .from(assignmentProofs)
    .where(
      and(
        eq(assignmentProofs.assignmentId, assignmentId),
        itemId ? eq(assignmentProofs.itemId, itemId) : undefined,
      ),
    )
    .orderBy(asc(assignmentProofs.createdAt));
}
