// Fake `claude` and `codex` for the tests (never the real one). They speak the same protocol the runner
// uses: `--version`, the login check (`claude auth status --json`, `codex login status`) and the harness
// turn in line-delimited JSON. In the turn, they start the runner's MCP server as the real CLI would
// and call the tool asked for in the conversation with `[[call:name {json}]]`. Everything they saw goes to the log.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface FakeCliConfig {
  kind: "claude" | "codex";
  /** Line-delimited JSON file with what the CLI saw on each call. */
  log: string;
  /** `claude auth status --json` (default: logged in to the max plan). */
  auth?: Record<string, unknown>;
  /** `codex login status` (default: "Logged in using ChatGPT"). */
  codexLogin?: string;
  /** `apiKeySource` of Claude Code's `init` (default: "none", which is the subscription). */
  apiKeySource?: string;
  /** The turn ends with the plan limit. */
  limit?: boolean;
  /** Files the CLI tries to read during the turn (the sandbox test checks which ones opened). */
  probe?: string[];
}

const RUNNER_MAIN = resolve(import.meta.dir, "..", "main.ts");

/** Command of the runner's MCP server for the tests (the same `mcp` of the runner CLI). */
export const testMcpCommand = (): string[] => [process.execPath, RUNNER_MAIN, "mcp"];

