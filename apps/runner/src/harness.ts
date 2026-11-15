// The harness in the environment: an agent turn thought by the Claude Code or Codex installed here, on the plan
// of whoever paired. Each turn is a new process (`claude -p` or `codex exec`), with no saved session:
// the server sends the whole context (instructions and the conversation). The CLI does not use its own tools
// (no shell, no file editing): the agent acts only through its own tools, which arrive over MCP and
// run on the server with the usual permissions and approvals. Before starting the CLI, the runner checks
// that the login is a subscription; on Claude Code it checks again at `init` (`apiKeySource`).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentRef, HarnessEvent, HarnessTurnResult, opArgs } from "@vanr/engine/runner-protocol";
import { z } from "zod";
import { type Access, inside, RunnerError } from "./access";
import { type CliBins, type CliWatch, cliEnv } from "./cli";
import { ensureDir, writePrivate } from "./config";
import { maybe, parseLine } from "./lines";
import { MCP_SERVER_NAME, MCP_SOCKET_ENV, MCP_TOKEN_ENV, type McpBridge, type ToolOutcome } from "./mcp";
import { sandboxed } from "./ops";
import {
  type AgentCli,
  agentCli,
  CLI_DOMAINS,
  type CommandSandbox,
  isolated,
  type PolicyContext,
  SESSION_ENV,
  shellLine,
} from "./sandbox";

export type HarnessTurnArgs = z.output<(typeof opArgs)["harness.turn"]>;

/** Harness processes at the same time in this environment (the original uses 3). */
const MAX_PROCESSES = 3;
const DEFAULT_TIMEOUT_S = 6 * 3600;
const STDERR_KEEP = 4000;
/**
 * Codex gets the instructions in argv (`developer_instructions`). One argument on Linux goes up to
 * 128 KiB (in bytes, JSON included); beyond that, the instructions go at the start of the prompt.
 */
const CODEX_SYSTEM_ARGV_BYTES = 100_000;
const codexSystemFitsArgv = (system: string) =>
  Buffer.byteLength(`developer_instructions=${JSON.stringify(system)}`) <= CODEX_SYSTEM_ARGV_BYTES;

function claudeHarnessArgs(input: { model?: string; systemFile: string; mcpFile: string }): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Without Claude Code's own tools: the agent acts only through its own (MCP).
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpFile,
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "--permission-mode",
    "dontAsk",
    // Only `local` (the turn folder, which belongs to the runner): without the person's settings.json (it may have `env`
    // with an API key, hooks and other servers) and without CLAUDE.md from the person or from folders above the turn.
    "--setting-sources",
    "local",
    "--no-session-persistence",
    "--append-system-prompt-file",
    input.systemFile,
    ...(input.model ? ["--model", input.model] : []),
  ];
}

/**
 * Codex's own tools (`codex features list`) the harness does not use. `code_mode_host` stays:
 * in Codex 0.162 the MCP tools go through it (an isolated JavaScript, with no disk or shell).
 */
const CODEX_FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "view_image",
  "image_generation",
  "hooks",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "workspace_dependencies",
  "goals",
  "sleep_tool",
  "multi_agent",
  "multi_agent_v2",
];

function codexHarnessArgs(input: {
  cliKind: AgentCli["kind"];
  cwd: string;
  model?: string;
  system: string | null;
  mcpCommand: string[];
  timeoutSeconds: number;
}): string[] {
  const [command, ...args] = input.mcpCommand;
  const key = `mcp_servers.${MCP_SERVER_NAME}`;
  const toml = (v: unknown) => JSON.stringify(v);
  const overrides = [
    // Rejects an API key: Codex only runs with the ChatGPT login.
    'forced_login_method="chatgpt"',
    'approval_policy="never"',
    // No Codex shell, files, images, web, apps or hooks: the agent acts only through its own tools.
    ...CODEX_FEATURES_OFF.map((f) => `features.${f}=false`),
    'web_search="disabled"',
    ...(input.system ? [`developer_instructions=${toml(input.system)}`] : []),
    `${key}.command=${toml(command)}`,
    `${key}.args=${toml(args)}`,
    `${key}.env_vars=${toml([MCP_TOKEN_ENV, MCP_SOCKET_ENV])}`,
    `${key}.default_tools_approval_mode="approve"`,
    `${key}.startup_timeout_sec=60`,
    `${key}.tool_timeout_sec=${input.timeoutSeconds}`,
    `${key}.required=true`,
  ];
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    // Without the person's config.toml (their MCP servers, another model provider).
    "--ignore-user-config",
    ...(input.cliKind === "own" ? ["--ignore-rules"] : []),
    "-C",
    input.cwd,
    "--sandbox",
    "read-only",
    ...overrides.flatMap((o) => ["-c", o]),
    ...(input.model ? ["-m", input.model] : []),
    "-",
  ];
}

