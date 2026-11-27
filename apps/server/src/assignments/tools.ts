// The agent's tools in an assignment's thread (plan, report, decision, review, job on the runner, submission)
// and the one that proposes an assignment outside it.
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRow } from "../agents";
import type { AppDeps } from "../context";
import { createFile } from "../drive";
import { notify } from "../notifications";
import { defineStored } from "../runtime/base-tools";
import { domain, self, visibleFile } from "../runtime/content-tools";
import type { ToolContext, ToolDef } from "../runtime/tools";
import { ToolInputError } from "../runtime/tools";
import {
  type AssignmentRow,
  assignmentFiles,
  assignmentOfThread,
  publishAssignment,
  roleOf,
  updateAssignment,
} from "./core";
import { createAssignment, createSubmission, runAgentJob } from "./engine";
import { assignmentEvent } from "./events";
import { itemOf, MAX_PLAN_ITEMS, planOf, touchItem, writePlan } from "./plan";
import { addProofs, proofInput } from "./proofs";

const { assignments, assignmentDecisions, assignmentReviews } = schema;

/** Notes kept on the assignment (the newest ones; they become notes.md). */
const FINDINGS_MAX = 100;

/** This thread's assignment, open, in this workspace and the agent's own. */
async function current(ctx: ToolContext): Promise<AssignmentRow> {
  const row = ctx.threadId ? await assignmentOfThread(ctx.deps.db, ctx.threadId) : null;
  if (!row || row.agentId !== ctx.agent.id || row.workspaceId !== ctx.workspaceId)
    throw new ToolInputError("This conversation is not one of your assignments.");
  if (row.status === "done" || row.status === "canceled")
    throw new ToolInputError("This assignment is closed.");
  if (row.status === "paused")
    throw new ToolInputError("The assignment is paused. Stop and wait until someone resumes it.");
  return row;
}

/**
 * Drive files attached to the assignment: the agent and whoever asked see each one, and so does whoever reads
 * the assignment (the whole workspace's, the assignment channel's or its thread's), so no other channel's file leaks.
 */
async function sharedFiles(ctx: ToolContext, row: AssignmentRow, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const file = await visibleFile(ctx, id);
    if (file.channelId !== null && file.channelId !== row.channelId && file.threadId !== row.threadId)
      throw new ToolInputError(`File ${id} is not visible in this assignment`);
  }
  return unique;
}

async function notifyPeople(ctx: ToolContext, row: AssignmentRow, text: string, messageId: string) {
  await notify(ctx.deps, {
    workspaceId: row.workspaceId,
    userId: row.ownerId,
    kind: "question_for_you",
    groupKey: `assignment:${row.id}:ask:${messageId}`,
    waiting: true,
    actor: { type: "agent", id: row.agentId },
    source: {
      assignmentId: row.id,
      channelId: row.channelId,
      threadId: row.threadId,
      messageId,
      label: row.title,
    },
    latest: { title: row.title, text: text.slice(0, 280) },
  });
}

const planItem = z.object({
  id: z.string().trim().max(40).optional(),
  title: z.string().trim().min(1).max(300),
  /** Done criterion: what the verifier checks. */
  criteria: z.string().trim().max(2000).optional(),
  milestone: z.string().trim().max(80).nullable().optional(),
  status: z.enum(["todo", "doing", "blocked_on_you", "done", "dropped"]).default("todo"),
  // No `passes`: only the verifier marks an item passed (zod drops the field if it comes).
});

const updatePlan = defineStored({
  name: "update_plan",
  description:
    "Replace the assignment plan. Send every item each time and keep the id of items that already exist. Each item is a deliverable with a done criterion (what a reviewer can check) and, when several go together, a milestone. Items a person or the verifier added stay even if you leave them out.",
  effect: "K1",
  input: z.object({ items: z.array(planItem).min(1).max(MAX_PLAN_ITEMS) }),
  async run(ctx, input) {
    const row = await current(ctx);
    const actor = { type: "agent" as const, id: ctx.agent.id };
    const w = await domain(writePlan(ctx.deps, row.id, { author: actor, mode: "agent", items: input.items }));
    if (w.added.length || w.removed.length || w.edited.length)
      await assignmentEvent(ctx.deps, row, {
        kind: "plan_edited",
        actor,
        data: { version: w.version, added: w.added, removed: w.removed, edited: w.edited },
      });
    publishAssignment(ctx.deps, row, "plan");
    const live = w.items.filter((i) => i.status !== "dropped");
    return `Plan v${w.version}: ${live.filter((i) => i.status === "done").length}/${live.length} done, ${live.filter((i) => i.passes === true).length} passed the verifier.`;
  },
});

