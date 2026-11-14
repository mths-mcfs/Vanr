// A real Postgres for the tests that don't fit in PGlite (the single-instance lock, the ledger on Postgres).
// They run only where a disposable Postgres is available: the CI `postgres` job starts one and passes its
// URL in VANR_TEST_POSTGRES_URL. Never point it at a database you care about: each call creates a database
// there and the server applies the migrations to it.
import postgres from "postgres";

export const TEST_POSTGRES_URL = process.env.VANR_TEST_POSTGRES_URL;

/** Why the real Postgres tests are skipped here, for the test names. */
export const NO_POSTGRES = "needs VANR_TEST_POSTGRES_URL (the CI postgres job)";

let databases = 0;

/** A new, empty database on the server of VANR_TEST_POSTGRES_URL: the tests never see each other's rows. */
export async function testDatabaseUrl(prefix = "t"): Promise<string> {
  if (!TEST_POSTGRES_URL) throw new Error(NO_POSTGRES);
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}_${databases++}`;
  const admin = postgres(TEST_POSTGRES_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  return url.toString();
}
