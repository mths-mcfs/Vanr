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
import { maybe } from "./lines";
import { agentEnv, domainsFor, sandboxed } from "./ops";
import { assemble, assembleSnapshot, type Masks } from "./outbound";
import {
  agentCli,
  CLI_DOMAINS,
  type CommandSandbox,
  isolated,
  type PolicyContext,
  shellLine,
} from "./sandbox";
import { MIN_MASK, maskBytes, maskSecrets, type SecretStore, StreamMasker } from "./secrets";

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

export function executorCommand(
  executor: "claude_code" | "codex" | "shell",
  input: { prompt: string; cwd: string; model?: string; session?: string; allow?: string[] },
  bins: { claude: string; codex: string },
): { cmd: string; args: string[]; stdin: string | null } {
  if (executor === "shell") return { cmd: "/bin/sh", args: ["-c", input.prompt], stdin: null };
  if (executor === "claude_code") {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      // Without the person's settings, hooks and instructions (`user`); the project's own still apply.
      "--setting-sources",
      "project,local",
    ];
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
    // Without the person's config.toml (their MCP servers, another model provider) nor their rules.
    "--ignore-user-config",
    "--ignore-rules",
    // Only with the ChatGPT login: with an API key Codex will not run.
    "-c",
    'forced_login_method="chatgpt"',
  ];
  if (input.model) args.push("-m", input.model);
  if (input.session) args.push("resume", input.session);
  args.push("-");
  return { cmd: bins.codex, args, stdin: input.prompt };
}

const tokenCounts = z
  .object({
    input_tokens: maybe.number,
    output_tokens: maybe.number,
    cached_input_tokens: maybe.number,
    cache_read_input_tokens: maybe.number,
    cache_creation_input_tokens: maybe.number,
  })
  .catch({
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });

/** A line of the Claude Code (`stream-json`) or Codex (`exec --json`) output, with the fields read below. */
const executorEvent = z.object({
  type: z.unknown().optional(),
  subtype: z.unknown().optional(),
  result: maybe.string,
  session_id: maybe.string,
  thread_id: maybe.string,
  apiKeySource: maybe.string,
  model: maybe.string,
  total_cost_usd: z.number().optional().catch(undefined),
  usage: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional().catch(undefined),
  permission_denials: z
    .array(
      z
        .object({
          tool_name: z.unknown().optional(),
          tool_input: z.object({ command: z.unknown().optional() }).catch({ command: undefined }),
        })
        .catch({ tool_name: undefined, tool_input: { command: undefined } }),
    )
    .catch([]),
  message: z
    .object({
      content: z
        .array(
          z
            .object({ type: z.unknown().optional(), text: maybe.string, name: z.unknown().optional() })
            .catch({ type: undefined, name: undefined }),
        )
        .catch([]),
    })
    .catch({ content: [] }),
  item: z
    .object({ type: z.unknown().optional(), text: maybe.string, command: z.unknown().optional() })
    .catch({ type: undefined, command: undefined }),
});

interface ExecutorLine {
  text?: string;
  result?: string;
  session?: string;
  denied?: string[];
  apiKey?: string;
  model?: string;
  usage?: Omit<JobUsage, "model">;
}

/** Reads a line of the executor's output: text to show, final result and session (to resume). */
export function parseExecutorLine(executor: "claude_code" | "codex" | "shell", raw: string): ExecutorLine {
  if (executor === "shell") return { text: raw };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { text: raw };
  }
  return parseExecutorEvent(executor, value);
}

