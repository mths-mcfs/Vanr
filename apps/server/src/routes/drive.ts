// Drive: list, open (any version), download, upload a file, create and edit a document, trash.
import type { ActorRef, FileKind } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { isSafeInline, isTextual, SNIFF_BYTES, sniffType } from "@vanr/engine/file-type";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { writableChannel } from "../channels";
import type { AppDeps, AppEnv, Ctx, WorkspaceMember } from "../context";
import {
  addVersion,
  canDeleteFile,
  canSeeFile,
  createFile,
  type Form,
  fileContentSchema,
  fileFor,
  readFormFile,
  restoreFile,
  titleSchema,
  toFile,
  toFileDetail,
  toTrashed,
  trashFile,
  versionOf,
  visibleFilesSql,
} from "../drive";
import { conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { log } from "../logger";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { files, fileVersions, threads } = schema;
const KINDS = ["document", "table", "diff", "diagram", "html", "file"] as const satisfies readonly FileKind[];
/**
 * The inactivity limit of the Drive's transfers (download of a file, its thumbnail or preview; a form upload
 * and a part of a chunked upload): a slow phone between two cells may go quiet for a while without the
 * transfer being dead. Bun's per-request limit is used (`server.timeout`); the server option caps at 255 s
 * (measured: `idleTimeout: 256` is rejected). 120 s keeps a dead client from holding its connection for long.
 */
export const TRANSFER_IDLE_SECONDS = 120;
const TRANSFER_PATHS = [
  /\/files\/[^/]+\/blob$/,
  /\/files\/files$/,
  /\/files\/[^/]+\/files$/,
  /\/files\/uploads\/[^/]+$/,
];
export const isTransfer = (path: string) =>
  path.startsWith("/api/v1/workspaces/") && TRANSFER_PATHS.some((re) => re.test(path));

export const me$ = (me: WorkspaceMember): ActorRef => ({ type: "person", id: me.userId });
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

/** `Range: bytes=a-b` (a single range). null = no Range or a format we don't handle (send it all). */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // Suffix: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/**
 * The file's stream with its first piece already read: a storage failure before any byte goes out still
 * becomes an answer (503 `storage.unavailable`). After that the status is gone, so a failure ends the
 * connection and is logged with its reason.
 */
async function startStream(body: globalThis.Blob, fileId: string): Promise<ReadableStream<Uint8Array>> {
  const reader = body.stream().getReader();
  const first = await reader.read();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        log.warn("drive.download_interrupted", { fileId, err });
        controller.error(err);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

export async function placement(deps: AppDeps, me: WorkspaceMember, channelId?: string, threadId?: string) {
  if (!channelId) {
    if (threadId) throw new HttpError(400, "invalid_request", "threadId needs channelId");
    return { channelId: null, threadId: null };
  }
  await writableChannel(deps.db, { workspaceId: me.workspaceId, userId: me.userId, channelId });
  if (threadId) {
    const [t] = await deps.db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.channelId, channelId)));
    if (!t) throw notFound("Thread not found");
  }
  return { channelId, threadId: threadId ?? null };
}

