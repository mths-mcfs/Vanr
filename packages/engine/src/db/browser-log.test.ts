import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { openDb, schema } from "./index";

const entry = (id: string) => ({
  id,
  workspaceId: "ws_1",
  agentId: "agt_1",
  runnerId: "run_1",
  tool: "browser_open",
  action: { url: "https://example.com/" },
  outcome: "ok" as const,
  at: new Date(),
});

/** The database error message, or "ok" when the statement went through. */
const result = (q: PromiseLike<unknown>) =>
  Promise.resolve(q).then(
    () => "ok",
    (e: Error & { cause?: { message?: string } }) => e.cause?.message ?? e.message,
  );

test("the browser log only grows: the database rejects UPDATE, DELETE and TRUNCATE", async () => {
  const { db, close } = await openDb({ kind: "pglite", dataDir: null });
  const log = schema.browserLogEntries;
  try {
    await db.insert(log).values([entry("ble_1"), entry("ble_2")]);
    // What an agent (or a bug) would do to erase the trail: change the URL, delete an entry, empty it.
    const rejected = "browser_log_entries is append-only";
    expect(await result(db.update(log).set({ url: "https://other.example/" }))).toContain(rejected);
    expect(await result(db.delete(log))).toContain(rejected);
    expect(await result(db.execute(sql`truncate browser_log_entries`))).toContain(rejected);
    expect((await db.select().from(log)).map((r) => r.url)).toEqual([null, null]);
    // Retention cleanup turns the switch on for its own transaction only.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.browser_log_purge', 'on', true)`);
      await tx.delete(log).where(sql`${log.id} = 'ble_1'`);
    });
    expect((await db.select().from(log)).map((r) => r.id)).toEqual(["ble_2"]);
    expect(await result(db.delete(log))).toContain(rejected);
  } finally {
    await close();
  }
});
