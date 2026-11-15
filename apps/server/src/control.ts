// Control over the agents' actions: the API's shapes, who decides and undo.
//
// Approval: the agent's owner decides; if they left the workspace, whoever has `manage_agents`.
// Proposal: the agent's instructions -> the owner or `manage_agents`; workspace context -> `configure`.
// Action: undone by whoever asked the agent, the owner or `manage_agents`, until `revertibleUntil`; an accepted
// proposal only by who could accept it.
import {
  type AgentActionKind,
  type AgentQuestion,
  type Approval,
  type ApprovalTrailEntry,
  can,
  type GateReason,
  type Proposal,
  type ProposalTrailEntry,
  type RiskReason,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { contentSha256 } from "@vanr/engine/memory";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { changeMemory, createMemory, itemAtPath, storeWhere, writeInstructions } from "./agent-memory";
import { BASE_UNDOERS } from "./bases/undo";
import { CONTENT_UNDOERS } from "./content-undo";
import type { AppDeps, WorkspaceMember } from "./context";
import { conflict, HttpError, notFound } from "./http";
import { reviewsFor } from "./memory-reviews";
import { hydrateOne } from "./messages";
import { closeNotifications, notify } from "./notifications";
import { cancelQueued } from "./outbox";
import { publishMemory } from "./routes/memories";
import { reindex, unindex } from "./search-index";

const {
  approvals,
  proposals,
  questions,
  reversibleActions,
  agents,
  members,
  workspaces,
  memories,
  reminders,
} = schema;
const { messages, outbox, users } = schema;

export type ApprovalRow = typeof approvals.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type QuestionRow = typeof questions.$inferSelect;
export type ActionRow = typeof reversibleActions.$inferSelect;

/** Deadline of an unanswered approval or question (the UI's 24 h bar). */
export const DECISION_TTL_MS = 24 * 60 * 60_000;
/** How long an agent's action can be undone. */
export const UNDO_WINDOW_MS = 24 * 60 * 60_000;

// The stored trail codes, gate reasons and flags are read back against the contract's closed lists.
const APPROVAL_TRAIL_CODES: ReadonlySet<string> = new Set<NonNullable<ApprovalTrailEntry["code"]>>([
  "approved",
  "canceled",
  "edited",
  "executed",
  "expired",
  "failed",
  "rejected",
  "remembered",
  "requested",
  "reviewed",
]);
const PROPOSAL_TRAIL_CODES: ReadonlySet<string> = new Set<NonNullable<ProposalTrailEntry["code"]>>([
  "accepted",
  "proposed",
  "redone",
  "rejected",
  "undone",
]);
const GATE_REASONS: ReadonlySet<string> = new Set<GateReason>([
  "destination_not_allowed",
  "irreversible",
  "policy",
  "rule_of_two",
  "untrusted_public",
  "untrusted_to_external",
]);
const isApprovalCode = (c: string | undefined): c is NonNullable<ApprovalTrailEntry["code"]> =>
  c !== undefined && APPROVAL_TRAIL_CODES.has(c);
const isProposalCode = (c: string | undefined): c is NonNullable<ProposalTrailEntry["code"]> =>
  c !== undefined && PROPOSAL_TRAIL_CODES.has(c);
const isGateReason = (r: string | null): r is GateReason => r !== null && GATE_REASONS.has(r);
const isFlag = (f: { flag: string; source: string }): f is RiskReason =>
  f.flag === "A" || f.flag === "B" || f.flag === "C";

type StoredTrail = { at: string; text: string; code?: string; params?: Record<string, string> };

// ---- approvals ----

export function trailEntry(
  at: Date,
  code: NonNullable<ApprovalTrailEntry["code"]>,
  text: string,
  params: Record<string, string> = {},
): ApprovalTrailEntry {
  return { at: at.toISOString(), text, code, params };
}

/** The agents' owners and whether they are still members, to compute `decidable` at once. */
export async function ownersOf(db: Db, workspaceId: string, agentIds: string[]) {
  const out = new Map<string, { ownerUserId: string; ownerIsMember: boolean }>();
  if (agentIds.length === 0) return out;
  const rows = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId, member: members.userId })
    .from(agents)
    .leftJoin(members, and(eq(members.workspaceId, workspaceId), eq(members.userId, agents.ownerUserId)))
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, [...new Set(agentIds)])));
  for (const r of rows) out.set(r.id, { ownerUserId: r.ownerUserId, ownerIsMember: r.member !== null });
  return out;
}

