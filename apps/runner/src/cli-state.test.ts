import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAccess } from "@vanr/contract";
import { Access, RunnerError } from "./access";
import { CliWatch } from "./cli";
import { Harnesses } from "./harness";
import { executorCommand, Jobs } from "./jobs";
import { McpBridge } from "./mcp";
import {
  agentCli,
  agentCliStateDir,
  defaultPolicyContext,
  type FsPolicy,
  fsPolicy,
  noLoginFile,
  shellLine,
} from "./sandbox";
import { SecretStore } from "./secrets";
import { fakeCliBin, testMcpCommand } from "./testing/fake-cli";
import { realSandbox } from "./testing/sandbox";

// The CLI folders are the person's: a session an agent runs (harness or job) keeps its own state in the
// runner folder, never mounts the person's Claude Code or Codex folder (not even for reading), and gets the
// person's login alone and read-only, at the name the CLI looks for. With made-up data and the real sandbox.
const dir = mkdtempSync(join(tmpdir(), "runner-cli-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const agent = { id: "agt_0000000087654321", handle: "lia" };
const other = { id: "agt_0000000011112222", handle: "max" };

/** A person's home with both CLIs signed in and their own data in each. */
function personHome(name: string) {
  const home = join(dir, name);
  const files: Record<string, string> = {
    ".claude/.credentials.json": "CLAUDE-LOGIN",
    ".claude/history.jsonl": "PERSON-HISTORY",
    ".claude/settings.json": '{"hooks":{"Stop":[{"command":"PERSON-HOOK"}]}}',
    ".claude/CLAUDE.md": "PERSON-INSTRUCTIONS",
    ".claude/plans/plan.md": "PERSON-PLAN",
    ".claude/projects/-work/memory/MEMORY.md": "PERSON-MEMORY",
    ".claude.json": '{"mcpServers":{"person":{}}}',
    ".codex/auth.json": "CODEX-LOGIN",
    ".codex/config.toml": "PERSON-CONFIG",
    ".codex/AGENTS.md": "PERSON-AGENTS",
    ".codex/history.jsonl": "PERSON-CODEX-HISTORY",
    ".codex/sessions/2026/old.jsonl": "PERSON-SESSION",
    ".codex/memories_1.sqlite": "PERSON-MEMORY-DB",
  };
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(join(home, f, ".."), { recursive: true });
    writeFileSync(join(home, f), content);
  }
  return { home, files };
}

/** The same home, with the CLIs signed in through the system keychain: no login file anywhere. */
function keychainHome(name: string) {
  const person = personHome(name);
  for (const f of [".claude/.credentials.json", ".codex/auth.json"]) {
    rmSync(join(person.home, f));
    delete person.files[f];
  }
  return person;
}

/** Every name and content under the person's CLI folders, to compare before and after. */
function snapshot(home: string) {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(p, "utf8");
    }
  };
  for (const d of [".claude", ".codex"]) walk(join(home, d));
  out[join(home, ".claude.json")] = readFileSync(join(home, ".claude.json"), "utf8");
  return out;
}

test("sandbox on and no login file (keychain, or not signed in): not_logged_in before anything, for both CLIs", () => {
  const { home } = keychainHome("keychain-home");
  const ctx = { ...defaultPolicyContext(join(home, ".runner")), home, cliDirs: {} };
  for (const executor of ["claude_code", "codex"] as const) {
    let err: unknown = null;
    try {
      agentCli(executor, ctx, null, agent, null, true).release();
    } catch (e) {
      err = e;
    }
    if (!(err instanceof RunnerError)) throw new Error(`expected a RunnerError, got ${String(err)}`);
    expect(err.code).toBe("not_logged_in");
    expect(err.message).toBe(noLoginFile(executor));
    expect(err.message).toContain("outside a file");
  }
  // Nothing was prepared for the session: no state folder, no link.
  expect(existsSync(join(home, ".runner", "cli"))).toBe(false);
});

test("sandbox turned off by the person: the CLI keeps the previous rules, in the person's folder", () => {
  for (const person of [personHome("sandbox-off-home"), keychainHome("sandbox-off-keychain")]) {
    const ctx = { ...defaultPolicyContext(join(person.home, ".runner")), home: person.home, cliDirs: {} };
    const off = agentCli("codex", ctx, null, agent, null, false);
    expect(off.kind).toBe("personal");
    expect(off.env).toEqual({});
    expect(off.write).toEqual([join(person.home, ".codex")]);
    const claude = agentCli("claude_code", ctx, null, agent, null, false);
    expect(claude.kind).toBe("personal");
    expect(claude.write).toEqual([join(person.home, ".claude")]);
  }
});

