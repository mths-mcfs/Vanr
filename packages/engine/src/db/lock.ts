// One open at a time per PGlite data directory. Two PGlite instances on one directory corrupt it
// silently, so the second open has to fail instead.
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Directories opened by this process, by real path. */
const openDirs = new Set<string>();

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

function errorCode(e: unknown): unknown {
  return e instanceof Error && "code" in e ? e.code : undefined;
}

/**
 * The real path of `path`, following symlinks, even when the last parts do not exist yet: the
 * deepest ancestor that exists is resolved and the rest is joined to it. A symlink whose target does
 * not exist yet (the data directory before its first open) is followed too.
 */
function realPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (let hops = 0; hops < 64; ) {
    try {
      return join(realpathSync(current), ...missing.toReversed());
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    let link: string | null = null;
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    if (link !== null) {
      current = resolve(dirname(current), link);
      hops++;
      continue;
    }
    const parent = dirname(current);
    if (parent === current) break;
    missing.push(basename(current));
    current = parent;
  }
  return resolve(path);
}

/** The lock file's content, or null when there is none. */
function readLock(lock: string): string | null {
  try {
    return readFileSync(lock, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
}

export interface LockHooks {
  /** Tests only: runs after a lock was judged stale and before it is taken over. */
  beforeTakeover?: () => void;
}

/**
 * Takes a data directory for this process: a registry inside the process, and a lock file created
 * exclusively with the pid across processes, both keyed by the directory's real path. The lock sits
 * next to the directory, `<dir>.lock`, because PGlite will not initialize a new database in a
 * directory that already holds a file. A lock whose process is gone is taken over, and only if the
 * file still holds what was judged stale when it is read again just before removal; the window left
 * is between that re-read and the removal, which only an OS-level lock (flock) would close.
 * Returns the release function.
 */
export function lockDataDir(dataDir: string, hooks: LockHooks = {}): () => void {
  const dir = realPath(dataDir);
  if (openDirs.has(dir)) throw new Error(`database directory ${dir} is already open in this process`);
  mkdirSync(dirname(dir), { recursive: true });
  const lock = `${dir}.lock`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
      const seen = readLock(lock);
      if (seen === null) continue;
      const holder = Number.parseInt(seen.trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && processAlive(holder)) {
        throw new Error(`database directory ${dir} is already open by process ${holder}`);
      }
      hooks.beforeTakeover?.();
      if (readLock(lock) !== seen) continue;
      rmSync(lock, { force: true });
      continue;
    }
    openDirs.add(dir);
    return () => {
      openDirs.delete(dir);
      if (readLock(lock) === String(process.pid)) rmSync(lock, { force: true });
    };
  }
  throw new Error(`could not lock database directory ${dir}`);
}
