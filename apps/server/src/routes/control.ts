// Approvals, proposals, questions and undo.
//
// Approving and editing send the `payloadHash` of the version the person saw: if the effect changed after that
// (another edit, another request), the route refuses with `approval.changed` instead of approving something else.
//
// Deciding an approval, editing it and answering a question wake the run that waits on them (the agent runtime):
// until the runtime is there, those routes check who may call and what was sent, then refuse with `not_available`
// before anything is written.
import type {
  AgentAction,
  AgentQuestion,
  Approval,
  ApprovalList,
  ApprovalRuleList,
  ApprovalStats,
  Proposal,
  ProposalList,
  UndoAllResult,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { createMemory } from "../agent-memory";
import { canReadChannel, readableChannel } from "../channels";
import { type AppEnv, requireRuntime, type WorkspaceMember } from "../context";
import {
  type ActionRow,
  actionInWorkspace,
  applyProposalText,
  applyUndo,
  approvalInWorkspace,
  approvalsView,
  canDecideFor,
  canUndo,
  ownersOf,
  type ProposalRow,
  proposalsView,
  proposalTrail,
  publishActions,
  publishApproval,
  publishProposal,
  recordDecision,
  toQuestion,
  trailEntry,
  UNDO_WINDOW_MS,
} from "../control";
import { conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { actorName, toAction } from "../messages";
import { rememberRule, revokeRule, rulesView } from "../standing-rules";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

/** Trail: the person remembered the request for 30 days. */
const rememberedEntry = (at: Date, name: string, label: string) =>
  trailEntry(at, "remembered", `${name} allowed this for 30 days (${label})`, { name, label });

const { approvals, proposals, questions, reversibleActions, gateDecisions } = schema;

const decideBody = z.object({
  reason: z.string().trim().max(1000).optional(),
  payloadHash: z.string().trim().min(1).max(128).optional(),
  remember: z.boolean().optional(),
});

const editBody = z.object({
  input: z.record(z.string(), z.unknown()),
  payloadHash: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(1000).optional(),
  remember: z.boolean().optional(),
});

const alreadyResolved = () => conflict("approval.already_resolved", "Already decided");

/** "Approve and remember" only where the gate let it be remembered (the runtime saves the key only on those). */
function rememberCheck(row: { ruleKey: string | null; effect: string | null }) {
  if (!row.ruleKey || row.effect === "K3")
    throw new HttpError(400, "approval.not_rememberable", "This request can't be remembered", {
      field: "remember",
    });
}

/** The person decided about another version of the effect (or without seeing the hash): it doesn't count. */
function sameEffect(row: { payloadHash: string | null }, seen: string | undefined) {
  if (row.payloadHash && seen !== row.payloadHash)
    throw conflict("approval.changed", "What would run is not what you saw; reload and decide again");
}

/** Whoever doesn't decide only sees approvals of conversations they can read. */
async function visibleApprovals(db: Db, me: WorkspaceMember, list: Approval[]): Promise<Approval[]> {
  const readable = new Map<string, boolean>();
  const out: Approval[] = [];
  for (const a of list) {
    if (a.ownerUserId === me.userId || a.decidable || !a.channelId) {
      out.push(a);
      continue;
    }
    let ok = readable.get(a.channelId);
    if (ok === undefined) {
      ok = await canReadChannel(db, {
        workspaceId: me.workspaceId,
        userId: me.userId,
        channelId: a.channelId,
      });
      readable.set(a.channelId, ok);
    }
    if (ok) out.push(a);
  }
  return out;
}

/**
 * A proposal made in a channel (its why and its evidence quote the conversation): whoever neither decides nor
 * decided only sees it if they can read the channel, as with approvals.
 */
async function visibleProposals(
  db: Db,
  me: WorkspaceMember,
  rows: ProposalRow[],
  at: Date,
): Promise<Proposal[]> {
  const views = await proposalsView(db, me, rows, at);
  const readable = new Map<string, boolean>();
  const out: Proposal[] = [];
  for (const [i, p] of views.entries()) {
    const channelId = rows[i]?.channelId;
    if (!channelId || p.decidable || p.decidedBy === me.userId) {
      out.push(p);
      continue;
    }
    let ok = readable.get(channelId);
    if (ok === undefined) {
      ok = await canReadChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId });
      readable.set(channelId, ok);
    }
    if (ok) out.push(p);
  }
  return out;
}

