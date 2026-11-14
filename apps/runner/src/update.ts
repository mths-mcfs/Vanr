// Runner update (F5-3.3-P0-01). Asks the server for the latest version, checks the manifest signature
// with the public key pinned here (the private one lives only on the server, in RUNNER_SIGNING_KEY),
// rejects an equal or older version, downloads the bundle, checks size and sha256, runs the new bundle with
// `version` before swapping, and only then swaps the file (the old one stays in `.prev`). The caller restarts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  compareVersions,
  type UpdateManifest,
  updateManifest,
  verifyManifest,
} from "@vanr/engine/runner-update";
import { RUNNER_VERSION } from "./config";

/** The updater's public key. The matching seed only exists on the server (RUNNER_SIGNING_KEY). */
const RUNNER_UPDATE_PUBLIC_KEY = "UxlTUh+tn+rWXx/RoZ4Z4cL6xSzPDTyHxazD/EXmd4c=";

export type UpdateErrorCode =
  | "off"
  | "unreachable"
  | "bad_manifest"
  | "unsigned"
  | "bad_signature"
  | "downgrade"
  | "bad_bundle"
  | "broken_bundle"
  | "not_installed";

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface UpdateOptions {
  server: string;
  /** File of the running bundle (`<runner home>/<name>.mjs`). */
  bundlePath: string | null;
  current?: string;
  publicKey?: string;
  fetch?: typeof fetch;
  /** Runtime that runs the bundle (Node or Bun); used to check the new bundle before swapping. */
  runtime?: string;
}

/** The bundle this process runs, if it runs from one (in development it runs from the source). */
export function runningBundle(argv: string[] = process.argv): string | null {
  const script = argv[1];
  return script?.endsWith(".mjs") ? script : null;
}

/** Checked manifest of a newer version, or `null` if it is already on the latest. */
export async function checkUpdate(opts: UpdateOptions): Promise<UpdateManifest | null> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.server}/api/v1/runners/runner/latest`, {
      headers: { accept: "application/json" },
    });
  } catch (err) {
    throw new UpdateError("unreachable", `Could not reach the server: ${String(err)}`);
  }
  if (res.status === 404) throw new UpdateError("off", "The server does not offer runner updates");
  if (!res.ok) throw new UpdateError("unreachable", `The server answered ${res.status}`);
  const parsed = updateManifest.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new UpdateError("bad_manifest", "The update manifest is not valid");
  const m = parsed.data;
  if (!m.signature) throw new UpdateError("unsigned", "The update is not signed; rejecting it");
  if (!verifyManifest(m, opts.publicKey ?? RUNNER_UPDATE_PUBLIC_KEY))
    throw new UpdateError(
      "bad_signature",
      "The update signature does not match this runner's key; rejecting it",
    );
  const order = compareVersions(m.version, opts.current ?? RUNNER_VERSION);
  if (order === 0) return null;
  if (order < 0)
    throw new UpdateError(
      "downgrade",
      `The server offers ${m.version}, older than ${opts.current ?? RUNNER_VERSION}`,
    );
  return m;
}

/** Downloads, checks and swaps the bundle. Returns the installed version. */
async function installUpdate(m: UpdateManifest, opts: UpdateOptions): Promise<string> {
  if (!opts.bundlePath || !existsSync(opts.bundlePath))
    throw new UpdateError("not_installed", "This runner runs from source; update it with git");
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${opts.server}${m.url}`).catch((err) => {
    throw new UpdateError("unreachable", `Could not download the update: ${String(err)}`);
  });
  if (!res.ok) throw new UpdateError("unreachable", `The server answered ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== m.size || sha256 !== m.sha256)
    throw new UpdateError("bad_bundle", "The downloaded bundle does not match the signed manifest");
  const next = `${opts.bundlePath}.new`;
  writeFileSync(next, bytes, { mode: 0o644 });
  chmodSync(next, 0o644);
  // The new bundle has to start and report the signed version before it takes the place of the current one.
  const check = spawnSync(opts.runtime ?? process.execPath, [next, "version"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (check.status !== 0 || check.stdout.trim() !== m.version) {
    rmSync(next, { force: true });
    throw new UpdateError(
      "broken_bundle",
      `The new bundle did not start (${check.stderr?.trim().slice(0, 300) ?? ""})`,
    );
  }
  copyFileSync(opts.bundlePath, `${opts.bundlePath}.prev`);
  renameSync(next, opts.bundlePath);
  return m.version;
}

/** Goes back to the bundle from before the last update. */
export function rollbackUpdate(bundlePath: string | null): boolean {
  if (!bundlePath || !existsSync(`${bundlePath}.prev`)) return false;
  renameSync(`${bundlePath}.prev`, bundlePath);
  return true;
}

/** Checks and installs; `null` when it is already on the latest version. */
export async function update(opts: UpdateOptions): Promise<string | null> {
  const m = await checkUpdate(opts);
  if (!m) return null;
  return installUpdate(m, opts);
}