const finishItem = defineStored({
  name: "finish_item",
  description:
    "Mark a plan item as done, with a short summary of what changed and proofs a reviewer can check (diff, test log, screenshot file id, preview link). A verifier with a clean context checks it at the end of the milestone; failed items come back as fix items.",
  effect: "K1",
  input: z.object({
    itemId: z.string().trim().min(1).max(40),
    summary: z.string().trim().min(1).max(8000),
    proofs: z.array(proofInput).max(10).optional(),
  }),
  async run(ctx, input) {
    const row = await current(ctx);
    const item = await itemOf(ctx.deps, row.id, input.itemId);
    if (!item || item.status === "dropped")
      throw new ToolInputError(`There is no item ${input.itemId} in the plan.`);
    const actor = { type: "agent" as const, id: ctx.agent.id };
    // A screenshot's file must be one the person asking sees too.
    for (const p of input.proofs ?? [])
      if (p.kind === "screenshot" && p.fileId) await visibleFile(ctx, p.fileId);
    await domain(addProofs(ctx.deps, row, { itemId: item.id, by: actor, proofs: input.proofs ?? [] }));
    await touchItem(ctx.deps, row.id, item.id, {
      status: "done",
      summary: input.summary,
      doneAt: ctx.deps.now(),
      updatedBy: actor,
      // An item already judged was finished again: the verdict was on the earlier work, the verifier looks again.
      ...(item.passes !== null ? { passes: null, verdict: null, verifiedAt: null } : {}),
    });
    await assignmentEvent(ctx.deps, row, {
      kind: "item_done",
      actor,
      itemId: item.id,
      data: { proofs: input.proofs?.length ?? 0, summary: input.summary.slice(0, 300) },
    });
    if (input.proofs?.length)
      await assignmentEvent(ctx.deps, row, {
        kind: "proof_added",
        actor,
        itemId: item.id,
        data: { kinds: input.proofs.map((p) => p.kind) },
      });
    publishAssignment(ctx.deps, row, "plan");
    return `Marked ${item.id} done. The verifier checks it at the end of its milestone; you do not mark it as passed.`;
  },
});

const WAIT_MAX_MS = 7 * 24 * 3600_000;

const waitUntil = defineStored({
  name: "wait_until",
  description:
    "Pause the assignment until a time (a build that takes hours, a reply expected tomorrow). End the turn after calling it; the assignment wakes you then, or earlier if a person acts.",
  effect: "K0",
  input: z
    .object({
      minutes: z
        .number()
        .int()
        .min(1)
        .max(7 * 24 * 60)
        .optional(),
      until: z.iso.datetime({ offset: true }).optional(),
      reason: z.string().trim().min(1).max(300),
    })
    .refine((x) => (x.minutes === undefined) !== (x.until === undefined), "Give minutes or until"),
  async run(ctx, input) {
    const row = await current(ctx);
    const now = ctx.deps.now();
    const at =
      input.minutes !== undefined
        ? new Date(now.getTime() + input.minutes * 60_000)
        : new Date(input.until as string);
    if (at.getTime() <= now.getTime()) throw new ToolInputError("That time already passed.");
    if (at.getTime() - now.getTime() > WAIT_MAX_MS) throw new ToolInputError("At most 7 days ahead.");
    await updateAssignment(ctx.deps, row, { wakeAt: at, waitReason: "timer" }, "status");
    await assignmentEvent(ctx.deps, row, {
      kind: "waiting_until",
      actor: { type: "agent", id: ctx.agent.id },
      data: { until: at.toISOString(), reason: input.reason },
    });
    return `OK. End the turn now; the assignment wakes you at ${at.toISOString()}.`;
  },
});

