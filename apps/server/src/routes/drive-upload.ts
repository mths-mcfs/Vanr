// The Drive's chunked upload (resumable): creates the session, sends the parts in order (each goes straight
// to a work file on disk, without putting the file together in memory), asks for the offset after the
// connection drops and completes. Completing writes the blob as a stream and creates the file (or the new
// version); repeating "complete" returns the same result.

import { mkdir, open, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UploadSession } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv, WorkspaceMember } from "../context";
import { addVersion, createFile, fileFor, sha256Of, titleSchema, toFileDetail, versionOf } from "../drive";
import { HttpError, notFound, param, readJson, readQuery } from "../http";
import { log } from "../logger";
import { requireMember, WORKSPACE } from "../workspace-scope";
import { me$, placement } from "./drive";

const { uploadSessions } = schema;
type SessionRow = typeof uploadSessions.$inferSelect;

/** The largest file per chunked upload (the size column is int4). */
export const MAX_RESUMABLE_BYTES = 1024 * 1024 * 1024;
export const PART_SIZE = 8 * 1024 * 1024;
/** A part larger than this is rejected (the browser may send the whole part at once). */
const MAX_PART_BYTES = 16 * 1024 * 1024;
const MAX_OPEN_PER_USER = 20;
const SESSION_MS = 24 * 60 * 60_000;
const STUCK_COMPLETE_MS = 10 * 60_000;
/** Space left on the disk after reserving the file. */
const DISK_MARGIN = 512 * 1024 * 1024;

const uploadDir = (deps: AppDeps) =>
  deps.config.dataDir === "memory" ? join(tmpdir(), "vanr-uploads") : join(deps.config.dataDir, "uploads");
const stagingPath = (deps: AppDeps, id: string) => join(uploadDir(deps), id);

function toSession(row: SessionRow): UploadSession {
  return {
    id: row.id,
    offset: row.received,
    size: row.size,
    partSize: PART_SIZE,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    fileId: row.resultFileId,
  };
}

/** The asker's session (another person's, another workspace's or an expired one: 404, like one that doesn't exist). */
async function sessionFor(deps: AppDeps, me: WorkspaceMember, id: string): Promise<SessionRow> {
  const [row] = await deps.db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, id),
        eq(uploadSessions.workspaceId, me.workspaceId),
        eq(uploadSessions.userId, me.userId),
      ),
    );
  if (!row || row.expiresAt <= deps.now()) throw notFound("Upload not found");
  return row;
}

const offsetMismatch = (row: SessionRow) =>
  new HttpError(409, "upload.offset_mismatch", "The server expects another offset", { offset: row.received });

async function dropSession(deps: AppDeps, id: string): Promise<void> {
  await rm(stagingPath(deps, id), { force: true });
  await deps.db.delete(uploadSessions).where(eq(uploadSessions.id, id));
}

/** Expired sessions: deletes the work file and the row (the runtime's tick). */
export async function expireUploads(deps: AppDeps): Promise<number> {
  const due = await deps.db
    .select({ id: uploadSessions.id })
    .from(uploadSessions)
    .where(lt(uploadSessions.expiresAt, deps.now()))
    .limit(100);
  for (const { id } of due) await dropSession(deps, id);
  return due.length;
}

