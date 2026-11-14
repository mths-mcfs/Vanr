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
      code: "storage.bucket_check_failed",
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

describe("changing the destination never makes a file unreadable", () => {
  test("a new prefix, bucket or endpoint is rejected while the saved bucket holds files; new keys are accepted", async () => {
    const { workspaceId, ana } = await team();
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("first") });
    const remote = await upload(ana, workspaceId, "remote");
    await saveStorage(server.deps, workspaceId, { kind: "builtin" });
    for (const change of [
      { prefix: "second" },
      { bucket: "elsewhere" },
      { endpoint: "http://127.0.0.2:9" },
    ]) {
      await expect(
        saveStorage(server.deps, workspaceId, { kind: "s3", s3: { ...input("first"), ...change } }),
      ).rejects.toMatchObject({
        status: 409,
        code: "storage.destination_in_use",
        params: { files: 1, bucket: "workshop", prefix: "first" },
      });
    }
    // The saved destination is untouched and the file still downloads.
    expect((await storageRow(server.deps.db, workspaceId))?.s3).toMatchObject({ prefix: "first" });
    expect(await read(ana, workspaceId, remote.id)).toBe("remote");
    // The same destination with other keys (and the prefix written another way) is a credential change.
    const rotated = await saveStorage(server.deps, workspaceId, {
      kind: "s3",
      s3: { ...input("/first/"), accessKeyId: "AKIAROTATED", secretAccessKey: "rotated-secret" },
    });
    expect(toStorageConfig(rotated).s3).toMatchObject({ prefix: "first", accessKeyIdPreview: "…ATED" });
    expect(await read(ana, workspaceId, remote.id)).toBe("remote");
  });

  test("a saved bucket without files of the workspace can be changed; the database decides, not the bucket", async () => {
    const empty = await team();
    await saveStorage(server.deps, empty.workspaceId, { kind: "s3", s3: input("unused-a") });
    await saveStorage(server.deps, empty.workspaceId, { kind: "builtin" });
    const moved = await saveStorage(server.deps, empty.workspaceId, { kind: "s3", s3: input("unused-b") });
    expect(moved.s3).toMatchObject({ prefix: "unused-b" });

    // An object in the bucket that no row points to (left by someone else) doesn't hold the destination.
    const { workspaceId } = await team();
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("orphaned") });
    s3.objects.set(`orphaned/files/${workspaceId}/file_gone/1-x`, {
      bytes: new Uint8Array([1]),
      type: "text/plain",
    });
    const changed = await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("other") });
    expect(changed.s3).toMatchObject({ prefix: "other" });
    expect((await storageRow(server.deps.db, workspaceId))?.s3).toMatchObject({ prefix: "other" });
  });
});

