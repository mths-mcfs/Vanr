// The runner hub on real runner sockets: a Bun server registers each connection under its runner id, and
// the test plays the runner, reading the `request` frames and answering through the hub.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { MAX_INFLIGHT } from "@vanr/engine/runner-protocol";
import { RunnerCallError, RunnerHub, type RunnerSocket, type RunnerSocketData } from "./hub";

let hub = new RunnerHub();
const sockets = new Map<string, RunnerSocket>();
let server: ReturnType<typeof Bun.serve<RunnerSocketData>>;

beforeAll(() => {
  server = Bun.serve<RunnerSocketData>({
    port: 0,
    fetch(req, srv) {
      const runnerId = new URL(req.url).searchParams.get("r");
      const data: RunnerSocketData = {
        kind: "runner",
        runnerId,
        workspaceId: "w1",
        lastFrameAt: 0,
        helloTimer: null,
        pingTimer: null,
      };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        if (!ws.data.runnerId) return;
        const previous = hub.register(ws.data.runnerId, ws);
        previous?.close(4000, "replaced");
        sockets.set(ws.data.runnerId, ws);
      },
      message() {},
      close(ws) {
        hub.unregister(ws);
      },
    },
  });
});
afterAll(() => server.stop(true));

interface Frame {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** The runner's end: every frame the server sent, and a way to wait for the next ones. */
async function runner(id: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/?r=${id}`);
  const frames: Frame[] = [];
  ws.addEventListener("message", (ev) => frames.push(JSON.parse(String(ev.data))));
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (ev) => resolve(ev.code)));
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  while (!hub.isOnline(id) || sockets.get(id)?.readyState !== 1) await Bun.sleep(1);
  const until = async (n: number) => {
    const deadline = Date.now() + 2000;
    while (frames.length < n) {
      if (Date.now() > deadline) throw new Error(`expected ${n} frames, got ${frames.length}`);
      await Bun.sleep(2);
    }
    return frames;
  };
  return { ws, frames, closed, until };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof RunnerCallError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected RunnerCallError");
};

describe("runner hub", () => {
  test("cancellation before or immediately after call never reaches the runner", async () => {
    const r = await runner("canceled");
    try {
      for (const immediate of [false, true]) {
        const abort = new AbortController();
        if (!immediate) abort.abort();
        const call = failure(
          hub.call("canceled", "write", { path: "x", content: "x" }, { signal: abort.signal, timeoutMs: 20 }),
        );
        abort.abort();
        expect(await call).toMatchObject({ code: "canceled" });
      }
      expect(r.frames).toEqual([]);
    } finally {
      r.ws.close();
    }
  });

  test("a call goes out as a request and resolves with the runner's result; output streams to the caller", async () => {
    const r = await runner("r1");
    const chunks: string[] = [];
    const call = hub.call<"exec", { exitCode: number }>(
      "r1",
      "exec",
      { command: "ls" },
      { agent: { id: "a1", handle: "lia" }, onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`) },
    );
    const [request] = await r.until(1);
    expect(request).toMatchObject({
      type: "request",
      op: "exec",
      agent: { id: "a1", handle: "lia" },
      stream: true,
      args: { command: "ls" },
    });
    const id = request?.id ?? "";
    hub.onOutput({ id, stream: "stdout", chunk: "file.txt\n" });
    hub.onResult({ id, ok: true, data: { exitCode: 0 } });
    expect(await call).toEqual({ exitCode: 0 });
    expect(chunks).toEqual(["stdout:file.txt\n"]);
    // A late result for a request already settled changes nothing.
    hub.onResult({ id, ok: false, error: { code: "internal", message: "late" } });
    r.ws.close();
  });

  test("the runner's error comes back with its code", async () => {
    const r = await runner("r2");
    const call = failure(hub.call("r2", "read", { path: "/etc/shadow" }));
    const [request] = await r.until(1);
    hub.onResult({ id: request?.id ?? "", ok: false, error: { code: "outside_work_dir", message: "no" } });
    expect(await call).toEqual({ code: "outside_work_dir", message: "no" });
    r.ws.close();
  });

  test("an offline runner fails at once; one that drops fails what was pending", async () => {
    expect(await failure(hub.call("nobody", "list", { path: "." }))).toEqual({
      code: "offline",
      message: "The runner is offline",
    });
    const r = await runner("r3");
    const call = failure(hub.call("r3", "list", { path: "." }));
    await r.until(1);
    r.ws.close();
    expect(await call).toEqual({ code: "offline", message: "The runner went offline" });
    expect(hub.isOnline("r3")).toBe(false);
  });

  test("a runner that reconnects replaces the old connection and fails its pending calls", async () => {
    const old = await runner("r4");
    const call = failure(hub.call("r4", "list", { path: "." }));
    await old.until(1);
    const fresh = await runner("r4");
    expect(await call).toEqual({ code: "offline", message: "The runner reconnected" });
    expect(await old.closed).toBe(4000);
    // The old socket closing doesn't take the new one offline.
    expect(hub.isOnline("r4")).toBe(true);
    expect(hub.online()).toContain("r4");
    fresh.ws.close();
  });

  test("without an answer in time the call fails with timeout and the runner gets a cancel", async () => {
    const r = await runner("r5");
    const call = failure(hub.call("r5", "list", { path: "." }, { timeoutMs: 50 }));
    const [request] = await r.until(1);
    expect(await call).toEqual({ code: "timeout", message: "The runner did not answer in time" });
    const frames = await r.until(2);
    expect(frames[1]).toEqual({ type: "cancel", id: request?.id ?? "" });
    r.ws.close();
  });

  test(`at most ${MAX_INFLIGHT} requests at a time per runner; the next waits for a slot`, async () => {
    const r = await runner("r6");
    const calls = Array.from({ length: MAX_INFLIGHT + 1 }, (_, i) =>
      hub.call("r6", "list", { path: String(i) }),
    );
    const first = await r.until(MAX_INFLIGHT);
    await Bun.sleep(30);
    expect(r.frames).toHaveLength(MAX_INFLIGHT);
    hub.onResult({ id: first[0]?.id ?? "", ok: true, data: "done 0" });
    const all = await r.until(MAX_INFLIGHT + 1);
    expect(all[MAX_INFLIGHT]).toMatchObject({ type: "request", args: { path: String(MAX_INFLIGHT) } });
    for (const f of all.slice(1)) hub.onResult({ id: f.id, ok: true, data: `done ${f.id}` });
    expect(await calls[0]).toBe("done 0");
    await Promise.all(calls);
    r.ws.close();
  });

  test("a call waiting for a slot that is aborted fails with canceled and never reaches the runner", async () => {
    const r = await runner("r7");
    const busy = Array.from({ length: MAX_INFLIGHT }, () => hub.call("r7", "list", { path: "." }));
    await r.until(MAX_INFLIGHT);
    const abort = new AbortController();
    const waiting = hub.call("r7", "list", { path: "waiting" }, { signal: abort.signal });
    abort.abort();
    expect(await failure(waiting)).toEqual({ code: "canceled", message: "Canceled" });
    for (const f of r.frames) hub.onResult({ id: f.id, ok: true, data: null });
    await Promise.all(busy);
    await Bun.sleep(30);
    expect(r.frames.filter((f) => (f.args as { path?: string }).path === "waiting")).toEqual([]);
    r.ws.close();
  });

  test("a harness tool call is answered to the runner serving the turn, and only to it", async () => {
    const r = await runner("r8");
    const other = await runner("r9");
    const events: unknown[] = [];
    const turn = {
      runId: "run_12345678",
      executor: "claude_code" as const,
      system: "",
      prompt: "hi",
      tools: [],
    };
    const call = hub.call("r8", "harness.turn", turn, {
      onHarnessEvent: (e) => events.push(e),
      onHarnessTool: async (name, input) => ({ content: `${name}:${JSON.stringify(input)}`, isError: false }),
    });
    const [request] = await r.until(1);
    const id = request?.id ?? "";
    // Another runner naming this request gets the "turn is over" answer, not the handler.
    hub.onHarnessTool("r9", { id, callId: "x", name: "read", input: {} });
    hub.onHarnessEvent("r9", { id, event: { kind: "text", text: "spoofed" } });
    const [spoofed] = await other.until(1);
    expect(spoofed).toEqual({
      type: "harness.tool_result",
      id,
      callId: "x",
      content: "This turn is over",
      isError: true,
    });
    hub.onHarnessTool("r8", { id, callId: "c1", name: "search", input: { q: "a" } });
    const frames = await r.until(2);
    expect(frames[1]).toEqual({
      type: "harness.tool_result",
      id,
      callId: "c1",
      content: 'search:{"q":"a"}',
      isError: false,
    });
    hub.onHarnessEvent("r8", { id, event: { kind: "text", text: "thinking" } });
    expect(events).toEqual([{ kind: "text", text: "thinking" }]);
    hub.onResult({ id, ok: true, data: null });
    await call;
    r.ws.close();
    other.ws.close();
  });

  test("a signal reused across calls keeps no abort listener once each call ends, by any path", async () => {
    const abort = new AbortController();
    const listeners = () => getEventListeners(abort.signal, "abort").length;
    const r = await runner("r10");
    const opts = { signal: abort.signal };
    // Answered with a result and with an error.
    for (let i = 0; i < 20; i++) {
      const call = hub.call("r10", "list", { path: String(i) }, opts);
      const frames = await r.until(i + 1);
      hub.onResult({ id: frames[i]?.id ?? "", ok: true, data: i });
      await call;
    }
    const failed = failure(hub.call("r10", "list", { path: "e" }, opts));
    const errorFrames = await r.until(21);
    hub.onResult({ id: errorFrames[20]?.id ?? "", ok: false, error: { code: "internal", message: "x" } });
    await failed;
    expect(listeners()).toBe(0);
    // Past its deadline.
    await failure(hub.call("r10", "list", { path: "t" }, { ...opts, timeoutMs: 20 }));
    expect(listeners()).toBe(0);
    // Waiting for a slot, then served.
    const busy = Array.from({ length: MAX_INFLIGHT }, () => hub.call("r10", "list", { path: "busy" }, opts));
    const queued = hub.call("r10", "list", { path: "queued" }, opts);
    while (
      r.frames.filter((f) => f.type === "request" && (f.args as { path?: string }).path === "busy").length <
      MAX_INFLIGHT
    )
      await Bun.sleep(2);
    for (const f of r.frames.filter((f) => (f.args as { path?: string } | undefined)?.path === "busy"))
      hub.onResult({ id: f.id, ok: true, data: null });
    await Promise.all(busy);
    while (!r.frames.some((f) => (f.args as { path?: string } | undefined)?.path === "queued"))
      await Bun.sleep(2);
    const q = r.frames.find((f) => (f.args as { path?: string } | undefined)?.path === "queued");
    hub.onResult({ id: q?.id ?? "", ok: true, data: null });
    await queued;
    expect(listeners()).toBe(0);
    // The runner drops.
    const dropped = failure(hub.call("r10", "list", { path: "drop" }, opts));
    while (!r.frames.some((f) => (f.args as { path?: string } | undefined)?.path === "drop"))
      await Bun.sleep(2);
    r.ws.close();
    await dropped;
    expect(listeners()).toBe(0);
    // The server stops (closeAll) with a call in flight.
    const s = await runner("r11");
    const stopping = failure(hub.call("r11", "list", { path: "." }, opts));
    await s.until(1);
    hub.closeAll();
    expect(await stopping).toEqual({ code: "offline", message: "The server is stopping" });
    expect(listeners()).toBe(0);
  });

  test("closeAll closes every runner connection", async () => {
    hub = new RunnerHub();
    const a = await runner("ra");
    const b = await runner("rb");
    hub.closeAll();
    expect([await a.closed, await b.closed]).toEqual([1001, 1001]);
    expect(hub.online()).toEqual([]);
  });
});
