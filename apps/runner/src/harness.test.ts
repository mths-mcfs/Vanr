import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAccess } from "@vanr/contract";
import type { HarnessEvent } from "@vanr/engine/runner-protocol";
import { Access, RunnerError } from "./access";
import { CliWatch } from "./cli";
import { classifyHarnessError, Harnesses, type HarnessTurnArgs } from "./harness";
import { McpBridge } from "./mcp";
import { defaultPolicyContext, sandboxOff } from "./sandbox";
import { type FakeCliConfig, fakeCliBin, fakeCliLog, testMcpCommand } from "./testing/fake-cli";
import { signedInPolicy } from "./testing/sandbox";

// The harness in the environment with fake `claude` and `codex` (never the real ones): the CLI starts the runner's
// MCP server, calls the agent's tool, which comes back here, and the answer arrives bit by bit. An
// API key in the runner's environment does not reach the CLI, and a CLI that would fall back to the key stops at `init`.
const dir = mkdtempSync(join(tmpdir(), "runner-harness-"));
const agent = { id: "agt_0000000012345678", handle: "lia" };
const tools = { files: true, commands: true, browser: true, claude: true, codex: true };
const access = new Access(() => ({
  access: { folders: [], tools } as unknown as RunnerAccess,
  workDir: join(dir, "ws"),
  paused: false,
}));
const saved = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
let bridge: McpBridge;
let n = 0;

beforeAll(() => {
  // The runner has keys in its environment; they must not reach the CLI.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-test";
  bridge = new McpBridge(join(dir, "home"));
});
afterAll(() => {
  bridge.close();
  if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.anthropic;
  if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved.openai;
  rmSync(dir, { recursive: true, force: true });
});

function setup(kind: FakeCliConfig["kind"], extra: Partial<FakeCliConfig> = {}) {
  const log = join(dir, `log-${++n}.jsonl`);
  const bin = fakeCliBin(dir, `${kind}-${n}`, { kind, log, ...extra });
  const bins = {
    claude: kind === "claude" ? bin : "/bin/false",
    codex: kind === "codex" ? bin : "/bin/false",
  };
  const cli = new CliWatch({ bins, installed: [kind === "claude" ? "claude_code" : "codex"] });
  const harnesses = new Harnesses({
    home: join(dir, "home"),
    access,
    bins,
    cli,
    bridge,
    mcpCommand: testMcpCommand(),
    // The harness's real sandbox has its own test (sandbox.test.ts).
    sandbox: sandboxOff(),
    policy: defaultPolicyContext(join(dir, "home")),
  });
  return { harnesses, log };
}

const args = (executor: HarnessTurnArgs["executor"], prompt: string): HarnessTurnArgs => ({
  runId: `run_${String(++n).padStart(8, "0")}`,
  executor,
  system: "You are Lia.",
  prompt,
  tools: [
    {
      name: "remember",
      description: "Saves a note",
      inputSchema: { type: "object", properties: { note: { type: "string" } } },
    },
  ],
});

function io() {
  const events: HarnessEvent[] = [];
  const calls: { name: string; input: unknown }[] = [];
  return {
    events,
    calls,
    signal: new AbortController().signal,
    emit: (e: HarnessEvent) => events.push(e),
    callTool: async (name: string, input: unknown) => {
      calls.push({ name, input });
      return { content: `saved ${JSON.stringify(input)}`, isError: false };
    },
  };
}

test("Claude Code: calls the tool over MCP, the answer arrives bit by bit, no key in the environment", async () => {
  const { harnesses, log } = setup("claude");
  const t = io();
  const turn = args("claude_code", 'Ana: save this [[call:remember {"note":"hi"}]]');
  const r = await harnesses.turn(agent, turn, t);
  expect(t.calls).toEqual([{ name: "remember", input: { note: "hi" } }]);
  expect(r.text).toBe('Done: saved {"note":"hi"}');
  expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 5, cachedTokens: 2 });
  expect(t.events.map((e) => e.text).join("")).toBe('Thinking. Done: saved {"note":"hi"}');
  const [seen] = fakeCliLog(log);
  expect(seen?.envKeys).toEqual([]);
  expect(seen?.tools).toEqual(["remember"]);
  expect(seen?.prompt).toBe(turn.prompt);
  const argv = seen?.args as string[];
  expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(argv).toContain("--strict-mcp-config");
  expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("local");
  expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__agent");
  // The turn cleans up what it wrote (instructions and the MCP config with the token).
  expect(existsSync(join(dir, "home", "harness", "turns", turn.runId))).toBe(false);
});

