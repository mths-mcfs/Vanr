import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

export interface Blob {
  bytes: Uint8Array;
  contentType: string;
}

/** File opened without reading it: `body.slice(a, b)` reads only that range (Range, first bytes, stream). */
interface BlobHandle {
  size: number;
  contentType: string;
  body: globalThis.Blob;
}

/** File storage (avatar, logo, Drive). Disk in dev, memory in tests, optional S3. */
export interface BlobStore {
  /** With a Blob (`Bun.file`, `open().body`), it writes as a stream, without loading the whole file. */
  put(key: string, data: Uint8Array | globalThis.Blob, contentType: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
  open(key: string): Promise<BlobHandle | null>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function memoryBlobs(): BlobStore {
  const data = new Map<string, Blob>();
  return {
    put: async (key, d, contentType) =>
      void data.set(key, { bytes: d instanceof Uint8Array ? d : await d.bytes(), contentType }),
    get: async (key) => data.get(key) ?? null,
    async open(key) {
      const b = data.get(key);
      return b
        ? { size: b.bytes.byteLength, contentType: b.contentType, body: new globalThis.Blob([b.bytes]) }
        : null;
    },
    delete: async (key) => void data.delete(key),
    keys: async () => [...data.keys()],
  };
}

export function diskBlobs(root: string): BlobStore {
  const base = normalize(root).replace(/[/\\]+$/, "");
  // With a trailing separator: "blobs-x/..." cannot pass as inside "blobs".
  const pathOf = (key: string) => {
    const p = normalize(join(base, key));
    if (!p.startsWith(base + sep)) throw new Error("blob key escapes the store");
    return p;
  };
  return {
    async put(key, data, contentType) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await Bun.write(p, data);
      await writeFile(`${p}.type`, contentType);
    },
    async open(key) {
      const p = pathOf(key);
      let size: number;
      try {
        size = (await stat(p)).size;
      } catch {
        return null;
      }
      const type = await readFile(`${p}.type`, "utf8").catch(() => "");
      return { size, contentType: type || "application/octet-stream", body: Bun.file(p) };
    },
    async get(key) {
      const p = pathOf(key);
      try {
        await stat(p);
      } catch {
        return null;
      }
      const [bytes, type] = await Promise.all([readFile(p), readFile(`${p}.type`, "utf8").catch(() => "")]);
      return { bytes: new Uint8Array(bytes), contentType: type || "application/octet-stream" };
    },
    async delete(key) {
      const p = pathOf(key);
      await rm(p, { force: true });
      await rm(`${p}.type`, { force: true });
    },
    async keys() {
      const out: string[] = [];
      const glob = new Bun.Glob("**/*");
      for await (const file of glob.scan({ cwd: base, onlyFiles: true })) {
        if (!file.endsWith(".type")) out.push(file);
      }
      return out;
    },
  };
}
