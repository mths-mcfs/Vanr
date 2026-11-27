// The debate benchmark, part A (accuracy): questions with an answer key, the three methods on the same item and the
// paired comparison. One debate per item: a single agent's answer is the lead's round 0, the vote is round 0's
// majority and the debate is the last round's majority. The three come from the same samples, so the difference
// debate − vote measures only the effect of the challenge rounds (Choi et al., 2025).
//
// With the simulated provider (below), the number measures the plumbing and the simulation's model, not an LLM.
// Every turn is a runtime `complete`.
//
// Part B (the decision) is the metrics of `GET debates/metrics`: a verdict accepted and reverted, a claim that
// changed and the blind read.
import { schema } from "@vanr/engine/db";
import {
  benchmarkDefault,
  normalizeAnswer,
  type PairedComparison,
  pairedComparison,
  seededRng,
} from "@vanr/engine/debate-protocol";
import {
  emptyUsage,
  type ModelContent,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@vanr/engine/models/types";
import { eq, inArray } from "drizzle-orm";
import { type AppDeps } from "./context";
import { openDebate } from "./debates";

export interface BenchmarkItem {
  id: string;
  question: string;
  /** The right answer (compared after normalizing). */
  answer: string;
}

/** Arithmetic with an answer key (Du et al.'s set: a·b + c − d·e), reproducible by the seed. */
export function arithmeticItems(n: number, seed = "debate-benchmark"): BenchmarkItem[] {
  const rng = seededRng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  return Array.from({ length: n }, (_, i) => {
    const [a, b, c, d, e] = [int(2, 29), int(2, 29), int(2, 99), int(2, 29), int(2, 29)];
    return {
      id: `arith-${i}`,
      question: `What is ${a}*${b}+${c}-${d}*${e}? Answer with the number only.`,
      answer: String(a * b + c - d * e),
    };
  });
}

/** A sum with + − × and integers, with multiplication's precedence (no eval). */
function arithmetic(expr: string): number {
  let total = 0;
  for (const m of expr.replace(/\s+/g, "").matchAll(/([+-]?)(\d+(?:\*\d+)*)/g)) {
    const product = (m[2] as string).split("*").reduce((p, x) => p * Number(x), 1);
    total += m[1] === "-" ? -product : product;
  }
  return total;
}

// ---- the simulated provider ----

const textEvents = (text: string, req: ModelRequest): AsyncIterable<ModelEvent> => ({
  async *[Symbol.asyncIterator]() {
    const content: ModelContent[] = [{ type: "text", text }];
    const usage = {
      ...emptyUsage(),
      inputTokens: Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
    yield { type: "text", text };
    yield { type: "turn", content, raw: null, stop: "end_turn", usage };
  },
});

/** A provider that answers with the text the function returns (tests and simulation). */
export function textProvider(reply: (req: ModelRequest) => string | Promise<string>): ModelProvider {
  return {
    kind: "fake",
    stream(req) {
      const stream = async function* () {
        yield* textEvents(await reply(req), req);
      };
      return stream();
    },
  };
}

const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("") ?? "";

/**
 * A simulated panel: each agent gets the sum right with probability `accuracy` (a fixed draw per agent and item) and
 * misses by a small offset; in a challenge round, with probability `conformity`, it adopts the most common answer
 * among the others' (Wynn et al.: the isolated agent gives in). It isn't an LLM: it proves the benchmark measures,
 * and shows what the owner's rule decides in each scenario.
 */
export function simulatedPanel(opts: { accuracy: number; conformity: number; seed?: string }): ModelProvider {
  const seed = opts.seed ?? "panel";
  return textProvider((req) => {
    const prompt = lastText(req);
    const goal = /<goal>\n([\s\S]*?)\n<\/goal>/.exec(req.system)?.[1] ?? "";
    // The seed comes from the agent's name (the pseudonym changes with each debate): the same simulated agent misses
    // the same items in every scenario, and the scenarios stay paired with each other.
    const me = /^You are (.+?) \(@/.exec(req.system)?.[1] ?? "?";
    if (prompt.startsWith("Write the synthesis"))
      return JSON.stringify({ summary: "simulated", decision: "" });
    const expr = /What is ([0-9*+\- ]+)\?/.exec(goal)?.[1];
    const truth = expr ? arithmetic(expr) : 0;
    const round = Number(/^Round (\d+)/.exec(prompt)?.[1] ?? 0);
    const rng = seededRng(`${seed}:${me}:${goal}`);
    const correct = rng() < opts.accuracy;
    const own = correct ? truth : truth + (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 3));
    let answer = own;
    if (round > 0) {
      const mine = /<position from="You">\nanswer: (-?\d+)/.exec(req.system)?.[1];
      const others = [
        ...req.system.matchAll(/<position from="Participant [A-Z0-9]+">\nanswer: (-?\d+)/g),
      ].map((m) => Number(m[1]));
      answer = mine !== undefined ? Number(mine) : own;
      const counts = new Map<number, number>();
      for (const o of others) counts.set(o, (counts.get(o) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const turn = seededRng(`${seed}:${me}:${goal}:${round}`)();
      if (top && top[0] !== answer && turn < opts.conformity) answer = top[0];
    }
    return `My answer is ${answer}.\n${JSON.stringify({ answer: String(answer), confidence: 0.6, reason: "", evidence: [] })}`;
  });
}

// ---- running and comparing ----

export interface ItemResult {
  id: string;
  debateId: string;
  single: boolean;
  vote: boolean;
  debate: boolean;
  tokens: { single: number; vote: number; debate: number };
  /** Rounds the debate played (round 0 included). */
  roundsPlayed: number;
}

export interface BenchmarkReport {
  n: number;
  accuracy: { single: number; vote: number; debate: number };
  /** Mean tokens per item (input + output). The debate spends more: the comparison is not at equal cost. */
  meanTokens: { single: number; vote: number; debate: number };
  debateVsVote: PairedComparison;
  debateVsSingle: PairedComparison;
  voteVsSingle: PairedComparison;
  /** The owner's rule applied to this result. */
  recommendedDefault: "debate" | "vote";
  items: ItemResult[];
}

/** Runs the items on a server already up (agents created), one debate per item, `parallel` at a time. */
export async function runAccuracyBenchmark(
  deps: AppDeps,
  input: {
    workspaceId: string;
    initiatedBy: string;
    agentIds: string[];
    items: readonly BenchmarkItem[];
    /** The debate's challenge rounds (default 1). */
    roundLimit?: number;
    parallel?: number;
  },
): Promise<BenchmarkReport> {
  const results: ItemResult[] = [];
  const queue = [...input.items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) results.push(await runItem(deps, input, item));
  };
  await Promise.all(Array.from({ length: Math.max(1, input.parallel ?? 4) }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return report(results);
}

async function runItem(
  deps: AppDeps,
  input: { workspaceId: string; initiatedBy: string; agentIds: string[]; roundLimit?: number },
  item: BenchmarkItem,
): Promise<ItemResult> {
  const debate = await openDebate(deps, {
    workspaceId: input.workspaceId,
    title: `Benchmark ${item.id}`,
    goal: item.question,
    agentIds: input.agentIds,
    roundLimit: input.roundLimit ?? 1,
    createdBy: { type: "person", id: input.initiatedBy },
    requesterUserId: input.initiatedBy,
    origin: { kind: "manual" },
    // No cap per debate: the benchmark measures accuracy, not the brake.
    spendCapPercent: 100,
  });
  await deps.runtime.settle();
  const [row] = await deps.db.select().from(schema.debates).where(eq(schema.debates.id, debate.id));
  const posts = await deps.db
    .select()
    .from(schema.debatePosts)
    .where(eq(schema.debatePosts.debateId, debate.id));
  const runs = await deps.db
    .select()
    .from(schema.runs)
    .where(inArray(schema.runs.debateId, [debate.id]));
  const owner = row?.leadAgentId ?? input.agentIds[0];
  const truth = normalizeAnswer(item.answer);
  const synthesis = row?.synthesis as {
    baseline?: { winnerKey: string | null };
    final?: { winnerKey: string | null };
  } | null;
  const ownerFirst = posts.find((p) => p.round === 0 && p.kind === "turn" && p.author.id === owner);
  const round0Runs = new Set(posts.filter((p) => p.round === 0 && p.runId).map((p) => p.runId));
  const tok = (r: (typeof runs)[number]) => r.inputTokens + r.outputTokens;
  return {
    id: item.id,
    debateId: debate.id,
    single: ownerFirst?.claimData?.key === truth,
    vote: synthesis?.baseline?.winnerKey === truth,
    debate: synthesis?.final?.winnerKey === truth,
    tokens: {
      single: runs.filter((r) => r.id === ownerFirst?.runId).reduce((s, r) => s + tok(r), 0),
      vote: runs.filter((r) => round0Runs.has(r.id)).reduce((s, r) => s + tok(r), 0),
      debate: runs.reduce((s, r) => s + tok(r), 0),
    },
    roundsPlayed: (row?.round ?? 0) + 1,
  };
}

export function report(items: ItemResult[]): BenchmarkReport {
  const n = items.length;
  const acc = (k: "single" | "vote" | "debate") => (n ? items.filter((i) => i[k]).length / n : 0);
  const mean = (k: "single" | "vote" | "debate") =>
    n ? Math.round(items.reduce((s, i) => s + i.tokens[k], 0) / n) : 0;
  const col = (k: "single" | "vote" | "debate") => items.map((i) => i[k]);
  const debateVsVote = pairedComparison(col("debate"), col("vote"));
  return {
    n,
    accuracy: { single: acc("single"), vote: acc("vote"), debate: acc("debate") },
    meanTokens: { single: mean("single"), vote: mean("vote"), debate: mean("debate") },
    debateVsVote,
    debateVsSingle: pairedComparison(col("debate"), col("single")),
    voteVsSingle: pairedComparison(col("vote"), col("single")),
    recommendedDefault: benchmarkDefault(debateVsVote),
    items,
  };
}
