// Effect decision. Every tool call with an effect goes through gate(run, call), which returns allow, ask
// (with a preview and the payload hash) or deny (with a reason).
//
// Effect class:
//   K0 read · K1 internal write that can be undone · K2 external with a window (post, email to an allowed
//   destination) · K3 irreversible (money, new recipient, delete, publish).
// Flags per run, decided on the server (the "rule of two", Meta 2025-10-31):
//   A read untrusted content (web, outside email, connector, channel with a guest)
//   B has access to sensitive data (browser login, secret, credential)
//   C changes state outside or communicates outside (every K2/K3 call or one with an external destination)
// A run never holds all three without a person deciding.
//
// Tools declare their class and destination and call gate(); they do not rewrite the table.
//
// The effect class, the gate reason and the risk reason (why a flag went up, shown on the approval card and in
// the run log; `source` is the tool and target, e.g. `browser_read https://example.com`) are contract types.
import type { EffectClass, GateReason, RiskReason } from "@vanr/contract";

export const EFFECT_CLASSES = ["K0", "K1", "K2", "K3"] as const satisfies readonly EffectClass[];

export type RiskFlag = RiskReason["flag"];
const RISK_FLAGS = ["A", "B", "C"] as const satisfies readonly RiskFlag[];

/** Risk state of a run. It only grows: a raised flag does not go down in the same run. */
export interface RunRisk {
  readonly flags: ReadonlySet<RiskFlag>;
  readonly reasons: readonly RiskReason[];
}

export type Destination =
  /** No destination (a read, the agent's own memory). */
  | { kind: "none" }
  /** Inside the workspace: source channel, wiki, issue. `public` = visible to guests or outside the workspace. */
  | { kind: "internal"; public?: boolean }
  /** Outside the workspace. `allowed` = workspace or thread domain, source channel, origin allowed for the agent. */
  | { kind: "external"; allowed: boolean; target: string };

/** What the approver sees: the exact effect, not the intent. */
export interface Preview {
  title: string;
  /** The whole text that goes out (uncut). */
  body?: string;
  /** Final recipients, already resolved. */
  recipients?: string[];
  /** Resolved links. */
  links?: string[];
  /** Diff in the wiki, Drive or instructions. */
  diff?: string;
}

export interface GateCall {
  tool: string;
  effect: EffectClass;
  destination: Destination;
  /** Flags this call raises (reading an outside page raises A; typing a secret raises B). */
  raises?: readonly RiskReason[];
  /** The call's exact payload: it is what the hash pins. */
  input: unknown;
  preview: Preview;
  /**
   * A workspace or agent rule that requires a person on this call, beyond the table (mailbox in "ask" mode,
   * `execute_code` with approval, connector with "approval" access, an explicit request of the assignment). It
   * never relaxes the table: it only adds the request.
   */
  policy?: "ask";
}

export type GateDecision =
  | { kind: "allow"; effect: EffectClass; flags: RiskFlag[] }
  | {
      kind: "ask";
      reason: GateReason;
      effect: EffectClass;
      flags: RiskFlag[];
      preview: Preview;
      /** SHA-256 of the payload as canonical JSON. The approval only runs a payload with this hash. */
      payloadHash: string;
    }
  | { kind: "deny"; reason: GateReason; effect: EffectClass; flags: RiskFlag[] };

/** The run's flags after this call. C goes up on an external effect (K2/K3) or an external destination. */
function flagsAfter(run: RunRisk, call: GateCall): Set<RiskFlag> {
  const flags = new Set(run.flags);
  for (const r of call.raises ?? []) flags.add(r.flag);
  if (call.effect === "K2" || call.effect === "K3" || call.destination.kind === "external") flags.add("C");
  return flags;
}

/**
 * Decision table:
 *   K0 automatic, unless the call closes the rule of two.
 *   K1 automatic with undo; asks if A is up and the destination is public or external.
 *   K2 automatic only with an allowed destination and without A+B together.
 *   K3 always a person, with a preview.
 * Deny only when the call would carry untrusted content outside an allowed destination.
 * `policy: "ask"` (workspace rule) adds a request where the table would let it pass; it does not remove a deny.
 */