export function canDecideFor(
  me: Pick<WorkspaceMember, "userId" | "role">,
  owner: { ownerUserId: string; ownerIsMember: boolean } | undefined,
): boolean {
  if (!owner) return false;
  if (owner.ownerUserId === me.userId) return true;
  return !owner.ownerIsMember && can(me.role, "manage_agents");
}

const approvalTrail = (trail: StoredTrail[]): ApprovalTrailEntry[] =>
  trail.map(({ code, ...t }) => (isApprovalCode(code) ? { ...t, code } : t));

export function toApproval(row: ApprovalRow, ownerUserId: string, decidable: boolean): Approval {
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    messageId: row.messageId,
    runId: row.runId,
    tool: row.tool,
    scope: row.scope,
    title: row.title,
    detail: row.detail,
    params: row.params,
    why: row.why,
    issue: row.issue ?? null,
    connector: row.connector,
    linkedAccount: row.linkedAccount,
    status: row.status,
    decidable: decidable && row.status === "pending",
    ownerUserId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    deciderUserId: row.deciderUserId,
    reason: row.reason,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    result: row.result ?? null,
    trail: approvalTrail(row.trail),
    effect: row.effect,
    gateReason: isGateReason(row.gateReason) ? row.gateReason : null,
    flags: row.flags.filter(isFlag),
    preview: row.preview ?? null,
    payloadHash: row.payloadHash,
    input: isRecord(row.input) ? row.input : null,
    editable: row.editable,
    edited: row.edited,
    rememberLabel: row.status === "pending" ? row.ruleLabel : null,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function approvalsView(db: Db, me: WorkspaceMember, rows: ApprovalRow[]): Promise<Approval[]> {
  const owners = await ownersOf(
    db,
    me.workspaceId,
    rows.map((r) => r.agentId),
  );
  return rows.map((r) => {
    const owner = owners.get(r.agentId);
    return toApproval(r, owner?.ownerUserId ?? "", canDecideFor(me, owner));
  });
}

/**
 * approval.requested / approval.resolved: in the channel (the card in the conversation) and in the user scope of
 * whoever may decide. The channel's event goes with `decidable: false`; the decider's client gets its own version
 * through the user scope. Admins get it too when the owner left.
 */
export async function publishApproval(
  deps: AppDeps,
  row: ApprovalRow,
  type: "approval.requested" | "approval.resolved",
) {
  const { db, hub } = deps;
  const owner = (await ownersOf(db, row.workspaceId, [row.agentId])).get(row.agentId);
  const ownerUserId = owner?.ownerUserId ?? "";
  if (row.channelId) hub.toChannel(row.channelId, { type, approval: toApproval(row, ownerUserId, false) });
  const deciders = new Set<string>();
  if (owner?.ownerIsMember) deciders.add(owner.ownerUserId);
  else {
    const admins = await db
      .select({ userId: members.userId, role: members.role })
      .from(members)
      .where(eq(members.workspaceId, row.workspaceId));
    for (const a of admins) if (can(a.role, "manage_agents")) deciders.add(a.userId);
  }
  for (const userId of deciders) {
    hub.toUser(row.workspaceId, userId, { type, approval: toApproval(row, ownerUserId, true) });
  }
  // A "waiting for you" notice for whoever decides; it goes away when the approval leaves pending.
  const groupKey = `approval:${row.id}`;
  if (row.status !== "pending") {
    await closeNotifications(deps, row.workspaceId, groupKey);
    return;
  }
  if (type !== "approval.requested") return;
  for (const userId of deciders) {
    await notify(deps, {
      workspaceId: row.workspaceId,
      userId,
      kind: "approval",
      groupKey,
      waiting: true,
      actor: { type: "agent", id: row.agentId },
      source: {
        approvalId: row.id,
        ...(row.payloadHash ? { payloadHash: row.payloadHash } : {}),
        ...(row.channelId ? { channelId: row.channelId } : {}),
        ...(row.threadId ? { threadId: row.threadId } : {}),
        ...(row.messageId ? { messageId: row.messageId } : {}),
      },
      latest: { title: row.title, text: row.detail, expiresAt: row.expiresAt.toISOString() },
    });
  }
}

export async function approvalInWorkspace(db: Db, workspaceId: string, id: string): Promise<ApprovalRow> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, id), eq(approvals.workspaceId, workspaceId)));
  if (!row) throw notFound("Approval not found");
  return row;
}

