import { expect, test } from "bun:test";
import { RunnerError } from "./access";
import { CliWatch, cliEnv, reservedSecretName } from "./cli";

// The CLI only runs on the plan: the environment goes out without API keys, a secret with a reserved name
// does not get in and the login is checked before use.

test("the CLI environment goes out without API keys and without secrets with a reserved name", () => {
  const env = cliEnv(
    {
      secrets: { GITHUB_TOKEN: "g", ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "/x" },
      internal: { MCP_TOOL_TIMEOUT: "1000" },
    },
    {
      PATH: "/usr/bin",
      HOME: "/home/a",
      ANTHROPIC_API_KEY: "sk-1",
      ANTHROPIC_BASE_URL: "http://x",
      CLAUDE_CODE_USE_BEDROCK: "1",
      OPENAI_API_KEY: "sk-2",
      CODEX_API_KEY: "sk-3",
      AWS_BEARER_TOKEN_BEDROCK: "b",
      LANG: "pt_BR.UTF-8",
    },
  );
  expect(env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/a",
    LANG: "pt_BR.UTF-8",
    GITHUB_TOKEN: "g",
    MCP_TOOL_TIMEOUT: "1000",
  });
});

test("reserved names for secrets", () => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "VANR_MCP_TOKEN",
  ])
    expect([name, reservedSecretName(name)]).toEqual([name, true]);
  for (const name of ["GITHUB_TOKEN", "STRIPE_KEY", "DATABASE_URL"])
    expect([name, reservedSecretName(name)]).toEqual([name, false]);
});

type Reply = { status: number; stdout: string; stderr?: string };
function watch(
  replies: Record<string, Reply>,
  installed: ("claude_code" | "codex")[] = ["claude_code", "codex"],
) {
  const calls: string[] = [];
  let now = 0;
  const w = new CliWatch({
    bins: { claude: "claude", codex: "codex" },
    installed,
    now: () => now,
    run: (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      calls.push(key);
      return replies[key] ?? { status: 1, stdout: "" };
    },
  });
  return { w, calls, tick: (ms: number) => (now += ms), replies };
}

const ok = (stdout: string): Reply => ({ status: 0, stdout });
/** The real `codex login status` writes to stderr. */
const okErr = (stderr: string): Reply => ({ status: 0, stdout: "", stderr });

test("detects the login of each CLI", () => {
  const { w } = watch({
    "claude --version": ok("2.1.0 (Claude Code)\n"),
    "claude auth status --json": ok('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'),
    "codex --version": ok("codex-cli 0.162.0"),
    "codex login status": okErr("Logged in using ChatGPT"),
  });
  expect(w.states()).toEqual({
    claude_code: { version: "2.1.0 (Claude Code)", login: "subscription", plan: "max" },
    codex: { version: "codex-cli 0.162.0", login: "subscription", plan: "chatgpt" },
  });
});

test("an API key and no login become states of their own; a plan that is not installed is left out", () => {
  const { w } = watch({
    "claude --version": ok("2.1.0"),
    "claude auth status --json": ok('{"loggedIn":true,"authMethod":"api_key"}'),
    "codex --version": ok("codex-cli 0.162.0"),
    "codex login status": { status: 1, stdout: "", stderr: "Not logged in" },
  });
  expect(w.states().claude_code?.login).toBe("api_key");
  expect(w.states().codex?.login).toBe("none");
  const none = watch({}, ["claude_code"]);
  expect(none.w.states()).toEqual({});
});

test("requireSubscription: rejects a key and no login, and checks again before rejecting", () => {
  const { w, calls, replies } = watch({
    "claude --version": ok("2.1.0"),
    "claude auth status --json": ok('{"loggedIn":false,"authMethod":"none"}'),
    "codex --version": ok("codex-cli 0.162.0"),
    "codex login status": okErr("Logged in using an API key - sk-***"),
  });
  expect(() => w.requireSubscription("claude_code")).toThrow(RunnerError);
  expect(() => w.requireSubscription("codex")).toThrow(/API key/);
  // The person logged in to the plan: the next check already sees it, without waiting for the cache.
  replies["claude auth status --json"] = ok(
    '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}',
  );
  const before = calls.length;
  expect(w.requireSubscription("claude_code").plan).toBe("pro");
  expect(calls.length).toBeGreaterThan(before);
});

test("with the plan in the cache, it does not run the CLI again until it expires", () => {
  const { w, calls, tick } = watch(
    {
      "claude --version": ok("2.1.0"),
      "claude auth status --json": ok('{"loggedIn":true,"authMethod":"claude.ai"}'),
    },
    ["claude_code"],
  );
  w.requireSubscription("claude_code");
  const count = calls.length;
  w.requireSubscription("claude_code");
  expect(calls.length).toBe(count);
  tick(11 * 60_000);
  w.requireSubscription("claude_code");
  expect(calls.length).toBeGreaterThan(count);
});
