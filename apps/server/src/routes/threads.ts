import type { ThreadState } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { and, eq, ilike, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { readableChannel, readableChannelsSql } from "../channels";
import type { AppEnv, Ctx } from "../context";
import { badRequest, conflict, forbidden, notFound, param, readJson, readQuery } from "../http";
import { ensureThread, messageInWorkspace } from "../messages";
import {
  actionNeededSql,
  assignmentSql,
  publishThread,
  type ThreadRow,
  threadInfos,
  type Viewer,
  workingSql,
} from "../threads";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { threads, messages, threadSubscriptions } = schema;

const id = z.string().min(1).max(64);
const ThreadQuery = z.object({
  tab: z.enum(["all", "working", "closed", "archived", "assignments"]).default("all"),
  channelId: id.optional(),
  agentId: id.optional(),
  actionNeeded: z.literal("true").optional(),
  mine: z.literal("true").optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Opaque cursor: the last activity time and the id of the page's last thread. */
const encodeCursor = (row: ThreadRow) =>
  Buffer.from(`${row.lastTouchedAt.toISOString()}|${row.id}`).toString("base64url");

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, rowId] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime()) || !rowId)
    throw badRequest("Invalid cursor", { field: "cursor" });
  return { at: date, id: rowId };
}

async function listThreads(db: Db, viewer: Viewer, q: z.infer<typeof ThreadQuery>) {
  const where: SQL[] = [
    eq(threads.workspaceId, viewer.workspaceId),
    sql`${threads.channelId} in ${readableChannelsSql(viewer)}`,
  ];
  switch (q.tab) {
    case "all":
      where.push(sql`${threads.state} <> 'archived'`);
      break;
    case "closed":
      where.push(eq(threads.state, "closed"));
      break;
    case "archived":
      where.push(eq(threads.state, "archived"));
      break;
    case "working":
      where.push(workingSql());
      break;
    case "assignments":
      where.push(assignmentSql());
      break;
    default: {
      const _exhaustive: never = q.tab;
      return _exhaustive;
    }
  }
  if (q.channelId) where.push(eq(threads.channelId, q.channelId));
  if (q.agentId) {
    where.push(sql`exists (
      select 1 from ${messages} m where (m.id = ${threads.id} or m.thread_id = ${threads.id})
        and m.author_kind = 'agent' and m.author_id = ${q.agentId})`);
  }
  if (q.actionNeeded) where.push(actionNeededSql(viewer));
  if (q.mine) {
    where.push(sql`(
      (${threads.createdByType} = 'person' and ${threads.createdById} = ${viewer.userId})
      or exists (select 1 from ${messages} m where (m.id = ${threads.id} or m.thread_id = ${threads.id})
        and m.author_kind = 'person' and m.author_id = ${viewer.userId})
      or exists (select 1 from ${threadSubscriptions} f where f.thread_id = ${threads.id}
        and f.user_id = ${viewer.userId} and f.following))`);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    // A retracted root's text matches nothing: a search would tell what it said.
    const rootMatches = sql`exists (select 1 from ${messages} m where m.id = ${threads.id}
      and m.meta -> 'retracted' is null and m.body ilike ${like})`;
    const titleMatches = ilike(threads.title, like);
    const either = or(titleMatches, rootMatches);
    if (either) where.push(either);
  }
  if (q.cursor) {
    const cur = decodeCursor(q.cursor);
    where.push(
      sql`(${threads.lastTouchedAt}, ${threads.id}) < (${cur.at.toISOString()}::timestamptz, ${cur.id})`,
    );
  }
  const rows = await db
    .select()
    .from(threads)
    .where(and(...where))
    .orderBy(sql`${threads.lastTouchedAt} desc, ${threads.id} desc`)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    threads: await threadInfos(db, viewer, page),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
  };
}

