// S3 storage with signed requests over the integration network guard.
// Works with AWS, R2, MinIO and the like (custom endpoint, optional path style).
import { createHash, createHmac } from "node:crypto";
import type { BlobStore } from "@vanr/engine/blobs";
import { PRODUCT } from "@vanr/product";
import { Window } from "happy-dom";
import { guardedFetch, type Resolver } from "./net";

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  /** Prefix inside the bucket ("" = root). Never ends with a slash. */
  prefix: string;
  pathAddressing: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export type S3Step = "write" | "read" | "list" | "delete";

const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const mac = (key: string | Uint8Array, s: string) => createHmac("sha256", key).update(s).digest();
const xmlWindow = new Window();
const xml = (s: string) => new xmlWindow.DOMParser().parseFromString(s, "application/xml");
const readXml = async (res: Response, root?: string) => {
  const doc = xml(await res.text());
  const code =
    doc.querySelector("Error > Code")?.textContent ||
    (doc.querySelector("Error") || (root && !doc.querySelector(root)) ? "InvalidResponse" : null);
  if (code) throw Object.assign(new Error(doc.querySelector("Message")?.textContent || code), { code });
  return doc;
};
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const partSize = 5 * 1024 * 1024;

/** All S3 operations, including redirects, connect only to the address approved by the network guard. */
export function client(cfg: S3Settings, allowPrivate: boolean, fetchFn = fetch, resolve?: Resolver) {
  const signed = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    headers.set("host", headers.get("host") ?? url.host);
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const payload = init.body ?? "";
    if (typeof payload !== "string" && !(payload instanceof Uint8Array)) throw new Error("Invalid S3 body");
    const payloadHash = hash(payload);
    headers.set("x-amz-date", date);
    headers.set("x-amz-content-sha256", payloadHash);
    const query = [...url.searchParams]
      .map(([k, v]) => [encode(k), encode(v)] as const)
      .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    url.pathname = url.pathname
      .split("/")
      .map((s) => encode(decodeURIComponent(s)))
      .join("/");
    url.search = query;
    const names = [...headers.keys()].sort();
    const canonical = [
      init.method ?? "GET",
      url.pathname,
      query,
      names.map((k) => `${k}:${headers.get(k)?.trim().replace(/\s+/g, " ")}\n`).join(""),
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date.slice(0, 8)}/${cfg.region || "auto"}/s3/aws4_request`;
    let key = mac(`AWS4${cfg.secretAccessKey}`, date.slice(0, 8));
    for (const part of [cfg.region || "auto", "s3", "aws4_request"]) key = mac(key, part);
    const signature = mac(key, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex");
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
    );
    const res = await fetchFn(url, { ...init, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) await res.body?.cancel();
    return res;
  };
  const send = guardedFetch(Object.assign(signed, { preconnect() {} }), allowPrivate, resolve);
  const request = async (
    method: string,
    key = "",
    query: Record<string, string> = {},
    body?: string | Uint8Array,
    headers?: RequestInit["headers"],
    signal?: AbortSignal,
  ) => {
    const url = new URL(cfg.endpoint);
    // As with Bun.S3Client, a virtual-hosted endpoint already contains the bucket.
    url.search = "";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${cfg.pathAddressing ? `${encode(cfg.bucket)}/` : ""}${key.split("/").map(encode).join("/")}`;
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await send(url, { method, body, headers, signal });
    if (!res.ok) {
      await readXml(res);
      const code = res.status === 404 && method === "HEAD" ? "NoSuchKey" : `HTTP${res.status}`;
      throw Object.assign(new Error(code), { code });
    }
    return res;
  };
  return {
    request,
    async list(opts: { prefix: string; maxKeys?: number; continuationToken?: string }) {
      const query = {
        "list-type": "2",
        prefix: opts.prefix,
        "max-keys": String(opts.maxKeys ?? 1000),
        ...(opts.continuationToken ? { "continuation-token": opts.continuationToken } : {}),
      };
      const doc = await request("GET", "", query).then((res) => readXml(res, "ListBucketResult"));
      return {
        contents: [...doc.querySelectorAll("Contents > Key")].map((n) => ({ key: n.textContent })),
        isTruncated: doc.querySelector("IsTruncated")?.textContent === "true",
        nextContinuationToken: doc.querySelector("NextContinuationToken")?.textContent,
      };
    },
  };
}

const join = (prefix: string, key: string) => (prefix ? `${prefix}/${key}` : key);