// ---- proposals ----

export function proposalTrail(
  at: Date,
  code: NonNullable<ProposalTrailEntry["code"]>,
  text: string,
  params: Record<string, string> = {},
): ProposalTrailEntry {
  return { at: at.toISOString(), text, code, params };
}

/** Inside its window (undone or not: the same window redoes it). */
const inWindow = (action: ActionRow | undefined, at: Date): boolean =>
  !!action?.revertibleUntil && action.revertibleUntil.getTime() > at.getTime();

/**
 * Who decides a proposal's target. The same right accepts it and undoes or redoes what accepting did: owning the
 * agent that proposed doesn't reach the workspace's context or memory.
 */
function decidesTarget(
  me: Pick<WorkspaceMember, "userId" | "role">,
  kind: ProposalRow["targetKind"],
  targetOwnerUserId: string | undefined,
): boolean {
  if (kind === "workspace_context") return can(me.role, "configure");
  if (kind === "workspace_memory") return can(me.role, "manage_agents");
  return can(me.role, "manage_agents") || targetOwnerUserId === me.userId;
}

/** The undo action of each accepted proposal (`proposal_applied`, target = the proposal). */
async function proposalActions(db: Db, ids: string[]): Promise<Map<string, ActionRow>> {
  const out = new Map<string, ActionRow>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(reversibleActions)
    .where(
      and(
        eq(reversibleActions.kind, "proposal_applied"),
        inArray(sql<string>`${reversibleActions.target}->>'id'`, ids),
      ),
    );
  for (const r of rows) out.set(r.target.id, r);
  return out;
}

const proposalTrailOf = (trail: StoredTrail[]): ProposalTrailEntry[] =>
  trail.map(({ code, ...t }) => (isProposalCode(code) ? { ...t, code } : t));

