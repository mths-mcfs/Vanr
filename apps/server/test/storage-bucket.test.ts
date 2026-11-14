// The bucket itself, beyond one object: a bucket that is gone (its 404 says nothing about the object), a call
// that never ends, a rejected connection, an empty file, ranges of a healthy download, and a client that leaves
// in the middle of one (the bucket's stream is closed too).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { extractPending } from "../src/drive-extract";
import { BUCKET_CHECK_MS, bucketDeadlines, saveStorage, testStorage } from "../src/integrations/storage";
import type { RunningServer } from "../src/server";
import { type FakeS3, startFakeS3 } from "./fake-s3";
import { makePng } from "./files";
import { body, signedIn, startTestServer } from "./harness";
import { type Person, seedWorkspace } from "./seed";

let s3: FakeS3;
let server: RunningServer;
let skew = 0;
const deadlines = { ...bucketDeadlines };
beforeAll(async () => {
  s3 = startFakeS3("workshop");
  server = await startTestServer({
    env: { ALLOW_PRIVATE_NETWORKS: "true" },
    now: () => new Date(Date.now() + skew),
  });
});
afterEach(() => {
  s3.override = null;
  skew = 0;
  Object.assign(bucketDeadlines, deadlines);
});
afterAll(async () => {
  await server.stop();
  s3.stop();
});

let n = 0;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;
const failure = async (res: Response) => (await body(res)).error;
const destination = (bucket: FakeS3, prefix: string) => ({
  endpoint: bucket.endpoint,
  region: "us-east-1",
  bucket: bucket.bucket,
  prefix,
  pathAddressing: true,
  accessKeyId: "AKIAWORKSHOP",
  secretAccessKey: "bucket-secret-key",
});

async function team(bucket = s3) {
  const ana = await signedIn(server, "Ana", `ana${++n}@storage-bucket.test`);
  const { workspaceId } = await seedWorkspace(server, ana, "Bucket");
  await saveStorage(server.deps, workspaceId, { kind: "s3", s3: destination(bucket, `bucket${n}`) });
  return { workspaceId, ana, prefix: `bucket${n}` };
}

async function uploaded(who: Person, workspaceId: string, data: Bun.BlobPart, name: string) {
  const form = new FormData();
  form.set("file", new File([data], name));
  const res = await who.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return body(res);
}
const versionOf = async (fileId: string) => {
  const [v] = await server.deps.db
    .select()
    .from(schema.fileVersions)
    .where(eq(schema.fileVersions.fileId, fileId));
  if (!v) throw new Error("no version");
  return v;
};
const noBucket = () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
const never = () => new Promise<Response>(() => {});

describe("a bucket that is gone", () => {
  test("an object's 404 is checked against the bucket: gone, the read is unavailable; back, the file is ready", async () => {
    const { workspaceId, ana } = await team();
    // The image's thumbnail first, while the bucket is there.
    const img = await uploaded(ana, workspaceId, await makePng(200, 100), "photo.png");
    while ((await extractPending(server.deps, { batch: 50 })) > 0);
    expect(await versionOf(img.id)).toMatchObject({ extractStatus: "ready" });
    const big = await uploaded(ana, workspaceId, "z".repeat(2 * 1024 * 1024 + 1), "big.txt");
    // Now the whole bucket answers NoSuchBucket, the object reads (HEAD, GET) and the bucket-level call alike.
    s3.override = (req) => (req.method === "PUT" ? null : noBucket());
    const blob = await ana.browser.fetch(`${W(workspaceId)}/files/${big.id}/blob`);
    expect([blob.status, (await failure(blob)).code]).toEqual([503, "storage.unavailable"]);
    const thumb = await ana.browser.fetch(`${W(workspaceId)}/files/${img.id}/blob?variant=thumb`);
    expect([thumb.status, (await failure(thumb)).code]).toEqual([503, "storage.unavailable"]);
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(big.id)).toMatchObject({ extractStatus: "working", extractAttempts: 0 });
    // The bucket comes back; after the wait, the next pass reads the file.
    s3.override = null;
    skew = 2 * 60_000;
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(big.id)).toMatchObject({ extractStatus: "ready", extractError: null });
    expect((await ana.browser.fetch(`${W(workspaceId)}/files/${big.id}/blob`)).status).toBe(200);
  });

  test("the bucket is there and the object is not: still 'no file' (404), and the extraction fails for the file", async () => {
    const { workspaceId, ana, prefix } = await team();
    const big = await uploaded(ana, workspaceId, "w".repeat(2 * 1024 * 1024 + 1), "lost.txt");
    for (const key of [...s3.objects.keys()])
      if (key.startsWith(`${prefix}/`) && key.includes(big.id)) s3.objects.delete(key);
    const blob = await ana.browser.fetch(`${W(workspaceId)}/files/${big.id}/blob`);
    expect([blob.status, (await failure(blob)).code]).toEqual([404, "not_found"]);
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(big.id)).toMatchObject({
      extractStatus: "failed",
      extractError: "file not found",
    });
  });
});

