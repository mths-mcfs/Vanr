// The estimated cost before running. Where a real upper bound exists, the sum is the cap's own reservation: each
// call reserves the prompt in bytes as cache-write tokens (the most expensive input price) plus the maximum output,
// and the real cost never exceeds the reservation. So the sum of the reservations the work can make is an honest
// ceiling, not a guess:
//   Debate: (the agents' turns × rounds + the synthesis), each with the prompt's fixed text and the fields at their
//   maximum size (title, goal, the conversation cut at TRANSCRIPT_CHARS); 3 bytes per character is UTF-8's worst
//   case for one JavaScript character.
//   A routine that writes a document: one call with today's request, plus the ceiling of the outside content
//   (`ROUTINE_CONTEXT_CHARS`) when the trigger brings some (webhook, email, event).
// A routine that talks in a channel has no fixed ceiling (the agent decides how many tools it uses): it shows what
// the latest executions really cost, measured in the ledger.
import type { DebateEstimate, RoutineEstimate } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { DEFAULT_MODEL } from "@vanr/engine/models/catalog";
import { PRICES } from "@vanr/engine/models/prices";
import { estimateUsd, utf8Bytes } from "@vanr/engine/usage";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { AgentRow } from "./agents";
import { MAX_ROUNDS, synthesisPrompt, TRANSCRIPT_CHARS, TURN_EXTRA_CHARS, turnPrompt } from "./debates";
import { readableRuns } from "./run-access";

const { agents, routineExecutions, runs } = schema;

/** The maximum output of a call outside a conversation (`runtime.complete` without `maxTokens`). */
const COMPLETE_MAX_TOKENS = 4000;
/** UTF-8's worst case per JavaScript string unit. */
const BYTES_PER_CHAR = 3;
/** The maximum size of a debate's title and goal (the route's schema). */
const TITLE_CHARS = 200;
const GOAL_CHARS = 4000;
/** How many of the routine's executions go into the average. */
const RECENT_RUNS = 10;

/** A model without a row in the price table is billed as the default (the runtime's same rule). */
const billedModel = (model: string, at: Date) => (PRICES.at(model, at) ? model : DEFAULT_MODEL);

const callUsd = (model: string, promptBytes: number, at: Date) =>
  estimateUsd(PRICES, { model: billedModel(model, at), promptBytes, maxTokens: COMPLETE_MAX_TOKENS, at });

/**
 * The ceiling of opening a debate: every turn of the agents in every round, plus the synthesis. The title and the
 * goal at the route's maximum, unless the text is already known (the routine that opens the debate).
 */
export function debateEstimate(
  speakers: readonly AgentRow[],
  input: { roundLimit: number; format?: "decision" | "plan"; titleChars?: number; goalChars?: number },
  at: Date,
): DebateEstimate {
  // `roundLimit` counts the challenge rounds after the blind round 0: each agent speaks roundLimit + 1 times.
  const roundLimit = Math.min(Math.max(0, input.roundLimit), MAX_ROUNDS);
  const turns = roundLimit + 1;
  const debate = { title: "", goal: "", round: roundLimit, roundLimit, format: input.format ?? "decision" };
  const open =
    BYTES_PER_CHAR * ((input.titleChars ?? TITLE_CHARS) + (input.goalChars ?? GOAL_CHARS) + TRANSCRIPT_CHARS);
  const debateBytes = (parts: { system: string; prompt: string }) =>
    utf8Bytes(parts.system) + utf8Bytes(parts.prompt) + open;
  let upToUsd = 0;
  // The longest turn: outside the blind round, with options and positions at the ceiling (TURN_EXTRA_CHARS).
  const turn = { pseudonym: "", blind: false, options: "", context: "" };
  const extra = BYTES_PER_CHAR * TURN_EXTRA_CHARS;
  for (const agent of speakers)
    upToUsd += turns * callUsd(agent.model, debateBytes(turnPrompt(agent, debate, turn)) + extra, at);
  const lead = speakers[0];
  if (lead) upToUsd += callUsd(lead.model, debateBytes(synthesisPrompt(lead, debate, "")), at);
  return { calls: speakers.length * turns + (lead ? 1 : 0), upToUsd };
}

/** The workspace's agents, in the order asked (a repeated one counts once; an archived or outside one, none). */
export async function speakerAgents(
  db: Db,
  workspaceId: string,
  ids: readonly string[],
): Promise<AgentRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, unique)));
  return unique.flatMap((id) => rows.filter((r) => r.id === id && !r.archivedAt));
}

/**
 * What the routine's latest executions cost (the sum of each run's ledger), from the newest to the oldest. Only the
 * runs the person sees count (`readableRuns`): a run in a channel they can't read doesn't show through its cost.
 */
export async function recentRoutineCosts(
  db: Db,
  routineId: string,
  viewer: { workspaceId: string; userId: string },
): Promise<number[]> {
  const rows = await db
    .select({ cost: runs.costUsd })
    .from(routineExecutions)
    .innerJoin(runs, eq(runs.id, routineExecutions.runId))
    .where(
      and(
        eq(routineExecutions.routineId, routineId),
        isNotNull(routineExecutions.runId),
        readableRuns(db, viewer),
      ),
    )
    .orderBy(desc(routineExecutions.at))
    .limit(RECENT_RUNS);
  return rows.map((r) => Number(r.cost ?? 0));
}

export function routineEstimate(input: {
  upToUsd: number | null;
  calls: number | null;
  recent: number[];
}): RoutineEstimate {
  const { recent } = input;
  return {
    upToUsd: input.upToUsd,
    calls: input.calls,
    recent: recent.length
      ? {
          runs: recent.length,
          avgUsd: recent.reduce((a, b) => a + b, 0) / recent.length,
          maxUsd: Math.max(...recent),
        }
      : null,
  };
}

/**
 * The ceiling of a routine that writes a document: one call with the request as it is, plus `extraChars` of the
 * outside content the trigger can add.
 */
export function fileUpToUsd(
  agent: AgentRow,
  system: string,
  prompt: string,
  extraChars: number,
  at: Date,
): number {
  return callUsd(agent.model, utf8Bytes(system) + utf8Bytes(prompt) + BYTES_PER_CHAR * extraChars, at);
}
