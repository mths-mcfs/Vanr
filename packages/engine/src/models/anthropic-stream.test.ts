// The Anthropic stream is checked event by event, before anything is accumulated or handed on: the
// sequences the review found (usage that shrinks or goes negative, a text delta that is not text, two
// message starts, a repeated tool id, a delta for a block never opened) fail the turn with
// invalid_response and are not retried; the valid sequences of the SDK's event types keep working.
import { describe, expect, test } from "bun:test";
import { costUsd } from "../usage";
import { anthropicProvider, usageOf } from "./anthropic";
import { PRICES } from "./prices";
import type { ModelEvent } from "./types";

type Sse = { event?: string; data: Record<string, unknown> };
const top = {
  input_tokens: 1000,
  output_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const start = (usage: Record<string, unknown> = top): Sse => ({
  data: {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  },
});
const delta = (usage: Record<string, unknown> = { output_tokens: 100 }, stop = "end_turn"): Sse => ({
  data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage },
});
const end: Sse = { data: { type: "message_stop" } };
const blockStart = (index: number, content_block: Record<string, unknown>): Sse => ({
  data: { type: "content_block_start", index, content_block },
});
const blockDelta = (index: number, d: Record<string, unknown>): Sse => ({
  data: { type: "content_block_delta", index, delta: d },
});
const blockStop = (index: number): Sse => ({ data: { type: "content_block_stop", index } });

