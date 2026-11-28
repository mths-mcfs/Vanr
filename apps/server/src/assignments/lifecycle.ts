// What the assignment routes share: closing (done or canceled), answering a submission with changes, telling the
// executor what a person wants, and the views of the harness, the settings and the people. A transition that
// reads the assignment's state and writes it (closing, asking for changes) runs in one transaction with the
// assignment's row locked, so two people at once (or a double click) end in one outcome.
import type {
  AssignmentExecutor,
  AssignmentHarness,
  AssignmentJoinRequest,
  AssignmentParticipants,
  AssignmentSettings,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { MODELS } from "@vanr/engine/models/catalog";
import { and, eq, inArray } from "drizzle-orm";
import type { AgentRow } from "../agents";
import type { AppDeps, WorkspaceMember } from "../context";
import { badRequest, conflict, HttpError } from "../http";
import { log } from "../logger";
import { closeNotificationGroups, closeNotifications } from "../notifications";
import { canUsePlan, EXECUTOR_MODELS, executorModelOk, executorProblem } from "../runners/plans";
import type { RunnerRow } from "../runners/runners";
import {
  type AssignmentRow,
  agentOf,
  isClosed,
  managesAssignment,
  nameMap,
  personSays,
  publishAssignment,
  runnerOfAssignment,
  runningJobsOf,
} from "./core";
import {
  cancelJobs,
  copyToWiki,
  rulesOf,
  startAssignmentJob,
  stopAgentRun,
  withAssignmentJobs,
} from "./engine";
import { assignmentEvent } from "./events";
import { writePlan } from "./plan";

const {
  assignments,
  assignmentParticipants,
  assignmentJoinRequests,
  assignmentCommands,
  assignmentCommandStats,
  assignmentSubmissions,
} = schema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const person = (me: { userId: string }) => ({ type: "person" as const, id: me.userId });

export const closedError = () => new HttpError(409, "assignment.closed", "This assignment is closed");
const submissionClosed = () =>
  conflict("assignment.submission_closed", "This submission was already answered");

/** The assignment's row, locked until the transaction ends: whoever moves it next waits for this one. */
async function lockAssignment(tx: Tx, id: string): Promise<AssignmentRow> {
  const [row] = await tx.select().from(assignments).where(eq(assignments.id, id)).for("update");
  if (!row || isClosed(row)) throw closedError();
  return row;
}

/** Who edits the agent's defaults: who manages agents or the agent's owner. */
export const editsAgent = (me: WorkspaceMember, agent: AgentRow) =>
  can(me.role, "manage_agents") || agent.ownerUserId === me.userId;

export function requireManager(me: WorkspaceMember, row: AssignmentRow) {
  if (!managesAssignment(me, row))
    throw new HttpError(403, "assignment.forbidden", "Only the owner can change this assignment");
}

/**
 * The executor runs on the runner, the tool is on, the CLI is logged in to a plan and the person (the
 * assignment's owner) may use that plan: who paired it.
 */
export function executorAvailable(
  runner: RunnerRow | null,
  executor: "claude_code" | "codex",
  userId: string,
): runner is RunnerRow {
  return !!runner && executorProblem(runner, executor) === null && canUsePlan(userId, runner);
}

const EXECUTOR_LABEL = { claude_code: "Claude Code", codex: "Codex" } as const;

/** 409 when the executor can't run this assignment on that runner, with the reason. */
export function requireExecutor(runner: RunnerRow | null, executor: "claude_code" | "codex", userId: string) {
  if (!runner) throw conflict("assignment.needs_environment", "Pick a runner for this assignment");
  if (!executorAvailable(runner, executor, userId))
    throw conflict(
      "assignment.executor_unavailable",
      `${EXECUTOR_LABEL[executor]} is not available on that runner`,
      {
        reason: executorProblem(runner, executor) ?? "personal_plan",
      },
    );
}

/** The assignment's runner is ready for a job (what starting asks for). */
export async function environmentReady(deps: AppDeps, row: AssignmentRow) {
  const runner = await runnerOfAssignment(deps.db, row);
  if (!runner) throw conflict("assignment.needs_environment", "Pick a runner for this assignment");
  if (!deps.runners.isOnline(runner.id)) throw conflict("runner.offline", "The runner is offline");
  if (!canUsePlan(row.ownerId, runner))
    throw conflict("assignment.personal_plan", "That runner's plan is personal to who paired it");
  // The runner may have changed since the executor was chosen: it still has to run it.
  if (row.executor !== "agent") requireExecutor(runner, row.executor, row.ownerId);
}

const queues = new Map<string, Promise<unknown>>();

/**
 * One at a time per key, in this process (the server is a single process, as the job queue in engine.ts
 * assumes): creating an assignment on an existing thread checks the thread and writes the card in order.
 */
export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/**
 * The owner's settings on the locked row: a limit left out keeps the value it has now (two managers changing
 * different limits at once both stay).
 */
export async function patchAssignment(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  input: {
    resumeJobs?: boolean;
    limits?: { dollars?: number | null; minutes?: number | null; steps?: number | null };
    dueAt?: string | null;
    commandPolicy?: AssignmentRow["commandPolicy"];
  },
): Promise<AssignmentRow> {
  const next = await deps.db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(assignments).where(eq(assignments.id, row.id)).for("update");
    if (!fresh) throw closedError();
    // Who manages is decided on the locked row: a hand-over committed meanwhile counts.
    requireManager(me, fresh);
    const given = input.limits;
    const pick = (v: number | null | undefined, was: number | null) => (v !== undefined ? v : was);
    const limits = given
      ? {
          dollars: pick(given.dollars, fresh.limits.dollars),
          minutes: pick(given.minutes, fresh.limits.minutes),
          steps: pick(
            given.steps === undefined || given.steps === null ? given.steps : Math.floor(given.steps),
            fresh.limits.steps,
          ),
        }
      : undefined;
    const [moved] = await tx
      .update(assignments)
      .set({
        ...(input.resumeJobs !== undefined ? { resumeJobs: input.resumeJobs } : {}),
        ...(input.commandPolicy !== undefined ? { commandPolicy: input.commandPolicy } : {}),
        ...(limits ? { limits } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
        updatedAt: deps.now(),
      })
      .where(eq(assignments.id, row.id))
      .returning();
    return moved ?? fresh;
  });
  publishAssignment(deps, next, "settings");
  return next;
}

