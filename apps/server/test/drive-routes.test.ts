// The Drive over HTTP: who may read and write each file (workspace scope, private channel, DM, another
// workspace's id in the path), the chunked resumable upload, Range downloads, the real type from the bytes,
// the extraction queue (text per page, thumbnail), the trash and the search over the content. Every attack
// is reproduced: HTML disguised as PNG, another person's upload session, a part out of place, a hash that
// doesn't match, a raw body outside the part route (CSRF).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { purgeTrash } from "../src/drive";
import { extractPending } from "../src/drive-extract";
import { expireUploads, PART_SIZE } from "../src/routes/drive-upload";
import type { RunningServer } from "../src/server";
import { makeDocx, makePdf, makePng, makePptx, makeXlsx } from "./files";
import { Browser, body, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
let skew = 0;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew) });
});
afterAll(() => server.stop());

let n = 0;
const email = (who: string) => `${who}${++n}@drive-routes.test`;
const { fileVersions, uploadSessions, files } = schema;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

/** Ana (owner), Beto (member) and a private #board channel with only Ana. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Files");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const board = await seedChannel(server, workspaceId, {
    name: "board",
    visibility: "private",
    members: [ana],
  });
  return { workspaceId, general, board, ana, beto };
}

const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const random = (size: number) => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(size, i + 65536)));
  return out;
};
const drain = async () => {
  while ((await extractPending(server.deps, { batch: 10 })) > 0);
};

/** Sends a file in one multipart form. */
function upload(
  who: Person,
  workspaceId: string,
  data: Bun.BlobPart,
  fileName: string,
  extra: Record<string, string> = {},
  type = "",
) {
  const form = new FormData();
  form.set("file", new File([data], fileName, { type }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return who.browser.fetch(`${W(workspaceId)}/files/files`, { method: "POST", body: form });
}

async function uploaded(who: Person, workspaceId: string, data: Bun.BlobPart, fileName: string, extra = {}) {
  const res = await upload(who, workspaceId, data, fileName, extra);
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return body(res);
}

const part = (who: Person, workspaceId: string, id: string, offset: number, bytes: Bun.BlobPart) =>
  who.browser.fetch(`${W(workspaceId)}/files/uploads/${id}?offset=${offset}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Blob([bytes]),
  });

/** The whole chunked upload: start, the parts in order and complete. */
async function resumable(who: Person, workspaceId: string, bytes: Uint8Array, meta: Record<string, unknown>) {
  const start = await who.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
    size: bytes.length,
    ...meta,
  });
  if (!start.ok) return start;
  const s = await body(start);
  for (let at = 0; at < bytes.length; at += PART_SIZE) {
    const res = await part(who, workspaceId, s.id, at, bytes.subarray(at, at + PART_SIZE));
    if (!res.ok) return res;
  }
  return who.browser.json(`${W(workspaceId)}/files/uploads/${s.id}/complete`, "POST");
}

/** The error of a failed response (`{ error: { code, message, params } }`). */
const failure = async (res: Response) => (await body(res)).error;

const blobUrl = (workspaceId: string, fileId: string, q = "") => `${W(workspaceId)}/files/${fileId}/blob${q}`;

describe("access: workspace scope and visibility", () => {
  test("without a session 401; a non-member gets 404 on every Drive route, like a workspace that doesn't exist", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "hello", "a.txt");
    const anon = new Browser(server.url);
    expect((await anon.fetch(`${W(workspaceId)}/files`)).status).toBe(401);
    const eve = await signedIn(server, "Eve", email("eve"));
    const paths: [string, string][] = [
      ["GET", "/files"],
      ["GET", "/files/trash"],
      ["GET", `/files/${file.id}`],
      ["GET", `/files/${file.id}/text`],
      ["GET", `/files/${file.id}/versions`],
      ["GET", `/files/${file.id}/download`],
      ["GET", `/files/${file.id}/blob`],
      ["DELETE", `/files/${file.id}`],
      ["POST", `/files/${file.id}/restore`],
      ["POST", `/files/${file.id}/versions`],
      ["POST", "/files"],
      ["POST", "/files/uploads"],
    ];
    for (const [method, path] of paths) {
      const res = await eve.browser.json(`${W(workspaceId)}${path}`, method);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect((await upload(eve, workspaceId, "x", "x.txt")).status).toBe(404);
  });

  test("another workspace's id in the path: a member of both reads nothing of one through the other", async () => {
    const { workspaceId, ana } = await team();
    const other = await seedWorkspace(server, ana, "Other");
    const file = await uploaded(ana, workspaceId, "only here", "here.txt");
    for (const path of ["", "/text", "/versions", "/download", "/blob"]) {
      expect((await ana.browser.fetch(`${W(other.workspaceId)}/files/${file.id}${path}`)).status).toBe(404);
    }
    expect((await ana.browser.json(`${W(other.workspaceId)}/files/${file.id}`, "DELETE")).status).toBe(404);
    const v2 = await ana.browser.json(`${W(other.workspaceId)}/files/${file.id}/versions`, "POST", {
      content: { kind: "document", markdown: "x" },
      parentVersion: 1,
    });
    expect(v2.status).toBe(404);
    const list = await body(await ana.browser.fetch(`${W(other.workspaceId)}/files`));
    expect(list.files).toEqual([]);
    // The trash too: deleted in its own workspace, the other one doesn't list nor restore it.
    expect((await ana.browser.json(`${W(workspaceId)}/files/${file.id}`, "DELETE")).status).toBe(204);
    expect((await body(await ana.browser.fetch(`${W(other.workspaceId)}/files/trash`))).files).toEqual([]);
    expect((await ana.browser.json(`${W(other.workspaceId)}/files/${file.id}/restore`, "POST")).status).toBe(
      404,
    );
  });

  test("a private channel's file and a DM's file: whoever doesn't read the channel doesn't list, open nor download it", async () => {
    const { workspaceId, board, ana, beto } = await team();
    const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
    const dm = await seedChannel(server, workspaceId, {
      name: "dm",
      kind: "dm",
      visibility: "private",
      members: [ana, beto],
    });
    const secret = await uploaded(ana, workspaceId, "board salaries", "salaries.txt", { channelId: board });
    const inDm = await uploaded(ana, workspaceId, "just us", "dm.txt", { channelId: dm });
    const open = await uploaded(ana, workspaceId, "for everyone", "open.txt");
    const ids = async (who: Person) =>
      (await body(await who.browser.fetch(`${W(workspaceId)}/files`))).files
        .map((f: { id: string }) => f.id)
        .sort();
    expect(await ids(ana)).toEqual([secret.id, inDm.id, open.id].sort());
    expect(await ids(beto)).toEqual([inDm.id, open.id].sort());
    expect(await ids(caio)).toEqual([open.id]);
    for (const path of ["", "/text", "/versions", "/download", "/blob"]) {
      expect((await beto.browser.fetch(`${W(workspaceId)}/files/${secret.id}${path}`)).status).toBe(404);
      expect((await caio.browser.fetch(`${W(workspaceId)}/files/${inDm.id}${path}`)).status).toBe(404);
    }
    expect((await caio.browser.json(`${W(workspaceId)}/files/${inDm.id}`, "DELETE")).status).toBe(404);
    // Filtering by the channel doesn't open it either.
    const byChannel = await body(await beto.browser.fetch(`${W(workspaceId)}/files?channelId=${board}`));
    expect(byChannel.files).toEqual([]);
  });

  test("writing into a private channel the person doesn't belong to is rejected; a public one, they join by writing", async () => {
    const { workspaceId, general, board, beto } = await team();
    expect((await upload(beto, workspaceId, "x", "x.txt", { channelId: board })).status).toBe(404);
    const doc = await beto.browser.json(`${W(workspaceId)}/files`, "POST", {
      title: "Plan",
      content: { kind: "document", markdown: "x" },
      channelId: board,
    });
    expect(doc.status).toBe(404);
    const start = await beto.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
      fileName: "x",
      size: 1,
      channelId: board,
    });
    expect(start.status).toBe(404);
    expect((await body(await beto.browser.fetch(`${W(workspaceId)}/files`))).files).toEqual([]);
    const ok = await uploaded(beto, workspaceId, "hi", "hi.txt", { channelId: general });
    expect(ok.channelId).toBe(general);
    const joined = await server.deps.db
      .select()
      .from(schema.channelMemberships)
      .where(eq(schema.channelMemberships.channelId, general));
    expect(joined.map((m) => m.memberId)).toContain(beto.user.id);
  });

  test("a thread needs its channel, and a thread of another channel is not found", async () => {
    const { workspaceId, general, ana } = await team();
    const other = await seedChannel(server, workspaceId, { name: "other", members: [ana] });
    // A thread's id is its root message's.
    const threadId = "msg_thread_root";
    await server.deps.db.insert(schema.messages).values({
      id: threadId,
      workspaceId,
      channelId: other,
      authorKind: "person",
      authorId: ana.user.id,
      body: "root",
    });
    await server.deps.db.insert(schema.threads).values({
      id: threadId,
      workspaceId,
      channelId: other,
      createdByType: "person",
      createdById: ana.user.id,
      lastTouchedAt: new Date(),
    });
    const create = (extra: Record<string, unknown>) =>
      ana.browser.json(`${W(workspaceId)}/files`, "POST", {
        title: "Note",
        content: { kind: "document", markdown: "x" },
        ...extra,
      });
    expect((await failure(await create({ threadId }))).code).toBe("invalid_request");
    expect((await create({ channelId: general, threadId })).status).toBe(404);
    expect(await body(await create({ channelId: other, threadId }))).toMatchObject({
      channelId: other,
      threadId,
    });
  });

  test("delete and restore: only the creator or an admin; a member gets 403 and the file stays", async () => {
    const { workspaceId, ana, beto } = await team();
    const admin = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
    const mine = await uploaded(ana, workspaceId, "ana's", "ana.txt");
    expect(mine.deletable).toBe(true);
    const seen = await body(await beto.browser.fetch(`${W(workspaceId)}/files/${mine.id}`));
    expect(seen).toMatchObject({ deletable: false, editable: true });
    const rejected = await beto.browser.json(`${W(workspaceId)}/files/${mine.id}`, "DELETE");
    expect(rejected.status).toBe(403);
    expect((await beto.browser.fetch(`${W(workspaceId)}/files/${mine.id}`)).status).toBe(200);
    expect((await admin.browser.json(`${W(workspaceId)}/files/${mine.id}`, "DELETE")).status).toBe(204);
    expect((await ana.browser.fetch(`${W(workspaceId)}/files/${mine.id}`)).status).toBe(404);
    expect((await beto.browser.json(`${W(workspaceId)}/files/${mine.id}/restore`, "POST")).status).toBe(403);
    const restored = await ana.browser.json(`${W(workspaceId)}/files/${mine.id}/restore`, "POST");
    expect(restored.status).toBe(200);
    const again = await ana.browser.json(`${W(workspaceId)}/files/${mine.id}/restore`, "POST");
    expect(await failure(again)).toMatchObject({ code: "file.not_deleted" });
  });
});

describe("chunked upload", () => {
  test("the connection drops after the part arrived: it resumes from the server's offset, streamed to the store", async () => {
    const { workspaceId, general, ana } = await team();
    const bytes = random(PART_SIZE + 1024 * 1024 + 123);
    const puts: string[] = [];
    const blobs = server.deps.blobs;
    const put = blobs.put.bind(blobs);
    blobs.put = (key, data, type) => {
      puts.push(data instanceof Uint8Array ? "bytes" : "blob");
      return put(key, data, type);
    };
    try {
      const start = await body(
        await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
          fileName: "data.bin",
          title: "Data",
          channelId: general,
          size: bytes.length,
          sha256: sha(bytes),
        }),
      );
      expect(start).toMatchObject({
        offset: 0,
        size: bytes.length,
        partSize: PART_SIZE,
        status: "open",
        fileId: null,
      });
      expect((await part(ana, workspaceId, start.id, 0, bytes.subarray(0, PART_SIZE))).status).toBe(200);
      // The browser lost the answer and asks where the server is.
      const status = await body(await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${start.id}`));
      expect(status.offset).toBe(PART_SIZE);
      // Repeating the part already received is rejected with the right offset (it doesn't count twice).
      const repeat = await part(ana, workspaceId, start.id, 0, bytes.subarray(0, PART_SIZE));
      expect(await failure(repeat)).toMatchObject({
        code: "upload.offset_mismatch",
        params: { offset: PART_SIZE },
      });
      expect((await part(ana, workspaceId, start.id, PART_SIZE, bytes.subarray(PART_SIZE))).status).toBe(200);
      const done = await body(
        await ana.browser.json(`${W(workspaceId)}/files/uploads/${start.id}/complete`, "POST"),
      );
      expect(done).toMatchObject({ kind: "file", title: "Data", channelId: general });
      expect(done.content).toMatchObject({ kind: "file", size: bytes.length, detectedType: null });
      expect(puts).toEqual(["blob"]);
      const got = new Uint8Array(
        await (await ana.browser.fetch(blobUrl(workspaceId, done.id))).arrayBuffer(),
      );
      expect(sha(got)).toBe(sha(bytes));
      // Completing again returns the same file (the browser may repeat after a drop), without a second one.
      const again = await body(
        await ana.browser.json(`${W(workspaceId)}/files/uploads/${start.id}/complete`, "POST"),
      );
      expect(again.id).toBe(done.id);
      const after = await body(await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${start.id}`));
      expect(after).toMatchObject({ status: "done", fileId: done.id });
      const rows = await server.deps.db.select().from(files).where(eq(files.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
    } finally {
      blobs.put = put;
    }
  });

  test("a new version by chunked upload, with a parentVersion conflict", async () => {
    const { workspaceId, ana } = await team();
    const first = await body(
      await resumable(ana, workspaceId, new TextEncoder().encode("v1"), { fileName: "a.txt" }),
    );
    const v2 = await body(
      await resumable(ana, workspaceId, new TextEncoder().encode("v2"), {
        fileName: "a.txt",
        fileId: first.id,
        parentVersion: 1,
        note: "second",
      }),
    );
    expect(v2).toMatchObject({ id: first.id, version: 2, content: { kind: "file", text: "v2" } });
    const stale = await resumable(ana, workspaceId, new TextEncoder().encode("v3"), {
      fileName: "a.txt",
      fileId: first.id,
      parentVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect((await failure(stale)).code).toBe("file.version_conflict");
    // A document can't get a file version.
    const doc = await body(
      await ana.browser.json(`${W(workspaceId)}/files`, "POST", {
        title: "Doc",
        content: { kind: "document", markdown: "x" },
      }),
    );
    const mismatch = await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
      fileName: "x",
      size: 1,
      fileId: doc.id,
    });
    expect(await failure(mismatch)).toMatchObject({ code: "file.kind_mismatch" });
  });

  test("attacks: another person's session, a part out of place or too large, a different hash, the size cap", async () => {
    const { workspaceId, board, ana, beto } = await team();
    const s = await body(
      await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "x.bin", size: 10 }),
    );
    // Beto doesn't see, send a part, complete nor cancel Ana's session.
    const base = `${W(workspaceId)}/files/uploads/${s.id}`;
    const denied = [
      await beto.browser.fetch(base),
      await part(beto, workspaceId, s.id, 0, "0123456789"),
      await beto.browser.json(`${base}/complete`, "POST"),
      await beto.browser.json(base, "DELETE"),
    ];
    expect(denied.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    // Nor does Ana herself through another workspace's path.
    const other = await seedWorkspace(server, ana, "Other");
    expect((await ana.browser.fetch(`${W(other.workspaceId)}/files/uploads/${s.id}`)).status).toBe(404);
    expect((await part(ana, other.workspaceId, s.id, 0, "0123456789")).status).toBe(404);
    // A part skipping bytes: 409 with the right offset.
    const skip = await part(ana, workspaceId, s.id, 5, "56789");
    expect(skip.status).toBe(409);
    expect(await failure(skip)).toMatchObject({ code: "upload.offset_mismatch", params: { offset: 0 } });
    // A part past the declared size.
    const big = await part(ana, workspaceId, s.id, 0, "0123456789AB");
    expect(big.status).toBe(413);
    expect((await failure(big)).code).toBe("upload.part_too_large");
    expect((await body(await ana.browser.fetch(base))).offset).toBe(0);
    // Completing before everything arrived.
    expect((await failure(await ana.browser.json(`${base}/complete`, "POST"))).code).toBe(
      "upload.incomplete",
    );
    // A declared hash other than what arrived: rejected and dropped.
    const h = await body(
      await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
        fileName: "h.bin",
        size: 3,
        sha256: sha(new Uint8Array([9, 9, 9])),
      }),
    );
    await part(ana, workspaceId, h.id, 0, "abc");
    const mismatch = await ana.browser.json(`${W(workspaceId)}/files/uploads/${h.id}/complete`, "POST");
    expect(mismatch.status).toBe(422);
    expect((await failure(mismatch)).code).toBe("upload.checksum_mismatch");
    expect((await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${h.id}`)).status).toBe(404);
    // Larger than 1 GB, and a destination the person can't write.
    const huge = await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
      fileName: "g",
      size: 2 ** 30 + 1,
    });
    expect(huge.status).toBe(413);
    expect((await failure(huge)).code).toBe("file.too_large");
    const closed = await beto.browser.json(`${W(workspaceId)}/files/uploads`, "POST", {
      fileName: "x",
      size: 1,
      channelId: board,
    });
    expect(closed.status).toBeGreaterThanOrEqual(403);
    // Cancelling deletes the session.
    expect((await ana.browser.json(base, "DELETE")).status).toBe(204);
    expect((await ana.browser.fetch(base)).status).toBe(404);
  });

  test("a part over 16 MB is rejected even inside the declared size", async () => {
    const { workspaceId, ana } = await team();
    const size = 17 * 1024 * 1024;
    const s = await body(
      await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "big", size }),
    );
    const res = await part(ana, workspaceId, s.id, 0, new Uint8Array(size));
    expect(res.status).toBe(413);
    expect(await failure(res)).toMatchObject({
      code: "upload.part_too_large",
      params: { maxBytes: 16 * 1024 * 1024 },
    });
    expect((await body(await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${s.id}`))).offset).toBe(0);
  });

  test("at most 20 open sessions per person: the 21st is rejected with 429", async () => {
    const { workspaceId, ana } = await team();
    const start = () =>
      ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "x", size: 1 });
    for (let i = 0; i < 20; i++) expect((await start()).status).toBe(200);
    const over = await start();
    expect(over.status).toBe(429);
    expect(await failure(over)).toMatchObject({ code: "upload.too_many", params: { max: 20 } });
  });

  test("CSRF: raw bytes only on the part route; plain text on the part is rejected", async () => {
    const { workspaceId, ana } = await team();
    const s = await body(
      await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "x.bin", size: 3 }),
    );
    const asText = await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${s.id}?offset=0`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "abc",
    });
    expect(asText.status).toBe(415);
    const elsewhere = await ana.browser.fetch(`${W(workspaceId)}/files/uploads`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "abc",
    });
    expect(elsewhere.status).toBe(415);
  });

  test("an abandoned session expires in 24 h and the work file goes away", async () => {
    const { workspaceId, ana } = await team();
    const s = await body(
      await ana.browser.json(`${W(workspaceId)}/files/uploads`, "POST", { fileName: "x.bin", size: 3 }),
    );
    await part(ana, workspaceId, s.id, 0, "ab");
    skew = 25 * 3_600_000;
    try {
      expect((await ana.browser.fetch(`${W(workspaceId)}/files/uploads/${s.id}`)).status).toBe(404);
      expect(await expireUploads(server.deps)).toBeGreaterThanOrEqual(1);
      const rows = await server.deps.db.select().from(uploadSessions).where(eq(uploadSessions.id, s.id));
      expect(rows).toEqual([]);
      // No file was created and nothing went to the store.
      expect(await server.deps.db.select().from(files).where(eq(files.workspaceId, workspaceId))).toEqual([]);
      expect((await server.deps.blobs.keys()).some((k) => k.startsWith(`files/${workspaceId}/`))).toBe(false);
    } finally {
      skew = 0;
    }
  });
});

