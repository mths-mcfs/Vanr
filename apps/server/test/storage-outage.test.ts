// A bucket that fails, operation by operation and moment by moment (the fake S3's `override` answers in its
// place): a HEAD that works and a GET refused, a body that breaks in the middle, 403, 500, 301. Every route
// that touches a stored file answers a typed error (never 500 `internal`, never "not found" for a 403),.
// The extraction queue's side of an outage is in extract-outage.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { purgeTrash } from "../src/drive";
import { extractPending } from "../src/drive-extract";
import { saveStorage } from "../src/integrations/storage";
import type { RunningServer } from "../src/server";
import { type FakeS3, startFakeS3 } from "./fake-s3";
import { makePng } from "./files";
import { body, signedIn, startTestServer } from "./harness";
import { type Person, seedWorkspace } from "./seed";

let s3: FakeS3;
let server: RunningServer;
let skew = 0;
beforeAll(async () => {
  s3 = startFakeS3("workshop");
  server = await startTestServer({
    env: { ALLOW_PRIVATE_NETWORKS: "true" },
    now: () => new Date(Date.now() + skew),
  });
});
afterAll(async () => {
  await server.stop();
  s3.stop();
});

let n = 0;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;
const failure = async (res: Response) => (await body(res)).error;

/** A workspace whose files go to the fake bucket under its own prefix. */
async function team() {
  const ana = await signedIn(server, "Ana", `ana${++n}@storage-outage.test`);
  const { workspaceId } = await seedWorkspace(server, ana, "Outage");
  await saveStorage(server.deps, workspaceId, {
    kind: "s3",
    s3: {
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: "workshop",
      prefix: `outage${n}`,
      pathAddressing: true,
      accessKeyId: "AKIAWORKSHOP",
      secretAccessKey: "bucket-secret-key",
    },
  });
  return { workspaceId, ana };
}

async function upload(who: Person, workspaceId: string, data: Bun.BlobPart, name: string) {
  const form = new FormData();
  form.set("file", new File([data], name));
  return who.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
}
async function uploaded(who: Person, workspaceId: string, data: Bun.BlobPart, name: string) {
  const res = await upload(who, workspaceId, data, name);
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return body(res);
}

const xml = (code: string) => `<Error><Code>${code}</Code></Error>`;
/** How the bucket fails, each one only on the object reads (GET), HEAD still answering. */
const getFails: Record<string, () => Response> = {
  "403": () => new Response(xml("AccessDenied"), { status: 403 }),
  "500": () => new Response(xml("InternalError"), { status: 500 }),
  "301": () => new Response(xml("PermanentRedirect"), { status: 301 }),
};
/** A GET that sends the headers and some pieces, then breaks (after the server already got the first ones). */
const breaksMidBody = (size: number) => () => {
  let sent = 0;
  return new Response(
    new ReadableStream({
      async pull(c) {
        if (sent >= 4) {
          // Let the pieces already sent reach the reader before the connection breaks.
          await new Promise((r) => setTimeout(r, 50));
          c.error(new Error("bucket connection dropped"));
          return;
        }
        sent++;
        c.enqueue(new Uint8Array(16 * 1024).fill(120));
      },
    }),
    { headers: { "content-length": String(size), "content-type": "text/plain" } },
  );
};

function failing(
  on: (req: { method: string; key: string; list: boolean }) => boolean,
  answer: () => Response,
) {
  s3.override = (req) => (on(req) ? answer() : null);
}
const objectGet = (req: { method: string; list: boolean }) => req.method === "GET" && !req.list;

