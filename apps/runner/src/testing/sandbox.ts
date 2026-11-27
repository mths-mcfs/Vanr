// Real sandbox in the tests. `srt` on Linux needs bubblewrap and socat; socat is often not
// installed, so it comes from the Ubuntu .deb (`apt-get download`, no install and no root) and stays in
// ~/.cache/vanr/socat, like the pgvector of the test Postgres. Without bubblewrap or a way to find
// socat, `realSandbox()` returns the `unavailable` state and the test checks the rejection.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../jobs";
import { type CommandSandbox, defaultPolicyContext, openSandbox, type PolicyContext } from "../sandbox";

const CACHE = join(homedir(), ".cache/vanr/socat");

/** socat from PATH, from the cache, or downloaded from the .deb now; `null` if nothing works. */
export function testSocat(): string | null {
  const inPath = which("socat");
  if (inPath) return inPath;
  const cached = join(CACHE, "socat");
  if (existsSync(cached)) return cached;
  if (process.platform !== "linux" || !which("apt-get") || !which("dpkg-deb")) return null;
  const work = mkdtempSync(join(tmpdir(), "socat-deb-"));
  try {
    if (
      spawnSync("apt-get", ["download", "socat"], { cwd: work, stdio: "ignore", timeout: 60_000 }).status !==
      0
    )
      return null;
    const deb = readdirSync(work).find((f) => f.endsWith(".deb"));
    if (!deb) return null;
    const x = join(work, "x");
    if (spawnSync("dpkg-deb", ["-x", join(work, deb), x], { stdio: "ignore" }).status !== 0) return null;
    const bin = join(x, "usr/bin/socat");
    if (!existsSync(bin)) return null;
    mkdirSync(CACHE, { recursive: true });
    copyFileSync(bin, cached);
    return spawnSync(cached, ["-V"], { stdio: "ignore" }).status === 0 ? cached : null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** This process's real sandbox (on, or `unavailable` with the reason). */
export function realSandbox(): Promise<CommandSandbox> {
  return openSandbox({ disabled: false, socatPath: testSocat() });
}

/**
 * A policy whose person is made up and signed in to both CLIs with a login file, so a test with the
 * sandbox on never depends on (nor touches) the login of whoever runs the tests.
 */
export function signedInPolicy(runnerHome: string, personHome: string): PolicyContext {
  for (const [folder, file] of [
    [".claude", ".credentials.json"],
    [".codex", "auth.json"],
  ] as const) {
    mkdirSync(join(personHome, folder), { recursive: true });
    writeFileSync(join(personHome, folder, file), "TEST-LOGIN");
  }
  return { ...defaultPolicyContext(runnerHome), home: personHome, cliDirs: {} };
}