export async function proposalsView(
  db: Db,
  me: WorkspaceMember,
  rows: ProposalRow[],
  at: Date,
): Promise<Proposal[]> {
  const actions = await proposalActions(
    db,
    rows.filter((r) => r.status === "accepted").map((r) => r.id),
  );
  const agentIds = rows.flatMap((r) => (r.recipientAgentId ? [r.recipientAgentId] : []));
  const targets = agentIds.length
    ? await db
        .select({ id: agents.id, instructions: agents.instructions, ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(and(eq(agents.workspaceId, me.workspaceId), inArray(agents.id, agentIds)))
    : [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  const [workspace] = await db
    .select({ context: workspaces.context })
    .from(workspaces)
    .where(eq(workspaces.id, me.workspaceId));
  const paths = rows.flatMap((r) =>
    r.targetKind === "workspace_memory" && r.targetPath ? [r.targetPath] : [],
  );
  const workspaceFiles = paths.length
    ? await db
        .select({ path: memories.path, text: memories.text })
        .from(memories)
        .where(
          and(
            storeWhere({ scope: "workspace", workspaceId: me.workspaceId }),
            eq(memories.archived, false),
            inArray(memories.path, paths),
          ),
        )
    : [];
  const fileText = new Map(workspaceFiles.map((f) => [f.path ?? "", f.text]));
  return rows.map((r) => {
    const target = r.recipientAgentId ? byId.get(r.recipientAgentId) : undefined;
    const current =
      r.targetKind === "workspace_context"
        ? (workspace?.context ?? "")
        : r.targetKind === "workspace_memory"
          ? (fileText.get(r.targetPath ?? "") ?? "")
          : (target?.instructions ?? "");
    const decidable = decidesTarget(me, r.targetKind, target?.ownerUserId);
    const action = actions.get(r.id);
    return {
      id: r.id,
      agentId: r.agentId,
      title: r.title,
      target:
        r.targetKind === "workspace_context"
          ? { kind: "workspace_context" }
          : r.targetKind === "workspace_memory"
            ? { kind: "workspace_memory", path: r.targetPath ?? "" }
            : { kind: "agent_prompt", agentId: r.recipientAgentId ?? r.agentId },
      before: r.before,
      after: r.after,
      status: r.status,
      stale: r.status === "pending" && current !== r.before,
      decidable: decidable && r.status === "pending",
      why: r.why,
      evidence: r.evidence,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      trail: proposalTrailOf(r.trail),
      actionId: action?.id ?? null,
      undone: !!action?.revertedAt,
      canUndo: decidable && inWindow(action, at),
    };
  });
}

/**
 * proposal.created / proposal.decided: in the proposal's channel (the card) and to whoever decides, each with
 * their own version (`decidable`). Accepting, rejecting, undoing and redoing send `proposal.decided`.
 */
export async function publishProposal(
  deps: AppDeps,
  row: ProposalRow,
  type: "proposal.created" | "proposal.decided",
) {
  const { db, hub } = deps;
  const at = deps.now();
  const anyone: WorkspaceMember = { workspaceId: row.workspaceId, userId: "", role: "member", handle: "" };
  const [shared] = await proposalsView(db, anyone, [row], at);
  if (row.channelId && shared)
    hub.toChannel(row.channelId, { type, proposal: { ...shared, decidable: false } });
  const deciders = new Set<string>();
  if (row.targetKind === "agent_prompt") {
    const [target] = await db
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(eq(agents.id, row.recipientAgentId ?? row.agentId));
    if (target) deciders.add(target.ownerUserId);
  }
  const admins = await db
    .select({ userId: members.userId, role: members.role })
    .from(members)
    .where(eq(members.workspaceId, row.workspaceId));
  for (const m of admins) {
    const perm = row.targetKind === "workspace_context" ? "configure" : "manage_agents";
    if (can(m.role, perm)) deciders.add(m.userId);
  }
  for (const userId of deciders) {
    const member = admins.find((m) => m.userId === userId);
    // An owner who left the workspace gets nothing.
    if (!member) continue;
    const [view] = await proposalsView(
      db,
      { workspaceId: row.workspaceId, userId, role: member.role, handle: "" },
      [row],
      at,
    );
    if (view) hub.toUser(row.workspaceId, userId, { type, proposal: view });
  }
}

// ---- questions ----

export function toQuestion(row: QuestionRow): AgentQuestion {
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    text: row.text,
    choices: row.choices,
    status: row.status,
    answer: row.answer,
    responderUserId: row.responderUserId,
    askedUserId: row.askedUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Rewrites the card's `meta.question` and tells the channel (the question changed state). */
export async function publishQuestion(
  deps: AppDeps,
  row: QuestionRow,
  type: "question.raised" | "question.closed",
) {
  const question = toQuestion(row);
  if (row.messageId) {
    const [msg] = await deps.db.select().from(messages).where(eq(messages.id, row.messageId));
    if (msg) {
      await deps.db
        .update(messages)
        .set({ meta: { ...msg.meta, question } })
        .where(eq(messages.id, msg.id));
    }
  }
  deps.hub.toChannel(row.channelId, { type, question, messageId: row.messageId, runId: row.runId });
  const groupKey = `question:${row.id}`;
  if (row.status !== "open") {
    await closeNotifications(deps, row.workspaceId, groupKey);
    return;
  }
  if (!row.askedUserId) return;
  await notify(deps, {
    workspaceId: row.workspaceId,
    userId: row.askedUserId,
    kind: "question_for_you",
    groupKey,
    waiting: true,
    actor: { type: "agent", id: row.agentId },
    source: {
      questionId: row.id,
      channelId: row.channelId,
      ...(row.threadId ? { threadId: row.threadId } : {}),
      ...(row.messageId ? { messageId: row.messageId } : {}),
    },
    latest: { text: row.text, suggestions: row.choices },
  });
}

// ---- actions and undo ----

// The send queue (outbox.ts) publishes too: the function lives in messages.ts.
export { publishActions } from "./messages";

const actionError = (status: 403 | 409, code: string, message: string) =>
  new HttpError(status, code, message);

/**
 * Work that waits for the undo's commit (telling the open editors, the conversation). It gets the server's deps:
 * the transaction the undoer ran in is over by then.
 */
export type AfterCommit = (deps: AppDeps) => void | Promise<void>;

/**
 * What undoing and redoing one kind of action does. It runs inside the undo's transaction: `deps.db` is that
 * transaction, the undoer locks the content's row before it compares, and whatever must wait for the commit
 * comes back as an `AfterCommit`.
 */
export type Undoer = {
  // biome-ignore lint/suspicious/noConfusingVoidType: an undoer with nothing to run after the commit returns nothing
  undo(deps: AppDeps, row: ActionRow, actorUserId: string): Promise<void | AfterCommit>;
  // biome-ignore lint/suspicious/noConfusingVoidType: an undoer with nothing to run after the commit returns nothing
  redo(deps: AppDeps, row: ActionRow, actorUserId: string): Promise<void | AfterCommit>;
};

async function republishMessage(deps: AppDeps, messageId: string) {
  const [row] = await deps.db.select().from(messages).where(eq(messages.id, messageId));
  if (!row) return;
  deps.hub.toChannel(row.channelId, { type: "message.posted", message: await hydrateOne(deps.db, row) });
}

/** The agent's posted message, locked until the undo commits. */
async function lockedMessage(deps: AppDeps, row: ActionRow) {
  const [msg] = await deps.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, row.target.id), eq(messages.workspaceId, row.workspaceId)))
    .for("no key update");
  if (!msg) throw actionError(409, "action.gone", "The message no longer exists");
  return msg;
}

/**
 * Cancels a send still in its window, with the queued row locked first: an undo that got there before the deadline
 * wins, and the send's claim (a conditional update) waits for this transaction and then finds it canceled.
 */
async function cancelInWindow(deps: AppDeps, row: ActionRow, actorUserId: string) {
  await deps.db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.id, row.target.id), eq(outbox.workspaceId, row.workspaceId)))
    .for("update");
  await cancelQueued(deps, row.workspaceId, row.target.id, actorUserId);
}

