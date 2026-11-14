// Jobs on the runners, on the server's side: start one (sends `job.start`), take its events and its end,
// keep the last lines (to show the output with the runner offline) and tell the thread.

import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { AgentRef, JobSnapshot } from "@vanr/engine/runner-protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "../context";
import { log } from "../logger";
import { networkPolicyFor, recordBlocked } from "./network";
import { type JobRow, toJob } from "./runners";

const { runnerJobs } = schema;
const TAIL_MAX = 200;

export type JobDoneListener = (deps: AppDeps, job: JobRow, snap: JobSnapshot) => Promise<void>;
const doneListeners: JobDoneListener[] = [];

/** Who wants to know when a job ends (the assignments). */
export function onJobDone(listener: JobDoneListener) {
  doneListeners.push(listener);
}

export function emitJob(deps: AppDeps, row: JobRow) {
  if (row.channelId) deps.hub.toChannel(row.channelId, { type: "job.updated", job: toJob(row) });
}

export async function startJob(
  deps: AppDeps,
  input: {
    workspaceId: string;
    runnerId: string;
    agent: AgentRef;
    executor: "claude_code" | "codex" | "shell";
    title: string;
    prompt: string;
    assignmentId?: string | null;
    threadId?: string | null;
    channelId?: string | null;
    cwd?: string;
    model?: string;
    session?: string;
    resumedJobId?: string | null;
    allow?: string[];
    /** A fixed id (the assignment engine): if it already exists, returns the job without sending it to the runner again. */
    id?: string;
    /** The assignment's plan item the job works on. */
    planItemId?: string | null;
  },
): Promise<JobRow> {
  const id = input.id ?? newId("job");
  // A fixed id that already exists (or that another start is inserting now) is that job, sent once.
  const existing = async () => {
    const [found] = await deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, id));
    return found;
  };
  if (input.id) {
    const found = await existing();
    if (found) return found;
  }
  const [inserted] = await deps.db
    .insert(runnerJobs)
    .values({
      id,
      workspaceId: input.workspaceId,
      runnerId: input.runnerId,
      agentId: input.agent.id,
      assignmentId: input.assignmentId ?? null,
      threadId: input.threadId ?? null,
      channelId: input.channelId ?? null,
      title: input.title.slice(0, 200),
      executor: input.executor,
      prompt: input.prompt,
      status: "queued",
      resumedJobId: input.resumedJobId ?? null,
      planItemId: input.planItemId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const found = await existing();
    if (found) return found;
    throw new Error("job insert failed");
  }
  const row = inserted;
  emitJob(deps, row);
  try {
    const network = await networkPolicyFor(deps, input.workspaceId, input.agent.id);
    const started = await deps.runners.call<"job.start", { startedAt: string }>(
      input.runnerId,
      "job.start",
      {
        jobId: id,
        executor: input.executor,
        title: row.title,
        prompt: input.prompt,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.session ? { session: input.session } : {}),
        ...(input.allow?.length ? { allow: input.allow } : {}),
        network,
      },
      { agent: input.agent, timeoutMs: 30_000 },
    );
    const [updated] = await deps.db
      .update(runnerJobs)
      .set({ status: "running", startedAt: new Date(started.startedAt), lastSignalAt: deps.now() })
      .where(and(eq(runnerJobs.id, id), eq(runnerJobs.status, "queued")))
      .returning();
    const out = updated ?? row;
    emitJob(deps, out);
    return out;
  } catch (err) {
    const [failed] = await deps.db
      .update(runnerJobs)
      .set({
        status: "failed",
        endedAt: deps.now(),
        tailLine: err instanceof Error ? err.message.slice(0, 500) : "failed",
      })
      // Only a job that didn't end meanwhile (its end may have arrived before the start's answer).
      .where(and(eq(runnerJobs.id, id), inArray(runnerJobs.status, ["queued", "running"])))
      .returning();
    if (failed) emitJob(deps, failed);
    throw err;
  }
}

/** A job is in a terminal state: nothing the runner sends about it changes it again. */
const TERMINAL: ReadonlySet<JobRow["status"]> = new Set(["done", "failed", "canceled", "interrupted"]);

