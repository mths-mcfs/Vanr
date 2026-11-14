// Usage ledger and caps. Every model call reserves budget first (reserve) and writes a ledger line
// afterwards (settle). The cap blocks: the reservation is atomic across every scope (agent in the month,
// channel, assignment, routine run), so two runs in parallel never cross the limit together.
//
// The Postgres ledger lives in the server; the dated price table is models/prices.ts. Routines, search,
// assignments, debates and the team and cost pages use it. Every implementation passes the same contract
// test (usage-contract.ts); memoryLedger() is the reference one.
import type { Usage, UsageIteration } from "./models/types";

/** Where the call came from: splits the cost by feature in the ledger. */
export type UsageSource =
  | "chat"
  | "routine"
  | "assignment"
  | "debate"
  | "search"
  | "memory"
  | "advisor"
  | "issue"
  | "delegation"
  /** The model reviewer of approvals. */
  | "review"
  | "other";

/** Who pays for the call: the platform key, the workspace key (`credentialId`) or the environment's plan. */
export type KeySource = "platform" | "workspace" | "plan";

export interface ModelCall {
  workspaceId: string;
  /** Agent that made the call (null: a platform call, e.g. search embeddings). */
  agentId: string | null;
  /** Person on whose behalf the work was requested. */
  userId: string | null;
  runId: string | null;
  channelId?: string | null;
  assignmentId?: string | null;
  source: UsageSource;
  model: string;
  usage: Usage;
  /** Batch API: half price. */
  batch?: boolean;
  /** The environment's plan (Claude Code/Codex): costs nothing here. Default: platform. */
  keySource?: KeySource;
  at: Date;
}

/** One ledger line: the whole call or one iteration of it (the advisor gets a line of its own). */
export interface UsageLine extends Omit<ModelCall, "usage"> {
  /** Position in the call (0 without iterations): with the reservation, the key that makes settle idempotent. */
  seq: number;
  /** Iteration type (`message` when the API does not split them). */
  iteration: string;
  inputTokens: number;
  cachedTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  /** As the provider sent it: `standard`, `fast` or a value this version does not know. */
  speed: string;
  inferenceGeo: string | null;
  serviceTier: string | null;
  costUsd: number;
  /** Price version used (`model@date`); null when the model has no price on that date. */
  priceVersion: string | null;
}

/** A cap scope. `month`: spend counts from the first day of the month (UTC) of `at`. */
export interface BudgetScope {
  kind: "agent" | "channel" | "assignment" | "routine_run" | "debate";
  id: string;
  limitUsd: number;
  period: "month" | "total";
}

/** A reservation open for longer than this no longer holds the cap (a process died between reserve and write). */
export const RESERVATION_TTL_MS = 30 * 60_000;

export interface Reservation {
  id: string;
  workspaceId: string;
  scopes: readonly BudgetScope[];
  estimateUsd: number;
  at: Date;
  expiresAt: Date;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; scope: BudgetScope; spentUsd: number; reservedUsd: number; limitUsd: number };

export interface UsageLedger {
  /** Reserves `estimateUsd` in every scope, or in none. Rejects if any would cross its limit. */
  reserve(req: {
    workspaceId: string;
    scopes: readonly BudgetScope[];
    estimateUsd: number;
    at: Date;
  }): Promise<ReserveResult>;
  /** Writes the call to the ledger at its real cost and frees the reservation. Calling twice writes once. */
  settle(reservation: Reservation, call: ModelCall): Promise<{ costUsd: number }>;
  /** The call did not happen: frees the reservation without recording a cost. */
  release(reservation: Reservation): Promise<void>;
  /**
   * Writes without a reservation and without checking the limit: a call that does not go through the cap
   * (the environment's plan, which costs 0 here). The cost, if any, counts toward the scopes' spend.
   */
  record(call: ModelCall, scopes: readonly BudgetScope[]): Promise<{ costUsd: number }>;
  /** Spend already recorded in the scope, in the period of `at` (without the open reservations). */
  spent(scope: BudgetScope, at: Date): Promise<number>;
}

/** A model's price in force on a date (USD per million tokens). */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** Writing to the 5 min cache (1.25x the input) and to the 1 h one (2x). */
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Long prompt tier (Haiku above 100k), per call. */
  longPrompt?: { above: number; price: TokenPrice };
  /** Fast mode multiplier (`speed: fast`). Without it, the model has no fast mode. */
  fast?: number;
  /** US-only inference multiplier (`inference_geo: us`). */
  usGeo?: number;
  /** `model@date` of the table row: goes to the ledger, to recompute if the price changes. */
  version?: string;
}

