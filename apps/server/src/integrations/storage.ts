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
import type { AppDeps } from "../context";
import { HttpError } from "../http";
import { log } from "../logger";
import { checkServerUrl } from "./net";
import { type S3Settings, s3Blobs, testS3 } from "./s3";

const { workspaceStorage } = schema;
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
  return testS3(settingsOf(cfg, keys), randomId(10));
}

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
  await assertDestinationFree(deps, workspaceId, cfg);
  const test = await testS3(settingsOf(cfg, keys), randomId(10));
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
  const [row] = await deps.db
    .insert(workspaceStorage)
    .values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: workspaceStorage.workspaceId, set: values })
    .returning();
  if (!row) throw new Error("storage upsert failed");
  storageCache.delete(workspaceId);
  return row;
}

/** Where the objects live: changing any of these makes the files already written there unreachable. */
const sameDestination = (a: S3ConfigRow, b: S3ConfigRow) =>
  a.endpoint === b.endpoint && a.bucket === b.bucket && cleanPrefix(a.prefix) === cleanPrefix(b.prefix);

/**
 * The saved bucket is the only reference to the Drive files written there, and the migration only copies
 * from the server to a bucket. So a new endpoint, bucket or prefix is rejected while the saved destination
 * still holds a file of the workspace (or can't be listed to prove it holds none). New keys for the same
 * destination are accepted.
 */
async function assertDestinationFree(deps: AppDeps, workspaceId: string, next: S3ConfigRow): Promise<void> {
  const row = await storageRow(deps.db, workspaceId);
  if (!row?.s3 || !row.secret || sameDestination(row.s3, next)) return;
  const saved = s3Blobs(
    settingsOf(row.s3, JSON.parse(storageSealer(deps.config.authSecret).open(row.secret)) as S3Keys),
  );
  let held: number;
  try {
    held = (await saved.keys()).filter((k) => k.startsWith(`files/${workspaceId}/`)).length;
  } catch (err) {
    log.warn("storage.destination_list_failed", { err, workspaceId });
    throw new StorageUnavailable("The saved bucket can't be listed to check it holds no files");
  }
  if (held > 0)
    throw new HttpError(
      409,
      "storage.destination_in_use",
      "The saved bucket still holds this workspace's files; keep its endpoint, bucket and prefix",
      { files: held, endpoint: row.s3.endpoint, bucket: row.s3.bucket, prefix: row.s3.prefix },
    );
}

/** The bucket failed (down, rejected the call, timed out): not the same as a file that doesn't exist. */
export class StorageUnavailable extends HttpError {
  constructor(message = "The file storage is unavailable right now; try again in a moment") {
    super(503, "storage.unavailable", message);
    this.name = "StorageUnavailable";
  }
}

/** A bucket call whose failure becomes `StorageUnavailable` (logged once with the original error). */
async function bucket<T>(what: string, key: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof StorageUnavailable) throw err;
    log.warn("storage.bucket_failed", { err, what, key });
    throw new StorageUnavailable();
  }
}

// ---- Router ----

interface Route {
  primary: BlobStore | null;
  /** The saved S3, even with the workspace back on "builtin": files written there stay readable. */
  s3: BlobStore | null;
  at: number;
}
const storageCache = new Map<string, Route>();

async function routeOf(db: Db, authSecret: string, workspaceId: string): Promise<Route> {
  const hit = storageCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const row = await storageRow(db, workspaceId);
  let s3: BlobStore | null = null;
  if (row?.s3 && row.secret) {
    const keys = JSON.parse(storageSealer(authSecret).open(row.secret)) as S3Keys;
    s3 = s3Blobs(settingsOf(row.s3, keys));
  }
  const route = { primary: row?.kind === "s3" ? s3 : null, s3, at: Date.now() };
  storageCache.set(workspaceId, route);
  return route;
}

/**
 * A BlobStore that follows each workspace's storage. A read tries the current place and then the other one
 * (a file from before the switch or from a migration in progress); a delete deletes in both.
 */
export function routedBlobs(base: BlobStore, ctx: () => { db: Db; authSecret: string }): BlobStore {
  const route = async (key: string) => {
    const workspaceId = WORKSPACE_KEY.exec(key)?.[1];
    if (!workspaceId) return null;
    const { db, authSecret } = ctx();
    return routeOf(db, authSecret, workspaceId);
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
        const found = store === base ? await how(base) : await bucket("read", key, () => how(store));
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
      if (target) await bucket("write", key, () => target.put(key, data, contentType));
      else await base.put(key, data, contentType);
    },
    get: (key): Promise<Blob | null> => read(key, (store) => store.get(key)),
    open: (key) => read(key, (store) => store.open(key)),
    async delete(key) {
      const r = await route(key);
      await base.delete(key);
      const saved = r?.s3;
      if (saved) await bucket("delete", key, () => saved.delete(key));
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
  const target = s3Blobs(
    settingsOf(row.s3, JSON.parse(storageSealer(deps.config.authSecret).open(row.secret)) as S3Keys),
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
