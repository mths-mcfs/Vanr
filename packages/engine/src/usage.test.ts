import { describe, expect, test } from "bun:test";
import { MODELS } from "./models/catalog";
import { PRICE_TABLE, PRICES } from "./models/prices";
import { costUsd, datedPriceBook, estimateUsd, memoryLedger, usageLines, utf8Bytes } from "./usage";
import { CONTRACT_PRICES, ledgerContract } from "./usage-contract";

ledgerContract("memory", () => memoryLedger(CONTRACT_PRICES));

const at = new Date("2026-10-22T00:00:00Z");
const usage = (input: number, output = 1000) => ({
  inputTokens: input,
  outputTokens: output,
  cachedTokens: 0,
  cacheWriteTokens: 0,
});

describe("price per call", () => {
  test("Haiku's long prompt tier applies per call; batch at half price", () => {
    // 100k input: 0.10/M → 0.01 + 1k output at 0.50/M → 0.0005.
    expect(costUsd(PRICES, { model: "claude-haiku-5-5", usage: usage(100_000), at })).toBeCloseTo(0.0105, 6);
    // 100,001: the long tier (0.50 and 2.50).
    expect(costUsd(PRICES, { model: "claude-haiku-5-5", usage: usage(100_001), at })).toBeCloseTo(0.0525, 4);
    expect(
      costUsd(PRICES, { model: "claude-haiku-5-5", usage: usage(100_000), at, batch: true }),
    ).toBeCloseTo(0.00525, 6);
    expect(costUsd(PRICES, { model: "no-such-model", usage: usage(1), at })).toBe(0);
  });

  test("the 1 h cache costs 2x the input; the 5 min one, 1.25x", () => {
    const u = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 1_000_000 };
    expect(costUsd(PRICES, { model: "claude-opus-5-5", usage: u, at })).toBeCloseTo(5);
    expect(
      costUsd(PRICES, { model: "claude-opus-5-5", usage: { ...u, cacheWrite1hTokens: 1_000_000 }, at }),
    ).toBeCloseTo(8);
    expect(
      costUsd(PRICES, { model: "claude-opus-5-5", usage: { ...u, cacheWrite1hTokens: 400_000 }, at }),
    ).toBeCloseTo(0.6 * 5 + 0.4 * 8);
  });

  test("Opus 5.5 fast mode costs 2x; US inference, 1.1x", () => {
    const u = usage(1_000_000, 1_000_000);
    expect(costUsd(PRICES, { model: "claude-opus-5-5", usage: u, at })).toBeCloseTo(24);
    expect(costUsd(PRICES, { model: "claude-opus-5-5", usage: { ...u, speed: "fast" }, at })).toBeCloseTo(48);
    expect(
      costUsd(PRICES, { model: "claude-opus-5-5", usage: { ...u, inferenceGeo: "us" }, at }),
    ).toBeCloseTo(26.4);
    // No fast mode on the model: the field does not change the price.
    expect(costUsd(PRICES, { model: "claude-sonnet-5-5", usage: { ...u, speed: "fast" }, at })).toBeCloseTo(
      12,
    );
  });

  test("Sonnet 5.5 is priced at 2 in, 10 out and 0.10 per million cache reads", () => {
    const u = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    expect(costUsd(PRICES, { model: "claude-sonnet-5-5", usage: u, at })).toBeCloseTo(12.1, 6);
    expect(PRICES.at("claude-sonnet-5-5", at)).toMatchObject({ input: 2, output: 10, cacheRead: 0.1 });
  });

  test("the environment's plan costs nothing", () => {
    expect(
      costUsd(PRICES, { model: "claude-opus-5-5", usage: usage(1_000_000), at, keySource: "plan" }),
    ).toBe(0);
  });

  test("advisor: one line per iteration, with its model and the advisor source", () => {
    const lines = usageLines(PRICES, {
      workspaceId: "o",
      agentId: "a",
      userId: "u",
      runId: "r",
      source: "chat",
      model: "claude-haiku-5-5",
      at,
      usage: {
        ...usage(10_000),
        iterations: [
          { type: "message", inputTokens: 10_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 },
          {
            type: "advisor_message",
            model: "claude-opus-5-5",
            inputTokens: 30_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 700,
          },
        ],
      },
    });
    expect(lines.map((l) => [l.seq, l.model, l.source, l.iteration])).toEqual([
      [0, "claude-haiku-5-5", "chat", "message"],
      [1, "claude-opus-5-5", "advisor", "advisor_message"],
    ]);
    // 30,000 × 4 / 1M + 700 × 20 / 1M = 0.134.
    expect(lines[1]?.costUsd).toBeCloseTo(0.134, 6);
    expect(lines[1]?.priceVersion).toBe("claude-opus-5-5@2026-01-01");
  });
});