describe("form upload limits", () => {
  test("without a file 400; over 50 MB 413; small text keeps its text, large text goes to the queue", async () => {
    const { workspaceId, ana } = await team();
    const empty = await ana.browser.fetch(`${W(workspaceId)}/files/files`, {
      method: "POST",
      body: new FormData(),
    });
    expect(await failure(empty)).toMatchObject({ code: "file_required" });
    const tooBig = await upload(ana, workspaceId, new Uint8Array(50 * 1024 * 1024 + 1), "big.bin");
    expect(tooBig.status).toBe(413);
    expect(await failure(tooBig)).toMatchObject({
      code: "file.too_large",
      params: { maxBytes: 50 * 1024 * 1024 },
    });
    const small = await uploaded(ana, workspaceId, "short note", "note.txt");
    expect(small.content).toMatchObject({ text: "short note", extract: "none" });
    const large = await uploaded(ana, workspaceId, "x".repeat(2 * 1024 * 1024 + 1), "long.txt");
    expect(large.content).toMatchObject({ text: null, extract: "pending" });
  });
});

describe("download and the real type", () => {
  test("Range: a slice, a suffix and out of the file (416)", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "0123456789", "n.txt");
    const url = blobUrl(workspaceId, file.id);
    const slice = await ana.browser.fetch(url, { headers: { range: "bytes=2-5" } });
    expect(slice.status).toBe(206);
    expect(slice.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await slice.text()).toBe("2345");
    const tail = await ana.browser.fetch(url, { headers: { range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");
    const open = await ana.browser.fetch(url, { headers: { range: "bytes=7-" } });
    expect(await open.text()).toBe("789");
    const out = await ana.browser.fetch(url, { headers: { range: "bytes=50-60" } });
    expect(out.status).toBe(416);
    expect(out.headers.get("content-range")).toBe("bytes */10");
    const full = await ana.browser.fetch(url);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("10");
    // The download link points at the blob route of the same workspace.
    const link = await body(await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/download`));
    expect(link.url).toBe(`${W(workspaceId)}/files/${file.id}/blob?version=1&format=download`);
    const attachment = await ana.browser.fetch(link.url);
    expect(attachment.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''n.txt");
  });

  test("attack: HTML named .png with type image/png is served as HTML with a sandbox CSP; a real PNG, inline", async () => {
    const { workspaceId, ana } = await team();
    const evil = await body(
      await upload(
        ana,
        workspaceId,
        "<!doctype html><script>fetch('/api/v1/me')</script>",
        "photo.png",
        {},
        "image/png",
      ),
    );
    expect(evil.content).toMatchObject({ kind: "file", contentType: "image/png", detectedType: "text/html" });
    const res = await ana.browser.fetch(blobUrl(workspaceId, evil.id));
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The same through the chunked upload.
    const evil2 = await body(
      await resumable(ana, workspaceId, new TextEncoder().encode("<svg onload='alert(1)'/>"), {
        fileName: "logo.png",
        contentType: "image/png",
      }),
    );
    const res2 = await ana.browser.fetch(blobUrl(workspaceId, evil2.id));
    expect(res2.headers.get("content-type")).toBe("image/svg+xml");
    expect(res2.headers.get("content-security-policy")).toContain("sandbox");

    const png = await uploaded(ana, workspaceId, await makePng(), "untyped");
    const ok = await ana.browser.fetch(blobUrl(workspaceId, png.id));
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-security-policy")).toBeNull();
    // An old version without a recorded type: it is detected on the spot from the bytes.
    await server.deps.db
      .update(fileVersions)
      .set({ detectedType: null })
      .where(eq(fileVersions.fileId, evil.id));
    const legacy = await ana.browser.fetch(blobUrl(workspaceId, evil.id));
    expect(legacy.headers.get("content-type")).toBe("text/html");
    expect(legacy.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("a file name with a path stays a name: the key doesn't use it and the header encodes it", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "x", "../../etc/passwd");
    const [v] = await server.deps.db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    expect(v?.blobKey).toStartWith(`files/${workspaceId}/${file.id}/1-`);
    const res = await ana.browser.fetch(blobUrl(workspaceId, file.id));
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent(v?.fileName ?? "")}`,
    );
  });
});

describe("documents, versions and the trash", () => {
  test("a document gets versions; an old parentVersion is a conflict; an old version can be opened", async () => {
    const { workspaceId, ana, beto } = await team();
    const doc = await body(
      await ana.browser.json(`${W(workspaceId)}/files`, "POST", {
        title: "Plan",
        content: { kind: "document", markdown: "first" },
      }),
    );
    expect(doc).toMatchObject({
      kind: "document",
      version: 1,
      viewVersion: 1,
      content: { kind: "document", markdown: "first" },
    });
    const v2 = await beto.browser.json(`${W(workspaceId)}/files/${doc.id}/versions`, "POST", {
      content: { kind: "document", markdown: "second" },
      parentVersion: 1,
      note: "edit",
    });
    expect(await body(v2)).toMatchObject({ version: 2, updatedBy: { type: "person", id: beto.user.id } });
    const stale = await ana.browser.json(`${W(workspaceId)}/files/${doc.id}/versions`, "POST", {
      content: { kind: "document", markdown: "lost" },
      parentVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await failure(stale)).toMatchObject({
      code: "file.version_conflict",
      params: { currentVersion: 2 },
    });
    const kind = await ana.browser.json(`${W(workspaceId)}/files/${doc.id}/versions`, "POST", {
      content: { kind: "diagram", mermaid: "graph TD" },
      parentVersion: 2,
    });
    expect(await failure(kind)).toMatchObject({ code: "file.kind_mismatch" });
    const old = await body(await ana.browser.fetch(`${W(workspaceId)}/files/${doc.id}?version=1`));
    expect(old).toMatchObject({ version: 2, viewVersion: 1, content: { markdown: "first" } });
    const versions = await body(await ana.browser.fetch(`${W(workspaceId)}/files/${doc.id}/versions`));
    expect(
      versions.versions.map((v: { version: number; note: string | null }) => [v.version, v.note]),
    ).toEqual([
      [2, "edit"],
      [1, null],
    ]);
    // A document has no file to download.
    expect(
      await failure(await ana.browser.fetch(`${W(workspaceId)}/files/${doc.id}/download`)),
    ).toMatchObject({
      code: "file.not_a_file",
    });
    // Extra fields are rejected (the body is strict).
    const extra = await ana.browser.json(`${W(workspaceId)}/files`, "POST", {
      title: "X",
      content: { kind: "document", markdown: "x" },
      workspaceId: "ws_other",
    });
    expect(extra.status).toBe(400);
  });

  test("the trash: out of the lists and the search at once, back on restore; 30 days later the bytes go away", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, "quarterly lighthouse report", "report.txt");
    const search = async () =>
      (await body(await ana.browser.fetch(`${W(workspaceId)}/search?q=lighthouse`))).hits.map(
        (h: { sourceId: string }) => h.sourceId,
      );
    expect(await search()).toEqual([file.id]);
    expect((await ana.browser.json(`${W(workspaceId)}/files/${file.id}`, "DELETE")).status).toBe(204);
    expect(await search()).toEqual([]);
    const trash = await body(await ana.browser.fetch(`${W(workspaceId)}/files/trash`));
    expect(trash.files).toEqual([expect.objectContaining({ id: file.id, title: "report.txt" })]);
    expect(Date.parse(trash.files[0].expungeAt) - Date.parse(trash.files[0].deletedAt)).toBe(30 * 86_400_000);
    await ana.browser.json(`${W(workspaceId)}/files/${file.id}/restore`, "POST");
    expect(await search()).toEqual([file.id]);
    expect((await body(await ana.browser.fetch(`${W(workspaceId)}/files`))).files).toHaveLength(1);

    await ana.browser.json(`${W(workspaceId)}/files/${file.id}`, "DELETE");
    const [v] = await server.deps.db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    if (!v?.blobKey) throw new Error("no blob");
    expect(await server.deps.blobs.get(v.blobKey)).not.toBeNull();
    skew = 31 * 86_400_000;
    try {
      expect(await purgeTrash(server.deps)).toBeGreaterThanOrEqual(1);
    } finally {
      skew = 0;
    }
    expect(await server.deps.blobs.get(v.blobKey)).toBeNull();
    expect(await server.deps.db.select().from(files).where(eq(files.id, file.id))).toEqual([]);
  });

  test("real time: a workspace file goes to the workspace, a channel file only to its channel", async () => {
    const { workspaceId, board, ana } = await team();
    const seen: [string, string][] = [];
    const off = server.deps.hub.onPublish((target, event) => seen.push([target, event.type]));
    try {
      const open = await uploaded(ana, workspaceId, "a", "a.txt");
      const secret = await uploaded(ana, workspaceId, "b", "b.txt", { channelId: board });
      await ana.browser.json(`${W(workspaceId)}/files/${secret.id}`, "DELETE");
      expect(seen.filter(([, type]) => type.startsWith("file."))).toEqual([
        [`workspace:${workspaceId}`, "file.created"],
        [`channel:${board}`, "file.created"],
        [`channel:${board}`, "file.deleted"],
      ]);
      expect(open.id).toBeTruthy();
    } finally {
      off();
    }
  });
});

