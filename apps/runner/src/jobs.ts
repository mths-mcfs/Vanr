// Long jobs in the environment: the executor of an assignment (Claude Code, Codex) or a shell command.
// State in `jobs/journal.json`; the output goes to `jobs/<id>/output.log`. The `job.done` is kept
// until the server confirms it (`job.ack`), even if the connection drops in between. A job that was running
// when the runner stopped comes back as `interrupted`. Claude Code and Codex run on the plan of whoever paired:
// an environment without an API key, the login checked first, and Claude Code stops if `init` reports another source.
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import {
  type AgentRef,
  JOB_STATUSES,
  type JobSnapshot,
  type JobUsage,
  type NetworkPolicyFrame,
} from "@vanr/engine/runner-protocol";
import { z } from "zod";
import { type Access, inside, RunnerError } from "./access";
import { type CliWatch, noPlanEnv } from "./cli";
import { ensureDir, writePrivate } from "./config";
import { record } from "./json";
import { agentEnv, domainsFor, sandboxed } from "./ops";
import { CLI_DOMAINS, type CommandSandbox, cliPaths, type PolicyContext, shellLine } from "./sandbox";
import { maskSecrets, type SecretStore } from "./secrets";

const LINE_EVERY_MS = 2000;
const PROGRESS_EVERY_MS = 30_000;
const LINE_MAX = 4000;
const RESULT_MAX = 8000;
/** Cap of the diff that goes to the server (it becomes proof in the assignment): start and end, the middle cut. */
export const DIFF_MAX = 100_000;
const GIT_TIMEOUT_MS = 10_000;

export type JobEvent =
  | {
      type: "job.event";
      jobId: string;
      kind: "line" | "progress" | "files";
      line?: string;
      files?: string[];
      at: string;
    }
  | { type: "job.done"; job: JobSnapshot };

interface JournalEntry extends JobSnapshot {
  agent: AgentRef;
  executor: "claude_code" | "codex" | "shell";
  delivered: boolean;
}

/** `jobs/journal.json`, as this runner writes it; `denied` and `blocked` are missing in older files. */
const journalFile = z.array(
  z.object({
    jobId: z.string(),
    status: z.enum(JOB_STATUSES),
    exitCode: z.number().int().nullable(),
    result: z.string().nullable(),
    files: z.array(z.string()),
    session: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    denied: z.array(z.string()).default([]),
    usage: z
      .object({
        model: z.string().nullable(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        cachedTokens: z.number(),
        cacheWriteTokens: z.number(),
        costUsd: z.number().nullable(),
      })
      .nullable()
      .optional(),
    diff: z.string().nullable().optional(),
    blocked: z.array(z.string()).default([]),
    agent: z.object({ id: z.string(), handle: z.string() }),
    executor: z.enum(["claude_code", "codex", "shell"]),
    delivered: z.boolean(),
  }),
) satisfies z.ZodType<JournalEntry[]>;

/** Finds an executable in PATH (the executor only shows up in `hello` if it is installed). */
export function which(bin: string, env: Record<string, string | undefined> = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function executorCommand(
  executor: "claude_code" | "codex" | "shell",
  input: { prompt: string; cwd: string; model?: string; session?: string; allow?: string[] },
  bins: { claude: string; codex: string },
): { cmd: string; args: string[]; stdin: string | null } {
  if (executor === "shell") return { cmd: "/bin/sh", args: ["-c", input.prompt], stdin: null };
  if (executor === "claude_code") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
    // The assignment rule `npm test *` becomes `Bash(npm test:*)` for Claude Code.
    if (input.allow?.length)
      args.push("--allowedTools", input.allow.map((r) => `Bash(${r.replace(/ \*$/, ":*")})`).join(","));
    if (input.model) args.push("--model", input.model);
    if (input.session) args.push("--resume", input.session);
    return { cmd: bins.claude, args, stdin: input.prompt };
  }
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    input.cwd,
    "--sandbox",
    "workspace-write",
    // Only with the ChatGPT login: with an API key Codex will not run.
    "-c",
    'forced_login_method="chatgpt"',
  ];
  if (input.model) args.push("-m", input.model);
  if (input.session) args.push("resume", input.session);
  args.push("-");
  return { cmd: bins.codex, args, stdin: input.prompt };
}

