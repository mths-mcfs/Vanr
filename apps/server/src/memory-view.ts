// A memory as it leaves the server. Its origin names the channel it came from, and that name shows only to whoever
// reads that channel: a person's answer and a channel's broadcast both go through here, for memories and for the
// reviews of a memory write alike. The channel is found from the message the memory came from or, without one,
// from the run that wrote it (a delegation's run counts the channel it was asked from).
import type { Memory, MemoryReview } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { contentSha256 } from "@vanr/engine/memory";
import { and, inArray, sql } from "drizzle-orm";
import type { MemoryRow } from "./agent-memory";
import { readableChannelsSql } from "./channels";
import type { MemoryReviewRow } from "./memory-reviews";

const { messages, runs, channels } = schema;

/** Who reads the memory: a person (their readable channels) or everyone in one channel (a broadcast there). */
export type OriginViewer = { workspaceId: string; userId: string } | { channelId: string };

interface Source {
  channel: string | null | undefined;
  messageId: string | null;
  runId: string | null;
}

/** For each source, whether the viewer may see the name of its origin's channel. */
async function originShown(db: Db, viewer: OriginViewer, sources: Source[]): Promise<boolean[]> {
  const named = sources.filter((s) => s.channel);
  const messageIds = [...new Set(named.flatMap((s) => (s.messageId ? [s.messageId] : [])))];
  const runIds = [...new Set(named.flatMap((s) => (!s.messageId && s.runId ? [s.runId] : [])))];
  const fromMessages = messageIds.length
    ? await db
        .select({ id: messages.id, channelId: messages.channelId })
        .from(messages)
        .where(inArray(messages.id, messageIds))
    : [];
  const fromRuns = runIds.length
    ? await db
        .select({
          id: runs.id,
          channelId: sql<string | null>`coalesce(${runs.channelId}, ${runs.sourceChannelId})`,
        })
        .from(runs)
        .where(inArray(runs.id, runIds))
    : [];
  const channelOf = new Map<string, string | null>(
    [...fromMessages, ...fromRuns].map((r) => [r.id, r.channelId]),
  );
  const found = [...new Set([...channelOf.values()].filter((id): id is string => id !== null))];
  const readable =
    "channelId" in viewer
      ? new Set([viewer.channelId])
      : new Set(
          found.length
            ? (
                await db
                  .select({ id: channels.id })
                  .from(channels)
                  .where(
                    and(inArray(channels.id, found), sql`${channels.id} in ${readableChannelsSql(viewer)}`),
                  )
              ).map((r) => r.id)
            : [],
        );
  return sources.map((s) => {
    if (!s.channel) return true;
    const key = s.messageId ?? s.runId;
    const channelId = key ? channelOf.get(key) : undefined;
    return !!channelId && readable.has(channelId);
  });
}

function memoryOf(row: MemoryRow): Memory {
  return {
    id: row.id,
    agentId: row.agentId,
    scope: row.scope,
    path: row.path,
    sha256: contentSha256(row.text),
    text: row.text,
    kind: row.kind,
    about: row.about,
    pinned: row.pinned,
    archived: row.archived,
    verified: row.verified,
    untrustedSource: row.untrustedSource,
    uses: row.uses,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    source: row.source,
    origin: row.origin ?? null,
    replaces: row.replaces,
    editorUserId: row.editorUserId,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function reviewOf(row: MemoryReviewRow): MemoryReview {
  return {
    id: row.id,
    agentId: row.agentId,
    runId: row.runId,
    scope: row.scope,
    op: row.op,
    memoryId: row.memoryId,
    path: row.path,
    newPath: row.newPath,
    text: row.text,
    kind: row.kind,
    about: row.about,
    reasons: row.reasons.map((r) => r.source),
    origin: row.origin,
    tool: row.tool,
    status: row.status,
    note: row.note,
    deciderUserId: row.deciderUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    resultMemoryId: row.resultMemoryId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function viewMemories(db: Db, viewer: OriginViewer, rows: MemoryRow[]): Promise<Memory[]> {
  const shown = await originShown(
    db,
    viewer,
    rows.map((r) => ({
      channel: r.origin?.channel,
      messageId: r.originMessageId,
      runId: r.origin?.runId ?? null,
    })),
  );
  return rows.map((r, i) => {
    const memory = memoryOf(r);
    return memory.origin && !shown[i] ? { ...memory, origin: { ...memory.origin, channel: null } } : memory;
  });
}

export async function viewMemory(db: Db, viewer: OriginViewer, row: MemoryRow): Promise<Memory> {
  const [memory] = await viewMemories(db, viewer, [row]);
  if (!memory) throw new Error("memory view returned nothing");
  return memory;
}

export async function viewMemoryReviews(
  db: Db,
  viewer: OriginViewer,
  rows: MemoryReviewRow[],
): Promise<MemoryReview[]> {
  const shown = await originShown(
    db,
    viewer,
    rows.map((r) => ({
      channel: r.origin.channel,
      messageId: null,
      runId: r.runId ?? r.origin.runId ?? null,
    })),
  );
  return rows.map((r, i) => {
    const review = reviewOf(r);
    return shown[i] ? review : { ...review, origin: { ...review.origin, channel: null } };
  });
}

export async function viewMemoryReview(
  db: Db,
  viewer: OriginViewer,
  row: MemoryReviewRow,
): Promise<MemoryReview> {
  const [review] = await viewMemoryReviews(db, viewer, [row]);
  if (!review) throw new Error("memory review view returned nothing");
  return review;
}
