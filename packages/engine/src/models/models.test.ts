import { describe, expect, test } from "bun:test";
import { ADVISOR_BETA, anthropicProvider, usageOf } from "./anthropic";
import { advisorPairOk, callCostUsd } from "./catalog";
import { chunksOf, FAKE_ADVICE_TOKENS, fakeProvider } from "./fake";
import type { ModelEvent, ModelRequest } from "./types";

const req = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-haiku-5-5",
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
  maxTokens: 1000,
  signal: new AbortController().signal,
  ...extra,
});

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("fake provider", () => {
  test("answers in pieces and ends with the full turn", async () => {
    const events = await collect(fakeProvider().stream(req("Bia: @lia what is the status of order 42?")));
    expect(events[0]).toEqual({ type: "thinking" });
    const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    const turn = events.at(-1);
    if (turn?.type !== "turn") throw new Error("no turn");
    expect(turn.stop).toBe("end_turn");
    expect(turn.content).toEqual([{ type: "text", text }]);
    expect(text).toContain("what is the status of order 42?");
    expect(turn.usage.inputTokens).toBeGreaterThan(0);
  });

  test("as the assignment verifier it answers the JSON: passes, and fails what carries [[reject]]", async () => {
    const prompt = [
      "# Assignment: Guide",
      "## Deliverable p1: Draft\nDone when: text\n<evidence>\nWorker summary:\nDone\n</evidence>",
      "## Deliverable p1-fix1: Fix\nDone when: x\n<evidence>\nWorker summary:\n[[reject]]\n</evidence>",
    ].join("\n\n");
    const system = 'Answer with JSON only: {"verdicts":[{"id":"<id>","passes":true|false}]}';
    const events = await collect(fakeProvider().stream(req(prompt, { system })));
    const turn = events.at(-1);
    if (turn?.type !== "turn" || turn.content[0]?.type !== "text") throw new Error("no text");
    expect(
      JSON.parse(turn.content[0].text).verdicts.map((v: { id: string; passes: boolean }) => [v.id, v.passes]),
    ).toEqual([
      ["p1", true],
      ["p1-fix1", false],
    ]);
    // Outside the verifier role, the same text is only an echo.
    const plain = (await collect(fakeProvider().stream(req(prompt)))).at(-1);
    if (plain?.type !== "turn" || plain.content[0]?.type !== "text") throw new Error("no text");
    expect(plain.content[0].text).not.toContain("verdicts");
  });

  test("a tool directive becomes tool_use and the result becomes the answer", async () => {
    const p = fakeProvider();
    const events = await collect(p.stream(req('note [[tool:remember {"text":"customer pays by wire"}]]')));
    const turn = events.at(-1);
    if (turn?.type !== "turn") throw new Error("no turn");
    expect(turn.stop).toBe("tool_use");
    const call = turn.content.find((c) => c.type === "tool_use");
    if (call?.type !== "tool_use") throw new Error("no call");
    expect(call).toMatchObject({ name: "remember", input: { text: "customer pays by wire" } });

    const next = await collect(
      p.stream(
        req("", {
          messages: [
            { role: "user", content: [{ type: "text", text: "note" }] },
            { role: "assistant", content: turn.content },
            {
              role: "user",
              content: [{ type: "tool_result", toolUseId: call.id, content: "saved", isError: false }],
            },
          ],
        }),
      ),
    );
    const last = next.at(-1);
    if (last?.type !== "turn") throw new Error("no turn");
    expect(last.stop).toBe("end_turn");
    expect(last.content[0]).toEqual({ type: "text", text: "Saved to memory: customer pays by wire." });
  });

  test("failure, silence and cancellation", async () => {
    await expect(collect(fakeProvider().stream(req("[[fail]]")))).rejects.toMatchObject({
      code: "fake_failure",
    });
    const silent = await collect(fakeProvider().stream(req("[[silent]]")));
    const turn = silent.at(-1);
    expect(turn?.type === "turn" && turn.content).toEqual([]);
    const ctrl = new AbortController();
    const it = fakeProvider().stream(
      req("[[slow:50]] one two three four five six seven", { signal: ctrl.signal }),
    );
    const seen: ModelEvent[] = [];
    const run = (async () => {
      for await (const e of it) {
        seen.push(e);
        if (e.type === "text") ctrl.abort();
      }
    })();
    await expect(run).rejects.toBeDefined();
    expect(seen.filter((e) => e.type === "text")).toHaveLength(1);
  });

  test("pieces keep the text", () => {
    const text = "one two  three four\nfive";
    expect(chunksOf(text).join("")).toBe(text);
  });
});

describe("cost", () => {
  test("price per model, cache and Haiku's long prompt tier", () => {
    const u = { inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 };
    expect(callCostUsd("claude-opus-5-5", u)).toBeCloseTo(24);
    expect(callCostUsd("claude-sonnet-5-5", u)).toBeCloseTo(12);
    // Sonnet cache reads at the official 0.10/M: 1M read + 1M written (2 × 1.25) = 0.10 + 2.50.
    const cache = { inputTokens: 0, cachedTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 0 };
    expect(callCostUsd("claude-sonnet-5-5", cache)).toBeCloseTo(2.6, 6);
    // A 1M prompt is over 100k: the upper tier.
    expect(callCostUsd("claude-haiku-5-5", u)).toBeCloseTo(3);
    const small = { inputTokens: 50_000, cachedTokens: 40_000, cacheWriteTokens: 8_000, outputTokens: 1_000 };
    // 50k*0.10 + 8k*0.10*1.25 + 40k*0.01 + 1k*0.50 = 5000+1000+400+500 = 6900 / 1e6
    expect(callCostUsd("claude-haiku-5-5", small)).toBeCloseTo(0.0069, 6);
  });
});

