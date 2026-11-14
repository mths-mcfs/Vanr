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

/**
 * Opens the database and applies the migrations: a real Postgres when there is a URL, otherwise
 * PGlite (Postgres compiled to WASM) in a directory or in memory, for development and tests.
 * The initial migration creates the `pg_trgm` extension, so PGlite loads it up front.
 */
export async function openDb(target: DbTarget): Promise<OpenDb> {
  if (target.kind === "postgres") {
    const sql = postgres(target.url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres({ client: sql, schema });
    await migratePostgres(db, { migrationsFolder: MIGRATIONS_DIR });
    return { db, kind: "postgres", close: () => sql.end({ timeout: 5 }) };
  }
  const extensions = { pg_trgm };
  const client = target.dataDir ? new PGlite(target.dataDir, { extensions }) : new PGlite({ extensions });
  const db = drizzlePglite({ client, schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, kind: "pglite", close: () => client.close() };
}

/** `DATABASE_URL` selects Postgres; otherwise PGlite under `DATA_DIR` (`memory` keeps it in memory). */
export function dbTargetFromEnv(env: { DATABASE_URL?: string; DATA_DIR?: string }): DbTarget {
  if (env.DATABASE_URL) return { kind: "postgres", url: env.DATABASE_URL };
  const dir = env.DATA_DIR ?? ".data";
  return { kind: "pglite", dataDir: dir === "memory" ? null : `${dir}/db` };
}
