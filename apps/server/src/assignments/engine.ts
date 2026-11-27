// What moves an assignment: start and resume (the agent in the thread, or a job on the runner), stop, close,
// submit, the commands that wait for a person and the end of the jobs.
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { channelInWorkspace } from "../channels";
import type { AppDeps } from "../context";
import { HttpError } from "../http";
import { log } from "../logger";
import { ensureThread, postMessage } from "../messages";
import { closeNotifications, notify } from "../notifications";
import { RunnerCallError } from "../runners/hub";
import { onJobDone, startJob } from "../runners/jobs";
import { canUsePlan } from "../runners/plans";
import { type JobRow, toJob } from "../runners/runners";
import { type ToolContext, ToolInputError } from "../runtime/tools";
import { createPage, savePage } from "../wiki";
import {
  type AssignmentRow,
  agentOf,
  agentSays,
  assignmentFiles,
  assignmentOfThread,
  type CommandRow,
  isClosed,
  publishAssignment,
  runnerOfAssignment,
  runningJobsOf,
  updateAssignment,
} from "./core";
import { assignmentEvent } from "./events";
import { workIdOfJob } from "./keys";
import { planOf, touchItem, writePlan } from "./plan";
import { addJobProofs } from "./proofs";

const {
  assignments,
  assignmentWork,
  assignmentCommands,
  assignmentCommandRules,
  assignmentCommandStats,
  assignmentSubmissions,
  runnerJobs,
  knowledgePages,
} = schema;

// ---- waits (the agent's tool holds until a person decides) ----

const waiters = new Map<string, (value: string | null) => void>();

/** Waits for the decision `id` (a choice, a command). null: the run stopped first. */
export function waitFor(id: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const onAbort = () => {
      waiters.delete(id);
      resolve(null);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.set(id, (v) => {
      signal.removeEventListener("abort", onAbort);
      waiters.delete(id);
      resolve(v);
    });
  });
}

export function wake(id: string, value: string | null): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  w(value);
  return true;
}

// ---- autonomy stats ----

async function bump(deps: AppDeps, assignmentId: string, field: "auto" | "asked" | "blocked") {
  const col = assignmentCommandStats[field];
  await deps.db
    .insert(assignmentCommandStats)
    .values({ assignmentId, [field]: 1 })
    .onConflictDoUpdate({ target: assignmentCommandStats.assignmentId, set: { [field]: sql`${col} + 1` } });
}

// ---- commands: what asks a person ----

const LOW_RISK = [
  /^(ls|pwd|cat|head|tail|wc|echo|grep|rg|find|tree|stat|file|du|df|which|env|date|whoami|uname)(\s|$)/,
  /^git (status|log|diff|show|branch|remote -v|rev-parse)(\s|$)/,
  /^(npm|pnpm|yarn|bun) (test|run test|run lint|run typecheck|run check)(\s|$)/,
  /^(pytest|go test|cargo test|cargo check|tsc --noEmit|node --version|python3? --version)(\s|$)/,
];