async function loadThread(c: Ctx): Promise<{ viewer: Viewer; row: ThreadRow }> {
  const viewer = requireMember(c);
  const { db } = c.get("deps");
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, param(c, "threadId")), eq(threads.workspaceId, viewer.workspaceId)));
  if (!row) throw notFound("Thread not found");
  await readableChannel(db, {
    workspaceId: viewer.workspaceId,
    userId: viewer.userId,
    channelId: row.channelId,
  });
  return { viewer, row };
}

async function infoOf(c: Ctx, viewer: Viewer, threadId: string) {
  const { db } = c.get("deps");
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!row) throw notFound("Thread not found");
  const [info] = await threadInfos(db, viewer, [row]);
  if (!info) throw notFound("Thread not found");
  return info;
}

async function requireManage(c: Ctx, viewer: Viewer, row: ThreadRow) {
  const [info] = await threadInfos(c.get("deps").db, viewer, [row]);
  if (!info?.manageable) throw forbidden("Only who started the thread or an admin can change it");
}

/** The valid transitions of each action. "move" takes the thread out of the channel (it stays only in Threads); "return" brings it back. */
const ACTIONS = {
  close: { from: ["open"], to: "closed" },
  reopen: { from: ["closed"], to: "open" },
  archive: { from: ["open", "closed"], to: "archived" },
  unarchive: { from: ["archived"], to: "open" },
  move: { from: ["open", "closed"], to: null },
  return: { from: ["open", "closed"], to: null },
} as const satisfies Record<string, { from: readonly ThreadState[]; to: ThreadState | null }>;

