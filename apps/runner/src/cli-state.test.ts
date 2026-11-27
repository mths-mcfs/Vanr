import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
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
  sandboxOff,
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
  const claude = executorCommand("claude_code", { prompt: "p", cwd: "/w", session: "s1" }, bins, "own").args;
  expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(claude.slice(-2)).toEqual(["--resume", "s1"]);
  const codex = executorCommand("codex", { prompt: "p", cwd: "/w" }, bins, "own").args;
  expect(codex).toContain("--ignore-user-config");
  expect(codex).toContain("--ignore-rules");
});

for (const executor of ["claude_code", "codex"] as const)
  test(`${executor}: sandbox off preserves the previous job and harness arguments`, async () => {
    const home = mkdtempSync(join(dir, "off-argv-"));
    const program = join(home, "argv.mjs");
    writeFileSync(
      program,
      `for await (const chunk of process.stdin) {}
const args = process.argv.slice(2), text = JSON.stringify(args);
const out = obj => console.log(JSON.stringify(obj));
if (args[0] === 'exec') {
  out({type:'item.completed',item:{type:'agent_message',text}});
  out({type:'turn.completed'});
} else out({type:'result',subtype:'success',result:text});`,
    );
    const bin = join(home, "fake-cli");
    writeFileSync(bin, `#!/bin/sh\nexec ${shellLine(process.execPath, [program])} "$@"\n`, { mode: 0o700 });
    const bins = { claude: bin, codex: bin };
    const cli = new CliWatch({
      bins,
      installed: [executor],
      run: (_bin, args) => ({
        status: 0,
        stdout:
          args[0] === "--version"
            ? "fake-cli 0.0.0"
            : executor === "codex"
              ? "Logged in using ChatGPT"
              : '{"loggedIn":true,"authMethod":"claude.ai"}',
      }),
    });
    const access = new Access(() => ({
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: false } },
      workDir: join(home, "work"),
      paused: false,
    }));
    const policy = { ...defaultPolicyContext(home), home: join(home, "person"), cliDirs: {} };
    const done = Promise.withResolvers<void>();
    const jobs = new Jobs({
      home,
      access,
      secrets: new SecretStore(home),
      cli,
      maxConcurrent: () => 1,
      maxSeconds: () => 10,
      send: (e) => {
        if (e.type === "job.done") done.resolve();
        return true;
      },
      bins,
      sandbox: sandboxOff(),
      policy,
    });
    await jobs.start(agent, {
      jobId: "job_off_args",
      executor,
      title: "t",
      prompt: "p",
      model: "test-model",
      session: "own-session",
    });
    await done.promise;
    const job = jobs.status("job_off_args");
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result ?? "null")).toEqual(
      executor === "claude_code"
        ? [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "acceptEdits",
            "--model",
            "test-model",
            "--resume",
            "own-session",
          ]
        : [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-C",
            access.agentRoot(agent),
            "--sandbox",
            "workspace-write",
            "-c",
            'forced_login_method="chatgpt"',
            "-m",
            "test-model",
            "resume",
            "own-session",
            "-",
          ],
    );
    // The fake CLI only returns argv; no MCP server is started.
    const bridge = new McpBridge(home);
    const open = spyOn(bridge, "open").mockResolvedValue({ token: "TEST", close: () => {} });
    try {
      const harnesses = new Harnesses({
        home,
        access,
        bins,
        cli,
        bridge,
        mcpCommand: ["/bin/true"],
        sandbox: sandboxOff(),
        policy,
      });
      const turn = await harnesses.turn(
        agent,
        { runId: "run_off_args", executor, system: "s", prompt: "p", tools: [] },
        {
          signal: new AbortController().signal,
          emit: () => {},
          callTool: async () => ({ content: "", isError: false }),
        },
      );
      const argv: string[] = JSON.parse(turn.text);
      expect(argv).not.toContain("--ignore-rules");
      if (executor === "codex") {
        expect(argv).toContain("--ignore-user-config");
        expect(argv).toContain('forced_login_method="chatgpt"');
        expect(argv).toContain("features.shell_tool=false");
        expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
      } else expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("local");
    } finally {
      open.mockRestore();
      bridge.close();
    }
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

  for (const { executor, layout } of (["claude_code", "codex"] as const).flatMap((executor) =>
    ["default", "relocated", "symlink"].map((layout) => ({ executor, layout })),
  ))
    test.if(on)(
      `${executor} ${layout}: nothing of the person's CLI folder is readable; the login is readable and not writable; the session writes and resumes in its own state`,
      async () => {
        const { home, files } = personHome(`real-${executor}-${layout}`);
        const ctx = { ...defaultPolicyContext(join(home, ".runner")), home, cliDirs: {} };
        const moved = join(dir, `outside-${executor}-${layout}`);
        const pathOf = (f: string) => join(layout === "default" || f === ".claude.json" ? home : moved, f);
        if (layout !== "default") {
          mkdirSync(moved);
          for (const [kind, folder] of [
            ["claude_code", ".claude"],
            ["codex", ".codex"],
          ] as const) {
            renameSync(join(home, folder), join(moved, folder));
            if (layout === "symlink") symlinkSync(join(moved, folder), join(home, folder));
            else ctx.cliDirs = { ...ctx.cliDirs, [kind]: join(moved, folder) };
          }
        }
        const cwd = mkdtempSync(join(dir, `cwd-${executor}-`));
        const personal = pathOf(executor === "codex" ? ".codex" : ".claude");
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
        const personalFiles = Object.keys(files).flatMap((f) => [join(home, f), pathOf(f)]);
        const otherState = agentCliStateDir(ctx, other, executor);
        mkdirSync(join(otherState, "sessions"), { recursive: true });
        writeFileSync(join(otherState, "sessions", "s1.jsonl"), "OTHER-AGENT-SESSION");
        const first = await session(
          [
            ...personalFiles.map((f) => `cat ${shellLine(f, [])} 2>/dev/null && echo "LEAK ${f}"`),
            `cat ${shellLine(join(otherState, "sessions", "s1.jsonl"), [])} 2>/dev/null`,
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
        expect(first.stdout).not.toContain("OTHER-AGENT-SESSION");
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
          expect(readFileSync(pathOf(f), "utf8")).toBe(content);
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
