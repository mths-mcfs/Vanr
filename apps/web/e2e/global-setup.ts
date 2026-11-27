// Builds the web once per run, into a folder of its own that the servers of every worker serve
// (WEB_DIST). VANR_E2E_WEB_DIST names a build that already exists and skips this one.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB_ROOT = join(import.meta.dirname, "..");

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.VANR_E2E_WEB_DIST !== undefined) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "vanr-e2e-web-"));
  const build = spawnSync("bun", ["x", "vite", "build", "--outDir", dir, "--logLevel", "warn"], {
    cwd: WEB_ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`the web build failed (exit ${build.status ?? build.signal})`);
  }
  // Workers start after this and inherit the environment.
  process.env.VANR_E2E_WEB_DIST = dir;
  return async () => {
    await rm(dir, { recursive: true, force: true });
  };
}
