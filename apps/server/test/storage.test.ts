// The workspace's storage through its routes, on a real fake S3 (local HTTP): testing the bucket, saving, new Drive
// files in the bucket, reading the old ones from the server, the migration and going back. Only `configure` may see
// or change it. The restart of a migration left running waits for the runtime's start (the ledger lists it);
// storage-routing.test.ts covers the module's resume.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrationDone } from "../src/integrations/storage";
import type { RunningServer } from "../src/server";
import { type FakeS3, startFakeS3 } from "./fake-s3";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, type Person, seedWorkspace } from "./seed";

let s3: FakeS3;
let server: RunningServer;
beforeAll(async () => {
  s3 = startFakeS3("workshop");
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" } });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  s3.stop();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@storage.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId } = await seedWorkspace(server, ana, "Workshop");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const url = (path: string) => `${ws(workspaceId)}${path}`;
  return { workspaceId, ana, beto, url };
}

async function upload(who: Person, url: (p: string) => string, text: string) {
  const form = new FormData();
  form.set("file", new File([text], `${text}.txt`, { type: "text/plain" }));
  const res = await who.browser.fetch(url("/files/files"), { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return body(res);
}
const read = async (who: Person, url: (p: string) => string, fileId: string) =>
  (await who.browser.fetch(url(`/files/${fileId}/blob`))).text();

describe("storage", () => {
  test(
    "test, save, write to the bucket, read what stayed on the server, migrate and go back",
    async () => {
      const { workspaceId, ana, beto, url } = await team();
      expect((await call(ana, "GET", url("/storage"))).body).toEqual({
        kind: "builtin",
        s3: null,
        transfer: null,
      });
      expect((await call(beto, "GET", url("/storage"))).status).toBe(403);
      expect((await call(beto, "GET", url("/storage/migration-status"))).status).toBe(403);
      const before = await upload(ana, url, "before");

      const input = {
        endpoint: s3.endpoint,
        region: "us-east-1",
        bucket: "workshop",
        prefix: "/vanr/",
        pathAddressing: true,
        accessKeyId: "AKIAWORKSHOP",
        secretAccessKey: "bucket-secret-key",
      };
      s3.failOn.add("LIST");
      const failed = (await call(ana, "POST", url("/storage/test"), input)).body;
      expect(failed.ok).toBe(false);
      expect(failed.steps.map((s: { step: string; ok: boolean }) => [s.step, s.ok])).toEqual([
        ["write", true],
        ["read", true],
        ["list", false],
      ]);
      expect((await call(ana, "PUT", url("/storage"), { kind: "s3", s3: input })).body.error.code).toBe(
        "storage.bucket_check_failed",
      );
      s3.failOn.clear();
      expect((await call(ana, "POST", url("/storage/test"), input)).body.ok).toBe(true);
      const keyless = { ...input, accessKeyId: undefined, secretAccessKey: undefined };
      expect((await call(ana, "POST", url("/storage/test"), keyless)).body.error.code).toBe(
        "storage.credentials_missing",
      );
      expect((await call(beto, "PUT", url("/storage"), { kind: "s3", s3: input })).status).toBe(403);

      const saved = (await call(ana, "PUT", url("/storage"), { kind: "s3", s3: input })).body;
      expect(saved).toMatchObject({
        kind: "s3",
        s3: {
          endpoint: s3.endpoint,
          bucket: "workshop",
          prefix: "vanr",
          pathAddressing: true,
          accessKeyIdPreview: "…SHOP",
          secretPreview: "…-key",
        },
      });
      expect(JSON.stringify(saved)).not.toContain(input.secretAccessKey);
      // The form again without the keys: the saved ones are used.
      expect((await call(ana, "POST", url("/storage/test"), keyless)).body.ok).toBe(true);
      expect(s3.unsigned).toBe(0);

      // A new file goes to the bucket (with the prefix); the old one stays readable from the server.
      const after = await upload(ana, url, "after");
      const keys = [...s3.objects.keys()].filter((k) => k.startsWith(`vanr/files/${workspaceId}/`));
      expect(keys).toHaveLength(1);
      expect(keys[0]).toStartWith(`vanr/files/${workspaceId}/${after.id}/1-`);
      expect(await read(ana, url, after.id)).toBe("after");
      expect(await read(ana, url, before.id)).toBe("before");

      expect((await call(ana, "GET", url("/storage/migration-status"))).body).toBeNull();
      expect((await call(beto, "POST", url("/storage/migrate"))).status).toBe(403);
      expect((await call(ana, "POST", url("/storage/migrate"))).body).toMatchObject({
        status: "running",
        total: 1,
      });
      await migrationDone(workspaceId);
      expect((await call(ana, "GET", url("/storage/migration-status"))).body).toEqual({
        status: "done",
        copied: 1,
        total: 1,
        error: null,
      });
      expect(
        [...s3.objects.keys()].some((k) => k.startsWith(`vanr/files/${workspaceId}/${before.id}/1-`)),
      ).toBe(true);
      expect((await call(ana, "GET", url("/storage"))).body.transfer?.status).toBe("done");

      // Back to the server's storage: what was written in the bucket stays readable.
      expect((await call(ana, "PUT", url("/storage"), { kind: "builtin" })).body.kind).toBe("builtin");
      expect(await read(ana, url, after.id)).toBe("after");
      expect((await call(ana, "POST", url("/storage/migrate"))).body.error.code).toBe("storage.not_s3");
    },
    SERVER_TEST_MS,
  );
});