describe("table versioned by date", () => {
  const book = datedPriceBook([
    {
      model: "m",
      from: "2026-01-01",
      price: { input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
    {
      model: "m",
      from: "2026-11-01",
      price: { input: 2, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
  ]);
  const u = usage(1_000_000, 0);

  test("each call pays the price of its day", () => {
    expect(costUsd(book, { model: "m", usage: u, at: new Date("2026-10-31T23:59:59Z") })).toBeCloseTo(1);
    expect(costUsd(book, { model: "m", usage: u, at: new Date("2026-11-01T00:00:00Z") })).toBeCloseTo(2);
    expect(book.at("m", new Date("2025-12-31T23:59:59Z"))).toBeNull();
    expect(book.at("m", new Date("2026-11-02T00:00:00Z"))?.version).toBe("m@2026-11-01");
  });

  test("the last row of each model is the catalog price (the screen shows the same)", () => {
    for (const m of MODELS) {
      const p = PRICES.at(m.id, new Date("2100-01-01T00:00:00Z"));
      expect(p && { input: p.input, output: p.output, cacheRead: p.cacheRead }).toEqual(m.price);
      expect(PRICE_TABLE.some((r) => r.model === m.id)).toBe(true);
    }
  });
});

describe("estimate before the call", () => {
  test("covers the worst case: one token per byte, everything written to the cache, output up to the max, US region", () => {
    const est = estimateUsd(PRICES, {
      model: "claude-opus-5-5",
      promptBytes: 300_000,
      maxTokens: 16_000,
      at,
    });
    // (300k tokens at 5/M for the 5 min write + 16k at 20/M) × 1.1 = (1.5 + 0.32) × 1.1.
    expect(est).toBeCloseTo(2.002, 6);
    expect(
      estimateUsd(PRICES, { model: "claude-opus-5-5", promptBytes: 0, maxTokens: 16_000, at, speed: "fast" }),
    ).toBeCloseTo(0.32 * 1.1 * 2, 6);
  });

  test("UTF-8 bytes: ASCII 1, accent 2, CJK 3, emoji 4", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("ação")).toBe(6);
    expect(utf8Bytes("日本")).toBe(6);
    expect(utf8Bytes("👍")).toBe(4);
    expect(utf8Bytes("👍👍")).toBe(new TextEncoder().encode("👍👍").length);
  });

  // Oracle: any real call whose prompt has at most one token per byte costs at most the reservation.
  test("fuzz: the real cost never exceeds the reservation (mixed text, Haiku's long tier, region)", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pieces = ["a", "código ", '{"k":1}', "日本語", "👍", "\n", "ção"];
    for (let i = 0; i < 300; i++) {
      const model = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"][i % 3] as string;
      const parts: string[] = [];
      const size = Math.floor(rand() * 60_000);
      for (let j = 0; j < size; j++) parts.push(pieces[Math.floor(rand() * pieces.length)] as string);
      const text = parts.join("");
      const bytes = utf8Bytes(text);
      const maxTokens = 1 + Math.floor(rand() * 16_000);
      const est = estimateUsd(PRICES, { model, promptBytes: bytes, maxTokens, at });
      // Real tokens between 1 per character and 1 per byte, split across input, cache read and cache write.
      const tokens = Math.ceil(text.length + rand() * (bytes - text.length));
      const cached = Math.floor(rand() * tokens);
      const write = Math.floor(rand() * (tokens - cached));
      const real = costUsd(PRICES, {
        model,
        at,
        usage: {
          inputTokens: tokens - cached - write,
          cachedTokens: cached,
          cacheWriteTokens: write,
          outputTokens: Math.floor(rand() * maxTokens),
          ...(rand() < 0.5 ? { inferenceGeo: "us" } : {}),
        },
      });
      expect(real).toBeLessThanOrEqual(est + 1e-12);
    }
  });

  test("the case that broke through: 290 thousand characters that become 101 thousand tokens on Haiku", () => {
    const est = estimateUsd(PRICES, { model: "claude-haiku-5-5", promptBytes: 290_000, maxTokens: 8000, at });
    const real = costUsd(PRICES, {
      model: "claude-haiku-5-5",
      at,
      usage: {
        inputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 101_000,
        outputTokens: 8000,
        inferenceGeo: "us",
      },
    });
    expect(real).toBeLessThanOrEqual(est);
  });

  test("memory: N reservations of the estimate never exceed the cap, even when spending all of it", async () => {
    const ledger = memoryLedger(PRICES);
    const scope = { kind: "agent" as const, id: "a", limitUsd: 1, period: "month" as const };
    const est = estimateUsd(PRICES, {
      model: "claude-haiku-5-5",
      promptBytes: 30_000,
      maxTokens: 16_000,
      at,
    });
    const rs = await Promise.all(
      Array.from({ length: 200 }, () =>
        ledger.reserve({ workspaceId: "o", scopes: [scope], estimateUsd: est, at }),
      ),
    );
    const ok = rs.filter((r) => r.ok);
    expect(ok.length).toBe(Math.floor(1 / est));
    expect(ok.length * est).toBeLessThanOrEqual(1);
  });
});