describe("a bucket that fails, route by route", () => {
  test("the blob before the first byte: 503 storage.unavailable for 403, 500 and 301, and a 403 is never 404", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "in the bucket", "a.txt");
    try {
      for (const [status, answer] of Object.entries(getFails)) {
        failing(objectGet, answer);
        const res = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
        expect([status, res.status, (await failure(res)).code]).toEqual([status, 503, "storage.unavailable"]);
        const ranged = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`, {
          headers: { range: "bytes=0-3" },
        });
        expect([status, ranged.status]).toEqual([status, 503]);
      }
      // HEAD refused too: the same answer.
      failing((req) => req.method === "HEAD", getFails["403"] as () => Response);
      const head = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
      expect([head.status, (await failure(head)).code]).toEqual([503, "storage.unavailable"]);
    } finally {
      s3.override = null;
    }
    expect(await (await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`)).text()).toBe(
      "in the bucket",
    );
  });

  test("the blob after the first byte: the connection ends (the status was already sent)", async () => {
    const { workspaceId, ana } = await team();
    const size = 256 * 1024;
    const file = await uploaded(ana, workspaceId, new Uint8Array(size).fill(120), "big.bin");
    failing(objectGet, breaksMidBody(size));
    try {
      const res = await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/blob`);
      expect(res.status).toBe(200);
      const read = await res.arrayBuffer().then(
        (b) => `complete ${b.byteLength}`,
        () => "interrupted",
      );
      expect(read).not.toBe(`complete ${size}`);
    } finally {
      s3.override = null;
    }
  });

  test("the thumbnail goes through the same read; the text and the versions don't need the bucket", async () => {
    const { workspaceId, ana } = await team();
    const img = await uploaded(ana, workspaceId, await makePng(400, 300), "photo.png");
    while ((await extractPending(server.deps, { batch: 20 })) > 0);
    const text = await uploaded(ana, workspaceId, "plain words", "t.txt");
    failing(objectGet, getFails["403"] as () => Response);
    try {
      const thumb = await ana.browser.fetch(`${W(workspaceId)}/files/${img.id}/blob?variant=thumb`);
      expect([thumb.status, (await failure(thumb)).code]).toEqual([503, "storage.unavailable"]);
      expect((await ana.browser.fetch(`${W(workspaceId)}/files/${text.id}/text`)).status).toBe(200);
      expect((await ana.browser.fetch(`${W(workspaceId)}/files/${text.id}/versions`)).status).toBe(200);
      expect((await ana.browser.fetch(`${W(workspaceId)}/files/${text.id}`)).status).toBe(200);
    } finally {
      s3.override = null;
    }
  });

  test("writes: a form upload, a new version and completing a chunked upload answer 503 and leave no row", async () => {
    const { workspaceId, ana } = await team();
    const first = await uploaded(ana, workspaceId, "v1", "v.txt");
    const rows = async () =>
      (
        await server.deps.db
          .select()
          .from(schema.fileVersions)
          .innerJoin(schema.files, eq(schema.files.id, schema.fileVersions.fileId))
          .where(eq(schema.files.workspaceId, workspaceId))
      ).length;
    const before = await rows();
    for (const [status, answer] of Object.entries(getFails)) {
      failing((req) => req.method === "PUT", answer);
      try {
        const res = await upload(ana, workspaceId, "x", "x.txt");
        expect([status, res.status, (await failure(res)).code]).toEqual([status, 503, "storage.unavailable"]);
        const form = new FormData();
        form.set("file", new File(["v2"], "v.txt"));
        const version = await ana.browser.fetch(`${W(workspaceId)}/files/${first.id}/files`, {
          method: "POST",
          body: form,
        });
        expect([status, version.status]).toEqual([status, 503]);
        const s = await body(
          await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "p.bin", size: 2 }),
        );
        await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${s.id}?offset=0`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: "ok",
        });
        const done = await ana.browser.json(`${W(workspaceId)}/files/uploads/${s.id}/complete`, "POST");
        expect([status, done.status, (await failure(done)).code]).toEqual([
          status,
          503,
          "storage.unavailable",
        ]);
      } finally {
        s3.override = null;
      }
    }
    expect(await rows()).toBe(before);
  });

  test("trash and restore don't touch the bucket; the purge with DELETE refused stops and retries later", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "to delete", "d.txt");
    failing(() => true, getFails["403"] as () => Response);
    try {
      expect((await ana.browser.json(`${W(workspaceId)}/files/${file.id}`, "DELETE")).status).toBe(204);
      expect((await ana.browser.json(`${W(workspaceId)}/files/${file.id}/restore`, "POST")).status).toBe(200);
      expect((await ana.browser.json(`${W(workspaceId)}/files/${file.id}`, "DELETE")).status).toBe(204);
      skew = 31 * 86_400_000;
      await expect(purgeTrash(server.deps)).rejects.toMatchObject({ code: "storage.unavailable" });
      // The row stays until the bytes are gone: nothing points to a deleted object, nothing is left behind.
      expect(
        await server.deps.db.select().from(schema.files).where(eq(schema.files.id, file.id)),
      ).toHaveLength(1);
      s3.override = null;
      expect(await purgeTrash(server.deps)).toBeGreaterThanOrEqual(1);
      expect(await server.deps.db.select().from(schema.files).where(eq(schema.files.id, file.id))).toEqual(
        [],
      );
    } finally {
      s3.override = null;
      skew = 0;
    }
  });
});