/** An event of the Claude Code or Codex output, already decoded from its JSON line. */
export function parseExecutorEvent(executor: "claude_code" | "codex", value: unknown): ExecutorLine {
  const parsed = executorEvent.safeParse(value);
  // JSON that is not an object (a number, a list) carries nothing the runner reads.
  if (!parsed.success) return {};
  const obj = parsed.data;
  const int = (v: number) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  if (executor === "claude_code") {
    if (obj.type === "result") {
      // Commands the permission blocked: `permission_denials: [{ tool_name, tool_input: { command } }]`.
      const denied = obj.permission_denials
        .map((d) => (d.tool_input.command ? d.tool_input.command : d.tool_name))
        .filter((c: unknown): c is string => typeof c === "string");
      // Usage at the end (`usage` and `total_cost_usd`): it runs on the plan of whoever paired, so it is only a measure.
      const u = obj.usage ? tokenCounts.parse(obj.usage) : undefined;
      const cost = obj.total_cost_usd !== undefined && obj.total_cost_usd >= 0 ? obj.total_cost_usd : null;
      const model = Object.keys(obj.modelUsage ?? {})[0];
      return {
        result: obj.result ?? "",
        session: obj.session_id,
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
      const parts = obj.message.content
        .map((c) => (c.type === "text" ? c.text : c.type === "tool_use" ? `→ ${c.name}` : undefined))
        .filter(Boolean);
      return parts.length ? { text: parts.join(" ") } : {};
    }
    if (obj.type === "system" && obj.subtype === "init") {
      // An `apiKeySource` other than `none`: Claude Code would bill an API key, not the plan.
      const source = obj.apiKeySource;
      return {
        ...(obj.session_id ? { session: obj.session_id } : {}),
        ...(source && source !== "none" ? { apiKey: source } : {}),
        ...(obj.model ? { model: obj.model } : {}),
      };
    }
    if (obj.type === "system" && obj.session_id) return { session: obj.session_id };
    return {};
  }
  // codex exec --json: events with `item` (agent message, command) and the thread id.
  const { item } = obj;
  if (obj.thread_id) return { session: obj.thread_id };
  // End of each Codex turn: `turn.completed` with the usage (summed at the end of the job; Codex sends no cost).
  if (obj.type === "turn.completed" && obj.usage && typeof obj.usage === "object") {
    const u = tokenCounts.parse(obj.usage);
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
  if (item.type === "agent_message" && item.text) return { text: item.text, result: item.text };
  if (item.type === "command_execution" && item.command) return { text: `$ ${item.command}` };
  return {};
}

const isEvent = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The output of a job, split into lines, in two flows. Text (a shell job, and the lines of Claude Code or
 * Codex that are not a JSON object): masked as one stream before the split, so a secret of several lines (a
 * PEM key) is replaced whole even when it arrives in pieces, and a JSON line in the middle does not make the
 * stream let go of what it holds. JSON (in `json` mode, each line that is a JSON object): handed over raw,
 * with the decoded event, for the runner to decide from (an API key in place of the plan) and to build the
 * frames from; their free text is masked when the frame is assembled (outbound.ts).
 * `onLine(line, event)`: a JSON line and its raw event, or a masked text line alone.
 */
export class JobOutput {
  private buffer = "";
  private readonly text: StreamMasker;
  private textBuffer = "";

  constructor(
    masks: [string, string][] | (() => [string, string][]),
    private readonly onLine: (line: string, event?: Record<string, unknown>) => void,
    private readonly kind: "json" | "text" = "json",
  ) {
    this.text = new StreamMasker(masks);
  }

  push(chunk: string): void {
    if (this.kind === "text") {
      this.addText(chunk);
      return;
    }
    this.buffer += chunk;
    let i = this.buffer.indexOf("\n");
    while (i >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      this.rawLine(line, true);
      i = this.buffer.indexOf("\n");
    }
  }

  end(): void {
    if (this.kind === "json") {
      const rest = this.buffer;
      this.buffer = "";
      if (rest) this.rawLine(rest, false);
    }
    this.textBuffer += this.text.end();
    this.textLines();
    if (this.textBuffer.trim()) this.onLine(this.textBuffer.trim());
    this.textBuffer = "";
  }

  private rawLine(line: string, newline: boolean) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    // Only an object is an event: a line like `1234` is JSON too, and it stays in the text flow.
    if (isEvent(value)) this.onLine(line.trim(), value);
    else this.addText(newline ? `${line}\n` : line);
  }

  private addText(chunk: string) {
    this.textBuffer += this.text.push(chunk);
    this.textLines();
  }

  private textLines() {
    let i = this.textBuffer.indexOf("\n");
    while (i >= 0) {
      const line = this.textBuffer.slice(0, i).trimEnd();
      this.textBuffer = this.textBuffer.slice(i + 1);
      if (line) this.onLine(line);
      i = this.textBuffer.indexOf("\n");
    }
  }
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
      "-c",
      "core.quotePath=false",
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
  masks: [string, string][] = [],
): { files: string[]; diff: string | null } {
  const now = gitSnapshot(cwd, store, exclude);
  if (!now) return { files: [], diff: null };
  // NUL-separated names, as they are: an accent, a space at either end or a line break in a name stays.
  const files = (snapGit(store, cwd, ["diff", "--name-only", "-z", "--no-renames", base, now]) ?? "")
    .split("\0")
    .filter(Boolean);
  // With secrets, both sides are masked before the diff: the diff sent is the diff of the masked files.
  const changed = new Set(files);
  const content = diffMasks(masks);
  const from = masks.length ? maskedTree(store, cwd, base, changed, content) : base;
  const to = masks.length ? maskedTree(store, cwd, now, changed, content) : now;
  // A file name can carry a secret's value too.
  const names = files.slice(0, 200).map((f) => maskSecrets(f, masks));
  if (!from || !to) return { files: names, diff: null };
  const diff = snapGit(store, cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    from,
    to,
  ]);
  // The files of this diff, in its order: the header lines are written from them, not taken from git.
  const blocks = (snapGit(store, cwd, ["diff", "--name-only", "-z", "--no-renames", from, to]) ?? "")
    .split("\0")
    .filter(Boolean);
  const written = diff?.trim() ? writeDiffHeaders(diff, blocks, masks) : null;
  // Written before it is cut, so a secret across the cut is replaced whole.
  return { files: names, diff: written ? clipMiddle(written, DIFF_MAX) : null };
}

