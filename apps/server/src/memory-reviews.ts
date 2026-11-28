// The memory review queue: a run's write with flag A doesn't count until a person approves it. Approving applies
// the operation through the single writer, with the base text as a precondition (if the item changed in the
// meantime, the review fails with `changed_since` and nothing changes). Rejecting only closes it.
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, desc, eq } from "drizzle-orm";
import { type Author, changeMemory, createMemory, type MemoryRow } from "./agent-memory";
import { agentInWorkspace, requireActiveAgent } from "./agents";
import { canReadChannel } from "./channels";
import type { AppDeps, WorkspaceMember } from "./context";
import { conflict, forbidden, HttpError, notFound } from "./http";

const { memoryReviews, memories, runs } = schema;
export type MemoryReviewRow = typeof memoryReviews.$inferSelect;
export type NewMemoryReview = Omit<
  typeof memoryReviews.$inferInsert,
  "id" | "status" | "createdAt" | "decidedAt" | "deciderUserId" | "note" | "resultMemoryId"
>;

export async function queueMemoryReview(deps: AppDeps, values: NewMemoryReview): Promise<MemoryReviewRow> {
  const [row] = await deps.db
    .insert(memoryReviews)
    .values({ ...values, id: newId("mrv"), createdAt: deps.now() })
    .returning();
  if (!row) throw new Error("memory review insert returned nothing");
  return row;
}

/** The channel of the run that queued the review (a delegation's run counts the channel it was asked from). */
async function reviewChannel(db: Db, row: MemoryReviewRow): Promise<string | null> {
  const runId = row.runId ?? row.origin.runId ?? null;
  if (!runId) return null;
  const [run] = await db
    .select({ channelId: runs.channelId, sourceChannelId: runs.sourceChannelId })
    .from(runs)
    .where(eq(runs.id, runId));
  return run?.channelId ?? run?.sourceChannelId ?? null;
}

/**
 * Who decides: in the agent's store, who edits the agent (an admin or the owner) and reads the channel the run
 * wrote from (what a private channel's run wants to remember stays with that channel's readers, as its lessons
 * do); in the person's store, only the person (it is the memory about them, which only they see).
 */
export async function canDecideReview(db: Db, me: WorkspaceMember, row: MemoryReviewRow): Promise<boolean> {
  if (row.workspaceId !== me.workspaceId) return false;
  if (row.scope === "person") return row.ownerUserId === me.userId;
  if (!can(me.role, "manage_agents")) {
    const agent = await agentInWorkspace(db, me.workspaceId, row.agentId);
    if (agent.ownerUserId !== me.userId) return false;
  }
  const channelId = await reviewChannel(db, row);
  return !channelId || canReadChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId });
}

/** The pending reviews this person decides (of one agent or of all). */
export async function reviewsFor(db: Db, me: WorkspaceMember, agentId?: string): Promise<MemoryReviewRow[]> {
  const rows = await db
    .select()
    .from(memoryReviews)
    .where(
      and(
        eq(memoryReviews.workspaceId, me.workspaceId),
        eq(memoryReviews.status, "pending"),
        agentId ? eq(memoryReviews.agentId, agentId) : undefined,
      ),
    )
    .orderBy(desc(memoryReviews.createdAt))
    .limit(300);
  const out: MemoryReviewRow[] = [];
  for (const r of rows) if (await canDecideReview(db, me, r)) out.push(r);
  return out;
}

async function reviewFor(db: Db, me: WorkspaceMember, id: string): Promise<MemoryReviewRow> {
  const [row] = await db
    .select()
    .from(memoryReviews)
    .where(and(eq(memoryReviews.id, id), eq(memoryReviews.workspaceId, me.workspaceId)));
  if (!row) throw notFound("Review not found");
  if (!(await canDecideReview(db, me, row))) {
    // A person-store review doesn't even show for anyone else, nor one from a channel the person doesn't read.
    if (row.scope === "person") throw notFound("Review not found");
    const channelId = await reviewChannel(db, row);
    if (
      channelId &&
      !(await canReadChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId }))
    )
      throw notFound("Review not found");
    throw forbidden();
  }
  if (row.status !== "pending") throw conflict("memory_review.decided", "Already decided");
  return row;
}

async function close(
  db: Db,
  id: string,
  set: Partial<Pick<MemoryReviewRow, "status" | "note" | "resultMemoryId" | "deciderUserId" | "decidedAt">>,
) {
  const [row] = await db
    .update(memoryReviews)
    .set(set)
    .where(and(eq(memoryReviews.id, id), eq(memoryReviews.status, "pending")))
    .returning();
  if (!row) throw conflict("memory_review.decided", "Already decided");
  return row;
}