/** Reads a line of the executor's output: text to show, final result and session (to resume). */
export function parseExecutorLine(
  executor: "claude_code" | "codex" | "shell",
  raw: string,
): {
  text?: string;
  result?: string;
  session?: string;
  denied?: string[];
  apiKey?: string;
  model?: string;
  usage?: Omit<JobUsage, "model">;
} {
  if (executor === "shell") return { text: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw };
  }
  const obj = record(parsed);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  if (executor === "claude_code") {
    if (obj.type === "result") {
      // Commands the permission blocked: `permission_denials: [{ tool_name, tool_input: { command } }]`.
      const denials = Array.isArray(obj.permission_denials) ? obj.permission_denials : [];
      const denied = denials
        .map((d: unknown) => {
          const denial = record(d);
          const command = record(denial.tool_input).command;
          return command ? command : denial.tool_name;
        })
        .filter((c: unknown): c is string => typeof c === "string");
      // Usage at the end (`usage` and `total_cost_usd`): it runs on the plan of whoever paired, so it is only a measure.
      const u = obj.usage ? record(obj.usage) : undefined;
      const cost =
        typeof obj.total_cost_usd === "number" && obj.total_cost_usd >= 0 ? obj.total_cost_usd : null;
      const model = Object.keys(record(obj.modelUsage))[0];
      return {
        result: str(obj.result) ?? "",
        session: str(obj.session_id),
        ...(denied.length ? { denied } : {}),
        ...(model ? { model } : {}),
        ...(u
          ? {
              usage: {
                inputTokens: int(u.input_tokens),
                outputTokens: int(u.output_tokens),
                cachedTokens: int(u.cache_read_input_tokens),
                cacheWriteTokens: int(u.cache_creation_input_tokens),
                costUsd: cost,
              },
            }
          : {}),
      };
    }
    if (obj.type === "assistant") {
      const content = record(obj.message).content;
      const parts = (Array.isArray(content) ? content : [])
        .map((raw: unknown) => {
          const c = record(raw);
          return c.type === "text" ? str(c.text) : c.type === "tool_use" ? `→ ${c.name}` : undefined;
        })
        .filter(Boolean);
      return parts.length ? { text: parts.join(" ") } : {};
    }
    if (obj.type === "system" && obj.subtype === "init") {
      // An `apiKeySource` other than `none`: Claude Code would bill an API key, not the plan.
      const source = str(obj.apiKeySource);
      return {
        ...(str(obj.session_id) ? { session: str(obj.session_id) } : {}),
        ...(source && source !== "none" ? { apiKey: source } : {}),
        ...(str(obj.model) ? { model: str(obj.model) } : {}),
      };
    }
    if (obj.type === "system" && str(obj.session_id)) return { session: str(obj.session_id) };
    return {};
  }
  // codex exec --json: events with `item` (agent message, command) and the thread id.
  const item = record(obj.item);
  if (str(obj.thread_id)) return { session: str(obj.thread_id) };
  // End of each Codex turn: `turn.completed` with the usage (summed at the end of the job; Codex sends no cost).
  if (obj.type === "turn.completed" && obj.usage && typeof obj.usage === "object") {
    const u = record(obj.usage);
    return {
      usage: {
        inputTokens: int(u.input_tokens),
        outputTokens: int(u.output_tokens),
        cachedTokens: int(u.cached_input_tokens),
        cacheWriteTokens: 0,
        costUsd: null,
      },
    };
  }
  const text = str(item.text);
  if (item.type === "agent_message" && text) return { text, result: text };
  if (item.type === "command_execution" && item.command) return { text: `$ ${item.command}` };
  return {};
}

/** Cuts in the middle, keeping the start and the end. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n… (${text.length - 2 * half} chars cut) …\n${text.slice(-half)}`;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
    });
  } catch {
    return null;
  }
}

/**
 * The snapshot's git runs on the runner, outside the sandbox, so it cannot use anything the agent controls in
 * the folder: the repository belongs to the runner (`store`, in the job folder) and the agent's folder is only the tree.
 * No system or global config, no fsmonitor, hooks or submodules: the config, hooks and objects
 * of the folder's `.git` (or of a nested repository the job created) do not run and are not written.
 */
function snapGit(store: string, cwd: string, args: string[], env: Record<string, string> = {}) {
  return git(
    cwd,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-c",
      "diff.ignoreSubmodules=all",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    { GIT_DIR: store, GIT_WORK_TREE: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env },
  );
}

/**
 * Snapshot of the folder as a git tree: what is on disk now, including new files outside
 * .gitignore. It uses a temporary index in a runner repository (`store`), so it does not touch the index,
 * the objects or the files of whoever works there. Outside git: null.
 */
