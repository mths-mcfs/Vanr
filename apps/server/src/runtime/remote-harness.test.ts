// The provider that thinks on a paired runner, without the runtime that picks it (runtime/runtime, S6): the
// real runner hub on a real socket, with the test playing the runner (it reads the `harness.turn` request and
// answers through the hub as the runner socket does). The transcript, the turn's frame, the streamed text, the
// result checked at the edge, the runner's errors and the notice are what the runtime will see.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { ModelEvent, ModelMessage, ModelRequest } from "@vanr/engine/models/types";
import { HARNESS_PROMPT_MAX, opArgs } from "@vanr/engine/runner-protocol";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../../test/harness";
import { seedWorkspace } from "../../test/seed";
import { RunnerCallError, RunnerHub, type RunnerSocket, type RunnerSocketData } from "../runners/hub";
import type { RunHarness } from "../runners/plans";
import type { RunningServer } from "../server";
import { HarnessError, harnessNotice, remoteProvider, transcript } from "./remote-harness";

let server: RunningServer;
let ws: ReturnType<typeof Bun.serve<RunnerSocketData>>;
const hub = new RunnerHub();
const sockets = new Map<string, RunnerSocket>();
let workspaceId: string;
let agentId: string;
let userId: string;

beforeAll(async () => {
  server = await startTestServer();
  const ana = await signedIn(server, "Ana", "ana@harness.test");
  userId = ana.user.id;
  ({ workspaceId } = await seedWorkspace(server, ana, "Harness"));
  const [agent] = await server.deps.db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: "Lia",
      handle: "lia",
      role: "support",
      instructions: "",
      model: "claude-haiku-5-5",
      ownerUserId: userId,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  agentId = agent?.id ?? "";
  ws = Bun.serve<RunnerSocketData>({
    port: 0,
    fetch(req, srv) {
      const data: RunnerSocketData = {
        kind: "runner",
        runnerId: new URL(req.url).searchParams.get("r"),
        workspaceId,
        lastFrameAt: 0,
        helloTimer: null,
        pingTimer: null,
        closed: false,
        onlineAt: null,
      };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("upgrade", { status: 426 });
    },
    websocket: {
      open(socket) {
        if (!socket.data.runnerId) return;
        hub.register(socket.data.runnerId, socket);
        sockets.set(socket.data.runnerId, socket);
      },
      message() {},
      close(socket) {
        hub.unregister(socket);
      },
    },
  });
}, SERVER_TEST_MS);
afterAll(async () => {
  ws.stop(true);
  await server.stop();
}, SERVER_TEST_MS);

interface Request {
  type: string;
  id: string;
  op: string;
  agent: unknown;
  args: Record<string, unknown>;
}

/** A paired runner (its row) connected to the hub; `next` resolves with the next request the server sends. */
async function pairedRunner() {
  const [row] = await server.deps.db
    .insert(schema.runners)
    .values({
      id: newId("rnr"),
      workspaceId,
      name: "Laptop",
      tokenHash: newId("rnr"),
      storeKey: "key",
      pairedByUserId: userId,
    })
    .returning();
  if (!row) throw new Error("no runner");
  const waiting: ((r: Request) => void)[] = [];
  const received: Request[] = [];
  const client = new WebSocket(`ws://localhost:${ws.port}/?r=${row.id}`);
  client.addEventListener("message", (ev) => {
    const frame: Request = JSON.parse(String(ev.data));
    if (frame.type !== "request") return;
    const w = waiting.shift();
    if (w) w(frame);
    else received.push(frame);
  });
  const registered = new Promise<void>((resolve) => {
    const check = () => (sockets.get(row.id)?.readyState === 1 ? resolve() : setTimeout(check, 1));
    client.addEventListener("open", check);
  });
  await registered;
  const socket = sockets.get(row.id);
  if (!socket) throw new Error("no socket");
  return {
    row,
    socket,
    next: () =>
      new Promise<Request>((resolve) => {
        const r = received.shift();
        if (r) resolve(r);
        else waiting.push(resolve);
      }),
    close: () => client.close(),
  };
}

const harnessOf = (
  row: typeof schema.runners.$inferSelect,
  model: string | null = null,
): Extract<RunHarness, { kind: "remote" }> => ({
  kind: "remote",
  executor: "claude_code",
  runner: row,
  model,
});

const request = (messages: ModelMessage[], signal = new AbortController().signal): ModelRequest => ({
  model: "claude-haiku-5-5",
  system: "You are Lia.",
  messages,
  tools: [],
  maxTokens: 1000,
  signal,
});

const say = (role: "user" | "assistant", text: string): ModelMessage => ({
  role,
  content: [{ type: "text", text }],
});