const report = defineStored({
  name: "report",
  description: "Tell the team what you found or did (shows in the assignment thread and in its notes).",
  effect: "K1",
  input: z.object({
    text: z.string().trim().min(1).max(4000),
    // Only http(s): the link becomes an href in the notes, and z.url() alone accepts javascript: and data:.
    prUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
  }),
  async run(ctx, input) {
    const row = await current(ctx);
    const entry = {
      text: input.text,
      at: ctx.deps.now().toISOString(),
      ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    };
    // One statement appends to the notes as they are now: two reports at once both stay.
    const [next] = await ctx.deps.db
      .update(assignments)
      .set({
        findings: sql`(select coalesce(jsonb_agg(e order by o), '[]'::jsonb) from (select e, o from jsonb_array_elements(${assignments.findings} || ${JSON.stringify([entry])}::jsonb) with ordinality as t(e, o) order by o desc limit ${FINDINGS_MAX}) kept)`,
        updatedAt: ctx.deps.now(),
      })
      .where(eq(assignments.id, row.id))
      .returning();
    publishAssignment(ctx.deps, next ?? row, "report");
    await ctx.postCard(input.text, {
      assignmentReport: { assignmentId: row.id, text: input.text.slice(0, 2000) },
    });
    return "Reported.";
  },
});

const askDecision = defineStored({
  name: "ask_decision",
  description:
    "Ask the team to choose between 2 to 4 options. Blocking (default): end the turn after asking; the assignment continues when they choose, or at the deadline with your recommendation. Not blocking: you go on with your recommendation and they can confirm later.",
  effect: "K0",
  input: z.object({
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(4),
    recommendation: z.string().trim().max(200).optional(),
    why: z.string().trim().max(1000).optional(),
    impact: z.string().trim().max(500).optional(),
    blocking: z.boolean().default(true),
    /** Deadline of the choice: once it passes, the assignment goes on with the recommendation (without one, it warns again). */
    deadlineMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .optional(),
  }),
  async run(ctx, input) {
    const row = await current(ctx);
    if (input.recommendation && !input.options.includes(input.recommendation))
      throw new ToolInputError("recommendation must be one of the options");
    if (!input.blocking && !input.recommendation)
      throw new ToolInputError("A non-blocking decision needs a recommendation (what you will do meanwhile)");
    const id = newId("adec");
    await ctx.deps.db.insert(assignmentDecisions).values({
      id,
      assignmentId: row.id,
      question: input.question,
      options: input.options,
      status: input.blocking ? "pending" : "provisional",
      chosen: input.blocking ? null : (input.recommendation ?? null),
      blocking: input.blocking,
      recommendation: input.recommendation ?? null,
      why: input.why ?? null,
      impact: input.impact ?? null,
      deadlineAt:
        input.blocking && input.deadlineMinutes
          ? new Date(ctx.deps.now().getTime() + input.deadlineMinutes * 60_000)
          : null,
    });
    const card = await ctx.postCard(input.question, {
      assignmentDecision: { assignmentId: row.id, decisionId: id },
    });
    await ctx.deps.db
      .update(assignmentDecisions)
      .set({ messageId: card.id })
      .where(eq(assignmentDecisions.id, id));
    publishAssignment(ctx.deps, row, "decision");
    await notifyPeople(ctx, row, input.question, card.id);
    await assignmentEvent(ctx.deps, row, {
      kind: "decision_asked",
      actor: { type: "agent", id: ctx.agent.id },
      data: { decisionId: id, question: input.question, blocking: input.blocking },
    });
    if (!input.blocking) return `Going on with "${input.recommendation}" for now; the team can change it.`;
    // It doesn't hold the run: the engine waits (it survives a crash) and the next turn brings the choice.
    return "Asked. End the turn now: the assignment continues when the team chooses.";
  },
});

const requestReview = defineStored({
  name: "request_review",
  description: "Ask the team to review something you made (a document, a pull request) before you go on.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(4000),
    fileIds: z.array(z.string().max(64)).max(10).optional(),
    // Only http(s): the link becomes an href on the card, and z.url() alone accepts javascript: and data:.
    prUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
  }),
  async run(ctx, input) {
    const row = await current(ctx);
    const fileIds = await sharedFiles(ctx, row, input.fileIds ?? []);
    const id = newId("mrv");
    await ctx.deps.db.insert(assignmentReviews).values({
      id,
      assignmentId: row.id,
      title: input.title,
      summary: input.summary,
      fileIds,
      prUrl: input.prUrl ?? null,
    });
    const card = await ctx.postCard(input.title, {
      assignmentReview: { assignmentId: row.id, reviewId: id },
    });
    await ctx.deps.db
      .update(assignmentReviews)
      .set({ messageId: card.id })
      .where(eq(assignmentReviews.id, id));
    publishAssignment(ctx.deps, row, "review");
    await notifyPeople(ctx, row, input.title, card.id);
    return "Review requested. Work on something else or stop and wait; the answer arrives in this thread.";
  },
});