/** What each kind of action does on undo and redo (the content ones live in content-undo.ts). */
const UNDOERS: Partial<Record<AgentActionKind, Undoer>> = {
  ...CONTENT_UNDOERS,
  ...BASE_UNDOERS,
  // An email can only be undone while it waits in the queue (until `sendAt`); once out there is no way back.
  mail_sent: {
    async undo(deps, row, actorUserId) {
      await cancelInWindow(deps, row, actorUserId);
    },
    async redo() {
      throw notSent();
    },
  },
  memory_recorded: {
    async undo(deps, row, actorUserId) {
      return flipMemory(deps, row, true, actorUserId);
    },
    async redo(deps, row, actorUserId) {
      return flipMemory(deps, row, false, actorUserId);
    },
  },
  reminder_created: {
    async undo(deps, row) {
      const done = await deps.db
        .update(reminders)
        .set({ status: "canceled" })
        .where(
          and(
            eq(reminders.id, row.target.id),
            eq(reminders.workspaceId, row.workspaceId),
            eq(reminders.status, "scheduled"),
          ),
        )
        .returning({ id: reminders.id });
      if (done.length === 0) throw actionError(409, "action.changed_since", "The reminder already ran");
    },
    async redo(deps, row) {
      const done = await deps.db
        .update(reminders)
        .set({ status: "scheduled" })
        .where(
          and(
            eq(reminders.id, row.target.id),
            eq(reminders.workspaceId, row.workspaceId),
            eq(reminders.status, "canceled"),
            sql`${reminders.at} > ${deps.now()}`,
          ),
        )
        .returning({ id: reminders.id });
      if (done.length === 0) throw actionError(409, "action.changed_since", "The reminder can't come back");
    },
  },
  // An accepted proposal: the text from before comes back, only if nobody touched it after (the current one is
  // still the accepted one).
  proposal_applied: {
    async undo(deps, row, actorUserId) {
      await swapProposal(deps, row, "undo", actorUserId);
    },
    async redo(deps, row, actorUserId) {
      await swapProposal(deps, row, "redo", actorUserId);
    },
  },
  // Within the undo window (outbox.ts) the post hasn't gone out yet: undo cancels and nothing shows. Once out,
  // undo retracts the message.
  message_posted: {
    async undo(deps, row, actorUserId) {
      if (row.target.type === "outbox") return cancelInWindow(deps, row, actorUserId);
      const msg = await lockedMessage(deps, row);
      const meta = { ...msg.meta, retracted: { actorUserId: actorUserId, at: deps.now().toISOString() } };
      // Retracting and leaving the search in the same commit: there is no moment with the retracted text findable.
      await deps.db.update(messages).set({ meta }).where(eq(messages.id, msg.id));
      await unindex(deps.db, deps, { kind: "message", id: msg.id });
      return (after) => republishMessage(after, msg.id);
    },
    async redo(deps, row) {
      if (row.target.type === "outbox") throw notSent();
      const msg = await lockedMessage(deps, row);
      const { retracted: _drop, ...meta } = msg.meta;
      await deps.db.update(messages).set({ meta }).where(eq(messages.id, msg.id));
      await reindex(deps, { kind: "message", id: msg.id });
      return (after) => republishMessage(after, msg.id);
    },
  },
};