/** Low risk: only reads or runs tests, with no redirect to a file and nothing risky chained on. */
export function isLowRisk(command: string): boolean {
  if (/[>`]|\$\(|\bsudo\b|\brm\b|\bcurl\b|\bwget\b|\bchmod\b|\bmv\b/.test(command)) return false;
  return command
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim())
    .filter(Boolean)
    .every((part) => LOW_RISK.some((re) => re.test(part)));
}

/** "Always" saves a rule: the first two words and the rest free (`npm test *`). */
export function ruleFor(command: string): string {
  const words = command.trim().split(/\s+/);
  return words.length > 2 ? `${words.slice(0, 2).join(" ")} *` : words.join(" ");
}

export function ruleMatches(rule: string, command: string): boolean {
  const c = command.trim();
  if (rule.endsWith(" *")) {
    const base = rule.slice(0, -2);
    return c === base || c.startsWith(`${base} `);
  }
  return c === rule;
}

export async function rulesOf(deps: AppDeps, assignmentId: string) {
  return deps.db
    .select()
    .from(assignmentCommandRules)
    .where(eq(assignmentCommandRules.assignmentId, assignmentId))
    .orderBy(assignmentCommandRules.createdAt);
}

export async function notifyOwner(
  deps: AppDeps,
  row: AssignmentRow,
  kind: "approval" | "assignment_finished" | "assignment_stopped",
  text: string,
  messageId: string | null,
) {
  await notify(deps, {
    workspaceId: row.workspaceId,
    userId: row.ownerId,
    kind,
    groupKey: `assignment:${row.id}:${kind}${kind === "approval" ? `:${messageId}` : ""}`,
    waiting: kind !== "assignment_stopped",
    actor: { type: "agent", id: row.agentId },
    source: {
      assignmentId: row.id,
      channelId: row.channelId,
      threadId: row.threadId,
      ...(messageId ? { messageId } : {}),
      label: row.title,
    },
    latest: { title: row.title, text: text.slice(0, 280) },
  });
}

/** A command card that waits for a person (from the agent on the server, or blocked in a job). */
export async function askCommand(
  deps: AppDeps,
  row: AssignmentRow,
  input: { command: string; tool: string; runId?: string | null; jobId?: string | null },
): Promise<CommandRow> {
  const id = newId("acmd");
  const [cmd] = await deps.db
    .insert(assignmentCommands)
    .values({
      id,
      assignmentId: row.id,
      jobId: input.jobId ?? null,
      runId: input.runId ?? null,
      command: input.command,
      tool: input.tool,
      rules: [ruleFor(input.command)],
    })
    .returning();
  if (!cmd) throw new Error("command insert failed");
  const card = await agentSays(deps, row, input.command, {
    assignmentCommand: {
      id,
      assignmentId: row.id,
      jobId: input.jobId ?? "",
      tool: input.tool,
      command: input.command,
    },
  });
  await deps.db.update(assignmentCommands).set({ messageId: card.id }).where(eq(assignmentCommands.id, id));
  await notifyOwner(deps, row, "approval", `$ ${input.command}`, card.id);
  publishAssignment(deps, row, "command");
  return { ...cmd, messageId: card.id };
}

/**
 * Before the agent runs a command in an assignment: lets it through on its own (a rule, low risk, full
 * autonomy) or asks and waits. Outside an assignment it does nothing.
 */
export async function assignmentGate(ctx: ToolContext, tool: string, command: string): Promise<void> {
  if (!ctx.threadId) return;
  const row = await assignmentOfThread(ctx.deps.db, ctx.threadId);
  if (!row || row.agentId !== ctx.agent.id) return;
  const rules = await rulesOf(ctx.deps, row.id);
  const free =
    row.commandPolicy === "never" ||
    rules.some((r) => ruleMatches(r.rule, command)) ||
    (row.commandPolicy === "when_safe" && isLowRisk(command));
  if (free) {
    await bump(ctx.deps, row.id, "auto");
    return;
  }
  await bump(ctx.deps, row.id, "asked");
  const cmd = await askCommand(ctx.deps, row, { command, tool, runId: ctx.runId });
  const decision = await waitFor(cmd.id, ctx.signal);
  if (decision === "allowed") return;
  if (decision === null) {
    await ctx.deps.db
      .update(assignmentCommands)
      .set({ state: "expired" })
      .where(and(eq(assignmentCommands.id, cmd.id), eq(assignmentCommands.state, "pending")));
    await closeNotifications(ctx.deps, row.workspaceId, `assignment:${row.id}:approval:${cmd.messageId}`);
  }
  await bump(ctx.deps, row.id, "blocked");
  throw new ToolInputError(
    decision === "denied"
      ? "A person denied this command. Try another way or ask."
      : "Nobody approved this command.",
  );
}

// ---- jobs on the runner ----

const jobPrompt = async (deps: AppDeps, row: AssignmentRow, extra: string) => {
  const files = await assignmentFiles(deps, row);
  return [
    `You are working on an assignment for the team: ${row.title}`,
    `Goal: ${row.goal}`,
    "The assignment files are in .vanr/ (assignment.md, decisions.md, notes.md). Keep notes short.",
    files.find((f) => f.name === "assignment.md")?.content ?? "",
    extra,
    "When you finish, answer with a short summary of what changed and how to check it.",
  ]
    .filter(Boolean)
    .join("\n\n");
};

/** The statuses in which the assignment can get a new job on the runner. */
const JOB_STATUSES: readonly AssignmentRow["status"][] = ["active", "wrapping_up"];

const jobQueues = new Map<string, Promise<unknown>>();

/**
 * One job operation per assignment at a time. Starting rereads the status and the slot and only then creates
 * the job; canceling waits for a start in progress and catches the job it created. Without the queue, three
 * messages at once opened three jobs in the same session, and closing in the middle of a start left a job
 * running on the closed assignment. The queue is in memory because the server is a single process (the
 * runners talk to it through the `RunnerHub`).
 */
export function withAssignmentJobs<T>(assignmentId: string, fn: () => Promise<T>): Promise<T> {
  const run = (jobQueues.get(assignmentId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  jobQueues.set(assignmentId, tail);
  void tail.then(() => {
    if (jobQueues.get(assignmentId) === tail) jobQueues.delete(assignmentId);
  });
  return run;
}

/** The assignment as it is now in the database, if it still takes a new job. */
async function openForJob(deps: AppDeps, assignmentId: string): Promise<AssignmentRow> {
  const [fresh] = await deps.db.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!fresh || !JOB_STATUSES.includes(fresh.status))
    throw new HttpError(409, "assignment.closed", "This assignment is not running");
  return fresh;
}

/** Starts (or resumes) the assignment's job on the runner. Resuming uses the last job's session. */
export interface AssignmentJobInput {
  extra: string;
  resumedJobId?: string | null;
  title?: string;
  /** Fixed id of the job (the engine): repeated, it returns the same job. */
  id?: string;
  /** Plan item; without it, the item in progress (or the next one to do). */
  planItemId?: string | null;
}

export function startAssignmentJob(
  deps: AppDeps,
  row: AssignmentRow,
  input: AssignmentJobInput,
): Promise<JobRow> {
  return withAssignmentJobs(row.id, async () =>
    startAssignmentJobNow(deps, await openForJob(deps, row.id), input),
  );
}

async function startAssignmentJobNow(
  deps: AppDeps,
  row: AssignmentRow,
  input: AssignmentJobInput,
): Promise<JobRow> {
  if (row.executor === "agent")
    throw new HttpError(409, "assignment.no_job", "This assignment runs in the conversation");
  if (input.id) {
    const [existing] = await deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, input.id));
    if (existing) return existing;
  }
  const runner = await runnerOfAssignment(deps.db, row);
  if (!runner) throw new HttpError(409, "assignment.needs_environment", "Pick a runner for this assignment");
  if (!deps.runners.isOnline(runner.id)) throw new HttpError(409, "runner.offline", "The runner is offline");
  // Claude Code and Codex use the personal plan of whoever paired the runner: only on that person's assignments.
  if (!canUsePlan(row.ownerId, runner))
    throw new HttpError(409, "assignment.personal_plan", "That runner's plan is personal to who paired it");
  if ((await runningJobsOf(deps.db, row.id)).length > 0)
    throw new HttpError(409, "assignment.job_running", "A job is already running for this assignment");
  const agent = await agentOf(deps.db, row);
  const [last] = await deps.db
    .select()
    .from(runnerJobs)
    .where(eq(runnerJobs.assignmentId, row.id))
    .orderBy(desc(runnerJobs.createdAt))
    .limit(1);
  const session = row.resumeJobs && last?.session ? last.session : undefined;
  const ref = { id: agent.id, handle: agent.handle };
  // The assignment files go to the working folder before the job (best effort).
  for (const f of await assignmentFiles(deps, row)) {
    const path = `${row.checkoutPath ? `${row.checkoutPath.replace(/\/+$/, "")}/` : ""}.vanr/${f.name}`;
    await deps.runners
      .call(
        runner.id,
        "write",
        { path, content: f.content, encoding: "utf8", append: false },
        { agent: ref, timeoutMs: 15_000 },
      )
      .catch(() => {});
  }
  const rules = (await rulesOf(deps, row.id)).map((r) => r.rule);
  try {
    const job = await startJob(deps, {
      workspaceId: row.workspaceId,
      runnerId: runner.id,
      agent: ref,
      executor: row.executor,
      title: input.title ?? row.title,
      prompt: session ? input.extra : await jobPrompt(deps, row, input.extra),
      assignmentId: row.id,
      threadId: row.threadId,
      channelId: row.channelId,
      ...(row.checkoutPath ? { cwd: row.checkoutPath } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(session ? { session } : {}),
      resumedJobId: input.resumedJobId ?? (session ? (last?.id ?? null) : null),
      allow: rules,
      ...(input.id ? { id: input.id } : {}),
      planItemId: input.planItemId !== undefined ? input.planItemId : await currentItem(deps, row.id),
    });
    await agentSays(deps, row, input.title ?? row.title, {
      job: { jobId: job.id, assignmentId: row.id },
    });
    publishAssignment(deps, row, "job");
    return job;
  } catch (err) {
    if (err instanceof RunnerCallError) throw new HttpError(409, `runner.${err.code}`, err.message);
    throw err;
  }
}

/** Cancels the assignment's jobs that still run (after a start in progress). Returns how many. */
export function cancelJobs(deps: AppDeps, row: AssignmentRow): Promise<number> {
  return withAssignmentJobs(row.id, () => cancelJobsNow(deps, row));
}

async function cancelJobsNow(deps: AppDeps, row: AssignmentRow): Promise<number> {
  const running = await runningJobsOf(deps.db, row.id);
  const agent = await agentOf(deps.db, row);
  for (const j of running) {
    await deps.runners
      .call(
        j.runnerId,
        "job.cancel",
        { jobId: j.id },
        { agent: { id: agent.id, handle: agent.handle }, timeoutMs: 15_000 },
      )
      .catch(async () => {
        // Runner offline: the job is canceled here; an end that arrives later is ignored.
        await deps.db
          .update(runnerJobs)
          .set({ status: "canceled", endedAt: deps.now() })
          .where(and(eq(runnerJobs.id, j.id), inArray(runnerJobs.status, ["queued", "running"])));
      });
  }
  return running.length;
}

/** Stops the agent's run in this thread (if there is one). */
export function stopAgentRun(deps: AppDeps, row: AssignmentRow, actorUserId: string): boolean {
  const runId = deps.runtime.activeRun(row.agentId, row.channelId, row.threadId);
  return runId ? deps.runtime.cancel(runId, actorUserId) : false;
}

// ---- submission ----

export async function createSubmission(
  deps: AppDeps,
  row: AssignmentRow,
  input: { note: string; checklist: string[]; fileIds?: string[]; auto: boolean },
) {
  // A new submission takes the place of the one still waiting.
  await deps.db
    .update(assignmentSubmissions)
    .set({ status: "superseded" })
    .where(and(eq(assignmentSubmissions.assignmentId, row.id), eq(assignmentSubmissions.status, "pending")));
  const id = newId("asub");
  const [submission] = await deps.db
    .insert(assignmentSubmissions)
    .values({
      id,
      assignmentId: row.id,
      auto: input.auto,
      note: input.note.slice(0, 20_000),
      fileIds: input.fileIds ?? [],
      checklist: input.checklist
        .slice(0, 30)
        .map((text, i) => ({ id: `c${i + 1}`, text: text.slice(0, 300), verifiedBy: null })),
    })
    .returning();
  if (!submission) throw new Error("submission insert failed");
  const card = await agentSays(deps, row, input.note.slice(0, 2000), {
    assignmentSubmission: { assignmentId: row.id, submissionId: id },
  });
  await deps.db
    .update(assignmentSubmissions)
    .set({ messageId: card.id })
    .where(eq(assignmentSubmissions.id, id));
  const next = await updateAssignment(deps, row, { status: "wrapping_up" }, "submission");
  await notifyOwner(deps, next, "assignment_finished", input.note, card.id);
  return { submission: { ...submission, messageId: card.id }, assignment: next };
}

// ---- wiki ----

export async function copyToWiki(deps: AppDeps, row: AssignmentRow, actorUserId: string): Promise<string> {
  const files = await assignmentFiles(deps, row);
  const body = files.map((f) => f.content.trim()).join("\n\n---\n\n");
  const author = { type: "person" as const, id: actorUserId };
  if (row.wikiPageId) {
    const [page] = await deps.db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.id, row.wikiPageId), isNull(knowledgePages.deletedAt)));
    if (page) {
      await savePage(deps, { row: page, author, canBypassLock: false, body, note: "assignment" });
      return page.id;
    }
  }
  const page = await createPage(deps, {
    workspaceId: row.workspaceId,
    title: `Assignment: ${row.title}`.slice(0, 200),
    folder: "assignments",
    body,
    tags: ["assignment"],
    author,
    note: "assignment",
  });
  await deps.db.update(assignments).set({ wikiPageId: page.id }).where(eq(assignments.id, row.id));
  return page.id;
}

// ---- end of the jobs ----

/** The assignment's item in progress, or the next to do (a job with no item chosen goes to it). */
export async function currentItem(deps: AppDeps, assignmentId: string): Promise<string | null> {
  const items = (await planOf(deps, assignmentId)).filter(
    (i) => i.status !== "dropped" && i.status !== "done",
  );
  return (items.find((i) => i.status === "doing") ?? items[0])?.id ?? null;
}

/** The item the agent was working on in the run (the turn the engine sent). */
async function itemOfRun(deps: AppDeps, runId: string): Promise<string | null> {
  const [w] = await deps.db
    .select({ itemId: assignmentWork.itemId })
    .from(assignmentWork)
    .where(eq(assignmentWork.refId, runId));
  return w?.itemId || null;
}

const endQueues = new Map<string, Promise<void>>();

/**
 * The end of one of the assignment's jobs. It can run more than once for the same job (the listener, the
 * runner's reconnection and, after a crash in the middle, the engine's `reap`), so:
 * - one at a time per job (an in-memory queue: the server is a single process) and nothing after
 *   `settledAt`, which is the "processed" mark;
 * - what must not be lost (proofs, cost in the ledger, the item done, the cards of blocked commands) is
 *   idempotent and runs before the mark, so the pass after a crash redoes what was missing;
 * - the `job_done` event (a fixed key) only decides the notices (finding, failure message, notification): a
 *   crash after it loses the notice, never the data.
 * With the runner as executor, a job that ended well marks the item done (the verifier is the one who
 * approves it). The usage goes to the ledger on the plan of whoever paired the runner (tokens, USD 0).
 */
export function jobEnded(deps: AppDeps, job: JobRow): Promise<void> {
  if (!job.assignmentId) return Promise.resolve();
  const run = (endQueues.get(job.id) ?? Promise.resolve()).then(() => processJobEnd(deps, job.id));
  const tail = run.catch(() => {});
  endQueues.set(job.id, tail);
  void tail.then(() => {
    if (endQueues.get(job.id) === tail) endQueues.delete(job.id);
  });
  return run;
}

async function processJobEnd(deps: AppDeps, jobId: string): Promise<void> {
  const [job] = await deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, jobId));
  if (!job?.assignmentId || job.settledAt) return;
  const [row] = await deps.db.select().from(assignments).where(eq(assignments.id, job.assignmentId));
  if (!row) return;
  const result = (job.result ?? job.tailLine ?? "").trim();
  const denied = job.denied;
  const at = deps.now();
  const agent = { type: "agent" as const, id: job.agentId };

  // Data that must not be lost, idempotent.
  await addJobProofs(deps, row.id, {
    id: job.id,
    itemId: job.planItemId,
    files: job.files,
    diff: job.diff,
    agentId: job.agentId,
  });
  if (job.usage && !job.costRecordedAt) {
    // Record and then mark: a crash between the two counts the cost twice, never zero (the cap errs on the
    // safe side).
    await deps.ledger.record(
      {
        workspaceId: row.workspaceId,
        agentId: job.agentId,
        userId: row.ownerId,
        runId: null,
        channelId: row.channelId,
        assignmentId: row.id,
        source: "assignment",
        model: job.usage.model ?? job.executor,
        usage: {
          inputTokens: job.usage.inputTokens,
          cachedTokens: job.usage.cachedTokens,
          cacheWriteTokens: job.usage.cacheWriteTokens,
          outputTokens: job.usage.outputTokens,
        },
        keySource: "plan",
        at: job.endedAt ?? at,
      },
      [],
    );
    await deps.db.update(runnerJobs).set({ costRecordedAt: at }).where(eq(runnerJobs.id, job.id));
  }
  const open = !isClosed(row);
  if (open && denied.length) {
    // Commands the permission check blocked become cards (one per command: the second pass doesn't duplicate).
    const asked = new Set(
      (
        await deps.db
          .select({ command: assignmentCommands.command })
          .from(assignmentCommands)
          .where(and(eq(assignmentCommands.assignmentId, row.id), eq(assignmentCommands.jobId, job.id)))
      ).map((c) => c.command),
    );
    for (const command of denied)
      if (!asked.has(command)) await askCommand(deps, row, { command, tool: "Bash", jobId: job.id });
  }
  if (open && row.executor !== "agent" && job.planItemId) {
    // The runner as executor: ended well and with no blocked command, the item is done; otherwise it goes back.
    const done = job.status === "done" && denied.length === 0;
    await touchItem(deps, row.id, job.planItemId, {
      status: done ? "done" : "todo",
      ...(done ? { summary: result.slice(0, 8000) || null, doneAt: at } : {}),
      updatedBy: agent,
    });
    if (done)
      await assignmentEvent(deps, row, {
        kind: "item_done",
        actor: agent,
        itemId: job.planItemId,
        key: `${row.id}:done:${job.planItemId}:${job.id}`,
        data: { jobId: job.id },
      });
    publishAssignment(deps, row, "plan");
  }
  deps.hub.toChannel(row.channelId, { type: "job.updated", job: toJob(job) });

  // Notices: only once, by the event's key.
  const first = await assignmentEvent(deps, row, {
    kind: "job_done",
    actor: agent,
    itemId: job.planItemId,
    key: `${row.id}:job:${job.id}`,
    data: {
      jobId: job.id,
      title: job.title,
      status: job.status,
      exitCode: job.exitCode,
      files: job.files.slice(0, 50),
      prUrl: job.prUrl,
      usage: job.usage,
      denied: denied.length,
      result: result.slice(0, 500),
    },
  });
  if (first && open) {
    let next = row;
    if (result)
      next = await updateAssignment(
        deps,
        row,
        {
          findings: [
            ...row.findings,
            {
              text: result.slice(0, 2000),
              at: at.toISOString(),
              ...(job.prUrl ? { prUrl: job.prUrl } : {}),
            },
          ].slice(-100),
        },
        "job",
      );
    if (job.status === "failed" || job.status === "interrupted") {
      next = (await deps.db.select().from(assignments).where(eq(assignments.id, row.id)))[0] ?? next;
      await agentSays(
        deps,
        next,
        `${job.title}: ${job.status}${result ? `\n\n${result.slice(0, 1500)}` : ""}`,
        {
          assignmentReport: { assignmentId: next.id, text: `${job.status}: ${result.slice(0, 500)}` },
        },
      );
      await notifyOwner(deps, next, "assignment_stopped", `${job.title}: ${job.status}`, null);
    }
  }
  await settleJob(deps, job);
}

/**
 * Closes the job's work and marks the end as processed. Only after that does the engine decide the next step:
 * before, it would see the job ended without the blocked command's card and open another.
 */
export async function settleJob(deps: AppDeps, job: JobRow): Promise<void> {
  const workId = workIdOfJob(job.id);
  await deps.db
    .update(assignmentWork)
    .set({
      status: "ended",
      outcome:
        job.status === "done"
          ? "done"
          : job.status === "canceled"
            ? "canceled"
            : job.status === "interrupted"
              ? "interrupted"
              : "failed",
      endedAt: deps.now(),
    })
    .where(
      and(
        workId
          ? or(eq(assignmentWork.refId, job.id), eq(assignmentWork.id, workId))
          : eq(assignmentWork.refId, job.id),
        ne(assignmentWork.status, "ended"),
      ),
    );
  await deps.db
    .update(runnerJobs)
    .set({ settledAt: deps.now() })
    .where(and(eq(runnerJobs.id, job.id), isNull(runnerJobs.settledAt)));
  if (job.assignmentId) deps.assignmentEngine.wake(job.assignmentId);
}

onJobDone((deps, job) =>
  jobEnded(deps, job).catch((err) => {
    log.error("assignment.job_done_failed", { err, jobId: job.id });
  }),
);

// ---- create ----

export interface NewAssignment {
  workspaceId: string;
  agentId: string;
  agentHandle: string;
  channelId: string;
  ownerId: string;
  title: string;
  goal: string;
  executor: "agent" | "claude_code" | "codex";
  runnerId: string | null;
  commandPolicy: "always" | "when_safe" | "never";
  /** A message that already exists and becomes the thread's root; without it, the plan card is the root. */
  threadId?: string | null;
  plan?: string[];
}

/** Creates the proposed assignment with the plan card (the thread's root, or inside the given thread). */
export async function createAssignment(deps: AppDeps, input: NewAssignment): Promise<AssignmentRow> {
  const id = newId("asg");
  const channel = await channelOf(deps, input.workspaceId, input.channelId);
  const runnerName = input.runnerId
    ? ((
        await deps.db
          .select({ name: schema.runners.name })
          .from(schema.runners)
          .where(eq(schema.runners.id, input.runnerId))
      )[0]?.name ?? null)
    : null;
  const { message } = await postMessage(deps, {
    workspaceId: input.workspaceId,
    channel,
    author: { type: "agent", id: input.agentId },
    body: input.title,
    clientId: `assignment:${id}`,
    threadId: input.threadId ?? null,
    meta: {
      assignmentPlan: {
        assignmentId: id,
        title: input.title,
        goal: input.goal,
        environment: runnerName,
        executor: input.executor,
      },
    },
  });
  const [row] = await deps.db
    .insert(assignments)
    .values({
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      goal: input.goal,
      agentId: input.agentId,
      channelId: input.channelId,
      threadId: input.threadId ?? message.id,
      executor: input.executor,
      runnerId: input.runnerId,
      ownerId: input.ownerId,
      commandPolicy: input.commandPolicy,
    })
    .returning();
  if (!row) throw new Error("assignment insert failed");
  if (input.plan?.length) {
    const w = await writePlan(deps, id, {
      author: { type: "agent", id: input.agentId },
      mode: "agent",
      items: input.plan.slice(0, 30).map((title, i) => ({ id: `p${i + 1}`, title })),
    });
    await assignmentEvent(deps, row, {
      kind: "plan_edited",
      actor: { type: "agent", id: input.agentId },
      data: { version: w.version, added: w.added, removed: [], edited: [] },
    });
  }
  // The thread exists from the proposal on (the assignments tab), with the assignment's title.
  const [root] = await deps.db.select().from(schema.messages).where(eq(schema.messages.id, row.threadId));
  if (root)
    await ensureThread(deps.db, {
      root,
      by: { type: "agent", id: input.agentId },
      at: deps.now(),
      title: input.title,
    });
  publishAssignment(deps, row, "created");
  return row;
}

async function channelOf(deps: AppDeps, workspaceId: string, channelId: string) {
  const channel = await channelInWorkspace(deps.db, workspaceId, channelId);
  if (!channel) throw new HttpError(404, "not_found", "Channel not found");
  return channel;
}

/**
 * A job the agent itself starts (start_job). It doesn't wait: the turn ends, the engine waits for the job (it
 * survives a server crash) and the next turn brings the result.
 */
export async function runAgentJob(
  ctx: ToolContext,
  row: AssignmentRow,
  input: { title: string; prompt: string; branch?: string },
): Promise<string> {
  const runner = await runnerOfAssignment(ctx.deps.db, row);
  if (!runner) throw new ToolInputError("This assignment has no runner. Ask the owner to pick one.");
  if (!ctx.deps.runners.isOnline(runner.id)) throw new ToolInputError("The runner is offline.");
  // Claude Code and Codex use the personal plan of whoever paired the runner: only on that person's assignments.
  if (!canUsePlan(row.ownerId, runner))
    throw new ToolInputError(
      "That runner's plan is personal to who paired it; only their assignments can use it.",
    );
  const available = runner.executors.filter((e) =>
    e === "claude_code" ? runner.access.tools.claude : runner.access.tools.codex,
  );
  const executor = row.executor !== "agent" && available.includes(row.executor) ? row.executor : available[0];
  if (!executor) throw new ToolInputError("There is no Claude Code or Codex on this runner.");
  const rules = (await rulesOf(ctx.deps, row.id)).map((r) => r.rule);
  const prompt = input.branch ? `${input.prompt}\n\nWork on the git branch ${input.branch}.` : input.prompt;
  let job: JobRow;
  try {
    job = await withAssignmentJobs(row.id, async () => {
      await openForJob(ctx.deps, row.id);
      if ((await runningJobsOf(ctx.deps.db, row.id)).length > 0)
        throw new HttpError(409, "assignment.job_running", "A job is already running for this assignment");
      return startJob(ctx.deps, {
        workspaceId: row.workspaceId,
        runnerId: runner.id,
        agent: { id: ctx.agent.id, handle: ctx.agent.handle },
        executor,
        title: input.title,
        prompt,
        assignmentId: row.id,
        threadId: row.threadId,
        channelId: row.channelId,
        ...(row.checkoutPath ? { cwd: row.checkoutPath } : {}),
        allow: rules,
        planItemId: (await itemOfRun(ctx.deps, ctx.runId)) ?? (await currentItem(ctx.deps, row.id)),
      });
    });
  } catch (err) {
    if (err instanceof RunnerCallError) throw new ToolInputError(`${err.code}: ${err.message}`);
    if (err instanceof HttpError) throw new ToolInputError(err.message);
    throw err;
  }
  await ctx.postCard(input.title, { job: { jobId: job.id, assignmentId: row.id } });
  publishAssignment(ctx.deps, row, "job");
  return `Started job ${job.id} on the runner. End the turn now: the assignment continues when it finishes, with its result.`;
}