describe("extraction, preview and search in the content", () => {
  test("PDF: text per page and the search finds the chunk citing the page", async () => {
    const { workspaceId, general, ana, beto } = await team();
    const pdf = await body(
      await resumable(
        ana,
        workspaceId,
        makePdf(["Commercial lease agreement", "Quarterly termination penalty clause"]),
        {
          fileName: "lease.pdf",
          channelId: general,
        },
      ),
    );
    expect(pdf.content).toMatchObject({ detectedType: "application/pdf", extract: "pending", totalPages: 0 });
    await drain();
    const text = await body(await ana.browser.fetch(`${W(workspaceId)}/files/${pdf.id}/text`));
    expect(text).toEqual({
      version: 1,
      status: "ready",
      pages: [
        { page: 1, markdown: "Commercial lease agreement" },
        { page: 2, markdown: "Quarterly termination penalty clause" },
      ],
    });
    expect((await body(await ana.browser.fetch(`${W(workspaceId)}/files/${pdf.id}`))).content).toMatchObject({
      extract: "ready",
      totalPages: 2,
    });
    const hits = (
      await body(await beto.browser.fetch(`${W(workspaceId)}/search?q=termination%20penalty&kinds=file`))
    ).hits;
    expect(hits[0]).toMatchObject({ kind: "file", sourceId: pdf.id, page: 2 });
    expect(hits[0]?.snippet).toContain("penalty");
  });

  test("Word, PowerPoint and Excel become searchable text; the search doesn't see a private channel's file", async () => {
    const { workspaceId, board, ana, beto } = await team();
    const docx = await uploaded(
      ana,
      workspaceId,
      makeDocx([{ text: "Strategic plan", style: "Heading1" }, { text: "Expansion to Lisbon" }]),
      "plan.docx",
    );
    const pptx = await uploaded(
      ana,
      workspaceId,
      makePptx([["Opening"], ["Results of the quadrimester"]]),
      "deck.pptx",
    );
    await uploaded(
      ana,
      workspaceId,
      makeXlsx([{ name: "Payroll", rows: [["Board salary", 99000]] }]),
      "payroll.xlsx",
      {
        channelId: board,
      },
    );
    await drain();
    const q = async (who: Person, query: string) =>
      (await body(await who.browser.fetch(`${W(workspaceId)}/search?q=${encodeURIComponent(query)}`))).hits;
    expect((await q(beto, "Lisbon"))[0]).toMatchObject({ sourceId: docx.id });
    expect((await q(beto, "quadrimester"))[0]).toMatchObject({ sourceId: pptx.id, page: 2 });
    expect(await q(beto, "board salary")).toEqual([]);
    expect((await q(ana, "board salary"))[0]?.kind).toBe("file");
  });

  test("an image gets a webp thumbnail; a corrupt file fails with an error and doesn't hold the queue", async () => {
    const { workspaceId, ana } = await team();
    const img = await uploaded(ana, workspaceId, await makePng(1600, 900), "photo.png");
    const broken = await uploaded(
      ana,
      workspaceId,
      new TextEncoder().encode("%PDF-1.4 junk without objects"),
      "broken.pdf",
    );
    await drain();
    expect((await body(await ana.browser.fetch(`${W(workspaceId)}/files/${img.id}`))).content).toMatchObject({
      extract: "ready",
      hasThumb: true,
    });
    const listed = await body(await ana.browser.fetch(`${W(workspaceId)}/files`));
    expect(listed.files.find((f: { id: string }) => f.id === img.id)?.hasThumb).toBe(true);
    const thumb = await ana.browser.fetch(blobUrl(workspaceId, img.id, "?variant=thumb"));
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    const meta = await sharp(new Uint8Array(await thumb.arrayBuffer())).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(320);
    expect(
      (await body(await ana.browser.fetch(`${W(workspaceId)}/files/${broken.id}`))).content,
    ).toMatchObject({
      extract: "failed",
    });
    // No preview without a converter: 404.
    expect((await ana.browser.fetch(blobUrl(workspaceId, img.id, "?variant=preview"))).status).toBe(404);
  });

  test("a stalled claim goes back to the queue; after 3 attempts it gives up", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, makePdf(["Stalled in the middle"]), "t.pdf");
    const where = eq(fileVersions.fileId, file.id);
    // The server went down with the version claimed 11 min ago.
    await server.deps.db
      .update(fileVersions)
      .set({
        extractStatus: "working",
        extractClaimedAt: new Date(Date.now() - 11 * 60_000),
        extractAttempts: 1,
      })
      .where(where);
    await drain();
    expect((await body(await ana.browser.fetch(`${W(workspaceId)}/files/${file.id}/text`))).status).toBe(
      "ready",
    );
    await server.deps.db
      .update(fileVersions)
      .set({ extractStatus: "pending", extractAttempts: 3 })
      .where(where);
    await drain();
    const [v] = await server.deps.db.select().from(fileVersions).where(where);
    expect(v).toMatchObject({ extractStatus: "failed", extractError: "gave up after repeated failures" });
  });

  // Limits of the origin that had no test of their own.
  test("a file over the extraction limit (100 MB) is not read: it fails with the reason", async () => {
    const { workspaceId, ana } = await team();
    const file = await uploaded(ana, workspaceId, makePdf(["small"]), "small.pdf");
    const [v] = await server.deps.db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    if (!v?.blobKey) throw new Error("no blob");
    // The stored bytes grow past the limit after the upload (a version written by another path).
    await server.deps.blobs.put(v.blobKey, new Uint8Array(100 * 1024 * 1024 + 1), "application/pdf");
    await drain();
    const [after] = await server.deps.db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    expect(after).toMatchObject({
      extractStatus: "failed",
      extractError: "file is too large to extract",
      pages: null,
    });
  });

  test("an image with more than 40 million pixels doesn't become a thumbnail (decompression bomb)", async () => {
    const { workspaceId, ana } = await team();
    const bomb = await makePng(8000, 6000);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const file = await uploaded(ana, workspaceId, bomb, "bomb.png");
    await drain();
    const [v] = await server.deps.db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    expect(v).toMatchObject({ extractStatus: "failed", thumbKey: null });
    expect(v?.extractError).toContain("pixel limit");
  });
});