/** Undo of `memory_recorded`: archives (or brings back) the item, as a new version by whoever undid it. */
async function flipMemory(
  deps: AppDeps,
  row: ActionRow,
  archived: boolean,
  actorUserId: string,
): Promise<AfterCommit> {
  try {
    const mem = await changeMemory(
      deps.db,
      deps.now(),
      row.target.id,
      { archived },
      {
        op: archived ? "archive" : "unarchive",
        author: { type: "person", id: actorUserId },
        reason: archived ? "undo" : "redo",
        expectArchived: !archived,
        // Whoever may undo through the receipt (admin, owner) doesn't rule over a person's store.
        store: { scope: "agent", workspaceId: row.workspaceId, agentId: row.agentId },
      },
    );
    return (after) => publishMemory(after, mem);
  } catch (err) {
    if (err instanceof HttpError) throw actionError(409, "action.changed_since", "The memory changed since");
    throw err;
  }
}

/**
 * Applies a proposal's accepted text, only if the current one is `from` (another person may have changed it in
 * the middle). Instructions and the workspace memory record a version. Returns false when the text changed.
 */
export async function applyProposalText(
  deps: AppDeps,
  row: ProposalRow,
  from: string,
  to: string,
  author: { type: "person"; id: string },
  source: "proposal" | "undo" | "redo",
): Promise<boolean> {
  const { db } = deps;
  const at = deps.now();
  if (row.targetKind === "workspace_context") {
    const done = await db
      .update(workspaces)
      .set({ context: to })
      .where(and(eq(workspaces.id, row.workspaceId), eq(workspaces.context, from)))
      .returning({ id: workspaces.id });
    return done.length > 0;
  }
  if (row.targetKind === "workspace_memory") {
    const store = { scope: "workspace" as const, workspaceId: row.workspaceId };
    const path = row.targetPath ?? "";
    const reason = `${source}: ${row.title}`;
    const current = await itemAtPath(db, store, path);
    try {
      if (from === "") {
        // A new file: accepting and redoing create it (or bring the archived one back); it can't exist.
        if (current) return false;
        const old =
          source === "redo"
            ? (
                await db
                  .select()
                  .from(memories)
                  .where(
                    and(
                      storeWhere(store),
                      eq(memories.path, path),
                      eq(memories.archived, true),
                      eq(memories.text, to),
                    ),
                  )
                  .orderBy(desc(memories.updatedAt))
                  .limit(1)
              )[0]
            : undefined;
        if (old)
          await changeMemory(
            db,
            at,
            old.id,
            { archived: false },
            { op: "unarchive", author, reason, expectArchived: true },
          );
        else
          await createMemory(
            db,
            at,
            {
              workspaceId: row.workspaceId,
              agentId: null,
              scope: "workspace",
              path,
              text: to,
              source: "proposal",
              verified: true,
              origin: {
                by: { type: "agent", id: row.agentId },
                name: null,
                channel: null,
                at: at.toISOString(),
                runId: row.runId,
              },
            },
            { author, reason },
          );
        return true;
      }
      if (!current || current.text !== from) return false;
      if (to === "")
        await changeMemory(
          db,
          at,
          current.id,
          { archived: true },
          { op: "archive", author, reason, expectedSha256: contentSha256(from) },
        );
      else
        await changeMemory(
          db,
          at,
          current.id,
          { text: to },
          { op: "update", author, reason, expectedSha256: contentSha256(from) },
        );
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.code === "memory.changed" || err.code === "memory.exists"))
        return false;
      throw err;
    }
  }
  const done = await writeInstructions(db, at, {
    agentId: row.recipientAgentId ?? row.agentId,
    text: to,
    expected: from,
    author,
    reason: source === "proposal" ? row.title : `${source}: ${row.title}`,
    source,
    proposalId: row.id,
  });
  return done !== null;
}

/** Canceled within the window doesn't come back through the queue: the agent asks again (and passes the gate again). */
const notSent = () => actionError(409, "action.changed_since", "It was not sent; ask the agent again");

