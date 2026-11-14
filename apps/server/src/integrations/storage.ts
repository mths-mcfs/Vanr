// Workspace storage: Drive files live on the server's disk ("builtin") or in an S3 bucket of the
// workspace itself. The router decides by key: `files/<workspace>/...` goes to the workspace's S3 when it
// configured one; the rest (avatars, logo) always stays in the server's storage.
import type {
  S3Input,
  StorageConfig,
  StorageInput,
  StorageMigration,
  StorageTestResult,
} from "@vanr/contract";
import type { Blob, BlobStore } from "@vanr/engine/blobs";
import { type Db, schema } from "@vanr/engine/db";
import { randomId } from "@vanr/engine/ids";
import { createSealer, keyPreview, type Sealer } from "@vanr/engine/seal";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../context";
import { HttpError, notFound } from "../http";
import { log } from "../logger";
import { checkServerUrl } from "./net";
import { client, type S3Settings, s3Blobs, testS3 } from "./s3";

const { workspaceStorage, files, fileVersions } = schema;
type StorageRow = typeof workspaceStorage.$inferSelect;
type S3ConfigRow = schema.S3ConfigRow;
type StorageMigrationRow = schema.StorageMigrationRow;
interface S3Keys {
  accessKeyId: string;
  secretAccessKey: string;
}

const WORKSPACE_KEY = /^files\/([^/]+)\//;
const CACHE_MS = 5_000;

export const storageSealer = (authSecret: string): Sealer => createSealer(authSecret, "storage");

function toMigration(m: StorageMigrationRow | null): StorageMigration | null {
  return m ? { status: m.status, copied: m.copied, total: m.total, error: m.error } : null;
}

export function toStorageConfig(row: StorageRow | null): StorageConfig {
  if (!row) return { kind: "builtin", s3: null, transfer: null };
  return {
    kind: row.kind,
    s3: row.s3
      ? {
          ...row.s3,
          accessKeyIdPreview: row.accessKeyIdPreview ?? "",
          secretPreview: row.secretPreview ?? "",
        }
      : null,
    transfer: toMigration(row.transfer),
  };
}

export async function storageRow(db: Db, workspaceId: string): Promise<StorageRow | null> {
  const [row] = await db.select().from(workspaceStorage).where(eq(workspaceStorage.workspaceId, workspaceId));
  return row ?? null;
}

const cleanPrefix = (p: string | null) => (p ?? "").trim().replace(/^\/+|\/+$/g, "");

function settingsOf(cfg: S3ConfigRow, keys: S3Keys): S3Settings {
  return { ...cfg, prefix: cleanPrefix(cfg.prefix), ...keys };
}

/** The form's configuration plus the keys (the new ones or the ones already saved). */
async function resolveInput(
  deps: AppDeps,
  workspaceId: string,
  input: S3Input,
): Promise<{ cfg: S3ConfigRow; keys: S3Keys }> {
  const endpoint = (await checkServerUrl(input.endpoint, deps.config.integrations.allowPrivateNetworks))
    .toString()
    .replace(/\/$/, "");
  const cfg: S3ConfigRow = {
    endpoint,
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    prefix: cleanPrefix(input.prefix) || null,
    pathAddressing: input.pathAddressing,
  };
  if (input.accessKeyId && input.secretAccessKey)
    return {
      cfg,
      keys: { accessKeyId: input.accessKeyId.trim(), secretAccessKey: input.secretAccessKey.trim() },
    };
  const row = await storageRow(deps.db, workspaceId);
  if (!row?.secret)
    throw new HttpError(400, "storage.credentials_missing", "Enter the access key and the secret");
  return { cfg, keys: JSON.parse(storageSealer(deps.config.authSecret).open(row.secret)) as S3Keys };
}

export async function testStorage(
  deps: AppDeps,
  workspaceId: string,
  input: S3Input,
): Promise<StorageTestResult> {
  const { cfg, keys } = await resolveInput(deps, workspaceId, input);
  return probe(deps, cfg, keys);
}

const envOf = (deps: AppDeps): BucketEnv => ({
  track: (work, what) => deps.runtime.track(work, what),
  now: deps.now,
  allowPrivateNetworks: deps.config.integrations.allowPrivateNetworks,
});