export function gate(run: RunRisk, call: GateCall): GateDecision {
  const flags = flagsAfter(run, call);
  const list = RISK_FLAGS.filter((f) => flags.has(f));
  const ask = (reason: GateReason): GateDecision => ({
    kind: "ask",
    reason,
    effect: call.effect,
    flags: list,
    preview: call.preview,
    payloadHash: payloadHash(call.tool, call.input),
  });
  const deny = (reason: GateReason): GateDecision => ({
    kind: "deny",
    reason,
    effect: call.effect,
    flags: list,
  });
  const dest = call.destination;
  const untrusted = flags.has("A");

  if (dest.kind === "external" && !dest.allowed)
    return untrusted ? deny("untrusted_to_external") : ask("destination_not_allowed");
  if (call.effect === "K3") return ask("irreversible");
  if (flags.has("A") && flags.has("B") && flags.has("C")) return ask("rule_of_two");
  if (untrusted && dest.kind === "internal" && dest.public && call.effect !== "K0")
    return ask("untrusted_public");
  if (untrusted && dest.kind === "external" && call.effect === "K1") return ask("untrusted_public");
  if (call.policy === "ask") return ask("policy");
  return { kind: "allow", effect: call.effect, flags: list };
}

// ---- Shortcuts for a request ----
// Always after the gate, never instead of it: only an "ask" can become "allow", and never in K3.

/** Validity of an "always allow" rule. */
export const STANDING_RULE_TTL_MS = 30 * 24 * 3600_000;

/**
 * Can a person remember this request ("always allow": agent + tool + resolved destination)? Only a
 * workspace-rule request (`policy`) in K1/K2 and in a run without A: what the table asks for because of risk
 * stays with the person, and with outside content in the run the text may have come from an injection.
 */
export function rememberable(d: GateDecision): boolean {
  return d.kind === "ask" && d.reason === "policy" && d.effect !== "K3" && !d.flags.includes("A");
}

/**
 * Can the model reviewer decide this request? Only the middle ground of risk between K1 and K2: the rule of
 * two or outside content going to a public destination. A workspace request belongs to the person; K3 is
 * never the model's.
 */
export function reviewable(d: GateDecision): boolean {
  return (
    d.kind === "ask" &&
    (d.effect === "K1" || d.effect === "K2") &&
    (d.reason === "rule_of_two" || d.reason === "untrusted_public")
  );
}

/** Reviewer breaker: 3 person requests in a row or 10 in the last 50 turn the reviewer off. */
export const REVIEW_BREAKER = { consecutive: 3, window: 50, maxAsks: 10 } as const;

/** `recent`: the reviewer's verdicts, newest first. Open = the reviewer does not decide. */
export function breakerOpen(recent: readonly ("allow" | "ask")[]): boolean {
  let streak = 0;
  for (const v of recent) {
    if (v !== "ask") break;
    streak++;
  }
  if (streak >= REVIEW_BREAKER.consecutive) return true;
  const asks = recent.slice(0, REVIEW_BREAKER.window).filter((v) => v === "ask").length;
  return asks >= REVIEW_BREAKER.maxAsks;
}

/** Risk tracker of a run. The harness keeps one per run and calls raise() after each call. */
export class RiskTracker implements RunRisk {
  private readonly set = new Set<RiskFlag>();
  private readonly list: RiskReason[] = [];

  constructor(initial: readonly RiskReason[] = []) {
    for (const r of initial) this.raise(r);
  }

  get flags(): ReadonlySet<RiskFlag> {
    return this.set;
  }

  get reasons(): readonly RiskReason[] {
    return this.list;
  }

  raise(reason: RiskReason): void {
    this.set.add(reason.flag);
    if (!this.list.some((r) => r.flag === reason.flag && r.source === reason.source)) this.list.push(reason);
  }

  /** After the call ran: records what it raised (including C, if it went outside). */
  record(call: GateCall): void {
    for (const r of call.raises ?? []) this.raise(r);
    if (flagsAfter({ flags: new Set(), reasons: [] }, call).has("C"))
      this.raise({ flag: "C", source: call.tool });
  }
}

/** JSON with sorted keys and no spaces: the same input always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("canonicalJson: non-finite number");
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 (hex) of tool + canonical payload. */
export function payloadHash(tool: string, input: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${tool}\n${canonicalJson(input)}`);
  return hasher.digest("hex");
}

/** Is the approval valid for this payload? Editing the payload after approval invalidates it. */
export function approvalMatches(approvedHash: string, tool: string, input: unknown): boolean {
  return approvedHash === payloadHash(tool, input);
}
