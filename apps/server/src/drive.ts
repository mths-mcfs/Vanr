// Drive: files with versions (structured content or an uploaded file in the BlobStore) and a 30-day trash.
// A channel's file only shows to whoever reads the channel; without a channel, to the whole workspace.
import type { ActorRef, File, FileContent, FileDetail, TrashedFile } from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { isTextual, SNIFF_BYTES, sniffType } from "@vanr/engine/file-type";
import { newId, randomId } from "@vanr/engine/ids";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { agentChannelsSql, canReadChannel, readableChannelsSql } from "./channels";
import type { AppDeps, WorkspaceMember } from "./context";
import { extractable } from "./drive-extract";
import { HttpError, notFound } from "./http";
import { confirmBlobs, discardBlob } from "./integrations/storage";
import { reindex, unindex } from "./search-index";

const { files, fileVersions } = schema;
export type FileRow = typeof files.$inferSelect;
export type FileVersionRow = typeof fileVersions.$inferSelect;

export const TRASH_DAYS = 30;
/** Sent in one form (the whole file goes through memory). Larger than this, a chunked upload. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** A text file up to this size keeps its text with it (search, preview and the agent's reading). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const fileContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), markdown: z.string().max(1_000_000) }),
  z.object({
    kind: z.literal("table"),
    columns: z.array(z.string().max(200)).min(1).max(100),
    rows: z.array(z.array(z.string().max(10_000)).max(100)).max(5000),
  }),
  z.object({
    kind: z.literal("diff"),
    files: z.array(z.object({ path: z.string().min(1).max(500), patch: z.string().max(1_000_000) })).max(200),
  }),
  z.object({ kind: z.literal("diagram"), mermaid: z.string().max(200_000) }),
  z.object({ kind: z.literal("html"), html: z.string().max(1_000_000) }),
]);
export type StructuredContent = z.infer<typeof fileContentSchema>;

export const titleSchema = z.string().trim().min(1).max(200);

const isPerson = (a: ActorRef, userId: string) => a.type === "person" && a.id === userId;

export function canDeleteFile(row: FileRow, me: WorkspaceMember | null): boolean {
  if (!me) return false;
  return isPerson(row.createdBy, me.userId) || can(me.role, "configure");
}

export function toFile(row: FileRow, me: WorkspaceMember | null): File {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    channelId: row.channelId,
    threadId: row.threadId,
    deletable: canDeleteFile(row, me),
  };
}

export function contentOf(v: FileVersionRow): FileContent {
  if (v.blobKey) {
    return {
      kind: "file",
      name: v.fileName ?? "file",
      contentType: v.contentType ?? "application/octet-stream",
      size: v.size ?? 0,
      text: v.text,
      detectedType: v.detectedType,
      extract: v.extractStatus,
      extractError: v.extractError,
      totalPages: v.pages?.length ?? 0,
      hasThumb: !!v.thumbKey,
      hasPreview: !!v.previewKey,
    };
  }
  const parsed = fileContentSchema.safeParse(v.content);
  return parsed.success ? parsed.data : { kind: "document", markdown: "" };
}

export function toFileDetail(row: FileRow, v: FileVersionRow, me: WorkspaceMember | null): FileDetail {
  return { ...toFile(row, me), content: contentOf(v), viewVersion: v.version, editable: !!me };
}

export function toTrashed(row: FileRow): TrashedFile {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    createdBy: row.createdBy,
    deletedAt: (row.deletedAt ?? row.updatedAt).toISOString(),
    expungeAt: (row.expungeAt ?? row.updatedAt).toISOString(),
  };
}

/** Who may see it: without a channel, the whole workspace; with one, whoever reads it (person) or is in it (agent). */
export async function canSeeFile(db: Db, row: FileRow, viewer: ActorRef): Promise<boolean> {
  if (!row.channelId) return true;
  if (viewer.type === "person") {
    return canReadChannel(db, { workspaceId: row.workspaceId, userId: viewer.id, channelId: row.channelId });
  }
  const [m] = await db
    .select({ id: schema.channelMemberships.memberId })
    .from(schema.channelMemberships)
    .where(
      and(
        eq(schema.channelMemberships.channelId, row.channelId),
        eq(schema.channelMemberships.memberType, "agent"),
        eq(schema.channelMemberships.memberId, viewer.id),
      ),
    );
  return !!m;
}

