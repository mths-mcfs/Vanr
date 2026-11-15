// Durable engine (DBOS Transact 5.3.0). Whoever needs a workflow that
// survives a crash or a deploy registers the function here (`DBOS.registerWorkflow`, when the module is imported)
// and the server starts DBOS once with `launchDurable`. Today only the assignments use it.
//
// The rules came from tests of the engine, and each one has
// a test in the durable engine tests or the assignment engine tests:
// 1. Version fixed by a variable (`DURABLE_VERSION`, default "1"), never the code hash. With the hash,
//    every deploy leaves the open workflow orphaned (`PENDING` forever, a message with nobody listening).
//    DBOS reads `DBOS__APPVERSION`, but the `applicationVersion` set here wins; the variable is ours.
// 2. Stable workflow code and state in our tables, read only inside a step. A new step
//    in the middle of the loop gives a determinism `ERROR` in the workflows that were already running.
// 3. An unavoidable change of shape: `DBOS.patch` (never right before a waiting `recv`) or
//    `forkWorkflow`, which creates a new ID (whoever keeps the ID follows the new one).
// 4. Migration of the `dbos` schema once, under a Postgres lock, before `launch` (which starts with
//    `runMigrations: false`). Two instances starting together on a fresh database deadlocked.
// 5. Small pool (`DURABLE_POOL`, default 4): DBOS only takes a node-postgres pool and it adds to
//    Drizzle's; with the defaults, 3 instances went past 90 of the 100 connections.
// Recovery: `launch` resumes the `PENDING` workflows with the same app name, the same version and the
// same executor (`local`): one server per database, as today.
import { DBOS } from "@dbos-inc/dbos-sdk";
import postgres from "postgres";

/** Name of the application in DBOS. Recovery only picks up workflows with this name: do not change it. */
export const DURABLE_APP = "vanr";
export const DURABLE_SCHEMA = "dbos";
/** Key of the migration's `pg_advisory_lock` (fixed: two versions of the server use the same one). */
const MIGRATE_LOCK = 7_310_011;

export interface DurableConfig {
  /** The product's Postgres: the DBOS tables live in the `dbos` schema of the same database. */
  url: string;
  version: string;
  poolSize: number;
}

/**
 * Runs the DBOS migration once per database: whoever comes later waits for the lock and does nothing.
 * The wait is `pg_try_advisory_lock` in a loop, not `pg_advisory_lock`: the migration creates an index with
 * `CREATE INDEX CONCURRENTLY`, which waits for every running query in the database, including the one of whoever is
 * stuck on the lock; with the blocking lock the two instances locked each other (checked in
 * the durable engine tests).
 */
export async function migrateDurable(url: string): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "vanr_migrate" },
  });
  try {
    for (;;) {
      const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${MIGRATE_LOCK}) as ok`;
      if (row?.ok) break;
      await Bun.sleep(200);
    }
    try {
      await DBOS.migrate(url, { schemaName: DURABLE_SCHEMA });
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATE_LOCK})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

let owner: DurableConfig | null = null;

/**
 * Starts DBOS: migration under a lock, fixed version, small pool, warning-only log. The workflows have to be
 * registered before (when the module is imported). There is one DBOS per process: a second server in the same
 * process gets an error (the tests start one at a time).
 */
export async function launchDurable(cfg: DurableConfig): Promise<{ stop(): Promise<void> }> {
  if (owner) throw new Error("durable engine already launched in this process");
  owner = cfg;
  try {
    await migrateDurable(cfg.url);
    DBOS.setConfig({
      name: DURABLE_APP,
      systemDatabaseUrl: cfg.url,
      systemDatabaseSchemaName: DURABLE_SCHEMA,
      systemDatabasePoolSize: cfg.poolSize,
      applicationVersion: cfg.version,
      runMigrations: false,
      logLevel: "warn",
    });
    await DBOS.launch();
  } catch (err) {
    owner = null;
    throw err;
  }
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await DBOS.shutdown();
      } finally {
        owner = null;
      }
    },
  };
}
