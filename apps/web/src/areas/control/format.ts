// The control center's text that the server sends as a code plus an English fallback: titles of
// known tools, the "always allow" rule, the steps of a trail and the line diff of a proposal. Each
// function takes the area's lookup, so a code the catalog does not know falls back to the server's
// own text.
import type { Approval, ApprovalStatus, ApprovalTrailEntry, ProposalTrailEntry } from "@vanr/contract";
import type { WorkStatus } from "@vanr/ui";
import type { MessageParams } from "../../i18n/format.ts";

export type Lookup = (key: string, params?: MessageParams) => string | undefined;

/** The approval's parameters that can fill a message: strings, numbers and lists of strings. */
function textParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number") out[key] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      out[key] = value.join(", ");
  }
  return out;
}

/** "Post in #sales": the request in the interface language when the tool is known. */
export function approvalTitle(approval: Approval, lookup: Lookup): string {
  return lookup(`title.${approval.tool}`, textParams(approval.params)) ?? approval.title;
}

/** What "always allow" stops asking about: "Posts in #sales", or the tool and its label. */
export function ruleText(tool: string, label: string, lookup: Lookup): string {
  return lookup(`rule.${tool}`, { label }) ?? lookup("rule.other", { tool, label }) ?? label;
}

/** One step of an approval's or a proposal's trail. */
export function trailText(
  entry: ApprovalTrailEntry | ProposalTrailEntry,
  kind: "approval" | "proposal",
  lookup: Lookup,
): string {
  if (entry.code === undefined) return entry.text;
  return lookup(`${kind}.trail.${entry.code}`, entry.params) ?? entry.text;
}

/** What the person lets happen, by the words in the tool's name; the first match wins. */
const ALLOWANCES = [
  ["send", ["post", "send", "mail"]],
  ["ship", ["deploy"]],
  ["revert", ["rollback"]],
  ["merge", ["merge"]],
  ["release", ["publish"]],
  ["removal", ["delete"]],
] as const;
export type Allowance = (typeof ALLOWANCES)[number][0] | "anything";

/** The approve button names what it lets the agent do: "Let it send", "Let it deploy". */
export function allowanceFor(tool: string): Allowance {
  const name = tool.toLowerCase();
  return ALLOWANCES.find(([, words]) => words.some((word) => name.includes(word)))?.[0] ?? "anything";
}

/** The badge an approval's status wears. */
export const APPROVAL_BADGE: Record<ApprovalStatus, WorkStatus> = {
  pending: "awaiting-approval",
  approved: "done",
  rejected: "failed",
  expired: "paused",
  canceled: "paused",
};

/** A link written as "label → destination" points somewhere its text does not say. */
export const isMisleading = (link: string) => link.includes(" → ");

/** "3 h", "12 min": the time left until `until`, rounded up to the minute under an hour. */
export function timeLeft(until: string, now: number, locale: string): string {
  const ms = Math.max(0, Date.parse(until) - now);
  const hours = Math.floor(ms / 3_600_000);
  const [value, unit] = hours >= 1 ? [hours, "hour"] : [Math.max(1, Math.ceil(ms / 60_000)), "minute"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
}

export const shortDateTime = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

/** "1.2 s", "4 min": a duration in milliseconds, for the time to a decision. */
export function duration(ms: number, locale: string): string {
  const [value, unit] =
    ms < 60_000 ? [ms / 1000, "second"] : ms < 3_600_000 ? [ms / 60_000, "minute"] : [ms / 3_600_000, "hour"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Above this many cells the diff says "all of it went out, all of it came in". */
const MAX_CELLS = 250_000;

/** Line diff between today's text and the proposed one (longest common subsequence). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const removed = (text: string): DiffLine => ({ kind: "del", text });
  const added = (text: string): DiffLine => ({ kind: "add", text });
  if (a.length * b.length > MAX_CELLS) return [...a.map(removed), ...b.map(added)];
  // lcs[i][j]: the length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] as string;
    const right = b[j] as string;
    if (left === right) {
      out.push({ kind: "same", text: left });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push(removed(left));
      i++;
    } else {
      out.push(added(right));
      j++;
    }
  }
  return [...out, ...a.slice(i).map(removed), ...b.slice(j).map(added)];
}