function formText(form: Form, key: string, max: number): string | undefined {
  const v = form.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

async function readForm(c: Ctx): Promise<Form> {
  try {
    return await c.req.raw.formData();
  } catch {
    throw new HttpError(400, "file_required", "Send the file as multipart/form-data");
  }
}

async function liveFile(c: Ctx, me: WorkspaceMember) {
  return fileFor(c.get("deps").db, me.workspaceId, param(c, "fileId"), me$(me));
}

export function registerDrive(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/files`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const q = readQuery(
      c,
      z.object({
        q: z.string().trim().max(200).optional(),
        kind: z.enum(KINDS).optional(),
        channelId: z.string().optional(),
        authorKind: z.enum(["person", "agent"]).optional(),
        authorId: z.string().optional(),
      }),
    );
    const rows = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, me.workspaceId),
          isNull(files.deletedAt),
          visibleFilesSql(me$(me), me.workspaceId),
          q.q ? ilike(files.title, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
          q.kind ? eq(files.kind, q.kind) : undefined,
          q.channelId ? eq(files.channelId, q.channelId) : undefined,
          q.authorKind && q.authorId
            ? sql`${files.createdBy}->>'type' = ${q.authorKind} and ${files.createdBy}->>'id' = ${q.authorId}`
            : undefined,
        ),
      )
      .orderBy(desc(files.updatedAt))
      .limit(500);
    // The current version's thumbnail (the grid shows the image instead of the icon).
    const uploaded = rows.filter((r) => r.kind === "file");
    const thumbs = uploaded.length
      ? await db
          .select({ id: fileVersions.fileId, version: fileVersions.version })
          .from(fileVersions)
          .where(
            and(
              inArray(
                fileVersions.fileId,
                uploaded.map((r) => r.id),
              ),
              isNotNull(fileVersions.thumbKey),
            ),
          )
      : [];
    const withThumb = new Set(thumbs.map((v) => `${v.id}:${v.version}`));
    return c.json({
      files: rows.map((r) => ({ ...toFile(r, me), hasThumb: withThumb.has(`${r.id}:${r.version}`) })),
    });
  });

  app.get(`${WORKSPACE}/files/trash`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const rows = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.workspaceId, me.workspaceId),
          isNotNull(files.deletedAt),
          visibleFilesSql(me$(me), me.workspaceId),
        ),
      )
      .orderBy(desc(files.deletedAt))
      .limit(500);
    return c.json({ files: rows.map(toTrashed) });
  });

  app.post(`${WORKSPACE}/files`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          title: titleSchema,
          content: fileContentSchema,
          channelId: z.string().optional(),
          threadId: z.string().optional(),
          note: z.string().trim().max(500).optional(),
        })
        .strict(),
    );
    const where = await placement(deps, me, input.channelId, input.threadId);
    const { row, version } = await createFile(deps, {
      workspaceId: me.workspaceId,
      title: input.title,
      author: me$(me),
      content: input.content,
      note: input.note,
      ...where,
    });
    return c.json(toFileDetail(row, version, me));
  });

  app.post(`${WORKSPACE}/files/files`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const form = await readForm(c);
    const file = await readFormFile(form);
    const where = await placement(
      deps,
      me,
      formText(form, "channelId", 100),
      formText(form, "threadId", 100),
    );
    const { row, version } = await createFile(deps, {
      workspaceId: me.workspaceId,
      title: formText(form, "title", 200) ?? file.fileName,
      author: me$(me),
      file,
      ...where,
    });
    return c.json(toFileDetail(row, version, me));
  });

  app.get(`${WORKSPACE}/files/:fileId`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await liveFile(c, me);
    const { version } = readQuery(c, versionQuery);
    return c.json(toFileDetail(row, await versionOf(db, row, version), me));
  });

  app.get(`${WORKSPACE}/files/:fileId/text`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await liveFile(c, me);
    const { version } = readQuery(c, versionQuery);
    const v = await versionOf(db, row, version);
    const pages = v.pages ?? (v.text ? [{ page: 1, markdown: v.text }] : []);
    return c.json({ version: v.version, status: v.extractStatus, pages });
  });

  app.get(`${WORKSPACE}/files/:fileId/versions`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const row = await liveFile(c, me);
    const rows = await db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, row.id))
      .orderBy(desc(fileVersions.version));
    return c.json({
      versions: rows.map((v) => ({
        version: v.version,
        note: v.note,
        author: v.author,
        createdAt: v.createdAt.toISOString(),
      })),
    });
  });

  app.post(`${WORKSPACE}/files/:fileId/versions`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await liveFile(c, me);
    const input = await readJson(
      c,
      z
        .object({
          content: fileContentSchema,
          parentVersion: z.number().int().min(1),
          note: z.string().trim().max(500).optional(),
          title: titleSchema.optional(),
        })
        .strict(),
    );
    const saved = await addVersion(deps, { row, author: me$(me), ...input });
    return c.json(toFileDetail(saved.row, saved.version, me));
  });

  app.post(`${WORKSPACE}/files/:fileId/files`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await liveFile(c, me);
    const form = await readForm(c);
    const file = await readFormFile(form);
    const saved = await addVersion(deps, { row, author: me$(me), file, note: formText(form, "note", 500) });
    return c.json(toFileDetail(saved.row, saved.version, me));
  });

  // The link is good while the session is (the cookie authenticates the file route).
  app.get(`${WORKSPACE}/files/:fileId/download`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await liveFile(c, me);
    const { version } = readQuery(c, versionQuery);
    const v = await versionOf(deps.db, row, version);
    if (!v.blobKey) throw new HttpError(400, "file.not_a_file", "Only uploaded files can be downloaded");
    const url = `/api/v1/workspaces/${encodeURIComponent(me.workspaceId)}/files/${encodeURIComponent(row.id)}/blob?version=${v.version}&format=download`;
    return c.json({ url, expiresAt: new Date(deps.now().getTime() + 10 * 60_000).toISOString() });
  });

  // The version's file as a stream, with Range (video, audio, a large PDF). Served with the type the bytes
  // say, never the one the uploader declared: HTML named .png doesn't run on the app's origin.
  app.get(`${WORKSPACE}/files/:fileId/blob`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await liveFile(c, me);
    const q = readQuery(
      c,
      versionQuery.extend({
        format: z.enum(["inline", "download"]).default("inline"),
        variant: z.enum(["original", "thumb", "preview"]).default("original"),
      }),
    );
    const v = await versionOf(deps.db, row, q.version);
    const key = q.variant === "thumb" ? v.thumbKey : q.variant === "preview" ? v.previewKey : v.blobKey;
    const blob = key ? await deps.blobs.open(key) : null;
    if (!blob) throw new HttpError(404, "not_found", "This version has no file");
    const detected =
      q.variant === "thumb"
        ? "image/webp"
        : q.variant === "preview"
          ? "application/pdf"
          : (v.detectedType ?? sniffType(await blob.body.slice(0, SNIFF_BYTES).bytes(), v.fileName ?? ""));
    const type = detected ?? "application/octet-stream";
    const name = encodeURIComponent(
      q.variant === "preview" ? `${v.fileName ?? "file"}.pdf` : (v.fileName ?? "file"),
    );
    const headers: Record<string, string> = {
      "Content-Type": isTextual(type) ? "text/plain; charset=utf-8" : type,
      "Content-Disposition": `${q.format === "download" ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": q.version ? "private, max-age=31536000, immutable" : "private, no-cache",
    };
    // HTML, SVG and whatever the bytes don't confirm don't run a script on the app's origin.
    if (!isSafeInline(type)) headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
    const range = parseRange(c.req.header("range"), blob.size);
    if (range === "invalid")
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${blob.size}` },
      });
    if (range) {
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${blob.size}`;
      headers["Content-Length"] = String(range.end - range.start + 1);
      const part = await startStream(blob.body.slice(range.start, range.end + 1), row.id);
      return new Response(part, { status: 206, headers });
    }
    headers["Content-Length"] = String(blob.size);
    return new Response(await startStream(blob.body, row.id), { headers });
  });

  app.delete(`${WORKSPACE}/files/:fileId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await liveFile(c, me);
    if (!canDeleteFile(row, me)) throw forbidden("Only who created it or an admin can delete it");
    await trashFile(deps, row, me$(me));
    return c.body(null, 204);
  });

  app.post(`${WORKSPACE}/files/:fileId/restore`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const [row] = await deps.db
      .select()
      .from(files)
      .where(and(eq(files.id, param(c, "fileId")), eq(files.workspaceId, me.workspaceId)));
    if (!row || !(await canSeeFile(deps.db, row, me$(me)))) throw notFound("File not found");
    if (!row.deletedAt) throw conflict("file.not_deleted", "This file is not in the trash");
    if (!canDeleteFile(row, me)) throw forbidden("Only who created it or an admin can restore it");
    const restored = await restoreFile(deps, row);
    return c.json(toFileDetail(restored, await versionOf(deps.db, restored), me));
  });
}
