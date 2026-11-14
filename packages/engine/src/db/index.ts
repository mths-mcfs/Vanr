import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export { schema };
export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export const MIGRATIONS_DIR = new URL("../../drizzle", import.meta.url).pathname;

/** Where the database lives. A PGlite `dataDir` of null keeps it in memory. */
export type DbTarget = { kind: "postgres"; url: string } | { kind: "pglite"; dataDir: string | null };

export interface OpenDb {
  db: Db;
  kind: DbTarget["kind"];
  close(): Promise<void>;
}

/** Directories opened by this process. Two PGlite instances on one directory corrupt it silently. */
const openDirs = new Set<string>();

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/**
 * Takes the directory for this process: a registry inside the process, and a lock file created
 * exclusively with the pid across processes. The lock sits next to the directory, `<dir>.lock`:
 * PGlite will not initialize a new database in a directory that already holds a file. A lock whose process is gone is taken over.
 * Returns the release function.
 */
function lockDir(dataDir: string): () => void {
  const dir = resolve(dataDir);
  if (openDirs.has(dir)) throw new Error(`database directory ${dir} is already open in this process`);
  mkdirSync(dirname(dir), { recursive: true });
  const lock = `${dir}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      openDirs.add(dir);
      return () => {
        openDirs.delete(dir);
        try {
          if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
      let holder = Number.NaN;
      try {
        holder = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
      } catch {
        // Removed between the two calls: try again.
      }
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && processAlive(holder)) {
        throw new Error(`database directory ${dir} is already open by process ${holder}`);
      }
      rmSync(lock, { force: true });
    }
  }
  throw new Error(`could not lock database directory ${dir}`);
}

/** Runs `fn` once; later calls get the same promise. */
function once(fn: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => {
    done ??= fn();
    return done;
  };
}

/**
 * Opens the database and applies the migrations: a real Postgres when there is a URL, otherwise
 * PGlite (Postgres compiled to WASM) in a directory or in memory, for development and tests.
 * The initial migration creates the `pg_trgm` extension, so PGlite loads it up front. A PGlite
 * directory can only be open once at a time: a second open rejects instead of sharing it.
 */
export async function openDb(target: DbTarget): Promise<OpenDb> {
  if (target.kind === "postgres") {
    const sql = postgres(target.url, { max: 10, onnotice: () => {} });
    const close = once(() => sql.end({ timeout: 5 }));
    try {
      const db = drizzlePostgres({ client: sql, schema });
      await migratePostgres(db, { migrationsFolder: MIGRATIONS_DIR });
      return { db, kind: "postgres", close };
    } catch (e) {
      await close();
      throw e;
    }
  }
  const extensions = { pg_trgm };
  const release = target.dataDir ? lockDir(target.dataDir) : () => {};
  let client: PGlite | null = null;
  try {
    client = target.dataDir ? new PGlite(target.dataDir, { extensions }) : new PGlite({ extensions });
    const db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS_DIR });
    const opened = client;
    const close = once(async () => {
      try {
        await opened.close();
      } finally {
        release();
      }
    });
    return { db, kind: "pglite", close };
  } catch (e) {
    try {
      if (client && !client.closed) await client.close();
    } catch {
      // The open already failed; that error is the one to report.
    }
    release();
    throw e;
  }
}

/** `DATABASE_URL` selects Postgres; otherwise PGlite under `DATA_DIR` (`memory` keeps it in memory). */
export function dbTargetFromEnv(env: { DATABASE_URL?: string; DATA_DIR?: string }): DbTarget {
  if (env.DATABASE_URL) return { kind: "postgres", url: env.DATABASE_URL };
  const dir = env.DATA_DIR ?? ".data";
  return { kind: "pglite", dataDir: dir === "memory" ? null : `${dir}/db` };
}
