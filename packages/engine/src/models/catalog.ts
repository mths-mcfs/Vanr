// Models offered to agents and the cost of each call.
// Prices in USD per million tokens (October 2026 reference). Writing to the 5 min cache costs 1.25x the input.
import type { Usage } from "./types";

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

interface CatalogModel {
  id: string;
  label: string;
  price: ModelPrice;
  /** Haiku charges more when the call's prompt goes over 100k tokens. */
  longPrompt?: { above: number; price: ModelPrice };
  recommended?: boolean;
}

export const MODELS: readonly CatalogModel[] = [
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
    longPrompt: { above: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
    recommended: true,
  },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", price: { input: 2, output: 10, cacheRead: 0.2 } },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", price: { input: 4, output: 20, cacheRead: 0.2 } },
];

export const DEFAULT_MODEL = "claude-haiku-5-5";

/**
 * Advisors each executor accepts, within the catalog (the API's pair table, October 2026). The advisor
 * has to be at least as capable as the executor; an equal pair does not help and is left out. Opus has
 * no advisor here: the only model more capable than it is outside the catalog.
 */
export const ADVISOR_PAIRS: Readonly<Record<string, readonly string[]>> = {
  "claude-haiku-5-5": ["claude-opus-5-5", "claude-sonnet-5-5"],
  "claude-sonnet-5-5": ["claude-opus-5-5"],
};
/** Ceiling of advisor calls in one request. */
export const ADVISOR_MAX_USES = 5;
/** Output of each advisor call (the advice is short: a plan, a change of course). */
export const ADVISOR_MAX_TOKENS = 2048;

export function advisorPairOk(executor: string, advisor: string): boolean {
  return ADVISOR_PAIRS[executor]?.includes(advisor) ?? false;
}
const CACHE_WRITE_FACTOR = 1.25;

export function findModel(id: string): CatalogModel | null {
  return MODELS.find((m) => m.id === id) ?? null;
}

/** Cost of a call. The long prompt tier applies per call, not to the run's total. */
export function callCostUsd(modelId: string, usage: Usage): number {
  const model = findModel(modelId) ?? findModel(DEFAULT_MODEL);
  if (!model) return 0;
  const prompt = usage.inputTokens + usage.cachedTokens + usage.cacheWriteTokens;
  const p = model.longPrompt && prompt > model.longPrompt.above ? model.longPrompt.price : model.price;
  const usd =
    usage.inputTokens * p.input +
    usage.cacheWriteTokens * p.input * CACHE_WRITE_FACTOR +
    usage.cachedTokens * p.cacheRead +
    usage.outputTokens * p.output;
  return usd / 1_000_000;
}
