// Fake S3, but a real one: local HTTP in path style (/bucket/key), with PUT, GET, HEAD,
// DELETE, multipart and paginated ListObjectsV2. Signature vectors live in s3.test.ts.
export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, { bytes: Uint8Array; type: string }>;
  /** Makes the step fail with 403 (tests the connection test report). */
  failOn: Set<"PUT" | "GET" | "LIST" | "DELETE">;
  unsigned: number;
  pending: number;
  aborted: number;
  /**
   * Answers a request instead of the bucket when it returns a response (any status, a body that breaks in
   * the middle, a promise that never settles for a deadline); null lets the bucket answer. `list` is true for
   * ListObjectsV2.
   */
  override:
    | ((req: {
        method: string;
        key: string;
        list: boolean;
        query: URLSearchParams;
      }) => Response | Promise<Response> | null)
    | null;
  stop(): void;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function startFakeS3(bucket = "workshop", pageSize = 1000): FakeS3 {
  const objects: FakeS3["objects"] = new Map();
  const failOn: FakeS3["failOn"] = new Set();
  const state: { unsigned: number; override: FakeS3["override"] } = { unsigned: 0, override: null };
  const uploads = new Map<string, { key: string; type: string; parts: Map<number, Uint8Array> }>();
  let aborted = 0;
  const server = Bun.serve({
    port: 0,
    // No idle timeout: a request the test holds open stays open until the client closes it (or the stop),
    // so a test can see whether the server closed its connection to the bucket.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!req.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256")) state.unsigned++;
      const virtual = req.headers.get("host")?.startsWith(`${bucket}.`);
      const [, b, ...rest] = (virtual ? `/${bucket}${url.pathname}` : url.pathname).split("/");
      if (b !== bucket) return new Response("NoSuchBucket", { status: 404 });
      const key = decodeURIComponent(rest.join("/"));
      const denied = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      const forced = state.override?.({
        method: req.method,
        key,
        list: !key && req.method === "GET",
        query: url.searchParams,
      });
      if (forced) return await forced;
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const id = `upload/+=${uploads.size}`;
        uploads.set(id, { key, type: req.headers.get("content-type") ?? "", parts: new Map() });
        return new Response(
          `<InitiateMultipartUploadResult><UploadId>${xml(id)}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      const uploadId = url.searchParams.get("uploadId");
      if (uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) return new Response("NoSuchUpload", { status: 404 });
        if (req.method === "PUT") {
          if (failOn.has("PUT")) return denied();
          const n = Number(url.searchParams.get("partNumber"));
          upload.parts.set(n, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { headers: { etag: `"part-${n}"` } });
        }
        if (req.method === "POST") {
          const parts = [...upload.parts];
          const manifest = parts
            .map(([n]) => `<Part><PartNumber>${n}</PartNumber><ETag>"part-${n}"</ETag></Part>`)
            .join("");
          if (
            !parts.length ||
            parts.some(
              ([n, bytes], i) => n !== i + 1 || (i < parts.length - 1 && bytes.length < 5 * 1024 * 1024),
            ) ||
            (await req.text()) !== `<CompleteMultipartUpload>${manifest}</CompleteMultipartUpload>`
          )
            return new Response("InvalidPart", { status: 400 });
          objects.set(key, { bytes: Buffer.concat(parts.map(([, bytes]) => bytes)), type: upload.type });
        } else if (req.method === "DELETE") aborted++;
        uploads.delete(uploadId);
        return new Response(req.method === "POST" ? "<CompleteMultipartUploadResult/>" : null);
      }
      if (!key && req.method === "GET") {
        if (failOn.has("LIST")) return denied();
        const prefix = url.searchParams.get("prefix") ?? "";
        const all = [...objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > (url.searchParams.get("continuation-token") ?? ""))
          .sort();
        const keys = all.slice(0, Math.min(pageSize, Number(url.searchParams.get("max-keys") ?? 1000)));
        const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${keys.length < all.length}</IsTruncated><NextContinuationToken>${xml(keys.at(-1) ?? "")}</NextContinuationToken>${keys
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
        // A GET with `Range: bytes=a-b` answers that slice, as S3 does (the client reads ranges this way).
        const range =
          req.method === "GET" ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "") : null;
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(Number(range[2]), obj.bytes.length - 1) : obj.bytes.length - 1;
          if (start >= obj.bytes.length || end < start)
            return new Response("<Error><Code>InvalidRange</Code></Error>", { status: 416 });
          return new Response(obj.bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              ...headers,
              "content-length": String(end - start + 1),
              "content-range": `bytes ${start}-${end}/${obj.bytes.length}`,
            },
          });
        }
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
    get pending() {
      return uploads.size;
    },
    get aborted() {
      return aborted;
    },
    get unsigned() {
      return state.unsigned;
    },
    get override() {
      return state.override;
    },
    set override(fn) {
      state.override = fn;
    },
    stop: () => server.stop(true),
  };
}