/** A live file (out of the trash) the actor sees; otherwise 404, the same as one that doesn't exist. */
export async function fileFor(db: Db, workspaceId: string, id: string, viewer: ActorRef): Promise<FileRow> {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.workspaceId, workspaceId)));
  if (!row || row.deletedAt || !(await canSeeFile(db, row, viewer))) throw notFound("File not found");
  return row;
}

export async function versionOf(db: Db, row: FileRow, version?: number): Promise<FileVersionRow> {
  const [v] = await db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, row.id), eq(fileVersions.version, version ?? row.version)));
  if (!v) throw notFound("Version not found");
  return v;
}

export function publishFile(deps: AppDeps, type: "file.created" | "file.updated", row: FileRow): void {
  const event = { type, file: toFile(row, null) };
  if (row.channelId) deps.hub.toChannel(row.channelId, event);
  else deps.hub.toWorkspace(row.workspaceId, event);
}

export function publishFileDeleted(deps: AppDeps, row: FileRow): void {
  const event = { type: "file.deleted", fileId: row.id, channelId: row.channelId };
  if (row.channelId) deps.hub.toChannel(row.channelId, event);
  else deps.hub.toWorkspace(row.workspaceId, event);
}

// Each write has a key of its own (version plus a random suffix). With the key from the version alone, two
// uploads on the same parentVersion wrote the file in the same place: the one that lost the race (409) had
// already overwritten the bytes of the one that won. The key lives in the version (`blobKey`), so the old
// ones remain.
const blobKey = (workspaceId: string, fileId: string, version: number) =>
  `files/${workspaceId}/${fileId}/${version}-${randomId(8)}`;

/** Writes the file and, if the database write doesn't happen, deletes what was left orphaned. */
async function withBlob<T>(
  deps: AppDeps,
  key: string | null,
  file: PreparedFile | null,
  write: () => Promise<T>,
): Promise<T> {
  if (!key || !file) return write();
  await deps.blobs.put(key, file.data, file.contentType);
  try {
    return await write();
  } catch (err) {
    // Deleted where it was sent, which is not always the destination saved now.
    await discardBlob(deps.blobs, key);
    throw err;
  }
}

/** Visibility in SQL (before the `limit`): no channel, or a channel the viewer reads (person) or is in (agent). */
export function visibleFilesSql(viewer: ActorRef, workspaceId: string): SQL {
  return or(
    isNull(files.channelId),
    sql`${files.channelId} in ${
      viewer.type === "person"
        ? readableChannelsSql({ workspaceId, userId: viewer.id })
        : agentChannelsSql(viewer.id)
    }`,
  ) as SQL;
}

/**
 * A file for a version: bytes in memory (agent, small form) or a Blob read as a stream (the work file of
 * a chunked upload, an old version restored).
 */
export type FilePayload = { fileName: string; contentType: string } & (
  | { bytes: Uint8Array }
  | { blob: globalThis.Blob; sha256?: string }
);

/** What the version records of the file: size, hash, type from the bytes and the text when it is small text. */
interface PreparedFile {
  data: Uint8Array | globalThis.Blob;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  detectedType: string | null;
  text: string | null;
}

export async function sha256Of(blob: globalThis.Blob): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of blob.stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