describe("Anthropic API usage in the ledger", () => {
  test("1 h cache, fast mode, region and the advisor iterations", () => {
    const u = usageOf({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      speed: "fast",
      inference_geo: "us",
      service_tier: "standard",
      iterations: [
        { type: "message", input_tokens: 100, output_tokens: 20 },
        { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 900, output_tokens: 400 },
      ],
    } as unknown as Parameters<typeof usageOf>[0]);
    expect(u).toEqual({
      inputTokens: 100,
      cachedTokens: 1000,
      cacheWriteTokens: 300,
      outputTokens: 50,
      cacheWrite1hTokens: 200,
      speed: "fast",
      inferenceGeo: "us",
      serviceTier: "standard",
      iterations: [
        { type: "message", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
        {
          type: "advisor_message",
          model: "claude-opus-5-5",
          inputTokens: 900,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 400,
        },
      ],
    });
  });
});

/** An SSE response of the Messages API: a text block, an advisor call and the usage with iterations. */
function sseWithAdvisor(): string {
  const events: [string, unknown][] = [
    [
      "message_start",
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
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "advisor_tool_result",
          tool_use_id: "srvtoolu_1",
          content: { type: "advisor_redacted_result", encrypted_content: "x", stop_reason: "end_turn" },
        },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    [
      "content_block_start",
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "done" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 2 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          iterations: [
            { type: "message", input_tokens: 10, output_tokens: 2 },
            { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 40, output_tokens: 30 },
            { type: "message", input_tokens: 50, output_tokens: 3 },
          ],
        },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("advisor", () => {
  test("valid pairs: Haiku consults Opus; Sonnet, Opus and an inverted pair do not", () => {
    expect(advisorPairOk("claude-haiku-5-5", "claude-opus-5-5")).toBe(true);
    expect(advisorPairOk("claude-haiku-5-5", "claude-sonnet-5-5")).toBe(false);
    expect(advisorPairOk("claude-sonnet-5-5", "claude-opus-5-5")).toBe(false);
    expect(advisorPairOk("claude-opus-5-5", "claude-opus-5-5")).toBe(false);
    expect(advisorPairOk("claude-opus-5-5", "claude-haiku-5-5")).toBe(false);
    expect(advisorPairOk("claude-sonnet-5-5", "claude-haiku-5-5")).toBe(false);
  });

  test("on the wire: the advisor_20260301 tool with the beta header; without an advisor, none of it", async () => {
    const seen: { beta: string | null; tools: unknown[] }[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({ beta: headers.get("anthropic-beta"), tools: JSON.parse(String(init.body)).tools });
      return new Response(sseWithAdvisor(), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const provider = anthropicProvider("sk-test", { fetch: fakeFetch });
    const advisor = { model: "claude-opus-5-5", maxUses: 2, maxTokens: 2048 };
    const events = await collect(provider.stream(req("hi", { advisor })));
    expect(seen[0]?.beta).toContain(ADVISOR_BETA);
    expect(seen[0]?.tools).toContainEqual({
      type: "advisor_20260301",
      name: "advisor",
      model: "claude-opus-5-5",
      max_uses: 2,
      max_tokens: 2048,
      caching: { type: "ephemeral" },
    });
    const turn = events.find((e) => e.type === "turn");
    if (turn?.type !== "turn") throw new Error("no turn");
    // The encrypted block comes back in raw (repeated unchanged in the next turn) and the cost comes in the iterations.
    expect((turn.raw as { type: string }[]).map((b) => b.type)).toEqual([
      "server_tool_use",
      "advisor_tool_result",
      "text",
    ]);
    expect(turn.content).toEqual([{ type: "text", text: "done" }]);
    expect(turn.usage.iterations?.map((i) => [i.type, i.model ?? null])).toEqual([
      ["message", null],
      ["advisor_message", "claude-opus-5-5"],
      ["message", null],
    ]);

    await collect(provider.stream(req("hi")));
    expect(seen[1]?.beta ?? "").not.toContain(ADVISOR_BETA);
    expect(JSON.stringify(seen[1]?.tools)).not.toContain("advisor");
  });

  test("fake provider: [[advise]] becomes an advisor call only with an advisor, up to maxUses", async () => {
    const provider = fakeProvider();
    const turnOf = async (r: ModelRequest) => {
      const t = (await collect(provider.stream(r))).find((e) => e.type === "turn");
      if (t?.type !== "turn") throw new Error("no turn");
      return t;
    };
    const without = await turnOf(req("plan [[advise]]"));
    expect(without.usage.iterations).toBeUndefined();
    const advisor = { model: "claude-opus-5-5", maxUses: 2, maxTokens: 2048 };
    const once = await turnOf(req("plan [[advise]]", { advisor }));
    expect(once.usage.iterations?.map((i) => i.type)).toEqual(["message", "advisor_message"]);
    expect(once.usage.iterations?.[1]).toMatchObject({
      model: "claude-opus-5-5",
      outputTokens: FAKE_ADVICE_TOKENS,
    });
    const capped = await turnOf(req("[[advise]] [[advise]] [[advise]]", { advisor }));
    expect(capped.usage.iterations?.filter((i) => i.type === "advisor_message")).toHaveLength(2);
    // The directive does not show up in the speech.
    expect(once.content).toEqual([{ type: "text", text: expect.not.stringContaining("advise") }]);
  });
});