/** Git on the runner's snapshot repository with bytes in and out (blobs, the batch reader, the index). */
function storeGit(
  store: string,
  cwd: string,
  args: string[],
  input?: Uint8Array,
  env: Record<string, string> = {},
) {
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      input,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_DIR: store,
        GIT_WORK_TREE: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...env,
      },
    });
  } catch {
    return null;
  }
}

/**
 * The same tree with the given files masked: each blob is masked as a whole (`maskBytes`), so a secret of
 * several lines is replaced in the content before any diff splits it into `+`/`-` lines. `null` if git fails.
 */
function maskedTree(
  store: string,
  cwd: string,
  tree: string,
  paths: ReadonlySet<string>,
  masks: [string, string][],
): string | null {
  const listing = storeGit(store, cwd, ["ls-tree", "-r", "-z", tree]);
  if (!listing) return null;
  const blobs = listing
    .toString("utf8")
    .split("\0")
    .map((entry) => /^(\d+) blob ([0-9a-f]+)\t(.*)$/s.exec(entry))
    .filter((m): m is RegExpExecArray => !!m && paths.has(m[3] as string));
  if (!blobs.length) return tree;
  const batch = storeGit(
    store,
    cwd,
    ["cat-file", "--batch"],
    Buffer.from(`${blobs.map((m) => m[2]).join("\n")}\n`),
  );
  if (!batch) return null;
  const changed: string[] = [];
  let at = 0;
  for (const [, mode, , path] of blobs) {
    const eol = batch.indexOf(0x0a, at);
    const size = Number(batch.subarray(at, eol).toString("latin1").split(" ")[2]);
    const content = batch.subarray(eol + 1, eol + 1 + size);
    at = eol + 1 + size + 1;
    const masked = maskBytes(content, masks);
    if (masked.equals(content)) continue;
    const sha = storeGit(store, cwd, ["hash-object", "-w", "--stdin"], masked)?.toString("utf8").trim();
    if (!sha) return null;
    changed.push(`${mode} ${sha}\t${path}`);
  }
  if (!changed.length) return tree;
  const tmp = mkdtempSync(join(tmpdir(), "runner-mask-index-"));
  try {
    const index = { GIT_INDEX_FILE: join(tmp, "index") };
    if (!storeGit(store, cwd, ["read-tree", tree], undefined, index)) return null;
    const info = Buffer.from(`${changed.join("\0")}\0`);
    if (!storeGit(store, cwd, ["update-index", "-z", "--index-info"], info, index)) return null;
    return storeGit(store, cwd, ["write-tree"], undefined, index)?.toString("utf8").trim() || null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The masks of a diff's content: each secret whole, plus each line (of 4 characters or more, like any mask) of
 * a secret of several lines, under the same label. A key changed in one of its lines is no longer the
 * secret's value, but its other lines still are and stay hidden.
 */
export function diffMasks(masks: [string, string][]): [string, string][] {
  const lines = masks.flatMap(([value, label]) =>
    value.includes("\n")
      ? value
          .split(/\r?\n/)
          .filter((line) => line.length >= MIN_MASK)
          .map((line): [string, string] => [line, label])
      : [],
  );
  return [...masks, ...lines];
}

/** A file name as the runner writes it in a diff header: masked, and a control character as `\xNN`. */
function diffName(name: string, masks: [string, string][]): string {
  const shown = (c: string) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : c;
  };
  return [...maskSecrets(name, masks)].map(shown).join("");
}

/**
 * The diff with its header lines written by the runner from the names (`names[i]` is the file of the i-th
 * block, in git's order), so no name goes out as git wrote or escaped it. The other lines stay. `null` when
 * the blocks and the names do not match.
 */
function writeDiffHeaders(diff: string, names: string[], masks: [string, string][]): string | null {
  const lines = diff.split("\n");
  const out: string[] = [];
  let block = -1;
  let inHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      block++;
      inHeader = true;
      const name = names[block];
      if (name === undefined) return null;
      const n = diffName(name, masks);
      out.push(`diff --git a/${n} b/${n}`);
      continue;
    }
    if (inHeader && line.startsWith("@@")) inHeader = false;
    const name = names[block];
    if (!inHeader || name === undefined) {
      out.push(line);
      continue;
    }
    const n = diffName(name, masks);
    if (line.startsWith("--- ")) out.push(line === "--- /dev/null" ? line : `--- a/${n}`);
    else if (line.startsWith("+++ ")) out.push(line === "+++ /dev/null" ? line : `+++ b/${n}`);
    else if (line.startsWith("Binary files ")) {
      const from = line.startsWith("Binary files /dev/null and ") ? "/dev/null" : `a/${n}`;
      const to = line.endsWith(" and /dev/null differ") ? "/dev/null" : `b/${n}`;
      out.push(`Binary files ${from} and ${to} differ`);
      inHeader = false;
    } else if (/^(index |new file mode |deleted file mode |old mode |new mode )/.test(line)) out.push(line);
    // Any other header line (a rename, a copy, a similarity) names files too: it does not go out.
  }
  return block + 1 === names.length ? out.join("\n") : null;
}

