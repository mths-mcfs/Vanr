import { expect, test } from "bun:test";
import { CdpBrowser } from "./cdp";

// The browser's ops after an aborted one: they wait for it to finish unwinding (its own steps after the abort
// do not go), and a wait that is itself aborted ends at once with `canceled`, not at the deadline.
function browserWithOneSession(timeout = 60_000) {
  const b = Object.create(CdpBrowser.prototype) as Record<string, unknown>;
  const agent = { id: "agt_0000000012345678", handle: "lia" };
  const session = {
    lock: Promise.resolve(),
    policy: { driver: "agent" },
    pages: [{ sessionId: "s" }],
    active: 0,
    signal: null as AbortSignal | null,
    unwinding: new Set(),
    cdp: { send: async () => ({}) },
  };
  Object.assign(b, { sessions: new Map([[agent.id, session]]), opts: { opTimeoutMs: timeout } });
  const calls: string[] = [];
  let hang: () => void = () => {};
  let entered: () => void = () => {};
  const inFirst = new Promise<void>((r) => {
    entered = r;
  });
  Reflect.set(b, "inspect", async () => {
    calls.push("inspect");
    if (calls.length === 1) {
      entered();
      // The first op's work does not settle until the test lets it.
      await new Promise<void>((r) => {
        hang = r;
      });
    }
    return { url: "u", allowed: true, element: null, fingerprint: "f" };
  });
  const handle = (signal?: AbortSignal) =>
    (Reflect.get(b, "handle") as (...a: unknown[]) => Promise<unknown>)
      .call(b, "browser.inspect", agent, {}, () => true, signal)
      .then(
        () => "done",
        (e: { code?: string }) => e.code,
      );
  return { b, agent, session, handle, calls, inFirst, release: () => hang() };
}

test("a wait for an aborted op ends at once with canceled when the waiting op is aborted too", async () => {
  const { handle, inFirst, release } = browserWithOneSession();
  const first = new AbortController();
  const one = handle(first.signal);
  await inFirst;
  first.abort();
  expect(await one).toBe("canceled");
  const second = new AbortController();
  const two = handle(second.signal);
  // The second op is waiting for the first to unwind when it is aborted.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  second.abort();
  const started = Date.now();
  expect(await two).toBe("canceled");
  expect(Date.now() - started).toBeLessThan(1000);
  release();
});

test("the next op does not begin while an aborted one is still unwinding", async () => {
  const { handle, calls, inFirst, release } = browserWithOneSession();
  const first = new AbortController();
  const one = handle(first.signal);
  await inFirst;
  first.abort();
  expect(await one).toBe("canceled");
  const two = handle(new AbortController().signal);
  // Still unwinding: the second op has not begun its work.
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(["inspect"]);
  release();
  expect(await two).toBe("done");
  expect(calls).toEqual(["inspect", "inspect"]);
});

test("timeout cancels pending work without a request signal and keeps unwinding", async () => {
  const { handle, session, calls, release } = browserWithOneSession(10);
  expect(await handle()).toBe("timeout");
  expect(session.signal?.aborted).toBe(true);
  expect(session.unwinding.size).toBe(1);
  const next = handle();
  await Promise.resolve();
  expect(calls).toEqual(["inspect"]);
  release();
  expect(await next).toBe("done");
  expect(session.unwinding.size).toBe(0);
});

test.each([false, true])("close while starting respects request cancellation: %s", async (abort) => {
  const { b, agent, session } = browserWithOneSession();
  const sessions = Reflect.get(b, "sessions");
  if (!(sessions instanceof Map)) throw new Error("missing sessions");
  sessions.clear();
  const starting = Promise.withResolvers<unknown>();
  Reflect.set(b, "starting", new Map([[agent.id, starting.promise]]));
  const closed: string[] = [];
  Object.assign(session, {
    guard: { close() {} },
    cdp: { send: async (m: string) => closed.push(m), close() {} },
    stream: null,
    proc: {
      kill() {},
      once(_e: string, cb: () => void) {
        cb();
      },
    },
  });
  const controller = new AbortController();
  const close = Reflect.get(b, abort ? "handle" : "close");
  if (typeof close !== "function") throw new Error("missing close");
  const pending = abort
    ? close.call(b, "browser.close", agent, {}, () => true, controller.signal)
    : close.call(b);
  if (abort) controller.abort();
  sessions.set(agent.id, session);
  starting.resolve(session);
  if (abort) await expect(pending).rejects.toMatchObject({ code: "canceled" });
  else await pending;
  expect(closed.includes("Browser.close")).toBe(!abort);
  expect(sessions.has(agent.id)).toBe(abort);
});

test.each([
  { name: "ordinary key", navigation: false, focus: "page", keys: ["keyDown", "keyUp"] },
  { name: "navigation destroys context", navigation: true, focus: "missing", keys: ["keyDown"] },
  { name: "navigation replaces page", navigation: true, focus: "page", keys: ["keyDown"] },
  { name: "context error without navigation", navigation: false, focus: "missing", keys: ["keyDown"] },
  { name: "focus moves into a frame", navigation: false, focus: "frame", keys: ["keyDown"] },
])("keyboard sequence: $name", async ({ navigation, focus, keys }) => {
  const { b, session } = browserWithOneSession();
  const sent: string[] = [];
  Object.assign(session.cdp, {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      switch (method) {
        case "Page.getFrameTree":
          return { frameTree: { frame: { loaderId: navigation && sent.length ? "new" : "old" } } };
        case "Page.createIsolatedWorld":
          return { executionContextId: 1 };
        case "Runtime.evaluate":
          if (sent.length && focus === "missing") throw new Error("Cannot find context with specified id");
          return { result: { objectId: "focused" } };
        case "DOM.describeNode":
          return { node: { nodeName: sent.length && focus === "frame" ? "IFRAME" : "INPUT" } };
        case "Input.dispatchKeyEvent":
          sent.push(String(params.type));
          return {};
        default:
          throw new Error(`Unexpected CDP command: ${method}`);
      }
    },
  });
  const press = Reflect.get(b, "press");
  if (typeof press !== "function") throw new Error("missing press");
  const result = press.call(b, session, "Enter");
  if (!navigation && focus === "missing")
    await expect(result).rejects.toThrow("Cannot find context with specified id");
  else if (focus === "frame") await expect(result).rejects.toMatchObject({ code: "not_allowed" });
  else await expect(result).resolves.toBeUndefined();
  expect(sent).toEqual([...keys]);
});