async function swapProposal(
  deps: AppDeps,
  action: ActionRow,
  direction: "undo" | "redo",
  actorUserId: string,
) {
  const { db } = deps;
  const [row] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, action.target.id), eq(proposals.workspaceId, action.workspaceId)))
    .for("no key update");
  if (row?.status !== "accepted") throw actionError(409, "action.gone", "The proposal is gone");
  const [from, to] = direction === "undo" ? [row.after, row.before] : [row.before, row.after];
  const done = await applyProposalText(deps, row, from, to, { type: "person", id: actorUserId }, direction);
  if (!done) throw actionError(409, "action.changed_since", "The text changed since");
  const [who] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorUserId));
  const name = who?.name ?? "";
  const entry = proposalTrail(
    deps.now(),
    direction === "undo" ? "undone" : "redone",
    `${direction === "undo" ? "Undone" : "Redone"} by ${name}`,
    { name },
  );
  await db
    .update(proposals)
    .set({ trail: sql`${proposals.trail} || ${JSON.stringify([entry])}::jsonb` })
    .where(eq(proposals.id, row.id));
}

export async function actionInWorkspace(db: Db, workspaceId: string, id: string): Promise<ActionRow> {
  const [row] = await db
    .select()
    .from(reversibleActions)
    .where(and(eq(reversibleActions.id, id), eq(reversibleActions.workspaceId, workspaceId)));
  if (!row) throw notFound("Action not found");
  return row;
}

export async function canUndo(db: Db, me: WorkspaceMember, row: ActionRow): Promise<boolean> {
  if (row.kind === "proposal_applied") {
    const [proposal] = await db
      .select({ targetKind: proposals.targetKind, recipientAgentId: proposals.recipientAgentId })
      .from(proposals)
      .where(and(eq(proposals.id, row.target.id), eq(proposals.workspaceId, row.workspaceId)));
    // Gone: the undoer answers that (action.gone).
    if (!proposal) return true;
    const [target] = proposal.recipientAgentId
      ? await db
          .select({ ownerUserId: agents.ownerUserId })
          .from(agents)
          .where(and(eq(agents.id, proposal.recipientAgentId), eq(agents.workspaceId, row.workspaceId)))
      : [];
    return decidesTarget(me, proposal.targetKind, target?.ownerUserId);
  }
  if (row.requesterUserId === me.userId || can(me.role, "manage_agents")) return true;
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.id, row.agentId), eq(agents.workspaceId, row.workspaceId)));
  return agent?.ownerUserId === me.userId;
}

/**
 * Undoes or redoes an action. Throws an HttpError with the `action.*` code the frontend translates.
 *
 * Checking, changing the content and marking the action are one transaction with the action's row locked
 * (FOR UPDATE): two undos of the same action at once apply once (the second one waits and finds it undone).
 * The undoer locks the content's row in the same transaction before it compares, so a person's edit at the
 * same time either lands first and the undo declines, or waits for the undo and lands after it.
 */
export async function applyUndo(
  deps: AppDeps,
  me: WorkspaceMember,
  row: ActionRow,
  direction: "undo" | "redo",
): Promise<ActionRow> {
  if (!(await canUndo(deps.db, me, row))) throw actionError(403, "action.not_yours", "Not your action");
  const undoer = isKind(row.kind) ? UNDOERS[row.kind] : undefined;
  if (!undoer) throw actionError(409, "action.expired", "This action can't be undone");
  const now = deps.now();
  const { next, after } = await deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reversibleActions)
      .where(and(eq(reversibleActions.id, row.id), eq(reversibleActions.workspaceId, row.workspaceId)))
      .for("update");
    if (!locked) throw notFound("Action not found");
    if (!locked.revertibleUntil || locked.revertibleUntil.getTime() <= now.getTime()) {
      throw actionError(409, "action.expired", "Too late to undo");
    }
    const scoped = { ...deps, db: tx };
    // biome-ignore lint/suspicious/noConfusingVoidType: what the undoer returned (nothing, or work for after the commit)
    let after: void | AfterCommit;
    if (direction === "undo") {
      if (locked.revertedAt) throw actionError(409, "action.already_undone", "Already undone");
      after = await undoer.undo(scoped, locked, me.userId);
    } else {
      if (!locked.revertedAt) throw conflict("action.not_undone", "Not undone");
      after = await undoer.redo(scoped, locked, me.userId);
    }
    const [next] = await tx
      .update(reversibleActions)
      .set(
        direction === "undo"
          ? { revertedAt: now, reverterUserId: me.userId }
          : { revertedAt: null, reverterUserId: null },
      )
      .where(eq(reversibleActions.id, locked.id))
      .returning();
    if (!next) throw notFound("Action not found");
    return { next, after };
  });
  if (after) await after(deps);
  // The proposal's card shows it undone: the state comes from the action, saved only now.
  if (next.kind === "proposal_applied") {
    const [p] = await deps.db.select().from(proposals).where(eq(proposals.id, next.target.id));
    if (p) await publishProposal(deps, p, "proposal.decided");
  }
  return next;
}