test("a Claude Code that would use an API key stops at init, before spending", async () => {
  const { harnesses, log } = setup("claude", { apiKeySource: "ANTHROPIC_API_KEY" });
  const started = Date.now();
  const err = await harnesses.turn(agent, args("claude_code", "hi"), io()).catch((e) => e);
  expect(err).toBeInstanceOf(RunnerError);
  expect((err as RunnerError).code).toBe("not_logged_in");
  // The fake sleeps 30 s after init; the runner kills it first.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(fakeCliLog(log)[0]?.waitedForKill).toBe(true);
});

test("a Claude Code logged in with an API key does not open the turn", async () => {
  const { harnesses, log } = setup("claude", { auth: { loggedIn: true, authMethod: "api_key" } });
  const err = await harnesses.turn(agent, args("claude_code", "hi"), io()).catch((e) => e);
  expect((err as RunnerError).code).toBe("not_logged_in");
  expect((err as RunnerError).message).toMatch(/API key/);
  expect(fakeCliLog(log)).toEqual([]);
});

test("the plan limit becomes plan_limit", async () => {
  const { harnesses } = setup("claude", { limit: true });
  const err = await harnesses.turn(agent, args("claude_code", "hi"), io()).catch((e) => e);
  expect((err as RunnerError).code).toBe("plan_limit");
});

test("Codex: only with the ChatGPT login, no shell, the tool over MCP", async () => {
  const { harnesses, log } = setup("codex");
  const t = io();
  const r = await harnesses.turn(agent, args("codex", '[[call:remember {"note":"x"}]]'), t);
  expect(r.text).toBe('Done: saved {"note":"x"}');
  expect(r.usage).toEqual({ inputTokens: 15, outputTokens: 7, cachedTokens: 5 });
  expect(t.calls).toHaveLength(1);
  const [seen] = fakeCliLog(log);
  expect(seen?.envKeys).toEqual([]);
  expect(seen?.tools).toEqual(["remember"]);
  const argv = seen?.args as string[];
  expect(argv).toContain('forced_login_method="chatgpt"');
  for (const off of ["shell_tool", "unified_exec", "view_image", "hooks", "apps", "plugins"])
    expect(argv).toContain(`features.${off}=false`);
  expect(argv).toContain('web_search="disabled"');
  expect(argv).toContain("--ignore-user-config");
  expect(argv).not.toContain("--ignore-rules");
  expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(argv.some((a) => a.startsWith("developer_instructions="))).toBe(true);
});

test("Codex: instructions large in bytes go in the prompt, not in argv (E2BIG)", async () => {
  const { harnesses, log } = setup("codex");
  const turn = { ...args("codex", "hi"), system: "ação\n".repeat(19_000) };
  expect(turn.system.length).toBeLessThan(100_000);
  const r = await harnesses.turn(agent, turn, io());
  expect(r.text).toBe("Hi from Codex.");
  const [seen] = fakeCliLog(log);
  const argv = (seen?.args ?? []) as string[];
  expect(argv).toContain("exec");
  expect(argv.some((a) => a.startsWith("developer_instructions="))).toBe(false);
  expect(String(seen?.prompt).startsWith(turn.system)).toBe(true);
});

test("a Codex with an API key does not open the turn", async () => {
  const { harnesses, log } = setup("codex", { codexLogin: "Logged in using an API key - sk-***" });
  const err = await harnesses.turn(agent, args("codex", "hi"), io()).catch((e) => e);
  expect((err as RunnerError).code).toBe("not_logged_in");
  expect(fakeCliLog(log)).toEqual([]);
});