/** Every event of the turn, or the error it ended with. */
async function drain(stream: AsyncIterable<ModelEvent>): Promise<{ events: ModelEvent[]; error: unknown }> {
  const events: ModelEvent[] = [];
  try {
    for await (const e of stream) events.push(e);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

describe("the transcript", () => {
  test("every message with what the agent said and called, between the header and the footer", () => {
    const text = transcript([
      say("user", "Hi Lia"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking" },
          { type: "tool_use", id: "t1", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "nothing", isError: true }],
      },
    ]);
    expect(text.split("\n\n")).toEqual([
      "The conversation so far, oldest first:",
      "Hi Lia",
      "You: Looking\n[you called search]",
      "[tool result, error] nothing",
      expect.stringMatching(/^Reply to the latest message\(s\) as yourself\./),
    ]);
  });

  test("past the cap the oldest messages leave first, and a lone message larger than the cap keeps its end", () => {
    const max = 2000;
    const msgs = Array.from({ length: 30 }, (_, i) => say("user", `message ${i} ${"z".repeat(60)}`));
    const text = transcript(msgs, max);
    expect(text.length).toBeLessThanOrEqual(max);
    expect(text).toContain("message 29");
    expect(text).not.toContain("message 0 ");
    expect(text).toMatch(/\(\d+ older messages left out\)/);
    const huge = transcript([say("user", `${"a".repeat(5000)}THE END`)], max);
    expect(huge.length).toBeLessThanOrEqual(max);
    expect(huge).toContain("[...]");
    expect(huge).toContain("THE END");
  });
  // Ported from the origin's provider test (its one scenario that needs no route).
  test("a long conversation fits in the runner's turn", () => {
    const long = "é\n".repeat(10_000);
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      content: [{ type: "text" as const, text: `${i}: ${long}` }],
    }));
    const prompt = transcript(messages);
    expect(prompt.length).toBeLessThanOrEqual(HARNESS_PROMPT_MAX);
    expect(prompt).toContain("older messages left out");
    expect(prompt).toContain("29: é");
    const args = { runId: "run_12345678", executor: "claude_code", system: "x", prompt, tools: [] };
    expect(opArgs["harness.turn"].safeParse(args).success).toBe(true);
    // A single message larger than the cap keeps its end.
    const huge = transcript([
      { role: "user", content: [{ type: "text", text: `${"a".repeat(500_000)}END` }] },
    ]);
    expect(huge.length).toBeLessThanOrEqual(HARNESS_PROMPT_MAX);
    expect(huge).toContain("END");
  });
});

