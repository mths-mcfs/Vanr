// The Anthropic response is outside data: what does not have the expected shape never reaches the ledger
// or the tool runner. Usage with a broken iteration falls back to the top-level usage; a token count that
// is not a non-negative integer, or a tool block without an id, fails the turn.
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../usage";
import { anthropicProvider, usageOf } from "./anthropic";
import { PRICES } from "./prices";
import { ModelError, type ModelEvent } from "./types";

const top = {
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
/** The SDK type does not have `iterations`; the tests feed raw API JSON, as the wire does. */
const usage = (over: Record<string, unknown>) =>
  usageOf({ ...top, ...over } as Parameters<typeof usageOf>[0]);
const cost = (u: ReturnType<typeof usageOf>) =>
  costUsd(PRICES, { model: "claude-haiku-5-5", usage: u, at: new Date("2026-10-01T00:00:00Z") });
const topCost = cost(usage({}));

describe("Anthropic usage at the boundary", () => {
  test("iterations without the expected shape are dropped; with none left, the top-level usage counts", () => {
    expect(topCost).toBeGreaterThan(0);
    for (const iterations of [
      [null],
      [42],
      [{}],
      ["message"],
      [{ type: "message" }],
      [{ input_tokens: 5, output_tokens: 1 }],
    ]) {
      const u = usage({ iterations });
      expect(u.iterations).toBeUndefined();
      expect(cost(u)).toBeCloseTo(topCost, 12);
    }
  });

  test("a well-formed iteration next to broken ones is kept, and only it", () => {
    const u = usage({
      iterations: [
        null,
        { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 900, output_tokens: 400 },
        7,
      ],
    });
    expect(u.iterations).toEqual([
      {
        type: "advisor_message",
        model: "claude-opus-5-5",
        inputTokens: 900,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 400,
      },
    ]);
  });

  test("a token count that is not a non-negative integer is an invalid response, in every usage field", () => {
    const bad = [
      { input_tokens: -1_000_000 },
      { output_tokens: -1 },
      { input_tokens: 1.5 },
      { cache_read_input_tokens: -3 },
      { cache_creation_input_tokens: Number.NaN },
      { cache_creation: { ephemeral_1h_input_tokens: -10 } },
      { iterations: [{ type: "message", input_tokens: -5, output_tokens: 1 }] },
      { iterations: [{ type: "message", input_tokens: 5, output_tokens: 1, cache_read_input_tokens: -1 }] },
    ];
    for (const over of bad) {
      let thrown: unknown;
      try {
        usage(over);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ModelError);
      expect(thrown).toMatchObject({ code: "invalid_response" });
    }
  });
});

/** An SSE stream of the Messages API with one tool block, as the SDK reads it. */
function sseWithTool(block: Record<string, unknown>): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: top,
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", input: {}, ...block } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"text":"hi"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

async function turnFor(block: Record<string, unknown>): Promise<ModelEvent[]> {
  const fakeFetch = (async () =>
    new Response(sseWithTool(block), {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  const provider = anthropicProvider("sk-test", { fetch: fakeFetch });
  const out: ModelEvent[] = [];
  for await (const e of provider.stream({
    model: "claude-haiku-5-5",
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 100,
    signal: new AbortController().signal,
  }))
    out.push(e);
  return out;
}

describe("Anthropic tool blocks at the boundary", () => {
  test("a tool block with an id and a name reaches the turn", async () => {
    const turn = (await turnFor({ id: "toolu_1", name: "remember" })).at(-1);
    expect(turn?.type === "turn" && turn.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "remember", input: { text: "hi" } },
    ]);
  });

  test("a tool block without an id, or with an empty one, fails the turn instead of being run", async () => {
    for (const block of [{ name: "remember" }, { id: "", name: "remember" }, { id: "toolu_1" }]) {
      let thrown: unknown;
      try {
        await turnFor(block);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ModelError);
      expect(thrown).toMatchObject({ code: "invalid_response" });
    }
  });
});

/** Every field of the SDK's `Usage`, the nullable ones as `null`: `satisfies` breaks if the SDK adds one. */
const nullUsage = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  input_tokens: 10,
  output_tokens: 5,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
} satisfies Anthropic.Usage;

/** Every field of the SDK's `Usage` filled in. */
const fullUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 },
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 1000,
  inference_geo: "us",
  input_tokens: 10,
  output_tokens: 5,
  output_tokens_details: { thinking_tokens: 3 },
  server_tool_use: { web_fetch_requests: 1, web_search_requests: 2 },
  service_tier: "priority",
  speed: "fast",
} satisfies Anthropic.Usage;

