// A healthy download to a client that reads slowly. The server here gets a 1 s inactivity limit for every
// request (the option the harness passes on; Bun's default is 10 s). Bun checks the limit in steps of about
// 4 s (measured: with 1 s, a 2.5 s pause passes and a 6 s pause is cut), so a 9 s pause stands for the 65 s
// pause of a slow phone. The Drive's transfers keep their own, longer limit, and the bucket's deadline for each
// next piece (shortened to 200 ms) doesn't fire while the server is waiting on the client, not on the bucket.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { bucketDeadlines, saveStorage } from "../src/integrations/storage";
import { isTransfer, TRANSFER_IDLE_SECONDS } from "../src/routes/drive";
import type { RunningServer } from "../src/server";
import { type FakeS3, startFakeS3 } from "./fake-s3";
import { body, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

let s3: FakeS3;
let server: RunningServer;
const deadlines = { ...bucketDeadlines };
beforeAll(async () => {
  s3 = startFakeS3("workshop");
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" }, idleTimeoutSeconds: 1 });
});
afterEach(() => {
  Object.assign(bucketDeadlines, deadlines);
});
afterAll(async () => {
  await server.stop();
  s3.stop();
});

const SIZE = 16 * 1024 * 1024;

describe("a slow client", () => {
  test("the transfer routes are the Drive's file bodies, and their limit is under Bun's cap of 255 s", () => {
    expect(TRANSFER_IDLE_SECONDS).toBeGreaterThan(10);
    expect(TRANSFER_IDLE_SECONDS).toBeLessThanOrEqual(255);
    const ws = "/api/v1/workspaces/w";
    expect(
      [`${ws}/files/f/blob`, `${ws}/files/files`, `${ws}/files/f/files`, `${ws}/files/uploads/u`].map(
        isTransfer,
      ),
    ).toEqual([true, true, true, true]);
    expect(
      [`${ws}/files/f`, `${ws}/files/f/text`, `${ws}/files/uploads`, `${ws}/search`, "/api/v1/me"].map(
        isTransfer,
      ),
    ).toEqual([false, false, false, false, false]);
  });

  test("a download read with a pause longer than the default limit arrives whole, from the bucket", async () => {
    Object.assign(bucketDeadlines, { pieceMs: 200 });
    const ana = await signedIn(server, "Ana", "ana@drive-slow-client.test");
    const { workspaceId } = await seedWorkspace(server, ana, "Slow");
    await saveStorage(server.deps, workspaceId, {
      kind: "s3",
      s3: {
        endpoint: s3.endpoint,
        region: "us-east-1",
        bucket: "workshop",
        prefix: "slow",
        pathAddressing: true,
        accessKeyId: "AKIAWORKSHOP",
        secretAccessKey: "bucket-secret-key",
      },
    });
    const form = new FormData();
    form.set("file", new File([new Uint8Array(SIZE).fill(97)], "big.bin"));
    const file = await body(
      await ana.browser.fetch(`/api/v1/workspaces/${workspaceId}/files/files`, {
        method: "POST",
        body: form,
      }),
    );
    const res = await ana.browser.fetch(`/api/v1/workspaces/${workspaceId}/files/${file.id}/blob`);
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let total = (await reader.read()).value?.byteLength ?? 0;
    // The client goes quiet for longer than the default limit (and than the bucket's piece deadline).
    await new Promise((r) => setTimeout(r, 9000));
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
    }
    expect(total).toBe(SIZE);
  }, 30_000);
});
