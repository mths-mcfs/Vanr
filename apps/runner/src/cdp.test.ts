import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserPolicy } from "@vanr/engine/browser-policy";
import type { AgentRef } from "@vanr/engine/runner-protocol";
import type { Access } from "./access";
import { CdpBrowser } from "./cdp";
import type { SecretStore } from "./secrets";

// Fake Chrome: prints the DevTools address and answers CDP; attaches the tab that already exists when the
// runner turns on auto-attach; with FAKE_ATTACH=fail it rejects auto-attach (startup fails after the
// process is born); with FAKE_SHOT=hang the screenshot
// never answers (what Chrome does when the tab switches midway); with FAKE_FRAMES=1 the page changes
// nonstop (a frame every 100 ms) and Chrome takes 800 ms to close.
const dir = mkdtempSync(join(tmpdir(), "cdp-test-"));
// Each fake Chrome writes its pid here when it starts. It is the process the runner spawned (the shell
// wrapper `exec`s into it) and it starts no children, so its pid is all there is to stop: no process group
// of its own (it shares the test's) and nothing found by name or path.
const pids = join(dir, "pids");
mkdirSync(pids);
const started = () => readdirSync(pids).map(Number);
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterAll(() => {
  // Also after a failed test: whatever fake Chrome is still running stops here.
  for (const pid of started().filter(running)) process.kill(pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});
const fake = join(dir, "fake-chrome.ts");
writeFileSync(
  fake,
  `require("node:fs").writeFileSync(${JSON.stringify(pids)} + "/" + process.pid, "");
const fail = process.env.FAKE_ATTACH === "fail";
const server = Bun.serve({
  port: 0,
  fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
  websocket: {
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      const reply = (body) => ws.send(JSON.stringify({ id: m.id, ...body }));
      if (m.method === "Target.setAutoAttach" && !m.sessionId) {
        if (fail) return reply({ error: { message: "Not allowed" } });
        reply({ result: {} });
        return ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S1",
          targetInfo: { targetId: "T1", type: "page", url: "about:blank", title: "" }, waitingForDebugger: false } }));
      }
      if (m.method === "Page.captureScreenshot" && process.env.FAKE_SHOT === "hang") return;
      if (m.method === "Page.startScreencast" && process.env.FAKE_FRAMES) {
        let n = 0;
        setInterval(() => ws.send(JSON.stringify({ method: "Page.screencastFrame", sessionId: m.sessionId,
          params: { data: "F" + n++, sessionId: n, metadata: { deviceWidth: 1280, deviceHeight: 800 } } })), 100);
      }
      if (m.method === "Browser.close" && process.env.FAKE_FRAMES) return setTimeout(() => reply({ result: {} }), 800);
      reply({ result: {} });
    },
  },
});
console.error("DevTools listening on ws://127.0.0.1:" + server.port + "/devtools/browser/x");
`,
);
const chrome = join(dir, "chrome");
writeFileSync(chrome, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
chmodSync(chrome, 0o755);

const agent: AgentRef = { id: "agt_0123456789abcdef", handle: "lia" };
const policy: BrowserPolicy = { driver: "agent", level: "free", sites: [], privateRanges: [] };
const alive = () => started().filter(running).length;
const browser = () =>
  new CdpBrowser({
    chrome,
    home: mkdtempSync(join(dir, "home-")),
    access: {} as Access,
    secrets: { values: async () => [] } as unknown as SecretStore,
  });

test("a Chrome that starts halfway dies, instead of holding on to the profile", async () => {
  process.env.FAKE_ATTACH = "fail";
  try {
    const b = browser();
    for (let i = 0; i < 3; i++)
      await expect(
        b.handle("browser.open", agent, { url: "http://x/", policy }, () => true),
      ).rejects.toThrow();
    await Bun.sleep(300);
    expect(alive()).toBe(0);
  } finally {
    delete process.env.FAKE_ATTACH;
  }
});

test("watching and opening at the same time wait for the same Chrome", async () => {
  const b = browser();
  const send = () => true;
  await Promise.all([
    b.handle("live_view.start", agent, { fps: 1, policy }, send),
    b.handle("live_view.start", agent, { fps: 1, policy }, send),
  ]);
  expect(alive()).toBe(1);
  await b.close();
  await Bun.sleep(300);
  expect(alive()).toBe(0);
});

test("the stream starts even if the first capture does not answer", async () => {
  process.env.FAKE_SHOT = "hang";
  try {
    const b = browser();
    const started = b.handle("live_view.start", agent, { fps: 1, policy }, () => true);
    const late = Bun.sleep(3000).then(() => "stuck");
    expect(await Promise.race([started, late])).toEqual({ streaming: true, fps: 1 });
    await b.close();
  } finally {
    delete process.env.FAKE_SHOT;
  }
});

test("no frame goes out after the stream ends, not even with Chrome slow to close", async () => {
  process.env.FAKE_FRAMES = "1";
  try {
    const b = browser();
    const out: string[] = [];
    const send = (f: { type: string }) => {
      out.push(f.type);
      return true;
    };
    await b.handle("live_view.start", agent, { fps: 1, policy }, send);
    await Bun.sleep(1200);
    await b.handle("browser.close", agent, {}, send);
    await Bun.sleep(1500);
    const ended = out.indexOf("live_view.stream_ended");
    expect(ended).toBeGreaterThan(0);
    expect(out.slice(ended + 1)).toEqual([]);
  } finally {
    delete process.env.FAKE_FRAMES;
  }
});
