import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, schema } from "./index";

/** Starting PGlite on disk takes several seconds. */
const SLOW = 60_000;
const dirs: string[] = [];
/** A fresh data directory under the system temp dir (set TMPDIR to move it). */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vanr-open-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.lock`, { force: true });
  }
});

const lockOf = (dir: string) => `${dir}.lock`;
const user = { id: "u1", name: "Ada", email: "ada@example.com" };

test(
  "a data directory opens once: a second open rejects and the first one's data survives",
  async () => {
    const dir = dataDir();
    const [first, second] = await Promise.allSettled([
      openDb({ kind: "pglite", dataDir: dir }),
      openDb({ kind: "pglite", dataDir: dir }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(String(second.reason)).toContain("already open");
    if (first.status !== "fulfilled") throw new Error("first open failed");
    await first.value.db.insert(schema.users).values(user);
    await first.value.close();
    expect(existsSync(lockOf(dir))).toBe(false);

    const again = await openDb({ kind: "pglite", dataDir: dir });
    try {
      expect((await again.db.select().from(schema.users)).map((u) => u.id)).toEqual(["u1"]);
    } finally {
      await again.close();
    }
  },
  SLOW,
);

test(
  "a lock left by a process that no longer exists rejects the open and stays untouched",
  async () => {
    const dir = dataDir();
    // Above any real pid limit (4194304 on Linux), so no live process has it.
    writeFileSync(lockOf(dir), "999999999");
    await expect(openDb({ kind: "pglite", dataDir: dir })).rejects.toThrow("unreleased lock");
    expect(readFileSync(lockOf(dir), "utf8")).toBe("999999999");
  },
  SLOW,
);

test(
  "a lock held by a live process rejects the open and stays untouched",
  async () => {
    const dir = dataDir();
    writeFileSync(lockOf(dir), String(process.ppid));
    await expect(openDb({ kind: "pglite", dataDir: dir })).rejects.toThrow("already open");
    expect(readFileSync(lockOf(dir), "utf8")).toBe(String(process.ppid));
  },
  SLOW,
);

test(
  "an open that fails after taking the lock releases it",
  async () => {
    const dir = dataDir();
    // A data directory that is not a Postgres one: PGlite cannot start on it.
    writeFileSync(join(dir, "PG_VERSION"), "not a version\n");
    await expect(openDb({ kind: "pglite", dataDir: dir })).rejects.toThrow();
    expect(existsSync(lockOf(dir))).toBe(false);
  },
  SLOW,
);

test(
  "close can be called twice",
  async () => {
    const memory = await openDb({ kind: "pglite", dataDir: null });
    await memory.close();
    await memory.close();
    const onDisk = await openDb({ kind: "pglite", dataDir: dataDir() });
    await onDisk.close();
    await onDisk.close();
  },
  SLOW,
);