export function gitSnapshot(cwd: string, store: string, exclude: readonly string[] = []): string | null {
  const inside = git(cwd, ["-c", "core.fsmonitor=false", "rev-parse", "--is-inside-work-tree"], {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  if (inside?.trim() !== "true") return null;
  if (
    !existsSync(join(store, "HEAD")) &&
    git(cwd, ["init", "-q", "--bare", store], {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    }) === null
  )
    return null;
  // Secret files stay out of the snapshot (including those of another job of the same agent that is still running).
  const lines = exclude
    .map((path) => relative(cwd, path))
    .filter((rel) => rel && !rel.startsWith("..") && !isAbsolute(rel))
    .map((rel) => `/${rel.replace(/[\\*?[\]!# ]/g, (c) => `\\${c}`)}`);
  mkdirSync(join(store, "info"), { recursive: true });
  writeFileSync(join(store, "info", "exclude"), lines.length ? `${lines.join("\n")}\n` : "");
  const tmp = mkdtempSync(join(tmpdir(), "runner-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    if (snapGit(store, cwd, ["add", "-A"], env) === null) return null;
    return snapGit(store, cwd, ["write-tree"], env)?.trim() || null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * What the job changed: the files and the diff between the starting snapshot and the current one. What was already
 * in the folder before (even a new file nobody committed) does not count as the job's.
 */
export function gitChanges(
  cwd: string,
  store: string,
  base: string,
  exclude: readonly string[] = [],
): { files: string[]; diff: string | null } {
  const now = gitSnapshot(cwd, store, exclude);
  if (!now) return { files: [], diff: null };
  const files = (snapGit(store, cwd, ["diff", "--name-only", "--no-renames", base, now]) ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  const diff = snapGit(store, cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    base,
    now,
  ]);
  return { files: files.slice(0, 200), diff: diff?.trim() ? clipMiddle(diff, DIFF_MAX) : null };
}

export class Jobs {
  private journal: JournalEntry[] = [];
  private readonly running = new Map<string, { kill: () => void }>();

  constructor(
    private readonly opts: {
      home: string;
      access: Access;
      secrets: SecretStore;
      cli: CliWatch;
      maxConcurrent: () => number;
      maxSeconds: () => number;
      send: (event: JobEvent) => boolean;
      bins: { claude: string; codex: string };
      sandbox: CommandSandbox;
      policy: PolicyContext;
    },
  ) {
    this.load();
  }

  private get dir() {
    return join(this.opts.home, "jobs");
  }

  private load() {
    const path = join(this.dir, "journal.json");
    if (!existsSync(path)) return;
    const parsed = journalFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success)
      throw new Error(`${path} is not a valid job journal: ${parsed.error.issues[0]?.message}`);
    this.journal = parsed.data.map((t) => {
      return t.status === "running" || t.status === "queued"
        ? { ...t, status: "interrupted" as const, endedAt: new Date().toISOString(), delivered: false }
        : t;
    });
    this.save();
  }

  private save() {
    ensureDir(this.dir);
    // Keeps the open ones, the undelivered ones and the last 200.
    const keep = this.journal
      .filter((t) => !t.delivered || t.status === "running")
      .concat(this.journal.filter((t) => t.delivered && t.status !== "running").slice(-200));
    this.journal = [...new Map(keep.map((t) => [t.jobId, t])).values()];
    writePrivate(join(this.dir, "journal.json"), JSON.stringify(this.journal));
  }

  private snapshot(t: JournalEntry): JobSnapshot {
    const { agent: _a, executor: _e, delivered: _d, ...snap } = t;
    return snap;
  }

  /** For `hello`: the running ones and the ones that ended without the server confirming. */
  pending(): JobSnapshot[] {
    return this.journal.filter((t) => t.status === "running" || !t.delivered).map((t) => this.snapshot(t));
  }

  /** Sends again the `job.done` that were left unconfirmed (called after `welcome`). */
  redeliver() {
    for (const t of this.journal)
      if (!t.delivered && t.status !== "running" && t.status !== "queued")
        this.opts.send({ type: "job.done", job: this.snapshot(t) });
  }

  ack(jobId: string) {
    const t = this.journal.find((x) => x.jobId === jobId);
    if (t && t.status !== "running") {
      t.delivered = true;
      // The server already stored the diff: the journal does not carry 200 diffs.
      t.diff = null;
      this.save();
    }
  }

  status(jobId: string): JobSnapshot {
    const t = this.journal.find((x) => x.jobId === jobId);
    if (!t) throw new RunnerError("not_found", "No such job");
    return this.snapshot(t);
  }

  output(jobId: string, tail = 50): { lines: string[]; truncated: boolean } {
    const path = join(this.dir, jobId, "output.log");
    if (!this.journal.some((t) => t.jobId === jobId) || !existsSync(path))
      throw new RunnerError("not_found", "No such job");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const n = Math.min(Math.max(tail, 1), 200);
    return { lines: lines.slice(-n), truncated: lines.length > n };
  }

  cancel(jobId: string): { canceled: boolean } {
    const r = this.running.get(jobId);
    if (!r) return { canceled: false };
    r.kill();
    return { canceled: true };
  }

  async start(
    agent: AgentRef,
    args: {
      jobId: string;
      executor: "claude_code" | "codex" | "shell";
      title: string;
      prompt: string;
      cwd?: string;
      model?: string;
      session?: string;
      timeoutSeconds?: number;
      allow?: string[];
      network?: NetworkPolicyFrame;
    },
  ): Promise<{ jobId: string; startedAt: string; cwd: string }> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(args.jobId)) throw new RunnerError("bad_request", "Bad job id");
    if (this.journal.some((t) => t.jobId === args.jobId))
      throw new RunnerError("bad_request", "Job id already used");
    this.opts.access.requireTool(
      args.executor === "shell" ? "commands" : args.executor === "codex" ? "codex" : "claude",
    );
    if (this.running.size >= this.opts.maxConcurrent())
      throw new RunnerError("no_slot", "This environment is already running its maximum of jobs");
    if (args.executor !== "shell") this.opts.cli.requireSubscription(args.executor);
    const root = this.opts.access.agentRoot(agent);
    const cwd = args.cwd ? this.opts.access.resolve(agent, args.cwd) : root;
    const { cmd, args: argv, stdin } = executorCommand(args.executor, { ...args, cwd }, this.opts.bins);
    // Claude Code and Codex read the login of whoever paired and talk to their own service; the rest is the
    // same as a command: the agent's folders and the workspace's network.
    const network = args.network ?? { mode: "off" as const, domains: [] };
    const folders = [root, ...this.opts.access.foldersFor(agent)];
    const cli =
      args.executor === "shell"
        ? null
        : cliPaths(
            args.executor,
            this.opts.policy,
            args.executor === "codex" ? this.opts.bins.codex : this.opts.bins.claude,
            inside(cwd, root) ? cwd : null,
          );
    for (const d of cli?.ensure ?? []) mkdirSync(d, { recursive: true, mode: 0o700 });
    // The starting snapshot before the secret becomes a file in the folder: that way it does not enter the diff.
    const snapStore = join(this.dir, args.jobId, "snapshot.git");
    const secretPaths = this.opts.secrets.secretFiles(agent, root);
    const base = args.executor === "shell" ? null : gitSnapshot(cwd, snapStore, secretPaths);
    const dropSnapshot = () => rmSync(snapStore, { recursive: true, force: true });
    const wrapped = await sandboxed(this.opts, {
      command: shellLine(cmd, argv),
      readable: [...folders, ...(cli?.read ?? [])],
      writable: [...folders, ...(cli?.write ?? [])],
      liberated: folders.slice(1),
      denyRead: cli?.denyRead ?? [],
      denyWrite: cli?.denyWrite ?? [],
      domains: [...domainsFor(network), ...(args.executor === "shell" ? [] : CLI_DOMAINS[args.executor])],
      network,
    });
    const secrets = await this.opts.secrets.materialize(agent, root).catch((err) => {
      wrapped?.release();
      dropSnapshot();
      throw err;
    });
    const startedAt = new Date().toISOString();
    const entry: JournalEntry = {
      jobId: args.jobId,
      status: "running",
      exitCode: null,
      result: null,
      files: [],
      session: args.session ?? null,
      startedAt,
      endedAt: null,
      denied: [],
      blocked: [],
      agent,
      executor: args.executor,
      delivered: false,
    };
    this.journal.push(entry);
    this.save();
    const jobDir = join(this.dir, args.jobId);
    ensureDir(jobDir);
    const logPath = join(jobDir, "output.log");
    const child = spawn(wrapped ? "/bin/sh" : cmd, wrapped ? ["-c", wrapped.command] : argv, {
      cwd,
      // A shell job does not use the plan of whoever paired; Claude Code and Codex do (checked above).
      env: agentEnv(root, {
        secrets: secrets.env,
        ...(args.executor === "shell" ? { internal: noPlanEnv(root) } : {}),
      }),
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (stdin !== null && child.stdin) {
      child.stdin.end(stdin);
    }
    let lastSent = 0;
    let tailLine = "";
    let sentLine = "";
    let canceled = false;
    let timedOut = false;
    let rejected: string | null = null;
    let buffer = "";
    let model: string | null = null;
    let usage: Omit<JobUsage, "model"> | null = null;
    const at = () => new Date().toISOString();
    const onLine = (raw: string) => {
      const parsed = parseExecutorLine(args.executor, raw);
      if (parsed.apiKey && !rejected) {
        rejected = `Claude Code in this environment would use ${parsed.apiKey} instead of your plan; stopped.`;
        stop();
      }
      if (parsed.session) entry.session = parsed.session;
      if (parsed.model) model = parsed.model;
      if (parsed.usage) {
        const u = parsed.usage;
        // Claude Code sends the total at the end; Codex, one per turn (summed).
        usage =
          args.executor === "codex" && usage
            ? {
                inputTokens: usage.inputTokens + u.inputTokens,
                outputTokens: usage.outputTokens + u.outputTokens,
                cachedTokens: usage.cachedTokens + u.cachedTokens,
                cacheWriteTokens: usage.cacheWriteTokens + u.cacheWriteTokens,
                costUsd: null,
              }
            : u;
      }
      if (parsed.denied) entry.denied = [...new Set([...entry.denied, ...parsed.denied])].slice(0, 50);
      if (parsed.result !== undefined)
        entry.result = maskSecrets(parsed.result, secrets.masks).slice(0, RESULT_MAX);
      if (!parsed.text) return;
      const text = maskSecrets(parsed.text, secrets.masks).slice(0, LINE_MAX);
      appendFileSync(logPath, `${text.replace(/\n/g, " ")}\n`);
      tailLine = text;
      if (Date.now() - lastSent >= LINE_EVERY_MS && text !== sentLine) {
        lastSent = Date.now();
        sentLine = text;
        this.opts.send({ type: "job.event", jobId: args.jobId, kind: "line", line: text, at: at() });
      }
    };
    const onData = (s: string) => {
      buffer += s;
      let i = buffer.indexOf("\n");
      while (i >= 0) {
        const line = buffer.slice(0, i).trimEnd();
        buffer = buffer.slice(i + 1);
        if (line) onLine(line);
        i = buffer.indexOf("\n");
      }
    };
    child.stdout?.setEncoding("utf8").on("data", onData);
    child.stderr?.setEncoding("utf8").on("data", onData);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already exited
      }
    };
    const stop = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    };
    this.running.set(args.jobId, {
      kill: () => {
        canceled = true;
        stop();
      },
    });
    const maxMs = Math.min(args.timeoutSeconds ?? this.opts.maxSeconds(), this.opts.maxSeconds()) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, maxMs);
    const progress = setInterval(() => {
      if (Date.now() - lastSent >= PROGRESS_EVERY_MS) {
        lastSent = Date.now();
        this.opts.send({
          type: "job.event",
          jobId: args.jobId,
          kind: "progress",
          line: tailLine,
          at: at(),
        });
      }
    }, PROGRESS_EVERY_MS);
    child.on("error", (e) => onLine(`error: ${e.message}`));
    child.on("close", (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      clearTimeout(timer);
      clearInterval(progress);
      this.running.delete(args.jobId);
      secrets.release();
      if (network.mode === "allowlist") entry.blocked = (wrapped?.blocked() ?? []).slice(0, 50);
      wrapped?.release();
      entry.exitCode = code;
      entry.status = canceled ? "canceled" : rejected || timedOut || code !== 0 ? "failed" : "done";
      if (rejected) entry.result = rejected;
      entry.endedAt = at();
      if (entry.result === null && tailLine) entry.result = tailLine.slice(0, RESULT_MAX);
      if (usage) entry.usage = { model, ...usage };
      // Files and diff against the start of the job (the server stores them as proof for the assignment).
      if (base) {
        const changes = gitChanges(cwd, snapStore, base, secretPaths);
        entry.files = changes.files;
        entry.diff = changes.diff ? maskSecrets(changes.diff, secrets.masks) : null;
      }
      dropSnapshot();
      this.save();
      if (tailLine !== sentLine)
        this.opts.send({ type: "job.event", jobId: args.jobId, kind: "line", line: tailLine, at: at() });
      this.opts.send({ type: "job.done", job: this.snapshot(entry) });
    });
    return { jobId: args.jobId, startedAt, cwd };
  }

  stopAll() {
    for (const r of this.running.values()) r.kill();
  }

  runningCount(): number {
    return this.running.size;
  }
}
