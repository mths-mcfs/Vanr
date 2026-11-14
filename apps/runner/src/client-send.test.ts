import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerFrame, runnerFrame } from "@vanr/engine/runner-protocol";
import { RunnerClient } from "./client";
import { Jobs } from "./jobs";
import { Flows } from "./outbound";
import { sandboxOff } from "./sandbox";
import { seeded } from "./testing/random";

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
    maskState: { kind: "empty" },
    heldFrames: [],
    reading: null,
    readFailures: 0,
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
      made.call("openSocket", "rst_fixture_session_1234");
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

test("property: across reconnections at any point, every frame (the first hello of each connection too) is masked", async () => {
  const r = seeded(9090);
  const real = globalThis.WebSocket;
  const sent: string[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(s: string) {
      sent.push(s);
    }
    close() {}
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  let version = 0;
  try {
    const { c, call } = fakeClient({
      config: {
        server: "https://example.invalid",
        workDir: "/w",
        paused: false,
        access: { folders: [], tools: { claude: true, codex: false, commands: true, browser: false } },
      },
      opts: { version: "1.0.0", log: () => {} },
      cli: {
        states: () => ({
          claude_code: { version: `${SECRET} ${version}`, login: "subscription", plan: SECRET },
        }),
      },
      jobs: { pending: () => [] },
      executors: ["claude_code"],
      sandbox: sandboxOff(),
      heartbeatMs: 25_000,
      agents: [agent],
      toolCalls: new Map(),
      retryLater: () => {},
      cliSent: "",
      secrets: { masks: async () => MASKS, lock: () => {} },
    });
    await call("refreshMasks");
    const connect = () => {
      call("openSocket", `rst_fixture_session_${String(r.int(1e6)).padStart(8, "0")}`);
      (Reflect.get(c, "ws") as FakeSocket).onopen?.();
      clearTimeout(Reflect.get(c, "watchdog") as ReturnType<typeof setTimeout>);
      Reflect.set(c, "hadWelcome", true);
    };
    connect();
    const flows = new Flows(() => (Reflect.get(c, "allMasks") as () => [string, string][]).call(c));
    let reconnects = 0;
    for (let step = 0; step < 600; step++) {
      const action = r.int(5, "action");
      if (action === 0) {
        (Reflect.get(c, "ws") as FakeSocket).onclose?.();
        connect();
        reconnects++;
      } else if (action === 1) {
        version++;
        Reflect.set(c, "cliCheckedAt", 0);
        call("recheckCli");
      } else if (action === 2) {
        const piece = flows.push("text", r.pick(["ABCD-", "SECRET", "x ", SECRET], "piece"));
        if (piece)
          call("send", { type: "harness.event", id: "req_1", event: { kind: "text", text: piece } }, []);
      } else if (action === 3)
        call("send", { type: "output", id: "req_1", stream: "stdout", chunk: `a ${SECRET} b` }, []);
      else call("send", { type: "job.event", jobId: "job_1", kind: "line", line: SECRET, at: "t" }, []);
    }
    const harness = sent.flatMap((s) => {
      const f = JSON.parse(s);
      return f.type === "harness.event" ? [f.event.text] : [];
    });
    expect(harness.join("").includes(SECRET)).toBe(false);
    for (const s of sent) expect(s.includes(SECRET)).toBe(false);
    const hellos = sent.filter((s) => JSON.parse(s).type === "hello");
    expect(hellos.length).toBe(reconnects + 1);
    console.log(
      `[reconnect] ${sent.length} frames, ${reconnects} reconnections, actions ${JSON.stringify(r.spread("action"))}`,
    );
  } finally {
    globalThis.WebSocket = real;
  }
});

test("a job that ended before a secret existed is masked with it when it is delivered again", async () => {
  const home = mkdtempSync(join(tmpdir(), "runner-redeliver-"));
  try {
    mkdirSync(join(home, "jobs"));
    const job = {
      jobId: "job_00000001",
      status: "done",
      exitCode: 0,
      result: `the key is ${SECRET}`,
      files: [],
      session: null,
      startedAt: null,
      endedAt: null,
      denied: [],
      blocked: [],
      agent,
      executor: "shell",
      delivered: false,
    };
    writeFileSync(join(home, "jobs", "journal.json"), JSON.stringify([job]));
    let client: { call: (name: string, ...a: unknown[]) => unknown } | undefined;
    const jobs = new Jobs({
      home,
      send: (e: RunnerFrame) => client?.call("send", e),
    } as unknown as ConstructorParameters<typeof Jobs>[0]);
    const made = fakeClient({ jobs, agents: [agent] });
    client = made;
    // The journal on disk keeps what it had (the secret did not exist when the job ended).
    expect(readFileSync(join(home, "jobs", "journal.json"), "utf8")).toContain(SECRET);
    await made.call("refreshMasks");
    jobs.redeliver();
    expect(made.sent).toMatchObject([{ type: "job.done", job: { result: "the key is [secret:S]" } }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Waits for a condition the code under test makes true, not for a time. */
async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(2);
}

test("a read of the secrets that fails is not knowing: nothing from outside goes until a read works, then it goes in order", async () => {
  let fails = 2;
  const secrets = {
    masks: async () => {
      if (fails-- > 0) throw new Error("cannot decrypt the store");
      return MASKS;
    },
    lock: () => {},
  };
  const cli = { states: () => ({ claude_code: { version: SECRET, login: "subscription", plan: null } }) };
  const job = {
    jobId: "job_00000001",
    status: "done",
    exitCode: 0,
    result: `end ${SECRET}`,
    files: [],
    session: null,
    startedAt: null,
    endedAt: null,
    denied: [],
    blocked: [],
  };
  const { c, sent, call } = fakeClient({
    maskState: { kind: "unknown" },
    secrets,
    cli,
    agents: [agent],
    hadWelcome: true,
    cliCheckedAt: 0,
    cliSent: "",
    opts: { log: () => {}, backoffBaseMs: 1 },
  });
  await call("refreshMasks");
  expect(Reflect.get(c, "maskState")).toEqual({ kind: "unknown" });
  // While it does not know, a finished job and the CLI state are held.
  call("send", { type: "job.done", job });
  call("recheckCli");
  expect(sent).toEqual([]);
  // The read is tried again on its own, with a growing wait, and the held frames go once it works.
  await until(() => (Reflect.get(c, "maskState") as { kind: string }).kind === "known");
  expect(sent.map((f) => f.type)).toEqual(["job.done", "cli.changed"]);
  expect(JSON.stringify(sent)).not.toContain(SECRET);
  expect(sent[0]).toMatchObject({ job: { result: "end [secret:S]" } });
});

test("a read that fails after one that worked keeps the last good list: a flow already going stays masked", async () => {
  let fail = false;
  const secrets = {
    masks: async () => {
      if (fail) throw new Error("cannot decrypt the store");
      return MASKS;
    },
    lock: () => {},
  };
  const { c, call } = fakeClient({
    maskState: { kind: "unknown" },
    secrets,
    agents: [agent],
    opts: { log: () => {}, backoffBaseMs: 60_000 },
  });
  await call("refreshMasks");
  const flows = new Flows(() => (Reflect.get(c, "allMasks") as () => [string, string][]).call(c));
  const before = flows.push("text", "out ABCD-");
  fail = true;
  await call("refreshMasks");
  expect((Reflect.get(c, "maskState") as { kind: string }).kind).toBe("known");
  const after = flows.push("text", "SECRET done") + flows.end("text");
  expect(before + after).toBe("out [secret:S] done");
  clearTimeout(Reflect.get(c, "readRetry") as ReturnType<typeof setTimeout>);
});

test("the first hello, before the secrets are read, carries no text from outside; the real one goes on a new connection", async () => {
  const real = globalThis.WebSocket;
  const sent: string[] = [];
  const closes: number[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(s: string) {
      sent.push(s);
    }
    close(code: number) {
      closes.push(code);
      this.readyState = 3;
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const { c, call } = fakeClient({
      maskState: { kind: "unknown" },
      config: {
        server: "https://example.invalid",
        workDir: `/w/${SECRET}`,
        paused: false,
        access: {
          folders: [{ path: `/w/${SECRET}`, agents: ["agt_1"] }],
          tools: { claude: true, codex: false, commands: true, browser: false },
        },
      },
      opts: { version: "1.2.3", log: () => {} },
      cli: { states: () => ({ claude_code: { version: SECRET, login: "subscription", plan: SECRET } }) },
      jobs: { pending: () => [], redeliver: () => {} },
      executors: ["claude_code"],
      sandbox: { status: () => ({ state: "unavailable", engine: null, reason: `no bwrap in /w/${SECRET}` }) },
      heartbeatMs: 25_000,
      agents: [agent],
      toolCalls: new Map(),
      retryLater: () => {},
    });
    call("openSocket", "rst_fixture_session_1234");
    (Reflect.get(c, "ws") as FakeSocket).onopen?.();
    clearTimeout(Reflect.get(c, "watchdog") as ReturnType<typeof setTimeout>);
    expect(sent.length).toBe(1);
    expect(sent[0]).not.toContain(SECRET);
    expect(JSON.parse(sent[0] as string)).toMatchObject({
      type: "hello",
      version: "1.2.3",
      hostname: "unknown",
      workDir: null,
      access: { folders: [], tools: { claude: true } },
      cli: {},
      jobs: [],
    });
    // The read works: the runner closes this connection to send the real hello on the next one.
    Reflect.set(c, "hadWelcome", true);
    await call("refreshMasks");
    expect(closes).toEqual([4006]);
    expect(sent.join("")).not.toContain(SECRET);
  } finally {
    globalThis.WebSocket = real;
  }
});

test("a request that arrives before the secrets are read waits for the read, and is rejected if it fails", async () => {
  const { sent, call } = fakeClient({
    maskState: { kind: "unknown" },
    secrets: { masks: async () => Promise.reject(new Error("cannot decrypt the store")), lock: () => {} },
    agents: [agent],
    opts: { log: () => {}, backoffBaseMs: 60_000 },
  });
  const reading = call("refreshMasks");
  await call("onRequest", {
    type: "request",
    id: "req_1",
    op: "exec",
    agent,
    stream: false,
    args: { command: "x" },
  });
  await reading;
  expect(sent).toMatchObject([{ type: "result", id: "req_1", ok: false, error: { code: "internal" } }]);
});

test("property: reads of the secrets that end in any order never take a mask out (the list only grows)", async () => {
  const r = seeded(4040);
  const values = ["SECRET-A-0001", "SECRET-B-0002", "SECRET-C-0003", "SECRET-D-0004"];
  for (let round = 0; round < 300; round++) {
    const reads: { masks: [string, string][]; done: (m: [string, string][]) => void }[] = [];
    const { c, call } = fakeClient({
      maskState: { kind: "empty" },
      agents: [agent],
      secrets: {
        masks: () =>
          new Promise<[string, string][]>((done) => {
            const masks = values
              .filter(() => r.int(2, "has"))
              .map((v): [string, string] => [v, `[secret:${v}]`]);
            reads.push({ masks, done });
          }),
        lock: () => {},
      },
    });
    const n = 2 + r.int(4, "reads");
    const pending = Array.from({ length: n }, () => call("refreshMasks"));
    // The reads end in an order the generator picks; each one, as it ends, may only add.
    const order = reads.map((_, i) => i).sort(() => r.int(3) - 1);
    const expected = new Set<string>();
    for (const i of order) {
      const read = reads[i];
      if (!read) continue;
      read.done(read.masks);
      await pending[i];
      for (const [v] of read.masks) expected.add(v);
      const state = Reflect.get(c, "maskState") as { kind: string; all?: [string, string][] };
      expect(new Set((state.all ?? []).map(([v]) => v))).toEqual(expected);
    }
  }
});

test("property: a request aborted at any point of waiting has no effect and no answer (write, exec, job.start, secret.remove)", async () => {
  const home = mkdtempSync(join(tmpdir(), "runner-abort-"));
  try {
    const work = join(home, "ws");
    const { Access } = await import("./access");
    const { defaultPolicyContext } = await import("./sandbox");
    const tools = { claude: false, codex: false, commands: true, browser: false };
    const access = new Access(() => ({ access: { folders: [], tools }, workDir: work, paused: false }));
    const root = access.agentRoot(agent);
    let points = 0;
    let abortAt = -1;
    let abort: () => void = () => {};
    // Each async step of the secrets is a point where the request can be aborted (the connection drops).
    const gate = async <T>(value: T): Promise<T> => {
      const k = points++;
      await Promise.resolve();
      if (k === abortAt) abort();
      return value;
    };
    const removed: string[] = [];
    // The point at which the op's effect happened: an abort after it is not "before the effect".
    let effectAt = Number.POSITIVE_INFINITY;
    const secrets = {
      masks: () => gate([] as [string, string][]),
      materialize: () => gate({ env: {}, masks: [] as [string, string][], release: () => {} }),
      secretFiles: () => [],
      lock: () => {},
      // A sync op: only the check of the request itself stands between the abort and its effect.
      remove: (_a: unknown, name: string) => {
        effectAt = points;
        removed.push(name);
        return { removed: true };
      },
    };
    const policy = defaultPolicyContext(home);
    const cases = [
      {
        op: "write",
        args: (n: number) => ({ path: `w${n}.txt`, content: "x" }),
        effect: (n: number) => existsSync(join(root, `w${n}.txt`)),
      },
      {
        op: "exec",
        args: (n: number) => ({ command: `touch '${join(home, `e${n}`)}'` }),
        effect: (n: number) => existsSync(join(home, `e${n}`)),
      },
      {
        op: "job.start",
        args: (n: number) => ({
          jobId: `job_${String(n).padStart(8, "0")}`,
          executor: "shell",
          title: "t",
          prompt: "true",
        }),
        effect: (n: number, jobs?: Jobs) =>
          (jobs?.pending() ?? []).some((j) => j.jobId === `job_${String(n).padStart(8, "0")}`),
      },
    ];
    const all: { op: string; args: (n: number) => object; effect: (n: number, jobs?: Jobs) => boolean }[] = [
      ...cases,
      { op: "secret.remove", args: (n) => ({ name: `S${n}` }), effect: (n) => removed.includes(`S${n}`) },
    ];
    let n = 0;
    const tried: Record<string, number> = {};
    for (const kase of all) {
      for (let at = -1; ; at++) {
        n++;
        points = 0;
        abortAt = at;
        effectAt = Number.POSITIVE_INFINITY;
        const jobs = new Jobs({
          home: join(home, `h${n}`),
          access,
          secrets: secrets as never,
          cli: {} as never,
          maxConcurrent: () => 5,
          maxSeconds: () => 30,
          send: () => true,
          bins: { claude: "claude", codex: "codex" },
          sandbox: sandboxOff(),
          policy,
        } as never);
        const { c, sent, call } = fakeClient({
          maskState: { kind: "unknown" },
          agents: [agent],
          secrets,
          access,
          sandbox: sandboxOff(),
          policy,
          jobs,
          opts: { log: () => {}, backoffBaseMs: 60_000 },
        });
        abort = () => (Reflect.get(c, "inflight") as Map<string, AbortController>).get("req_1")?.abort();
        const reading = call("refreshMasks");
        await call("onRequest", {
          type: "request",
          id: "req_1",
          op: kase.op,
          agent,
          stream: false,
          args: kase.args(n),
        });
        await reading;
        clearTimeout(Reflect.get(c, "readRetry") as ReturnType<typeof setTimeout>);
        const effect = kase.effect(n, jobs);
        const answered = sent.some((f) => f.type === "result");
        if (at === -1) {
          // Not aborted: the op happens and answers (the check is not vacuous).
          expect([kase.op, effect, answered]).toEqual([kase.op, true, true]);
          continue;
        }
        if (at >= Math.min(points, effectAt)) break;
        expect([kase.op, at, effect, answered]).toEqual([kase.op, at, false, false]);
        tried[kase.op] = (tried[kase.op] ?? 0) + 1;
      }
    }
    console.log(`[abort] aborted at every waiting point: ${JSON.stringify(tried)}`);
    expect(Object.keys(tried).sort()).toEqual(["exec", "job.start", "secret.remove", "write"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("property: however many reconnections fail to read the secrets, each pending job is held once", async () => {
  const home = mkdtempSync(join(tmpdir(), "runner-held-"));
  try {
    mkdirSync(join(home, "jobs"));
    const job = (i: number) => ({
      jobId: `job_${String(i).padStart(8, "0")}`,
      status: "done",
      exitCode: 0,
      result: "ok",
      files: [],
      session: null,
      startedAt: null,
      endedAt: null,
      denied: [],
      blocked: [],
      diff: "x".repeat(50_000),
      agent,
      executor: "shell",
      delivered: false,
    });
    const journal = [job(1), job(2), job(3)];
    writeFileSync(join(home, "jobs", "journal.json"), JSON.stringify(journal));
    let client: { call: (name: string, ...a: unknown[]) => unknown } | undefined;
    const jobs = new Jobs({
      home,
      send: (e: RunnerFrame) => client?.call("send", e),
    } as unknown as ConstructorParameters<typeof Jobs>[0]);
    const made = fakeClient({
      maskState: { kind: "unknown" },
      jobs,
      agents: [agent],
      opts: { log: () => {}, backoffBaseMs: 60_000 },
      secrets: { masks: async () => Promise.reject(new Error("cannot decrypt")), lock: () => {} },
    });
    client = made;
    const held = () => Reflect.get(made.c, "heldFrames") as { frame: RunnerFrame }[];
    const sizes: number[] = [];
    for (let i = 0; i < 300; i++) {
      jobs.redeliver();
      await made.call("refreshMasks");
      sizes.push(held().length);
    }
    clearTimeout(Reflect.get(made.c, "readRetry") as ReturnType<typeof setTimeout>);
    expect(new Set(sizes)).toEqual(new Set([3]));
    expect(held().map((h) => h.frame.type === "job.done" && h.frame.job.jobId)).toEqual(
      journal.map((j) => j.jobId),
    );
    // The read works: each job goes once.
    Reflect.set(made.c, "secrets", { masks: async () => MASKS, lock: () => {} });
    await made.call("refreshMasks");
    expect(
      made.sent.filter((f) => f.type === "job.done").map((f) => f.type === "job.done" && f.job.jobId),
    ).toEqual(journal.map((j) => j.jobId));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ready() resolves at the welcome of the connection with the real hello, not at the neutral one before it", async () => {
  const real = globalThis.WebSocket;
  const hellos: string[] = [];
  const closes: number[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(s: string) {
      const f = JSON.parse(s);
      if (f.type === "hello") hellos.push(f.hostname);
    }
    close(code: number) {
      closes.push(code);
      this.readyState = 3;
      this.onclose?.();
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const { c, call } = fakeClient({
      maskState: { kind: "unknown" },
      config: {
        server: "https://example.invalid",
        name: "laptop",
        workDir: "/w",
        paused: false,
        access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: false } },
      },
      opts: {
        version: "1.2.3",
        log: () => {},
        backoffBaseMs: 60_000,
        home: mkdtempSync(join(tmpdir(), "runner-ready-")),
      },
      cli: { states: () => ({}) },
      jobs: { pending: () => [], redeliver: () => {} },
      executors: [],
      sandbox: sandboxOff(),
      heartbeatMs: 25_000,
      agents: [agent],
      toolCalls: new Map(),
      welcomeWaiters: [],
      retryLater: () => {},
      secrets: { masks: async () => MASKS, lock: () => {}, unlock: async () => {} },
    });
    const order: string[] = [];
    const ready = (call("ready") as Promise<void>).then(() => order.push("ready"));
    const welcome = {
      type: "welcome",
      runnerId: "rnr_1",
      name: "laptop",
      heartbeatMs: 25_000,
      storeKey: "k",
      agents: [{ ...agent, name: "Lia" }],
    };
    const connect = () => {
      call("openSocket", "rst_fixture_session_1234");
      (Reflect.get(c, "ws") as FakeSocket).onopen?.();
      clearTimeout(Reflect.get(c, "watchdog") as ReturnType<typeof setTimeout>);
    };
    // The first connection: a neutral hello; its welcome reads the secrets and the runner reconnects.
    connect();
    await call("onFrame", welcome);
    order.push("first welcome handled");
    expect(closes).toEqual([4006]);
    // The second connection: the real hello; its welcome settles the runner.
    connect();
    await call("onFrame", welcome);
    await ready;
    expect(hellos).toEqual(["unknown", expect.not.stringMatching(/^unknown$/)]);
    expect(order).toEqual(["first welcome handled", "ready"]);
  } finally {
    globalThis.WebSocket = real;
  }
});