export type TokenPrice = Pick<Price, "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h">;

export interface PriceBook {
  /** Price in force at `at`. null when the model has no price on that date. */
  at(model: string, at: Date): Price | null;
}

/** A price table row: valid from `from` (UTC date, inclusive) until the next row of the same model. */
export interface DatedPrice {
  model: string;
  from: string;
  price: Omit<Price, "version">;
}

/** A table versioned by date: a call's price is the one of the row in force on its day. */
export function datedPriceBook(rows: readonly DatedPrice[]): PriceBook {
  const byModel = new Map<string, { from: number; row: DatedPrice }[]>();
  for (const row of rows) {
    const from = Date.parse(`${row.from}T00:00:00Z`);
    if (!Number.isFinite(from)) throw new Error(`datedPriceBook: bad date ${row.from}`);
    const list = byModel.get(row.model) ?? [];
    list.push({ from, row });
    byModel.set(row.model, list);
  }
  for (const list of byModel.values()) list.sort((a, b) => a.from - b.from);
  return {
    at(model, at) {
      const list = byModel.get(model);
      if (!list) return null;
      let hit: DatedPrice | null = null;
      for (const r of list) if (r.from <= at.getTime()) hit = r.row;
      return hit && { ...hit.price, version: `${hit.model}@${hit.from}` };
    },
  };
}

type Tokens = Pick<UsageIteration, "inputTokens" | "cachedTokens" | "cacheWriteTokens" | "outputTokens"> & {
  cacheWrite1hTokens?: number;
};

function tokenCost(price: Price, t: Tokens, mult: number): number {
  const prompt = t.inputTokens + t.cachedTokens + t.cacheWriteTokens;
  const p: TokenPrice = price.longPrompt && prompt > price.longPrompt.above ? price.longPrompt.price : price;
  const write1h = Math.min(t.cacheWrite1hTokens ?? 0, t.cacheWriteTokens);
  const usd =
    t.inputTokens * p.input +
    (t.cacheWriteTokens - write1h) * p.cacheWrite5m +
    write1h * p.cacheWrite1h +
    t.cachedTokens * p.cacheRead +
    t.outputTokens * p.output;
  return (mult * usd) / 1_000_000;
}

function multiplier(price: Price, call: Pick<ModelCall, "usage" | "batch">): number {
  let m = call.batch ? 0.5 : 1;
  // An unknown speed is charged as the dearest known mode (fast), so the budget errs upward, never down.
  const speed = call.usage.speed ?? "standard";
  if (speed !== "standard") m *= price.fast ?? 1;
  if (call.usage.inferenceGeo === "us") m *= price.usGeo ?? 1;
  return m;
}

/**
 * The lines a call writes to the ledger, each with its cost. Without iterations, one line. With
 * iterations (advisor, compaction, fallback), one per iteration, each with the model that ran it: the
 * top-level `usage` covers only the executor.
 */
export function usageLines(book: PriceBook, call: ModelCall): UsageLine[] {
  const { usage, ...rest } = call;
  const parts: (Tokens & { type: string; model: string })[] = usage.iterations?.length
    ? usage.iterations.map((it) => ({ ...it, model: it.model ?? call.model }))
    : [{ ...usage, type: "message", model: call.model }];
  return parts.map((part, seq) => {
    const price = book.at(part.model, call.at);
    const free = call.keySource === "plan";
    return {
      ...rest,
      model: part.model,
      source: part.type === "advisor_message" ? "advisor" : call.source,
      seq,
      iteration: part.type,
      inputTokens: part.inputTokens,
      cachedTokens: part.cachedTokens,
      cacheWrite5mTokens:
        part.cacheWriteTokens - Math.min(part.cacheWrite1hTokens ?? 0, part.cacheWriteTokens),
      cacheWrite1hTokens: Math.min(part.cacheWrite1hTokens ?? 0, part.cacheWriteTokens),
      outputTokens: part.outputTokens,
      speed: usage.speed ?? "standard",
      inferenceGeo: usage.inferenceGeo ?? null,
      serviceTier: usage.serviceTier ?? null,
      costUsd: !price || free ? 0 : tokenCost(price, part, multiplier(price, call)),
      priceVersion: price?.version ?? null,
    };
  });
}