interface JobStartArgs {
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
}

export class Jobs {
  private journal: JournalEntry[] = [];
  private readonly running = new Map<string, { kill: () => void }>();
  /** Jobs between the checks of `start` and their process: they hold their id and a slot. */
  private readonly starting = new Set<string>();
  /** Jobs canceled while they were still preparing. */
  private readonly canceledStarts = new Set<string>();
  /** The secrets of each running job, for what is sent while it runs. */
  private readonly liveMasks = new Map<string, () => Masks>();

  constructor(
    private readonly opts: {
      home: string;
      access: Access;
      secrets: SecretStore;
      cli: CliWatch;
      maxConcurrent: () => number;
      maxSeconds: () => number;
      send: (event: JobEvent) => boolean;
      /** The masks of an agent the runner knows now (they grow while a job runs: a secret given mid-job). */
      knownMasks?: (agentId: string) => Masks;
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
    return this.journal.filter((t) => t.status === "running" || !t.delivered).map((t) => this.view(t));
  }

  /**
   * A job as it goes to the server: a running job's raw fields masked with its secrets; an ended one is in the
   * journal as it was sent, masked when it ended.
   */
  private view(t: JournalEntry): JobSnapshot {
    return assembleSnapshot(this.snapshot(t), this.liveMasks.get(t.jobId)?.() ?? []);
  }

  /** Sends a job frame, assembled (masked, cut, valid) with the job's secrets. */
  private emit(frame: JobEvent, masks: Masks): void {
    const out = assemble(frame, masks);
    if (out?.type === "job.event" || out?.type === "job.done") this.opts.send(out);
  }

  /** Sends again the `job.done` that were left unconfirmed (called after `welcome`). */
  redeliver() {
    for (const t of this.journal)
      if (!t.delivered && t.status !== "running" && t.status !== "queued")
        this.emit({ type: "job.done", job: this.view(t) }, []);
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
    return this.view(t);
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
    if (r) {
      r.kill();
      return { canceled: true };
    }
    // Still preparing: when the preparation ends, nothing runs and the job ends as canceled.
    if (this.starting.has(jobId)) {
      this.canceledStarts.add(jobId);
      return { canceled: true };
    }
    return { canceled: false };
  }

  async start(
    agent: AgentRef,
    args: JobStartArgs,
    signal?: AbortSignal,
  ): Promise<{ jobId: string; startedAt: string; cwd: string }> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(args.jobId)) throw new RunnerError("bad_request", "Bad job id");
    if (this.journal.some((t) => t.jobId === args.jobId) || this.starting.has(args.jobId))
      throw new RunnerError("bad_request", "Job id already used");
    this.opts.access.requireTool(
      args.executor === "shell" ? "commands" : args.executor === "codex" ? "codex" : "claude",
    );
    if (this.running.size + this.starting.size >= this.opts.maxConcurrent())
      throw new RunnerError("no_slot", "This environment is already running its maximum of jobs");
    if (args.executor !== "shell") this.opts.cli.requireSubscription(args.executor);
    // The id and the slot are taken here, before the first await: a second start with the same id, or one
    // past the cap, arriving while this one prepares, is rejected above instead of running the job twice.
    this.starting.add(args.jobId);
    try {
      return await this.launch(agent, args, signal);
    } finally {
      this.starting.delete(args.jobId);
      this.canceledStarts.delete(args.jobId);
    }
  }

  private async launch(
    agent: AgentRef,
    args: JobStartArgs,
    signal?: AbortSignal,
  ): Promise<{ jobId: string; startedAt: string; cwd: string }> {
    const root = this.opts.access.agentRoot(agent);
    const cwd = args.cwd ? this.opts.access.resolve(agent, args.cwd) : root;
    const { cmd, args: argv, stdin } = executorCommand(args.executor, { ...args, cwd }, this.opts.bins);
    // Claude Code and Codex read the login of whoever paired and talk to their own service; the rest is the
    // same as a command: the agent's folders and the workspace's network.
    const network = args.network ?? { mode: "off" as const, domains: [] };
    const folders = [root, ...this.opts.access.foldersFor(agent)];
    // Claude Code and Codex use the agent's own state (sessions, memories, configuration) with the person's
    // login read-only; a session is resumed from there.
    const cli =
      args.executor === "shell"
        ? null
        : agentCli(
            args.executor,
            this.opts.policy,
            args.executor === "codex" ? this.opts.bins.codex : this.opts.bins.claude,
            agent,
            inside(cwd, root) ? cwd : null,
            isolated(this.opts.sandbox.status()),
          );
    for (const d of cli?.ensure ?? []) mkdirSync(d, { recursive: true, mode: 0o700 });
    // The starting snapshot before the secret becomes a file in the folder: that way it does not enter the diff.
    const snapStore = join(this.dir, args.jobId, "snapshot.git");
    const secretPaths = this.opts.secrets.secretFiles(agent, root);
    let base: ReturnType<typeof gitSnapshot> | null;
    try {
      base = args.executor === "shell" ? null : gitSnapshot(cwd, snapStore, secretPaths);
    } catch (err) {
      cli?.release();
      throw err;
    }
    const dropSnapshot = () => rmSync(snapStore, { recursive: true, force: true });
    const wrapped = await sandboxed(this.opts, {
      command: shellLine(cmd, argv),
      readable: [...folders, ...(cli?.read ?? [])],
      writable: [...folders, ...(cli?.write ?? [])],
      liberated: folders.slice(1),
      denyRead: cli?.denyRead ?? [],
      denyWrite: cli?.denyWrite ?? [],
      runnerInner: { read: [], write: cli?.innerWrite ?? [] },
      domains: [...domainsFor(network), ...(args.executor === "shell" ? [] : CLI_DOMAINS[args.executor])],
      network,
    }).catch((err) => {
      cli?.release();
      dropSnapshot();
      throw err;
    });
    // The process's sandbox and the agent's CLI login link go together.
    const releaseBox = () => {
      wrapped?.release();
      cli?.release();
    };
    const secrets = await this.opts.secrets.materialize(agent, root, signal).catch((err) => {
      releaseBox();
      dropSnapshot();
      throw err;
    });
    // The request was aborted while the job prepared (the connection dropped): the job does not start, and
    // nothing of it is kept.
    if (signal?.aborted) {
      secrets.release();
      releaseBox();
      dropSnapshot();
      throw new RunnerError("canceled", "Canceled");
    }
    // The job's secrets and the ones the runner learns while it runs, read again at each line and each frame.
    let merged: Masks = secrets.masks;
    let mergedFrom: Masks | null = null;
    const masksNow = (): Masks => {
      const known = this.opts.knownMasks?.(agent.id) ?? [];
      if (known !== mergedFrom) {
        mergedFrom = known;
        merged = [...secrets.masks, ...known];
      }
      return merged;
    };
    const startedAt = new Date().toISOString();
    const canceledEarly = this.canceledStarts.has(args.jobId);
    const entry: JournalEntry = {
      jobId: args.jobId,
      status: canceledEarly ? "canceled" : "running",
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
    const jobDir = join(this.dir, args.jobId);
    if (canceledEarly) {
      // Canceled before its process started: nothing runs, the slot goes back, the job ends as canceled.
      secrets.release();
      releaseBox();
      dropSnapshot();
      entry.endedAt = startedAt;
      this.journal.push(entry);
      this.save();
      ensureDir(jobDir);
      writeFileSync(join(jobDir, "output.log"), "");
      this.emit({ type: "job.done", job: this.snapshot(entry) }, []);
      return { jobId: args.jobId, startedAt, cwd };
    }
    this.journal.push(entry);
    this.save();
    ensureDir(jobDir);
    const logPath = join(jobDir, "output.log");
    const child = spawn(wrapped ? "/bin/sh" : cmd, wrapped ? ["-c", wrapped.command] : argv, {
      cwd,
      // A shell job does not use the plan of whoever paired; Claude Code and Codex do (checked above).
      env: agentEnv(root, {
        secrets: secrets.env,
        internal: args.executor === "shell" ? noPlanEnv(root) : (cli?.env ?? {}),
      }),
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let lastSent = 0;
    let tailLine = "";
    let sentLine = "";
    let canceled = false;
    let timedOut = false;
    let rejected: string | null = null;
    let model: string | null = null;
    let usage: Omit<JobUsage, "model"> | null = null;
    const at = () => new Date().toISOString();
    // Raised by the handling of the output (a bad event, a mask that throws): the job ends failed, never hangs.
    let handlerError: string | null = null;
    const fail = (err: unknown) => {
      if (handlerError !== null) return;
      handlerError = err instanceof Error ? err.message : String(err);
      stop();
    };
    // Every value here is raw: what the runner decides, and what the frames are built from. The free text is
    // masked when a frame is assembled (outbound.ts), and in the log when it is written.
    const onLine = (line: string, event?: Record<string, unknown>) => {
      const parsed =
        event && args.executor !== "shell" ? parseExecutorEvent(args.executor, event) : { text: line };
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
      if (parsed.result !== undefined) entry.result = parsed.result;
      if (!parsed.text) return;
      // One line of the job's text: masked whole, then through the flow of the job's lines, so a secret of
      // two lines split between two events goes out in neither.
      const one = maskSecrets(parsed.text, masksNow()).replace(/\r?\n/g, " ");
      flowed += lines.push(`${one}\n`);
      takeLines(false);
    };
    const lines = new StreamMasker(masksNow);
    let flowed = "";
    // The lines the flow let go: written to the log, and the newest sent (one every LINE_EVERY_MS).
    const takeLines = (last: boolean) => {
      const done = flowed.split("\n");
      flowed = last ? "" : (done.pop() ?? "");
      for (const line of done) {
        if (!line) continue;
        appendFileSync(logPath, `${line.slice(0, LINE_MAX)}\n`);
        tailLine = line;
      }
      if (tailLine && tailLine !== sentLine && (last || Date.now() - lastSent >= LINE_EVERY_MS)) {
        lastSent = Date.now();
        sentLine = tailLine;
        this.emit(
          { type: "job.event", jobId: args.jobId, kind: "line", line: tailLine, at: at() },
          masksNow(),
        );
      }
    };
    const guarded = (line: string, event?: Record<string, unknown>) => {
      try {
        onLine(line, event);
      } catch (err) {
        fail(err);
      }
    };
    const output = new JobOutput(masksNow, guarded, args.executor === "shell" ? "text" : "json");
    const take = (chunk: string) => {
      try {
        output.push(chunk);
      } catch (err) {
        fail(err);
      }
    };
    child.stdout?.setEncoding("utf8").on("data", take);
    child.stderr?.setEncoding("utf8").on("data", take);
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
    // The job now holds its slot as a running one.
    this.starting.delete(args.jobId);
    this.liveMasks.set(args.jobId, masksNow);
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
        this.emit(
          { type: "job.event", jobId: args.jobId, kind: "progress", line: tailLine, at: at() },
          masksNow(),
        );
      }
    }, PROGRESS_EVERY_MS);
    child.stdin?.on("error", fail);
    if (stdin !== null) child.stdin?.end(stdin);
    child.on("error", (e) => guarded(`error: ${e.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(progress);
      this.running.delete(args.jobId);
      try {
        try {
          output.end();
          // The tail the flow of lines held goes before the job.done.
          flowed += lines.end();
          takeLines(true);
        } catch (err) {
          fail(err);
        }
        secrets.release();
        if (network.mode === "allowlist") entry.blocked = (wrapped?.blocked() ?? []).slice(0, 50);
        releaseBox();
        entry.exitCode = code;
        entry.status =
          handlerError !== null
            ? "failed"
            : canceled
              ? "canceled"
              : rejected || timedOut || code !== 0
                ? "failed"
                : "done";
        if (rejected) entry.result = rejected;
        if (handlerError !== null) entry.result = `The runner stopped this job: ${handlerError}`;
        entry.endedAt = at();
        if (entry.result === null && tailLine) entry.result = tailLine;
        if (usage) entry.usage = { model, ...usage };
        // Files and diff against the start of the job (the server stores them as proof for the assignment).
        if (base) {
          const changes = gitChanges(cwd, snapStore, base, secretPaths, masksNow());
          entry.files = changes.files;
          entry.diff = changes.diff;
        }
        if (tailLine !== sentLine)
          this.emit(
            { type: "job.event", jobId: args.jobId, kind: "line", line: tailLine, at: at() },
            masksNow(),
          );
      } catch (err) {
        // Whatever failed after the process ended: the job still ends, failed, and its slot is back.
        entry.status = "failed";
        entry.endedAt = at();
        entry.result = `The runner could not finish this job: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        dropSnapshot();
        // The journal keeps the job as it was sent: masked, cut and valid.
        // A field the assembly left out (a usage that failed the schema) goes from the journal too.
        const sent = assembleSnapshot(this.snapshot(entry), masksNow());
        Object.assign(entry, { ...sent, usage: sent.usage ?? null, diff: sent.diff ?? null });
        // The runner keeps a shorter result than the protocol allows.
        if (entry.result) entry.result = entry.result.slice(0, RESULT_MAX);
        this.liveMasks.delete(args.jobId);
        this.save();
        this.emit({ type: "job.done", job: this.snapshot(entry) }, masksNow());
      }
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
