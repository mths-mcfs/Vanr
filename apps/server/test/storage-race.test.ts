// Changing the bucket while a Drive file is being saved into it. The bytes reach the bucket, the test holds
// the save before its row is recorded and changes the destination, in both orders:
//   change first: the change finds no row yet and is accepted; the save then sees another destination, undoes
//     itself (the object leaves the old bucket, no row) and answers storage.destination_changed;
//   save first: the row is recorded, the change counts it and is rejected.
// Without the check at the row, the first order leaves a file whose download answers 404 (the visible defect).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { migrationDone, saveStorage, startMigration } from "../src/integrations/storage";
import type { RunningServer } from "../src/server";
import { type FakeS3, startFakeS3 } from "./fake-s3";
import { body, signedIn, startTestServer } from "./harness";
import { type Person, seedWorkspace } from "./seed";

let s3: FakeS3;
let server: RunningServer;
beforeAll(async () => {
  s3 = startFakeS3("workshop");
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" } });
});
afterAll(async () => {
  await server.stop();
  s3.stop();
});

let n = 0;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;
const dest = (prefix: string, bucket = "workshop") => ({
  endpoint: s3.endpoint,
  region: "us-east-1",
  bucket,
  prefix,
  pathAddressing: true,
  accessKeyId: "AKIAWORKSHOP",
  secretAccessKey: "bucket-secret-key",
});

async function team(prefix: string) {
  const ana = await signedIn(server, "Ana", `ana${++n}@storage-race.test`);
  const { workspaceId } = await seedWorkspace(server, ana, "Race");
  await saveStorage(server.deps, workspaceId, { kind: "s3", s3: dest(prefix) });
  return { workspaceId, ana };
}

function send(who: Person, workspaceId: string, text: string) {
  const form = new FormData();
  form.set("file", new File([text], `${text}.txt`));
  return who.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
}

/** Holds the next Drive write right after its bytes reached the store, before its row is recorded. */
function holdAfterPut() {
  const blobs = server.deps.blobs;
  const put = blobs.put.bind(blobs);
  let reached!: () => void;
  let release!: () => void;
  const sent = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  blobs.put = async (key, data, type) => {
    blobs.put = put;
    await put(key, data, type);
    reached();
    await gate;
  };
  return { sent, release };
}

const inBucket = (prefix: string, workspaceId: string) =>
  [...s3.objects.keys()].filter((k) => k.startsWith(`${prefix}/files/${workspaceId}/`));
const fileRows = async (workspaceId: string) =>
  server.deps.db.select().from(schema.files).where(eq(schema.files.workspaceId, workspaceId));

describe("a destination change racing a Drive write", () => {
  test("change first: accepted, and the write undoes itself instead of leaving an unreadable file", async () => {
    const { workspaceId, ana } = await team("old-a");
    const hold = holdAfterPut();
    const saving = send(ana, workspaceId, "raced");
    await hold.sent;
    expect(inBucket("old-a", workspaceId)).toHaveLength(1);
    const changed = await saveStorage(server.deps, workspaceId, { kind: "s3", s3: dest("new-a") });
    expect(changed.s3).toMatchObject({ prefix: "new-a" });
    hold.release();
    const res = await saving;
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("storage.destination_changed");
    expect(await fileRows(workspaceId)).toEqual([]);
    expect(inBucket("old-a", workspaceId)).toEqual([]);
    expect(inBucket("new-a", workspaceId)).toEqual([]);
    // Sending it again lands in the new destination and downloads.
    const again = await body(await send(ana, workspaceId, "raced"));
    expect(inBucket("new-a", workspaceId)).toHaveLength(1);
    expect(await (await ana.browser.fetch(`${W(workspaceId)}/files/${again.id}/blob`)).text()).toBe("raced");
  });

  test("write first: the row is counted and the change is rejected; the file still downloads", async () => {
    const { workspaceId, ana } = await team("old-b");
    const hold = holdAfterPut();
    const saving = send(ana, workspaceId, "first");
    await hold.sent;
    hold.release();
    const file = await body(await saving);
    await expect(
      saveStorage(server.deps, workspaceId, { kind: "s3", s3: dest("new-b") }),
    ).rejects.toMatchObject({
      status: 409,
      code: "storage.destination_in_use",
      params: { files: 1 },
    });
    expect(await (await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`)).text()).toBe("first");
  });

  test("in two steps (back to builtin, then another bucket) the same rule holds", async () => {
    const { workspaceId, ana } = await team("old-c");
    const file = await body(await send(ana, workspaceId, "kept"));
    await saveStorage(server.deps, workspaceId, { kind: "builtin" });
    for (const other of [
      dest("new-c"),
      dest("old-c", "other-bucket"),
      { ...dest("old-c"), endpoint: "http://127.0.0.2:9" },
    ])
      await expect(saveStorage(server.deps, workspaceId, { kind: "s3", s3: other })).rejects.toMatchObject({
        code: "storage.destination_in_use",
      });
    expect(await (await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`)).text()).toBe("kept");
  });

  test("files that also have a copy on the server's disk don't hold the bucket", async () => {
    const ana = await signedIn(server, "Ana", `ana${++n}@storage-race.test`);
    const { workspaceId } = await seedWorkspace(server, ana, "Local");
    const local = await body(await send(ana, workspaceId, "local"));
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: dest("copied") });
    await startMigration(server.deps, server.deps.localBlobs, workspaceId);
    await migrationDone(workspaceId);
    expect(inBucket("copied", workspaceId)).toHaveLength(1);
    const moved = await saveStorage(server.deps, workspaceId, { kind: "s3", s3: dest("elsewhere") });
    expect(moved.s3).toMatchObject({ prefix: "elsewhere" });
    expect(await (await ana.browser.fetch(`${W(workspaceId)}/files/${local.id}/blob`)).text()).toBe("local");
  });
});