const requestApproval = defineStored({
  name: "request_approval",
  description:
    "Ask for explicit approval before something risky in the assignment (deploy, delete, spend). Waits.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).optional(),
  }),
  // The request is the approval itself: the gate asks a person (policy), and running only confirms it.
  async plan(ctx, input) {
    const row = await current(ctx);
    return {
      policy: "ask",
      payload: { assignmentId: row.id, ...input },
      preview: { title: input.title, ...(input.detail ? { body: input.detail } : {}) },
      card: { scope: `assignment:${row.id}`, params: { assignmentId: row.id } },
    };
  },
  async run() {
    return "Approved.";
  },
});

const uploadFile = defineStored({
  name: "upload_drive_file",
  description: "Save a document for the assignment in the Drive (attached to this thread).",
  effect: "K1",
  input: z.object({ title: z.string().trim().min(1).max(200), markdown: z.string().max(500_000) }),
  async run(ctx, input) {
    await current(ctx);
    const { row } = await domain(
      createFile(ctx.deps, {
        workspaceId: ctx.workspaceId,
        title: input.title,
        author: self(ctx),
        content: { kind: "document", markdown: input.markdown },
        channelId: ctx.channel.id,
        threadId: ctx.threadId,
      }),
    );
    return `Saved "${row.title}" (${row.id}).`;
  },
});

const getContext = defineStored({
  name: "get_context",
  description: "Read the assignment files: goal and plan, decisions taken, notes.",
  effect: "K0",
  input: z.object({}),
  async run(ctx) {
    const row = await current(ctx);
    return (await assignmentFiles(ctx.deps, row)).map((f) => `### ${f.name}\n\n${f.content}`).join("\n\n");
  },
});

const startJob = defineStored({
  name: "start_job",
  description:
    "Hand a coding job to Claude Code or Codex on the assignment's runner. Give a complete prompt: what to change, where, and how to check. End the turn after starting it; the assignment continues with its result.",
  effect: "K2",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(50_000),
    branch: z.string().trim().max(200).optional(),
  }),
  async run(ctx, input) {
    const row = await current(ctx);
    return runAgentJob(ctx, row, input);
  },
});

const completeAssignment = defineStored({
  name: "complete_assignment",
  description:
    "Submit the assignment: a summary, a checklist the owner can tick to check the result, and the paths that changed. Then stop.",
  effect: "K1",
  input: z.object({
    summary: z.string().trim().min(1).max(10_000),
    checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
    paths: z.array(z.string().trim().max(500)).max(50).optional(),
    fileIds: z.array(z.string().max(64)).max(10).optional(),
  }),
  async run(ctx, input) {
    const row = await current(ctx);
    if (row.status !== "active") throw new ToolInputError("Only an active assignment can be submitted.");
    // A submission only with everything the verifier passed (the engine submits on its own when it gets there),
    // and with at least one deliverable: an empty or fully dropped plan is not a finished assignment.
    const live = (await planOf(ctx.deps, row.id)).filter((i) => i.status !== "dropped" && i.kind !== "fix");
    if (live.length === 0)
      throw new ToolInputError("The plan has no deliverable. Add the deliverables with update_plan first.");
    const open = live.filter((i) => i.passes !== true);
    if (open.length)
      throw new ToolInputError(
        `Not every deliverable passed the verifier yet (${open.map((i) => i.id).join(", ")}). Finish them with finish_item; the verifier checks each milestone.`,
      );
    const fileIds = await sharedFiles(ctx, row, input.fileIds ?? []);
    const note = input.paths?.length
      ? `${input.summary}\n\nChanged: ${input.paths.join(", ")}`
      : input.summary;
    await createSubmission(ctx.deps, row, { note, checklist: input.checklist, fileIds, auto: false });
    return "Submitted. Stop now; the owner will accept it or ask for changes in this thread.";
  },
});

const proposeAssignment = defineStored({
  name: "propose_assignment",
  description:
    "Propose an assignment for a larger goal that takes many steps: it gets its own thread, a plan and the owner's go-ahead before you start.",
  effect: "K1",
  input: z.object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4000),
    plan: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  }),
  async run(ctx, input) {
    if (!ctx.trigger)
      throw new ToolInputError("Only a person can own an assignment; propose it when someone asks.");
    if (ctx.channel.kind === "dm")
      throw new ToolInputError("Assignments live in channels; propose it in a channel.");
    const row = await domain(
      createAssignment(ctx.deps, {
        workspaceId: ctx.workspaceId,
        agentId: ctx.agent.id,
        agentHandle: ctx.agent.handle,
        channelId: ctx.channel.id,
        ownerId: ctx.trigger.authorId,
        title: input.title,
        goal: input.goal,
        executor: "agent",
        runnerId: null,
        commandPolicy: ctx.agent.assignmentCommandPolicy,
        ...(input.plan ? { plan: input.plan } : {}),
      }),
    );
    return `Proposed the assignment "${row.title}" (${row.id}). ${ctx.trigger.authorName} starts it from the card.`;
  },
});