/**
 * Runs `change` on the job of this runner under the row's lock (`FOR UPDATE`), so an event and the job's end (or
 * two events) that arrive at once apply one after the other on the row as it is now. Null when the job isn't
 * this runner's.
 */
function withJob<T>(
  deps: AppDeps,
  runnerId: string,
  jobId: string,
  change: (tx: Db, row: JobRow) => Promise<T>,
): Promise<T | null> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.id, jobId), eq(runnerJobs.runnerId, runnerId)))
      .for("update");
    return row ? change(tx, row) : null;
  });
}

/**
 * A line, progress or files of a job. It changes only a job that isn't in a terminal state (a late event after
 * the end changes nothing), and the line goes onto the tail as the row is now, so two lines at once both stay.
 */
export async function applyJobEvent(
  deps: AppDeps,
  runnerId: string,
  ev: { jobId: string; kind: "line" | "progress" | "files"; line?: string; files?: string[] },
) {
  const updated = await withJob(deps, runnerId, ev.jobId, async (tx, row) => {
    if (TERMINAL.has(row.status)) return null;
    const tail =
      ev.kind === "line" && ev.line ? [...row.outputTail, ev.line].slice(-TAIL_MAX) : row.outputTail;
    const [out] = await tx
      .update(runnerJobs)
      .set({
        ...(ev.line ? { tailLine: ev.line.slice(0, 1000) } : {}),
        ...(ev.files ? { files: ev.files.slice(0, 200) } : {}),
        outputTail: tail,
        lastSignalAt: deps.now(),
        ...(row.status === "queued" ? { status: "running" as const, startedAt: deps.now() } : {}),
      })
      .where(eq(runnerJobs.id, row.id))
      .returning();
    return out ?? null;
  });
  if (updated) emitJob(deps, updated);
}

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * A job's end (or its state in the `hello`), under the row's lock. Idempotent: the same end twice changes
 * nothing, and a terminal state is final.
 */
export async function finishJob(deps: AppDeps, runnerId: string, snap: JobSnapshot) {
  const changed = await withJob(deps, runnerId, snap.jobId, async (tx, row) => {
    if (snap.status === "running" || snap.status === "queued") {
      if (row.status !== "queued") return null;
      const [out] = await tx
        .update(runnerJobs)
        .set({ status: "running", startedAt: snap.startedAt ? new Date(snap.startedAt) : deps.now() })
        .where(eq(runnerJobs.id, row.id))
        .returning();
      return out ? { row: out, ended: false } : null;
    }
    if (TERMINAL.has(row.status)) return null;
    const pr = snap.result ? PR_RE.exec(snap.result)?.[0] : undefined;
    const [out] = await tx
      .update(runnerJobs)
      .set({
        status: snap.status,
        exitCode: snap.exitCode,
        result: snap.result,
        session: snap.session,
        files: snap.files.slice(0, 200),
        ...(snap.usage ? { usage: snap.usage } : {}),
        denied: snap.denied.slice(0, 50),
        ...(snap.diff ? { diff: snap.diff } : {}),
        endedAt: snap.endedAt ? new Date(snap.endedAt) : deps.now(),
        lastSignalAt: deps.now(),
        ...(pr ? { prUrl: pr } : {}),
      })
      .where(eq(runnerJobs.id, row.id))
      .returning();
    return out ? { row: out, ended: true } : null;
  });
  if (!changed) return;
  const updated = changed.row;
  if (!changed.ended) {
    emitJob(deps, updated);
    return;
  }
  emitJob(deps, updated);
  // Hosts the proxy blocked become domain requests on the agent's list (the job has no card).
  if (snap.blocked.length)
    await recordBlocked(deps, {
      workspaceId: updated.workspaceId,
      agentId: updated.agentId,
      hosts: snap.blocked,
      context: updated.title,
      channelId: updated.channelId,
      threadId: updated.threadId,
    }).catch((err) => log.error("job.blocked_failed", { err, jobId: updated.id }));
  for (const l of doneListeners) {
    try {
      await l(deps, updated, snap);
    } catch (err) {
      // a listener that fails doesn't stop the others
      log.error("job.listener_failed", { err, jobId: updated.id });
    }
  }
}
