// Jobs on the runners, on the server's side: start one (sends `job.start`), take its events and its end,
// keep the last lines (to show the output with the runner offline) and tell the thread.

import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { AgentRef, JobSnapshot } from "@vanr/engine/runner-protocol";
import { and, eq } from "drizzle-orm";
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
  if (input.id) {
    const [existing] = await deps.db.select().from(runnerJobs).where(eq(runnerJobs.id, input.id));
    if (existing) return existing;
  }
  const [row] = await deps.db
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
    .returning();
  if (!row) throw new Error("job insert failed");
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
      .where(eq(runnerJobs.id, id))
      .returning();
    if (failed) emitJob(deps, failed);
    throw err;
  }
}

async function jobOf(db: Db, runnerId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(runnerJobs)
    .where(and(eq(runnerJobs.id, jobId), eq(runnerJobs.runnerId, runnerId)));
  return row ?? null;
}

export async function applyJobEvent(
  deps: AppDeps,
  runnerId: string,
  ev: { jobId: string; kind: "line" | "progress" | "files"; line?: string; files?: string[] },
) {
  const row = await jobOf(deps.db, runnerId, ev.jobId);
  if (!row) return;
  const tail = ev.kind === "line" && ev.line ? [...row.outputTail, ev.line].slice(-TAIL_MAX) : row.outputTail;
  const [updated] = await deps.db
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
  if (updated) emitJob(deps, updated);
}

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** A job's end (or its state in the `hello`). Idempotent: the same end twice changes nothing. */
export async function finishJob(deps: AppDeps, runnerId: string, snap: JobSnapshot) {
  const row = await jobOf(deps.db, runnerId, snap.jobId);
  if (!row) return;
  if (snap.status === "running" || snap.status === "queued") {
    if (row.status === "queued") {
      const [updated] = await deps.db
        .update(runnerJobs)
        .set({ status: "running", startedAt: snap.startedAt ? new Date(snap.startedAt) : deps.now() })
        .where(eq(runnerJobs.id, row.id))
        .returning();
      if (updated) emitJob(deps, updated);
    }
    return;
  }
  if (row.status !== "running" && row.status !== "queued") return;
  const pr = snap.result ? PR_RE.exec(snap.result)?.[0] : undefined;
  const [updated] = await deps.db
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
    .where(and(eq(runnerJobs.id, row.id), eq(runnerJobs.status, row.status)))
    .returning();
  if (!updated) return;
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
