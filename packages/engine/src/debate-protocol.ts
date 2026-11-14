// Debate protocol: the part that does not depend on the database. A blind, parallel round 0; claims
// anonymized and shuffled in the following rounds; a structured claim per round; simple majority as the
// baseline (confidence is stored and shown, it does not weigh the vote); stop when no claim changes;
// divergence synthesis; and the benchmark statistic (paired accuracy).
//
// No Bun or database dependency: the server, the benchmark and the web app import from here.
import type {
  DebateClaim,
  DebateEndReason,
  DebateMajority,
  DebateMajorityGroup,
  DebateSynthesis,
} from "@vanr/contract";

// ---- reproducible draw ----

/** Deterministic generator from a text (mulberry32 over an FNV-1a hash). */
export function seededRng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates: a shuffled copy. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * One pseudonym per participant (A, B, C...), drawn at random: the letter tells neither the speaking order nor
 * the creation order. More than 26 participants get a number (A2, B2...).
 */
export function assignPseudonyms(ids: readonly string[], rng: () => number): Record<string, string> {
  const unique = [...new Set(ids)];
  const labels = unique.map((_, i) => {
    const letter = LETTERS[i % LETTERS.length] as string;
    return i < LETTERS.length ? letter : `${letter}${Math.floor(i / LETTERS.length) + 1}`;
  });
  const order = shuffled(labels, rng);
  return Object.fromEntries(unique.map((id, i) => [id, order[i] as string]));
}

// ---- claim (`DebateClaim`: what each participant states in each round) ----

export const ANSWER_MAX = 200;
export const REASON_MAX = 500;
const EVIDENCE_MAX = 5;

/** The format the prompt asks of the agent at the end of its message. */
export const POSITION_FORMAT =
  'End your message with one line of JSON: {"answer": string (your position in at most 15 words), ' +
  '"confidence": number from 0 to 1, "reason": string (why you changed your answer since your last ' +
  'round; empty if you did not), "evidence": string[] (sources, tool outputs or facts you rely on)}';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Removes accents, case and punctuation; a number becomes its canonical form ("42.0" = "42"). */
export function normalizeAnswer(answer: string): string {
  const plain = answer
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.,\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,]+$/, "");
  // Commas in groups of three are thousands ("1,000"); otherwise it is the decimal comma ("1,5", "3,14").
  const num = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(plain)
    ? plain.replace(/,/g, "")
    : /^-?\d+,\d+$/.test(plain)
      ? plain.replace(",", ".")
      : plain;
  if (/^-?\d+(\.\d+)?$/.test(num)) return String(Number(num));
  return plain;
}

/**
 * Answer key. With options, the answer becomes the equal option (ignoring case and accents), the only option
 * quoted inside it, or the option letter ("B", "b)"); otherwise, `other:<answer>`.
 */
export function answerKey(answer: string, options: readonly string[] = []): string {
  const norm = normalizeAnswer(answer);
  // No answer means no vote (empty key), with or without options.
  if (!options.length || !norm) return norm;
  const opts = options.map(normalizeAnswer);
  const exact = opts.indexOf(norm);
  if (exact >= 0) return `option:${exact}`;
  const letter = /^\(?([a-z])\)?\.?$/.exec(norm.split(" ")[0] ?? "")?.[1];
  if (letter && norm.length <= 3) {
    const i = letter.charCodeAt(0) - 97;
    if (i >= 0 && i < opts.length) return `option:${i}`;
  }
  const inside = opts.flatMap((o, i) =>
    o && new RegExp(`(?:^|[ .,\\-])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[ .,\\-])`).test(norm)
      ? [i]
      : [],
  );
  if (inside.length === 1) return `option:${inside[0]}`;
  return `other:${norm}`;
}

/** Display label of a key (the option as written, or the answer). */
function keyLabel(key: string, options: readonly string[], fallback: string): string {
  const m = /^option:(\d+)$/.exec(key);
  if (m) return options[Number(m[1])] ?? fallback;
  return fallback;
}

/**
 * Reads the agent's message: the argument as text and the claim in the trailing JSON. Without JSON, the first
 * sentence becomes the answer and confidence stays null. The body shown is the text without the JSON.
 */
