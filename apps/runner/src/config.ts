// Runner config on the customer's host: `~/.vanr-runner/config.json`, folder 0700, file 0600,
// atomic write (temporary file + rename). The token authenticates the runner; the agents' secrets
// live in another file, encrypted (see secrets.ts).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunnerAccess } from "@vanr/contract";
import { PRODUCT } from "@vanr/product";
import { z } from "zod";

export const RUNNER_VERSION = "0.2.0";
const HOME_ENV = `${PRODUCT.slug.toUpperCase()}_RUNNER_HOME`;

export interface RunnerConfig {
  server: string;
  runnerId: string;
  name: string;
  token: string;
  workspaceId: string;
  workspaceName: string;
  /** Work folder: each agent gets a subfolder `<handle>-<last 8 of the id>`. */
  workDir: string;
  access: RunnerAccess;
  paused: boolean;
  maxConcurrentJobs: number;
  jobMaxSeconds: number;
  /** Agent processes inside the sandbox (default). Only the person turns it off, here (`sandbox off`). */
  sandbox: boolean;
  /** Updates itself when the server offers a new signed version (default). */
  autoUpdate: boolean;
}

export function runnerHome(env: Record<string, string | undefined> = process.env): string {
  return env[HOME_ENV] || join(homedir(), PRODUCT.runnerDir);
}

export const configPath = (home: string) => join(home, "config.json");

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Writes without leaving a half-written file: writes next to it and renames. */
export function writePrivate(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export const runnerAccess = z.object({
  folders: z.array(z.object({ path: z.string(), agents: z.array(z.string()) })),
  tools: z.object({ claude: z.boolean(), codex: z.boolean(), commands: z.boolean(), browser: z.boolean() }),
}) satisfies z.ZodType<RunnerAccess>;

/** The file as written by any runner version: every field may be missing and gets its default below. */
const configFile = z.object({
  server: z.string().optional(),
  runnerId: z.string().optional(),
  name: z.string().optional(),
  token: z.string().optional(),
  workspaceId: z.string().optional(),
  workspaceName: z.string().optional(),
  workDir: z.string().optional(),
  access: runnerAccess.optional(),
  paused: z.boolean().optional(),
  maxConcurrentJobs: z.number().int().min(1).optional(),
  jobMaxSeconds: z.number().min(1).optional(),
  sandbox: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
});

export function readConfig(home: string): RunnerConfig | null {
  const path = configPath(home);
  if (!existsSync(path)) return null;
  const parsed = configFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new Error(`${path} is not a valid runner config: ${parsed.error.issues[0]?.message}`);
  const raw = parsed.data;
  if (!raw.server || !raw.token || !raw.runnerId) return null;
  return {
    server: raw.server,
    runnerId: raw.runnerId,
    name: raw.name ?? "",
    token: raw.token,
    workspaceId: raw.workspaceId ?? "",
    workspaceName: raw.workspaceName ?? "",
    workDir: raw.workDir ?? join(homedir(), PRODUCT.slug),
    access: raw.access ?? {
      folders: [],
      tools: { claude: false, codex: false, commands: false, browser: false },
    },
    paused: raw.paused ?? false,
    maxConcurrentJobs: raw.maxConcurrentJobs ?? 3,
    jobMaxSeconds: Math.min(raw.jobMaxSeconds ?? 4 * 3600, 24 * 3600),
    sandbox: raw.sandbox !== false,
    autoUpdate: raw.autoUpdate !== false,
  };
}

export function writeConfig(home: string, config: RunnerConfig): void {
  ensureDir(home);
  writePrivate(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

export function configMtime(home: string): number {
  try {
    return statSync(configPath(home)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Server address: http(s) only, no trailing slash, no query. */
export function normalizeServer(input: string): string {
  const u = new URL(input);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Server must be http(s)");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}