async function run(events: Sse[]) {
  let requests = 0;
  const output: ModelEvent[] = [];
  const body = events
    .map((e) => `event: ${e.event ?? e.data.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  const fakeFetch = (async () => {
    requests++;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  let error: unknown = null;
  try {
    for await (const e of anthropicProvider("sk-test", { fetch: fakeFetch }).stream({
      model: "claude-opus-5-5",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    }))
      output.push(e);
  } catch (e) {
    error = e;
  }
  const turn = output.find((e) => e.type === "turn");
  return { requests, output, error, turn: turn?.type === "turn" ? turn : null };
}

describe("invalid stream sequences", () => {
  test("usage never shrinks: a later, smaller total keeps the larger one", async () => {
    const r = await run([
      start(),
      delta({ input_tokens: 2000, output_tokens: 500 }),
      delta({ input_tokens: 1, output_tokens: 1 }),
      end,
    ]);
    expect(r.error).toBeNull();
    expect(r.turn?.usage).toMatchObject({ inputTokens: 2000, outputTokens: 500 });
  });

  const invalid: [string, Sse[]][] = [
    ["a negative count later overwritten", [start({ ...top, output_tokens: -1 }), delta(), end]],
    ["a negative count in a delta", [start(), delta({ output_tokens: -1 }), end]],
    ["a fractional count in a delta", [start(), delta({ output_tokens: 1, input_tokens: 2.5 }), end]],
    [
      "a text delta that is not text",
      [
        start(),
        blockStart(0, { type: "text", text: "", citations: null }),
        blockDelta(0, { type: "text_delta", text: 123 }),
        blockStop(0),
        delta(),
        end,
      ],
    ],
    [
      "a text block whose text is not text",
      [start(), blockStart(0, { type: "text", text: 123, citations: null }), blockStop(0), delta(), end],
    ],
    ["two message starts", [start(), start(), delta(), end]],
    [
      "a repeated tool id",
      [
        start(),
        ...[0, 1].flatMap((i) => [
          blockStart(i, { type: "tool_use", id: "same", name: "remember", input: { n: i } }),
          blockStop(i),
        ]),
        delta(undefined, "tool_use"),
        end,
      ],
    ],
    [
      "a delta for a block never opened",
      [
        start(),
        blockStart(10, { type: "text", text: "", citations: null }),
        blockDelta(10, { type: "text_delta", text: "lost" }),
        blockStop(10),
        delta(),
        end,
      ],
    ],
    [
      "a delta after its block stopped",
      [
        start(),
        blockStart(0, { type: "text", text: "", citations: null }),
        blockStop(0),
        blockDelta(0, { type: "text_delta", text: "late" }),
        delta(),
        end,
      ],
    ],
    [
      "a text delta on a tool block",
      [
        start(),
        blockStart(0, { type: "tool_use", id: "t1", name: "remember", input: {} }),
        blockDelta(0, { type: "text_delta", text: "x" }),
        blockStop(0),
        delta(),
        end,
      ],
    ],
    ["a stream that ends before message_stop", [start(), delta()]],
    [
      "an event after message_stop",
      [start(), delta(), end, blockStart(0, { type: "text", text: "", citations: null })],
    ],
  ];
  for (const [name, events] of invalid)
    test(`${name}: invalid_response, one request, nothing handed on`, async () => {
      const r = await run(events);
      expect(r.error).toMatchObject({ code: "invalid_response" });
      expect(r.requests).toBe(1);
      expect(r.output.filter((e) => e.type !== "thinking")).toEqual([]);
    });

  test("tool input that is not JSON is still invalid_tool_input, retried before anything was shown", async () => {
    const r = await run([
      start(),
      blockStart(0, { type: "tool_use", id: "t1", name: "remember", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: '{"text":' }),
      blockStop(0),
      delta(undefined, "tool_use"),
      end,
    ]);
    expect(r.error).toMatchObject({ code: "invalid_tool_input" });
    expect(r.requests).toBe(3);
  });

  test("an empty speed is unknown, kept, and charged as fast", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const cost = (speed: string) =>
      costUsd(PRICES, { model: "claude-opus-5-5", usage: usageOf({ ...top, speed } as never), at });
    expect(usageOf({ ...top, speed: "" } as never).speed).toBe("");
    expect(cost("")).toBeCloseTo(cost("fast"), 12);
    expect(cost("")).toBeGreaterThan(cost("standard"));
  });
});

describe("valid stream sequences of the SDK's event types", () => {
  test("ping, an unknown event, thinking, citations, a server tool, its result and a client tool", async () => {
    const r = await run([
      start(),
      { event: "ping", data: { type: "ping" } },
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "let me" }),
      blockDelta(0, { type: "thinking_delta", thinking: " think" }),
      blockDelta(0, { type: "signature_delta", signature: "sig" }),
      blockStop(0),
      { event: "brand_new_event", data: { type: "brand_new_event", x: -1 } },
      blockStart(1, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
      blockDelta(1, { type: "input_json_delta", partial_json: '{"query":' }),
      blockDelta(1, { type: "input_json_delta", partial_json: '"vanr"}' }),
      blockStop(1),
      blockStart(2, { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }),
      blockStop(2),
      blockStart(3, { type: "text", text: "", citations: null }),
      blockDelta(3, { type: "text_delta", text: "Hello " }),
      blockDelta(3, {
        type: "citations_delta",
        citation: {
          type: "search_result_location",
          cited_text: "cited",
          search_result_index: 0,
          source: "/wiki/a",
          title: null,
          start_block_index: 0,
          end_block_index: 1,
        },
      }),
      blockDelta(3, { type: "text_delta", text: "world" }),
      blockDelta(3, { type: "brand_new_delta", whatever: 1 }),
      blockStop(3),
      blockStart(4, {
        type: "tool_use",
        id: "toolu_1",
        name: "remember",
        input: {},
        caller: { type: "direct" },
      }),
      blockDelta(4, { type: "input_json_delta", partial_json: '{"text":' }),
      blockDelta(4, { type: "input_json_delta", partial_json: '"hi"}' }),
      blockStop(4),
      delta(
        {
          output_tokens: 50,
          input_tokens: 1000,
          cache_read_input_tokens: null,
          server_tool_use: { web_search_requests: 1 },
        },
        "tool_use",
      ),
      end,
    ]);
    expect(r.error).toBeNull();
    expect(r.output.filter((e) => e.type !== "turn")).toEqual([
      { type: "thinking" },
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
    expect(r.turn?.stop).toBe("tool_use");
    expect(r.turn?.content).toEqual([
      {
        type: "text",
        text: "Hello world",
        citations: [{ searchResultIndex: 0, source: "/wiki/a", title: null, citedText: "cited" }],
      },
      { type: "tool_use", id: "toolu_1", name: "remember", input: { text: "hi" } },
    ]);
    expect(r.turn?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    const raw = r.turn?.raw;
    expect(Array.isArray(raw) && raw.map((b: { type: string }) => b.type)).toEqual([
      "thinking",
      "server_tool_use",
      "web_search_tool_result",
      "text",
      "tool_use",
    ]);
    expect(Array.isArray(raw) && raw[0]).toEqual({
      type: "thinking",
      thinking: "let me think",
      signature: "sig",
    });
    expect(Array.isArray(raw) && raw[1]).toMatchObject({ input: { query: "vanr" } });
  });

  test("a tool block with no input deltas keeps the input it started with", async () => {
    const r = await run([
      start(),
      blockStart(0, { type: "tool_use", id: "t1", name: "remember", input: { a: 1 } }),
      blockStop(0),
      delta(undefined, "tool_use"),
      end,
    ]);
    expect(r.turn?.content).toEqual([{ type: "tool_use", id: "t1", name: "remember", input: { a: 1 } }]);
  });
});
