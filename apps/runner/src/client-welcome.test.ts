import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerFrame, runnerFrame, type ServerFrame, serverFrame } from "@vanr/engine/runner-protocol";
import type { BrowserDriver } from "./browser";
import { RunnerClient } from "./client";
import { writeConfig } from "./config";
import { sandboxOff } from "./sandbox";

// Nothing runs before the connection is authenticated: until the welcome of THAT connection only a welcome,
// a ping and a rejection are taken. A server that sends a write, a command or a browser request first gets
// the connection closed, on the first connection and on a reconnection alike, and nothing of it runs.
const dir = mkdtempSync(join(tmpdir(), "runner-welcome-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const agent = { id: "agt_0000000012345678", handle: "lia" };

test("a write, a command and a browser request before the welcome close the connection and never run", async () => {
  const work = join(dir, "work");
  const agentDir = join(work, `${agent.handle}-${agent.id.slice(-8)}`);
  const written = join(agentDir, "early.txt");
  const marker = join(dir, "exec-ran");
  const browserCalls: string[] = [];
  const browser: BrowserDriver = {
    handle: async (op) => {
      browserCalls.push(op);
      return {};
    },
    close: async () => {},
  };
  const sent: RunnerFrame[] = [];
  const closes: number[] = [];
  let connection = 0;
  let welcomes = 0;
  let readyHello: () => void = () => {};
  const secondEarlyClosed = new Promise<void>((r) => {
    readyHello = r;
  });
  const early = (n: number): ServerFrame[] => [
    { type: "ping", at: n },
    {
      type: "request",
      id: `req_w${n}`,
      op: "write",
      agent,
      stream: false,
      args: { path: "early.txt", content: "pwned" },
    },
    {
      type: "request",
      id: `req_e${n}`,
      op: "exec",
      agent,
      stream: false,
      args: { command: `touch ${marker}` },
    },
    {
      type: "request",
      id: `req_b${n}`,
      op: "browser.open",
      agent,
      stream: false,
      args: {
        url: "https://example.com",
        policy: { driver: "agent", level: "free", sites: [], privateRanges: [] },
      },
    },
  ];
  const welcome: ServerFrame = {
    type: "welcome",
    runnerId: "rnr_0000000000000001",
    name: "laptop",
    heartbeatMs: 25_000,
    storeKey: Buffer.alloc(32, 7).toString("base64"),
    agents: [{ ...agent, name: "Lia" }],
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/runners/session")
        return Response.json({ session: `rst_${"s".repeat(24)}`, credential: "rrt_rotated_0001" });
      if (path === "/api/v1/runners/connect" && srv.upgrade(req, { data: { n: ++connection } }))
        return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      data: {} as { n: number },
      message(ws, raw) {
        const frame = runnerFrame.parse(JSON.parse(String(raw)));
        sent.push(frame);
        if (frame.type !== "hello") return;
        // Connections 1 and 3 (the first one, and the one after the welcome made the runner reconnect with the
        // real hello) send the requests before the welcome; the others welcome at once.
        const n = ws.data.n;
        const frames = n === 1 || n === 3 ? [...early(n), welcome] : [welcome];
        for (const f of frames) ws.send(JSON.stringify(serverFrame.parse(f)));
        if (frames.length === 1) welcomes++;
      },
      close(ws, code) {
        closes.push(code);
        if (ws.data.n === 3) readyHello();
      },
    },
  });
  const home = join(dir, "home");
  writeConfig(home, {
    server: `http://127.0.0.1:${server.port}`,
    runnerId: "rnr_0000000000000001",
    name: "laptop",
    token: "rrt_initial_0001",
    workspaceId: "workspace_1",
    workspaceName: "Workspace",
    workDir: work,
    access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true } },
    paused: false,
    maxConcurrentJobs: 3,
    jobMaxSeconds: 3600,
    sandbox: false,
    autoUpdate: false,
  });
  const logs: string[] = [];
  const client = new RunnerClient({
    home,
    executors: [],
    bins: { claude: "/bin/false", codex: "/bin/false" },
    sandbox: sandboxOff(),
    browser,
    log: (l) => logs.push(l),
    backoffBaseMs: 10,
  });
  try {
    client.start();
    await secondEarlyClosed;
    await client.ready();
    // The runner closed both connections that spoke before the welcome (4001), and only those.
    expect(closes.slice(0, 1)).toEqual([4001]);
    expect(closes.filter((c) => c === 4001)).toHaveLength(2);
    expect(welcomes).toBeGreaterThanOrEqual(2);
    // Nothing ran: no file, no command, no browser call, no result for any early request.
    expect(existsSync(written)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(browserCalls).toEqual([]);
    expect(sent.filter((f) => f.type === "result")).toEqual([]);
    expect(logs.filter((l) => l.includes("before the welcome"))).toHaveLength(2);
  } finally {
    await client.stop();
    server.stop(true);
  }
});
