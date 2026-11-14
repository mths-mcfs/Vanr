// The usage ledger on Postgres: the same contract as the in-memory reference, on PGlite and on a real
// Postgres (the CI `postgres` job).
import { test } from "bun:test";
import { type Db, openDb, schema } from "@vanr/engine/db";
import { CONTRACT_PRICES, ledgerContract } from "@vanr/engine/usage-contract";
import { sql } from "drizzle-orm";
import { postgresLedger } from "../src/usage-ledger";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

/** One database per implementation; every contract test starts with an empty ledger and workspace `o1`. */
function fresh(open: () => Promise<Db>) {
  let db: Promise<Db> | null = null;
  return async () => {
    db ??= open();
    const d = await db;
    await d.execute(sql`truncate usage_lines, usage_reservation_scopes, usage_reservations, budget_counters`);
    await d.insert(schema.workspaces).values({ id: "o1", name: "Workspace" }).onConflictDoNothing();
    return postgresLedger(d, CONTRACT_PRICES);
  };
}

ledgerContract(
  "Postgres (PGlite)",
  fresh(async () => (await openDb({ kind: "pglite", dataDir: null })).db),
);

if (TEST_POSTGRES_URL)
  ledgerContract(
    "real Postgres",
    fresh(async () => (await openDb({ kind: "postgres", url: await testDatabaseUrl() })).db),
  );
else test.skip(`real Postgres (${NO_POSTGRES})`, () => {});
