// Memory: the three stores (agent, person, workspace), editing with the hash precondition, immutable versions
// and restore, the review queue; feedback on an answer and reminders.
import { can, type Memory, type MemoryVersion, type Message, type Reminder } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import {
  contentSha256,
  MEMORY_ITEM_MAX_BYTES,
  MEMORY_PATH_MAX,
  MemoryPathError,
  parseMemoryPath,
} from "@vanr/engine/memory";
import { and, asc, desc, eq, or } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import {
  type Author,
  changeMemory,
  createMemory,
  type MemoryRow,
  type MemoryVersionRow,
  memoryVersionsOf,
  restoreMemory,
  storeWhere,
} from "../agent-memory";
import { agentInWorkspace, toMemory } from "../agents";
import { canReadChannel, readableChannel, writableChannel } from "../channels";
import type { AppDeps, AppEnv, WorkspaceMember } from "../context";
import { badRequest, conflict, forbidden, notFound, param, readJson, readQuery } from "../http";
import { approveReview, rejectReview, reviewsFor, toMemoryReview } from "../memory-reviews";
import { channelNameOf, hydrateOne, memoriesFor, messageInWorkspace, postMessage } from "../messages";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { memories, reminders } = schema;

/** The longest text of a short note (`remember`) and of feedback on an answer; a file goes up to 100 kB. */
export const MEMORY_NOTE_MAX = 4000;
/** The longest reason of a change and note of a rejected review. */
export const MEMORY_REASON_MAX = 500;
/** The longest reminder text. */
export const REMINDER_TEXT_MAX = 500;
/** How far ahead a reminder may be set. */
export const REMINDER_HORIZON_MS = 366 * 24 * 3600 * 1000;
/** How many items a store listing returns. */
export const STORE_LIST_LIMIT = 2000;
/** How many reminders the list returns. */
export const REMINDER_LIST_LIMIT = 500;

/**
 * A memory item the person may see: in the agent's store (a workspace member), in the workspace's (a member) or
 * in their own store (only its owner; for anyone else, 404). `editable` says whether they may also change it.
 */
async function memoryFor(deps: AppDeps, me: WorkspaceMember, id: string) {
  const [row] = await deps.db
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.workspaceId, me.workspaceId)));
  if (!row) throw notFound("Memory not found");
  if (row.scope === "person") {
    if (row.ownerUserId !== me.userId) throw notFound("Memory not found");
    return { row, editable: true };
  }
  if (row.scope === "workspace") return { row, editable: can(me.role, "manage_agents") };
  const agent = await agentInWorkspace(deps.db, me.workspaceId, row.agentId ?? "");
  return { row, editable: can(me.role, "manage_agents") || agent.ownerUserId === me.userId };
}

async function editableMemory(deps: AppDeps, me: WorkspaceMember, id: string) {
  const found = await memoryFor(deps, me, id);
  if (!found.editable) throw forbidden();
  return found.row;
}

const person = (me: WorkspaceMember): Author => ({ type: "person", id: me.userId });

/** memory.recorded goes to the channel the memory came from, if any (only the agent's store). */
export async function publishMemory(deps: AppDeps, row: MemoryRow) {
  if (!row.originMessageId || row.scope !== "agent" || !row.agentId) return;
  const [origin] = await deps.db
    .select({ channelId: schema.messages.channelId })
    .from(schema.messages)
    .where(eq(schema.messages.id, row.originMessageId));
  if (!origin) return;
  deps.hub.toChannel(origin.channelId, {
    type: "memory.recorded",
    agentId: row.agentId,
    memory: toMemory(row),
  });
  const list = (await memoriesFor(deps.db, [row.originMessageId])).get(row.originMessageId) ?? [];
  deps.hub.toChannel(origin.channelId, {
    type: "message.memories_updated",
    messageId: row.originMessageId,
    memories: list,
  });
}

/** A file path inside a store (`clients/acme.md`), by the same rules as the memory tool. */
function storePath(raw: string): string {
  try {
    const p = parseMemoryPath(`/memories/workspace/${raw.replace(/^\/+/, "")}`);
    if (p.kind !== "store" || p.path === "" || p.path.startsWith("remembered/"))
      throw new MemoryPathError("pick a file name");
    return p.path;
  } catch (err) {
    if (err instanceof MemoryPathError) throw badRequest(`Invalid path: ${err.message}`, { field: "path" });
    throw err;
  }
}

const reason = z.string().trim().max(MEMORY_REASON_MAX).optional();

