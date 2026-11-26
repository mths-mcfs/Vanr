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

/**
 * Blobs on disk. The bytes live under `<root>/data/<key>` and the content type under `<root>/meta/<key>`: two
 * separate trees, so no key can name another key's metadata (a key must stay inside `data`).
 */
export function diskBlobs(root: string): BlobStore {
  const base = normalize(root).replace(/[/\\]+$/, "");
  const dataRoot = join(base, "data");
  const metaRoot = join(base, "meta");
  const writes = new Map<string, Promise<void>>();
  // With a trailing separator: "data-x/..." cannot pass as inside "data".
  const pathsOf = (key: string) => {
    const data = normalize(join(dataRoot, key));
    if (!data.startsWith(dataRoot + sep)) throw new Error("blob key escapes the store");
    return { data, meta: join(metaRoot, data.slice(dataRoot.length + 1)) };
  };
  const typeOf = (meta: string) =>
    readFile(meta, "utf8")
      .catch(() => "")
      .then((type) => type || "application/octet-stream");
  return {
    async put(key, data, contentType) {
      const p = pathsOf(key);
      const write = (writes.get(p.data) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await mkdir(dirname(p.data), { recursive: true });
          await mkdir(dirname(p.meta), { recursive: true });
          await Bun.write(p.data, data);
          await writeFile(p.meta, contentType);
        });
      writes.set(p.data, write);
      try {
        await write;
      } finally {
        if (writes.get(p.data) === write) writes.delete(p.data);
      }
    },
    async open(key) {
      const p = pathsOf(key);
      let size: number;
      try {
        size = (await stat(p.data)).size;
      } catch {
        return null;
      }
      return { size, contentType: await typeOf(p.meta), body: Bun.file(p.data) };
    },
    async get(key) {
      const p = pathsOf(key);
      try {
        await stat(p.data);
      } catch {
        return null;
      }
      const [bytes, contentType] = await Promise.all([readFile(p.data), typeOf(p.meta)]);
      return { bytes: new Uint8Array(bytes), contentType };
    },
    async delete(key) {
      const p = pathsOf(key);
      await rm(p.data, { force: true });
      await rm(p.meta, { force: true });
    },
    async keys() {
      const out: string[] = [];
      const glob = new Bun.Glob("**/*");
      try {
        for await (const file of glob.scan({ cwd: dataRoot, onlyFiles: true })) out.push(file);
      } catch {
        // nothing stored yet: the data folder does not exist
      }
      return out;
    },
  };
}