/** Writes the fake executable in `dir` and returns its path. */
export function fakeCliBin(dir: string, name: string, config: FakeCliConfig): string {
  const cfg = join(dir, `${name}.json`);
  writeFileSync(cfg, JSON.stringify(config));
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dir, "fake-cli.ts")}" --fake-config "${cfg}" "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Lines of the fake CLI's log. */
export function fakeCliLog(path: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---- the executable ----

const out = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Minimal MCP client (line-delimited JSON-RPC on the server's stdio). */
function mcpClient(command: string, args: string[], env: Record<string, string>) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let seq = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    pending.get(Number(msg.id))?.(msg);
  });
  const ask = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((done) => {
      const id = ++seq;
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    async start() {
      await ask("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fake" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const list = await ask("tools/list");
      return ((list.result as { tools?: { name: string }[] }).tools ?? []).map((t) => t.name);
    },
    async call(name: string, input: unknown) {
      const r = (await ask("tools/call", { name, arguments: input })).result as {
        content: { text: string }[];
        isError: boolean;
      };
      return { text: r.content.map((c) => c.text).join(""), isError: r.isError };
    },
    close: () => child.stdin.end(),
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Tools asked for after the agent's last answer (`You: ...`): `[[call:name {"a":1}]]`.
 * Several directives become calls at the same time, as the CLI does with parallel tools.
 */
function requestedCalls(prompt: string): { name: string; input: unknown }[] {
  const fresh = prompt.slice(Math.max(0, prompt.lastIndexOf("You: ")));
  return [...fresh.matchAll(/\[\[call:([A-Za-z0-9_-]+) (\{.*?\})\]\]/gs)].map((m) => ({
    name: m[1] as string,
    input: JSON.parse(m[2] as string),
  }));
}

/** Calls the requested tools (in parallel) and builds the answer. */
async function callAll(
  mcp: ReturnType<typeof mcpClient>,
  prompt: string,
  entry: Record<string, unknown>,
): Promise<string | null> {
  const calls = requestedCalls(prompt);
  if (!calls.length) return null;
  const results = await Promise.all(calls.map((c) => mcp.call(c.name, c.input)));
  entry.call = results[0];
  entry.calls = results;
  return `Done: ${results.map((r) => r.text).join(" | ")}`;
}

/** Like the real one: with the config folder pointed elsewhere and no credential there, there is no login. */
const noLogin = (env: string, file: string) => {
  const dir = process.env[env];
  return !!dir && !existsSync(join(dir, file));
};

const secretsSeen = () =>
  Object.keys(process.env).filter((k) => /^(ANTHROPIC_|OPENAI_|CODEX_API_KEY|AWS_BEARER)/.test(k));

async function claude(cfg: FakeCliConfig, args: string[]) {
  if (args[0] === "--version") return console.log("9.9.9 (Claude Code)");
  if (args[0] === "auth")
    return console.log(
      JSON.stringify(
        noLogin("CLAUDE_CONFIG_DIR", ".credentials.json")
          ? { loggedIn: false, authMethod: "none" }
          : (cfg.auth ?? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      ),
    );
  const prompt = await readStdin();
  const config = JSON.parse(readFileSync(flagValue(args, "--mcp-config") as string, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = config.mcpServers.agent;
  const entry: Record<string, unknown> = {
    kind: "claude",
    args,
    prompt,
    envKeys: secretsSeen(),
    probes: (cfg.probe ?? []).map((path) => {
      try {
        readFileSync(path);
        return { path, read: true };
      } catch {
        return { path, read: false };
      }
    }),
  };
  const apiKey = (cfg.apiKeySource ?? "none") !== "none";
  // Writes before init: the runner may kill the process as soon as it reads an init with an API key.
  if (apiKey) appendFileSync(cfg.log, `${JSON.stringify({ ...entry, waitedForKill: true })}\n`);
  out({
    type: "system",
    subtype: "init",
    session_id: "s-1",
    apiKeySource: cfg.apiKeySource ?? "none",
    model: "x",
  });
  if (apiKey) {
    await new Promise((r) => setTimeout(r, 30_000));
    return;
  }
  const delta = (text: string) =>
    out({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
  const mcp = mcpClient(server?.command ?? "", server?.args ?? [], {
    ...(process.env as Record<string, string>),
    ...server?.env,
  });
  entry.tools = await mcp.start();
  delta("Thinking. ");
  const answer = (await callAll(mcp, prompt, entry)) ?? "Hi from Claude Code.";
  mcp.close();
  appendFileSync(cfg.log, `${JSON.stringify(entry)}\n`);
  if (cfg.limit) {
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your usage limit",
      usage: {},
    });
    return;
  }
  delta(answer);
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: answer,
    session_id: "s-1",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
  });
}

async function codex(cfg: FakeCliConfig, args: string[]) {
  if (args[0] === "--version") return console.log("codex-cli 9.9.9");
  // The real one writes the login state to stderr.
  if (args[0] === "login") {
    if (noLogin("CODEX_HOME", "auth.json")) {
      console.error("Not logged in");
      process.exit(1);
    }
    return console.error(cfg.codexLogin ?? "Logged in using ChatGPT");
  }
  const prompt = await readStdin();
  const overrides = new Map<string, string>();
  args.forEach((a, i) => {
    if (a !== "-c") return;
    const [k, ...v] = (args[i + 1] ?? "").split("=");
    overrides.set(k as string, v.join("="));
  });
  const command = JSON.parse(overrides.get("mcp_servers.agent.command") ?? '""') as string;
  const mcpArgs = JSON.parse(overrides.get("mcp_servers.agent.args") ?? "[]") as string[];
  const names = JSON.parse(overrides.get("mcp_servers.agent.env_vars") ?? "[]") as string[];
  const env = { ...(process.env as Record<string, string>) };
  const entry: Record<string, unknown> = {
    kind: "codex",
    args,
    prompt,
    envKeys: secretsSeen(),
    passed: names,
  };
  out({ type: "thread.started", thread_id: "t-1" });
  const mcp = mcpClient(command, mcpArgs, env);
  entry.tools = await mcp.start();
  const answer = (await callAll(mcp, prompt, entry)) ?? "Hi from Codex.";
  mcp.close();
  appendFileSync(cfg.log, `${JSON.stringify(entry)}\n`);
  out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: answer } });
  out({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 } });
}

if (import.meta.main) {
  const [, , flag, cfgPath, ...args] = process.argv;
  if (flag !== "--fake-config" || !cfgPath) process.exit(2);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as FakeCliConfig;
  await (cfg.kind === "claude" ? claude(cfg, args) : codex(cfg, args));
  process.exit(0);
}