export async function participantsOf(deps: AppDeps, row: AssignmentRow): Promise<AssignmentParticipants> {
  const list = await deps.db
    .select()
    .from(assignmentParticipants)
    .where(eq(assignmentParticipants.assignmentId, row.id))
    .orderBy(assignmentParticipants.createdAt);
  const names = await nameMap(deps.db, [row.ownerId, ...list.map((p) => p.userId)]);
  return {
    owner: { userId: row.ownerId, name: names.get(row.ownerId) ?? "" },
    participants: list.map((p) => ({ userId: p.userId, name: names.get(p.userId) ?? "", role: p.role })),
  };
}

export async function joinRequestsOf(deps: AppDeps, assignmentId: string): Promise<AssignmentJoinRequest[]> {
  const rows = await deps.db
    .select()
    .from(assignmentJoinRequests)
    .where(eq(assignmentJoinRequests.assignmentId, assignmentId))
    .orderBy(assignmentJoinRequests.createdAt);
  const names = await nameMap(
    deps.db,
    rows.map((r) => r.userId),
  );
  return rows.map((r) => ({
    userId: r.userId,
    name: names.get(r.userId) ?? "",
    role: r.role,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function harnessOf(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
): Promise<AssignmentHarness> {
  const agent = await agentOf(deps.db, row);
  const runner = await runnerOfAssignment(deps.db, row);
  const options: AssignmentHarness["options"] = [
    {
      kind: "agent",
      models: MODELS.map((m) => ({
        value: m.id,
        label: m.label,
        ...(m.recommended ? { recommended: true } : {}),
      })),
    },
  ];
  for (const kind of ["claude_code", "codex"] as const)
    if (executorAvailable(runner, kind, row.ownerId)) options.push({ kind, models: EXECUTOR_MODELS[kind] });
  return {
    options,
    effectiveHarness: row.executor,
    resolvedModel: row.model ?? (row.executor === "agent" ? agent.model : ""),
    modelAdjustable: managesAssignment(me, row),
  };
}

const jobRunning = () => conflict("assignment.job_running", "Wait for the running job or stop it first");

/** Whether the assignment has a job queued or running, read in `tx`. */
async function hasRunningJob(tx: Tx, assignmentId: string) {
  const [running] = await tx
    .select({ id: schema.runnerJobs.id })
    .from(schema.runnerJobs)
    .where(
      and(
        eq(schema.runnerJobs.assignmentId, assignmentId),
        inArray(schema.runnerJobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return !!running;
}

/**
 * The assignment's row locked for a settings change that was decided on `row`: who manages is checked again,
 * and the fields the decision stood on must not have moved (otherwise `assignment.changed`).
 */
async function lockForSettings(
  tx: Tx,
  me: WorkspaceMember,
  row: AssignmentRow,
  same: readonly ("executor" | "runnerId" | "ownerId")[],
) {
  const [fresh] = await tx.select().from(assignments).where(eq(assignments.id, row.id)).for("update");
  if (!fresh) throw closedError();
  requireManager(me, fresh);
  if (same.some((k) => fresh[k] !== row[k]))
    throw conflict("assignment.changed", "This assignment changed meanwhile; open it again");
  if (await hasRunningJob(tx, row.id)) throw jobRunning();
  return fresh;
}

/**
 * Changes the executor (and the model). An executor on the runner needs the runner with it. In the
 * assignment's job queue and on its locked row, so no job starts on the old executor meanwhile.
 */
export async function setHarness(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  harness: AssignmentExecutor,
  model?: string,
) {
  if (harness !== "agent") requireExecutor(await runnerOfAssignment(deps.db, row), harness, row.ownerId);
  if (model) {
    const ok = harness === "agent" ? MODELS.some((m) => m.id === model) : executorModelOk(harness, model);
    if (!ok) throw badRequest("Unknown model for this harness", { field: "model" });
  }
  const next = await withAssignmentJobs(row.id, () =>
    setHarnessOnLockedRow(deps, me, row, { harness, model }),
  );
  publishAssignment(deps, next, "settings");
  return next;
}

/** The executor's write, on the locked row: the runner and the owner it was checked against still hold. */
export function setHarnessOnLockedRow(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  input: { harness: AssignmentExecutor; model?: string },
): Promise<AssignmentRow> {
  return deps.db.transaction(async (tx) => {
    await lockForSettings(tx, me, row, ["runnerId", "ownerId"]);
    const [moved] = await tx
      .update(assignments)
      .set({ executor: input.harness, model: input.model || null, updatedAt: deps.now() })
      .where(eq(assignments.id, row.id))
      .returning();
    if (!moved) throw closedError();
    return moved;
  });
}

/**
 * Picks the assignment's runner (and its folder: "" clears it, absent keeps it). The executor must run there.
 * In the job queue and on the locked row: a job start in progress lands first and is seen, or reads the new one.
 */
export async function setRunner(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  runner: RunnerRow,
  checkoutPath?: string,
) {
  if (row.executor !== "agent") requireExecutor(runner, row.executor, row.ownerId);
  const next = await withAssignmentJobs(row.id, () =>
    setRunnerOnLockedRow(deps, me, row, { runnerId: runner.id, checkoutPath }),
  );
  publishAssignment(deps, next, "settings");
  return next;
}

/** The runner's write, on the locked row: the executor and the owner it was checked against still hold. */
export function setRunnerOnLockedRow(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  input: { runnerId: string; checkoutPath?: string },
): Promise<AssignmentRow> {
  return deps.db.transaction(async (tx) => {
    await lockForSettings(tx, me, row, ["executor", "ownerId"]);
    const [moved] = await tx
      .update(assignments)
      .set({
        runnerId: input.runnerId,
        ...(input.checkoutPath !== undefined ? { checkoutPath: input.checkoutPath || null } : {}),
        updatedAt: deps.now(),
      })
      .where(eq(assignments.id, row.id))
      .returning();
    if (!moved) throw closedError();
    return moved;
  });
}

export async function settingsOf(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
): Promise<AssignmentSettings> {
  const rules = await rulesOf(deps, row.id);
  const names = await nameMap(
    deps.db,
    rules.map((r) => r.by),
  );
  const [stats] = await deps.db
    .select()
    .from(assignmentCommandStats)
    .where(eq(assignmentCommandStats.assignmentId, row.id));
  const agent = await agentOf(deps.db, row);
  return {
    rules: rules.map((r) => ({
      id: r.id,
      rule: r.rule,
      by: names.get(r.by) ?? "",
      createdAt: r.createdAt.toISOString(),
    })),
    stats: { auto: stats?.auto ?? 0, asked: stats?.asked ?? 0, blocked: stats?.blocked ?? 0 },
    agentBaseline: { commandPolicy: agent.assignmentCommandPolicy, adjustable: editsAgent(me, agent) },
  };
}

/** Tells the executor what the person wants: the agent through the thread; Claude Code/Codex in a resumed job. */
export async function tell(
  deps: AppDeps,
  row: AssignmentRow,
  userId: string,
  text: string,
): Promise<{ delivered: boolean; jobId?: string }> {
  if (row.executor === "agent") {
    await personSays(deps, row, userId, text);
    return { delivered: true };
  }
  if ((await runningJobsOf(deps.db, row.id)).length > 0) return { delivered: false };
  try {
    const job = await startAssignmentJob(deps, row, { extra: text });
    return { delivered: true, jobId: job.id };
  } catch (err) {
    // Another message opened the job meanwhile: this one waits, as if the job were already running.
    if (err instanceof HttpError && err.code === "assignment.job_running") return { delivered: false };
    throw err;
  }
}

/**
 * `tell` after a person's answer that already counts. Whether to tell comes from the assignment as it is after the
 * answer (`when`), not from a read taken before it. A runner that can't take it (offline) doesn't fail the answer;
 * the miss is logged. Returns whether it was told.
 */
export async function tellIfPossible(
  deps: AppDeps,
  assignmentId: string,
  userId: string,
  text: string,
  when: (row: AssignmentRow) => boolean,
): Promise<boolean> {
  const [fresh] = await deps.db.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!fresh || !when(fresh)) return false;
  try {
    return (await tell(deps, fresh, userId, text)).delivered;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    log.warn("assignment.tell_failed", { assignmentId, code: err.code });
    return false;
  }
}

/**
 * Closes the assignment (done or canceled) once, even with two clicks or two people. In one transaction on the
 * locked row: accepts the given submission (or every pending one when done), supersedes the rest, expires the
 * commands that waited and moves the status. Then it stops the agent and the jobs, copies to the wiki if asked
 * and tells.
 */
export async function finishAssignment(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  input: { outcome: "done" | "canceled"; wiki: boolean; note?: string; submissionId?: string },
): Promise<AssignmentRow> {
  const now = deps.now();
  let next = await deps.db.transaction(async (tx) => {
    const fresh = await lockAssignment(tx, row.id);
    const pending = and(
      eq(assignmentSubmissions.assignmentId, row.id),
      eq(assignmentSubmissions.status, "pending"),
    );
    const accept = { status: "accepted" as const, decidedBy: me.userId, decidedAt: now };
    if (input.submissionId) {
      const [accepted] = await tx
        .update(assignmentSubmissions)
        .set(accept)
        .where(and(pending, eq(assignmentSubmissions.id, input.submissionId)))
        .returning();
      if (!accepted) throw submissionClosed();
    } else if (input.outcome === "done") await tx.update(assignmentSubmissions).set(accept).where(pending);
    await tx.update(assignmentSubmissions).set({ status: "superseded" }).where(pending);
    await tx
      .update(assignmentCommands)
      .set({ state: "expired" })
      .where(and(eq(assignmentCommands.assignmentId, row.id), eq(assignmentCommands.state, "pending")));
    const findings = input.note
      ? [...fresh.findings, { text: input.note, at: now.toISOString() }].slice(-100)
      : fresh.findings;
    const [moved] = await tx
      .update(assignments)
      .set({ status: input.outcome, outcome: input.outcome, closedAt: now, findings, updatedAt: now })
      .where(eq(assignments.id, row.id))
      .returning();
    if (!moved) throw closedError();
    return moved;
  });
  publishAssignment(deps, next, "status");
  stopAgentRun(deps, next, me);
  await cancelJobs(deps, next);
  // The copy is extra: the assignment is closed already, so a failed copy is logged and the close goes on.
  if (input.wiki) {
    await copyToWiki(deps, next, me.userId).catch((err) =>
      log.error("assignment.wiki_copy_failed", { assignmentId: row.id, err }),
    );
    next = (await deps.db.select().from(assignments).where(eq(assignments.id, row.id)))[0] ?? next;
  }
  await closeNotificationGroups(deps, row.workspaceId, `assignment:${row.id}:`);
  await assignmentEvent(deps, next, { kind: "closed", actor: person(me), data: { outcome: input.outcome } });
  deps.assignmentEngine.wake(row.id);
  return next;
}

/**
 * The person asks for changes on a pending submission: on the locked row, the submission is answered and the
 * assignment goes back to work; the request becomes a person's plan item that the engine works on and the
 * verifier checks.
 */
export async function requestSubmissionChanges(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  submissionId: string,
  note: string,
): Promise<AssignmentRow> {
  const now = deps.now();
  const { answered, next } = await deps.db.transaction(async (tx) => {
    await lockAssignment(tx, row.id);
    const [answered] = await tx
      .update(assignmentSubmissions)
      .set({ status: "changes_requested", changesNote: note, decidedBy: me.userId, decidedAt: now })
      .where(
        and(
          eq(assignmentSubmissions.id, submissionId),
          eq(assignmentSubmissions.assignmentId, row.id),
          eq(assignmentSubmissions.status, "pending"),
        ),
      )
      .returning();
    if (!answered) throw submissionClosed();
    const [next] = await tx
      .update(assignments)
      .set({ status: "active", pausedAt: null, updatedAt: now })
      .where(eq(assignments.id, row.id))
      .returning();
    if (!next) throw closedError();
    return { answered, next };
  });
  publishAssignment(deps, next, "submission");
  await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:assignment_finished`);
  const w = await writePlan(deps, row.id, {
    author: person(me),
    mode: "append",
    items: [
      { id: `change-${answered.id.slice(-8)}`, title: note.slice(0, 300), criteria: note, kind: "change" },
    ],
    note: "changes requested",
  });
  await assignmentEvent(deps, next, {
    kind: "plan_edited",
    actor: person(me),
    data: { version: w.version, added: w.added, removed: [], edited: [], submissionId: answered.id },
  });
  deps.assignmentEngine.wake(row.id);
  return next;
}

/**
 * Hands the assignment over on its locked row: the owner, the runner and the executor must still be the ones the
 * caller decided on (two hand-overs at once: the second finds it changed), and a runner left behind must have no
 * job running. The new owner leaves the participants; the old one stays as who decides.
 */
export async function transferAssignment(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  input: { userId: string; runnerId: { set: string | null } | null },
): Promise<AssignmentRow> {
  // In the assignment's job queue: a job start in progress either lands first (and is seen running here) or
  // reads the new owner and runner after.
  const next = await withAssignmentJobs(row.id, () => transferOnLockedRow(deps, me, row, input));
  publishAssignment(deps, next, "participants");
  return next;
}

/** The hand-over's write, on the assignment's row locked: the owner, runner and executor checked again there. */
export function transferOnLockedRow(
  deps: AppDeps,
  me: WorkspaceMember,
  row: AssignmentRow,
  input: { userId: string; runnerId: { set: string | null } | null },
): Promise<AssignmentRow> {
  return deps.db.transaction(async (tx) => {
    const fresh = await lockAssignment(tx, row.id);
    if (fresh.ownerId !== row.ownerId || fresh.runnerId !== row.runnerId || fresh.executor !== row.executor)
      throw conflict("assignment.changed", "This assignment changed meanwhile; open it again");
    if (input.runnerId?.set === null && (await hasRunningJob(tx, row.id))) throw jobRunning();
    await tx
      .delete(assignmentParticipants)
      .where(
        and(eq(assignmentParticipants.assignmentId, row.id), eq(assignmentParticipants.userId, input.userId)),
      );
    await tx
      .insert(assignmentParticipants)
      .values({ assignmentId: row.id, userId: fresh.ownerId, role: "decide", addedBy: me.userId })
      .onConflictDoUpdate({
        target: [assignmentParticipants.assignmentId, assignmentParticipants.userId],
        set: { role: "decide" },
      });
    const [moved] = await tx
      .update(assignments)
      .set({
        ownerId: input.userId,
        ...(input.runnerId ? { runnerId: input.runnerId.set } : {}),
        updatedAt: deps.now(),
      })
      .where(eq(assignments.id, row.id))
      .returning();
    if (!moved) throw closedError();
    return moved;
  });
}
