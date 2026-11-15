// Claude Code and Codex on the plan of whoever paired the runner. The login stays in the CLI itself (the
// runner and the server never see a token). The danger is the CLI swapping the plan for an API key without
// anyone noticing: `ANTHROPIC_API_KEY` in the environment wins over the subscription in `claude -p`, and an
// agent secret with that name would land in the process environment. So the runner starts the CLIs with a
// clean environment, rejects secrets with those names and checks the login before each use (`claude auth
// status`, `codex login status`). If the CLI is not on the plan, the turn does not run.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunnerCli } from "@vanr/contract";
import {
  blockedEnv as blockedEnvName,
  type CliStates,
  reservedSecretName as reservedName,
} from "@vanr/engine/runner-protocol";
import { PRODUCT } from "@vanr/product";
import { RunnerError } from "./access";

const RUNNER_PREFIX = `${PRODUCT.slug.toUpperCase()}_`;

export const blockedEnv = blockedEnvName;

/** Names an agent secret may not have (plus the runner's own variables). */
export const reservedSecretName = (name: string) => reservedName(name) || name.startsWith(RUNNER_PREFIX);

/**
 * Environment of a process the runner starts: the runner's own minus the blocked variables, the agent's
 * secrets (no reserved name) and the runner's own variables (`internal`, e.g. the MCP bridge).
 */
export function cliEnv(
  add: { secrets?: Record<string, string>; internal?: Record<string, string> } = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !blockedEnv(k)) out[k] = v;
  for (const [k, v] of Object.entries(add.secrets ?? {})) if (!reservedSecretName(k)) out[k] = v;
  Object.assign(out, add.internal ?? {});
  return out;
}

/**
 * An agent command (`execute_code`, a shell job): the `claude` and `codex` called from inside it find an
 * empty config folder, not the login of whoever paired. It does not stop someone who wants around it (the
 * command runs as the runner's user and can read the person's folder); it avoids using the plan by accident.
 */
export function noPlanEnv(root: string): Record<string, string> {
  const claude = join(root, ".cli", "claude");
  const codex = join(root, ".cli", "codex");
  for (const dir of [claude, codex]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
}

export type Executor = "claude_code" | "codex";
export interface CliBins {
  claude: string;
  codex: string;
}

type Run = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout: string; stderr?: string; error?: Error };

const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000, env: cliEnv() });
  return {
    status: r.status,
    stdout: `${r.stdout ?? ""}`,
    stderr: `${r.stderr ?? ""}`,
    ...(r.error ? { error: r.error } : {}),
  };
};

const word = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : null);

function versionOf(run: Run, cmd: string): string | null {
  const r = run(cmd, ["--version"]);
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) || null;
}

/**
 * `claude auth status --json`: `authMethod` `claude.ai` is the subscription login and `oauth_token` is the
 * token from `claude setup-token` (also the plan). `api_key`, `api_key_helper` and `third_party`
 * bill outside the plan.
 */
function claudeState(run: Run, bin: string): RunnerCli | null {
  const version = versionOf(run, bin);
  if (!version) return null;
  const r = run(bin, ["auth", "status", "--json"]);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(r.stdout.trim() || "null") as Record<string, unknown> | null;
  } catch {
    json = null;
  }
  if (!json || typeof json !== "object")
    return { version, login: r.status === 0 ? "unknown" : "none", plan: null };
  const method = word(json.authMethod);
  const login =
    json.loggedIn !== true || method === "none"
      ? "none"
      : method === "claude.ai" || method === "oauth_token"
        ? "subscription"
        : "api_key";
  return { version, login, plan: login === "subscription" ? word(json.subscriptionType) : null };
}

/**
 * `codex login status` writes "Logged in using ChatGPT" (subscription) or "... an API key" to stderr.
 */
function codexState(run: Run, bin: string): RunnerCli | null {
  const version = versionOf(run, bin);
  if (!version) return null;
  const r = run(bin, ["login", "status"]);
  const text = `${r.stdout}\n${r.stderr ?? ""}`.trim();
  const login = /chatgpt/i.test(text)
    ? "subscription"
    : /api key/i.test(text)
      ? "api_key"
      : r.status === 0
        ? "unknown"
        : "none";
  return { version, login, plan: login === "subscription" ? "chatgpt" : null };
}

const TTL_MS = 10 * 60_000;

/** State of the CLIs, kept for 10 minutes (`hello` and `cli.changed` carry it to the server). */
export class CliWatch {
  private cache: { at: number; value: CliStates } | null = null;

  constructor(
    private readonly opts: { bins: CliBins; installed: Executor[]; run?: Run; now?: () => number },
  ) {}

  private detect(): CliStates {
    const run = this.opts.run ?? defaultRun;
    const out: CliStates = {};
    if (this.opts.installed.includes("claude_code")) {
      const s = claudeState(run, this.opts.bins.claude);
      if (s) out.claude_code = s;
    }
    if (this.opts.installed.includes("codex")) {
      const s = codexState(run, this.opts.bins.codex);
      if (s) out.codex = s;
    }
    return out;
  }

  states(fresh = false): CliStates {
    const now = (this.opts.now ?? Date.now)();
    if (fresh || !this.cache || now - this.cache.at > TTL_MS) this.cache = { at: now, value: this.detect() };
    return this.cache.value;
  }

  /** Before using the CLI: it must be on the plan. Checks again if the cache says it is not. */
  requireSubscription(executor: Executor): RunnerCli {
    let state = this.states()[executor];
    if (state?.login !== "subscription") state = this.states(true)[executor];
    const name = executor === "codex" ? "Codex" : "Claude Code";
    if (!state) throw new RunnerError("not_logged_in", `${name} is not installed in this environment`);
    if (state.login === "api_key")
      throw new RunnerError(
        "not_logged_in",
        `${name} in this environment uses an API key, not a plan; log in with your subscription`,
      );
    if (state.login !== "subscription")
      throw new RunnerError("not_logged_in", `${name} in this environment is not logged in to a plan`);
    return state;
  }
}
