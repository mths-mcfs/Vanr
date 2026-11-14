// A runner that speaks the protocol by hand, for the tests that need what the real runner (apps/runner) can't be
// told to do: claim a browser, send a malformed frame, stream live view frames. Every frame the server sends it is
// checked against the protocol's schema (`serverFrame`), so a frame the server builds wrong fails the test.
import {
  BROWSER_GUARD_FEATURE,
  type HelloFrame,
  RUNNER_PROTOCOL,
  type ServerFrame,
  serverFrame,
} from "@vanr/engine/runner-protocol";
import { RUNNER_VERSION } from "@vanr/runner/config";

type Request = Extract<ServerFrame, { type: "request" }>;
type Answer = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export interface ProtocolRunner {
  readonly runnerId: string;
  /** Every frame the server sent, already checked against `serverFrame`. */
  readonly frames: ServerFrame[];
  /** What the server sent that doesn't match the protocol (the tests expect it empty). */
  readonly invalid: unknown[];
  /** The next frame (already received or to come) that matches. */
  next(match: (f: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
  /** The next request the server made for this op. */
  request(op: string, timeoutMs?: number): Promise<Request>;
  /** Sends anything: a frame or raw text. */
  send(frame: unknown): void;
  readonly closed: Promise<{ code: number; reason: string }>;
  close(): Promise<void>;
}

/** The single-use session for the `hello` and the new credential (protocol 2). */
export async function mintSession(server: string, credential: string) {
  const res = await fetch(`${server}/api/v1/runners/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ protocol: RUNNER_PROTOCOL, version: RUNNER_VERSION }),
  });
  return { status: res.status, body: (await res.json()) as { session: string; credential: string } };
}

/**
 * Connects with a session and says `hello`. `answer` replies to the server's requests (by default every op
 * succeeds with `{}`, `secret.store` with `{ stored: true }`). Resolves on `welcome`.
 */
export async function connectProtocolRunner(
  server: string,
  session: string,
  opts: { browser?: boolean; answer?: (req: Request) => Answer | Promise<Answer> } = {},
): Promise<ProtocolRunner> {
  const frames: ServerFrame[] = [];
  const invalid: unknown[] = [];
  const waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  const ws = new WebSocket(`${server.replace(/^http/, "ws")}/api/v1/runners/connect`);
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason })),
  );
  const answer =
    opts.answer ??
    ((req: Request): Answer => ({ ok: true, data: req.op === "secret.store" ? { stored: true } : {} }));
  const send = (frame: unknown) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  ws.addEventListener("message", (ev) => {
    const parsed = serverFrame.safeParse(JSON.parse(String(ev.data)));
    if (!parsed.success) {
      invalid.push(JSON.parse(String(ev.data)));
      return;
    }
    const frame = parsed.data;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.match(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
    if (frame.type === "request")
      void Promise.resolve(answer(frame)).then((a) => send({ type: "result", id: frame.id, ...a }));
  });
  const next = (match: (f: ServerFrame) => boolean, timeoutMs = 5000) => {
    const seen = frames.find(match);
    if (seen) {
      frames.splice(frames.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise<ServerFrame>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (f: ServerFrame) => {
          clearTimeout(timer);
          frames.splice(frames.indexOf(f), 1);
          resolve(f);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(
          new Error(`timeout waiting for a runner frame; got ${JSON.stringify(frames.map((f) => f.type))}`),
        );
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const browser = opts.browser ?? false;
  const hello: HelloFrame = {
    type: "hello",
    session,
    version: RUNNER_VERSION,
    protocol: RUNNER_PROTOCOL,
    os: "linux",
    arch: "x64",
    hostname: "test-host",
    workDir: null,
    paused: false,
    access: { folders: [], tools: { browser, claude: false, codex: false, commands: true } },
    browser,
    executors: [],
    cli: {},
    jobs: [],
    features: browser ? [BROWSER_GUARD_FEATURE] : [],
    sandbox: { state: "off", engine: null, reason: null },
  };
  send(hello);
  const welcome = await Promise.race([
    next((f) => f.type === "welcome" || f.type === "rejected"),
    closed.then((c) => {
      throw new Error(`closed before welcome: ${c.code} ${c.reason}`);
    }),
  ]);
  if (welcome.type !== "welcome") throw new Error(`rejected: ${JSON.stringify(welcome)}`);
  return {
    runnerId: welcome.runnerId,
    frames,
    invalid,
    next,
    request: (op, timeoutMs) =>
      next((f) => f.type === "request" && f.op === op, timeoutMs) as Promise<Request>,
    send,
    closed,
    close: async () => {
      ws.close();
      await closed;
    },
  };
}
