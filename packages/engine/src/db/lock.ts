// One open at a time per PGlite data directory. Two PGlite instances on one directory corrupt it
// silently, so the second open has to fail instead.
import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

/**
 * Exclusively creates `<real dataDir>.lock`, beside the directory so PGlite can initialize it.
 * An existing file always rejects the open, including an empty file whose owner may still be
 * publishing its PID. Locks left after a crash require manual removal after checking no owner remains.
 * Only the owner releases the file; release is idempotent even after another owner acquires it.
 */
export function lockDataDir(dataDir: string): () => void {
  const dir = realPath(dataDir);
  mkdirSync(dirname(dir), { recursive: true });
  const lock = `${dir}.lock`;
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (errorCode(e) !== "EEXIST") throw e;
    throw new Error(`database directory ${dir} is already open or has an unreleased lock at ${lock}`);
  }
  let released = false;
  return () => {
    if (released) return;
    rmSync(lock);
    released = true;
  };
}