describe("a bucket that fails", () => {
  test("reads: the server's copy is served; a file only in the bucket answers storage.unavailable, not 500 nor 404", async () => {
    const { workspaceId, ana } = await team();
    const local = await upload(ana, workspaceId, "local");
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("down") });
    const remote = await upload(ana, workspaceId, "remote");
    s3.failOn.add("GET");
    try {
      const fromDisk = await ana.browser.fetch(`${W(workspaceId)}/files/${local.id}/blob`);
      expect(fromDisk.status).toBe(200);
      expect(await fromDisk.text()).toBe("local");
      const fromBucket = await ana.browser.fetch(`${W(workspaceId)}/files/${remote.id}/blob`);
      expect(fromBucket.status).toBe(503);
      expect((await body(fromBucket)).error.code).toBe("storage.unavailable");
      // What the database holds doesn't need the bucket.
      expect((await ana.browser.fetch(`${W(workspaceId)}/files/${remote.id}`)).status).toBe(200);
      expect(
        (await body(await ana.browser.fetch(`${W(workspaceId)}/files/${remote.id}/text`))).pages,
      ).toEqual([{ page: 1, markdown: "remote" }]);
      expect((await ana.browser.fetch(`${W(workspaceId)}/files/${remote.id}/versions`)).status).toBe(200);
    } finally {
      s3.failOn.clear();
    }
    expect(await read(ana, workspaceId, remote.id)).toBe("remote");
    // Back on the server's storage with the saved bucket down: the disk still answers first.
    await saveStorage(server.deps, workspaceId, { kind: "builtin" });
    s3.failOn.add("GET");
    try {
      expect(await read(ana, workspaceId, local.id)).toBe("local");
      const res = await ana.browser.fetch(`${W(workspaceId)}/files/${remote.id}/blob`);
      expect((await body(res)).error.code).toBe("storage.unavailable");
    } finally {
      s3.failOn.clear();
    }
  });

  test("a local copy downloads when HEAD succeeds but the bucket GET is rejected", async () => {
    const { workspaceId, ana } = await team();
    const file = await upload(ana, workspaceId, "local bytes");
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("head-only") });
    await startMigration(server.deps, server.deps.localBlobs, workspaceId);
    await migrationDone(workspaceId);
    s3.override = ({ method, list }) =>
      method === "GET" && !list
        ? new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
        : null;
    try {
      expect(await read(ana, workspaceId, file.id)).toBe("local bytes");
    } finally {
      s3.override = null;
    }
  });

  test("writes: a clear error and no file row without its bytes, in the form and in the chunked upload", async () => {
    const { workspaceId, ana } = await team();
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("nowrite") });
    const countFiles = async () =>
      (await server.deps.db.select().from(schema.files).where(eq(schema.files.workspaceId, workspaceId)))
        .length;
    s3.failOn.add("PUT");
    try {
      const form = new FormData();
      form.set("file", new File(["x"], "x.txt"));
      const res = await ana.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
      expect(res.status).toBe(503);
      expect((await body(res)).error.code).toBe("storage.unavailable");
      expect(await countFiles()).toBe(0);
      const s = await body(
        await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "p.bin", size: 2 }),
      );
      await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${s.id}?offset=0`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "ok",
      });
      const done = await ana.browser.json(`${W(workspaceId)}/files/uploads/${s.id}/complete`, "POST");
      expect(done.status).toBe(503);
      expect((await body(done)).error.code).toBe("storage.unavailable");
      expect(await countFiles()).toBe(0);
      // The session went back to open: completing works once the bucket is back.
      s3.failOn.clear();
      const again = await ana.browser.json(`${W(workspaceId)}/files/uploads/${s.id}/complete`, "POST");
      expect(again.status).toBe(200);
      expect(await read(ana, workspaceId, (await body(again)).id)).toBe("ok");
      expect(await countFiles()).toBe(1);
    } finally {
      s3.failOn.clear();
    }
  });

  test("extraction: the bucket down is not the file's fault; the claim goes back to the queue and ends ready", async () => {
    const { extractPending } = await import("../src/drive-extract");
    const { workspaceId, ana } = await team();
    await saveStorage(server.deps, workspaceId, { kind: "s3", s3: input("extract") });
    const big = await upload(ana, workspaceId, "x".repeat(2 * 1024 * 1024 + 1));
    const where = eq(schema.fileVersions.fileId, big.id);
    s3.failOn.add("GET");
    try {
      await extractPending(server.deps, { batch: 50 });
    } finally {
      s3.failOn.clear();
    }
    const [stuck] = await server.deps.db.select().from(schema.fileVersions).where(where);
    // The outage gives the attempt back and waits (1 min first) instead of failing the file.
    expect(stuck).toMatchObject({
      extractStatus: "working",
      extractError: expect.stringMatching(/^storage unavailable since \S+; wait 1$/),
      extractAttempts: 0,
    });
    // Stale after 10 min, the queue claims it again.
    await server.deps.db
      .update(schema.fileVersions)
      .set({ extractClaimedAt: new Date(Date.now() - 11 * 60_000) })
      .where(where);
    await extractPending(server.deps, { batch: 50 });
    const [ready] = await server.deps.db.select().from(schema.fileVersions).where(where);
    expect(ready?.extractStatus).toBe("ready");
  });
});