const ASSIGNMENT_TOOLS: readonly ToolDef<unknown>[] = [
  updatePlan,
  finishItem,
  waitUntil,
  report,
  askDecision,
  requestReview,
  requestApproval,
  uploadFile,
  getContext,
  startJob,
  completeAssignment,
];

/** In one of the agent's assignment threads: its tools. Outside: only proposing one. */
export async function assignmentToolsFor(
  deps: AppDeps,
  agent: AgentRow,
  threadId: string | null,
): Promise<ToolDef<unknown>[]> {
  const row = threadId ? await assignmentOfThread(deps.db, threadId) : null;
  if (
    row &&
    row.agentId === agent.id &&
    row.workspaceId === agent.workspaceId &&
    row.status !== "done" &&
    row.status !== "canceled"
  )
    return [...ASSIGNMENT_TOOLS];
  return [proposeAssignment];
}

/** The part of the agent's prompt in the assignment's thread. */
export async function assignmentPrompt(
  deps: AppDeps,
  agentId: string,
  threadId: string | null,
): Promise<string> {
  if (!threadId) return "";
  const row = await assignmentOfThread(deps.db, threadId);
  if (!row || row.agentId !== agentId) return "";
  const decisions = await deps.db
    .select()
    .from(assignmentDecisions)
    .where(eq(assignmentDecisions.assignmentId, row.id));
  const items = await planOf(deps, row.id);
  const plan = items.length
    ? items
        .map((i) => {
          const verdict =
            i.passes === true ? " ✓ passed" : i.passes === false ? ` ✗ failed: ${i.verdict ?? ""}` : "";
          return `- [${i.status}] (${i.id})${i.milestone ? ` {${i.milestone}}` : ""} ${i.title}${i.criteria ? ` — done when: ${i.criteria}` : ""}${verdict}`;
        })
        .join("\n")
    : "No plan yet: start with update_plan.";
  const taken = decisions
    .filter((d) => d.status !== "pending")
    .map((d) => `- ${d.question} → ${d.chosen}${d.status === "provisional" ? " (provisional)" : ""}`)
    .join("\n");
  return [
    `# Assignment: ${row.title}`,
    `This thread is an assignment you run. Status: ${row.status}. Goal: ${row.goal}`,
    `## Plan\n${plan}`,
    taken ? `## Decisions\n${taken}` : "",
    row.status === "proposed"
      ? "The owner has not started it yet: discuss the plan, do not do the work."
      : "The assignment sends you one item per turn. Work on it, then call finish_item with a summary and proofs; a verifier with a clean context checks each milestone. Report findings, ask the team with ask_decision when a choice is theirs (then end the turn), and use wait_until to come back later.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Does a person's message in the assignment's thread go to the agent? (Not a suggestion, nor while paused.) */
export async function assignmentRouting(
  deps: AppDeps,
  row: { threadId: string | null; meta: { assignmentSuggestion?: unknown } },
): Promise<boolean> {
  if (row.meta.assignmentSuggestion) return false;
  if (!row.threadId) return true;
  const assignment = await assignmentOfThread(deps.db, row.threadId);
  return assignment?.status !== "paused";
}

/** Meta of a new message: whoever only views or comments on an open assignment makes a suggestion to the owner. */
export async function assignmentPostMeta(
  deps: AppDeps,
  me: { workspaceId: string; userId: string },
  threadId: string | undefined,
  body: string,
): Promise<{ assignmentSuggestion?: { assignmentId: string; text: string; status: "pending" } }> {
  if (!threadId) return {};
  const assignment = await assignmentOfThread(deps.db, threadId);
  if (
    !assignment ||
    assignment.workspaceId !== me.workspaceId ||
    assignment.status === "done" ||
    assignment.status === "canceled"
  )
    return {};
  const role = await roleOf(deps.db, me, assignment);
  if (role === "owner" || role === "decide") return {};
  return {
    assignmentSuggestion: { assignmentId: assignment.id, text: body.slice(0, 2000), status: "pending" },
  };
}