/** The connection test, through the same bucket wrapper as every call (the probe's write has the short deadline). */
const probe = (deps: AppDeps, cfg: S3ConfigRow, keys: S3Keys) =>
  testS3(randomId(10), remoteStore(cfg, keys, envOf(deps), "call"));

/** Saves: S3 only after it passes the test. Going back to "builtin" keeps the S3 (the files stay there). */
export async function saveStorage(
  deps: AppDeps,
  workspaceId: string,
  input: StorageInput,
): Promise<StorageRow> {
  const at = deps.now();
  if (input.kind === "builtin") {
    const [row] = await deps.db
      .insert(workspaceStorage)
      .values({ workspaceId, kind: "builtin", updatedAt: at })
      .onConflictDoUpdate({ target: workspaceStorage.workspaceId, set: { kind: "builtin", updatedAt: at } })
      .returning();
    if (!row) throw new Error("storage upsert failed");
    storageCache.delete(workspaceId);
    return row;
  }
  const { cfg, keys } = await resolveInput(deps, workspaceId, input.s3);
  // Before the bucket test (no network for a change that can't be accepted anyway); the check that counts
  // is the one in the transaction below.
  await deps.db.transaction((tx) => assertDestinationFree(tx, deps.localBlobs, workspaceId, cfg));
  const test = await probe(deps, cfg, keys);
  if (!test.ok)
    throw new HttpError(400, "storage.bucket_check_failed", "The bucket did not pass the test", {
      steps: test.steps,
    });
  const values = {
    kind: "s3" as const,
    s3: cfg,
    secret: storageSealer(deps.config.authSecret).seal(JSON.stringify(keys)),
    accessKeyIdPreview: keyPreview(keys.accessKeyId),
    secretPreview: keyPreview(keys.secretAccessKey),
    updatedAt: at,
  };
  // Checking and saving are one step: the row lock waits for any Drive write that is recording a file
  // in the saved bucket right now (it holds the same row shared), and then counts that file too.
  const row = await deps.db.transaction(async (tx) => {
    await assertDestinationFree(tx, deps.localBlobs, workspaceId, cfg);
    const [saved] = await tx
      .insert(workspaceStorage)
      .values({ workspaceId, ...values })
      .onConflictDoUpdate({ target: workspaceStorage.workspaceId, set: values })
      .returning();
    if (!saved) throw new Error("storage upsert failed");
    return saved;
  });
  storageCache.delete(workspaceId);
  return row;
}

/** Where the objects live: changing any of these makes the files already written there unreachable. */
const sameDestination = (a: S3ConfigRow, b: S3ConfigRow) =>
  a.endpoint === b.endpoint && a.bucket === b.bucket && cleanPrefix(a.prefix) === cleanPrefix(b.prefix);

/**
 * The storage row read inside a transaction, locked: `update` by whoever changes the destination, `share` by
 * whoever records a file it just sent to the bucket. Both locks are taken through here (a seam the
 * Postgres race test replaces, to show the test fails without them).
 */
export const storageLock = {
  async row(tx: Db, workspaceId: string, mode: "update" | "share"): Promise<StorageRow | null> {
    const [row] = await tx
      .select()
      .from(workspaceStorage)
      .where(eq(workspaceStorage.workspaceId, workspaceId))
      .for(mode);
    return row ?? null;
  },
};

/** Locks the storage row and rejects a new destination while the saved one is the only copy of a file. */
async function assertDestinationFree(tx: Db, local: BlobStore, workspaceId: string, next: S3ConfigRow) {
  const current = await storageLock.row(tx, workspaceId, "update");
  if (!current?.s3 || sameDestination(current.s3, next)) return;
  const held = await filesOnlyInBucket(tx, local, workspaceId);
  if (held > 0)
    throw new HttpError(
      409,
      "storage.destination_in_use",
      "The saved bucket still holds this workspace's files; keep its endpoint, bucket and prefix",
      { files: held, endpoint: current.s3.endpoint, bucket: current.s3.bucket, prefix: current.s3.prefix },
    );
}

