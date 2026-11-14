import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskBlobs } from "./blobs";

const text = (s: string) => new TextEncoder().encode(s);

describe("diskBlobs metadata", () => {
  test("a key that looks like another key's metadata is just another blob", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blobs-"));
    try {
      const store = diskBlobs(join(dir, "blobs"));
      await store.put("a", text("first"), "text/plain");
      await store.put("a.type", text("second"), "image/png");
      expect((await store.get("a"))?.contentType).toBe("text/plain");
      expect((await store.get("a.type"))?.contentType).toBe("image/png");
      expect((await store.keys()).sort()).toEqual(["a", "a.type"]);
      await store.delete("a");
      expect(await store.get("a")).toBeNull();
      const second = await store.get("a.type");
      expect(new TextDecoder().decode(second?.bytes)).toBe("second");
      expect((await store.open("a.type"))?.contentType).toBe("image/png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a key cannot reach the metadata of another key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blobs-"));
    try {
      const store = diskBlobs(join(dir, "blobs"));
      await store.put("x/a", text("first"), "text/plain");
      for (const key of ["../meta/x/a", "../x/a"])
        await expect(store.put(key, text("evil"), "text/html")).rejects.toThrow("escapes");
      expect((await store.get("x/a"))?.contentType).toBe("text/plain");
      expect(await store.keys()).toEqual(["x/a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