interface StreamState {
  final: string | null;
  done: boolean;
  usage: HarnessTurnResult["usage"];
  model: string | null;
  error: RunnerError | null;
  authFailed: boolean;
  lastError: string;
}

const newState = (): StreamState => ({
  final: null,
  done: false,
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  model: null,
  error: null,
  authFailed: false,
  lastError: "",
});

const claudeUsage = z
  .object({
    input_tokens: maybe.number,
    output_tokens: maybe.number,
    cache_read_input_tokens: maybe.number,
    cache_creation_input_tokens: maybe.number,
  })
  .optional()
  .catch(undefined);

/** The lines of `claude -p --output-format stream-json` the harness reads. */
const claudeEvent = z.object({
  type: maybe.string,
  subtype: z.unknown().optional(),
  apiKeySource: maybe.string,
  model: maybe.string,
  error: maybe.string,
  parent_tool_use_id: z.unknown().optional(),
  event: z
    .object({
      type: maybe.string,
      delta: z.object({ type: maybe.string, text: maybe.text }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  usage: claudeUsage,
  is_error: maybe.boolean,
  errors: z.array(z.unknown()).optional().catch(undefined),
  result: maybe.text,
});

/** The lines of `codex exec --json` the harness reads. */
const codexEvent = z.object({
  type: maybe.string,
  item: z.object({ type: maybe.string, text: maybe.text }).optional().catch(undefined),
  usage: z
    .object({ input_tokens: maybe.number, cached_input_tokens: maybe.number, output_tokens: maybe.number })
    .optional()
    .catch(undefined),
  error: z.object({ message: maybe.text }).optional().catch(undefined),
  message: maybe.text,
});

/** What the person reads when an agent session cannot use their CLI login. */
export const SIGN_IN_AGAIN =
  "Sign in to the CLI again on this computer: agent sessions only read your login and cannot renew it.";

/** A CLI error: plan limit, login, or something else. */
export function classifyHarnessError(message: string, authFailed = false): RunnerError {
  const text = message.trim().slice(-2000) || "The CLI stopped without an answer";
  if (
    /usage limit|limit reached|rate.?limit|hit your limit|resets? (at|in)|out of (extra )?usage/i.test(text)
  )
    return new RunnerError("plan_limit", text);
  // The session reads the person's login read-only: a CLI that tried to renew it hits a read-only file.
  const renewBlocked =
    /read-only file system|EROFS|EBUSY|resource busy/i.test(text) &&
    /credential|auth\.json|token|login/i.test(text);
  if (
    authFailed ||
    renewBlocked ||
    /not logged in|\/login|log ?in again|invalid api key|authenticat|unauthori[sz]ed|oauth/i.test(text)
  )
    return new RunnerError("not_logged_in", `${SIGN_IN_AGAIN} ${text}`);
  return new RunnerError("harness_failed", text);
}

/** A line of `claude -p --output-format stream-json`. Returns the new text to show. */
function claudeLine(state: StreamState, raw: string): string | null {
  const obj = parseLine(claudeEvent, raw);
  if (!obj) return null;
  if (obj.type === "system" && obj.subtype === "init") {
    // `none` is the subscription login; any other source is an API key and the turn stops here.
    const source = obj.apiKeySource;
    if (source !== undefined && source !== "none")
      state.error = new RunnerError(
        "not_logged_in",
        `Claude Code in this environment would use ${source} instead of your plan`,
      );
    if (obj.model !== undefined) state.model = obj.model.slice(0, 100);
    return null;
  }
  if (obj.type === "system" && obj.subtype === "api_retry") {
    if (obj.error === "authentication_failed") state.authFailed = true;
    return null;
  }
  if (obj.type === "stream_event" && obj.parent_tool_use_id == null) {
    const delta = obj.event?.delta;
    if (obj.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text)
      return delta.text;
    return null;
  }
  if (obj.type === "result") {
    const u = obj.usage;
    state.usage = {
      inputTokens: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
      outputTokens: u?.output_tokens ?? 0,
      cachedTokens: u?.cache_read_input_tokens ?? 0,
    };
    if (obj.is_error === true || (obj.subtype && obj.subtype !== "success")) {
      const errors = obj.errors ? obj.errors.map(String).join("; ") : "";
      const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
      state.error ??= classifyHarnessError(obj.result || errors || subtype, state.authFailed);
    } else {
      state.final = obj.result;
      state.done = true;
    }
  }
  return null;
}

/** A line of `codex exec --json`. Returns the new text to show. */
function codexLine(state: StreamState, raw: string): string | null {
  const obj = parseLine(codexEvent, raw);
  if (!obj) return null;
  const text = obj.item?.text ?? "";
  if (obj.type === "item.completed" && obj.item?.type === "agent_message" && text) {
    state.final = text;
    return text;
  }
  if (obj.type === "turn.completed") {
    const u = obj.usage;
    state.usage = {
      inputTokens: (u?.input_tokens ?? 0) - (u?.cached_input_tokens ?? 0),
      outputTokens: u?.output_tokens ?? 0,
      cachedTokens: u?.cached_input_tokens ?? 0,
    };
    state.done = true;
    return null;
  }
  if (obj.type === "turn.failed") {
    state.error ??= classifyHarnessError(obj.error?.message || state.lastError);
    return null;
  }
  // A loose `error` may be a reconnection notice; it only counts if the turn does not finish.
  if (obj.type === "error") state.lastError = obj.message;
  return null;
}

/** Environment of the harness CLI: no API key, no session sockets, TMPDIR in the work folder. */
function harnessEnv(cwd: string, internal: Record<string, string>): Record<string, string> {
  const tmp = join(cwd, ".tmp");
  ensureDir(tmp);
  const env = cliEnv({ internal: { TMPDIR: tmp, ...internal } });
  for (const k of SESSION_ENV) delete env[k];
  return env;
}

export class Harnesses {
  private running = 0;
  private readonly children = new Set<() => void>();

  constructor(
    private readonly opts: {
      home: string;
      access: Access;
      bins: CliBins;
      cli: CliWatch;
      bridge: McpBridge;
      /** How to start the runner's MCP server (`<runtime> <script> mcp`). */
      mcpCommand: string[];
      sandbox: CommandSandbox;
      policy: PolicyContext;
    },
  ) {}

  /**
   * What the harness process reads to start the runner's MCP server: the runtime, the bundle (or, running
   * from source, the monorepo with its node_modules) and the bridge socket.
   */
  private mcpReadable(): { outside: string[]; inner: string[] } {
    const runner = resolve(this.opts.home);
    const paths: string[] = [];
    const [runtime, script] = this.opts.mcpCommand;
    if (runtime && existsSync(runtime)) paths.push(dirname(runtime));
    if (script && existsSync(script)) {
      paths.push(script);
      if (script.endsWith(".ts")) {
        // From source: the package imports the monorepo; walks up to the highest folder with node_modules.
        let dir = dirname(script);
        let top: string | null = null;
        while (dirname(dir) !== dir) {
          if (existsSync(join(dir, "node_modules"))) top = dir;
          dir = dirname(dir);
        }
        if (top) paths.push(top);
      }
    }
    paths.push(this.opts.bridge.path);
    return {
      outside: paths.filter((p) => !inside(resolve(p), runner)),
      inner: paths.filter((p) => inside(resolve(p), runner) && resolve(p) !== runner),
    };
  }

  async turn(
    agent: AgentRef,
    args: HarnessTurnArgs,
    io: {
      signal: AbortSignal;
      emit: (event: HarnessEvent) => void;
      callTool: (name: string, input: unknown) => Promise<ToolOutcome>;
    },
  ): Promise<HarnessTurnResult> {
    this.opts.access.requireTool(args.executor === "codex" ? "codex" : "claude");
    this.opts.cli.requireSubscription(args.executor);
    if (this.running >= MAX_PROCESSES)
      throw new RunnerError(
        "no_slot",
        "This environment is already thinking for other agents; try again soon",
      );
    this.running++;
    let dir: string | undefined;
    const timeoutSeconds = Math.min(args.timeoutSeconds ?? DEFAULT_TIMEOUT_S, 86_400);
    let bridge: { token: string; close: () => void } | null = null;
    let cli: AgentCli | null = null;
    try {
      const turns = join(this.opts.home, "harness", "turns");
      ensureDir(turns);
      dir = mkdtempSync(join(turns, `${args.runId}-`));
      const cwd = this.opts.access.agentRoot(agent, join(this.opts.home, "harness", "work"));
      bridge = await this.opts.bridge.open(args.tools, io.callTool);
      const link = { [MCP_TOKEN_ENV]: bridge.token, [MCP_SOCKET_ENV]: this.opts.bridge.path };
      // In the sandbox: the CLI login, the turn folder and the work folder, the MCP; network only the CLI's.
      const bin = args.executor === "codex" ? this.opts.bins.codex : this.opts.bins.claude;
      // The agent's own CLI state (sessions, memories, configuration), with the person's login read-only.
      cli = agentCli(args.executor, this.opts.policy, bin, agent, cwd, isolated(this.opts.sandbox.status()));
      for (const d of cli.ensure) ensureDir(d);
      const mcp = this.mcpReadable();
      const box = {
        readable: [...cli.read, ...mcp.outside],
        writable: cli.write,
        denyRead: cli.denyRead,
        denyWrite: cli.denyWrite,
        runnerInner: { read: [dir, ...mcp.inner], write: [cwd, ...cli.innerWrite] },
        domains: CLI_DOMAINS[args.executor],
        network: args.network ?? { mode: "off" as const, domains: [] },
      };
      if (args.executor === "claude_code") {
        const systemFile = join(dir, "system.txt");
        const mcpFile = join(dir, "mcp.json");
        writePrivate(systemFile, args.system);
        const [command, ...rest] = this.opts.mcpCommand;
        writePrivate(
          mcpFile,
          JSON.stringify({
            mcpServers: { [MCP_SERVER_NAME]: { type: "stdio", command, args: rest, env: link } },
          }),
        );
        return await this.spawnTurn({
          executor: "claude_code",
          cmd: this.opts.bins.claude,
          argv: claudeHarnessArgs({ model: args.model, systemFile, mcpFile }),
          env: harnessEnv(cwd, { MCP_TOOL_TIMEOUT: String(timeoutSeconds * 1000), ...cli.env }),
          box,
          cwd,
          stdin: args.prompt,
          timeoutMs: timeoutSeconds * 1000,
          io,
        });
      }
      const inArgv = codexSystemFitsArgv(args.system);
      return await this.spawnTurn({
        executor: "codex",
        cmd: this.opts.bins.codex,
        argv: codexHarnessArgs({
          cliKind: cli.kind,
          cwd,
          model: args.model,
          system: inArgv ? args.system : null,
          mcpCommand: this.opts.mcpCommand,
          timeoutSeconds,
        }),
        env: harnessEnv(cwd, { ...link, ...cli.env }),
        box,
        cwd,
        stdin: inArgv ? args.prompt : `${args.system}\n\n${args.prompt}`,
        timeoutMs: timeoutSeconds * 1000,
        io,
      });
    } finally {
      bridge?.close();
      cli?.release();
      this.running--;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  private async spawnTurn(input: {
    executor: "claude_code" | "codex";
    cmd: string;
    argv: string[];
    env: Record<string, string>;
    box: Omit<Parameters<typeof sandboxed>[1], "command">;
    cwd: string;
    stdin: string;
    timeoutMs: number;
    io: { signal: AbortSignal; emit: (event: HarnessEvent) => void };
  }): Promise<HarnessTurnResult> {
    const { io } = input;
    if (io.signal.aborted) throw new RunnerError("canceled", "Canceled");
    const wrapped = await sandboxed(this.opts, { ...input.box, command: shellLine(input.cmd, input.argv) });
    // Aborted while the sandbox opened: the CLI does not start.
    if (io.signal.aborted) {
      wrapped?.release();
      throw new RunnerError("canceled", "Canceled");
    }
    return new Promise<HarnessTurnResult>((resolve, reject) => {
      const child = spawn(wrapped ? "/bin/sh" : input.cmd, wrapped ? ["-c", wrapped.command] : input.argv, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const state = newState();
      const parse = input.executor === "claude_code" ? claudeLine : codexLine;
      let stderr = "";
      let buffer = "";
      let stopped = false;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // already exited
        }
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        kill("SIGTERM");
        setTimeout(() => kill("SIGKILL"), 5000).unref();
      };
      this.children.add(stop);
      const timer = setTimeout(() => {
        state.error ??= new RunnerError("timeout", "The harness took too long");
        stop();
      }, input.timeoutMs);
      const onAbort = () => {
        state.error = new RunnerError("canceled", "Canceled");
        stop();
      };
      io.signal.addEventListener("abort", onAbort, { once: true });
      const onLine = (line: string) => {
        const text = parse(state, line);
        if (text) io.emit({ kind: "text", text: text.slice(0, 100_000) });
        // An API key in place of the plan: stops before spending.
        if (state.error && !state.done) stop();
      };
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        let i = buffer.indexOf("\n");
        while (i >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) onLine(line);
          i = buffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_KEEP);
      });
      child.on("error", (err) => {
        state.error ??= new RunnerError(
          "harness_failed",
          `${input.executor === "codex" ? "Codex" : "Claude Code"} could not start: ${err.message}`,
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        io.signal.removeEventListener("abort", onAbort);
        this.children.delete(stop);
        if (buffer.trim()) onLine(buffer.trim());
        if (state.error) return reject(state.error);
        if (state.done) return resolve({ text: state.final ?? "", usage: state.usage, model: state.model });
        reject(classifyHarnessError(state.lastError || stderr || `The CLI exited with ${code}`));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input.stdin);
    }).finally(() => wrapped?.release());
  }

  close() {
    for (const stop of this.children) stop();
  }
}