/**
 * How many of the workspace's stored files (any version's blob, thumbnail or preview, in the trash too) exist
 * only in the bucket. The rows don't say where their bytes are; like the router, a key that is not on the
 * server's disk is read from the saved bucket, so that bucket is its only copy.
 */
async function filesOnlyInBucket(tx: Db, local: BlobStore, workspaceId: string): Promise<number> {
  const rows = await tx
    .select({ blob: fileVersions.blobKey, thumb: fileVersions.thumbKey, preview: fileVersions.previewKey })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(eq(files.workspaceId, workspaceId));
  let held = 0;
  for (const r of rows)
    for (const key of [r.blob, r.thumb, r.preview]) if (key && !(await local.open(key))) held++;
  return held;
}

/** The bucket failed (down, rejected the call, timed out): not the same as a file that doesn't exist. */
export class StorageUnavailable extends HttpError {
  /** What the bucket answered (logged and shown by the connection test; never sent to a download). */
  readonly reason: unknown;
  constructor(
    message = "The file storage is unavailable right now; try again in a moment",
    reason?: unknown,
  ) {
    super(503, "storage.unavailable", message);
    this.name = "StorageUnavailable";
    this.reason = reason;
  }
}

/** The destination changed while a file was being saved there; the save was undone. */
export class DestinationChanged extends HttpError {
  constructor() {
    super(
      409,
      "storage.destination_changed",
      "The storage changed while the file was being saved; send it again",
    );
    this.name = "DestinationChanged";
  }
}

/**
 * The one place that reads what the bucket's client threw: the object isn't there (404 of the object) or
 * the bucket can't answer now (403, 5xx, 301, a deadline, the network, a body that breaks in the middle).
 * A 403 is never "not found".
 */
function classify(what: string, key: string, err: unknown): HttpError {
  if (err instanceof HttpError && !["blocked_host", "unreachable", "invalid_url"].includes(err.code))
    return err;
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  if (code === "NoSuchKey") return notFound("This version has no file");
  log.warn("storage.bucket_failed", { err, what, key });
  return new StorageUnavailable(undefined, err);
}

/**
 * How long a bucket call may take before it counts as unavailable. `call` covers the short ones (HEAD, a
 * whole read of a small object, delete, list); `write` a whole upload; `piece` the wait for each next piece
 * of a streamed body. `late` is how long a write that missed its deadline is still waited for, so its
 * object can be deleted when it lands (beyond that it is logged as abandoned: the stop doesn't wait forever
 * for a bucket that never answers). Tests shorten them.
 */
export const bucketDeadlines = { callMs: 30_000, writeMs: 15 * 60_000, pieceMs: 60_000, lateMs: 60_000 };

class BucketDeadline extends Error {
  constructor(what: string, ms: number) {
    super(`bucket ${what} took longer than ${ms} ms`);
  }
}

/**
 * Where the server's bucket calls run: `track` keeps late work as background work (the server's stop waits
 * for it, so nothing runs after the database closes) and `now` is the injected clock.
 */
export interface BucketEnv {
  track: (work: Promise<unknown>, what: string) => void;
  now: () => Date;
  allowPrivateNetworks: boolean;
}

/**
 * Rejects past `ms`. The client's own request can't be cancelled, so it goes on: whoever gave up waiting still
 * owns it, and `undo` (when given) runs once it ends successfully, as background work.
 */
function within<T>(
  what: string,
  ms: number,
  work: Promise<T>,
  late?: { env: BucketEnv; undo: () => Promise<unknown> },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BucketDeadline(what, ms));
      if (late) {
        const giveUp = bucketDeadlines.lateMs;
        let abandon: ReturnType<typeof setTimeout> | undefined;
        const abandoned = new Promise<void>((resolve) => {
          abandon = setTimeout(() => {
            log.warn("storage.late_write_abandoned", { what, waitedMs: giveUp });
            resolve();
          }, giveUp);
        });
        const undone = work.then(
          () => late.undo(),
          () => undefined,
        );
        late.env.track(
          Promise.race([undone, abandoned]).finally(() => clearTimeout(abandon)),
          `storage.undo_late_${what}`,
        );
      }
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function bucket<T>(
  what: string,
  key: string,
  call: () => Promise<T>,
  ms = bucketDeadlines.callMs,
  late?: { env: BucketEnv; undo: () => Promise<unknown> },
): Promise<T> {
  try {
    return await within(what, ms, call(), late);
  } catch (err) {
    throw classify(what, key, err);
  }
}

