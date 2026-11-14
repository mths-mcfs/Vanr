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
  if (!row?.secret) throw new HttpError(400, "storage.keys_required", "Enter the access key and the secret");
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
  const test = await testS3(settingsOf(cfg, keys), randomId(10));
  if (!test.ok)
    throw new HttpError(400, "storage.test_failed", "The bucket did not pass the test", {
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
  return {
    async put(key, data, contentType) {
      const r = await route(key);
      await (r?.primary ?? base).put(key, data, contentType);
    },
    async get(key): Promise<Blob | null> {
      const r = await route(key);
      const first = r?.primary ?? base;
      const found = await first.get(key);
      if (found || !r) return found;
      const other = first === base ? r.s3 : base;
      return other ? other.get(key) : null;
    },
    async open(key) {
      const r = await route(key);
      const first = r?.primary ?? base;
      const found = await first.open(key);
      if (found || !r) return found;
      const other = first === base ? r.s3 : base;
      return other ? other.open(key) : null;
    },
    async delete(key) {
      const r = await route(key);
      await base.delete(key);
      if (r?.s3) await r.s3.delete(key);
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