export function parsePosition(
  text: string,
  options: readonly string[] = [],
): { argument: string; position: Omit<DebateClaim, "changed"> } {
  const trimmed = text.trim();
  let argument = trimmed;
  let raw: Record<string, unknown> | null = null;
  // The last JSON object with "answer" (the agent may quote JSON in its argument).
  const candidates: { start: number; end: number }[] = [];
  const starts: number[] = [];
  for (const m of trimmed.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}]/g)) {
    if (m[0] === "{") starts.push(m.index);
    else if (m[0] === "}") {
      const start = starts.pop();
      if (start !== undefined) candidates.push({ start, end: m.index + 1 });
    }
  }
  for (let i = candidates.length - 1; i >= 0 && !raw; i--) {
    const m = candidates[i];
    if (!m) continue;
    try {
      const v: unknown = JSON.parse(trimmed.slice(m.start, m.end));
      if (isRecord(v) && typeof v.answer === "string") {
        raw = v;
        argument = (trimmed.slice(0, m.start) + trimmed.slice(m.end)).replace(/```(json)?\s*```/g, "").trim();
      }
    } catch {
      // not JSON
    }
  }
  if (!raw) {
    const first = trimmed.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? "";
    const answer = clip(first, ANSWER_MAX);
    return {
      argument,
      position: { answer, key: answerKey(answer, options), confidence: null, reason: "", evidence: [] },
    };
  }
  const answer = clip(String(raw.answer).trim(), ANSWER_MAX);
  const c = typeof raw.confidence === "number" ? raw.confidence : Number(raw.confidence);
  const confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter((e): e is string => typeof e === "string" && !!e.trim())
        .slice(0, EVIDENCE_MAX)
        .map((e) => clip(e.trim(), REASON_MAX))
    : [];
  return {
    argument,
    position: {
      answer,
      key: answerKey(answer, options),
      confidence,
      reason: typeof raw.reason === "string" ? clip(raw.reason.trim(), REASON_MAX) : "",
      evidence,
    },
  };
}

// ---- simple majority ----

