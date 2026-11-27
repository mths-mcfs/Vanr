// The answers a person writes into a list another person may be writing at the same time: an opinion on a
// decision, a check on the submission's checklist, the answer to a suggestion and the command rules. Each one
// reads the row and writes it back in one transaction with that row locked, so two people at once both count
// (or the second finds it answered) and nothing written meanwhile is lost.
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, conflict, notFound } from "../http";
import type { CommandRow, DecisionRow, SubmissionRow } from "./core";
import { ruleFor } from "./engine";

const {
  assignments,
  assignmentCommands,
  assignmentDecisions,
  assignmentSubmissions,
  assignmentCommandRules,
  messages,
} = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const submissionClosed = () =>
  conflict("assignment.submission_closed", "This submission was already answered");

/** The person's opinion on a decision: replaces their earlier one and keeps everyone else's. */
export function addOpinion(
  deps: AppDeps,
  input: { assignmentId: string; decisionId: string; userId: string; option: string },
): Promise<DecisionRow> {
  return deps.db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(assignmentDecisions)
      .where(
        and(
          eq(assignmentDecisions.id, input.decisionId),
          eq(assignmentDecisions.assignmentId, input.assignmentId),
        ),
      )
      .for("update");
    if (!d) throw notFound("Decision not found");
    if (!d.options.includes(input.option)) throw badRequest("Not one of the options", { field: "option" });
    const opinions = [
      ...d.opinions.filter((o) => o.userId !== input.userId),
      { userId: input.userId, option: input.option, at: deps.now().toISOString() },
    ];
    const [next] = await tx
      .update(assignmentDecisions)
      .set({ opinions })
      .where(eq(assignmentDecisions.id, d.id))
      .returning();
    return next ?? d;
  });
}

/** Checks (or unchecks) one item of a pending submission's checklist, keeping the other items as they are now. */
export function checkSubmissionItem(
  deps: AppDeps,
  input: { assignmentId: string; submissionId: string; itemId: string; verifiedBy: string | null },
): Promise<SubmissionRow> {
  return deps.db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(assignmentSubmissions)
      .where(
        and(
          eq(assignmentSubmissions.id, input.submissionId),
          eq(assignmentSubmissions.assignmentId, input.assignmentId),
        ),
      )
      .for("update");
    if (!d) throw notFound("Submission not found");
    if (d.status !== "pending") throw submissionClosed();
    if (!d.checklist.some((i) => i.id === input.itemId)) throw notFound("Item not found");
    const checklist = d.checklist.map((i) =>
      i.id === input.itemId ? { ...i, verifiedBy: input.verifiedBy } : i,
    );
    const [next] = await tx
      .update(assignmentSubmissions)
      .set({ checklist })
      .where(eq(assignmentSubmissions.id, d.id))
      .returning();
    return next ?? d;
  });
}

const suggestionMeta = z.object({
  assignmentId: z.string(),
  text: z.string(),
  status: z.enum(["pending", "accepted", "declined"]).optional(),
});
export type Suggestion = z.infer<typeof suggestionMeta>;

/**
 * Answers a suggestion of the assignment's thread (a message whose meta carries it) once: the second answer
 * finds it answered. Returns the suggestion as answered and its author.
 */
export function answerSuggestion(
  deps: AppDeps,
  input: {
    workspaceId: string;
    assignmentId: string;
    threadId: string;
    messageId: string;
    status: "accepted" | "declined";
  },
): Promise<{ suggestion: Suggestion; authorId: string }> {
  return deps.db.transaction(async (tx) => {
    const [msg] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.messageId), eq(messages.workspaceId, input.workspaceId)))
      .for("update");
    const parsed = suggestionMeta.safeParse(msg?.meta.assignmentSuggestion);
    const s = parsed.success ? parsed.data : null;
    if (!msg || msg.threadId !== input.threadId || !s || s.assignmentId !== input.assignmentId)
      throw notFound("Suggestion not found");
    if (s.status && s.status !== "pending")
      throw conflict("assignment.suggestion_closed", "This suggestion was already answered");
    const suggestion = { ...s, status: input.status };
    await tx
      .update(messages)
      .set({ meta: { ...msg.meta, assignmentSuggestion: suggestion } })
      .where(eq(messages.id, msg.id));
    return { suggestion, authorId: msg.authorId };
  });
}