/** Applies the write the run asked for, as a version by the agent approved by who decided. */
async function apply(deps: AppDeps, row: MemoryReviewRow, me: WorkspaceMember): Promise<MemoryRow> {
  const at = deps.now();
  const author: Author = { type: "agent", id: row.agentId, runId: row.runId };
  const meta = { author, approvedByUserId: me.userId, reason: "approved in review" };
  const store =
    row.scope === "person"
      ? { scope: "person" as const, workspaceId: row.workspaceId, userId: row.ownerUserId ?? "" }
      : { scope: "agent" as const, workspaceId: row.workspaceId, agentId: row.agentId };
  const base = row.baseSha256 ?? undefined;
  // The path the run read when it queued the change (null: the note had none): a move before approval, or a path
  // given to a note that had none, makes it change another file.
  const expectedPath = { expectedPath: row.path };
  switch (row.op) {
    case "create": {
      // What replaces a lesson confined to its channel stays confined with it.
      const [replaced] = row.replaces
        ? await deps.db
            .select({ channelId: memories.channelId })
            .from(memories)
            .where(eq(memories.id, row.replaces))
        : [];
      const created = await createMemory(
        deps.db,
        at,
        {
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          scope: row.scope,
          ownerUserId: row.scope === "person" ? row.ownerUserId : null,
          path: row.path,
          text: row.text,
          kind: row.kind,
          about: row.about,
          source: row.tool === "memory" ? "memory_tool" : "conversation",
          origin: row.origin,
          originMessageId: null,
          untrustedSource: true,
          verified: true,
          channelId: replaced?.channelId ?? null,
          replaces: row.replaces,
        },
        meta,
      );
      if (row.replaces) {
        await changeMemory(
          deps.db,
          at,
          row.replaces,
          { archived: true },
          { ...meta, op: "archive", store },
        ).catch(() => undefined);
      }
      return created;
    }
    case "update":
      return changeMemory(
        deps.db,
        at,
        row.memoryId ?? "",
        { text: row.text, untrustedSource: true },
        {
          ...meta,
          op: "update",
          expectedSha256: base,
          ...expectedPath,
          store,
        },
      );
    case "archive":
      return changeMemory(
        deps.db,
        at,
        row.memoryId ?? "",
        { archived: true },
        {
          ...meta,
          op: "archive",
          expectedSha256: base,
          ...expectedPath,
          store,
        },
      );
    case "rename":
      return changeMemory(
        deps.db,
        at,
        row.memoryId ?? "",
        { path: row.newPath },
        {
          ...meta,
          op: "rename",
          expectedSha256: base,
          ...expectedPath,
          store,
        },
      );
    default: {
      const _never: never = row.op;
      return _never;
    }
  }
}

/**
 * Approving locks the request (`FOR UPDATE`), applies it and closes it in the same transaction: two clicks, or
 * approving and rejecting at the same time, apply at most once, and a crash in the middle doesn't leave the
 * memory written with the request still pending.
 */
export async function approveReview(
  deps: AppDeps,
  me: WorkspaceMember,
  id: string,
): Promise<MemoryReviewRow> {
  await reviewFor(deps.db, me, id);
  const out = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(memoryReviews)
      .where(and(eq(memoryReviews.id, id), eq(memoryReviews.status, "pending")))
      .for("update");
    if (!row) throw conflict("memory_review.decided", "Already decided");
    // Approving writes into the agent's store, which is read-only once it is archived (rejecting stays open).
    if (row.scope === "agent") {
      const [agent] = await tx
        .select({ archivedAt: schema.agents.archivedAt })
        .from(schema.agents)
        .where(eq(schema.agents.id, row.agentId))
        .for("share");
      if (agent) requireActiveAgent(agent);
    }
    try {
      // Each write of the writer is a nested transaction (a savepoint): if it fails, only it rolls back.
      const mem = await apply({ ...deps, db: tx }, row, me);
      return close(tx, row.id, {
        status: "approved",
        resultMemoryId: mem.id,
        deciderUserId: me.userId,
        decidedAt: deps.now(),
      });
    } catch (err) {
      if (err instanceof HttpError && (err.code === "memory.changed" || err.code === "not_found")) {
        await close(tx, row.id, {
          status: "failed",
          note: "changed_since",
          deciderUserId: me.userId,
          decidedAt: deps.now(),
        });
        return null;
      }
      throw err;
    }
  });
  if (!out)
    throw conflict("memory_review.changed", "The memory changed since the agent asked; nothing was applied");
  return out;
}

export async function rejectReview(
  deps: AppDeps,
  me: WorkspaceMember,
  id: string,
  note: string | null,
): Promise<MemoryReviewRow> {
  const row = await reviewFor(deps.db, me, id);
  // Waits for an approval in progress (which locks the request) and only rejects what is still pending.
  return deps.db.transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: memoryReviews.id })
      .from(memoryReviews)
      .where(and(eq(memoryReviews.id, row.id), eq(memoryReviews.status, "pending")))
      .for("update");
    if (!pending) throw conflict("memory_review.decided", "Already decided");
    return close(tx, row.id, {
      status: "rejected",
      note,
      deciderUserId: me.userId,
      decidedAt: deps.now(),
    });
  });
}