/** A call's cost at the price in force on its date (the sum of its lines). */
export function costUsd(
  book: PriceBook,
  call: Pick<ModelCall, "model" | "usage" | "batch" | "at" | "keySource">,
): number {
  const lines = usageLines(book, {
    ...call,
    workspaceId: "",
    agentId: null,
    userId: null,
    runId: null,
    source: "other",
  });
  return lines.reduce((sum, l) => sum + l.costUsd, 0);
}

/** UTF-8 bytes of a text, without copying. It bounds the tokens: every token covers at least one byte. */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * The cap of the next call before it happens: the worst case. Prompt tokens = UTF-8 bytes (there are
 * never more tokens than bytes; counting characters / 3 was wrong for code, CJK and emoji and could cross
 * Haiku's long tier without reserving for it), all written to the 5 min cache (the cache may have expired
 * during a wait), output up to `maxTokens`, and the US region surcharge. Overestimating only blocks
 * earlier; underestimating would let the cap be crossed. Holds while the runtime only uses the 5 min cache.
 */
export function estimateUsd(
  book: PriceBook,
  req: { model: string; promptBytes: number; maxTokens: number; at: Date; speed?: "fast" },
): number {
  return costUsd(book, {
    model: req.model,
    at: req.at,
    usage: {
      inputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: Math.max(0, Math.ceil(req.promptBytes)),
      outputTokens: req.maxTokens,
      inferenceGeo: "us",
      ...(req.speed ? { speed: req.speed } : {}),
    },
  });
}

export function periodStart(scope: BudgetScope, at: Date): Date | null {
  return scope.period === "month" ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)) : null;
}

/** Key of the scope's period at `at`: `2026-10` for the month, `total` for the total. */
export function periodKey(scope: Pick<BudgetScope, "period">, at: Date): string {
  return scope.period === "month"
    ? `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`
    : "total";
}

const scopeKey = (s: BudgetScope) => `${s.kind}:${s.id}`;

/** In-memory ledger: the contract's reference and the double in tests of code that only uses the interface. */
export function memoryLedger(book: PriceBook): UsageLedger & { lines: UsageLine[] } {
  const lines: (UsageLine & { scopes: readonly BudgetScope[] })[] = [];
  const open = new Map<string, Reservation>();
  const settled = new Set<string>();
  let seq = 0;

  const spentIn = (scope: BudgetScope, at: Date) => {
    const from = periodStart(scope, at);
    return lines
      .filter((l) => l.scopes.some((s) => scopeKey(s) === scopeKey(scope)) && (!from || l.at >= from))
      .reduce((sum, l) => sum + l.costUsd, 0);
  };
  const reservedIn = (scope: BudgetScope, at: Date) => {
    const from = periodStart(scope, at);
    let sum = 0;
    for (const r of open.values())
      if (
        r.scopes.some((s) => scopeKey(s) === scopeKey(scope)) &&
        (!from || r.at >= from) &&
        r.expiresAt > at
      )
        sum += r.estimateUsd;
    return sum;
  };
  const write = (call: ModelCall, scopes: readonly BudgetScope[]) => {
    const out = usageLines(book, call);
    for (const l of out) lines.push({ ...l, scopes });
    return out.reduce((sum, l) => sum + l.costUsd, 0);
  };

  return {
    lines,
    // No await between reading and reserving: on the event loop that is already atomic.
    async reserve({ workspaceId, scopes, estimateUsd, at }) {
      for (const scope of scopes) {
        const spentUsd = spentIn(scope, at);
        const reservedUsd = reservedIn(scope, at);
        if (spentUsd + reservedUsd + estimateUsd > scope.limitUsd)
          return { ok: false, scope, spentUsd, reservedUsd, limitUsd: scope.limitUsd };
      }
      const reservation: Reservation = {
        id: `res_${++seq}`,
        workspaceId,
        scopes,
        estimateUsd,
        at,
        expiresAt: new Date(at.getTime() + RESERVATION_TTL_MS),
      };
      open.set(reservation.id, reservation);
      return { ok: true, reservation };
    },
    async settle(reservation, call) {
      if (settled.has(reservation.id)) return { costUsd: costUsd(book, call) };
      settled.add(reservation.id);
      open.delete(reservation.id);
      return { costUsd: write(call, reservation.scopes) };
    },
    async release(reservation) {
      open.delete(reservation.id);
    },
    async record(call, scopes) {
      return { costUsd: write(call, scopes) };
    },
    async spent(scope, at) {
      return spentIn(scope, at);
    },
  };
}
