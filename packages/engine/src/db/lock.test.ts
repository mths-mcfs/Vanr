import { afterEach, expect, test } from "bun:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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
    expect(() => lockDataDir(link)).toThrow("already open");
    // Through a link to the parent, before the directory exists on disk.
    symlinkSync(root, join(root, "parent"));
    expect(() => lockDataDir(join(root, "parent", "db"))).toThrow("already open");
  } finally {
    release();
  }
});

/** Real processes and workers use the same acquire/release barrier, without acquisition hooks. */
function ownerScript(root: string): string {
  const script = join(root, "owner.ts");
  writeFileSync(
    script,
    `
    import { parentPort, workerData } from "node:worker_threads";
    import { lockDataDir } from ${JSON.stringify(new URL("./lock.ts", import.meta.url).href)};
    let release;
    (parentPort ?? process).on("message", message => {
      if (message === "acquire") {
        let acquired = false;
        try { release = lockDataDir(workerData ?? process.argv[2]); acquired = true; } catch {}
        if (parentPort) parentPort.postMessage(acquired);
        else process.send(acquired);
      } else if (message === "release") {
        release?.();
        process.exit(0);
      }
    });
  `,
  );
  return script;
}

for (const content of [null, "", "999999999"]) {
  test(`processes cannot share a directory with lock content ${JSON.stringify(content)}`, async () => {
    const root = scratch();
    const dir = join(root, "db");
    if (content !== null) writeFileSync(`${dir}.lock`, content);
    const script = ownerScript(root);
    const children = Array.from({ length: 8 }, () =>
      fork(script, [dir], { execPath: process.execPath, stdio: ["ignore", "ignore", "inherit", "ipc"] }),
    );
    const exits = children.map((child) => once(child, "exit"));
    try {
      const replies = children.map((child) => once(child, "message"));
      for (const child of children) child.send("acquire");
      // Every winner keeps its lock until every contender has replied.
      const results = await Promise.all(replies);
      expect(results.filter(([acquired]) => acquired === true)).toHaveLength(content === null ? 1 : 0);
      if (content !== null) expect(readFileSync(`${dir}.lock`, "utf8")).toBe(content);
    } finally {
      for (const child of children) child.send("release");
      await Promise.all(exits);
    }
  });
}

test("a worker cannot acquire a directory while another worker in its process holds it", async () => {
  const root = scratch();
  const script = ownerScript(root);
  const first = new Worker(script, { workerData: join(root, "db") });
  const second = new Worker(script, { workerData: join(root, "db") });
  try {
    const acquired = once(first, "message");
    first.postMessage("acquire");
    expect((await acquired)[0]).toBe(true);
    const rejected = once(second, "message");
    second.postMessage("acquire");
    expect((await rejected)[0]).toBe(false);
  } finally {
    const exits = [once(first, "exit"), once(second, "exit")];
    first.postMessage("release");
    second.postMessage("release");
    await Promise.all(exits);
  }
});

test("releasing twice does not remove the next owner's lock", () => {
  const dir = join(scratch(), "db");
  const release = lockDataDir(dir);
  release();
  const nextRelease = lockDataDir(dir);
  try {
    release();
    expect(() => lockDataDir(dir)).toThrow("already open");
  } finally {
    nextRelease();
  }
});
