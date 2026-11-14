import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskBlobs } from "./blobs";

describe("diskBlobs", () => {
  test("stores, reads and deletes inside the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blobs-"));
    try {
      const store = diskBlobs(join(dir, "blobs"));
      await store.put("files/workspace_1/a/1", new TextEncoder().encode("oi"), "text/plain");
      const got = await store.get("files/workspace_1/a/1");
      expect(new TextDecoder().decode(got?.bytes)).toBe("oi");
      expect(got?.contentType).toBe("text/plain");
      expect(await store.keys()).toEqual(["files/workspace_1/a/1"]);
      await store.delete("files/workspace_1/a/1");
      expect(await store.get("files/workspace_1/a/1")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a key that leaves the folder, including into a sibling with the same prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blobs-"));
    try {
      const store = diskBlobs(join(dir, "blobs"));
      const bytes = new Uint8Array([1]);
      await expect(store.put("../fora", bytes, "x/y")).rejects.toThrow("escapes");
      // "blobs-neighbor" starts with "blobs": the old check (startsWith without a separator) let it through.
      await expect(store.put("../blobs-vizinha/x", bytes, "x/y")).rejects.toThrow("escapes");
      await expect(store.get("../blobs-vizinha/x")).rejects.toThrow("escapes");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
