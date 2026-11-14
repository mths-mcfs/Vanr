// File and command ops the server asks for. Each one gets the agent (to find its folder and its
// secrets) and returns the protocol result; an error becomes a RunnerError with the code.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentRef,
  ExecResult,
  ListResult,
  NetworkPolicyFrame,
  ReadResult,
} from "@vanr/engine/runner-protocol";
import { type Access, protectedPath, RunnerError, WALK_MAX } from "./access";
import { cliEnv, noPlanEnv } from "./cli";
import {
  type CommandSandbox,
  fsPolicy,
  isolated,
  type PolicyContext,
  SESSION_ENV,
  type Wrapped,
} from "./sandbox";
import { maskSecrets, type SecretStore } from "./secrets";

const OUTPUT_MAX = 2_000_000;
const STREAM_EVERY_MS = 100;
const STREAM_MAX = 1_000_000;
const READ_MAX = 5_000_000;
const LIST_MAX = 5000;

export interface OpContext {
  access: Access;
  secrets: SecretStore;
  sandbox: CommandSandbox;
  policy: PolicyContext;
  agent: AgentRef | null;
  signal: AbortSignal;
  /** A chunk of streamed output (only when the server asked for it). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

/** Collects output up to the cap, keeping half from the start and half from the end. */
class Capture {
  private head = "";
  private tail = "";
  cut = false;
  push(s: string) {
    if (!this.cut && this.head.length + s.length <= OUTPUT_MAX) {
      this.head += s;
      return;
    }
    if (!this.cut) {
      const room = OUTPUT_MAX / 2 - this.head.length;
      if (room > 0) this.head += s.slice(0, room);
      this.head = this.head.slice(0, OUTPUT_MAX / 2);
      this.cut = true;
    }
    this.tail = (this.tail + s).slice(-OUTPUT_MAX / 2);
  }
  text() {
    return this.cut ? `${this.head}\n[… cut …]\n${this.tail}` : this.head;
  }
}

function blockedSecretFile(ctx: OpContext, path: string) {
  if (!ctx.agent) return;
  const files = ctx.secrets.secretFiles(ctx.agent, ctx.access.agentRoot(ctx.agent));
  if (files.includes(path)) throw new RunnerError("bad_request", "Secret files are not readable by agents");
}

/** Without a policy from the server, no network. */
const NO_NETWORK: NetworkPolicyFrame = { mode: "off", domains: [] };

/** Domains the process takes to the proxy: none with the network off. */
export const domainsFor = (network: NetworkPolicyFrame) => (network.mode === "off" ? [] : network.domains);

/**
 * Starts an agent process inside the sandbox (or outside, if the person turned it off in this environment).
 * Returns the shell line and the wrapper, which reports the blocked hosts and releases the network list at the end.
 */
export async function sandboxed(
  ctx: Pick<OpContext, "sandbox" | "policy">,
  input: {
    command: string;
    readable: string[];
    writable: string[];
    liberated?: string[];
    denyRead?: string[];
    denyWrite?: string[];
    runnerInner?: { read: string[]; write: string[] };
    domains: string[];
    network: NetworkPolicyFrame;
    signal?: AbortSignal;
  },
): Promise<Wrapped | null> {
  const status = ctx.sandbox.status();
  if (status.state === "off") return null;
  if (!isolated(status))
    throw new RunnerError("sandbox_unavailable", status.reason ?? "No sandbox in this environment");
  ctx.sandbox.setMode(input.network.mode);
  const { unchecked, ...fs } = fsPolicy(ctx.policy, input);
  const wrapped = await ctx.sandbox.wrap({
    command: input.command,
    fs,
    domains: input.domains,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return unchecked.length ? { ...wrapped, unchecked } : wrapped;
}

/** A note on stderr when a folder became read-only for having too many files to check. */
const uncheckedNote = (paths: readonly string[] = []) =>
  paths.length
    ? `[sandbox] ${paths.join(", ")} has more than ${WALK_MAX} entries, too many to check for git hooks and config; it is read-only for this command. Remove files you no longer need.\n`
    : "";

/**
 * Environment of an agent process: without the API keys or the Claude Code/Codex login of whoever
 * paired, without the sockets of the person's session (SSH key agent, D-Bus, X11) and with a TMPDIR in the
 * agent's folder (/tmp is read-only in the sandbox).
 */
export function agentEnv(
  root: string,
  add: { secrets?: Record<string, string>; internal?: Record<string, string> },
): Record<string, string> {
  const tmp = join(root, ".tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const env = cliEnv({ secrets: add.secrets, internal: { TMPDIR: tmp, ...add.internal } });
  for (const k of SESSION_ENV) delete env[k];
  return env;
}

export async function execOp(
  ctx: OpContext,
  args: { command: string; cwd?: string; timeoutSeconds?: number; network?: NetworkPolicyFrame },
): Promise<ExecResult> {
  ctx.access.requireTool("commands");
  const root = ctx.access.agentRoot(ctx.agent);
  const cwd = args.cwd ? ctx.access.resolve(ctx.agent, args.cwd) : root;
  if (!existsSync(cwd)) throw new RunnerError("not_found", `${args.cwd} does not exist`);
  if (!statSync(cwd).isDirectory()) throw new RunnerError("bad_request", `${args.cwd} is not a folder`);
  const network = args.network ?? NO_NETWORK;
  const folders = [root, ...ctx.access.foldersFor(ctx.agent)];
  const win = process.platform === "win32";
  const wrapped = win
    ? null
    : await sandboxed(ctx, {
        command: args.command,
        readable: folders,
        writable: folders,
        liberated: folders.slice(1),
        domains: domainsFor(network),
        network,
        signal: ctx.signal,
      });
  const secrets = ctx.agent
    ? await ctx.secrets.materialize(ctx.agent, root).catch((err) => {
        wrapped?.release();
        throw err;
      })
    : { env: {}, masks: [] as [string, string][], release: () => {} };
  const started = Date.now();
  const timeoutMs = (args.timeoutSeconds ?? 60) * 1000;
  try {
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(
        win ? "cmd" : "/bin/sh",
        win ? ["/d", "/s", "/c", args.command] : ["-c", wrapped?.command ?? args.command],
        {
          cwd,
          env: agentEnv(root, { secrets: secrets.env, internal: noPlanEnv(root) }),
          detached: !win,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const out = new Capture();
      const err = new Capture();
      let streamed = 0;
      let pending: { stream: "stdout" | "stderr"; chunk: string }[] = [];
      let timedOut = false;
      let canceled = false;
      const flush = () => {
        if (!ctx.onOutput || pending.length === 0) return;
        for (const p of pending) {
          if (streamed >= STREAM_MAX) break;
          const chunk = maskSecrets(p.chunk, secrets.masks).slice(0, STREAM_MAX - streamed);
          streamed += chunk.length;
          ctx.onOutput(p.stream, chunk);
        }
        pending = [];
      };
      const flusher = setInterval(flush, STREAM_EVERY_MS);
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && !win) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // already exited
        }
      };
      const stop = () => {
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 3000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = () => {
        canceled = true;
        stop();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (s: string) => {
        out.push(s);
        if (ctx.onOutput) pending.push({ stream: "stdout", chunk: s });
      });
      child.stderr.on("data", (s: string) => {
        err.push(s);
        if (ctx.onOutput) pending.push({ stream: "stderr", chunk: s });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(flusher);
        ctx.signal.removeEventListener("abort", onAbort);
        flush();
        resolve({
          exitCode: timedOut ? 124 : canceled ? 130 : code,
          stdout: maskSecrets(out.text(), secrets.masks),
          stderr: uncheckedNote(wrapped?.unchecked) + maskSecrets(err.text(), secrets.masks),
          truncated: out.cut || err.cut,
          timedOut,
          durationMs: Date.now() - started,
          blocked: network.mode === "allowlist" ? (wrapped?.blocked() ?? []).slice(0, 50) : [],
        });
      });
      child.on("error", (e) => {
        err.push(String(e));
      });
    });
  } finally {
    secrets.release();
    wrapped?.release();
  }
}

const looksBinary = (buf: Buffer) => {
  if (buf.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
};

export function readOp(ctx: OpContext, args: { path: string; maxBytes?: number }): ReadResult {
  ctx.access.requireActive();
  const path = ctx.access.resolve(ctx.agent, args.path);
  blockedSecretFile(ctx, path);
  if (!existsSync(path)) throw new RunnerError("not_found", `${args.path} does not exist`);
  const st = statSync(path);
  if (!st.isFile()) throw new RunnerError("bad_request", `${args.path} is not a file`);
  const max = Math.min(args.maxBytes ?? READ_MAX, READ_MAX);
  const buf = readFileSync(path).subarray(0, max);
  const binary = looksBinary(buf);
  return {
    path: args.path,
    content: binary ? buf.toString("base64") : buf.toString("utf8"),
    encoding: binary ? "base64" : "utf8",
    size: st.size,
    truncated: st.size > max,
  };
}

export function writeOp(
  ctx: OpContext,
  args: { path: string; content: string; encoding: "utf8" | "base64"; append: boolean },
): { path: string; bytes: number } {
  ctx.access.requireActive();
  const path = ctx.access.resolve(ctx.agent, args.path);
  blockedSecretFile(ctx, path);
  if (path === ctx.access.agentRoot(ctx.agent))
    throw new RunnerError("bad_request", "Cannot write the folder itself");
  // The same rule as the sandbox: git hook, shell rc, config of a tool that runs outside it.
  const escalation = protectedPath(path);
  if (escalation)
    throw new RunnerError("not_allowed", `${args.path} is protected (${escalation}); agents cannot write it`);
  if (existsSync(path) && statSync(path).isDirectory())
    throw new RunnerError("bad_request", `${args.path} is a folder`);
  const data =
    args.encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
  if (data.byteLength > READ_MAX) throw new RunnerError("too_large", "File is larger than 5 MB");
  mkdirSync(dirname(path), { recursive: true });
  if (args.append) appendFileSync(path, data);
  else writeFileSync(path, data);
  return { path: args.path, bytes: data.byteLength };
}

export function listOp(ctx: OpContext, args: { path: string }): ListResult {
  ctx.access.requireActive();
  const path = ctx.access.resolve(ctx.agent, args.path);
  if (!existsSync(path)) throw new RunnerError("not_found", `${args.path} does not exist`);
  if (!statSync(path).isDirectory()) throw new RunnerError("bad_request", `${args.path} is not a folder`);
  const hidden = new Set(
    ctx.agent ? ctx.secrets.secretFiles(ctx.agent, ctx.access.agentRoot(ctx.agent)) : [],
  );
  const names = readdirSync(path).sort();
  const entries: ListResult["entries"] = [];
  for (const name of names) {
    if (entries.length >= LIST_MAX) break;
    const full = join(path, name);
    if (hidden.has(full)) continue;
    const st = lstatSync(full);
    entries.push({
      name,
      kind: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other",
      size: st.isFile() ? st.size : 0,
    });
  }
  return { path: args.path, entries, truncated: names.length > entries.length + hidden.size };
}
