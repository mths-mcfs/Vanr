// With Postgres the server is a single instance. These run only on a real Postgres (the CI `postgres` job).
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { INSTANCE_LOCK } from "../src/instance-lock";
import { signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("single instance on Postgres"), () => {
  test("the second instance doesn't start", async () => {
    const url = await testDatabaseUrl("inst");
    const first = await startTestServer({ env: { DATABASE_URL: url } });
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await signedIn(first, "Ana", "ana@instance.test");
      await expect(startTestServer({ env: { DATABASE_URL: url } })).rejects.toThrow(
        "A server instance already runs",
      );
      const held = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and objid = ${INSTANCE_LOCK} and granted`;
      expect(held[0]?.n).toBe(1);
    } finally {
      await first.stop();
    }
    // Once the first one stops, the lock goes with it and another one starts on the same database.
    const second = await startTestServer({ env: { DATABASE_URL: url } });
    try {
      expect((await fetch(`${second.url}/api/v1/health`)).ok).toBe(true);
    } finally {
      await second.stop();
      await sql.end({ timeout: 5 });
    }
  });
});

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("boot that fails after the lock"), () => {
  test("port in use: undoes the lock and the database, and the next attempt in the same process starts", async () => {
    const url = await testDatabaseUrl("boot");
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    const port = String(busy.port);
    try {
      // The lock and the migration pass; the listener fails. The error thrown is the listener's.
      await expect(startTestServer({ env: { DATABASE_URL: url, PORT: port } })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      const held = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and objid = ${INSTANCE_LOCK} and granted`;
      expect(held[0]?.n).toBe(0);
      // No server connection stayed open (the lock's and Drizzle's pool), only this test's.
      const conns = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()`;
      expect(conns[0]?.n).toBe(0);
      await busy.stop(true);
      const retry = await startTestServer({ env: { DATABASE_URL: url, PORT: port } });
      try {
        expect((await fetch(`${retry.url}/api/v1/health`)).ok).toBe(true);
      } finally {
        await retry.stop();
      }
    } finally {
      await busy.stop(true);
      await sql.end({ timeout: 5 });
    }
  });
});