test("each agent and each CLI has its own state, outside the work folder and the person's CLI folder", () => {
  const { home } = personHome("state-home");
  const ctx = { ...defaultPolicyContext(join(home, ".runner")), home, cliDirs: {} };
  const a = agentCli("claude_code", ctx, null, agent, null, true);
  const b = agentCli("claude_code", ctx, null, other, null, true);
  const c = agentCli("codex", ctx, null, agent, null, true);
  try {
    expect(a.kind).toBe("own");
    expect(a.env).toEqual({ CLAUDE_CONFIG_DIR: agentCliStateDir(ctx, agent, "claude_code") });
    expect(c.env).toEqual({ CODEX_HOME: agentCliStateDir(ctx, agent, "codex") });
    expect(new Set([a.env.CLAUDE_CONFIG_DIR, b.env.CLAUDE_CONFIG_DIR, c.env.CODEX_HOME]).size).toBe(3);
    for (const box of [a, b, c]) {
      const state = Object.values(box.env)[0] as string;
      expect(state.startsWith(join(home, ".runner", "cli"))).toBe(true);
      expect(box.read.concat(box.write).some((p) => p.includes(".claude") || p.includes(".codex"))).toBe(
        false,
      );
    }
  } finally {
    for (const box of [a, b, c]) box.release();
  }
  // The login link goes away with its last session.
  expect(existsSync(join(agentCliStateDir(ctx, agent, "claude_code"), ".credentials.json"))).toBe(false);
  expect(readFileSync(join(home, ".claude", ".credentials.json"), "utf8")).toBe("CLAUDE-LOGIN");
});

test("a job leaves out the person's CLI configuration, rules and instructions, like the harness", () => {
  const bins = { claude: "claude", codex: "codex" };
  const claude = executorCommand("claude_code", { prompt: "p", cwd: "/w", session: "s1" }, bins).args;
  expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(claude.slice(-2)).toEqual(["--resume", "s1"]);
  const codex = executorCommand("codex", { prompt: "p", cwd: "/w" }, bins).args;
  expect(codex).toContain("--ignore-user-config");
  expect(codex).toContain("--ignore-rules");
});