const isKind = (kind: string): kind is AgentActionKind => Object.hasOwn(UNDOERS, kind);

// ---- what waits for the person ----

/** Pending approvals the person decides (the sidebar badge and the overview). */
export async function approvalsWaitingFor(
  db: Db,
  me: WorkspaceMember,
  agentId?: string,
): Promise<ApprovalRow[]> {
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.workspaceId, me.workspaceId),
        eq(approvals.status, "pending"),
        agentId ? eq(approvals.agentId, agentId) : undefined,
      ),
    )
    .orderBy(asc(approvals.expiresAt));
  const owners = await ownersOf(
    db,
    me.workspaceId,
    rows.map((r) => r.agentId),
  );
  return rows.filter((r) => canDecideFor(me, owners.get(r.agentId)));
}

/** What waits for this person on the agent's profile: approvals, questions and proposals waiting for this person. */
export async function waitingForMe(db: Db, me: WorkspaceMember, agentId: string, at: Date) {
  const out: {
    kind: "approval" | "question" | "proposal" | "memory_review";
    id: string;
    title: string;
    at: string;
  }[] = [];
  for (const a of await approvalsWaitingFor(db, me, agentId)) {
    out.push({ kind: "approval", id: a.id, title: a.title, at: a.createdAt.toISOString() });
  }
  const qs = await db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.workspaceId, me.workspaceId),
        eq(questions.agentId, agentId),
        eq(questions.status, "open"),
        eq(questions.askedUserId, me.userId),
      ),
    );
  for (const q of qs) out.push({ kind: "question", id: q.id, title: q.text, at: q.createdAt.toISOString() });
  const props = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, me.workspaceId),
        eq(proposals.agentId, agentId),
        eq(proposals.status, "pending"),
      ),
    );
  for (const p of await proposalsView(db, me, props, at)) {
    if (p.decidable) out.push({ kind: "proposal", id: p.id, title: p.title, at: p.createdAt });
  }
  // Memory written by a run that read outside content: waits for this person to approve.
  for (const r of await reviewsFor(db, me, agentId)) {
    out.push({ kind: "memory_review", id: r.id, title: r.text.slice(0, 120), at: r.createdAt.toISOString() });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// ---- deciding an approval ----

/**
 * Records a person's decision on a pending approval: one conditional statement (still pending, and still the
 * effect the person saw), so two decisions at once (two tabs, approve and reject) apply one; the other gets null.
 */
export async function recordDecision(
  db: Db,
  row: ApprovalRow,
  decision: {
    status: "approved" | "rejected";
    deciderUserId: string;
    at: Date;
    reason: string | null;
    entries: ApprovalTrailEntry[];
    /** Edit and approve: the new effect and the hash the person approved it against. */
    edit?: {
      seenHash: string;
      set: Partial<
        Pick<
          ApprovalRow,
          | "originalInput"
          | "input"
          | "preview"
          | "detail"
          | "payloadHash"
          | "effect"
          | "ruleKey"
          | "ruleLabel"
          | "edited"
        >
      >;
    };
  },
): Promise<ApprovalRow | null> {
  const seen = decision.edit ? decision.edit.seenHash : row.payloadHash;
  const [next] = await db
    .update(approvals)
    .set({
      status: decision.status,
      decidedAt: decision.at,
      deciderUserId: decision.deciderUserId,
      reason: decision.reason,
      ...decision.edit?.set,
      trail: sql`${approvals.trail} || ${JSON.stringify(decision.entries)}::jsonb`,
    })
    .where(
      and(
        eq(approvals.id, row.id),
        eq(approvals.workspaceId, row.workspaceId),
        eq(approvals.status, "pending"),
        // Another edit in the middle changed the hash: this decision was about the earlier version.
        seen ? eq(approvals.payloadHash, seen) : undefined,
      ),
    )
    .returning();
  return next ?? null;
}
