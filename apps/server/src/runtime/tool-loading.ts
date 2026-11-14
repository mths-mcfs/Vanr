// On-demand tool loading. Measured before turning it on:
// the definitions of a default agent already weigh thousands of tokens on every call. Above the limit,
// only the pinned ones go in the prompt; the rest go with `defer_loading` and the API's search finds them when needed.
//
// Pinned: the ones the agent used most in the last 30 days (`gate_decisions`), topped up by a default
// list. Anthropic recommends keeping 3 to 5 pinned.
import type { Db } from "@vanr/engine/db";
import { schema } from "@vanr/engine/db";
import { estimateTokens, wireTool } from "@vanr/engine/models/tool-tokens";
import type { ToolSpec } from "@vanr/engine/models/types";
import { and, count, desc, eq, gte } from "drizzle-orm";

const { gateDecisions } = schema;

/** Below this the definitions go in whole (the search costs one more round trip). */
export const DEFER_FROM_TOKENS = 3_000;
export const PINNED_MAX = 5;
/** Pinned without history: what almost every run uses (search, ask, remember, reply in another channel, skill). */
export const DEFAULT_PINNED = ["search", "ask_user", "remember", "post_message", "use_skill"];
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The ones the agent used most in the last 30 days, topped up by the default list. */
export async function pinnedTools(db: Db, agentId: string, now: Date): Promise<string[]> {
  const rows = await db
    .select({ tool: gateDecisions.tool, n: count() })
    .from(gateDecisions)
    .where(
      and(
        eq(gateDecisions.agentId, agentId),
        gte(gateDecisions.createdAt, new Date(now.getTime() - WINDOW_MS)),
      ),
    )
    .groupBy(gateDecisions.tool)
    .orderBy(desc(count()), gateDecisions.tool)
    .limit(PINNED_MAX);
  return [...new Set([...rows.map((r) => r.tool), ...DEFAULT_PINNED])];
}

/** Estimated tokens of the definitions as they go on the wire. */
export const definitionTokens = (specs: readonly ToolSpec[]) =>
  estimateTokens(JSON.stringify(specs.map(wireTool)));

/**
 * Marks the tools that are not pinned as deferred, when the definitions go over the limit. The
 * pinned ones are the first `PINNED_MAX` of `pinned` that exist in this run.
 */
export function withLoading(
  specs: readonly ToolSpec[],
  pinned: readonly string[],
  minTokens = DEFER_FROM_TOKENS,
): ToolSpec[] {
  if (definitionTokens(specs) < minTokens) return [...specs];
  const names = new Set(specs.map((s) => s.name));
  const fixed = new Set(pinned.filter((p) => names.has(p)).slice(0, PINNED_MAX));
  return specs.map((s) => (fixed.has(s.name) ? s : { ...s, deferLoading: true }));
}
