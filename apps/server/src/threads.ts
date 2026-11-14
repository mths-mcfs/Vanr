// Threads: the state row (threads table) plus the root and the replies become the API's ThreadInfo.
import type { ActorRef, ThreadInfo } from "@vanr/contract";
import { can, type Role } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { canActRole, isClosed, roleOf, waitingFor } from "./assignments/core";
import type { AppDeps } from "./context";
import { excerpt } from "./messages";

const {
  threads,
  messages,
  channels,
  threadSubscriptions,
  runs,
  approvals,
  questions,
  agents,
  members,
  assignments,
  assignmentParticipants,
  assignmentDecisions,
  assignmentReviews,
  assignmentCommands,
  assignmentSubmissions,
} = schema;

/** The qualified thread id: inside the subqueries, `"id"` alone would be the inner table's id. */
const THREAD_ID = sql.raw('"threads"."id"');

/** A thread with an active agent run ("working" tab). Valid in queries over the threads table. */
export const workingSql = () => sql`exists (
  select 1 from ${runs} r where r.thread_id = ${THREAD_ID}
    and r.status in ('queued','running','paused_for_input','paused_for_approval'))`;

/**
 * A thread waiting on the person: an approval they decide (they own the agent, or an admin when the owner
 * left), an agent question asked to them, or an open assignment they decide with something pending.
 */
export const needsYouSql = (viewer: Viewer) => sql`(
  exists (
    select 1 from ${approvals} a join ${agents} g on g.id = a.agent_id
    where a.thread_id = ${THREAD_ID} and a.status = 'pending'
      and (g.owner_user_id = ${viewer.userId}
        or (${sql.raw(can(viewer.role, "manage_agents") ? "true" : "false")} and not exists (
          select 1 from ${members} m where m.workspace_id = a.workspace_id and m.user_id = g.owner_user_id))))
  or exists (
    select 1 from ${questions} q
    where q.thread_id = ${THREAD_ID} and q.status = 'open' and q.asked_user_id = ${viewer.userId})
  or exists (
    select 1 from ${assignments} mi
    where mi.thread_id = ${THREAD_ID} and mi.status in ('proposed','active','paused','wrapping_up')
      and (mi.owner_id = ${viewer.userId} or exists (
        select 1 from ${assignmentParticipants} mp
        where mp.assignment_id = mi.id and mp.user_id = ${viewer.userId} and mp.role = 'decide'))
      and (exists (select 1 from ${assignmentDecisions} d where d.assignment_id = mi.id and d.status = 'pending')
        or exists (select 1 from ${assignmentReviews} v where v.assignment_id = mi.id and v.status = 'pending')
        or exists (select 1 from ${assignmentCommands} c where c.assignment_id = mi.id and c.state = 'pending')
        or exists (select 1 from ${assignmentSubmissions} l where l.assignment_id = mi.id and l.status = 'pending'))))`;

/** An assignment's thread ("assignments" tab). */
export const assignmentSql = () =>
  sql`exists (select 1 from ${assignments} mi where mi.thread_id = ${THREAD_ID})`;

export type ThreadRow = typeof threads.$inferSelect;

export interface Viewer {
  workspaceId: string;
  userId: string;
  role: Role;
}

