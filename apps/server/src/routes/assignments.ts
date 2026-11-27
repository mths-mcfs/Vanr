// Assignment routes: list and create, the lifecycle (start, pause, resume, stop, close), participants and join
// requests, autonomy (commands and rules), the harness, decisions, reviews, submissions, suggestions, files and
// the jobs on the runner. Every route checks the workspace membership and the person's role on the
// assignment: an assignment the person doesn't see (another workspace, a private channel they don't read)
// answers 404.
import type {
  AssignmentCloseInput,
  AssignmentCommandRetryInput,
  AssignmentEligibleAgent,
  AssignmentHarnessInput,
  AssignmentInput,
  AssignmentPatch,
  AssignmentPlanInput,
  AssignmentRunnerInput,
  AssignmentTransferInput,
  JobOutput,
} from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { agentInWorkspace, requireAgentEditor } from "../agents";
import { assignmentUsage, ceilingState } from "../assignments/budget";
import {
  type AssignmentRow,
  actOn,
  assignmentFiles,
  assignmentFor,
  assignmentOfThread,
  isClosed,
  moveAssignment,
  nameMap,
  OPEN_STATUSES,
  personSays,
  publishAssignment,
  requireOpen,
  roleOf,
  runnerOfAssignment,
  runningJobsOf,
  toCommand,
  toDecision,
  toReview,
  toSubmission,
  updateAssignment,
  viewAssignment,
  visibleAssignments,
  waitingFor,
} from "../assignments/core";
import {
  cancelJobs,
  createAssignment,
  ruleFor,
  ruleMatches,
  rulesOf,
  startAssignmentJob,
  stopAgentRun,
  wake,
} from "../assignments/engine";
import { assignmentEvent, eventsOf, lastEvent, markSeen, seenBy, toEvent } from "../assignments/events";
import {
  editsAgent,
  environmentReady,
  executorAvailable,
  finishAssignment,
  harnessOf,
  joinRequestsOf,
  participantsOf,
  person,
  requestSubmissionChanges,
  requireExecutor,
  requireManager,
  requireRunStop,
  requireTell,
  setHarness,
  settingsOf,
  tell,
  tellIfPossible,
} from "../assignments/lifecycle";
import { resetTurns } from "../assignments/motor";
import {
  itemOf,
  MAX_PLAN_ITEMS,
  planOf,
  planVersions,
  toPlanItem,
  touchItem,
  writePlan,
} from "../assignments/plan";
import { proofsOf, toProof } from "../assignments/proofs";
import { canReadChannel, writableChannel } from "../channels";
import type { AppDeps, AppEnv } from "../context";
import { badRequest, conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { messageInWorkspace } from "../messages";
import { closeNotifications, notify } from "../notifications";
import { withPlanOwner, withPlanOwners } from "../runners/plans";
import { canUseRunner, runnerInWorkspace, toJob } from "../runners/runners";
import { canTalkTo } from "../runtime/route";
import { requireMember, WORKSPACE } from "../workspace-scope";

const {
  agents,
  members,
  messages,
  runnerJobs,
  channelMemberships,
  assignmentParticipants,
  assignmentJoinRequests,
  assignmentDecisions,
  assignmentReviews,
  assignmentCommands,
  assignmentCommandRules,
  assignmentSubmissions,
} = schema;

const AI = `${WORKSPACE}/assignments/:assignmentId`;
const id = z.string().min(1).max(64);
const executorEnum = z.enum(["agent", "claude_code", "codex"]);
const policyEnum = z.enum(["always", "when_safe", "never"]);
const participantRole = z.enum(["decide", "comment"]);
const suggestionMeta = z.object({
  assignmentId: z.string(),
  text: z.string(),
  status: z.enum(["pending", "accepted", "declined"]).optional(),
});
/** What the runner answers to `job.output`: checked before it reaches the response. */
const liveOutput = z.object({ lines: z.array(z.string().max(100_000)).max(2000) });

export const createAssignmentBody = z
  .object({
    agentId: id,
    goal: z.string().trim().min(1).max(4000),
    title: z.string().trim().max(120).optional(),
    channelId: id,
    threadId: id.optional(),
    commandPolicy: policyEnum.optional(),
    executor: executorEnum.optional(),
    runnerId: id.optional(),
  })
  .strict() satisfies z.ZodType<AssignmentInput>;

const limit = z.number().min(0).max(1_000_000).nullable().optional();
export const updateAssignmentBody = z
  .object({
    resumeJobs: z.boolean().optional(),
    limits: z.object({ dollars: limit, minutes: limit, steps: limit }).strict().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict() satisfies z.ZodType<AssignmentPatch>;

const closeBody = z
  .object({
    outcome: z.enum(["done", "canceled"]),
    copyToWiki: z.boolean().optional(),
    note: z.string().trim().max(4000).optional(),
  })
  .strict() satisfies z.ZodType<AssignmentCloseInput>;

const transferBody = z
  .object({ userId: id, lendRunner: z.boolean().optional() })
  .strict() satisfies z.ZodType<AssignmentTransferInput>;

const runnerBody = z
  .object({ runnerId: id, checkoutPath: z.string().trim().max(1024).optional() })
  .strict() satisfies z.ZodType<AssignmentRunnerInput>;

const harnessBody = z
  .object({ harness: executorEnum, model: z.string().max(100).optional() })
  .strict() satisfies z.ZodType<AssignmentHarnessInput>;

export const planBody = z
  .object({
    parentVersion: z.number().int().min(0),
    items: z
      .array(
        z
          .object({
            id: z.string().trim().max(40).optional(),
            title: z.string().trim().min(1).max(300),
            criteria: z.string().trim().max(2000).optional(),
            milestone: z.string().trim().max(80).nullable().optional(),
            status: z.enum(["todo", "dropped"]).optional(),
          })
          .strict(),
      )
      .max(MAX_PLAN_ITEMS),
    note: z.string().trim().max(500).optional(),
  })
  .strict() satisfies z.ZodType<AssignmentPlanInput>;

const retryBody = z
  .object({ jobId: id, commands: z.array(z.string().trim().min(1).max(2000)).min(1).max(50) })
  .strict() satisfies z.ZodType<AssignmentCommandRetryInput>;

/** A member of this workspace (who an assignment is handed to or shared with). */
async function memberOfWorkspace(deps: AppDeps, workspaceId: string, userId: string) {
  const [m] = await deps.db
    .select({ userId: members.userId, role: members.role })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  if (!m) throw badRequest("Not a member of this workspace", { field: "userId" });
  return m;
}

/**
 * Who takes part in the assignment (a participant, the new owner) must read its channel: the assignment's
 * plan, decisions and files are the channel's, and a private channel's stay with its members.
 */
async function requireReadsChannel(deps: AppDeps, row: AssignmentRow, userId: string) {
  if (!(await canReadChannel(deps.db, { workspaceId: row.workspaceId, userId, channelId: row.channelId })))
    throw badRequest("That person can't read this assignment's channel", { field: "userId" });
}

/** Saves the command rules the assignment doesn't have yet; returns every rule it has now. */
async function addRules(deps: AppDeps, row: AssignmentRow, wanted: readonly string[], by: string) {
  const have = new Set((await rulesOf(deps, row.id)).map((r) => r.rule));
  for (const rule of wanted.filter((r) => !have.has(r))) {
    await deps.db.insert(assignmentCommandRules).values({ id: newId("acr"), assignmentId: row.id, rule, by });
    have.add(rule);
  }
  return have;
}

const notStarted = (start: boolean) =>
  start
    ? conflict("assignment.not_proposed", "This assignment already started")
    : conflict("assignment.not_paused", "This assignment is not paused");

export function registerAssignments(app: Hono<AppEnv>) {
  // ---- list and create ----

  app.get(`${WORKSPACE}/assignments`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const q = readQuery(
      c,
      z.object({
        status: z.enum(["open", "closed", "blocked_on_you"]).optional(),
        channelId: id.optional(),
        agentId: id.optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    );
    const all = await visibleAssignments(deps, me, { channelId: q.channelId, agentId: q.agentId });
    const waiting = new Set<string>();
    for (const r of all) if (await waitingFor(deps.db, me, r)) waiting.add(r.id);
    const text = q.q?.trim().toLowerCase();
    const filtered = all.filter((r) => {
      if (q.status === "open" && isClosed(r)) return false;
      if (q.status === "closed" && !isClosed(r)) return false;
      if (q.status === "blocked_on_you" && !waiting.has(r.id)) return false;
      if (text && !`${r.title}\n${r.goal}`.toLowerCase().includes(text)) return false;
      return true;
    });
    const out = [];
    for (const r of filtered.slice(0, q.limit)) out.push(await assignmentFor(deps, r, me));
    return c.json({
      assignments: out,
      counts: {
        active: all.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status)).length,
        blockedOnYou: waiting.size,
        closed: all.filter(isClosed).length,
      },
    });
  });

  app.get(`${WORKSPACE}/assignments/eligible-agents`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, me.workspaceId), isNull(agents.archivedAt)))
      .orderBy(agents.name);
    const out: AssignmentEligibleAgent[] = [];
    for (const a of await withPlanOwners(deps.db, rows)) {
      if (!canTalkTo(a, me.userId)) continue;
      const runner = a.environmentId
        ? await runnerInWorkspace(deps.db, me.workspaceId, a.environmentId).catch(() => null)
        : null;
      out.push({
        agentId: a.id,
        qualifies: true,
        reason: null,
        runner: runner
          ? { id: runner.id, name: runner.name, online: deps.runners.isOnline(runner.id) }
          : null,
        executors: [
          "agent",
          ...(executorAvailable(runner, "claude_code", me.userId) ? (["claude_code"] as const) : []),
          ...(executorAvailable(runner, "codex", me.userId) ? (["codex"] as const) : []),
        ],
        manageable: editsAgent(me, a),
      });
    }
    return c.json({ agents: out });
  });

  app.post(`${WORKSPACE}/assignments`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(c, createAssignmentBody);
    // The agent, the channel, the thread and the runner are this workspace's: another one's id is a 404.
    const agent = await agentInWorkspace(deps.db, me.workspaceId, input.agentId);
    if (agent.archivedAt || !canTalkTo(await withPlanOwner(deps.db, agent), me.userId))
      throw notFound("Agent not found");
    const channel = await writableChannel(deps.db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      channelId: input.channelId,
    });
    if (channel.kind === "dm") throw badRequest("Assignments live in channels", { field: "channelId" });
    const [inChannel] = await deps.db
      .select({ id: channelMemberships.memberId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channel.id),
          eq(channelMemberships.memberType, "agent"),
          eq(channelMemberships.memberId, agent.id),
        ),
      );
    if (!inChannel)
      throw conflict("assignment.agent_not_in_channel", `Add ${agent.name} to this channel first`);
    if (input.threadId) {
      const root = await messageInWorkspace(deps.db, me.workspaceId, input.threadId);
      if (!root || root.channelId !== channel.id || root.threadId)
        throw badRequest("Thread not found", { field: "threadId" });
      if (await assignmentOfThread(deps.db, root.id))
        throw conflict("assignment.exists", "This thread already has an assignment");
    }
    const executor = input.executor ?? "agent";
    let runnerId: string | null = null;
    if (input.runnerId) {
      const r = await runnerInWorkspace(deps.db, me.workspaceId, input.runnerId);
      if (!canUseRunner(me, r)) throw forbidden("Only who paired that runner can use it");
      runnerId = r.id;
    }
    if (executor !== "agent") {
      const planned = { runnerId, agentId: agent.id, workspaceId: me.workspaceId, ownerId: me.userId };
      requireExecutor(await runnerOfAssignment(deps.db, planned), executor, me.userId);
    }
    const goal = input.goal;
    const title = input.title || goal.split("\n")[0]?.slice(0, 80) || "Assignment";
    const row = await createAssignment(deps, {
      workspaceId: me.workspaceId,
      agentId: agent.id,
      agentHandle: agent.handle,
      channelId: channel.id,
      ownerId: me.userId,
      title,
      goal,
      executor,
      runnerId,
      commandPolicy: input.commandPolicy ?? agent.assignmentCommandPolicy,
      threadId: input.threadId ?? null,
    });
    return c.json(await assignmentFor(deps, row, me), 201);
  });

  app.get(AI, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    return c.json(await assignmentFor(deps, row, me));
  });

  app.get(`${WORKSPACE}/threads/:threadId/assignment`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await assignmentOfThread(deps.db, param(c, "threadId"));
    if (!row || row.workspaceId !== me.workspaceId || !(await roleOf(deps.db, me, row)))
      throw notFound("No assignment in this thread");
    return c.json(await assignmentFor(deps, row, me));
  });

  app.get(`${WORKSPACE}/threads/:threadId/jobs`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const root = await messageInWorkspace(deps.db, me.workspaceId, param(c, "threadId"));
    if (
      !root ||
      !(await canReadChannel(deps.db, {
        workspaceId: me.workspaceId,
        userId: me.userId,
        channelId: root.channelId,
      }))
    )
      throw notFound("Thread not found");
    const rows = await deps.db
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.workspaceId, me.workspaceId), eq(runnerJobs.threadId, root.id)))
      .orderBy(desc(runnerJobs.createdAt));
    return c.json({ jobs: rows.map(toJob) });
  });

  app.get(`${WORKSPACE}/jobs/:jobId/output`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { tail } = readQuery(c, z.object({ tail: z.coerce.number().int().min(1).max(2000).default(200) }));
    const [job] = await deps.db
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.id, param(c, "jobId")), eq(runnerJobs.workspaceId, me.workspaceId)));
    if (!job) throw notFound("Job not found");
    if (job.assignmentId) await viewAssignment(deps, me, job.assignmentId);
    else if (
      !job.channelId ||
      !(await canReadChannel(deps.db, {
        workspaceId: me.workspaceId,
        userId: me.userId,
        channelId: job.channelId,
      }))
    )
      throw notFound("Job not found");
    let out: JobOutput = {
      lines: job.outputTail.slice(-tail),
      source: job.outputTail.length ? "stored" : "none",
    };
    if (deps.runners.isOnline(job.runnerId)) {
      const [agent] = await deps.db
        .select({ handle: agents.handle })
        .from(agents)
        .where(eq(agents.id, job.agentId));
      const live = await deps.runners
        .call(
          job.runnerId,
          "job.output",
          { jobId: job.id, tail },
          { agent: { id: job.agentId, handle: agent?.handle ?? "" }, timeoutMs: 10_000 },
        )
        .catch(() => null);
      const parsed = liveOutput.safeParse(live);
      if (parsed.success) out = { lines: parsed.data.lines.slice(-tail), source: "live" };
    }
    return c.json(out);
  });

  // ---- lifecycle ----

  app.post(`${AI}/:action{start|pause|resume|stop}`, async (c) => {
    const action = z.enum(["start", "pause", "resume", "stop"]).parse(param(c, "action"));
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const now = deps.now();
    if (action === "start" || action === "resume") {
      const start = action === "start";
      const from = start ? "proposed" : "paused";
      if (row.status !== from) throw notStarted(start);
      // Without the runner the assignment doesn't move: say why before starting.
      if (row.executor !== "agent") await environmentReady(deps, row);
      // Resuming with the cap still hit would stop again at once: raise the cap first.
      if (!start) {
        const hit = ceilingState(row.limits, await assignmentUsage(deps, row)).hit;
        if (hit) throw conflict("assignment.ceiling", `Raise the ${hit} limit first`, { which: hit });
      }
      // Moves only from the expected status: a double click or two people at once start it once.
      const next = await moveAssignment(
        deps,
        row,
        [from],
        start
          ? { status: "active", startedAt: now, pausedAt: null }
          : { status: "active", pausedAt: null, ceiling: null, waitReason: null },
        "status",
      );
      if (!next) throw notStarted(start);
      if (!start) await resetTurns(deps, row.id);
      await assignmentEvent(deps, next, { kind: start ? "started" : "resumed", actor: person(me) });
      deps.assignmentEngine.wake(row.id);
      return c.json(await assignmentFor(deps, next, me));
    }
    if (row.status === "proposed")
      throw conflict("assignment.not_started", "This assignment has not started");
    requireRunStop(deps);
    stopAgentRun(deps, row, me.userId);
    const canceledJobs = action === "stop" ? await cancelJobs(deps, row) : 0;
    const moved = await moveAssignment(
      deps,
      row,
      ["active", "wrapping_up"],
      { status: "paused", pausedAt: now, waitReason: "paused" },
      "status",
    );
    if (moved) await assignmentEvent(deps, moved, { kind: "paused", actor: person(me), data: { action } });
    deps.assignmentEngine.wake(row.id);
    return c.json({
      ...(await assignmentFor(deps, moved ?? row, me)),
      ...(action === "stop" ? { canceledJobs } : {}),
    });
  });

  app.post(`${AI}/close`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const input = await readJson(c, closeBody);
    requireRunStop(deps);
    const next = await finishAssignment(deps, me, row, {
      outcome: input.outcome,
      wiki: input.copyToWiki ?? false,
      ...(input.note ? { note: input.note } : {}),
    });
    return c.json(await assignmentFor(deps, next, me));
  });

  app.post(`${AI}/messages`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    if (row.status === "paused") throw conflict("assignment.paused", "Resume the assignment first");
    const { text } = await readJson(c, z.object({ text: z.string().trim().min(1).max(10_000) }).strict());
    requireTell(deps, row);
    return c.json(await tell(deps, row, me.userId, text));
  });

  // ---- people ----

  app.get(`${AI}/participants`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    return c.json(await participantsOf(deps, row));
  });

  app.patch(`${AI}/participants/:participantId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    const userId = param(c, "participantId");
    const { role } = await readJson(c, z.object({ role: participantRole }).strict());
    if (userId === row.ownerId) throw badRequest("The owner already decides", { field: "userId" });
    await memberOfWorkspace(deps, me.workspaceId, userId);
    await requireReadsChannel(deps, row, userId);
    await deps.db
      .insert(assignmentParticipants)
      .values({ assignmentId: row.id, userId, role, addedBy: me.userId })
      .onConflictDoUpdate({
        target: [assignmentParticipants.assignmentId, assignmentParticipants.userId],
        set: { role },
      });
    await deps.db
      .update(assignmentJoinRequests)
      .set({ status: "accepted", role, decidedAt: deps.now() })
      .where(
        and(
          eq(assignmentJoinRequests.assignmentId, row.id),
          eq(assignmentJoinRequests.userId, userId),
          eq(assignmentJoinRequests.status, "pending"),
        ),
      );
    publishAssignment(deps, row, "participants");
    return c.json(await participantsOf(deps, row));
  });

  app.delete(`${AI}/participants/:participantId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const userId = param(c, "participantId");
    if (userId !== me.userId) requireManager(me, row);
    await deps.db
      .delete(assignmentParticipants)
      .where(and(eq(assignmentParticipants.assignmentId, row.id), eq(assignmentParticipants.userId, userId)));
    publishAssignment(deps, row, "participants");
    return c.body(null, 204);
  });

  app.get(`${AI}/join-requests`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    return c.json({ requests: await joinRequestsOf(deps, row.id) });
  });

  app.post(`${AI}/join-requests`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row, role } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    if (role !== "view")
      throw conflict("assignment.already_participant", "You already take part in this assignment");
    await deps.db
      .insert(assignmentJoinRequests)
      .values({ assignmentId: row.id, userId: me.userId })
      .onConflictDoUpdate({
        target: [assignmentJoinRequests.assignmentId, assignmentJoinRequests.userId],
        set: { status: "pending", role: null, createdAt: deps.now(), decidedAt: null },
      });
    await notify(deps, {
      workspaceId: row.workspaceId,
      userId: row.ownerId,
      kind: "question_for_you",
      reason: "join_requested",
      groupKey: `assignment:${row.id}:join:${me.userId}`,
      waiting: true,
      actor: { type: "person", id: me.userId },
      source: { assignmentId: row.id, channelId: row.channelId, threadId: row.threadId, label: row.title },
      latest: { title: row.title, text: "join" },
    });
    publishAssignment(deps, row, "join");
    const list = await joinRequestsOf(deps, row.id);
    return c.json(
      list.find((r) => r.userId === me.userId),
      201,
    );
  });

  app.post(`${AI}/join-requests/:joinRequestId/:action{accept|decline}`, async (c) => {
    const action = z.enum(["accept", "decline"]).parse(param(c, "action"));
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    // A join request is the requester's: its id is their user id.
    const userId = param(c, "joinRequestId");
    const role =
      action === "accept"
        ? (await readJson(c, z.object({ role: participantRole.default("comment") }).strict())).role
        : null;
    if (role) await requireReadsChannel(deps, row, userId);
    const [req] = await deps.db
      .update(assignmentJoinRequests)
      .set({ status: action === "accept" ? "accepted" : "declined", role, decidedAt: deps.now() })
      .where(
        and(
          eq(assignmentJoinRequests.assignmentId, row.id),
          eq(assignmentJoinRequests.userId, userId),
          eq(assignmentJoinRequests.status, "pending"),
        ),
      )
      .returning();
    if (!req) throw conflict("assignment.join_closed", "There is no open request from this person");
    if (role)
      await deps.db
        .insert(assignmentParticipants)
        .values({ assignmentId: row.id, userId, role, addedBy: me.userId })
        .onConflictDoUpdate({
          target: [assignmentParticipants.assignmentId, assignmentParticipants.userId],
          set: { role },
        });
    await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:join:${userId}`);
    publishAssignment(deps, row, "join");
    const list = await joinRequestsOf(deps, row.id);
    return c.json(list.find((r) => r.userId === userId));
  });

  app.post(`${AI}/transfer`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    requireOpen(row);
    const input = await readJson(c, transferBody);
    if (input.userId === row.ownerId) throw badRequest("That person already owns it", { field: "userId" });
    const target = await memberOfWorkspace(deps, me.workspaceId, input.userId);
    await requireReadsChannel(deps, row, target.userId);
    // Without lending the runner, the assignment still moves, but leaves the runner the new owner can't use and
    // comes back with `assignment.needs_environment`. Lending pins the runner on the assignment (with no
    // explicit choice it would use the agent's, which the new owner can't use); only who may use the runner
    // lends it.
    const runner = await runnerOfAssignment(deps.db, row);
    const lend = !!runner && !!input.lendRunner;
    if (lend && !canUseRunner(me, runner)) throw forbidden("Only who paired that runner can lend it");
    const dropRunner =
      row.executor !== "agent" &&
      !lend &&
      !!runner &&
      !canUseRunner({ userId: target.userId, role: target.role }, runner);
    if (dropRunner && (await runningJobsOf(deps.db, row.id)).length > 0)
      throw conflict("assignment.job_running", "Wait for the running job or stop it first");
    await deps.db
      .delete(assignmentParticipants)
      .where(
        and(eq(assignmentParticipants.assignmentId, row.id), eq(assignmentParticipants.userId, input.userId)),
      );
    await deps.db
      .insert(assignmentParticipants)
      .values({ assignmentId: row.id, userId: row.ownerId, role: "decide", addedBy: me.userId })
      .onConflictDoUpdate({
        target: [assignmentParticipants.assignmentId, assignmentParticipants.userId],
        set: { role: "decide" },
      });
    const next = await updateAssignment(
      deps,
      row,
      {
        ownerId: input.userId,
        ...(dropRunner ? { runnerId: null } : lend && runner ? { runnerId: runner.id } : {}),
      },
      "participants",
    );
    const out = await assignmentFor(deps, next, me);
    return c.json(dropRunner ? { ...out, code: "assignment.needs_environment" } : out);
  });

  // ---- settings ----

  app.patch(AI, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    const input = await readJson(c, updateAssignmentBody);
    const pick = (v: number | null | undefined, was: number | null) => (v !== undefined ? v : was);
    const limits = input.limits
      ? {
          dollars: pick(input.limits.dollars, row.limits.dollars),
          minutes: pick(input.limits.minutes, row.limits.minutes),
          steps: pick(
            input.limits.steps === undefined || input.limits.steps === null
              ? input.limits.steps
              : Math.floor(input.limits.steps),
            row.limits.steps,
          ),
        }
      : undefined;
    const next = await updateAssignment(
      deps,
      row,
      {
        ...(input.resumeJobs !== undefined ? { resumeJobs: input.resumeJobs } : {}),
        ...(limits ? { limits } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
      },
      "settings",
    );
    if (limits || input.dueAt !== undefined) deps.assignmentEngine.wake(row.id);
    return c.json(await assignmentFor(deps, next, me));
  });

  app.put(`${AI}/runner`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    requireOpen(row);
    const input = await readJson(c, runnerBody);
    const r = await runnerInWorkspace(deps.db, me.workspaceId, input.runnerId);
    if (!canUseRunner(me, r)) throw forbidden("Only who paired that runner can use it");
    if ((await runningJobsOf(deps.db, row.id)).length > 0)
      throw conflict("assignment.job_running", "Wait for the running job or stop it first");
    const next = await updateAssignment(
      deps,
      row,
      {
        runnerId: r.id,
        ...(input.checkoutPath !== undefined ? { checkoutPath: input.checkoutPath || null } : {}),
      },
      "settings",
    );
    return c.json(await assignmentFor(deps, next, me));
  });

  app.put(`${AI}/executor`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    const { executor } = await readJson(c, z.object({ executor: executorEnum }).strict());
    return c.json(await assignmentFor(deps, await setHarness(deps, row, executor), me));
  });

  app.put(`${AI}/command-approval`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    const { commandPolicy } = await readJson(c, z.object({ commandPolicy: policyEnum }).strict());
    await updateAssignment(deps, row, { commandPolicy }, "settings");
    return c.json({ commandPolicy });
  });

  app.put(`${WORKSPACE}/agents/:agentId/assignment-command-approval`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const agent = await agentInWorkspace(deps.db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    const { commandPolicy } = await readJson(c, z.object({ commandPolicy: policyEnum }).strict());
    await deps.db
      .update(agents)
      .set({ assignmentCommandPolicy: commandPolicy, updatedAt: deps.now() })
      .where(eq(agents.id, agent.id));
    return c.json({ commandPolicy });
  });

  app.get(`${AI}/settings`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    return c.json(await settingsOf(deps, me, row));
  });

  app.get(`${AI}/runtime`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    return c.json(await harnessOf(deps, me, row));
  });

  app.put(`${AI}/runtime`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    const input = await readJson(c, harnessBody);
    const next = await setHarness(deps, row, input.harness, input.model);
    return c.json(await harnessOf(deps, me, next));
  });

  app.delete(`${AI}/command-rules/:commandRuleId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    requireManager(me, row);
    const removed = await deps.db
      .delete(assignmentCommandRules)
      .where(
        and(
          eq(assignmentCommandRules.id, param(c, "commandRuleId")),
          eq(assignmentCommandRules.assignmentId, row.id),
        ),
      )
      .returning();
    if (removed.length === 0) throw notFound("Rule not found");
    publishAssignment(deps, row, "settings");
    return c.json({ rules: (await settingsOf(deps, me, row)).rules });
  });

  // ---- commands ----

  app.get(`${AI}/commands`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const rows = await deps.db
      .select()
      .from(assignmentCommands)
      .where(eq(assignmentCommands.assignmentId, row.id))
      .orderBy(desc(assignmentCommands.createdAt));
    return c.json({ commands: rows.map(toCommand), rules: (await rulesOf(deps, row.id)).map((r) => r.rule) });
  });

  app.post(`${AI}/commands/:commandId/decide`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    const { decision } = await readJson(
      c,
      z.object({ decision: z.enum(["allow", "deny", "always"]) }).strict(),
    );
    const state = decision === "deny" ? "denied" : "allowed";
    // Only a pending command changes: the second click finds it decided.
    const [cmd] = await deps.db
      .update(assignmentCommands)
      .set({ state, always: decision === "always", decidedBy: me.userId, decidedAt: deps.now() })
      .where(
        and(
          eq(assignmentCommands.id, param(c, "commandId")),
          eq(assignmentCommands.assignmentId, row.id),
          eq(assignmentCommands.state, "pending"),
        ),
      )
      .returning();
    if (!cmd) throw conflict("assignment.command_closed", "This command was already decided");
    if (decision === "always") await addRules(deps, row, cmd.rules, me.userId);
    wake(cmd.id, state);
    if (cmd.messageId)
      await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:approval:${cmd.messageId}`);
    publishAssignment(deps, row, "command");
    await resetTurns(deps, row.id);
    deps.assignmentEngine.wake(row.id);
    return c.json(toCommand(cmd));
  });

  // Allows commands a job was denied (they become the assignment's rules) and resumes the job with them.
  app.post(`${AI}/commands/retry`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const input = await readJson(c, retryBody);
    const [job] = await deps.db
      .select()
      .from(runnerJobs)
      .where(and(eq(runnerJobs.id, input.jobId), eq(runnerJobs.assignmentId, row.id)));
    if (!job) throw notFound("Job not found");
    const wanted = [...new Set(input.commands.map(ruleFor))];
    const have = await addRules(deps, row, wanted, me.userId);
    const waiting = await deps.db
      .select()
      .from(assignmentCommands)
      .where(
        and(
          eq(assignmentCommands.assignmentId, row.id),
          eq(assignmentCommands.jobId, job.id),
          eq(assignmentCommands.state, "pending"),
        ),
      );
    const freed = waiting.filter((cmd) => wanted.some((rule) => ruleMatches(rule, cmd.command)));
    if (freed.length)
      await deps.db
        .update(assignmentCommands)
        .set({ state: "allowed", decidedBy: me.userId, decidedAt: deps.now() })
        .where(
          and(
            inArray(
              assignmentCommands.id,
              freed.map((cmd) => cmd.id),
            ),
            eq(assignmentCommands.state, "pending"),
          ),
        );
    for (const cmd of freed)
      if (cmd.messageId)
        await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:approval:${cmd.messageId}`);
    let delivered = false;
    if (row.executor !== "agent" && row.status !== "paused") {
      try {
        await startAssignmentJob(deps, row, {
          extra: `These commands are allowed now; run them again and continue:\n${wanted.map((x) => `- ${x}`).join("\n")}`,
          resumedJobId: job.id,
          planItemId: job.planItemId,
        });
        delivered = true;
      } catch (err) {
        // The runner can't take the job now (offline, a job running): the rules stay for the next one.
        if (!(err instanceof HttpError)) throw err;
      }
    }
    publishAssignment(deps, row, "command");
    await resetTurns(deps, row.id);
    deps.assignmentEngine.wake(row.id);
    return c.json({ rules: [...have], delivered });
  });

  // ---- decisions ----

  app.get(`${AI}/decisions`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const rows = await deps.db
      .select()
      .from(assignmentDecisions)
      .where(eq(assignmentDecisions.assignmentId, row.id))
      .orderBy(assignmentDecisions.createdAt);
    return c.json({ decisions: rows.map(toDecision) });
  });

  app.post(`${AI}/decisions/approve-provisional`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    const rows = await deps.db
      .update(assignmentDecisions)
      .set({ status: "taken", selectedBy: me.userId, selectedAt: deps.now() })
      .where(and(eq(assignmentDecisions.assignmentId, row.id), eq(assignmentDecisions.status, "provisional")))
      .returning();
    for (const d of rows)
      if (d.messageId)
        await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:ask:${d.messageId}`);
    publishAssignment(deps, row, "decision");
    return c.json({ decisions: rows.map(toDecision) });
  });

  app.post(`${AI}/decisions/:decisionId/choose`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    const { option } = await readJson(c, z.object({ option: z.string().trim().min(1).max(200) }).strict());
    const [d] = await deps.db
      .select()
      .from(assignmentDecisions)
      .where(
        and(eq(assignmentDecisions.id, param(c, "decisionId")), eq(assignmentDecisions.assignmentId, row.id)),
      );
    if (!d) throw notFound("Decision not found");
    if (d.status === "taken") throw conflict("assignment.decision_taken", "This decision was already taken");
    if (!d.options.includes(option)) throw badRequest("Not one of the options", { field: "option" });
    // A provisional choice that changes the course is told to the agent through the thread (the runtime).
    const changesCourse =
      d.status === "provisional" &&
      option !== d.chosen &&
      row.executor === "agent" &&
      row.status === "active";
    if (changesCourse) requireTell(deps, row);
    const [next] = await deps.db
      .update(assignmentDecisions)
      .set({ status: "taken", chosen: option, selectedBy: me.userId, selectedAt: deps.now() })
      .where(
        and(
          eq(assignmentDecisions.id, d.id),
          inArray(assignmentDecisions.status, ["pending", "provisional"]),
        ),
      )
      .returning();
    if (!next) throw conflict("assignment.decision_taken", "This decision was already taken");
    // The agent waiting for the choice goes on; if no one waits and it changes the course, it hears it in the thread.
    if (!wake(d.id, option) && changesCourse)
      await personSays(deps, row, me.userId, `${d.question} → ${option}`);
    if (d.messageId)
      await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:ask:${d.messageId}`);
    publishAssignment(deps, row, "decision");
    await assignmentEvent(deps, row, {
      kind: "decision_taken",
      actor: person(me),
      data: { decisionId: d.id, question: d.question, chosen: option },
    });
    await resetTurns(deps, row.id);
    deps.assignmentEngine.wake(row.id);
    return c.json(toDecision(next));
  });

  app.post(`${AI}/decisions/:decisionId/opinion`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row, role } = await viewAssignment(deps, me, param(c, "assignmentId"));
    if (role === "view")
      throw new HttpError(403, "assignment.forbidden", "Join the assignment to give an opinion");
    const { option } = await readJson(c, z.object({ option: z.string().trim().min(1).max(200) }).strict());
    const [d] = await deps.db
      .select()
      .from(assignmentDecisions)
      .where(
        and(eq(assignmentDecisions.id, param(c, "decisionId")), eq(assignmentDecisions.assignmentId, row.id)),
      );
    if (!d) throw notFound("Decision not found");
    if (!d.options.includes(option)) throw badRequest("Not one of the options", { field: "option" });
    const opinions = [
      ...d.opinions.filter((o) => o.userId !== me.userId),
      { userId: me.userId, option, at: deps.now().toISOString() },
    ];
    const [next] = await deps.db
      .update(assignmentDecisions)
      .set({ opinions })
      .where(eq(assignmentDecisions.id, d.id))
      .returning();
    publishAssignment(deps, row, "decision");
    return c.json(toDecision(next ?? d));
  });

  // ---- reviews ----

  app.get(`${AI}/reviews`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const rows = await deps.db
      .select()
      .from(assignmentReviews)
      .where(eq(assignmentReviews.assignmentId, row.id))
      .orderBy(desc(assignmentReviews.createdAt));
    return c.json({ reviews: rows.map(toReview) });
  });

  app.post(`${AI}/reviews/:reviewId/:action{approve|changes}`, async (c) => {
    const action = z.enum(["approve", "changes"]).parse(param(c, "action"));
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    const { note } = await readJson(c, z.object({ note: z.string().trim().max(4000).optional() }).strict());
    if (action === "changes" && !note) throw badRequest("Say what to change", { field: "note" });
    if (row.status === "active") requireTell(deps, row);
    const [next] = await deps.db
      .update(assignmentReviews)
      .set({
        status: action === "approve" ? "approved" : "changes_requested",
        note: note ?? null,
        decidedBy: me.userId,
        decidedAt: deps.now(),
      })
      .where(
        and(
          eq(assignmentReviews.id, param(c, "reviewId")),
          eq(assignmentReviews.assignmentId, row.id),
          eq(assignmentReviews.status, "pending"),
        ),
      )
      .returning();
    if (!next) throw conflict("assignment.review_closed", "This review was already answered");
    if (next.messageId)
      await closeNotifications(deps, row.workspaceId, `assignment:${row.id}:ask:${next.messageId}`);
    publishAssignment(deps, row, "review");
    await resetTurns(deps, row.id);
    deps.assignmentEngine.wake(row.id);
    if (row.status === "active")
      await tellIfPossible(
        deps,
        row,
        me.userId,
        action === "approve" ? `✓ ${next.title}${note ? `: ${note}` : ""}` : `✎ ${next.title}: ${note}`,
      );
    return c.json(toReview(next));
  });

  // ---- submissions ----

  app.get(`${AI}/submissions`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const rows = await deps.db
      .select()
      .from(assignmentSubmissions)
      .where(eq(assignmentSubmissions.assignmentId, row.id))
      .orderBy(desc(assignmentSubmissions.createdAt));
    return c.json(rows.map(toSubmission));
  });

  const pendingSubmission = async (deps: AppDeps, row: AssignmentRow, submissionId: string) => {
    const [d] = await deps.db
      .select()
      .from(assignmentSubmissions)
      .where(and(eq(assignmentSubmissions.id, submissionId), eq(assignmentSubmissions.assignmentId, row.id)));
    if (!d) throw notFound("Submission not found");
    if (d.status !== "pending")
      throw conflict("assignment.submission_closed", "This submission was already answered");
    return d;
  };

  app.put(`${AI}/submissions/:submissionId/checklist/:itemId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    const d = await pendingSubmission(deps, row, param(c, "submissionId"));
    const { checked } = await readJson(c, z.object({ checked: z.boolean() }).strict());
    const itemId = param(c, "itemId");
    if (!d.checklist.some((i) => i.id === itemId)) throw notFound("Item not found");
    const checklist = d.checklist.map((i) =>
      i.id === itemId ? { ...i, verifiedBy: checked ? me.userId : null } : i,
    );
    const [next] = await deps.db
      .update(assignmentSubmissions)
      .set({ checklist })
      .where(and(eq(assignmentSubmissions.id, d.id), eq(assignmentSubmissions.status, "pending")))
      .returning();
    if (!next) throw conflict("assignment.submission_closed", "This submission was already answered");
    publishAssignment(deps, row, "submission");
    return c.json(toSubmission(next));
  });

  app.post(`${AI}/submissions/:submissionId/accept`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const d = await pendingSubmission(deps, row, param(c, "submissionId"));
    const { copyToWiki } = await readJson(c, z.object({ copyToWiki: z.boolean().default(false) }).strict());
    requireRunStop(deps);
    const next = await finishAssignment(deps, me, row, {
      outcome: "done",
      wiki: copyToWiki,
      submissionId: d.id,
    });
    return c.json(await assignmentFor(deps, next, me));
  });

  app.post(`${AI}/submissions/:submissionId/request-changes`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const d = await pendingSubmission(deps, row, param(c, "submissionId"));
    const { note } = await readJson(c, z.object({ note: z.string().trim().min(1).max(4000) }).strict());
    const next = await requestSubmissionChanges(deps, me, row, d.id, note);
    return c.json(await assignmentFor(deps, next, me));
  });

  // ---- suggestions ----

  app.post(`${AI}/suggestions/:suggestionId/:action{accept|decline}`, async (c) => {
    const action = z.enum(["accept", "decline"]).parse(param(c, "action"));
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    // A suggestion is a message of the assignment's thread: its id is the message's.
    const msg = await messageInWorkspace(deps.db, me.workspaceId, param(c, "suggestionId"));
    const parsed = suggestionMeta.safeParse(msg?.meta.assignmentSuggestion);
    const s = parsed.success ? parsed.data : null;
    if (!msg || msg.threadId !== row.threadId || !s || s.assignmentId !== row.id)
      throw notFound("Suggestion not found");
    if (s.status && s.status !== "pending")
      throw conflict("assignment.suggestion_closed", "This suggestion was already answered");
    const status = action === "accept" ? ("accepted" as const) : ("declined" as const);
    const tells = status === "accepted" && !isClosed(row) && row.status !== "paused";
    if (tells) requireTell(deps, row);
    await deps.db
      .update(messages)
      .set({ meta: { ...msg.meta, assignmentSuggestion: { ...s, status } } })
      .where(eq(messages.id, msg.id));
    publishAssignment(deps, row, "suggestion", { messageId: msg.id, suggestion: { ...s, status } });
    if (tells) {
      const names = await nameMap(deps.db, [msg.authorId]);
      await tellIfPossible(deps, row, me.userId, `${names.get(msg.authorId) ?? ""}: ${s.text}`);
    }
    return c.json({ messageId: msg.id, status });
  });

  // ---- reading ----

  app.get(`${AI}/files`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const files = (await assignmentFiles(deps, row)).map((f) => ({ ...f, writtenAt: null }));
    return c.json({ files, editedOnRunner: [] });
  });

  app.get(`${AI}/summary`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const m = await assignmentFor(deps, row, me);
    const live = (await planOf(deps, row.id)).filter((i) => i.status !== "dropped");
    return c.json({
      plan: {
        done: m.plan.done,
        total: m.plan.total,
        inProgress: live.filter((i) => i.status === "doing").length,
        waiting: m.plan.waiting,
      },
      running: m.runningJobs,
      pendingDecisions: m.pending.decisions,
      provisionalDecisions: m.pending.provisional,
      pendingReviews: m.pending.reviews,
    });
  });

  app.get(`${AI}/plan`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const items = await planOf(deps, row.id);
    return c.json({
      current: items.length ? { version: row.planVersion, items: items.map(toPlanItem) } : null,
    });
  });

  // A person edits the plan midway (P0-03): version and author; an old `parentVersion` gets 409.
  app.put(`${AI}/plan`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const input = await readJson(c, planBody);
    const w = await writePlan(deps, row.id, {
      author: person(me),
      mode: "person",
      items: input.items,
      parentVersion: input.parentVersion,
      ...(input.note ? { note: input.note } : {}),
    });
    if (w.added.length || w.removed.length || w.edited.length) {
      await assignmentEvent(deps, row, {
        kind: "plan_edited",
        actor: person(me),
        data: {
          version: w.version,
          added: w.added,
          removed: w.removed,
          edited: w.edited,
          note: input.note ?? null,
        },
      });
      publishAssignment(deps, row, "plan");
      deps.assignmentEngine.wake(row.id);
    }
    return c.json({ current: { version: w.version, items: w.items.map(toPlanItem) } });
  });

  app.get(`${AI}/plan/versions`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const rows = await planVersions(deps, row.id);
    return c.json({
      versions: rows.map((v) => ({
        version: v.version,
        author: { type: v.author.type, id: v.author.id },
        note: v.note,
        items: v.items,
        createdAt: v.createdAt.toISOString(),
      })),
    });
  });

  // The assignment's trail (events) and how far the person has seen ("what changed since you looked").
  app.get(`${AI}/events`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const q = readQuery(
      c,
      z.object({
        after: z.coerce.number().int().min(0).optional(),
        before: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
    );
    const events = await eventsOf(deps, row.id, {
      ...(q.after !== undefined ? { after: q.after } : {}),
      ...(q.before !== undefined ? { before: q.before } : {}),
      limit: q.limit,
    });
    const last = await lastEvent(deps, row.id);
    return c.json({
      events: events.map(toEvent),
      seenSeq: await seenBy(deps, row.id, me.userId),
      lastSeq: last?.seq ?? 0,
    });
  });

  app.post(`${AI}/seen`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    const { seq } = await readJson(c, z.object({ seq: z.number().int().min(0) }).strict());
    const last = await lastEvent(deps, row.id);
    return c.json({ seenSeq: await markSeen(deps, row.id, me.userId, Math.min(seq, last?.seq ?? 0)) });
  });

  app.get(`${AI}/proofs`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await viewAssignment(deps, me, param(c, "assignmentId"));
    return c.json({ proofs: (await proofsOf(deps, row.id)).map(toProof) });
  });

  // A stuck item: the person has it tried again (turns and rounds back to zero; the verdict stays in the history).
  app.post(`${AI}/items/:itemId/retry`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await actOn(deps, me, param(c, "assignmentId"));
    requireOpen(row);
    const item = await itemOf(deps, row.id, param(c, "itemId"));
    if (!item || item.status === "dropped") throw notFound("Item not found");
    const next = await touchItem(deps, row.id, item.id, {
      turns: 0,
      checks: 0,
      epoch: item.epoch + 1,
      ...(item.status === "blocked_on_you" ? { status: "todo" as const } : {}),
      updatedBy: person(me),
    });
    await assignmentEvent(deps, row, { kind: "item_retry", actor: person(me), itemId: item.id });
    publishAssignment(deps, row, "plan");
    deps.assignmentEngine.wake(row.id);
    return c.json(toPlanItem(next ?? item));
  });
}