describe("a turn on the runner", () => {
  test("goes out once with the network policy, streams the text and ends in end_turn with the usage", async () => {
    const runner = await pairedRunner();
    await server.deps.db
      .insert(schema.sandboxPolicies)
      .values({ workspaceId, network: "allowlist", permittedDomains: ["docs.example.com"] })
      .onConflictDoNothing();
    await server.deps.db.insert(schema.networkRequests).values({
      id: newId("nr"),
      workspaceId,
      agentId,
      domain: "api.example.com",
      status: "allowed",
    });
    const provider = remoteProvider(
      { ...server.deps, runners: hub },
      {
        runId: "run_1",
        agent: { id: agentId, handle: "lia" },
        harness: harnessOf(runner.row, "claude-opus-5-5"),
        invoke: async (name) => ({ content: `ran ${name}`, isError: false }),
      },
    );
    const done = drain(provider.stream(request([say("user", "Hi")])));
    const turn = await runner.next();
    expect(turn).toMatchObject({ op: "harness.turn", agent: { id: agentId, handle: "lia" } });
    expect(turn.args).toMatchObject({
      runId: "run_1",
      executor: "claude_code",
      model: "claude-opus-5-5",
      system: "You are Lia.",
      tools: [],
      timeoutSeconds: 6 * 3600,
      network: { mode: "allowlist", domains: ["docs.example.com", "api.example.com"] },
    });
    expect(String(turn.args.prompt)).toContain("Hi");
    hub.onHarnessEvent(runner.socket, { id: turn.id, event: { kind: "text", text: "Hel" } });
    hub.onHarnessEvent(runner.socket, { id: turn.id, event: { kind: "text", text: "lo" } });
    hub.onResult(runner.socket, {
      id: turn.id,
      ok: true,
      data: { text: "Hello", usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 4 }, model: null },
    });
    const { events, error } = await done;
    expect(error).toBeNull();
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "turn",
        content: [{ type: "text", text: "Hello" }],
        raw: null,
        stop: "end_turn",
        usage: { inputTokens: 10, cachedTokens: 4, cacheWriteTokens: 0, outputTokens: 2 },
      },
    ]);
    runner.close();
  });

  test("without a model it asks for none, and a blank answer is an empty turn", async () => {
    const runner = await pairedRunner();
    const provider = remoteProvider(
      { ...server.deps, runners: hub },
      {
        runId: "run_2",
        agent: { id: agentId, handle: "lia" },
        harness: harnessOf(runner.row),
        invoke: async () => ({ content: "", isError: false }),
      },
    );
    const done = drain(provider.stream(request([say("user", "Anything?")])));
    const turn = await runner.next();
    expect("model" in turn.args).toBe(false);
    hub.onResult(runner.socket, {
      id: turn.id,
      ok: true,
      data: { text: "   ", usage: { inputTokens: 1, outputTokens: 0, cachedTokens: 0 }, model: "x" },
    });
    const { events } = await done;
    expect(events.at(-1)).toMatchObject({ type: "turn", content: [], stop: "end_turn" });
    runner.close();
  });

  test("an answer in a shape the turn doesn't have fails the turn, without asking again", async () => {
    const runner = await pairedRunner();
    const provider = remoteProvider(
      { ...server.deps, runners: hub },
      {
        runId: "run_3",
        agent: { id: agentId, handle: "lia" },
        harness: harnessOf(runner.row),
        invoke: async () => ({ content: "", isError: false }),
      },
    );
    for (const data of [
      null,
      { text: 5, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, model: null },
      { text: "ok", usage: { inputTokens: -1, outputTokens: 1, cachedTokens: 0 }, model: null },
      { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, model: null },
    ]) {
      const done = drain(provider.stream(request([say("user", "Hi")])));
      const turn = await runner.next();
      hub.onResult(runner.socket, { id: turn.id, ok: true, data });
      const { events, error } = await done;
      expect(events).toEqual([]);
      expect(error).toBeInstanceOf(HarnessError);
      expect(error).toMatchObject({
        code: "harness_failed",
        executor: "claude_code",
        runnerId: runner.row.id,
      });
    }
    runner.close();
  });

  test("the runner's errors become the harness's codes; a cancel stays the runner's own error", async () => {
    const runner = await pairedRunner();
    const provider = remoteProvider(
      { ...server.deps, runners: hub },
      {
        runId: "run_4",
        agent: { id: agentId, handle: "lia" },
        harness: harnessOf(runner.row),
        invoke: async () => ({ content: "", isError: false }),
      },
    );
    const cases = [
      ["not_logged_in", "not_logged_in"],
      ["plan_limit", "plan_limit"],
      ["paused", "paused"],
      ["not_allowed", "tool_off"],
      ["internal", "harness_failed"],
    ] as const;
    for (const [from, to] of cases) {
      const done = drain(provider.stream(request([say("user", "Hi")])));
      const turn = await runner.next();
      hub.onResult(runner.socket, { id: turn.id, ok: false, error: { code: from, message: from } });
      const { error } = await done;
      expect(error).toMatchObject({ code: to, executor: "claude_code", runnerId: runner.row.id });
    }
    const canceled = drain(provider.stream(request([say("user", "Hi")])));
    await runner.next();
    hub.cancelPending(runner.row.id, agentId);
    const { error } = await canceled;
    expect(error).toBeInstanceOf(RunnerCallError);
    expect(error).toMatchObject({ code: "canceled" });
    runner.close();
  });

  test("an offline runner fails at once with offline", async () => {
    const runner = await pairedRunner();
    runner.close();
    await new Promise<void>((resolve) => {
      const check = () => (hub.isOnline(runner.row.id) ? setTimeout(check, 1) : resolve());
      check();
    });
    const provider = remoteProvider(
      { ...server.deps, runners: hub },
      {
        runId: "run_5",
        agent: { id: agentId, handle: "lia" },
        harness: harnessOf(runner.row),
        invoke: async () => ({ content: "", isError: false }),
      },
    );
    const { error } = await drain(provider.stream(request([say("user", "Hi")])));
    expect(error).toMatchObject({ code: "offline", runnerId: runner.row.id });
  });
});

describe("the notice", () => {
  test("names the harness and the reason, with the template the screen translates", () => {
    expect(harnessNotice("agt_1", { code: "offline", executor: "codex", runnerId: "rnr_1" })).toEqual({
      body: "Codex is offline right now (offline).",
      meta: {
        bodyTemplate: "harness.offline",
        templateVars: { harness: "Codex", code: "offline" },
        harnessUnavailable: { harness: "codex", code: "offline", runnerId: "rnr_1", agentId: "agt_1" },
      },
    });
    expect(harnessNotice("agt_1", { code: "outdated", executor: "claude_code", runnerId: null }).body).toBe(
      "Claude Code is not available right now (outdated).",
    );
  });
});