describe("deadlines and rejected connections", () => {
  test("a call that never ends counts as unavailable, in each operation", async () => {
    Object.assign(bucketDeadlines, { callMs: 200, writeMs: 200, pieceMs: 200, lateMs: 200 });
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "slow", "slow.txt");
    const cases: [string, (req: { method: string; list: boolean }) => boolean, () => Promise<Response>][] = [
      [
        "HEAD",
        (r) => r.method === "HEAD",
        async () => ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`),
      ],
      [
        "GET body",
        (r) => r.method === "GET" && !r.list,
        async () => ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`),
      ],
      [
        "PUT",
        (r) => r.method === "PUT",
        async () => {
          const form = new FormData();
          form.set("file", new File(["x"], "x.txt"));
          return ana.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
        },
      ],
    ];
    for (const [what, on, call] of cases) {
      s3.override = (req) => (on(req) ? never() : null);
      const res = await call();
      expect([what, res.status, (await failure(res)).code]).toEqual([what, 503, "storage.unavailable"]);
    }
    // DELETE and the bucket-level listing (the check behind an object's 404).
    s3.override = (req) => (req.method === "DELETE" ? never() : null);
    await expect(server.deps.blobs.delete(`files/${workspaceId}/x/1-x`)).rejects.toMatchObject({
      code: "storage.unavailable",
    });
    s3.override = (req) =>
      req.method === "HEAD" ? new Response(null, { status: 404 }) : req.list ? never() : null;
    const checked = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
    expect([checked.status, (await failure(checked)).code]).toEqual([503, "storage.unavailable"]);
  });

  test("a bucket that rejects connections is unavailable for reads, writes and deletes", async () => {
    const gone = startFakeS3("workshop");
    const { workspaceId, ana } = await team(gone);
    const file = await uploaded(ana, workspaceId, "remote", "remote.txt");
    gone.stop();
    const read = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
    expect([read.status, (await failure(read)).code]).toEqual([503, "storage.unavailable"]);
    const form = new FormData();
    form.set("file", new File(["x"], "x.txt"));
    const write = await ana.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
    expect([write.status, (await failure(write)).code]).toEqual([503, "storage.unavailable"]);
    const [v] = await server.deps.db
      .select()
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, file.id));
    await expect(server.deps.blobs.delete(v?.blobKey ?? "")).rejects.toMatchObject({
      code: "storage.unavailable",
    });
  });
});

