import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerFrame, runnerFrame } from "@vanr/engine/runner-protocol";
import { RunnerClient } from "./client";
import { Jobs } from "./jobs";
import { sandboxOff } from "./sandbox";

// What the client sends, on its real way out: the pieces of one text go through one flow (a secret split
// between two frames goes out in neither, and the tail goes before the last frame); a frame of no agent is
// masked with every agent's secrets; a hello never fails because of how many jobs wait.
const SECRET = "ABCD-SECRET";
const MASKS: [string, string][] = [[SECRET, "[secret:S]"]];
const agent = { id: "agt_0000000012345678", handle: "lia" };

function fakeClient(fields: Record<string, unknown>) {
  const sent: RunnerFrame[] = [];
  const c = Object.create(RunnerClient.prototype) as Record<string, unknown>;
  Object.assign(c, {
    ws: { readyState: WebSocket.OPEN, send: (s: string) => sent.push(JSON.parse(s)) },
    inflight: new Map(),
    knownMasks: new Map(),
    secrets: { masks: async () => MASKS },
    opts: { log: () => {} },
    ...fields,
  });
  const call = (name: string, ...args: unknown[]) =>
    (Reflect.get(c, name) as (...a: unknown[]) => unknown).call(c, ...args);
  return { c, sent, call };
}

test("a harness turn's text deltas go through one flow: the secret split in two deltas goes out in neither", async () => {
  const harnesses = {
    turn: async (_a: unknown, _args: unknown, io: { emit: (e: { kind: "text"; text: string }) => void }) => {
      for (const text of ["hi ", "ABCD-", "SECRET", " and ABCD-"]) io.emit({ kind: "text", text });
      return {
        text: `hi ${SECRET}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        model: SECRET,
      };
    },
  };
  const { sent, call } = fakeClient({ harnesses });
  await call("onRequest", {
    type: "request",
    id: "req_1",
    op: "harness.turn",
    agent,
    stream: true,
    args: { runId: "run_00001", executor: "claude_code", system: "", prompt: "p", tools: [] },
  });
  const texts = sent.flatMap((f) => (f.type === "harness.event" ? [f.event.text] : []));
  expect(texts.join("")).toBe("hi [secret:S] and ABCD-");
  for (const t of texts) expect(t.includes("SECRET") && t.includes("ABCD")).toBe(false);
  // The tail the flow held goes before the result, and the result's model is masked too.
  expect(sent.at(-2)?.type).toBe("harness.event");
  expect(sent.at(-1)).toMatchObject({ type: "result", ok: true, data: { model: "[secret:S]" } });
  for (const f of sent) expect(runnerFrame.safeParse(f).success).toBe(true);
});

test("a command's streamed output goes through one flow per stream, the tail before the result", async () => {
  const { c, sent, call } = fakeClient({});
  Reflect.set(
    c,
    "run",
    async (_op: string, _args: unknown, ctx: { onOutput: (s: string, chunk: string) => void }) => {
      for (const chunk of ["out ABCD-", "SECR", "ET done ABC"]) ctx.onOutput("stdout", chunk);
      ctx.onOutput("stderr", "ABCD-");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 1,
        blocked: [],
      };
    },
  );
  await call("onRequest", {
    type: "request",
    id: "req_1",
    op: "exec",
    agent,
    stream: true,
    args: { command: "x" },
  });
  const of = (stream: string) =>
    sent.flatMap((f) => (f.type === "output" && f.stream === stream ? [f.chunk] : [])).join("");
  expect(of("stdout")).toBe("out [secret:S] done ABC");
  expect(of("stderr")).toBe("ABCD-");
  expect(sent.at(-1)?.type).toBe("result");
});

test("a frame of no agent (cli.changed) is masked with the secrets of every agent known since the welcome", async () => {
  const cli = {
    states: () => ({ claude_code: { version: SECRET, login: "subscription", plan: SECRET } }),
  };
  const { sent, call } = fakeClient({ cli, hadWelcome: true, cliCheckedAt: 0, cliSent: "", agents: [agent] });
  await call("refreshMasks");
  call("recheckCli");
  expect(sent).toEqual([
    {
      type: "cli.changed",
      cli: { claude_code: { version: "[secret:S]", login: "subscription", plan: "[secret:S]" } },
    },
  ]);
});

test("a hello with more pending jobs than it can carry is valid; the rest goes as job.done after the welcome, in order", () => {
  const home = mkdtempSync(join(tmpdir(), "runner-hello-"));
  try {
    mkdirSync(join(home, "jobs"));
    const id = (i: number) => `job_${String(i).padStart(8, "0")}`;
    const journal = Array.from({ length: 201 }, (_, i) => ({
      jobId: id(i),
      status: "done",
      exitCode: 0,
      result: "ok",
      files: [],
      session: null,
      startedAt: null,
      endedAt: null,
      denied: [],
      blocked: [],
      agent,
      executor: "shell",
      delivered: false,
    }));
    writeFileSync(join(home, "jobs", "journal.json"), JSON.stringify(journal));
    let client: { call: (name: string, ...a: unknown[]) => unknown } | undefined;
    const jobs = new Jobs({
      home,
      send: (e: RunnerFrame) => client?.call("send", e),
    } as unknown as ConstructorParameters<typeof Jobs>[0]);
    const real = globalThis.WebSocket;
    const sent: RunnerFrame[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      send(s: string) {
        sent.push(JSON.parse(s));
      }
      close() {}
    }
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    try {
      const made = fakeClient({
        config: {
          server: "https://example.invalid",
          workDir: join(home, "ws"),
          paused: false,
          access: { folders: [], tools: { claude: true, codex: false, commands: true, browser: false } },
        },
        opts: { version: "1.0.0", log: () => {} },
        cli: { states: () => ({}) },
        jobs,
        executors: [],
        sandbox: sandboxOff(),
        heartbeatMs: 25_000,
      });
      client = made;
      made.call("openSocket", "fixture-session-1234");
      const ws = Reflect.get(made.c, "ws") as FakeSocket;
      ws.onopen?.();
      clearTimeout(Reflect.get(made.c, "watchdog") as ReturnType<typeof setTimeout>);
      const hello = sent[0];
      expect(runnerFrame.safeParse(hello).success).toBe(true);
      expect(hello?.type === "hello" && hello.jobs.length).toBe(200);
      jobs.redeliver();
      const done = sent.flatMap((f) => (f.type === "job.done" ? [f.job.jobId] : []));
      expect(done).toEqual(journal.map((j) => j.jobId));
    } finally {
      globalThis.WebSocket = real;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