/** The bucket's lazy body: reading it (all, a slice or a stream) goes through the same classification. */
function guardedBody(inner: globalThis.Blob, key: string): globalThis.Blob {
  const read = <T>(call: () => Promise<T>) => bucket("read", key, call);
  return {
    size: inner.size,
    type: inner.type,
    slice: (start?: number, end?: number, type?: string) => guardedBody(inner.slice(start, end, type), key),
    bytes: () => read(() => inner.bytes()),
    arrayBuffer: () => read(() => inner.arrayBuffer()),
    text: () => read(() => inner.text()),
    json: () => read(() => inner.json()),
    formData: () => read(() => inner.formData()),
    // Lazy and unused by the server: its reads happen in Bun.Image, outside this classification.
    image: (options) => inner.image(options),
    stream: () => {
      const reader = inner.stream().getReader();
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          try {
            const { done, value } = await within("read", bucketDeadlines.pieceMs, reader.read());
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (err) {
            void reader.cancel(err).catch(() => {});
            controller.error(classify("read", key, err));
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
    },
  };
}

/** A saved bucket: every call and every body it hands out pass through `classify`; it knows where it points. */
interface RemoteStore extends BlobStore {
  destination: S3ConfigRow;
}

/** How long a bucket check's answer is kept, per destination, by the injected clock. */
export const BUCKET_CHECK_MS = 30_000;
const bucketChecks = new Map<string, { present: boolean; at: number }>();
/** The part of an S3 error the check reads (the client's error carries the bucket's code). */
const s3ErrorCode = z.object({ code: z.string() });

/**
 * Does the bucket exist for these keys? Asked with a listing of at most one key, the cheapest bucket-level
 * call the client has, and classified by the answer: a listing accepted, or AccessDenied (the bucket
 * answered and recognized the keys, they just can't list), is a bucket that is there; NoSuchBucket, keys it
 * doesn't recognize (InvalidAccessKeyId, SignatureDoesNotMatch...), 5xx, the network or the deadline are a
 * bucket that can't be reached.
 */
async function bucketIsThere(settings: S3Settings, key: string, allowPrivate: boolean): Promise<boolean> {
  try {
    await within(
      "check the bucket",
      bucketDeadlines.callMs,
      client(settings, allowPrivate).list({ maxKeys: 1, prefix: settings.prefix }),
    );
    return true;
  } catch (err) {
    const answer = s3ErrorCode.safeParse(err);
    if (answer.success && answer.data.code === "AccessDenied") return true;
    log.warn("storage.bucket_check_failed", { err, key });
    return false;
  }
}

function remoteStore(
  cfg: S3ConfigRow,
  keys: S3Keys,
  env: BucketEnv,
  /** Which deadline a write gets, read at each call (tests change the deadlines at run time). */
  writeDeadline: "write" | "call" = "write",
): RemoteStore {
  const settings = settingsOf(cfg, keys);
  const inner = s3Blobs(settings, env.allowPrivateNetworks);
  const destination = `${cfg.endpoint}|${cfg.bucket}|${settings.prefix}`;
  /**
   * The object is missing (its HEAD answered 404): a 404 without a body can't tell a missing object from a
   * missing bucket, so the bucket is checked; its answer is kept for BUCKET_CHECK_MS (a thousand missing
   * files don't make a thousand listings, and a bucket that comes back is seen within that time).
   */
  const missing = async (key: string) => {
    const now = env.now().getTime();
    const kept = bucketChecks.get(destination);
    const fresh = kept && now >= kept.at && now - kept.at < BUCKET_CHECK_MS;
    const present = fresh ? kept.present : await bucketIsThere(settings, key, env.allowPrivateNetworks);
    if (!fresh) bucketChecks.set(destination, { present, at: now });
    if (!present) throw new StorageUnavailable();
    return null;
  };
  // A write that ends after its deadline was given up: its object is deleted once it lands.
  const undoWrite = (key: string) => ({
    env,
    undo: () =>
      within("delete", bucketDeadlines.callMs, inner.delete(key)).catch((err: unknown) =>
        log.warn("storage.undo_late_write_failed", { err, key }),
      ),
  });
  return {
    destination: cfg,
    put: (key, data, type) =>
      bucket(
        "write",
        key,
        () => inner.put(key, data, type),
        writeDeadline === "write" ? bucketDeadlines.writeMs : bucketDeadlines.callMs,
        undoWrite(key),
      ),
    async get(key) {
      return (await bucket("read", key, () => inner.get(key))) ?? missing(key);
    },
    async open(key) {
      const handle = await bucket("read", key, () => inner.open(key));
      return handle ? { ...handle, body: guardedBody(handle.body, key) } : missing(key);
    },
    delete: (key) => bucket("delete", key, () => inner.delete(key)),
    keys: () => bucket("list", "", () => inner.keys()),
  };
}

/** Files sent to a bucket whose row isn't recorded yet: key -> the bucket they went to. */
const unconfirmed = new Map<string, RemoteStore>();

/**
 * Called in the transaction that records the rows of `keys`, before writing them: each key sent to a bucket
 * must have gone to the destination saved now. It holds the storage row shared until the commit, so a
 * destination change waits and then counts these rows; a change that came first makes this throw
 * `DestinationChanged` (the caller undoes the save with `discardBlob`).
 */
export async function confirmBlobs(tx: Db, keys: readonly (string | null)[]): Promise<void> {
  for (const key of keys) {
    const sent = key ? unconfirmed.get(key) : undefined;
    const workspaceId = key ? WORKSPACE_KEY.exec(key)?.[1] : undefined;
    if (!key || !sent || !workspaceId) continue;
    const row = await storageLock.row(tx, workspaceId, "share");
    if (!row?.s3 || !sameDestination(row.s3, sent.destination)) throw new DestinationChanged();
  }
  for (const key of keys) if (key) unconfirmed.delete(key);
}

/** Undoes a file whose row was not recorded: deletes it where it was actually sent. */
export async function discardBlob(blobs: BlobStore, key: string): Promise<void> {
  const sent = unconfirmed.get(key);
  unconfirmed.delete(key);
  await (sent ? sent.delete(key) : blobs.delete(key)).catch((err: unknown) =>
    log.warn("storage.discard_failed", { err, key }),
  );
}

// ---- Router ----

interface Route {
  primary: RemoteStore | null;
  /** The saved S3, even with the workspace back on "builtin": files written there stay readable. */
  s3: RemoteStore | null;
  at: number;
}
const storageCache = new Map<string, Route>();

async function routeOf(db: Db, authSecret: string, env: BucketEnv, workspaceId: string): Promise<Route> {
  const hit = storageCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const row = await storageRow(db, workspaceId);
  let s3: RemoteStore | null = null;
  if (row?.s3 && row.secret) {
    const keys = JSON.parse(storageSealer(authSecret).open(row.secret)) as S3Keys;
    s3 = remoteStore(row.s3, keys, env);
  }
  const route = { primary: row?.kind === "s3" ? s3 : null, s3, at: Date.now() };
  storageCache.set(workspaceId, route);
  return route;
}

/**
 * A BlobStore that follows each workspace's storage. A read tries the current place and then the other one
 * (a file from before the switch or from a migration in progress); a delete deletes in both.
 */
export function routedBlobs(
  base: BlobStore,
  ctx: () => { db: Db; authSecret: string } & BucketEnv,
): BlobStore {
  const route = async (key: string) => {
    const workspaceId = WORKSPACE_KEY.exec(key)?.[1];
    if (!workspaceId) return null;
    const { db, authSecret, track, now, allowPrivateNetworks } = ctx();
    return routeOf(db, authSecret, { track, now, allowPrivateNetworks }, workspaceId);
  };
  /**
   * Reads where the file should be and then in the other place. A bucket that fails doesn't stop the read
   * before the server's disk is checked; only when the file is nowhere and the bucket failed is the answer
   * `StorageUnavailable` (it may be in the bucket), not "doesn't exist".
   */
  const read = async <T>(key: string, how: (store: BlobStore) => Promise<T | null>): Promise<T | null> => {
    const r = await route(key);
    if (!r) return how(base);
    const order = r.primary ? [r.primary, base] : r.s3 ? [base, r.s3] : [base];
    let failed: StorageUnavailable | null = null;
    for (const store of order) {
      try {
        const found = await how(store);
        if (found) return found;
      } catch (err) {
        if (!(err instanceof StorageUnavailable)) throw err;
        failed = err;
      }
    }
    if (failed) throw failed;
    return null;
  };
  return {
    async put(key, data, contentType) {
      const r = await route(key);
      const target = r?.primary;
      if (!target) return base.put(key, data, contentType);
      await target.put(key, data, contentType);
      unconfirmed.set(key, target);
    },
    get: (key): Promise<Blob | null> => read(key, (store) => store.get(key)),
    open: async (key) => (await base.open(key)) ?? read(key, (store) => store.open(key)),
    async delete(key) {
      const r = await route(key);
      await base.delete(key);
      await r?.s3?.delete(key);
    },
    keys: () => base.keys(),
  };
}

// ---- Migration ----

const running = new Map<string, Promise<void>>();

/** Copies the workspace's Drive files from the server to its S3. The originals stay (nothing is lost). */
export async function startMigration(
  deps: AppDeps,
  base: BlobStore,
  workspaceId: string,
): Promise<StorageMigrationRow> {
  const row = await storageRow(deps.db, workspaceId);
  if (row?.kind !== "s3" || !row.s3 || !row.secret)
    throw new HttpError(400, "storage.not_s3", "Save an S3 bucket before moving the files");
  if (row.transfer?.status === "running" && running.has(workspaceId)) return row.transfer;
  const prefix = `files/${workspaceId}/`;
  const keys = (await base.keys()).filter((k) => k.startsWith(prefix));
  const target = remoteStore(
    row.s3,
    JSON.parse(storageSealer(deps.config.authSecret).open(row.secret)) as S3Keys,
    envOf(deps),
  );
  const state: StorageMigrationRow = { status: "running", copied: 0, total: keys.length, error: null };
  const save = (m: StorageMigrationRow) =>
    deps.db
      .update(workspaceStorage)
      .set({ transfer: m, updatedAt: deps.now() })
      .where(eq(workspaceStorage.workspaceId, workspaceId));
  await save(state);
  const job = (async () => {
    try {
      for (const key of keys) {
        // Streamed (a large Drive file doesn't go into memory whole).
        const blob = await base.open(key);
        if (blob) await target.put(key, blob.body, blob.contentType);
        state.copied++;
        if (state.copied % 20 === 0) await save(state);
      }
      state.status = "done";
    } catch (err) {
      log.warn("storage.migration_failed", { err, workspaceId });
      state.status = "failed";
      state.error = err instanceof Error ? err.message.slice(0, 300) : "Copy failed";
    }
    await save(state);
  })().finally(() => running.delete(workspaceId));
  running.set(workspaceId, job);
  return { ...state };
}

/**
 * Boot: the copy runs in memory, so a restart in the middle left the migration "running" forever. It
 * starts over (copying again is safe: same key, same bytes); if the workspace no longer uses the bucket, it
 * is marked as failed.
 */
export async function resumeStorageMigrations(deps: AppDeps): Promise<void> {
  const stuck = await deps.db
    .select({ workspaceId: workspaceStorage.workspaceId, transfer: workspaceStorage.transfer })
    .from(workspaceStorage)
    .where(sql`${workspaceStorage.transfer}->>'status' = 'running'`);
  for (const { workspaceId, transfer } of stuck) {
    if (running.has(workspaceId)) continue;
    try {
      await startMigration(deps, deps.localBlobs, workspaceId);
    } catch (err) {
      log.warn("storage.migration_resume_failed", { err, workspaceId });
      await deps.db
        .update(workspaceStorage)
        .set({
          transfer: {
            ...(transfer as StorageMigrationRow),
            status: "failed",
            error: "Interrupted by a server restart",
          },
          updatedAt: deps.now(),
        })
        .where(eq(workspaceStorage.workspaceId, workspaceId));
    }
  }
}

/** Tests wait for the copy to end. */
export const migrationDone = (workspaceId: string) => running.get(workspaceId) ?? Promise.resolve();