describe("healthy downloads", () => {
  test("an empty file: upload, download and extraction (form and chunked upload)", async () => {
    const { workspaceId, ana } = await team();
    const empty = await uploaded(ana, workspaceId, new Uint8Array(0), "empty.txt");
    expect(empty.content).toMatchObject({ kind: "file", size: 0 });
    const res = await ana.browser.fetch(`${W(workspaceId)}/files/${empty.id}/blob`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(
      (
        await ana.browser.fetch(`${W(workspaceId)}/files/${empty.id}/blob`, {
          headers: { range: "bytes=0-0" },
        })
      ).status,
    ).toBe(416);
    await extractPending(server.deps, { batch: 50 });
    expect(["none", "ready"]).toContain((await versionOf(empty.id)).extractStatus);
    const s = await body(
      await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "e.bin", size: 0 }),
    );
    const done = await ana.browser.json(`${W(workspaceId)}/files/uploads/${s.id}/complete`, "POST");
    expect(done.status).toBe(200);
    expect((await body(done)).content).toMatchObject({ size: 0 });
  });

  test("Range from the bucket: the first byte, the middle, the last byte, and an invalid range", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "0123456789", "digits.txt");
    const url = `${W(workspaceId)}/files/${file.id}/blob`;
    const ranges: [string, number, string, string | null][] = [
      ["bytes=0-0", 206, "0", "bytes 0-0/10"],
      ["bytes=3-6", 206, "3456", "bytes 3-6/10"],
      ["bytes=9-9", 206, "9", "bytes 9-9/10"],
      ["bytes=-1", 206, "9", "bytes 9-9/10"],
      ["bytes=6-2", 416, "", "bytes */10"],
    ];
    for (const [range, status, text, contentRange] of ranges) {
      const res = await ana.browser.fetch(url, { headers: { range } });
      expect([range, res.status, await res.text(), res.headers.get("content-range")]).toEqual([
        range,
        status,
        text,
        contentRange,
      ]);
    }
  });

  test("a client that leaves in the middle of a download: the bucket's stream is closed too", async () => {
    const { workspaceId, ana } = await team();
    const size = 4 * 1024 * 1024;
    const file = await uploaded(ana, workspaceId, new Uint8Array(size).fill(97), "big.bin");
    let closed!: () => void;
    const bucketSawClose = new Promise<void>((r) => {
      closed = r;
    });
    // A slow bucket: 8 pieces, then nothing more until the reader goes away.
    let served = 0;
    s3.override = (req) =>
      req.method === "GET" && !req.list
        ? new Response(
            new ReadableStream({
              pull(c) {
                if (served >= 8) return new Promise<void>(() => {});
                served++;
                c.enqueue(new Uint8Array(64 * 1024).fill(97));
              },
              cancel() {
                closed();
              },
            }),
            { headers: { "content-length": String(size), "content-type": "application/octet-stream" } },
          )
        : null;
    const leave = new AbortController();
    const res = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`, { signal: leave.signal });
    const reader = res.body?.getReader();
    await reader?.read();
    leave.abort();
    // The fake sees its response stream cancelled: the connection to the bucket was closed.
    await bucketSawClose;
    expect(served).toBeLessThanOrEqual(8);
  });
});

/** A PUT the fake holds until the test releases it; the object only exists once released. */
function holdPuts(on: (key: string) => boolean) {
  const held: { key: string; release: () => void }[] = [];
  s3.override = (req) =>
    req.method === "PUT" && on(req.key)
      ? new Promise<Response>((resolve) =>
          held.push({
            key: req.key,
            release: () => {
              s3.objects.set(req.key, { bytes: new TextEncoder().encode("late"), type: "text/plain" });
              resolve(new Response(null, { status: 200, headers: { etag: '"x"' } }));
            },
          }),
        )
      : null;
  return held;
}
const objectsOf = (prefix: string) => [...s3.objects.keys()].filter((k) => k.startsWith(`${prefix}/`));

describe("a write that ends after its deadline", () => {
  test("the upload answered 503 and left no row; when the late PUT lands, its object is deleted", async () => {
    Object.assign(bucketDeadlines, { writeMs: 100 });
    const { workspaceId, ana, prefix } = await team();
    const held = holdPuts(() => true);
    const form = new FormData();
    form.set("file", new File(["late"], "late.txt"));
    const res = await ana.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
    expect([res.status, (await failure(res)).code]).toEqual([503, "storage.unavailable"]);
    expect(held).toHaveLength(1);
    s3.override = null;
    for (const h of held) h.release();
    // The undo is background work: settling it (what the server's stop waits for) is enough, no sleep.
    await server.deps.runtime.settle();
    expect(objectsOf(prefix)).toEqual([]);
    const rows = await server.deps.db
      .select()
      .from(schema.files)
      .where(eq(schema.files.workspaceId, workspaceId));
    expect(rows).toEqual([]);
  });

  test("a late thumbnail is deleted too; the retry leaves only the file and its one thumbnail", async () => {
    const { workspaceId, ana, prefix } = await team();
    const img = await uploaded(ana, workspaceId, await makePng(200, 100), "photo.png");
    Object.assign(bucketDeadlines, { writeMs: 100 });
    const held = holdPuts((key) => key.includes(".thumb-"));
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(img.id)).toMatchObject({ extractStatus: "working", extractAttempts: 0 });
    s3.override = null;
    for (const h of held) h.release();
    await server.deps.runtime.settle();
    expect(objectsOf(prefix).filter((k) => k.includes(".thumb-"))).toEqual([]);
    skew = 2 * 60_000;
    await extractPending(server.deps, { batch: 50 });
    const v = await versionOf(img.id);
    expect(v.extractStatus).toBe("ready");
    expect(objectsOf(prefix).filter((k) => k.includes(img.id))).toHaveLength(2);
    expect(objectsOf(prefix).some((k) => v.thumbKey !== null && k.endsWith(v.thumbKey))).toBe(true);
  });

  test("the connection test's write has the short deadline, and its late object is deleted", async () => {
    Object.assign(bucketDeadlines, { callMs: 100 });
    const { workspaceId } = await team();
    const held = holdPuts((key) => key.includes("-probe-"));
    const result = await testStorage(server.deps, workspaceId, destination(s3, "probe"));
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([expect.objectContaining({ step: "write", ok: false })]);
    expect(result.steps[0]?.error).toContain("took longer than 100 ms");
    s3.override = null;
    for (const h of held) h.release();
    await server.deps.runtime.settle();
    expect(objectsOf("probe")).toEqual([]);
  });

  test("a write that never lands is given up after the late wait, so the server's stop doesn't hang", async () => {
    Object.assign(bucketDeadlines, { writeMs: 100, lateMs: 200 });
    const { workspaceId, ana } = await team();
    s3.override = (req) => (req.method === "PUT" ? never() : null);
    const form = new FormData();
    form.set("file", new File(["never"], "never.txt"));
    expect(
      (await ana.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form })).status,
    ).toBe(503);
    await server.deps.runtime.settle();
  });
});

describe("the bucket check behind an object's 404", () => {
  test("keys that may read but not list: a missing object is 404, with one listing for many reads", async () => {
    const { workspaceId, ana, prefix } = await team();
    const file = await uploaded(ana, workspaceId, "gone soon", "gone.txt");
    let lists = 0;
    s3.override = (req) => {
      if (!req.list) return null;
      lists++;
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    };
    for (const key of objectsOf(prefix)) s3.objects.delete(key);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses).toEqual(Array(10).fill(404));
    expect(lists).toBe(1);
    // Past the kept time (injected clock) the bucket is asked again.
    skew = BUCKET_CHECK_MS + 1000;
    await (await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`)).arrayBuffer();
    expect(lists).toBe(2);
  });

  test("keys the bucket doesn't recognize, and a missing bucket, are unavailable; a bucket that comes back is seen within the kept time", async () => {
    const { workspaceId, ana, prefix } = await team();
    const file = await uploaded(ana, workspaceId, "here", "here.txt");
    const blob = () => ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
    for (const code of ["InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket"]) {
      skew += BUCKET_CHECK_MS + 1000;
      s3.override = (req) =>
        req.method === "HEAD" || req.list
          ? new Response(`<Error><Code>${code}</Code></Error>`, {
              status: code === "NoSuchBucket" ? 404 : 403,
            })
          : null;
      const res = await blob();
      expect([code, res.status, (await failure(res)).code]).toEqual([code, 503, "storage.unavailable"]);
    }
    // The bucket is back: within the kept time the answer may still be the old one, never past it.
    s3.override = null;
    skew += BUCKET_CHECK_MS + 1000;
    const back = await blob();
    expect([back.status, await back.text()]).toEqual([200, "here"]);
    // And a clock that went back doesn't keep an old answer either.
    s3.override = (req) => (req.method === "HEAD" ? new Response(null, { status: 404 }) : null);
    for (const key of objectsOf(prefix)) s3.objects.delete(key);
    skew -= 10 * BUCKET_CHECK_MS;
    expect((await blob()).status).toBe(404);
  });
});
