// Assignments: a goal with its own thread, owner, participants, plan, decisions, reviews, commands that need
// a person, and the submission. The executor is the agent itself (on the server, through the thread) or
// Claude Code / Codex on the lent runner (one job at a time, resumable by its session).
// The messages' meta keeps only pointers; the state comes from here and the `assignment.updated` event tells.
import type {
  Assignment,
  AssignmentCommand,
  AssignmentDecision,
  AssignmentReview,
  AssignmentRole,
  AssignmentSubmission,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { assignmentWorkState } from "@vanr/engine/work-state";
import { and, count, eq, gt, inArray } from "drizzle-orm";
import type { AgentRow } from "../agents";
import { canReadChannel, channelInWorkspace } from "../channels";
import { type AppDeps, requireRuntime, type WorkspaceMember } from "../context";
import { HttpError } from "../http";
import { postMessage } from "../messages";
import { canUseRunner } from "../runners/runners";
import { assignmentUsage } from "./budget";
import { seenBy } from "./events";
import { planOf, toPlanItem } from "./plan";
import { isStale, itemStuck, lastActivityOf, waitingOnPerson } from "./state";

const {
  assignments,
  assignmentParticipants,
  assignmentJoinRequests,
  assignmentDecisions,
  assignmentReviews,
  assignmentCommands,
  assignmentSubmissions,
  runnerJobs,
  runners,
  agents,
  users,
} = schema;

export type AssignmentRow = typeof assignments.$inferSelect;
export type DecisionRow = typeof assignmentDecisions.$inferSelect;
export type ReviewRow = typeof assignmentReviews.$inferSelect;
export type CommandRow = typeof assignmentCommands.$inferSelect;
export type SubmissionRow = typeof assignmentSubmissions.$inferSelect;

export const OPEN_STATUSES = ["proposed", "active", "paused", "wrapping_up"] as const;
export const isClosed = (row: AssignmentRow) => row.status === "done" || row.status === "canceled";

export const notFoundAssignment = () => new HttpError(404, "assignment.not_found", "Assignment not found");

export async function assignmentInWorkspace(db: Db, workspaceId: string, id: string): Promise<AssignmentRow> {
  const [row] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.id, id), eq(assignments.workspaceId, workspaceId)));
  if (!row) throw notFoundAssignment();
  return row;
}

export async function assignmentOfThread(db: Db, threadId: string): Promise<AssignmentRow | null> {
  const [row] = await db.select().from(assignments).where(eq(assignments.threadId, threadId));
  return row ?? null;
}

/** The viewer's role: owner, participant, or read-only (who reads the channel). null = doesn't see the assignment. */
export async function roleOf(
  db: Db,
  me: { workspaceId: string; userId: string },
  row: AssignmentRow,
): Promise<AssignmentRole | null> {
  if (row.ownerId === me.userId) return "owner";
  const [p] = await db
    .select({ role: assignmentParticipants.role })
    .from(assignmentParticipants)
    .where(
      and(eq(assignmentParticipants.assignmentId, row.id), eq(assignmentParticipants.userId, me.userId)),
    );
  if (p) return p.role;
  if (await canReadChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId: row.channelId }))
    return "view";
  return null;
}

export const canActRole = (role: AssignmentRole | null) => role === "owner" || role === "decide";
export const canManage = (me: WorkspaceMember, row: AssignmentRow) =>
  row.ownerId === me.userId || can(me.role, "configure");

/** The assignment as the person may see it; 404 for whoever neither reads the channel nor takes part. */
export async function viewAssignment(deps: AppDeps, me: WorkspaceMember, id: string) {
  const row = await assignmentInWorkspace(deps.db, me.workspaceId, id);
  const role = await roleOf(deps.db, me, row);
  if (!role) throw notFoundAssignment();
  return { row, role };
}

/** Who may act (the owner or who decides); everyone else gets 403. */
export async function actOn(deps: AppDeps, me: WorkspaceMember, id: string) {
  const v = await viewAssignment(deps, me, id);
  if (!canActRole(v.role))
    throw new HttpError(403, "assignment.forbidden", "Only the owner and who decides can do that");
  return v;
}

