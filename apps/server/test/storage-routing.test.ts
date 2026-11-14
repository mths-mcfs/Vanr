// The routed blobs the boot wires in (integrations/storage): a workspace's Drive files go to its S3 bucket
// once it saved one (a real local fake S3 over HTTP), the old ones stay readable from the server, the
// migration copies them, going back to the builtin storage still reads what went to the bucket, and the rest
// of the keys (not under `files/<workspace>/`) never leave the server. The storage routes come with
// routes/integrations (S5); here the module's own functions are called, the same ones those routes call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import {
  migrationDone,
  resumeStorageMigrations,
  saveStorage,
  startMigration,
  storageRow,
  testStorage,
  toStorageConfig,
} from "../src/integrations/storage";
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
const email = (who: string) => `${who}${++n}@storage-routing.test`;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId } = await seedWorkspace(server, ana, "Workshop");
  return { workspaceId, ana };
}

async function upload(who: Person, workspaceId: string, text: string) {
  const form = new FormData();
  form.set("file", new File([text], `${text}.txt`, { type: "text/plain" }));
  const res = await who.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return body(res);
}
const read = async (who: Person, workspaceId: string, fileId: string) =>
  (await who.browser.fetch(`${W(workspaceId)}/files/${fileId}/blob`)).text();

const input = (prefix: string) => ({
  endpoint: s3.endpoint,
  region: "us-east-1",
  bucket: "workshop",
  prefix,
  pathAddressing: true,
  accessKeyId: "AKIAWORKSHOP",
  secretAccessKey: "bucket-secret-key",
});

describe("routed storage", () => {
  test("new Drive files go to the bucket, the old ones are read from the server, the migration copies, going back keeps reading", async () => {
    const { workspaceId, ana } = await team();
    expect(toStorageConfig(await storageRow(server.deps.db, workspaceId))).toEqual({
      kind: "builtin",
      s3: null,
      transfer: null,
    });
    const before = await upload(ana, workspaceId, "before");
    s3.failOn.add("LIST");
    await expect(
      saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("/vanr/") }),
    ).rejects.toMatchObject({
      code: "storage.test_failed",
    });
    s3.failOn.clear();
    expect((await testStorage(server.deps, workspaceId, input("vanr"))).ok).toBe(true);
    const saved = toStorageConfig(
      await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("/vanr/") }),
    );
    expect(saved).toMatchObject({
      kind: "s3",
      s3: {
        bucket: "workshop",
        prefix: "vanr",
        pathAddressing: true,
        accessKeyIdPreview: "…SHOP",
        secretPreview: "…-key",
      },
    });
    // The form again without the keys: the saved ones are used.
    expect(
      (
        await testStorage(server.deps, workspaceId, {
          ...input("vanr"),
          accessKeyId: undefined,
          secretAccessKey: undefined,
        })
      ).ok,
    ).toBe(true);
    expect(s3.unsigned).toBe(0);

    const after = await upload(ana, workspaceId, "after");
    const inBucket = [...s3.objects.keys()].filter((k) => k.startsWith(`vanr/files/${workspaceId}/`));
    expect(inBucket).toHaveLength(1);
    expect(inBucket[0]).toStartWith(`vanr/files/${workspaceId}/${after.id}/1-`);
    expect((await server.deps.localBlobs.keys()).some((k) => k.includes(after.id))).toBe(false);
    expect(await read(ana, workspaceId, after.id)).toBe("after");
    expect(await read(ana, workspaceId, before.id)).toBe("before");

    expect(await startMigration(server.deps, server.deps.localBlobs, workspaceId)).toMatchObject({
      status: "running",
      total: 1,
    });
    await migrationDone(workspaceId);
    expect(toStorageConfig(await storageRow(server.deps.db, workspaceId)).transfer).toEqual({
      status: "done",
      copied: 1,
      total: 1,
      error: null,
    });
    expect(
      [...s3.objects.keys()].some((k) => k.startsWith(`vanr/files/${workspaceId}/${before.id}/1-`)),
    ).toBe(true);

    // Back to the server's storage: what was written in the bucket stays readable.
    expect((await saveStorage(server.deps, workspaceId, { kind: "builtin" })).kind).toBe("builtin");
    expect(await read(ana, workspaceId, after.id)).toBe("after");
    await expect(startMigration(server.deps, server.deps.localBlobs, workspaceId)).rejects.toMatchObject({
      code: "storage.not_s3",
    });
  });

  test("another workspace and keys outside the Drive never go to a bucket", async () => {
    const one = await team();
    await saveStorage(server.deps, one.workspaceId, { kind: "s3", s3: input("only-one") });
    const two = await team();
    const file = await upload(two.ana, two.workspaceId, "local");
    expect([...s3.objects.keys()].some((k) => k.includes(file.id))).toBe(false);
    expect(
      (await server.deps.localBlobs.keys()).some((k) => k.startsWith(`files/${two.workspaceId}/${file.id}/`)),
    ).toBe(true);
    await server.deps.blobs.put(`avatars/${one.workspaceId}/x`, new Uint8Array([1]), "image/png");
    expect([...s3.objects.keys()].some((k) => k.includes("avatars/"))).toBe(false);
    expect(await server.deps.localBlobs.get(`avatars/${one.workspaceId}/x`)).not.toBeNull();
  });

  test("a migration stuck in running (the server went down): resuming starts over or marks it failed", async () => {
    const { workspaceId, ana } = await team();
    const old = await upload(ana, workspaceId, "old");
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("boot") });
    const stuck = { status: "running" as const, copied: 0, total: 1, error: null };
    const setStuck = (id: string) =>
      server.deps.db
        .update(schema.workspaceStorage)
        .set({ transfer: stuck })
        .where(eq(schema.workspaceStorage.workspaceId, id));
    await setStuck(workspaceId);
    // Another workspace got stuck and then went back to the server's storage.
    const other = await team();
    await saveStorage(server.deps, other.workspaceId, { kind: "s3", s3: input("boot") });
    await saveStorage(server.deps, other.workspaceId, { kind: "builtin" });
    await setStuck(other.workspaceId);

    await resumeStorageMigrations(server.deps);
    await migrationDone(workspaceId);
    expect((await storageRow(server.deps.db, workspaceId))?.transfer).toEqual({
      status: "done",
      copied: 1,
      total: 1,
      error: null,
    });
    expect([...s3.objects.keys()].some((k) => k.startsWith(`boot/files/${workspaceId}/${old.id}/1-`))).toBe(
      true,
    );
    expect((await storageRow(server.deps.db, other.workspaceId))?.transfer).toMatchObject({
      status: "failed",
      error: "Interrupted by a server restart",
    });
  });
});
