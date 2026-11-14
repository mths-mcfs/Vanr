// The extraction queue during a bucket outage (the fake S3's `override` answers in its place): the attempts
// are for failures of the file itself; an outage gives the attempt back and waits, 1 min doubling to 1 h, and
// after 24 h of waits the version is marked with its own reason, which a pass once an hour undoes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { extractPending, STORAGE_BACKOFF, STORAGE_GAVE_UP } from "../src/drive-extract";
import { saveStorage } from "../src/integrations/storage";
import type { RunningServer } from "../src/server";
import { type FakeS3, startFakeS3 } from "./fake-s3";
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

describe("the extraction queue during an outage", () => {
  const versionOf = async (fileId: string) => {
    const [v] = await server.deps.db
      .select()
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId));
    if (!v) throw new Error("no version");
    return v;
  };

  test("a rejected GET (HEAD fine) or a body that breaks: back in the queue, the attempt given back, no hot loop", async () => {
    const { workspaceId, ana } = await team();
    const size = 2 * 1024 * 1024 + 1;
    const big = await uploaded(ana, workspaceId, "x".repeat(size), "large.txt");
    for (const answer of [getFails["403"] as () => Response, breaksMidBody(size)]) {
      failing(objectGet, answer);
      try {
        await extractPending(server.deps, { batch: 50 });
      } finally {
        s3.override = null;
      }
      const v = await versionOf(big.id);
      expect(v).toMatchObject({ extractStatus: "working", extractAttempts: 0 });
      expect(v.extractError).toMatch(/^storage unavailable \(wait \d\)$/);
      // Not claimed again right away.
      expect(
        (await extractPending(server.deps, { batch: 50 }).then(() => versionOf(big.id))).extractAttempts,
      ).toBe(0);
      await server.deps.db
        .update(schema.fileVersions)
        .set({ extractClaimedAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(schema.fileVersions.fileId, big.id));
    }
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(big.id)).toMatchObject({
      extractStatus: "ready",
      extractError: null,
      extractAttempts: 1,
    });
  });

  test("waits double from 1 min up to 1 h; after 24 h it is marked with its own reason, undone once the bucket is back", async () => {
    const { workspaceId, ana } = await team();
    const big = await uploaded(ana, workspaceId, "y".repeat(2 * 1024 * 1024 + 1), "long.txt");
    const where = eq(schema.fileVersions.fileId, big.id);
    const waits: number[] = [];
    failing(objectGet, getFails["500"] as () => Response);
    try {
      for (let i = 0; i < 40; i++) {
        const at = Date.now() + skew;
        await extractPending(server.deps, { batch: 50 });
        const v = await versionOf(big.id);
        expect(v.extractAttempts).toBe(0);
        if (v.extractStatus === "failed") break;
        // The claim is due again at claimedAt + 10 min: the wait is what is past "now".
        const due = (v.extractClaimedAt?.getTime() ?? 0) + 10 * 60_000;
        waits.push(Math.round((due - at) / 60_000));
        skew += due - at + 1000;
      }
      expect(waits.slice(0, 8)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
      expect(Math.max(...waits)).toBe(60);
      const total = waits.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(24 * 60 - 60);
      expect(total).toBeLessThanOrEqual(24 * 60 + 60);
      expect(await versionOf(big.id)).toMatchObject({
        extractStatus: "failed",
        extractError: STORAGE_GAVE_UP,
      });
      // Still down an hour later: it stays marked, without spending attempts.
      skew += STORAGE_BACKOFF.recheckMs + 1000;
      await extractPending(server.deps, { batch: 50 });
      expect(await versionOf(big.id)).toMatchObject({
        extractStatus: "failed",
        extractError: STORAGE_GAVE_UP,
      });
    } finally {
      s3.override = null;
    }
    // Before the hour, nothing; after it, the bucket is back and the file is read.
    await extractPending(server.deps, { batch: 50 });
    expect((await versionOf(big.id)).extractStatus).toBe("failed");
    skew += STORAGE_BACKOFF.recheckMs + 1000;
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(big.id)).toMatchObject({ extractStatus: "ready", extractError: null });
    const [row] = await server.deps.db.select().from(schema.fileVersions).where(where);
    expect(row?.pages?.length).toBeGreaterThan(0);
    skew = 0;
  }, 60_000);

  test("a file that breaks the extractor still fails after its 3 attempts (the bucket is fine)", async () => {
    const { workspaceId, ana } = await team();
    const broken = await uploaded(ana, workspaceId, new TextEncoder().encode("%PDF-1.4 junk"), "broken.pdf");
    await extractPending(server.deps, { batch: 50 });
    expect(await versionOf(broken.id)).toMatchObject({ extractStatus: "failed", extractAttempts: 1 });
  });
});