export function requireOpen(row: AssignmentRow) {
  if (isClosed(row)) throw new HttpError(409, "assignment.closed", "This assignment is closed");
}

/**
 * The assignment's runner: the one chosen (or lent on the handover) or, with no choice, the agent's,
 * as long as the assignment's owner may use that runner.
 */
export async function runnerOfAssignment(db: Db, row: AssignmentRow) {
  if (row.runnerId) {
    const [m] = await db.select().from(runners).where(eq(runners.id, row.runnerId));
    return m && !m.removedAt ? m : null;
  }
  const [a] = await db
    .select({ environmentId: agents.environmentId })
    .from(agents)
    .where(eq(agents.id, row.agentId));
  if (!a?.environmentId) return null;
  const [m] = await db.select().from(runners).where(eq(runners.id, a.environmentId));
  if (!m || m.removedAt) return null;
  const [owner] = await db
    .select({ role: schema.members.role })
    .from(schema.members)
    .where(and(eq(schema.members.workspaceId, row.workspaceId), eq(schema.members.userId, row.ownerId)));
  return owner && canUseRunner({ userId: row.ownerId, role: owner.role }, m) ? m : null;
}

export async function agentOf(db: Db, row: AssignmentRow): Promise<AgentRow> {
  const [a] = await db.select().from(agents).where(eq(agents.id, row.agentId));
  if (!a) throw notFoundAssignment();
  return a;
}

const executorsOf = (m: {
  executors: ("claude_code" | "codex")[];
  access: { tools: { claude: boolean; codex: boolean } };
}) => m.executors.filter((e) => (e === "claude_code" ? m.access.tools.claude : m.access.tools.codex));

async function pendingCounts(db: Db, assignmentId: string) {
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  return {
    decisions: await n(
      db
        .select({ n: count() })
        .from(assignmentDecisions)
        .where(
          and(eq(assignmentDecisions.assignmentId, assignmentId), eq(assignmentDecisions.status, "pending")),
        ),
    ),
    provisional: await n(
      db
        .select({ n: count() })
        .from(assignmentDecisions)
        .where(
          and(
            eq(assignmentDecisions.assignmentId, assignmentId),
            eq(assignmentDecisions.status, "provisional"),
          ),
        ),
    ),
    reviews: await n(
      db
        .select({ n: count() })
        .from(assignmentReviews)
        .where(
          and(eq(assignmentReviews.assignmentId, assignmentId), eq(assignmentReviews.status, "pending")),
        ),
    ),
    commands: await n(
      db
        .select({ n: count() })
        .from(assignmentCommands)
        .where(
          and(eq(assignmentCommands.assignmentId, assignmentId), eq(assignmentCommands.state, "pending")),
        ),
    ),
    submissions: await n(
      db
        .select({ n: count() })
        .from(assignmentSubmissions)
        .where(
          and(
            eq(assignmentSubmissions.assignmentId, assignmentId),
            eq(assignmentSubmissions.status, "pending"),
          ),
        ),
    ),
    joinRequests: await n(
      db
        .select({ n: count() })
        .from(assignmentJoinRequests)
        .where(
          and(
            eq(assignmentJoinRequests.assignmentId, assignmentId),
            eq(assignmentJoinRequests.status, "pending"),
          ),
        ),
    ),
  };
}

export async function runningJobsOf(db: Db, assignmentId: string) {
  return db
    .select()
    .from(runnerJobs)
    .where(and(eq(runnerJobs.assignmentId, assignmentId), inArray(runnerJobs.status, ["queued", "running"])));
}