export function s3Blobs(
  cfg: S3Settings,
  allowPrivate: boolean,
  fetchFn = fetch,
  resolve?: Resolver,
): BlobStore {
  const { request, list } = client(cfg, allowPrivate, fetchFn, resolve);
  const remoteBody = (key: string, start: number, end: number, type: string): Blob => {
    const size = end - start;
    const response = (signal?: AbortSignal) =>
      size
        ? request("GET", key, {}, undefined, { range: `bytes=${start}-${end - 1}` }, signal)
        : Promise.resolve(new Response(null));
    const body: Blob = {
      size,
      type,
      slice(a = 0, b = size, t = "") {
        const edge = (n: number) => Math.min(size, Math.max(0, (n < 0 ? size : 0) + (Math.trunc(n) || 0)));
        const low = edge(a);
        return remoteBody(key, start + low, start + Math.max(low, edge(b)), t);
      },
      bytes: async () => new Uint8Array(await (await response()).arrayBuffer()),
      arrayBuffer: async () => (await response()).arrayBuffer(),
      text: async () => (await response()).text(),
      json: async () => (await response()).json(),
      formData: async () => new Blob([await body.bytes()], { type }).formData(),
      image: (options) => new Bun.Image(body, options),
      stream() {
        const abort = new AbortController();
        let reader: Pick<ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>, "read" | "cancel"> | undefined;
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
          async pull(c) {
            reader ??= (await response(abort.signal)).body?.getReader();
            const part = await reader?.read();
            if (!part || part.done) c.close();
            else c.enqueue(part.value);
          },
          cancel(reason) {
            const closed = reader?.cancel(reason);
            abort.abort(reason);
            return closed;
          },
        });
      },
    };
    return body;
  };
  const open = async (key: string) => {
    key = join(cfg.prefix, key);
    let res: Response;
    try {
      res = await request("HEAD", key);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "NoSuchKey") return null;
      throw err;
    }
    const size = Number(res.headers.get("content-length"));
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    return { size, contentType, body: remoteBody(key, 0, size, contentType) };
  };
  return {
    async put(key, data, contentType) {
      key = join(cfg.prefix, key);
      const blob = data instanceof Uint8Array ? new Blob([data]) : data;
      if (blob.size <= partSize) {
        await (
          await request("PUT", key, {}, await blob.bytes(), { "content-type": contentType })
        ).body?.cancel();
        return;
      }
      const initiated = await request("POST", key, { uploads: "" }, undefined, {
        "content-type": contentType,
      }).then((res) => readXml(res, "InitiateMultipartUploadResult"));
      const uploadId = initiated.querySelector("UploadId")?.textContent;
      if (!uploadId) throw new Error("S3 did not return an upload ID");
      try {
        const parts: string[] = [];
        // Stay below S3's 10,000-part limit and buffer only one part, including for Bun.file and migration.
        const chunk = Math.max(partSize, Math.ceil(blob.size / 10000));
        for (let offset = 0; offset < blob.size; offset += chunk) {
          const number = String(parts.length + 1);
          const res = await request(
            "PUT",
            key,
            { uploadId, partNumber: number },
            await blob.slice(offset, offset + chunk).bytes(),
          );
          const etag = res.headers.get("etag");
          await res.body?.cancel();
          if (!etag) throw new Error("S3 did not return a part ETag");
          parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
        }
        await request(
          "POST",
          key,
          { uploadId },
          `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
          { "content-type": "application/xml" },
        ).then((res) => readXml(res, "CompleteMultipartUploadResult"));
      } catch (err) {
        await request("DELETE", key, { uploadId })
          .then((res) => res.body?.cancel())
          .catch(() => {});
        throw err;
      }
    },
    open,
    async get(key) {
      const file = await open(key);
      return file ? { bytes: await file.body.bytes(), contentType: file.contentType } : null;
    },
    async delete(key) {
      await (await request("DELETE", join(cfg.prefix, key))).body?.cancel();
    },
    async keys() {
      const out: string[] = [];
      const base = cfg.prefix ? `${cfg.prefix}/` : "";
      let token: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const res = await list({ prefix: base, ...(token ? { continuationToken: token } : {}) });
        for (const item of res.contents) out.push(item.key.slice(base.length));
        if (!res.isTruncated || !res.nextContinuationToken) break;
        token = res.nextContinuationToken;
      }
      return out;
    },
  };
}

/** Writes, reads, lists and deletes a probe object; stops at the first step that fails. */
export async function testS3(
  probeId: string,
  store: BlobStore,
): Promise<{ ok: boolean; steps: { step: S3Step; ok: boolean; error?: string }[] }> {
  const key = `.${PRODUCT.slug}-probe-${probeId}`;
  const body = new TextEncoder().encode(`probe ${probeId}`);
  const steps: { step: S3Step; ok: boolean; error?: string }[] = [];
  const attempt = async (step: S3Step, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ step, ok: true });
      return true;
    } catch (err) {
      // A wrapped error keeps what the bucket answered in `reason`: that is what the person needs to see.
      const shown =
        typeof err === "object" && err !== null && "reason" in err && err.reason instanceof Error
          ? err.reason
          : err;
      steps.push({
        step,
        ok: false,
        error: shown instanceof Error ? shown.message.slice(0, 300) : String(shown),
      });
      return false;
    }
  };
  const ok =
    (await attempt("write", () => store.put(key, body, "text/plain"))) &&
    (await attempt("read", async () => {
      const got = await store.get(key);
      if (!got || new TextDecoder().decode(got.bytes) !== `probe ${probeId}`)
        throw new Error("read back differs");
    })) &&
    (await attempt("list", async () => {
      if (!(await store.keys()).includes(key)) throw new Error("object not listed");
    })) &&
    (await attempt("delete", () => store.delete(key)));
  return { ok, steps };
}