export function registerDriveUploads(app: Hono<AppEnv>) {
  app.post(`${WORKSPACE}/files/uploads`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          fileName: z.string().trim().min(1).max(255),
          size: z.number().int().min(0),
          contentType: z.string().trim().max(200).optional(),
          title: titleSchema.optional(),
          channelId: z.string().optional(),
          threadId: z.string().optional(),
          note: z.string().trim().max(500).optional(),
          fileId: z.string().optional(),
          parentVersion: z.number().int().min(1).optional(),
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
        .strict(),
    );
    if (input.size > MAX_RESUMABLE_BYTES)
      throw new HttpError(413, "file.too_large", "File is larger than 1 GB", {
        maxBytes: MAX_RESUMABLE_BYTES,
      });
    // Where it will land is checked now (an error before sending 1 GB) and again when completing.
    if (input.fileId) {
      const row = await fileFor(deps.db, me.workspaceId, input.fileId, me$(me));
      if (row.kind !== "file")
        throw new HttpError(400, "file.kind_mismatch", `This file is a ${row.kind}`, {
          kind: row.kind,
        });
    } else await placement(deps, me, input.channelId, input.threadId);
    const now = deps.now();
    const [open_] = await deps.db
      .select({ n: count() })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.userId, me.userId),
          sql`${uploadSessions.expiresAt} > ${now}`,
          inArray(uploadSessions.status, ["open", "completing"]),
        ),
      );
    if ((open_?.n ?? 0) >= MAX_OPEN_PER_USER)
      throw new HttpError(429, "upload.too_many", "Finish or cancel other uploads first", {
        max: MAX_OPEN_PER_USER,
      });
    await mkdir(uploadDir(deps), { recursive: true });
    const disk = await statfs(uploadDir(deps)).catch(() => null);
    if (disk && disk.bavail * disk.bsize < input.size + DISK_MARGIN)
      throw new HttpError(507, "upload.no_space", "The server has no space for this file right now");
    const id = newId("upl");
    await (await open(stagingPath(deps, id), "w")).close();
    const [row] = await deps.db
      .insert(uploadSessions)
      .values({
        id,
        workspaceId: me.workspaceId,
        userId: me.userId,
        fileId: input.fileId ?? null,
        parentVersion: input.parentVersion ?? null,
        channelId: input.channelId ?? null,
        threadId: input.threadId ?? null,
        title: input.title ?? null,
        note: input.note ?? null,
        fileName: input.fileName,
        contentType: input.contentType || "application/octet-stream",
        size: input.size,
        sha256: input.sha256 ?? null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_MS),
      })
      .returning();
    if (!row) throw new Error("upload insert failed");
    return c.json(toSession(row));
  });

  app.get(`${WORKSPACE}/files/uploads/:uploadId`, async (c) => {
    const me = requireMember(c);
    return c.json(toSession(await sessionFor(c.get("deps"), me, param(c, "uploadId"))));
  });

  // A part, from the offset the server expects. The bytes are streamed to the work file; only afterwards
  // does the offset move (conditionally: two equal parts at once don't count twice).
  app.put(`${WORKSPACE}/files/uploads/:uploadId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await sessionFor(deps, me, param(c, "uploadId"));
    const { offset } = readQuery(c, z.object({ offset: z.coerce.number().int().min(0) }));
    if (row.status !== "open") throw new HttpError(409, "upload.closed", "This upload is already finishing");
    if (offset !== row.received) throw offsetMismatch(row);
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, "upload.empty_part", "The part is empty");
    const fh = await open(stagingPath(deps, row.id), "r+").catch(() => null);
    if (!fh) throw notFound("Upload not found");
    let n = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > MAX_PART_BYTES || offset + n > row.size) {
          await reader.cancel();
          throw new HttpError(413, "upload.part_too_large", "The part goes past the limit or the file size", {
            maxBytes: Math.min(MAX_PART_BYTES, row.size - offset),
          });
        }
        await fh.write(value, 0, value.length, offset + n - value.length);
      }
    } finally {
      await fh.close();
    }
    if (n === 0 && row.size > 0) throw new HttpError(400, "upload.empty_part", "The part is empty");
    const now = deps.now();
    const [moved] = await deps.db
      .update(uploadSessions)
      .set({ received: offset + n, updatedAt: now, expiresAt: new Date(now.getTime() + SESSION_MS) })
      .where(
        and(
          eq(uploadSessions.id, row.id),
          eq(uploadSessions.received, offset),
          eq(uploadSessions.status, "open"),
        ),
      )
      .returning();
    if (!moved) throw offsetMismatch(await sessionFor(deps, me, row.id));
    return c.json(toSession(moved));
  });

  app.post(`${WORKSPACE}/files/uploads/:uploadId/complete`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const id = param(c, "uploadId");
    const row = await sessionFor(deps, me, id);
    if (row.status === "done" && row.resultFileId) {
      const done = await fileFor(deps.db, me.workspaceId, row.resultFileId, me$(me));
      return c.json(toFileDetail(done, await versionOf(deps.db, done, row.resultVersion ?? undefined), me));
    }
    if (row.received < row.size)
      throw new HttpError(409, "upload.incomplete", "Send the rest of the file first", {
        offset: row.received,
      });
    const now = deps.now();
    const [claimed] = await deps.db
      .update(uploadSessions)
      .set({ status: "completing", updatedAt: now })
      .where(
        and(
          eq(uploadSessions.id, id),
          or(
            eq(uploadSessions.status, "open"),
            and(
              eq(uploadSessions.status, "completing"),
              lt(uploadSessions.updatedAt, new Date(now.getTime() - STUCK_COMPLETE_MS)),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed) throw new HttpError(409, "upload.completing", "This upload is already finishing");
    try {
      const staged = Bun.file(stagingPath(deps, id));
      if (staged.size !== row.size)
        throw new Error(`staged file has ${staged.size} bytes, expected ${row.size}`);
      const sha256 = await sha256Of(staged);
      if (row.sha256 && row.sha256 !== sha256) {
        await dropSession(deps, id);
        throw new HttpError(422, "upload.checksum_mismatch", "The file arrived different from what was sent");
      }
      const file = { blob: staged, sha256, fileName: row.fileName, contentType: row.contentType };
      const saved = row.fileId
        ? await addVersion(deps, {
            row: await fileFor(deps.db, me.workspaceId, row.fileId, me$(me)),
            author: me$(me),
            parentVersion: row.parentVersion ?? undefined,
            note: row.note,
            file,
          })
        : await createFile(deps, {
            workspaceId: me.workspaceId,
            title: row.title ?? row.fileName,
            author: me$(me),
            note: row.note,
            file,
            ...(await placement(deps, me, row.channelId ?? undefined, row.threadId ?? undefined)),
          });
      await deps.db
        .update(uploadSessions)
        .set({
          status: "done",
          resultFileId: saved.row.id,
          resultVersion: saved.version.version,
          updatedAt: deps.now(),
        })
        .where(eq(uploadSessions.id, id));
      await rm(stagingPath(deps, id), { force: true });
      return c.json(toFileDetail(saved.row, saved.version, me));
    } catch (err) {
      // Back to open: completing can be tried again (or cancelled).
      await deps.db
        .update(uploadSessions)
        .set({ status: "open", updatedAt: deps.now() })
        .where(and(eq(uploadSessions.id, id), eq(uploadSessions.status, "completing")));
      if (!(err instanceof HttpError)) log.warn("drive.upload_complete_failed", { uploadId: id, err });
      throw err;
    }
  });

  app.delete(`${WORKSPACE}/files/uploads/:uploadId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await sessionFor(deps, me, param(c, "uploadId"));
    if (row.status === "completing")
      throw new HttpError(409, "upload.completing", "This upload is finishing");
    await dropSession(deps, row.id);
    return c.body(null, 204);
  });
}
