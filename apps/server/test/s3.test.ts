import { afterAll, expect, setSystemTime, test } from "bun:test";
import { client, type S3Settings, s3Blobs, testS3 } from "../src/integrations/s3";
import { startFakeS3 } from "./fake-s3";

const s3 = startFakeS3();
afterAll(() => s3.stop());
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
  const store = s3Blobs(cfg(), true);
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
  expect(await testS3("p1", s3Blobs(cfg(), true))).toEqual({
    ok: true,
    steps: [
      { step: "write", ok: true },
      { step: "read", ok: true },
      { step: "list", ok: true },
      { step: "delete", ok: true },
    ],
  });
  s3.failOn.add("LIST");
  const failed = await testS3("p2", s3Blobs(cfg(), true));
  s3.failOn.clear();
  expect(failed.ok).toBe(false);
  expect(failed.steps.map((s) => [s.step, s.ok])).toEqual([
    ["write", true],
    ["read", true],
    ["list", false],
  ]);
  const wrongBucket = await testS3("p3", s3Blobs(cfg({ bucket: "outro" }), true));
  expect(wrongBucket.steps).toHaveLength(1);
  expect(wrongBucket.steps[0]?.ok).toBe(false);
});

// Independent AWS vectors: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
test("matches AWS SigV4 vectors for Range, payload escaping and sorted queries", async () => {
  const signatures: string[] = [];
  const capture = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      signatures.push(new Headers(init?.headers).get("authorization")?.split("Signature=")[1] ?? "");
      return new Response(null);
    },
    { preconnect() {} },
  );
  const c = client(
    cfg({
      endpoint: "https://examplebucket.s3.amazonaws.com",
      bucket: "examplebucket",
      pathAddressing: false,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    }),
    true,
    capture,
  );
  setSystemTime(new Date("2013-05-24T00:00:00Z"));
  try {
    await c.request("GET", "test.txt", {}, undefined, { range: "bytes=0-9" });
    await c.request("PUT", "test$file.text", {}, "Welcome to Amazon S3.", {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    });
    await c.request("GET", "", { prefix: "J", "max-keys": "2" });
    expect(signatures).toEqual([
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    ]);
  } finally {
    setSystemTime();
  }
});

for (const pathAddressing of [true, false])
  test(`pins every S3 operation, multipart and lazy reads (${pathAddressing ? "path" : "virtual"})`, async () => {
    const bucket = startFakeS3("workshop", 1);
    const host = pathAddressing ? "objects.example" : "workshop.objects.example";
    const ops: { method: string; key: string; query: Record<string, string> }[] = [];
    let privateDns = false;
    const resolve = async (name: string) => {
      expect(name).toBe(host);
      return [privateDns ? "127.0.0.1" : "93.184.216.34"];
    };
    const wire = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.hostname).toBe("93.184.216.34");
        expect(new Headers(init?.headers).get("host")).toBe(host);
        expect(init && "tls" in init && init.tls).toEqual({ serverName: host });
        ops.push({
          method: init?.method ?? "GET",
          key: decodeURIComponent(url.pathname.slice(pathAddressing ? bucket.bucket.length + 2 : 1)),
          query: Object.fromEntries(url.searchParams),
        });
        return fetch(`${bucket.endpoint}${url.pathname}${url.search}`, init);
      },
      { preconnect() {} },
    );
    const settings = cfg({ endpoint: `https://${host}`, pathAddressing });
    const store = s3Blobs(settings, false, wire, resolve);
    const saved = client(settings, false, wire, resolve);
    try {
      const bytes = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251);
      const large = new Blob([bytes]);
      Object.assign(large, { bytes: () => Promise.reject(new Error("whole upload buffered")) });
      await store.put("large", large, "application/test");
      expect(Buffer.compare((await store.get("large"))?.bytes ?? new Uint8Array(), bytes)).toBe(0);
      const file = await store.open("large");
      expect(await file?.body.slice(-11, -1).bytes()).toEqual(bytes.slice(-11, -1));
      await store.put("sp ace/+&!é", new Uint8Array([7]), "application/octet-stream");
      expect(await store.keys()).toEqual(["large", "sp ace/+&!é"]);
      bucket.failOn.add("PUT");
      await expect(store.put("failed", large, "text/plain")).rejects.toMatchObject({ code: "AccessDenied" });
      bucket.failOn.clear();
      bucket.override = (r) =>
        r.method === "POST" && r.query.has("uploadId")
          ? new Response("<Error><Code>InternalError</Code></Error>")
          : null;
      await expect(store.put("failed", large, "text/plain")).rejects.toMatchObject({ code: "InternalError" });
      expect([bucket.pending, bucket.aborted]).toEqual([0, 2]);
      const cancelled = Promise.withResolvers<void>();
      bucket.override = (r) =>
        r.method === "GET" && !r.list
          ? new Response(
              new ReadableStream({
                start: (c) => c.enqueue(new Uint8Array([1])),
                cancel: () => cancelled.resolve(),
              }),
            )
          : null;
      const reader = file?.body.stream().getReader();
      await reader?.read();
      await reader?.cancel();
      await cancelled.promise;
      bucket.override = null;
      await store.delete("large");
      const before = ops.length;
      privateDns = true;
      for (const op of ops)
        await expect(saved.request(op.method, op.key, op.query)).rejects.toMatchObject({
          code: "blocked_host",
        });
      await expect(file?.body.slice(0, 1).bytes()).rejects.toMatchObject({ code: "blocked_host" });
      expect(ops.length).toBe(before);
    } finally {
      bucket.stop();
    }
  });

test("revalidates and re-signs redirects, and never follows a private redirect", async () => {
  const signatures: string[] = [];
  const hosts: string[] = [];
  const wire = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.hostname).toBe("93.184.216.34");
      const name = signatures.length ? "next.example" : "first.example";
      expect(headers.get("host")).toBe(name);
      expect(init && "tls" in init && init.tls).toEqual({ serverName: name });
      expect([init?.method, init?.body]).toEqual(["PUT", "bytes"]);
      signatures.push(headers.get("authorization") ?? "");
      return signatures.length === 1
        ? new Response("redirect", {
            status: 307,
            headers: { location: "https://next.example/new?uploadId=a%2B%2F&partNumber=1" },
          })
        : new Response(null);
    },
    { preconnect() {} },
  );
  const resolve = async (host: string) => {
    hosts.push(host);
    return ["93.184.216.34"];
  };
  await client(cfg({ endpoint: "https://first.example" }), false, wire, resolve).request(
    "PUT",
    "key",
    {},
    "bytes",
  );
  expect(hosts).toEqual(["first.example", "next.example"]);
  expect(signatures[0]).not.toBe(signatures[1]);
  let calls = 0;
  const redirect = Object.assign(
    async () => {
      calls++;
      return new Response(null, { status: 307, headers: { location: "https://127.0.0.1/metadata" } });
    },
    { preconnect() {} },
  );
  await expect(
    client(cfg({ endpoint: "https://first.example" }), false, redirect, resolve).request("GET", "key"),
  ).rejects.toMatchObject({ code: "blocked_host" });
  expect(calls).toBe(1);
});