async function lockOpen(tx: Tx, assignmentId: string) {
  const [row] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).for("update");
  if (!row) throw notFound("Assignment not found");
  return row;
}

/**
 * Saves the command rules the assignment doesn't have yet, on the assignment's row locked (two "always" at once
 * save a rule once). Returns every rule it has now.
 */
export function addRules(
  deps: AppDeps,
  input: { assignmentId: string; wanted: readonly string[]; by: string },
): Promise<Set<string>> {
  return deps.db.transaction(async (tx) => {
    const row = await lockOpen(tx, input.assignmentId);
    return insertRules(tx, row.id, input.wanted, input.by);
  });
}

async function insertRules(tx: Tx, assignmentId: string, wanted: readonly string[], by: string) {
  const have = new Set(
    (
      await tx
        .select({ rule: assignmentCommandRules.rule })
        .from(assignmentCommandRules)
        .where(eq(assignmentCommandRules.assignmentId, assignmentId))
    ).map((r) => r.rule),
  );
  for (const rule of wanted.filter((r) => !have.has(r))) {
    await tx.insert(assignmentCommandRules).values({ id: newId("acr"), assignmentId, rule, by });
    have.add(rule);
  }
  return have;
}

/**
 * Decides a pending command; "always" also saves its rules, in the same transaction (a failed rule leaves the
 * command pending, to decide again). Null when it was no longer pending.
 */
export function decideCommand(
  deps: AppDeps,
  input: { assignmentId: string; commandId: string; decision: "allow" | "deny" | "always"; by: string },
): Promise<CommandRow | null> {
  return deps.db.transaction(async (tx) => {
    await lockOpen(tx, input.assignmentId);
    const [cmd] = await tx
      .update(assignmentCommands)
      .set({
        state: input.decision === "deny" ? "denied" : "allowed",
        always: input.decision === "always",
        decidedBy: input.by,
        decidedAt: deps.now(),
      })
      .where(
        and(
          eq(assignmentCommands.id, input.commandId),
          eq(assignmentCommands.assignmentId, input.assignmentId),
          eq(assignmentCommands.state, "pending"),
        ),
      )
      .returning();
    if (!cmd) return null;
    if (input.decision === "always") await insertRules(tx, input.assignmentId, cmd.rules, input.by);
    return cmd;
  });
}

/**
 * Allows the job's commands that were denied and still wait, among the ones asked (compared without the spaces
 * around them), and saves their rules, in one transaction: a command someone denied meanwhile is neither
 * allowed nor turned into a rule. Returns the commands it allowed and every rule the assignment has now.
 */
export function allowJobCommands(
  deps: AppDeps,
  input: { assignmentId: string; jobId: string; commands: readonly string[]; by: string },
): Promise<{ freed: CommandRow[]; rules: Set<string> }> {
  return deps.db.transaction(async (tx) => {
    await lockOpen(tx, input.assignmentId);
    const asked = new Set(input.commands.map((c) => c.trim()));
    const waiting = await tx
      .select()
      .from(assignmentCommands)
      .where(
        and(
          eq(assignmentCommands.assignmentId, input.assignmentId),
          eq(assignmentCommands.jobId, input.jobId),
          eq(assignmentCommands.state, "pending"),
        ),
      );
    const ids = waiting.filter((cmd) => asked.has(cmd.command.trim())).map((cmd) => cmd.id);
    if (ids.length === 0) throw conflict("assignment.command_closed", "None of these commands is waiting");
    const freed = await tx
      .update(assignmentCommands)
      .set({ state: "allowed", decidedBy: input.by, decidedAt: deps.now() })
      .where(and(inArray(assignmentCommands.id, ids), eq(assignmentCommands.state, "pending")))
      .returning();
    const wanted = [
      ...new Set(freed.flatMap((cmd) => (cmd.rules.length ? cmd.rules : [ruleFor(cmd.command)]))),
    ];
    return { freed, rules: await insertRules(tx, input.assignmentId, wanted, input.by) };
  });
}
