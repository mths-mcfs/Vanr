import { afterAll, expect, test } from "bun:test";
import { type S3Settings, s3Blobs, testS3 } from "../src/integrations/s3";
import { startFakeS3 } from "./fake-s3";

const s3 = startFakeS3();
afterAll(() => s3.stop());
/** The fake S3 listens on localhost over http: the installation allows both. */
const LOCAL = { allowPrivate: true, allowPlaintext: true };
const cfg = (extra: Partial<S3Settings> = {}): S3Settings => ({
  endpoint: s3.endpoint,
  region: "us-east-1",
  bucket: s3.bucket,
  prefix: "vanr",
  pathAddressing: true,
  accessKeyId: "AKIATEST",
  secretAccessKey: "secret",
  ...extra,
});

test("stores, reads with the type, lists without the prefix and deletes, with a signed request", async () => {
  const store = s3Blobs(cfg(), LOCAL);
  await store.put("workspaces/o1/a.txt", new TextEncoder().encode("hi"), "text/plain");
  expect([...s3.objects.keys()]).toEqual(["vanr/workspaces/o1/a.txt"]);
  const got = await store.get("workspaces/o1/a.txt");
  expect(new TextDecoder().decode(got?.bytes)).toBe("hi");
  expect(got?.contentType).toContain("text/plain");
  expect(await store.get("workspaces/o1/nothing")).toBeNull();
  expect(await store.keys()).toEqual(["workspaces/o1/a.txt"]);
  await store.delete("workspaces/o1/a.txt");
  expect(s3.objects.size).toBe(0);
  expect(s3.unsigned).toBe(0);
});

test("connection test goes through the four steps and stops at the first that fails", async () => {
  expect(await testS3(cfg(), "p1", LOCAL)).toEqual({
    ok: true,
    steps: [
      { step: "write", ok: true },
      { step: "read", ok: true },
      { step: "list", ok: true },
      { step: "delete", ok: true },
    ],
  });
  s3.failOn.add("LIST");
  const failed = await testS3(cfg(), "p2", LOCAL);
  s3.failOn.clear();
  expect(failed.ok).toBe(false);
  expect(failed.steps.map((s) => [s.step, s.ok])).toEqual([
    ["write", true],
    ["read", true],
    ["list", false],
  ]);
  const wrongBucket = await testS3(cfg({ bucket: "outro" }), "p3", LOCAL);
  expect(wrongBucket.steps).toHaveLength(1);
  expect(wrongBucket.steps[0]?.ok).toBe(false);
});