export async function toAssignment(
  deps: AppDeps,
  row: AssignmentRow,
  me: { workspaceId: string; userId: string },
): Promise<Assignment> {
  const { db } = deps;
  const role = await roleOf(db, me, row);
  const runner = await runnerOfAssignment(db, row);
  const items = await planOf(deps, row.id);
  const live = items.filter((i) => i.status !== "dropped");
  const pending = await pendingCounts(db, row.id);
  const now = deps.now();
  const lastActivity = await lastActivityOf(deps, row);
  const person = {
    decisions: Array.from({ length: pending.decisions }, () => ({ id: "", deadlineAt: null })),
    others: pending.reviews + pending.commands,
    submission: pending.submissions > 0,
  };
  // Stopped by the cap also waits on you: only the owner raises the cap and resumes.
  const waiting =
    waitingOnPerson({ person, items: live }) || (row.status === "paused" && row.ceiling !== null);
  const stale = isStale({ status: row.status, person, items: live, wakeAt: row.wakeAt, lastActivity }, now);
  const base = assignmentWorkState(row.status, { waitingOnPerson: waiting, stale });
  // Asked to come back later (wait_until, a decision's deadline): scheduled, not working.
  const state = base === "running" && row.wakeAt && row.wakeAt > now ? "due" : base;
  const seen = role ? await seenBy(deps, row.id, me.userId) : 0;
  const [unseen] = await db
    .select({ n: count() })
    .from(schema.assignmentEvents)
    .where(and(eq(schema.assignmentEvents.assignmentId, row.id), gt(schema.assignmentEvents.seq, seen)));
  const [open] = await db
    .select({ question: assignmentDecisions.question })
    .from(assignmentDecisions)
    .where(
      and(
        eq(assignmentDecisions.assignmentId, row.id),
        eq(assignmentDecisions.status, "pending"),
        eq(assignmentDecisions.blocking, true),
      ),
    )
    .limit(1);
  const [joined] = await db
    .select({ status: assignmentJoinRequests.status })
    .from(assignmentJoinRequests)
    .where(
      and(eq(assignmentJoinRequests.assignmentId, row.id), eq(assignmentJoinRequests.userId, me.userId)),
    );
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    executor: row.executor,
    runner: runner
      ? {
          id: runner.id,
          name: runner.name,
          online: deps.runners.isOnline(runner.id),
          executors: ["agent", ...executorsOf(runner)],
        }
      : null,
    ownerId: row.ownerId,
    role,
    actionable: canActRole(role),
    manageable: row.ownerId === me.userId,
    needsEnvironment: row.executor !== "agent" && !runner,
    commandPolicy: row.commandPolicy,
    resumeJobs: row.resumeJobs,
    plan: {
      items: items.map(toPlanItem),
      version: row.planVersion,
      total: live.length,
      done: live.filter((i) => i.status === "done").length,
      passed: live.filter((i) => i.passes === true).length,
      waiting: live.filter((i) => i.status === "blocked_on_you").length,
    },
    state,
    stale,
    lastTouchedAt: lastActivity?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    overdue: !!row.dueAt && row.dueAt <= now && !isClosed(row),
    wakeAt: row.wakeAt?.toISOString() ?? null,
    waitReason: (row.waitReason as Assignment["waitReason"]) ?? null,
    limits: row.limits,
    usage: await assignmentUsage(deps, row),
    // The contract names the dollar cap `usd`; the column keeps `dollars`, like the limits.
    ceiling: row.ceiling === "dollars" ? "usd" : row.ceiling,
    unseen: unseen?.n ?? 0,
    runningJobs: (await runningJobsOf(db, row.id)).length,
    pending,
    findings: row.findings.map((f) => f.text),
    pendingQuestion: open?.question ?? null,
    checkoutPath: row.checkoutPath,
    pendingJoin: joined?.status === "pending",
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** With the workspace's manager permission (configure), `manageable` also holds for whoever isn't the owner. */
export async function assignmentFor(
  deps: AppDeps,
  row: AssignmentRow,
  me: WorkspaceMember,
): Promise<Assignment> {
  const m = await toAssignment(deps, row, me);
  return { ...m, manageable: canManage(me, row) };
}

export type AssignmentChange =
  | "created"
  | "status"
  | "plan"
  | "settings"
  | "participants"
  | "decision"
  | "review"
  | "command"
  | "submission"
  | "report"
  | "suggestion"
  | "job"
  | "join";

/** Tells the channel the assignment changed; `extra` carries what the client applies directly (e.g. the answered suggestion). */
export function publishAssignment(
  deps: AppDeps,
  row: AssignmentRow,
  change: AssignmentChange,
  extra: Record<string, unknown> = {},
) {
  deps.hub.toChannel(row.channelId, {
    type: "assignment.updated",
    assignmentId: row.id,
    threadId: row.threadId,
    channelId: row.channelId,
    change,
    ...extra,
  });
}

export async function updateAssignment(
  deps: AppDeps,
  row: AssignmentRow,
  set: Partial<typeof assignments.$inferInsert>,
  change: AssignmentChange,
): Promise<AssignmentRow> {
  const [next] = await deps.db
    .update(assignments)
    .set({ ...set, updatedAt: deps.now() })
    .where(eq(assignments.id, row.id))
    .returning();
  const out = next ?? row;
  publishAssignment(deps, out, change);
  return out;
}

/** Changes the status only if it is still one of the expected ones (two people clicking at once). */
export async function moveAssignment(
  deps: AppDeps,
  row: AssignmentRow,
  from: readonly AssignmentRow["status"][],
  set: Partial<typeof assignments.$inferInsert>,
  change: AssignmentChange,
): Promise<AssignmentRow | null> {
  const [next] = await deps.db
    .update(assignments)
    .set({ ...set, updatedAt: deps.now() })
    .where(and(eq(assignments.id, row.id), inArray(assignments.status, [...from])))
    .returning();
  if (next) publishAssignment(deps, next, change);
  return next ?? null;
}

// ---- API formats ----

export function toDecision(row: DecisionRow): AssignmentDecision {
  return {
    id: row.id,
    question: row.question,
    options: row.options,
    status: row.status,
    chosen: row.chosen,
    selectedBy: row.selectedBy,
    selectedAt: row.selectedAt?.toISOString() ?? null,
    blocking: row.blocking,
    recommendation: row.recommendation,
    why: row.why,
    impact: row.impact,
    opinions: row.opinions,
    messageId: row.messageId,
  };
}

export function toReview(row: ReviewRow): AssignmentReview {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    note: row.note,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    fileIds: row.fileIds,
    prUrl: row.prUrl,
  };
}

