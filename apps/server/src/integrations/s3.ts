// S3 storage of the workspace (optional): the same BlobStore contract, on top of Bun's S3Client.
// Works with AWS, R2, MinIO and the like (custom endpoint, optional path style).
import type { BlobStore } from "@vanr/engine/blobs";
import { PRODUCT } from "@vanr/product";

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

function client(cfg: S3Settings) {
  return new Bun.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region || "auto",
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    virtualHostedStyle: !cfg.pathAddressing,
  });
}

const join = (prefix: string, key: string) => (prefix ? `${prefix}/${key}` : key);

export function s3Blobs(cfg: S3Settings): BlobStore {
  const s3 = client(cfg);
  return {
    // With a Blob (local file), Bun uploads in parts (multipart) and does not load it all.
    async put(key, data, contentType) {
      await s3.write(join(cfg.prefix, key), data, { type: contentType });
    },
    async open(key) {
      const file = s3.file(join(cfg.prefix, key));
      if (!(await file.exists())) return null;
      const stat = await file.stat();
      return { size: stat.size, contentType: stat.type || "application/octet-stream", body: file };
    },
    async get(key) {
      const file = s3.file(join(cfg.prefix, key));
      if (!(await file.exists())) return null;
      const [bytes, stat] = await Promise.all([file.bytes(), file.stat()]);
      return { bytes, contentType: stat.type || "application/octet-stream" };
    },
    async delete(key) {
      await s3.delete(join(cfg.prefix, key));
    },
    async keys() {
      const out: string[] = [];
      const base = cfg.prefix ? `${cfg.prefix}/` : "";
      let token: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const res = await s3.list({ prefix: base, ...(token ? { continuationToken: token } : {}) });
        for (const item of res.contents ?? []) out.push(item.key.slice(base.length));
        if (!res.isTruncated || !res.nextContinuationToken) break;
        token = res.nextContinuationToken;
      }
      return out;
    },
  };
}

/** Writes, reads, lists and deletes a probe object; stops at the first step that fails. */
export async function testS3(
  cfg: S3Settings,
  probeId: string,
): Promise<{ ok: boolean; steps: { step: S3Step; ok: boolean; error?: string }[] }> {
  const store = s3Blobs(cfg);
  const key = `.${PRODUCT.slug}-probe-${probeId}`;
  const body = new TextEncoder().encode(`probe ${probeId}`);
  const steps: { step: S3Step; ok: boolean; error?: string }[] = [];
  const attempt = async (step: S3Step, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ step, ok: true });
      return true;
    } catch (err) {
      steps.push({ step, ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
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