/** Builds the ThreadInfo of several rows at once (root, last reply, participants, follow). */
export async function threadInfos(db: Db, viewer: Viewer, rows: ThreadRow[]): Promise<ThreadInfo[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const roots = new Map(
    (await db.select().from(messages).where(inArray(messages.id, ids))).map((m) => [m.id, m]),
  );
  const chans = new Map(
    (
      await db
        .select({ id: channels.id, name: channels.name, kind: channels.kind })
        .from(channels)
        .where(
          inArray(
            channels.id,
            rows.map((r) => r.channelId),
          ),
        )
    ).map((ch) => [ch.id, ch]),
  );
  const replies = await db
    .select({
      threadId: messages.threadId,
      authorKind: messages.authorKind,
      authorId: messages.authorId,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(inArray(messages.threadId, ids))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const follows = new Map(
    (
      await db
        .select({ threadId: threadSubscriptions.threadId, following: threadSubscriptions.following })
        .from(threadSubscriptions)
        .where(and(inArray(threadSubscriptions.threadId, ids), eq(threadSubscriptions.userId, viewer.userId)))
    ).map((f) => [f.threadId, f.following]),
  );
  const flags = new Map(
    (
      await db
        .select({
          id: threads.id,
          working: workingSql().mapWith(Boolean),
          needsYou: needsYouSql(viewer).mapWith(Boolean),
        })
        .from(threads)
        .where(inArray(threads.id, ids))
    ).map((f) => [f.id, f]),
  );

  const assignmentInfo = new Map<string, NonNullable<ThreadInfo["assignment"]>>();
  for (const m of await db.select().from(assignments).where(inArray(assignments.threadId, ids))) {
    const live = m.plan.items.filter((i) => i.status !== "dropped");
    const role = await roleOf(db, viewer, m);
    assignmentInfo.set(m.threadId, {
      assignmentId: m.id,
      agentId: m.agentId,
      stepsDone: live.filter((i) => i.status === "done").length,
      stepsTotal: live.length,
      status: m.status,
      blockedOnYou: !isClosed(m) && canActRole(role) && (await waitingFor(db, viewer, m)),
      role,
    });
  }

  return rows.map((row) => {
    const root = roots.get(row.id);
    const chan = chans.get(row.channelId);
    const mine = replies.filter((r) => r.threadId === row.id);
    const last = mine.at(-1);
    const rootAuthor: ActorRef = root
      ? { type: root.authorKind, id: root.authorId }
      : { type: row.createdByType, id: row.createdById };
    const participants: ActorRef[] = [];
    for (const a of [rootAuthor, ...mine.map((m) => ({ type: m.authorKind, id: m.authorId }))]) {
      if (!participants.some((p) => p.type === a.type && p.id === a.id)) participants.push(a);
    }
    const createdBy: ActorRef = { type: row.createdByType, id: row.createdById };
    const isOwner =
      (createdBy.type === "person" && createdBy.id === viewer.userId) ||
      (rootAuthor.type === "person" && rootAuthor.id === viewer.userId);
    return {
      id: row.id,
      state: row.state,
      title: row.title,
      openingText: excerpt(root?.body ?? ""),
      channelId: row.channelId,
      channelName: chan?.name ?? "",
      venue: chan?.kind ?? "channel",
      createdBy,
      opener: rootAuthor,
      lastMessage: last
        ? {
            author: { type: last.authorKind, id: last.authorId },
            excerpt: excerpt(last.body),
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      assignment: assignmentInfo.get(row.id) ?? null,
      context: {
        channelId: row.sourceChannelId ?? row.channelId,
        count: mine.length,
        moved: row.sourceChannelId !== null,
        rootMessageId: row.rootMessageId,
        lastMessageId: row.lastMessageId,
        omittedMessageIds: row.omittedMessageIds,
      },
      participants,
      replyCount: root?.replyCount ?? mine.length,
      lastTouchedAt: row.lastTouchedAt.toISOString(),
      working: flags.get(row.id)?.working ?? false,
      actionNeeded: flags.get(row.id)?.needsYou ?? false,
      resolvedSuggestion: row.resolvedSuggestion,
      following: follows.get(row.id) ?? false,
      manageable: isOwner || can(viewer.role, "configure"),
      firstReplyAt: row.firstReplyAt?.toISOString() ?? null,
    };
  });
}

/** Tells the channel the thread changed. The client applies what came and fetches the rest. */
export async function publishThread(deps: AppDeps, threadId: string) {
  const [row] = await deps.db
    .select({
      id: threads.id,
      channelId: threads.channelId,
      state: threads.state,
      title: threads.title,
      lastTouchedAt: threads.lastTouchedAt,
      replyCount: messages.replyCount,
    })
    .from(threads)
    .innerJoin(messages, eq(messages.id, threads.id))
    .where(eq(threads.id, threadId));
  if (!row) return;
  deps.hub.toChannel(row.channelId, {
    type: "thread.info_changed",
    threadId: row.id,
    channelId: row.channelId,
    state: row.state,
    title: row.title,
    replyCount: row.replyCount,
    lastTouchedAt: row.lastTouchedAt.toISOString(),
  });
}