export async function prepareFile(file: FilePayload): Promise<PreparedFile> {
  const data = "bytes" in file ? file.bytes : file.blob;
  const size = "bytes" in file ? file.bytes.byteLength : file.blob.size;
  const head =
    "bytes" in file ? file.bytes.subarray(0, SNIFF_BYTES) : await file.blob.slice(0, SNIFF_BYTES).bytes();
  const sha256 =
    "bytes" in file
      ? new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex")
      : (file.sha256 ?? (await sha256Of(file.blob)));
  const detectedType = sniffType(head, file.fileName);
  // Small text stays with it (search, preview and the agent's reading at once); the rest goes to the queue.
  const inlineText =
    detectedType && (isTextual(detectedType) || detectedType === "text/html") && size <= MAX_TEXT_BYTES;
  const text = inlineText
    ? new TextDecoder("utf-8", { fatal: false }).decode(
        "bytes" in file ? file.bytes : await file.blob.bytes(),
      )
    : null;
  return { data, fileName: file.fileName, contentType: file.contentType, size, sha256, detectedType, text };
}

/** The FormData Bun's Request returns (the global DOM type is another one). */
export type Form = Awaited<ReturnType<Request["formData"]>>;

/** Reads the file from the multipart, with the limits and errors the screen understands. */
export async function readFormFile(form: Form): Promise<FilePayload> {
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "file_required", "Attach a file");
  if (!file.name.trim()) throw new HttpError(400, "file_name_required", "The file needs a name");
  if (file.size > MAX_UPLOAD_BYTES)
    throw new HttpError(413, "file.too_large", "File is larger than 50 MB", {
      maxBytes: MAX_UPLOAD_BYTES,
    });
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name.trim().slice(0, 255),
    contentType: file.type || "application/octet-stream",
  };
}

interface NewFile {
  workspaceId: string;
  title: string;
  author: ActorRef;
  channelId?: string | null;
  threadId?: string | null;
  note?: string | null;
}