/** Every field of the SDK's `Message`, with a text block (and a citation) and a tool block in full. */
const fullMessage = (usage: Anthropic.Usage, extra: Record<string, unknown> = {}) =>
  ({
    id: "msg_1",
    container: null,
    content: [
      {
        citations: [
          {
            cited_text: "cited",
            end_block_index: 1,
            search_result_index: 0,
            source: "/wiki/a",
            start_block_index: 0,
            title: null,
            type: "search_result_location",
          },
        ],
        text: "answer",
        type: "text",
        ...extra,
      },
      { citations: null, text: "more", type: "text" },
      {
        id: "toolu_1",
        caller: { type: "direct" },
        input: { text: "hi" },
        name: "remember",
        type: "tool_use",
        toolset_name: null,
        ...extra,
      },
    ],
    diagnostics: null,
    model: "claude-haiku-5-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage,
    ...extra,
  }) satisfies Anthropic.Message;

async function streamMessage(message: Record<string, unknown>): Promise<ModelEvent[]> {
  const events = [
    { type: "message_start", message },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const fakeFetch = (async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const out: ModelEvent[] = [];
  for await (const e of anthropicProvider("sk-test", { fetch: fakeFetch }).stream({
    model: "claude-haiku-5-5",
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 100,
    signal: new AbortController().signal,
  }))
    out.push(e);
  return out;
}

describe("the validation is never stricter than the SDK's types", () => {
  test("a usage with every SDK field, nullable ones as null or filled in, passes", () => {
    expect(usageOf(nullUsage)).toEqual({
      inputTokens: 10,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
    });
    expect(usageOf(fullUsage)).toEqual({
      inputTokens: 10,
      cachedTokens: 1000,
      cacheWriteTokens: 300,
      outputTokens: 5,
      cacheWrite1hTokens: 200,
      speed: "fast",
      inferenceGeo: "us",
      serviceTier: "priority",
    });
  });

  test("a field the SDK does not know is ignored, in the usage and in the message", async () => {
    expect(
      usageOf({ ...fullUsage, brand_new_counter: -7, brand_new_object: { x: null } } as Anthropic.Usage),
    ).toEqual(usageOf(fullUsage));
    for (const message of [fullMessage(nullUsage), fullMessage(fullUsage, { brand_new_field: { x: -1 } })]) {
      const turn = (await streamMessage(message)).at(-1);
      if (turn?.type !== "turn") throw new Error("no turn");
      expect(turn.content).toEqual([
        {
          type: "text",
          text: "answer",
          citations: [{ searchResultIndex: 0, source: "/wiki/a", title: null, citedText: "cited" }],
        },
        { type: "text", text: "more" },
        { type: "tool_use", id: "toolu_1", name: "remember", input: { text: "hi" } },
      ]);
    }
  });

  test("an unknown speed does not fail the turn, is kept, and is charged as fast", () => {
    const u = usageOf({ ...fullUsage, speed: "turbo" } as unknown as Anthropic.Usage);
    expect(u.speed).toBe("turbo");
    const at = new Date("2026-10-01T00:00:00Z");
    const opus = (speed: string) => costUsd(PRICES, { model: "claude-opus-5-5", usage: { ...u, speed }, at });
    expect(opus("turbo")).toBeCloseTo(opus("fast"), 12);
    expect(opus("turbo")).toBeGreaterThan(opus("standard"));
  });
});