export function registerThreads(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/threads`, async (c) => {
    const viewer = requireMember(c);
    return c.json(await listThreads(c.get("deps").db, viewer, readQuery(c, ThreadQuery)));
  });

  app.get(`${WORKSPACE}/channels/:channelId/threads`, async (c) => {
    const viewer = requireMember(c);
    const { db } = c.get("deps");
    const { channel } = await readableChannel(db, {
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      channelId: param(c, "channelId"),
    });
    const q = readQuery(c, ThreadQuery);
    return c.json(await listThreads(db, viewer, { ...q, channelId: channel.id }));
  });

  app.get(`${WORKSPACE}/threads/:threadId`, async (c) => {
    const { viewer, row } = await loadThread(c);
    return c.json(await infoOf(c, viewer, row.id));
  });

  // Opens a thread from a channel message (before any reply). Opening is idempotent: on a root that already
  // has a thread it answers that thread as it is and changes nothing (the title and the rest change only
  // through the PATCH, which checks who manages the thread).
  app.post(`${WORKSPACE}/threads`, async (c) => {
    const viewer = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z.object({ channelId: id, messageId: id, title: z.string().trim().max(200).optional() }),
    );
    await readableChannel(deps.db, {
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      channelId: input.channelId,
    });
    const root = await messageInWorkspace(deps.db, viewer.workspaceId, input.messageId);
    if (!root || root.channelId !== input.channelId) throw notFound("Message not found");
    if (root.threadId !== null) throw conflict("thread.not_root", "Replies can't start a thread");
    const at = deps.now();
    const created = await ensureThread(deps.db, {
      root,
      by: { type: "person", id: viewer.userId },
      at,
      title: input.title ?? "",
    });
    if (!created) return c.json(await infoOf(c, viewer, root.id), 200);
    await deps.db
      .insert(threadSubscriptions)
      .values({ threadId: root.id, userId: viewer.userId, following: true, updatedAt: at })
      .onConflictDoNothing();
    await publishThread(deps, root.id);
    return c.json(await infoOf(c, viewer, root.id), 201);
  });

  app.patch(`${WORKSPACE}/threads/:threadId`, async (c) => {
    const { viewer, row } = await loadThread(c);
    await requireManage(c, viewer, row);
    const deps = c.get("deps");
    const patch = await readJson(
      c,
      z
        .object({
          title: z.string().trim().max(200).optional(),
          rootMessageId: id.optional(),
          lastMessageId: id.optional(),
          omittedMessageIds: z.array(id).max(500).optional(),
        })
        // A body without anything to change is rejected here: an UPDATE with nothing to set can't run.
        .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "Nothing to change" }),
    );
    // The context cut only takes messages of the thread itself (or the root).
    for (const mid of [patch.rootMessageId, patch.lastMessageId, ...(patch.omittedMessageIds ?? [])]) {
      if (!mid || mid === row.id) continue;
      const m = await messageInWorkspace(deps.db, viewer.workspaceId, mid);
      if (!m || m.threadId !== row.id) throw badRequest("Message is not in this thread", { messageId: mid });
    }
    await deps.db
      .update(threads)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.rootMessageId !== undefined ? { rootMessageId: patch.rootMessageId } : {}),
        ...(patch.lastMessageId !== undefined ? { lastMessageId: patch.lastMessageId } : {}),
        ...(patch.omittedMessageIds !== undefined ? { omittedMessageIds: patch.omittedMessageIds } : {}),
      })
      .where(eq(threads.id, row.id));
    await publishThread(deps, row.id);
    return c.json(await infoOf(c, viewer, row.id));
  });

  // Undoes the thread: the replies stay, only the state (title, cut, follows) goes.
  app.delete(`${WORKSPACE}/threads/:threadId`, async (c) => {
    const { viewer, row } = await loadThread(c);
    await requireManage(c, viewer, row);
    const deps = c.get("deps");
    await deps.db.delete(threads).where(eq(threads.id, row.id));
    deps.hub.toChannel(row.channelId, {
      type: "thread.info_changed",
      threadId: row.id,
      channelId: row.channelId,
      removed: true,
    });
    return c.body(null, 204);
  });

  app.post(`${WORKSPACE}/threads/:threadId/:action`, async (c) => {
    const action = z
      .enum(["close", "reopen", "archive", "unarchive", "move", "return"])
      .safeParse(param(c, "action"));
    if (!action.success) throw notFound("Unknown thread action");
    const { viewer, row } = await loadThread(c);
    await requireManage(c, viewer, row);
    const rule = ACTIONS[action.data];
    if (!(rule.from as readonly ThreadState[]).includes(row.state)) {
      throw conflict("thread.invalid_state", `Can't ${action.data} a thread that is ${row.state}`, {
        state: row.state,
      });
    }
    const deps = c.get("deps");
    const at = deps.now();
    // One conditional UPDATE per action: two people acting at once can't both pass the check above and
    // write over each other (an archived thread closed by a click that read it open).
    const from = inArray(threads.state, [...rule.from]);
    const where =
      action.data === "move"
        ? and(eq(threads.id, row.id), from, isNull(threads.sourceChannelId))
        : action.data === "return"
          ? and(eq(threads.id, row.id), from, isNotNull(threads.sourceChannelId))
          : and(eq(threads.id, row.id), from);
    const set =
      action.data === "move"
        ? { sourceChannelId: row.channelId, lastTouchedAt: at }
        : action.data === "return"
          ? { sourceChannelId: null, lastTouchedAt: at }
          : { state: rule.to ?? row.state, lastTouchedAt: at };
    const [moved] = await deps.db.update(threads).set(set).where(where).returning({ id: threads.id });
    if (!moved) {
      const [now] = await deps.db.select().from(threads).where(eq(threads.id, row.id));
      if (!now) throw notFound("Thread not found");
      if (action.data === "move" && now.sourceChannelId !== null)
        throw conflict("thread.already_moved", "Thread is already out of the channel");
      if (action.data === "return" && now.sourceChannelId === null)
        throw conflict("thread.not_moved", "Thread is already in the channel");
      throw conflict("thread.invalid_state", `Can't ${action.data} a thread that is ${now.state}`, {
        state: now.state,
      });
    }
    await publishThread(deps, row.id);
    return c.json(await infoOf(c, viewer, row.id));
  });
}
