// The Drive's extraction queue: each version of a file with text (PDF, Office, large text) or an image
// goes in as `pending`; the tick claims with SKIP LOCKED (two servers don't take the same one), extracts
// in a Worker with a deadline, saves the markdown per page and the thumbnail, and reindexes the file in
// the search. A claim that stalled (the server went down in the middle) goes back to the queue after
// 10 min; after 3 attempts it gives up with an error.
import { schema } from "@vanr/engine/db";
import { isLegacyOffice, isOffice, isTextual, SNIFF_BYTES, sniffType } from "@vanr/engine/file-type";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import sharp from "sharp";
import type { AppDeps } from "./context";
import type { Page } from "./drive-extract-core";
import { log } from "./logger";
import { reindex } from "./search-index";

const { files, fileVersions } = schema;

export const EXTRACT_TIMEOUT_MS = 60_000;
/** A file larger than this is not read to extract (it stays without text and without a thumbnail). */
export const MAX_EXTRACT_BYTES = 100 * 1024 * 1024;
const STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
/** An image with more pixels than this doesn't become a thumbnail (decompression bomb). */
const MAX_THUMB_PIXELS = 40_000_000;
const THUMB_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

/** Does this version have something to extract (text or a thumbnail)? */
export function extractable(type: string): boolean {
  return (
    type === "application/pdf" ||
    isTextual(type) ||
    isOffice(type) ||
    isLegacyOffice(type) ||
    THUMB_TYPES.test(type)
  );
}

/** Extracts in a Worker; past the deadline the Worker is terminated (a PDF that hangs doesn't hold the server). */
export function extractInWorker(
  bytes: Uint8Array,
  type: string,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<Page[]> {
  const worker = new Worker(new URL("./extract-worker.ts", import.meta.url).href);
  return new Promise<Page[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("extraction timed out"));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (e: MessageEvent<{ ok: boolean; pages?: Page[]; error?: string }>) => {
      done();
      if (e.data.ok) resolve(e.data.pages ?? []);
      else reject(new Error(e.data.error ?? "extraction failed"));
    };
    worker.onerror = (e) => {
      done();
      reject(new Error(e.message || "extraction worker crashed"));
    };
    worker.postMessage({ bytes, type }, [bytes.buffer as ArrayBuffer]);
  });
}

async function thumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(bytes, { limitInputPixels: MAX_THUMB_PIXELS, animated: false })
    .rotate()
    .resize(320, 320, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();
  return new Uint8Array(out);
}

