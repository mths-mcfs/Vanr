// Assignment trail (`assignment_events`): append only, the UI reads it and draws the trail. It is not engine state:
// the engine decides from the plan and the assignment tables. Each event also goes out on the channel
// (`assignment.trail_event`), and an event with a `key` is not duplicated when the engine step runs again.
import type { AssignmentEvent, AssignmentEventKind } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { AppDeps } from "../context";

const { assignmentEvents, assignmentSeen } = schema;
type AssignmentActor = schema.AssignmentActor;

export type EventRow = typeof assignmentEvents.$inferSelect;

/** Event kinds (the type lives in the contract, which draws the trail). */
export type { AssignmentEventKind };

export const SYSTEM: AssignmentActor = { type: "system", id: null };

/**
 * An event as the reader gets it. A cap's warning and hit record the usage they saw; its dollars reach only whoever
 * has view_usage (`seesSpend`). The channel event reaches everyone in the channel, so it never carries them.
 */
export function toEvent(row: EventRow, seesSpend: boolean): AssignmentEvent {
  return {
    seq: row.seq,
    kind: row.kind as AssignmentEventKind,
    actor: row.actor,
    itemId: row.itemId,
    data: seesSpend ? row.data : withoutDollars(row.data),
    at: row.at.toISOString(),
  };
}

function withoutDollars(data: Record<string, unknown>): Record<string, unknown> {
  const usage = data.usage;
  if (typeof usage !== "object" || usage === null || !("dollars" in usage)) return data;
  return { ...data, usage: { ...usage, dollars: null } };
}

/** Appends an event and notifies the channel. With a repeated `key`, it does not record again (returns null). */
export async function assignmentEvent(
  deps: AppDeps,
  assignment: { id: string; channelId: string; threadId: string },
  input: {
    kind: AssignmentEventKind;
    actor: AssignmentActor;
    itemId?: string | null;
    data?: Record<string, unknown>;
    key?: string;
  },
): Promise<EventRow | null> {
  const [row] = await deps.db
    .insert(assignmentEvents)
    .values({
      assignmentId: assignment.id,
      key: input.key ?? null,
      kind: input.kind,
      actor: input.actor,
      itemId: input.itemId ?? null,
      data: input.data ?? {},
      at: deps.now(),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  deps.hub.toChannel(assignment.channelId, {
    type: "assignment.trail_event",
    assignmentId: assignment.id,
    threadId: assignment.threadId,
    channelId: assignment.channelId,
    event: toEvent(row, false),
  });
  return row;
}

/**
 * One page of the trail, always in ascending order. With `after`: what came after (the news). Without
 * it: the `limit` most recent ones, or the ones before `before` (see older).
 */
export async function eventsOf(
  deps: AppDeps,
  assignmentId: string,
  opts: { after?: number; before?: number; limit: number },
): Promise<EventRow[]> {
  if (opts.after !== undefined)
    return deps.db
      .select()
      .from(assignmentEvents)
      .where(and(eq(assignmentEvents.assignmentId, assignmentId), gt(assignmentEvents.seq, opts.after)))
      .orderBy(asc(assignmentEvents.seq))
      .limit(opts.limit);
  const rows = await deps.db
    .select()
    .from(assignmentEvents)
    .where(
      and(
        eq(assignmentEvents.assignmentId, assignmentId),
        opts.before !== undefined ? lt(assignmentEvents.seq, opts.before) : undefined,
      ),
    )
    .orderBy(desc(assignmentEvents.seq))
    .limit(opts.limit);
  return rows.reverse();
}

export async function lastEvent(deps: AppDeps, assignmentId: string): Promise<EventRow | null> {
  const [row] = await deps.db
    .select()
    .from(assignmentEvents)
    .where(eq(assignmentEvents.assignmentId, assignmentId))
    .orderBy(desc(assignmentEvents.seq))
    .limit(1);
  return row ?? null;
}

/** How far the person has seen (0: never opened it). */
export async function seenBy(deps: AppDeps, assignmentId: string, userId: string): Promise<number> {
  const [row] = await deps.db
    .select({ seq: assignmentSeen.seq })
    .from(assignmentSeen)
    .where(and(eq(assignmentSeen.assignmentId, assignmentId), eq(assignmentSeen.userId, userId)));
  return row?.seq ?? 0;
}

/** Marks as seen up to `seq` (never goes back). */
export async function markSeen(
  deps: AppDeps,
  assignmentId: string,
  userId: string,
  seq: number,
): Promise<number> {
  const [row] = await deps.db
    .insert(assignmentSeen)
    .values({ assignmentId, userId, seq, at: deps.now() })
    .onConflictDoUpdate({
      target: [assignmentSeen.assignmentId, assignmentSeen.userId],
      set: { seq: sql`greatest(${assignmentSeen.seq}, excluded.seq)`, at: deps.now() },
    })
    .returning({ seq: assignmentSeen.seq });
  return row?.seq ?? seq;
}