/** Simple majority (plurality): one vote per participant, no confidence weight. */
export function majority(
  votes: readonly { member: string; key: string; answer: string; confidence: number | null }[],
  options: readonly string[] = [],
): DebateMajority {
  const byKey = new Map<string, DebateMajorityGroup & { confs: number[] }>();
  for (const v of votes) {
    if (!v.key) continue;
    const g = byKey.get(v.key) ?? {
      key: v.key,
      answer: keyLabel(v.key, options, v.answer),
      count: 0,
      members: [],
      meanConfidence: null,
      confs: [],
    };
    g.count++;
    g.members.push(v.member);
    if (v.confidence !== null) g.confs.push(v.confidence);
    byKey.set(v.key, g);
  }
  const groups = [...byKey.values()]
    .map(({ confs, ...g }) => ({
      ...g,
      members: [...g.members].sort(),
      meanConfidence: confs.length
        ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100
        : null,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const total = groups.reduce((n, g) => n + g.count, 0);
  const [first, second] = groups;
  const tie = !!first && !!second && first.count === second.count;
  return {
    total,
    groups,
    winner: first && !tie ? first.answer : null,
    winnerKey: first && !tie ? first.key : null,
    tie,
    unanimous: groups.length === 1 && total > 0,
  };
}

// ---- stopping ----

/**
 * After a round closes: go on to another one or to the synthesis. An extra round only with divergence; in a
 * challenge round, if nobody changed their claim, stop (more rounds do not pay off).
 */
export function afterRound(input: {
  round: number;
  /** Challenge rounds requested after round 0. */
  roundLimit: number;
  /** Claims (keys) of this round, by participant. */
  current: ReadonlyMap<string, string>;
  /** Those of the previous round; null in round 0. */
  previous: ReadonlyMap<string, string> | null;
  /** Some turn of this round ran out of the debate's budget. */
  budgetHit: boolean;
}): { next: true } | { next: false; reason: DebateEndReason } {
  if (input.budgetHit) return { next: false, reason: "budget" };
  const keys = new Set(input.current.values());
  if (keys.size <= 1) return { next: false, reason: "unanimous" };
  if (input.previous) {
    let changed = false;
    for (const [who, key] of input.current) {
      const before = input.previous.get(who);
      if (before !== undefined && before !== key) changed = true;
    }
    if (!changed) return { next: false, reason: "no_change" };
  }
  if (input.round >= input.roundLimit) return { next: false, reason: "max_rounds" };
  return { next: true };
}

// ---- divergence synthesis ----

/** The structured part of a debate synthesis (`DebateSynthesis.structured`). */
export type DivergenceSynthesis = DebateSynthesis["structured"];

export const SYNTHESIS_SHAPE = {
  decision:
    '{"summary": string, "decision": string, "agreements": string[], "disagreements": [{"point": string, ' +
    '"sides": [{"position": string, "mustProve": string}]}]}',
  plan:
    '{"summary": string, "items": [{"title": string, "owner"?: string, "step"?: string}], "agreements": ' +
    'string[], "disagreements": [{"point": string, "sides": [{"position": string, "mustProve": string}]}]}',
} as const;

const strings = (v: unknown, max = 30): string[] | undefined =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .slice(0, max)
        .map((x) => x.trim())
    : undefined;

/** Reads the JSON synthesis; if the model answered in text (or the JSON was cut off), the text becomes the summary. */
export function parseDivergenceSynthesis(text: string): DivergenceSynthesis {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const v: unknown = JSON.parse(json);
      if (isRecord(v) && typeof v.summary === "string") {
        const items = Array.isArray(v.items)
          ? v.items
              .filter(
                (i): i is Record<string, unknown> =>
                  typeof i === "object" && i !== null && typeof i.title === "string",
              )
              .map((i) => ({
                title: String(i.title),
                ...(typeof i.owner === "string" ? { owner: i.owner } : {}),
                ...(typeof i.step === "string" ? { step: i.step } : {}),
              }))
          : undefined;
        const disagreements = Array.isArray(v.disagreements)
          ? v.disagreements
              .filter(
                (d): d is Record<string, unknown> =>
                  typeof d === "object" && d !== null && typeof d.point === "string",
              )
              .slice(0, 20)
              .map((d) => ({
                point: String(d.point),
                sides: (Array.isArray(d.sides) ? d.sides : [])
                  .filter(
                    (s): s is Record<string, unknown> =>
                      typeof s === "object" && s !== null && typeof s.position === "string",
                  )
                  .slice(0, 10)
                  .map((s) => ({
                    position: String(s.position),
                    mustProve: typeof s.mustProve === "string" ? s.mustProve : "",
                  })),
              }))
          : undefined;
        const agreements = strings(v.agreements);
        const dissent = strings(v.dissent);
        return {
          summary: v.summary,
          ...(typeof v.decision === "string" ? { decision: v.decision } : {}),
          ...(items ? { items } : {}),
          ...(agreements ? { agreements } : {}),
          ...(disagreements ? { disagreements } : {}),
          ...(dissent ? { dissent } : {}),
        };
      }
    } catch {
      // free text
    }
  }
  return { summary: text.trim() };
}

/**
 * Synthesis without a model (the cap ran out before it): the decision is the last round's majority and each
 * group that lost becomes one side of the disagreement.
 */
export function voteSynthesis(final: DebateMajority): DivergenceSynthesis {
  const [top, ...rest] = final.groups;
  return {
    summary: "",
    ...(final.winner ? { decision: final.winner } : {}),
    agreements: final.unanimous && top ? [top.answer] : [],
    disagreements:
      rest.length && top
        ? [
            {
              point: "",
              sides: final.groups.map((g) => ({ position: g.answer, mustProve: "" })),
            },
          ]
        : [],
  };
}

// ---- benchmark: paired accuracy ----

export interface PairedComparison {
  n: number;
  /** Accuracy of each method (0 to 1). */
  accA: number;
  accB: number;
  /** accA − accB. */
  diff: number;
  /** 95% interval of the difference (normal over the paired differences). */
  ci95: [number, number];
  /** Items where the two methods disagree on correctness. */
  discordant: number;
}

/** Compares two methods on the same items (right or wrong), with the interval of the paired difference. */
export function pairedComparison(a: readonly boolean[], b: readonly boolean[]): PairedComparison {
  if (a.length !== b.length) throw new Error("paired samples must have the same length");
  const n = a.length;
  if (n === 0) return { n, accA: 0, accB: 0, diff: 0, ci95: [0, 0], discordant: 0 };
  const d = a.map((x, i) => Number(x) - Number(b[i]));
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.96 * Math.sqrt(variance / n);
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    n,
    accA: round(a.filter(Boolean).length / n),
    accB: round(b.filter(Boolean).length / n),
    diff: round(mean),
    ci95: [round(mean - half), round(mean + half)],
    discordant: d.filter((x) => x !== 0).length,
  };
}

/** Minimum items for the normal interval to mean anything (with 2 equal items it gives [1, 1]). */
export const BENCHMARK_MIN_ITEMS = 30;

/**
 * Owner's rule: a debate with rounds only stays the default if it beats the simple majority with the whole
 * interval above zero, on at least `BENCHMARK_MIN_ITEMS` items; otherwise the default becomes a vote
 * (round 0 + synthesis).
 */
export function benchmarkDefault(debateVsVote: PairedComparison): "debate" | "vote" {
  return debateVsVote.n >= BENCHMARK_MIN_ITEMS && debateVsVote.ci95[0] > 0 ? "debate" : "vote";
}
