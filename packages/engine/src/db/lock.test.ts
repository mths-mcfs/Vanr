import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockDataDir } from "./lock";

const made: string[] = [];
/** A fresh directory under the system temp dir (set TMPDIR to move it). */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "vanr-lock-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a symlink to an open directory is the same directory", () => {
  const root = scratch();
  const real = join(root, "db");
  const link = join(root, "link");
  const release = lockDataDir(real);
  try {
    symlinkSync(real, link);
    expect(() => lockDataDir(link)).toThrow("already open in this process");
    // Through a link to the parent, before the directory exists on disk.
    symlinkSync(root, join(root, "parent"));
    expect(() => lockDataDir(join(root, "parent", "db"))).toThrow("already open in this process");
  } finally {
    release();
  }
});

test("taking over a stale lock does not remove one a live process took in between", () => {
  const root = scratch();
  const dir = join(root, "db");
  const lock = `${dir}.lock`;
  writeFileSync(lock, "999999999");
  // Another process takes the lock right after this one judged it stale.
  const takeover = () => writeFileSync(lock, String(process.ppid));
  expect(() => lockDataDir(dir, { beforeTakeover: takeover })).toThrow(`process ${process.ppid}`);
  expect(readFileSync(lock, "utf8")).toBe(String(process.ppid));
});