/** The action as the API shows it (a kind this server doesn't know never gets here: applyUndo refuses it). */
function actionOut(row: ActionRow): AgentAction {
  const out = toAction(row);
  if (!out) throw notFound("Action not found");
  return out;
}

export function registerControl(app: Hono<AppEnv>) {
  // ---- approvals ----

  app.get(`${WORKSPACE}/approvals`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { status } = readQuery(c, z.object({ status: z.enum(["pending", "decided"]).optional() }));
    const rows = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspaceId, me.workspaceId),
          status === "pending" ? eq(approvals.status, "pending") : undefined,
          status === "decided" ? ne(approvals.status, "pending") : undefined,
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(300);
    return c.json({
      approvals: await visibleApprovals(db, me, await approvalsView(db, me, rows)),
    } satisfies ApprovalList);
  });

  // The gate's telemetry per class: how many calls, how many asked a person, how they ended and the time to the
  // decision (p50, p90). Only whoever sees the workspace's usage.
  app.get(`${WORKSPACE}/approvals/stats`, async (c) => {
    const me = requirePermission(c, "view_usage");
    const { db, now } = c.get("deps");
    const { days } = readQuery(c, z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }));
    const since = new Date(now().getTime() - days * 86_400_000);
    const decideMs = sql<number>`extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) * 1000`;
    const rows = await db
      .select({
        effect: gateDecisions.effect,
        calls: sql<number>`count(*)::int`,
        auto: sql<number>`count(*) filter (where ${gateDecisions.decision} = 'allow')::int`,
        asked: sql<number>`count(*) filter (where ${gateDecisions.decision} = 'ask')::int`,
        denied: sql<number>`count(*) filter (where ${gateDecisions.decision} = 'deny')::int`,
        approved: sql<number>`count(*) filter (where ${approvals.status} = 'approved' and not ${approvals.edited})::int`,
        edited: sql<number>`count(*) filter (where ${approvals.status} = 'approved' and ${approvals.edited})::int`,
        rejected: sql<number>`count(*) filter (where ${approvals.status} = 'rejected')::int`,
        expired: sql<number>`count(*) filter (where ${approvals.status} = 'expired')::int`,
        p50: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${decideMs}) filter (where ${approvals.decidedAt} is not null and ${approvals.status} in ('approved', 'rejected'))`,
        p90: sql<
          number | null
        >`percentile_cont(0.9) within group (order by ${decideMs}) filter (where ${approvals.decidedAt} is not null and ${approvals.status} in ('approved', 'rejected'))`,
      })
      .from(gateDecisions)
      .leftJoin(approvals, eq(approvals.id, gateDecisions.approvalId))
      .where(and(eq(gateDecisions.workspaceId, me.workspaceId), gte(gateDecisions.createdAt, since)))
      .groupBy(gateDecisions.effect)
      .orderBy(gateDecisions.effect);
    const round = (v: number | string | null) => (v === null ? null : Math.round(Number(v)));
    return c.json({
      since: since.toISOString(),
      byEffect: rows.map(({ p50, p90, ...r }) => ({ ...r, p50Ms: round(p50), p90Ms: round(p90) })),
    } satisfies ApprovalStats);
  });

  app.get(`${WORKSPACE}/approvals/:approvalId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await approvalInWorkspace(db, me.workspaceId, param(c, "approvalId"));
    const [view] = await visibleApprovals(db, me, await approvalsView(db, me, [row]));
    if (!view) throw notFound("Approval not found");
    return c.json(view satisfies Approval);
  });

  const decide = (decision: "approved" | "rejected") =>
    app.post(
      `${WORKSPACE}/approvals/:approvalId/${decision === "approved" ? "approve" : "reject"}`,
      async (c) => {
        const me = requireMember(c);
        const deps = c.get("deps");
        const { db, runtime } = deps;
        const { reason, payloadHash, remember } = await readJson(c, decideBody);
        const row = await approvalInWorkspace(db, me.workspaceId, param(c, "approvalId"));
        const owner = (await ownersOf(db, me.workspaceId, [row.agentId])).get(row.agentId);
        if (!canDecideFor(me, owner)) throw forbidden("Only the agent's owner decides");
        if (row.status !== "pending") throw alreadyResolved();
        // Rejecting runs nothing: it doesn't need the hash. Approving only counts for the effect the person saw.
        if (decision === "approved") sameEffect(row, payloadHash);
        const remembers = decision === "approved" && remember === true;
        if (remembers) rememberCheck(row);
        // The run that waits on the decision is the runtime's: without it, nothing is written.
        requireRuntime(runtime, "awaitsApproval");
        requireRuntime(runtime, "resolveApproval");
        const at = deps.now();
        const name = await actorName(db, me.workspaceId, { type: "person", id: me.userId });
        if (!runtime.awaitsApproval(row.id)) {
          // The run that asked already ended (it shouldn't happen: the end of a run cancels its pending ones).
          const entry = trailEntry(at, "canceled", "The work stopped before a decision");
          const [ended] = await db
            .update(approvals)
            .set({
              status: "canceled",
              decidedAt: at,
              trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
            })
            .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
            .returning();
          if (ended) await publishApproval(deps, ended, "approval.resolved");
          throw conflict("approval.gone", "The agent is no longer waiting for this");
        }
        const entries =
          decision === "approved"
            ? [
                trailEntry(at, "approved", `Approved by ${name}`, { name }),
                ...(remembers ? [rememberedEntry(at, name, row.ruleLabel ?? "")] : []),
              ]
            : [trailEntry(at, "rejected", `Rejected by ${name}`, { name, reason: reason ?? "" })];
        const next = await recordDecision(db, row, {
          status: decision,
          deciderUserId: me.userId,
          at,
          reason: reason ?? null,
          entries,
        });
        if (!next) throw alreadyResolved();
        if (remembers && next.ruleKey && next.ruleLabel)
          await rememberRule(db, {
            workspaceId: me.workspaceId,
            agentId: next.agentId,
            tool: next.tool,
            key: next.ruleKey,
            label: next.ruleLabel,
            approvalId: next.id,
            byUserId: me.userId,
            at,
          });
        await publishApproval(deps, next, "approval.resolved");
        runtime.resolveApproval(row.id, {
          id: row.id,
          decision,
          reason: reason ?? null,
          byName: name,
          ...(decision === "approved" && row.payloadHash ? { payloadHash: row.payloadHash } : {}),
        });
        const [view] = await approvalsView(db, me, [next]);
        if (!view) throw notFound("Approval not found");
        return c.json(view satisfies Approval);
      },
    );
  decide("approved");
  decide("rejected");

  // Edit and approve: only the editable fields; the run validates with the tool's schema, plans again and returns
  // the preview and the hash of the new effect, which is the only one that runs.
  app.post(`${WORKSPACE}/approvals/:approvalId/edit`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { db, runtime } = deps;
    const body = await readJson(c, editBody);
    const row = await approvalInWorkspace(db, me.workspaceId, param(c, "approvalId"));
    const owner = (await ownersOf(db, me.workspaceId, [row.agentId])).get(row.agentId);
    if (!canDecideFor(me, owner)) throw forbidden("Only the agent's owner decides");
    if (row.status !== "pending") throw alreadyResolved();
    sameEffect(row, body.payloadHash);
    if (row.editable.length === 0)
      throw new HttpError(400, "invalid_request", "This request can't be edited", { field: "input" });
    requireRuntime(runtime, "reviseApproval");
    requireRuntime(runtime, "resolveApproval");
    const revised = await runtime.reviseApproval(row.id, body.input);
    if (!revised) throw conflict("approval.gone", "The agent is no longer waiting for this");
    if ("error" in revised) throw new HttpError(400, "invalid_request", revised.error, { field: "input" });
    // The edit may change the predicate (or the class): the edited effect's one counts.
    const rule = revised.rule;
    if (body.remember) rememberCheck({ ruleKey: rule?.key ?? null, effect: revised.effect });
    const at = deps.now();
    const name = await actorName(db, me.workspaceId, { type: "person", id: me.userId });
    const entries = [
      trailEntry(at, "edited", `Edited by ${name}`, { name }),
      trailEntry(at, "approved", `Approved by ${name}`, { name }),
      ...(body.remember && rule ? [rememberedEntry(at, name, rule.label)] : []),
    ];
    const next = await recordDecision(db, row, {
      status: "approved",
      deciderUserId: me.userId,
      at,
      reason: body.reason ?? null,
      entries,
      edit: {
        seenHash: body.payloadHash,
        set: {
          originalInput: row.edited ? row.originalInput : row.input,
          input: revised.input,
          preview: revised.preview,
          detail: revised.preview.body ?? "",
          payloadHash: revised.payloadHash,
          effect: revised.effect,
          ruleKey: rule?.key ?? null,
          ruleLabel: rule?.label ?? null,
          edited: true,
        },
      },
    });
    if (!next) throw alreadyResolved();
    if (body.remember && rule)
      await rememberRule(db, {
        workspaceId: me.workspaceId,
        agentId: next.agentId,
        tool: next.tool,
        key: rule.key,
        label: rule.label,
        approvalId: next.id,
        byUserId: me.userId,
        at,
      });
    await publishApproval(deps, next, "approval.resolved");
    runtime.resolveApproval(row.id, {
      id: row.id,
      decision: "approved",
      reason: body.reason ?? null,
      byName: name,
      input: revised.input,
      payloadHash: revised.payloadHash,
      edited: true,
    });
    const [view] = await approvalsView(db, me, [next]);
    if (!view) throw notFound("Approval not found");
    return c.json(view satisfies Approval);
  });

  // ---- always allow ----

  app.get(`${WORKSPACE}/approval-rules`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { agentId } = readQuery(c, z.object({ agentId: z.string().max(64).optional() }));
    return c.json({ rules: await rulesView(deps.db, me, deps.now(), agentId) } satisfies ApprovalRuleList);
  });

  app.delete(`${WORKSPACE}/approval-rules/:approvalRuleId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const out = await revokeRule(deps.db, me, param(c, "approvalRuleId"), deps.now());
    if (out === "not_found") throw notFound("Rule not found");
    if (out === "forbidden") throw forbidden("Only who answers for the agent revokes its rules");
    return c.body(null, 204);
  });

  // ---- proposals ----

  app.get(`${WORKSPACE}/proposals`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(proposals)
      .where(eq(proposals.workspaceId, me.workspaceId))
      .orderBy(desc(proposals.createdAt))
      .limit(300);
    return c.json({
      proposals: await visibleProposals(deps.db, me, rows, deps.now()),
    } satisfies ProposalList);
  });

  /**
   * The proposal, locked for the decision's transaction: two decisions at once (accept twice, accept and reject)
   * apply one; the other finds it decided.
   */
  const lockedProposal = async (db: Db, me: WorkspaceMember, id: string, at: Date) => {
    const [row] = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, id), eq(proposals.workspaceId, me.workspaceId)))
      .for("update");
    if (!row) throw notFound("Proposal not found");
    const [view] = await proposalsView(db, me, [row], at);
    if (!view) throw notFound("Proposal not found");
    if (row.status !== "pending") throw conflict("proposal.decided", "Already decided");
    if (!view.decidable) throw forbidden();
    return { row, view };
  };

  app.post(`${WORKSPACE}/proposals/:proposalId/accept`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { text } = await readJson(c, z.object({ text: z.string().trim().min(1).max(20_000).optional() }));
    const id = param(c, "proposalId");
    const at = deps.now();
    const name = await actorName(deps.db, me.workspaceId, { type: "person", id: me.userId });
    const next = await deps.db.transaction(async (tx) => {
      const { row, view } = await lockedProposal(tx, me, id, at);
      if (view.stale) throw conflict("proposal.stale", "The text changed since the proposal");
      const finalText = text ?? row.after;
      // The swap only counts if the text is still `before` (another person may have changed it in the middle).
      // Instructions and the workspace memory get a version with the proposal, who accepted and the title as reason.
      const applied = await applyProposalText(
        { ...deps, db: tx },
        row,
        row.before,
        finalText,
        { type: "person", id: me.userId },
        "proposal",
      );
      if (!applied) throw conflict("proposal.stale", "The text changed since the proposal");
      const edited = text !== undefined && text !== row.after;
      const entry = proposalTrail(
        at,
        "accepted",
        `${edited ? "Edited and accepted" : "Accepted"} by ${name}`,
        {
          name,
          ...(edited ? { edited: "true" } : {}),
        },
      );
      const [next] = await tx
        .update(proposals)
        .set({
          status: "accepted",
          after: finalText,
          decidedAt: at,
          decidedBy: me.userId,
          trail: sql`${proposals.trail} || ${JSON.stringify([entry])}::jsonb`,
        })
        .where(and(eq(proposals.id, row.id), eq(proposals.status, "pending")))
        .returning();
      if (!next) throw conflict("proposal.decided", "Already decided");
      // Accepting gets an undo: the text from before comes back as long as nobody touches it after.
      await tx.insert(reversibleActions).values({
        id: newId("act"),
        workspaceId: me.workspaceId,
        agentId: row.agentId,
        runId: row.runId,
        requesterUserId: me.userId,
        kind: "proposal_applied",
        target: { type: "proposal", id: row.id, title: row.title },
        params: { targetKind: row.targetKind },
        createdAt: at,
        revertibleUntil: new Date(at.getTime() + UNDO_WINDOW_MS),
      });
      return next;
    });
    await publishProposal(deps, next, "proposal.decided");
    const [out] = await proposalsView(deps.db, me, [next], deps.now());
    if (!out) throw notFound("Proposal not found");
    return c.json(out satisfies Proposal);
  });

  app.post(`${WORKSPACE}/proposals/:proposalId/reject`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const id = param(c, "proposalId");
    const at = deps.now();
    const name = await actorName(deps.db, me.workspaceId, { type: "person", id: me.userId });
    const next = await deps.db.transaction(async (tx) => {
      const { row } = await lockedProposal(tx, me, id, at);
      const entry = proposalTrail(at, "rejected", `Rejected by ${name}`, { name });
      const [next] = await tx
        .update(proposals)
        .set({
          status: "rejected",
          decidedAt: at,
          decidedBy: me.userId,
          trail: sql`${proposals.trail} || ${JSON.stringify([entry])}::jsonb`,
        })
        .where(and(eq(proposals.id, row.id), eq(proposals.status, "pending")))
        .returning();
      if (!next) throw conflict("proposal.decided", "Already decided");
      // The rejection becomes a lesson: the agent doesn't propose the same thing again.
      await createMemory(
        tx,
        at,
        {
          workspaceId: me.workspaceId,
          agentId: row.agentId,
          scope: "agent",
          text: `${name} rejected the proposal "${row.title}". Don't propose it again unless asked.`,
          kind: "lesson",
          source: "proposal",
          origin: { by: { type: "person", id: me.userId }, name, channel: null, at: at.toISOString() },
        },
        { author: { type: "person", id: me.userId }, reason: "proposal rejected" },
      );
      return next;
    });
    await publishProposal(deps, next, "proposal.decided");
    const [out] = await proposalsView(deps.db, me, [next], deps.now());
    if (!out) throw notFound("Proposal not found");
    return c.json(out satisfies Proposal);
  });

  // ---- questions ----

  app.post(`${WORKSPACE}/questions/:questionId/answer`, async (c) => {
    const me = requireMember(c);
    const { db, runtime } = c.get("deps");
    const input = await readJson(
      c,
      z.union([
        z.object({ choice: z.string().trim().min(1).max(200) }),
        z.object({ text: z.string().trim().min(1).max(4000) }),
      ]),
    );
    const [row] = await db
      .select()
      .from(questions)
      .where(and(eq(questions.id, param(c, "questionId")), eq(questions.workspaceId, me.workspaceId)));
    if (!row) throw notFound("Question not found");
    await readableChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId: row.channelId });
    // Only whoever was asked answers: the answer becomes a decision in another person's run.
    if (row.askedUserId && row.askedUserId !== me.userId)
      throw forbidden("Only the person who was asked can answer");
    if (row.status !== "open") throw conflict("question.closed", "The question is no longer open");
    let answer: string;
    if ("choice" in input) {
      if (!row.choices.includes(input.choice)) {
        throw new HttpError(400, "invalid_request", "Not one of the choices", { field: "choice" });
      }
      answer = input.choice;
    } else answer = input.text;
    // The run that waits on the answer is the runtime's: without it, nothing is written.
    requireRuntime(runtime, "answerQuestion");
    const next = await runtime.answerQuestion(row.id, answer, me.userId);
    if (!next) throw conflict("question.closed", "The question is no longer open");
    return c.json(toQuestion(next) satisfies AgentQuestion);
  });

  // ---- undo ----

  const undoRoute = (direction: "undo" | "redo") =>
    app.post(`${WORKSPACE}/actions/:actionId/${direction}`, async (c) => {
      const me = requireMember(c);
      const deps = c.get("deps");
      const row = await actionInWorkspace(deps.db, me.workspaceId, param(c, "actionId"));
      const next = await applyUndo(deps, me, row, direction);
      if (next.messageId) await publishActions(deps, next.messageId);
      return c.json(actionOut(next) satisfies AgentAction);
    });
  undoRoute("undo");
  undoRoute("redo");

  app.post(`${WORKSPACE}/messages/:messageId/actions/undo`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { db } = deps;
    const messageId = param(c, "messageId");
    const rows = await db
      .select()
      .from(reversibleActions)
      .where(
        and(eq(reversibleActions.workspaceId, me.workspaceId), eq(reversibleActions.messageId, messageId)),
      );
    if (rows.length === 0) throw notFound("No actions on this message");
    const now = deps.now().getTime();
    const failed: UndoAllResult["failed"] = [];
    for (const row of rows) {
      // "Undo all" only takes what is still open and is the person's; the rest stays as it is.
      if (row.revertedAt || !row.revertibleUntil || row.revertibleUntil.getTime() <= now) continue;
      if (!(await canUndo(db, me, row))) continue;
      try {
        await applyUndo(deps, me, row, "undo");
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        failed.push({ actionId: row.id, code: err.code });
      }
    }
    await publishActions(deps, messageId);
    const after = await db
      .select()
      .from(reversibleActions)
      .where(
        and(eq(reversibleActions.workspaceId, me.workspaceId), eq(reversibleActions.messageId, messageId)),
      );
    return c.json({
      actions: after.flatMap((r) => toAction(r) ?? []),
      failed,
    } satisfies UndoAllResult);
  });
}
