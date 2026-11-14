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
import { confirmBlobs, DestinationChanged, discardBlob, StorageUnavailable } from "./integrations/storage";
import { log } from "./logger";
import { reindex } from "./search-index";

const { files, fileVersions } = schema;

export const EXTRACT_TIMEOUT_MS = 60_000;
/** A file larger than this is not read to extract (it stays without text and without a thumbnail). */
export const MAX_EXTRACT_BYTES = 100 * 1024 * 1024;
const STALE_MS = 10 * 60_000;
/** Attempts for a failure OF THE FILE (its content breaks the extractor); storage outages don't count. */
const MAX_ATTEMPTS = 3;
/**
 * The storage outage backoff: the first wait is 1 min, doubling up to 1 h per wait. After 24 h of waits the
 * version is marked with STORAGE_GAVE_UP, and once an hour a new pass tries it again (ready once the bucket
 * is back). The count of waits lives in the reason (`storage unavailable (wait N)`): the schema has no field
 * for it.
 */
export const STORAGE_BACKOFF = {
  firstMs: 60_000,
  maxMs: 60 * 60_000,
  giveUpMs: 24 * 60 * 60_000,
  recheckMs: 60 * 60_000,
};
export const STORAGE_GAVE_UP = "storage unavailable for over 24 h";
const STORAGE_WAIT = /^storage unavailable \(wait (\d+)\)$/;
const waitOf = (n: number) => Math.min(STORAGE_BACKOFF.firstMs * 2 ** (n - 1), STORAGE_BACKOFF.maxMs);
/** How long the first `n` waits add up to. */
const waitedFor = (n: number) =>
  Array.from({ length: n }, (_, i) => waitOf(i + 1)).reduce((a, b) => a + b, 0);
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
          // Marked after a long storage outage: tried again once an hour.
          and(
            eq(fileVersions.extractStatus, "failed"),
            eq(fileVersions.extractError, STORAGE_GAVE_UP),
            lt(fileVersions.extractClaimedAt, new Date(now.getTime() - STORAGE_BACKOFF.recheckMs)),
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
  // The thumbnail and the preview sent to a bucket are recorded only if it is still the saved destination.
  const saved = await deps.db.transaction(async (tx) => {
    await confirmBlobs(tx, written);
    return tx
      .update(fileVersions)
      .set({ ...set, extractClaimedAt: null })
      .where(sameVersion(v))
      .returning({ id: fileVersions.fileId });
  });
  // The version went away in the middle (the trash was emptied): what was written now would be orphaned.
  if (!saved.length) for (const key of written) await discardBlob(deps.blobs, key);
}

/**
 * The storage couldn't answer (or changed under the write): not the file's fault. The attempt is given back
 * and the version waits for the next one (1 min, doubling to 1 h); after 24 h of waits it is marked with
 * STORAGE_GAVE_UP, which a pass once an hour undoes when the bucket is back.
 */
async function waitForStorage(deps: AppDeps, v: VersionRow, written: string[]): Promise<void> {
  for (const key of written) await discardBlob(deps.blobs, key);
  const waits = Number(STORAGE_WAIT.exec(v.extractError ?? "")?.[1] ?? 0) + 1;
  const now = deps.now().getTime();
  const gaveUp = v.extractError === STORAGE_GAVE_UP || waitedFor(waits) > STORAGE_BACKOFF.giveUpMs;
  log.warn("drive.extract_storage_unavailable", { fileId: v.fileId, version: v.version, waits, gaveUp });
  const attempts = Math.max(0, v.extractAttempts - 1);
  await deps.db
    .update(fileVersions)
    .set(
      gaveUp
        ? {
            extractStatus: "failed",
            extractError: STORAGE_GAVE_UP,
            extractClaimedAt: new Date(now),
            extractAttempts: attempts,
          }
        : {
            extractStatus: "working",
            extractError: `storage unavailable (wait ${waits})`,
            // The stale-claim rule takes it back once the wait has passed.
            extractClaimedAt: new Date(now - STALE_MS + waitOf(waits)),
            extractAttempts: attempts,
          },
    )
    .where(and(eq(fileVersions.fileId, v.fileId), eq(fileVersions.version, v.version)));
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
    if (err instanceof StorageUnavailable || err instanceof DestinationChanged) {
      await waitForStorage(deps, v, written);
      return;
    }
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
