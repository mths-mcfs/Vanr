import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserPolicy } from "@vanr/engine/browser-policy";
import { type RunnerFrame, runnerFrame, type ServerFrame, serverFrame } from "@vanr/engine/runner-protocol";
import type { Access } from "./access";
import { CdpBrowser } from "./cdp";
import { CliWatch } from "./cli";
import { RunnerClient } from "./client";
import { writeConfig } from "./config";
import { sandboxOff } from "./sandbox";
import type { SecretStore } from "./secrets";
import { fakeCliBin, testMcpCommand } from "./testing/fake-cli";

// Both ends speak the same protocol: a fake server drives a real RunnerClient through every op and every
// frame type the server can send. Each frame the runner sends must pass the engine's `runnerFrame` schema
// (the one the server validates with), and the runner must accept every `serverFrame` the server sends
// (it logs the frames it does not understand).
const dir = mkdtempSync(join(tmpdir(), "runner-protocol-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Fake Chrome (never a real browser): answers every CDP command, attaches its tab on auto-attach and,
// once the screencast starts, sends a frame every 100 ms.
const fakeChrome = join(dir, "fake-chrome.ts");
writeFileSync(
  fakeChrome,
  `const server = Bun.serve({
  port: 0,
  fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
  websocket: {
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      ws.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === "Target.setAutoAttach" && !m.sessionId)
        ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S1",
          targetInfo: { targetId: "T1", type: "page", url: "about:blank", title: "" }, waitingForDebugger: false } }));
      if (m.method === "Page.startScreencast")
        setInterval(() => ws.send(JSON.stringify({ method: "Page.screencastFrame", sessionId: m.sessionId,
          params: { data: "F", sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } } })), 100);
    },
  },
});
console.error("DevTools listening on ws://127.0.0.1:" + server.port + "/devtools/browser/x");
`,
);
const chrome = join(dir, "chrome");
writeFileSync(chrome, `#!/bin/sh\nexec "${process.execPath}" "${fakeChrome}" "$@"\n`);
chmodSync(chrome, 0o755);

const agent = { id: "agt_0000000012345678", handle: "lia" };
const policy: BrowserPolicy = { driver: "agent", level: "free", sites: [], privateRanges: [] };

test("every frame the runner sends passes the engine schema, and the runner accepts every server frame", async () => {
  const sent: RunnerFrame[] = [];
  const invalid: { frame: unknown; issue: string }[] = [];
  const results = new Map<string, (frame: RunnerFrame) => void>();
  const waiters: { match: (f: RunnerFrame) => boolean; done: (f: RunnerFrame) => void }[] = [];
  let socket: { send: (data: string) => void } | null = null;
  let hello: () => void = () => {};
  const helloSeen = new Promise<void>((r) => {
    hello = r;
  });
  const push = (frame: ServerFrame) => {
    // The server side of the contract: what goes out is a valid `serverFrame`.
    serverFrame.parse(frame);
    socket?.send(JSON.stringify(frame));
  };
  const next = (match: (f: RunnerFrame) => boolean) =>
    new Promise<RunnerFrame>((done) => waiters.push({ match, done }));

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/runners/session")
        return Response.json({ session: "s".repeat(24), credential: "cred_rotated_0001" });
      if (path === "/api/v1/runners/connect" && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(_ws, raw) {
        const data: unknown = JSON.parse(String(raw));
        const parsed = runnerFrame.safeParse(data);
        if (!parsed.success) {
          invalid.push({ frame: data, issue: parsed.error.issues[0]?.message ?? "" });
          return;
        }
        const frame = parsed.data;
        sent.push(frame);
        if (frame.type === "hello") hello();
        if (frame.type === "result") results.get(frame.id)?.(frame);
        for (const w of waiters.splice(0)) {
          if (w.match(frame)) w.done(frame);
          else waiters.push(w);
        }
      },
    },
  });

  const home = join(dir, "home");
  const config = {
    server: `http://127.0.0.1:${server.port}`,
    runnerId: "rnr_0000000000000001",
    name: "laptop",
    token: "cred_initial_0001",
    workspaceId: "wsp_1",
    workspaceName: "Workspace",
    workDir: join(dir, "work"),
    access: { folders: [], tools: { claude: true, codex: false, commands: true, browser: true } },
    paused: false,
    maxConcurrentJobs: 3,
    jobMaxSeconds: 3600,
    sandbox: false,
    autoUpdate: false,
  };
  writeConfig(home, config);
  const claude = fakeCliBin(dir, "claude", { kind: "claude", log: join(dir, "cli-log.jsonl") });
  const logs: string[] = [];
  const client = new RunnerClient({
    home,
    executors: ["claude_code"],
    bins: { claude, codex: "/bin/false" },
    mcpCommand: testMcpCommand(),
    sandbox: sandboxOff(),
    browser: new CdpBrowser({
      chrome,
      home: join(dir, "browser-home"),
      access: {} as Access,
      secrets: { values: async () => [] } as unknown as SecretStore,
    }),
    log: (l) => logs.push(l),
  });
  let seq = 0;
  const ask = (op: string, args: Record<string, unknown>, stream = false) => {
    const id = `req_${++seq}`;
    const answer = new Promise<RunnerFrame>((done) => results.set(id, done));
    push({ type: "request", id, op, agent, stream, args });
    return answer;
  };
  const ok = async (op: string, args: Record<string, unknown>, stream = false) => {
    const r = await ask(op, args, stream);
    expect([op, r.type === "result" && r.ok]).toEqual([op, true]);
    return r;
  };

  try {
    client.start();
    await helloSeen;
    push({
      type: "welcome",
      runnerId: config.runnerId,
      name: "laptop",
      heartbeatMs: 25_000,
      storeKey: Buffer.alloc(32, 7).toString("base64"),
      agents: [{ ...agent, name: "Lia" }],
    });
    await client.ready();
    push({ type: "agents", agents: [{ ...agent, name: "Lia" }] });
    push({ type: "ping", at: 1 });
    await next((f) => f.type === "pong");

    await ok("exec", { command: "echo hi" }, true);
    await ok("write", { path: "a.txt", content: "x" });
    await ok("read", { path: "a.txt" });
    await ok("list", { path: "." });
    const done = next((f) => f.type === "job.done");
    await ok("job.start", { jobId: "job_00000001", executor: "shell", title: "t", prompt: "echo done" });
    await done;
    push({ type: "job.ack", jobId: "job_00000001" });
    await ok("job.status", { jobId: "job_00000001" });
    await ok("job.output", { jobId: "job_00000001" });
    await ok("job.cancel", { jobId: "job_00000001" });
    await ok("secret.prepare", { requestId: "sreq_1" });
    await ok("secret.list", {});
    await ok("secret.remove", { name: "NOPE" });
    await ok("access.reduce", { disableTool: "codex" });

    // A harness turn: the fake CLI calls the agent tool, the server answers it.
    const tool = next((f) => f.type === "harness.tool");
    const turn = ask("harness.turn", {
      runId: "run_00000001",
      executor: "claude_code",
      system: "You are Lia.",
      prompt: '[[call:remember {"note":"hi"}]]',
      tools: [{ name: "remember", description: "Saves a note", inputSchema: { type: "object" } }],
    });
    const call = await tool;
    if (call.type !== "harness.tool") throw new Error("expected harness.tool");
    push({ type: "harness.tool_result", id: call.id, callId: call.callId, content: "saved", isError: false });
    const answered = await turn;
    expect(answered.type === "result" && answered.ok).toBe(true);

    // The live view of the fake Chrome: frames, then the end of the stream.
    const frame = next((f) => f.type === "live_view.frame");
    await ok("live_view.start", { fps: 15, policy });
    await frame;
    const ended = next((f) => f.type === "live_view.stream_ended");
    await ok("browser.close", {});
    await ended;

    // The person pauses the runner from its CLI (the config on disk): `runner.state`.
    const paused = next((f) => f.type === "runner.state");
    writeConfig(home, { ...config, paused: true, token: "cred_rotated_0001" });
    await paused;

    // Errors are protocol frames too.
    const unknown = await ask("nope", {});
    expect(unknown.type === "result" && !unknown.ok && unknown.error.code).toBe("bad_request");
    push({ type: "cancel", id: "req_none" });
    push({ type: "rejected", reason: "revoked", message: "bye" });
    expect(await client.exited).toBe("revoked");
  } finally {
    await client.stop();
    server.stop(true);
  }

  expect(invalid).toEqual([]);
  expect(logs.filter((l) => l.includes("does not understand"))).toEqual([]);
  const types = new Set(sent.map((f) => (f.type === "result" ? `result.${f.ok}` : f.type)));
  expect([...types].sort()).toEqual(
    [
      "access.changed",
      // The first hello of a process goes before any mask is read: the CLI states follow the welcome.
      "cli.changed",
      "harness.event",
      "harness.tool",
      "hello",
      "job.done",
      "job.event",
      "live_view.frame",
      "live_view.stream_ended",
      "output",
      "pong",
      "result.false",
      "result.true",
      "runner.state",
    ].sort(),
  );
}, 60_000);

test("the frames built outside the request loop pass the schema too", () => {
  // `cli.changed` goes out every 10 minutes and `sandbox.changed` when the person flips the sandbox; their
  // payloads come from the same producers the client uses.
  const cli = new CliWatch({
    bins: { claude: "claude", codex: "codex" },
    installed: ["claude_code", "codex"],
    run: (cmd, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: `${cmd} 1.0.0` }
        : cmd === "claude"
          ? { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' }
          : { status: 0, stdout: "", stderr: "Logged in using ChatGPT" },
  });
  const frames: RunnerFrame[] = [
    { type: "cli.changed", cli: cli.states() },
    { type: "sandbox.changed", sandbox: sandboxOff().status() },
  ];
  for (const f of frames) expect(runnerFrame.safeParse(f).success).toBe(true);
});
