// The destination change against a Drive write on a real Postgres, from two connections (the CI `postgres`
// job). The write is held inside its own transaction, right after it read the storage row shared; the change
// runs on a second connection and must wait for that lock, then count the new row and be rejected.
//
// VANR_TEST_STORAGE_UNLOCKED=1 swaps the locked read for one without the lock (a double of `storageLock.row`):
// then the change doesn't wait, is accepted, and the file it leaves behind answers 404. The CI runs it that
// way too and expects this test to FAIL, which proves the test depends on the locks.
import { describe, expect, test } from "bun:test";
import { openDb, schema } from "@vanr/engine/db";
import { eq, sql } from "drizzle-orm";
import { saveStorage, storageLock } from "../src/integrations/storage";
import { startFakeS3 } from "./fake-s3";
import { body, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const UNLOCKED = process.env.VANR_TEST_STORAGE_UNLOCKED === "1";

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("storage destination race on Postgres"), () => {
  test("a write holding the storage row makes the change wait, then the change counts it and is rejected", async () => {
    const url = await testDatabaseUrl("storage");
    const s3 = startFakeS3("workshop");
    const server = await startTestServer({ env: { DATABASE_URL: url, ALLOW_PRIVATE_NETWORKS: "true" } });
    const second = await openDb({ kind: "postgres", url });
    const locked = storageLock.row;
    try {
      const ana = await signedIn(server, "Ana", "ana@storage-postgres.test");
      const { workspaceId } = await seedWorkspace(server, ana, "Race");
      const dest = (prefix: string) => ({
        endpoint: s3.endpoint,
        region: "us-east-1",
        bucket: "workshop",
        prefix,
        pathAddressing: true,
        accessKeyId: "AKIAWORKSHOP",
        secretAccessKey: "bucket-secret-key",
      });
      await saveStorage(server.deps, workspaceId, { kind: "s3", s3: dest("old") });

      const read: typeof locked = UNLOCKED
        ? async (tx, id) => {
            const [row] = await tx
              .select()
              .from(schema.workspaceStorage)
              .where(eq(schema.workspaceStorage.workspaceId, id));
            return row ?? null;
          }
        : locked;
      let reached!: () => void;
      let release!: () => void;
      const holding = new Promise<void>((r) => {
        reached = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let held = false;
      storageLock.row = async (tx, id, mode) => {
        const row = await read(tx, id, mode);
        if (mode === "share" && !held) {
          held = true;
          reached();
          await gate;
        }
        return row;
      };

      const form = new FormData();
      form.set("file", new File(["raced"], "raced.txt"));
      const saving = ana.browser.fetch(`/api/v1/workspaces/${workspaceId}/files/files`, {
        method: "POST",
        body: form,
      });
      await holding;
      // The change on the second connection.
      const changing = saveStorage({ ...server.deps, db: second.db }, workspaceId, {
        kind: "s3",
        s3: dest("new"),
      }).then(
        () => "accepted",
        (err: { code?: string }) => err.code ?? "error",
      );
      // Release the write once the change either waits for a lock or already ended.
      const waitingForLock = async () => {
        for (;;) {
          const rows = await server.deps.db.execute(
            sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
          );
          if (Array.isArray(rows) && rows.length) return;
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      await Promise.race([changing, waitingForLock()]);
      release();
      const saved = await saving;
      const outcome = await changing;

      expect(saved.status).toBe(200);
      const file = await body(saved);
      expect(outcome).toBe("storage.destination_in_use");
      const download = await ana.browser.fetch(`/api/v1/workspaces/${workspaceId}/files/${file.id}/blob`);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("raced");
    } finally {
      storageLock.row = locked;
      await second.close();
      await server.stop();
      s3.stop();
    }
  }, 60_000);
});
