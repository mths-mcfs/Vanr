import { expect, test } from "bun:test";
import { ADVISOR_PAIRS, advisorPairOk, callCostUsd } from "./catalog";
import { emptyUsage } from "./types";

test("advisor pairs only see their own keys", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    expect(advisorPairOk(name, "claude-opus-5-5")).toBe(false);
    expect(ADVISOR_PAIRS[name]).toBeUndefined();
  }
  expect(advisorPairOk("claude-haiku-5-5", "claude-opus-5-5")).toBe(true);
});

test("catalog charges advisor iterations, one-hour cache and pricing multipliers", () => {
  const usage = {
    ...emptyUsage(),
    outputTokens: 1000,
    iterations: [
      { ...emptyUsage(), type: "message", outputTokens: 1000 },
      {
        ...emptyUsage(),
        type: "advisor_message",
        model: "claude-opus-5-5",
        outputTokens: 1000,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
        speed: "fast",
        inferenceGeo: "us",
      },
    ],
  };
  // Haiku output: 0.0005. Advisor: (8 cache + 0.02 output) * 2 fast * 1.1 US.
  expect(callCostUsd("claude-haiku-5-5", usage)).toBeCloseTo(17.6445, 10);
});