export function toCommand(row: CommandRow): AssignmentCommand {
  return {
    id: row.id,
    command: row.command,
    jobId: row.jobId ?? "",
    tool: row.tool,
    state: row.state,
    rules: row.rules,
    always: row.always,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSubmission(row: SubmissionRow): AssignmentSubmission {
  return {
    id: row.id,
    status: row.status,
    changesNote: row.changesNote,
    auto: row.auto,
    note: row.note,
    fileIds: row.fileIds,
    checklist: row.checklist,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---- the assignment's files ----

const STATUS_MARK: Record<string, string> = {
  todo: " ",
  doing: "~",
  blocked_on_you: "?",
  done: "x",
  dropped: "-",
};

export async function assignmentFiles(deps: AppDeps, row: AssignmentRow) {
  const decisions = await deps.db
    .select()
    .from(assignmentDecisions)
    .where(eq(assignmentDecisions.assignmentId, row.id))
    .orderBy(assignmentDecisions.createdAt);
  const names = await nameMap(
    deps.db,
    decisions.map((d) => d.selectedBy).filter((x): x is string => !!x),
  );
  const items = await planOf(deps, row.id);
  const plan = items.length
    ? items
        .map((i) => {
          const verdict =
            i.passes === true ? " (passed)" : i.passes === false ? ` (failed: ${i.verdict ?? ""})` : "";
          return `- [${STATUS_MARK[i.status] ?? " "}] ${i.id}: ${i.title}${i.criteria ? ` — done when: ${i.criteria}` : ""}${verdict}`;
        })
        .join("\n")
    : "_No plan yet._";
  const assignment = `# ${row.title}\n\n${row.goal}\n\nStatus: ${row.status}\n\n## Plan\n\n${plan}\n`;
  const decided = decisions.length
    ? decisions
        .map((d) => {
          const who = d.selectedBy ? ` by ${names.get(d.selectedBy) ?? "someone"}` : "";
          const state =
            d.status === "taken"
              ? `Chosen: ${d.chosen}${who}`
              : d.status === "provisional"
                ? `Provisional: ${d.chosen ?? d.recommendation ?? "?"}`
                : "Waiting for a decision";
          return `## ${d.question}\n\nOptions: ${d.options.join(" | ")}\n${state}${d.why ? `\nWhy: ${d.why}` : ""}`;
        })
        .join("\n\n")
    : "_No decisions yet._";
  const notes = row.findings.length
    ? row.findings
        .map((f) => `- ${f.at.slice(0, 16).replace("T", " ")} ${f.text}${f.prUrl ? ` (${f.prUrl})` : ""}`)
        .join("\n")
    : "_Nothing reported yet._";
  const at = row.updatedAt.toISOString();
  return [
    { name: "assignment.md", content: assignment, updatedAt: at },
    { name: "decisions.md", content: `# Decisions\n\n${decided}\n`, updatedAt: at },
    { name: "notes.md", content: `# Notes\n\n${notes}\n`, updatedAt: at },
  ];
}

export async function nameMap(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---- messages in the thread ----

/**
 * A person's message in the assignment's thread, which the agent receives (start, resume, ask for changes).
 * The runtime hands it to the agent after it is saved, so without the runtime nothing is written.
 */
export async function personSays(
  deps: AppDeps,
  row: AssignmentRow,
  userId: string,
  text: string,
  meta: Record<string, unknown> = {},
) {
  requireRuntime(deps.runtime, "onPersonMessage");
  const channel = await channelInWorkspace(deps.db, row.workspaceId, row.channelId);
  if (!channel) throw notFoundAssignment();
  const agent = await agentOf(deps.db, row);
  const { message } = await postMessage(deps, {
    workspaceId: row.workspaceId,
    channel,
    author: { type: "person", id: userId },
    body: `@${agent.handle} ${text}`,
    clientId: newId("ak"),
    threadId: row.threadId,
    meta,
  });
  await deps.runtime.onPersonMessage({ workspaceId: row.workspaceId, channel, message });
  return message;
}

/** The agent's message in the thread (decision card, report, submission). */
export async function agentSays(
  deps: AppDeps,
  row: AssignmentRow,
  text: string,
  meta: Record<string, unknown>,
) {
  const channel = await channelInWorkspace(deps.db, row.workspaceId, row.channelId);
  if (!channel) throw notFoundAssignment();
  const { message } = await postMessage(deps, {
    workspaceId: row.workspaceId,
    channel,
    author: { type: "agent", id: row.agentId },
    body: text,
    clientId: newId("am"),
    threadId: row.threadId,
    meta,
  });
  return message;
}

/** Open assignments in which the person decides and something waits on them. */
export async function waitingFor(db: Db, me: { workspaceId: string; userId: string }, row: AssignmentRow) {
  if (isClosed(row)) return false;
  if (!canActRole(await roleOf(db, me, row))) return false;
  // Stopped at the cap: only the owner raises the cap.
  if (row.status === "paused" && row.ceiling && row.ownerId === me.userId) return true;
  const p = await pendingCounts(db, row.id);
  if (
    p.decisions + p.reviews + p.commands + p.submissions + (row.ownerId === me.userId ? p.joinRequests : 0) >
    0
  )
    return true;
  // A stuck item (or one waiting on someone) waits on whoever can have it tried again.
  const items = await planOf({ db }, row.id);
  return items.some((i) => i.status === "blocked_on_you" || itemStuck(i) !== null);
}

/** The assignments the person sees (channels they read and the ones they take part in). */
export async function visibleAssignments(
  deps: AppDeps,
  me: WorkspaceMember,
  opts: { channelId?: string; agentId?: string },
) {
  const rows = await deps.db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.workspaceId, me.workspaceId),
        opts.channelId ? eq(assignments.channelId, opts.channelId) : undefined,
        opts.agentId ? eq(assignments.agentId, opts.agentId) : undefined,
      ),
    )
    .orderBy(assignments.createdAt);
  const out: AssignmentRow[] = [];
  for (const r of rows) if (await roleOf(deps.db, me, r)) out.push(r);
  return out.reverse();
}