/** Office to PDF through Gotenberg (LibreOffice). Only with GOTENBERG_URL; without Docker here, not verified. */
async function officeToPdf(url: string, bytes: Uint8Array, fileName: string): Promise<Uint8Array> {
  const form = new FormData();
  form.set("files", new Blob([bytes]), fileName);
  const res = await fetch(`${url}/forms/libreoffice/convert`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gotenberg ${res.status}`);
  const pdf = new Uint8Array(await res.arrayBuffer());
  if (sniffType(pdf.subarray(0, SNIFF_BYTES), "x.pdf") !== "application/pdf")
    throw new Error("gotenberg: not a PDF");
  return pdf;
}

type VersionRow = typeof fileVersions.$inferSelect;

/** Claims up to `batch` versions (pending, or stalled for more than 10 min). */
async function claim(deps: AppDeps, batch: number): Promise<VersionRow[]> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select({ fileId: fileVersions.fileId, version: fileVersions.version })
      .from(fileVersions)
      .where(
        or(
          eq(fileVersions.extractStatus, "pending"),
          and(
            eq(fileVersions.extractStatus, "working"),
            lt(fileVersions.extractClaimedAt, new Date(now.getTime() - STALE_MS)),
          ),
        ),
      )
      .orderBy(asc(fileVersions.createdAt))
      .limit(batch)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(fileVersions)
      .set({
        extractStatus: "working",
        extractClaimedAt: now,
        extractAttempts: sql`${fileVersions.extractAttempts} + 1`,
      })
      .where(
        or(...due.map((d) => and(eq(fileVersions.fileId, d.fileId), eq(fileVersions.version, d.version)))),
      )
      .returning();
  });
}

const sameVersion = (v: VersionRow) =>
  and(
    eq(fileVersions.fileId, v.fileId),
    eq(fileVersions.version, v.version),
    eq(fileVersions.extractStatus, "working"),
  );

async function finish(
  deps: AppDeps,
  v: VersionRow,
  set: Partial<VersionRow>,
  written: string[],
): Promise<void> {
  const saved = await deps.db
    .update(fileVersions)
    .set({ ...set, extractClaimedAt: null })
    .where(sameVersion(v))
    .returning({ id: fileVersions.fileId });
  // The version went away in the middle (the trash was emptied): what was written now would be orphaned.
  if (!saved.length) for (const key of written) await deps.blobs.delete(key).catch(() => undefined);
}

async function extractOne(deps: AppDeps, v: VersionRow, timeoutMs: number): Promise<void> {
  if (v.extractAttempts > MAX_ATTEMPTS) {
    await finish(deps, v, { extractStatus: "failed", extractError: "gave up after repeated failures" }, []);
    return;
  }
  const written: string[] = [];
  try {
    const handle = v.blobKey ? await deps.blobs.open(v.blobKey) : null;
    if (!handle) throw new Error("file not found");
    if (handle.size > MAX_EXTRACT_BYTES) throw new Error("file is too large to extract");
    const bytes = await handle.body.bytes();
    const type = v.detectedType ?? sniffType(bytes.subarray(0, SNIFF_BYTES), v.fileName ?? "") ?? "";
    const set: Partial<VersionRow> = { extractStatus: "ready", extractError: null };
    if (THUMB_TYPES.test(type)) {
      const key = `${v.blobKey}.thumb.webp`;
      await deps.blobs.put(key, await thumbnail(bytes), "image/webp");
      written.push(key);
      set.thumbKey = key;
    }
    let source: Uint8Array = bytes;
    let sourceType = type;
    const gotenberg = deps.config.drive.gotenbergUrl;
    if (gotenberg && (isOffice(type) || isLegacyOffice(type))) {
      const pdf = await officeToPdf(gotenberg, bytes, v.fileName ?? "file");
      const key = `${v.blobKey}.preview.pdf`;
      await deps.blobs.put(key, pdf, "application/pdf");
      written.push(key);
      set.previewKey = key;
      // The old formats (.doc, .xls, .ppt) only have text through the PDF.
      if (isLegacyOffice(type)) {
        source = pdf;
        sourceType = "application/pdf";
      }
    }
    if (sourceType === "application/pdf" || isTextual(sourceType) || isOffice(sourceType)) {
      // The Worker keeps the bytes (transferred): send a copy if the thumbnail still uses them.
      set.pages = await extractInWorker(source === bytes ? bytes.slice() : source, sourceType, timeoutMs);
    }
    await finish(deps, v, set, written);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "extraction failed";
    log.warn("drive.extract_failed", { fileId: v.fileId, version: v.version, err: message });
    // An error of the file (corrupt, large, deadline) is final; it is the stalled claim that goes back to the queue.
    await finish(deps, v, { extractStatus: "failed", extractError: message }, written);
  }
}

/** One round of the queue (the runtime's tick). Returns how many versions it handled. */
export async function extractPending(
  deps: AppDeps,
  opts: { batch?: number; timeoutMs?: number } = {},
): Promise<number> {
  const claimed = await claim(deps, opts.batch ?? 4);
  for (const v of claimed) await extractOne(deps, v, opts.timeoutMs ?? EXTRACT_TIMEOUT_MS);
  // Search: only the current version of each file counts.
  const ids = [...new Set(claimed.map((v) => v.fileId))];
  if (ids.length) {
    const current = await deps.db
      .select({ id: files.id, version: files.version })
      .from(files)
      .where(inArray(files.id, ids));
    for (const a of current)
      if (claimed.some((v) => v.fileId === a.id && v.version === a.version))
        await reindex(deps, { kind: "file", id: a.id });
  }
  return claimed.length;
}