/** Creates a file with version 1 (structured content or an uploaded file). */
export async function createFile(
  deps: AppDeps,
  input: NewFile & ({ content: StructuredContent } | { file: FilePayload }),
): Promise<{ row: FileRow; version: FileVersionRow }> {
  const { db } = deps;
  const id = newId("file");
  const at = deps.now();
  const kind = "file" in input ? "file" : input.content.kind;
  const key = "file" in input ? blobKey(input.workspaceId, id, 1) : null;
  const file = "file" in input ? await prepareFile(input.file) : null;
  const result = await withBlob(deps, key, file, () =>
    db.transaction(async (tx) => {
      await confirmBlobs(tx, [key]);
      const [row] = await tx
        .insert(files)
        .values({
          id,
          workspaceId: input.workspaceId,
          title: input.title,
          kind,
          version: 1,
          createdBy: input.author,
          updatedBy: input.author,
          channelId: input.channelId ?? null,
          threadId: input.threadId ?? null,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      const [version] = await tx
        .insert(fileVersions)
        .values({
          fileId: id,
          version: 1,
          author: input.author,
          note: input.note ?? null,
          createdAt: at,
          ...versionData(input, file, key),
        })
        .returning();
      if (!row || !version) throw new Error("file insert failed");
      return { row, version };
    }),
  );
  await reindex(deps, { kind: "file", id: result.row.id });
  publishFile(deps, "file.created", result.row);
  return result;
}

function versionData(
  input: { content: StructuredContent } | { file: FilePayload },
  file: PreparedFile | null,
  key: string | null,
): Partial<typeof fileVersions.$inferInsert> {
  if ("content" in input || !file) return { content: "content" in input ? input.content : null };
  return {
    blobKey: key,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
    sha256: file.sha256,
    detectedType: file.detectedType,
    text: file.text,
    extractStatus: !file.text && file.detectedType && extractable(file.detectedType) ? "pending" : "none",
  };
}

/**
 * A new version. A `parentVersion` other than the current one (someone saved first) answers 409, so the
 * screen shows the conflict instead of erasing the other person's change.
 */
export async function addVersion(
  deps: AppDeps,
  input: {
    row: FileRow;
    author: ActorRef;
    parentVersion?: number;
    title?: string;
    note?: string | null;
  } & ({ content: StructuredContent } | { file: FilePayload }),
): Promise<{ row: FileRow; version: FileVersionRow }> {
  const { db } = deps;
  const { row } = input;
  if (input.parentVersion !== undefined && input.parentVersion !== row.version)
    throw new HttpError(409, "file.version_conflict", "Someone saved a newer version", {
      currentVersion: row.version,
    });
  const kind = "file" in input ? "file" : input.content.kind;
  if (kind !== row.kind)
    throw new HttpError(400, "file.kind_mismatch", `This file is a ${row.kind}`, { kind: row.kind });
  const next = row.version + 1;
  const at = deps.now();
  const key = "file" in input ? blobKey(row.workspaceId, row.id, next) : null;
  const file = "file" in input ? await prepareFile(input.file) : null;
  const result = await withBlob(deps, key, file, () =>
    db.transaction(async (tx) => {
      await confirmBlobs(tx, [key]);
      // Only goes up if nobody went up first (two saves at once don't become the same version).
      const [updated] = await tx
        .update(files)
        .set({
          version: next,
          updatedBy: input.author,
          updatedAt: at,
          ...(input.title ? { title: input.title } : {}),
        })
        .where(and(eq(files.id, row.id), eq(files.version, row.version)))
        .returning();
      if (!updated)
        throw new HttpError(409, "file.version_conflict", "Someone saved a newer version", {
          currentVersion: row.version + 1,
        });
      const [version] = await tx
        .insert(fileVersions)
        .values({
          fileId: row.id,
          version: next,
          author: input.author,
          note: input.note ?? null,
          createdAt: at,
          ...versionData(input, file, key),
        })
        .returning();
      if (!version) throw new Error("version insert failed");
      return { row: updated, version };
    }),
  );
  await reindex(deps, { kind: "file", id: result.row.id });
  publishFile(deps, "file.updated", result.row);
  return result;
}

export async function fileBytes(deps: AppDeps, v: FileVersionRow) {
  return v.blobKey ? deps.blobs.get(v.blobKey) : null;
}

/** Sends it to the trash; it leaves the lists and is deleted for good after 30 days. */
export async function trashFile(deps: AppDeps, row: FileRow, by: ActorRef): Promise<FileRow> {
  const at = deps.now();
  // The trash and leaving the search in the same commit.
  const updated = await deps.db.transaction(async (tx) => {
    const [r] = await tx
      .update(files)
      .set({
        deletedAt: at,
        deletedBy: by,
        expungeAt: new Date(at.getTime() + TRASH_DAYS * 86_400_000),
        updatedAt: at,
      })
      .where(eq(files.id, row.id))
      .returning();
    if (r) await unindex(tx, deps, { kind: "file", id: r.id });
    return r;
  });
  if (!updated) throw notFound("File not found");
  publishFileDeleted(deps, updated);
  return updated;
}

export async function restoreFile(deps: AppDeps, row: FileRow): Promise<FileRow> {
  const [updated] = await deps.db
    .update(files)
    .set({ deletedAt: null, deletedBy: null, expungeAt: null, updatedAt: deps.now() })
    .where(eq(files.id, row.id))
    .returning();
  if (!updated) throw notFound("File not found");
  await reindex(deps, { kind: "file", id: updated.id });
  publishFile(deps, "file.created", updated);
  return updated;
}

/** Deletes for good what passed the trash's deadline (the runtime's tick). */
export async function purgeTrash(deps: AppDeps): Promise<number> {
  const due = await deps.db
    .select()
    .from(files)
    .where(and(isNotNull(files.deletedAt), lte(files.expungeAt, deps.now())))
    .orderBy(asc(files.expungeAt))
    .limit(100);
  if (due.length === 0) return 0;
  const versions = await deps.db
    .select()
    .from(fileVersions)
    .where(
      inArray(
        fileVersions.fileId,
        due.map((r) => r.id),
      ),
    );
  for (const v of versions)
    for (const key of [v.blobKey, v.thumbKey, v.previewKey]) if (key) await deps.blobs.delete(key);
  await deps.db.transaction(async (tx) => {
    await tx.delete(files).where(
      inArray(
        files.id,
        due.map((r) => r.id),
      ),
    );
    for (const r of due) await unindex(tx, deps, { kind: "file", id: r.id });
  });
  return due.length;
}