describe("real srt", async () => {
  const sandbox = await realSandbox();
  const on = sandbox.status().state === "on";

  const runIn = async (fs: FsPolicy, command: string, cwd: string, env: Record<string, string>) => {
    const w = await sandbox.wrap({ command, fs, domains: [], mode: "off" });
    try {
      return await new Promise<{ stdout: string; stderr: string }>((done) => {
        const child = spawn("/bin/sh", ["-c", w.command], {
          cwd,
          env: { ...process.env, ...env, LC_ALL: "C" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (s: string) => {
          stdout += s;
        });
        child.stderr.setEncoding("utf8").on("data", (s: string) => {
          stderr += s;
        });
        child.on("close", () => done({ stdout, stderr }));
      });
    } finally {
      w.release();
    }
  };

  test.if(on)(
    "keychain login: a harness turn and a job end in not_logged_in, the CLI never starts, the person's folder stays as it was",
    async () => {
      const { home } = keychainHome("real-keychain");
      const runnerHome = join(home, ".runner");
      const policy = { ...defaultPolicyContext(runnerHome), home, cliDirs: {} };
      const before = snapshot(home);
      const log = join(dir, "keychain-cli-log.jsonl");
      // The CLI says it is signed in (through the keychain): only the missing file stops the session.
      const bin = fakeCliBin(dir, "claude-keychain", { kind: "claude", log, probe: [join(home, ".claude")] });
      const bins = { claude: bin, codex: "/bin/false" };
      const tools = { claude: true, codex: true, commands: true, browser: false };
      const access = new Access(() => ({
        access: { folders: [], tools } as RunnerAccess,
        workDir: join(dir, "keychain-ws"),
        paused: false,
      }));
      const cli = new CliWatch({ bins, installed: ["claude_code"] });
      const bridge = new McpBridge(runnerHome);
      const codeOf = (p: Promise<unknown>) =>
        p.then(
          () => "started",
          (e: unknown) => (e instanceof RunnerError ? `${e.code}: ${e.message}` : String(e)),
        );
      try {
        const harnesses = new Harnesses({
          home: runnerHome,
          access,
          bins,
          cli,
          bridge,
          mcpCommand: testMcpCommand(),
          sandbox,
          policy,
        });
        const turn = await codeOf(
          harnesses.turn(
            agent,
            { runId: "run_keychain_01", executor: "claude_code", system: "s", prompt: "p", tools: [] },
            {
              signal: new AbortController().signal,
              emit: () => {},
              callTool: async () => ({ content: "", isError: false }),
            },
          ),
        );
        expect(turn).toBe(`not_logged_in: ${noLoginFile("claude_code")}`);
        const jobs = new Jobs({
          home: runnerHome,
          access,
          secrets: new SecretStore(runnerHome),
          cli,
          maxConcurrent: () => 1,
          maxSeconds: () => 30,
          send: () => true,
          bins,
          sandbox,
          policy,
        });
        const job = await codeOf(
          jobs.start(agent, { jobId: "job_keychain1", executor: "claude_code", title: "t", prompt: "p" }),
        );
        expect(job).toBe(`not_logged_in: ${noLoginFile("claude_code")}`);
        expect(jobs.runningCount()).toBe(0);
      } finally {
        bridge.close();
      }
      // The CLI never ran (it logs every session), and nothing of the person changed or appeared.
      expect(existsSync(log)).toBe(false);
      expect(snapshot(home)).toEqual(before);
      expect(existsSync(join(runnerHome, "cli"))).toBe(false);
    },
  );

  for (const executor of ["claude_code", "codex"] as const)
    test.if(on)(
      `${executor}: nothing of the person's CLI folder is readable; the login is readable and not writable; the session writes and resumes in its own state`,
      async () => {
        const { home, files } = personHome(`real-${executor}`);
        const ctx = { ...defaultPolicyContext(join(home, ".runner")), home, cliDirs: {} };
        const cwd = mkdtempSync(join(dir, `cwd-${executor}-`));
        const personal = join(home, executor === "codex" ? ".codex" : ".claude");
        const login = executor === "codex" ? "auth.json" : ".credentials.json";
        const loginText = executor === "codex" ? "CODEX-LOGIN" : "CLAUDE-LOGIN";
        const session = async (command: string) => {
          const cli = agentCli(executor, ctx, null, agent, cwd, true);
          try {
            expect(cli.kind).toBe("own");
            const { unchecked: _, ...fs } = fsPolicy(ctx, {
              readable: [cwd, ...cli.read],
              writable: [cwd, ...cli.write],
              denyRead: cli.denyRead,
              denyWrite: cli.denyWrite,
              runnerInner: { read: [], write: cli.innerWrite },
            });
            return await runIn(fs, command, cwd, cli.env);
          } finally {
            cli.release();
          }
        };
        const state = agentCliStateDir(ctx, agent, executor);
        const personalFiles = Object.keys(files).map((f) => join(home, f));
        const first = await session(
          [
            ...personalFiles.map((f) => `cat ${shellLine(f, [])} 2>/dev/null && echo "LEAK ${f}"`),
            `ls -A ${shellLine(personal, [])} 2>/dev/null | sed 's/^/LISTED /'`,
            `STATE="$${executor === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}"`,
            `echo "STATE=$STATE"`,
            `cat "$STATE/${login}"; echo`,
            `echo stolen >> "$STATE/${login}" 2>/dev/null && echo WROTE-LOGIN`,
            `echo new > "$STATE/new" && mv "$STATE/new" "$STATE/${login}" 2>/dev/null && echo REPLACED-LOGIN`,
            `rm -f "$STATE/${login}" 2>/dev/null; test -e "$STATE/${login}" || echo REMOVED-LOGIN`,
            `mkdir -p "$STATE/sessions" && echo SESSION-ONE > "$STATE/sessions/s1.jsonl" && echo SAVED`,
            "echo END",
          ].join("; "),
        );
        expect(first.stdout).toContain("END");
        expect(first.stdout).toContain(`STATE=${state}`);
        // Nothing of the person's folder shows up, not even its names.
        expect(first.stdout).not.toContain("LEAK");
        expect(first.stdout).not.toContain("LISTED");
        for (const text of Object.values(files).filter((t) => t !== loginText))
          expect(first.stdout).not.toContain(text);
        // The login is there, read-only: no write, no replacement, no removal.
        expect(first.stdout).toContain(loginText);
        expect(first.stdout).not.toContain("WROTE-LOGIN");
        expect(first.stdout).not.toContain("REPLACED-LOGIN");
        expect(first.stdout).not.toContain("REMOVED-LOGIN");
        expect(first.stdout).toContain("SAVED");
        // The next session resumes from the same state.
        const second = await session(
          `cat "$${executor === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}/sessions/s1.jsonl"; echo END`,
        );
        expect(second.stdout).toContain("SESSION-ONE");
        // The person's files are as they were, and nothing new appeared in their folder.
        for (const [f, content] of Object.entries(files))
          expect(readFileSync(join(home, f), "utf8")).toBe(content);
        expect(readdirSync(personal).sort()).toEqual(
          Object.keys(files)
            .filter((f) => f.startsWith(executor === "codex" ? ".codex/" : ".claude/"))
            .map((f) => f.split("/")[1] as string)
            .filter((v, i, a) => a.indexOf(v) === i)
            .sort(),
        );
        expect(readFileSync(join(state, "sessions", "s1.jsonl"), "utf8")).toBe("SESSION-ONE\n");
      },
    );
});
