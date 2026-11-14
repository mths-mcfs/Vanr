// Fake S3, but a real one: local HTTP in path style (/bucket/key), with PUT, GET, HEAD,
// DELETE and ListObjectsV2. It does not check the signature; it records who called without a credential.
export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, { bytes: Uint8Array; type: string }>;
  /** Makes the step fail with 403 (tests the connection test report). */
  failOn: Set<"PUT" | "GET" | "LIST" | "DELETE">;
  unsigned: number;
  stop(): void;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function startFakeS3(bucket = "workshop"): FakeS3 {
  const objects: FakeS3["objects"] = new Map();
  const failOn: FakeS3["failOn"] = new Set();
  const state = { unsigned: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) state.unsigned++;
      const [, b, ...rest] = url.pathname.split("/");
      if (b !== bucket) return new Response("NoSuchBucket", { status: 404 });
      const key = decodeURIComponent(rest.join("/"));
      const denied = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      if (!key && req.method === "GET") {
        if (failOn.has("LIST")) return denied();
        const prefix = url.searchParams.get("prefix") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${keys
          .map(
            (k) =>
              `<Contents><Key>${xml(k)}</Key><Size>${objects.get(k)?.bytes.length ?? 0}</Size></Contents>`,
          )
          .join("")}</ListBucketResult>`;
        return new Response(body, { headers: { "content-type": "application/xml" } });
      }
      if (req.method === "PUT") {
        if (failOn.has("PUT")) return denied();
        objects.set(key, {
          bytes: new Uint8Array(await req.arrayBuffer()),
          type: req.headers.get("content-type") ?? "application/octet-stream",
        });
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      }
      const obj = objects.get(key);
      if (req.method === "DELETE") {
        if (failOn.has("DELETE")) return denied();
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        if (failOn.has("GET")) return denied();
        if (!obj) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        const headers = {
          "content-type": obj.type,
          "content-length": String(obj.bytes.length),
          etag: '"x"',
          "last-modified": new Date().toUTCString(),
        };
        return new Response(req.method === "HEAD" ? null : obj.bytes, { headers });
      }
      return new Response("unsupported", { status: 405 });
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    bucket,
    objects,
    failOn,
    get unsigned() {
      return state.unsigned;
    },
    stop: () => server.stop(true),
  };
}
