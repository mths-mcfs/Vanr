// Assignment cap in two parts: USD for the harness through the API, reserved in the ledger
// (scope `assignment`) before each call; job time and steps for the runner, which
// runs on the pairing person's plan and costs no USD here ("cost not measured", not USD 0).
import type { AssignmentUsage } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import type { BudgetScope } from "@vanr/engine/usage";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { AppDeps } from "../context";

const { assignments, assignmentWork, runnerJobs } = schema;
type AssignmentLimits = schema.AssignmentLimits;

/**
 * Default of each new assignment. It did not come from a measurement: p50 and p90 of `runs.costUsd`
 * with the harness through the API have to be measured before fixing the USD amount (an assignment costs more
 * than a chat). The owner changes it on the assignment.
 */
export const DEFAULT_LIMITS: AssignmentLimits = { dollars: 5, minutes: 480, steps: 30 };
/** Warns once when usage passes this fraction of the cap. */
export const WARN_AT = 0.8;

export type LimitKind = keyof AssignmentLimits;
export const LIMIT_KINDS: readonly LimitKind[] = ["dollars", "minutes", "steps"];

/** Keep accounting when the USD cap is disabled, so enabling it includes all spending. */
export function assignmentScope(row: { id: string; limits: AssignmentLimits }): BudgetScope {
  return {
    kind: "assignment",
    id: row.id,
    limitUsd: row.limits.dollars ?? Number.MAX_SAFE_INTEGER,
    period: "total",
  };
}

/** Scope and id of a run's assignment, when the conversation is the thread of an open assignment of the agent. */
export async function assignmentOfRun(
  deps: Pick<AppDeps, "db">,
  agentId: string,
  threadId: string | null,
): Promise<{ assignmentId: string; scope: BudgetScope } | null> {
  if (!threadId) return null;
  const [row] = await deps.db
    .select({
      id: assignments.id,
      agentId: assignments.agentId,
      limits: assignments.limits,
      status: assignments.status,
    })
    .from(assignments)
    .where(eq(assignments.threadId, threadId));
  if (!row || row.agentId !== agentId || row.status === "done" || row.status === "canceled") return null;
  return { assignmentId: row.id, scope: assignmentScope(row) };
}

/** The usage as measured: the dollars are always there (the API nulls them for whoever lacks view_usage). */
export type MeasuredUsage = AssignmentUsage & { dollars: number; jobTokens: number };

/** Usage so far: USD in the ledger, minutes of the jobs on the runner and steps the engine sent. */
export async function assignmentUsage(
  deps: Pick<AppDeps, "db" | "ledger" | "now">,
  row: { id: string; limits: AssignmentLimits },
): Promise<MeasuredUsage> {
  const now = deps.now();
  const spentUsd = await deps.ledger.spent(
    { kind: "assignment", id: row.id, limitUsd: Number.MAX_SAFE_INTEGER, period: "total" },
    now,
  );
  const [t] = await deps.db
    .select({
      seconds: sql<number>`coalesce(sum(extract(epoch from (coalesce(${runnerJobs.endedAt}, ${now.toISOString()}::timestamptz) - ${runnerJobs.startedAt}))), 0)::float`,
      tokens: sql<number>`coalesce(sum(((${runnerJobs.usage} ->> 'inputTokens')::bigint) + ((${runnerJobs.usage} ->> 'outputTokens')::bigint)), 0)::float`,
      unmeasured: sql<number>`count(*) filter (where ${runnerJobs.usage} is null and ${runnerJobs.status} in ('done','failed','interrupted','canceled'))::int`,
    })
    .from(runnerJobs)
    .where(eq(runnerJobs.assignmentId, row.id));
  const [s] = await deps.db
    .select({ n: count() })
    .from(assignmentWork)
    .where(
      and(eq(assignmentWork.assignmentId, row.id), inArray(assignmentWork.kind, ["plan", "run", "task"])),
    );
  return {
    dollars: Math.round(spentUsd * 10_000) / 10_000,
    minutes: Math.round(((t?.seconds ?? 0) / 60) * 10) / 10,
    steps: s?.n ?? 0,
    jobTokens: Math.round(t?.tokens ?? 0),
    unmeasuredJobs: t?.unmeasured ?? 0,
  };
}

/** Which cap is already hit (in order: USD, minutes, steps) and which ones passed the warning. */
export function ceilingState(limits: AssignmentLimits, usage: Pick<MeasuredUsage, LimitKind>) {
  let hit: LimitKind | null = null;
  const warn: LimitKind[] = [];
  for (const k of LIMIT_KINDS) {
    const limit = limits[k];
    if (limit === null) continue;
    const used = usage[k];
    if (used >= limit && !hit) hit = k;
    else if (used >= limit * WARN_AT) warn.push(k);
  }
  return { hit, warn };
}