function toVersion(v: MemoryVersionRow): MemoryVersion {
  return {
    id: v.id,
    memoryId: v.memoryId,
    seq: v.seq,
    op: v.op,
    text: v.text,
    path: v.path,
    archived: v.archived,
    sha256: v.sha256,
    author: { type: v.authorKind, id: v.authorId },
    runId: v.runId,
    reason: v.reason,
    approvedByUserId: v.approvedByUserId,
    restoredFromSeq: v.restoredFromSeq,
    createdAt: v.createdAt.toISOString(),
  };
}

function toReminder(row: typeof reminders.$inferSelect): Reminder {
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    text: row.text,
    at: row.at.toISOString(),
    status: row.status,
    createdBy: { type: row.createdByType, id: row.createdById },
    createdAt: row.createdAt.toISOString(),
  };
}

const memoryList = (rows: MemoryRow[]): { memories: Memory[] } => ({ memories: rows.map(toMemory) });

export function registerMemories(app: Hono<AppEnv>) {
  // The agent's store (the person's and the workspace's have their own routes).
  app.get(`${WORKSPACE}/agents/:agentId/memories`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const agent = await agentInWorkspace(db, me.workspaceId, param(c, "agentId"));
    const about = readQuery(c, z.object({ about: z.string().max(200).optional() })).about || undefined;
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.agentId, agent.id),
          eq(memories.scope, "agent"),
          about ? eq(memories.about, about) : undefined,
        ),
      )
      .orderBy(desc(memories.pinned), desc(memories.updatedAt));
    return c.json(memoryList(rows));
  });

  // The person's store: what the agents kept about them. Only they see it.
  app.get(`${WORKSPACE}/memories/mine`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const rows = await db
      .select()
      .from(memories)
      .where(storeWhere({ scope: "person", workspaceId: me.workspaceId, userId: me.userId }))
      .orderBy(desc(memories.updatedAt))
      .limit(STORE_LIST_LIMIT);
    return c.json(memoryList(rows));
  });

  // The workspace's store: every member reads it (the agents too); only who manages agents writes.
  app.get(`${WORKSPACE}/memories/workspace`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const rows = await db
      .select()
      .from(memories)
      .where(storeWhere({ scope: "workspace", workspaceId: me.workspaceId }))
      .orderBy(memories.path)
      .limit(STORE_LIST_LIMIT);
    return c.json(memoryList(rows));
  });

  app.post(`${WORKSPACE}/memories`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          scope: z.enum(["workspace", "person"]),
          path: z.string().trim().min(1).max(MEMORY_PATH_MAX),
          // Characters never outnumber UTF-8 bytes: a longer text is too big before counting its bytes.
          text: z.string().min(1).max(MEMORY_ITEM_MAX_BYTES),
          reason,
        })
        .strict(),
    );
    if (input.scope === "workspace" && !can(me.role, "manage_agents")) throw forbidden();
    const at = deps.now();
    const row = await createMemory(
      deps.db,
      at,
      {
        workspaceId: me.workspaceId,
        agentId: null,
        scope: input.scope,
        ownerUserId: input.scope === "person" ? me.userId : null,
        path: storePath(input.path),
        text: input.text,
        source: "person",
        verified: true,
        origin: {
          by: { type: "person", id: me.userId },
          name: me.handle || null,
          channel: null,
          at: at.toISOString(),
        },
      },
      { author: person(me), reason: input.reason ?? "" },
    );
    return c.json(toMemory(row), 201);
  });

  // One PATCH changes the text (with the hash precondition), the path, the pin or the archive.
  app.patch(`${WORKSPACE}/memories/:memoryId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await editableMemory(deps, me, param(c, "memoryId"));
    const input = await readJson(
      c,
      z
        .object({
          // The same cap as feedback (4000) on short notes; a file goes up to 100 kB.
          text: z
            .string()
            .trim()
            .min(1)
            .max(row.path ? MEMORY_ITEM_MAX_BYTES : MEMORY_NOTE_MAX)
            .optional(),
          path: z.string().trim().min(1).max(MEMORY_PATH_MAX).optional(),
          pinned: z.boolean().optional(),
          archived: z.boolean().optional(),
          expectedSha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
          reason,
        })
        .strict()
        .refine(
          (v) => Object.keys(v).some((k) => k !== "expectedSha256" && k !== "reason"),
          "Nothing to change",
        ),
    );
    const textChanged = input.text !== undefined && input.text !== row.text;
    const op =
      input.archived === true
        ? "archive"
        : input.archived === false
          ? "unarchive"
          : input.path !== undefined && !textChanged
            ? "rename"
            : "update";
    const updated = await changeMemory(
      deps.db,
      deps.now(),
      row.id,
      {
        ...(textChanged
          ? { text: input.text, textBefore: row.text, editorUserId: me.userId, verified: true }
          : {}),
        ...(input.path !== undefined ? { path: storePath(input.path) } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      },
      { op, author: person(me), reason: input.reason ?? "", expectedSha256: input.expectedSha256 },
    );
    await publishMemory(deps, updated);
    return c.json(toMemory(updated));
  });

  // Brings back the text before the last edit by a person (it is a new version).
  app.post(`${WORKSPACE}/memories/:memoryId/revert`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await editableMemory(deps, me, param(c, "memoryId"));
    if (row.textBefore === null)
      throw conflict("memory.nothing_to_revert", "This memory has no earlier version");
    const updated = await changeMemory(
      deps.db,
      deps.now(),
      row.id,
      { text: row.textBefore, textBefore: row.text, editorUserId: me.userId },
      { op: "update", author: person(me), reason: "revert", expectedSha256: contentSha256(row.text) },
    );
    await publishMemory(deps, updated);
    return c.json(toMemory(updated));
  });

  app.get(`${WORKSPACE}/memories/:memoryId/versions`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { row } = await memoryFor(deps, me, param(c, "memoryId"));
    const versions: MemoryVersion[] = (await memoryVersionsOf(deps.db, row.id)).map(toVersion);
    return c.json({ versions });
  });

  // Restoring is rewriting: the chosen version comes back as a new version; no version changes.
  app.post(`${WORKSPACE}/memories/:memoryId/versions/:versionId/restore`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await editableMemory(deps, me, param(c, "memoryId"));
    const input = await readJson(c, z.object({ reason }).strict());
    const updated = await restoreMemory(
      deps.db,
      deps.now(),
      row.id,
      param(c, "versionId"),
      person(me),
      input.reason ?? "",
    );
    await publishMemory(deps, updated);
    return c.json(toMemory(updated));
  });

  // ---- review queue (a run's write under flag A) ----

  app.get(`${WORKSPACE}/memory-reviews`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const agentId = readQuery(c, z.object({ agentId: z.string().max(64).optional() })).agentId || undefined;
    return c.json({ reviews: (await reviewsFor(db, me, agentId)).map(toMemoryReview) });
  });

  app.post(`${WORKSPACE}/memory-reviews/:memoryReviewId/approve`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await approveReview(deps, me, param(c, "memoryReviewId"));
    return c.json(toMemoryReview(row));
  });

  app.post(`${WORKSPACE}/memory-reviews/:memoryReviewId/reject`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z.object({ note: z.string().trim().max(MEMORY_REASON_MAX).optional() }).strict(),
    );
    const row = await rejectReview(deps, me, param(c, "memoryReviewId"), input.note ?? null);
    return c.json(toMemoryReview(row));
  });

  // Feedback on an agent's answer: it goes into the answer's thread and becomes a lesson for the agent. Everything
  // that can reject it (the body, the message, the channel, the store's room and size) is checked before anything
  // shows: the lesson is written first (the store's checks), the message goes out after it, and a message that
  // can't go out takes the lesson back, so the two exist together or not at all.
  app.post(`${WORKSPACE}/messages/:messageId/feedback`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { db } = deps;
    const input = await readJson(
      c,
      z.object({ body: z.string().trim().min(1).max(MEMORY_NOTE_MAX) }).strict(),
    );
    const target = await messageInWorkspace(db, me.workspaceId, param(c, "messageId"));
    if (!target) throw notFound("Message not found");
    if (target.authorKind !== "agent") throw badRequest("Only agent replies take feedback");
    const viewer = { workspaceId: me.workspaceId, userId: me.userId, channelId: target.channelId };
    // The right to write, without joining the channel yet (joining is an effect).
    const { channel } = await readableChannel(db, viewer);
    const at = deps.now();
    const lesson = await createMemory(
      db,
      at,
      {
        workspaceId: me.workspaceId,
        agentId: target.authorId,
        scope: "agent",
        text: input.body,
        kind: "lesson",
        source: "feedback",
        verified: true,
        origin: {
          by: { type: "person", id: me.userId },
          name: null,
          channel: await channelNameOf(db, channel.id),
          at: at.toISOString(),
        },
      },
      { author: person(me), reason: "feedback" },
    );
    let messageId: string;
    try {
      const { message } = await postMessage(deps, {
        workspaceId: me.workspaceId,
        channel: await writableChannel(db, viewer),
        author: { type: "person", id: me.userId },
        body: input.body,
        clientId: `feedback:${target.id}:${newId("fb")}`,
        threadId: target.threadId ?? target.id,
        meta: { feedback: { messageId: target.id, agentId: target.authorId } },
      });
      messageId = message.id;
    } catch (err) {
      await db.delete(memories).where(eq(memories.id, lesson.id));
      throw err;
    }
    const [mem] = await db
      .update(memories)
      .set({ originMessageId: messageId })
      .where(eq(memories.id, lesson.id))
      .returning();
    if (mem) await publishMemory(deps, mem);
    const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    if (!row) throw notFound("Message not found");
    const posted: Message = await hydrateOne(db, row);
    return c.json(posted, 201);
  });

  // ---- reminders ----

  app.post(`${WORKSPACE}/reminders`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { db } = deps;
    const input = await readJson(
      c,
      z
        .object({
          channelId: z.string().min(1).max(64),
          threadId: z.string().min(1).max(64).optional(),
          agentId: z.string().min(1).max(64).optional(),
          text: z.string().trim().min(1).max(REMINDER_TEXT_MAX),
          at: z.string().datetime({ offset: true }),
        })
        .strict(),
    );
    const viewer = { workspaceId: me.workspaceId, userId: me.userId, channelId: input.channelId };
    // The right to write is checked here; joining a public channel (an effect) waits until nothing can reject it.
    const { channel } = await readableChannel(db, viewer);
    const at = new Date(input.at);
    const nowMs = deps.now().getTime();
    if (at.getTime() <= nowMs) throw badRequest("Pick a time in the future", { field: "at" });
    if (at.getTime() > nowMs + REMINDER_HORIZON_MS)
      throw badRequest("Pick a time within a year", { field: "at" });
    if (input.threadId) {
      const root = await messageInWorkspace(db, me.workspaceId, input.threadId);
      if (!root || root.channelId !== channel.id || root.threadId !== null) {
        throw badRequest("Thread not found in this channel", { field: "threadId" });
      }
    }
    if (input.agentId) {
      const agent = await agentInWorkspace(db, me.workspaceId, input.agentId);
      if (agent.archivedAt) throw notFound("Agent not found");
    }
    await writableChannel(db, viewer);
    const [row] = await db
      .insert(reminders)
      .values({
        id: newId("rem"),
        workspaceId: me.workspaceId,
        agentId: input.agentId ?? null,
        channelId: channel.id,
        threadId: input.threadId ?? null,
        text: input.text,
        at,
        createdByType: "person",
        createdById: me.userId,
      })
      .returning();
    if (!row) throw new Error("reminder insert returned nothing");
    return c.json(toReminder(row), 201);
  });

  // The reminders the person created and the agents' ones in the conversations they read.
  app.get(`${WORKSPACE}/reminders`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const rows = await db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.workspaceId, me.workspaceId),
          or(
            and(eq(reminders.createdByType, "person"), eq(reminders.createdById, me.userId)),
            eq(reminders.createdByType, "agent"),
          ),
        ),
      )
      .orderBy(asc(reminders.at))
      .limit(REMINDER_LIST_LIMIT);
    const visible = await readableIds(db, me, [...new Set(rows.map((r) => r.channelId))]);
    return c.json({
      reminders: rows.filter((r) => r.createdByType === "person" || visible.has(r.channelId)).map(toReminder),
    });
  });

  app.delete(`${WORKSPACE}/reminders/:reminderId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const [row] = await db
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, param(c, "reminderId")), eq(reminders.workspaceId, me.workspaceId)));
    if (!row) throw notFound("Reminder not found");
    const mine = row.createdByType === "person" && row.createdById === me.userId;
    if (!mine) {
      if (row.createdByType === "person") throw forbidden();
      await readableChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId: row.channelId });
    }
    if (row.status !== "scheduled") return c.json(toReminder(row));
    const [updated] = await db
      .update(reminders)
      .set({ status: "canceled" })
      .where(and(eq(reminders.id, row.id), eq(reminders.status, "scheduled")))
      .returning();
    return c.json(toReminder(updated ?? row));
  });
}

async function readableIds(db: Db, me: WorkspaceMember, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const channelId of ids) {
    if (await canReadChannel(db, { workspaceId: me.workspaceId, userId: me.userId, channelId }))
      out.add(channelId);
  }
  return out;
}