test("canceling stops the process", async () => {
  const { harnesses } = setup("claude", { apiKeySource: "none" });
  const ctrl = new AbortController();
  const t = { ...io(), signal: ctrl.signal };
  ctrl.abort();
  const err = await harnesses.turn(agent, args("claude_code", "hi"), t).catch((e) => e);
  expect((err as RunnerError).code).toBe("canceled");
});

test("classifies the CLI errors", () => {
  expect(classifyHarnessError("You've hit your usage limit · resets 3pm").code).toBe("plan_limit");
  expect(classifyHarnessError("Invalid API key · Please run /login").code).toBe("not_logged_in");
  expect(classifyHarnessError("boom", true).code).toBe("not_logged_in");
  expect(classifyHarnessError("Something else").code).toBe("harness_failed");
});

test("a turn aborted while its sandbox opens does not start the CLI", async () => {
  const log = join(dir, `log-${++n}.jsonl`);
  const bin = fakeCliBin(dir, `claude-${n}`, { kind: "claude", log });
  const bins = { claude: bin, codex: "/bin/false" };
  const controller = new AbortController();
  // The sandbox the turn opens: the request is aborted while it opens (the connection dropped).
  const sandbox = {
    status: () => ({ state: "on" as const, engine: "bubblewrap" as const, reason: null }),
    wrap: async (input: { command: string }) => {
      controller.abort();
      return { command: input.command, blocked: () => [], release: () => {} };
    },
    close: async () => {},
  };
  const harnesses = new Harnesses({
    home: join(dir, "home"),
    access,
    bins,
    cli: new CliWatch({ bins, installed: ["claude_code"] }),
    bridge,
    mcpCommand: testMcpCommand(),
    sandbox,
    policy: signedInPolicy(join(dir, "home"), join(dir, "person")),
  });
  const err = await harnesses
    .turn(agent, args("claude_code", "hi"), { ...io(), signal: controller.signal })
    .catch((e) => e);
  expect(err instanceof RunnerError && err.code).toBe("canceled");
  expect(existsSync(log)).toBe(false);
});

test("duplicate turns own separate MCP files and canceled preparation preserves old files", async () => {
  const { harnesses } = setup("claude");
  const opts = Reflect.get(harnesses, "opts");
  let tokens = 0;
  opts.bridge = { path: "/unused", open: async () => ({ token: `token-${++tokens}`, close() {} }) };
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const reached = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let call = 0;
  Reflect.set(harnesses, "spawnTurn", async (input: { argv: string[] }) => {
    const index = call++;
    reached[index]?.resolve();
    await gates[index]?.promise;
    return { text: readFileSync(input.argv[input.argv.indexOf("--mcp-config") + 1] ?? "", "utf8") };
  });
  const turn = args("claude_code", "hi");
  const previous = join(opts.home, "harness", "turns", turn.runId, "keep");
  mkdirSync(join(opts.home, "harness", "turns", turn.runId), { recursive: true });
  writeFileSync(previous, "owned earlier");
  const first = harnesses.turn(agent, turn, io());
  await reached[0]?.promise;
  const second = harnesses.turn(agent, turn, io());
  await reached[1]?.promise;
  gates[0]?.resolve();
  const firstResult = await first;
  gates[1]?.resolve();
  const secondResult = await second;
  expect(firstResult.text).toContain("token-1");
  expect(secondResult.text).toContain("token-2");
  const controller = new AbortController();
  opts.bridge.open = async () => {
    controller.abort();
    return { token: "cancel", close() {} };
  };
  Reflect.deleteProperty(harnesses, "spawnTurn");
  await expect(harnesses.turn(agent, turn, { ...io(), signal: controller.signal })).rejects.toMatchObject({
    code: "canceled",
  });
  expect(readFileSync(previous, "utf8")).toBe("owned earlier");
});
