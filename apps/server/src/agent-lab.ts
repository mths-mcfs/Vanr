// An agent's test cases and the before/after run of a change of instructions. It only advises: accepting the
// proposal doesn't depend on the outcome.
import type {
  AgentEval,
  AgentEvalCase,
  AgentEvalSide,
  AgentEvalSummary,
  AgentTestCase,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { PRODUCT } from "@vanr/product";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type AgentRow, workspaceBudgetDefaults } from "./agents";
import { type AppDeps } from "./context";
import { isUniqueViolation } from "./db-errors";
import { conflict } from "./http";

const { agentTestCases, agentEvals, memoryConsolidations, runs } = schema;
export type TestCaseRow = typeof agentTestCases.$inferSelect;
export type EvalRow = typeof agentEvals.$inferSelect;

export const TEST_CASES_MAX = 50;
/** Cases running at the same time (each one makes two calls: before and after). */
export const EVAL_CONCURRENCY = 4;
/** Each case's answer: enough for a chat answer. */
export const EVAL_MAX_TOKENS = 1000;
const EVAL_TIMEOUT_MS = 90_000;

export function toTestCase(row: TestCaseRow): AgentTestCase {
  return {
    id: row.id,
    agentId: row.agentId,
    input: row.input,
    mustInclude: row.mustInclude,
    mustNotInclude: row.mustNotInclude,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toEval(row: EvalRow): AgentEval {
  return {
    id: row.id,
    agentId: row.agentId,
    proposalId: row.proposalId,
    status: row.status,
    total: row.total,
    done: row.results.length,
    results: row.results,
    summary: row.summary,
    error: row.error,
    costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

const fold = (s: string) => s.normalize("NFKC").toLocaleLowerCase("pt-BR");

/** Checks the answer against the case: every required snippet shows up, no forbidden one does. */
export function checkReply(
  text: string,
  c: Pick<TestCaseRow, "mustInclude" | "mustNotInclude">,
): AgentEvalSide {
  const said = fold(text);
  const failed = [
    ...c.mustInclude.filter((t) => !said.includes(fold(t))).map((t) => `include:${t}`),
    ...c.mustNotInclude.filter((t) => said.includes(fold(t))).map((t) => `exclude:${t}`),
  ];
  return { text, pass: failed.length === 0, failed };
}

export function summarize(results: readonly AgentEvalCase[]): AgentEvalSummary {
  return {
    cases: results.length,
    beforePass: results.filter((r) => r.before.pass).length,
    afterPass: results.filter((r) => r.after.pass).length,
    regressions: results.filter((r) => r.before.pass && !r.after.pass).length,
  };
}

/**
 * What the agent sees in a case: who it is, that side's instructions and the workspace's context, as in the chat.
 * No memory, skills or tools: the case measures the effect of the instructions, in a single call.
 */
export async function evalSystem(db: Db, agent: AgentRow, instructions: string): Promise<string> {
  const workspace = await workspaceBudgetDefaults(db, agent.workspaceId);
  return [
    `You are ${agent.name} (@${agent.handle}), an AI agent on ${PRODUCT.name}, the team chat of ${workspace.name}.`,
    agent.role !== "custom" ? `Your role on the team: ${agent.role}.` : "",
    `# Instructions\n${instructions.trim() || "No specific instructions yet. Be helpful and brief."}`,
    workspace.context.trim() ? `# About the company\n${workspace.context.trim()}` : "",
    "# This conversation\nA person on the team writes to you directly. Answer in the language of the person, " +
      "in plain chat style and briefly. You have no tools in this conversation.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Opens the run (one per agent) and runs the cases in the background. Each case asks the runtime for a text
 * (`complete`).
 */
export async function startEval(
  deps: AppDeps,
  input: { agent: AgentRow; userId: string; after: string; proposalId: string | null },
): Promise<EvalRow> {
  const { db } = deps;
  const cases = await db
    .select()
    .from(agentTestCases)
    .where(eq(agentTestCases.agentId, input.agent.id))
    .orderBy(asc(agentTestCases.createdAt), asc(agentTestCases.id));
  if (cases.length === 0) throw conflict("agent_eval.no_cases", "Add a test case first");
  let row: EvalRow | undefined;
  try {
    [row] = await db
      .insert(agentEvals)
      .values({
        id: newId("evl"),
        workspaceId: input.agent.workspaceId,
        agentId: input.agent.id,
        proposalId: input.proposalId,
        beforeText: input.agent.instructions,
        textAfter: input.after,
        total: cases.length,
        createdBy: input.userId,
        createdAt: deps.now(),
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("agent_eval.running", "A test run is already going");
    throw err;
  }
  if (!row) throw new Error("eval insert returned nothing");
  deps.runtime.track(runEval(deps, row, input.agent, cases, input.userId), "agent_eval");
  return row;
}

async function runEval(deps: AppDeps, row: EvalRow, agent: AgentRow, cases: TestCaseRow[], userId: string) {
  const { db, runtime } = deps;
  const systems = {
    before: await evalSystem(db, agent, row.beforeText),
    after: await evalSystem(db, agent, row.textAfter),
  };
  let stop: string | null = null;
  const side = async (c: TestCaseRow, which: "before" | "after", i: number) => {
    const res = await runtime.complete({
      agent,
      initiatedBy: userId,
      system: systems[which],
      prompt: c.input,
      what: `Test case ${i + 1}/${cases.length} (${which})`,
      maxTokens: EVAL_MAX_TOKENS,
      timeoutMs: EVAL_TIMEOUT_MS,
      source: "other",
    });
    if (!res.ok) {
      // No balance or a personal plan: the next cases wouldn't run either.
      if (res.code !== "failed") stop = res.error;
      return { side: { text: "", pass: false, failed: [`error:${res.code}`] }, runId: null };
    }
    return { side: checkReply(res.text, c), runId: res.runId };
  };
  let next = 0;
  const worker = async () => {
    while (stop === null) {
      const i = next++;
      const c = cases[i];
      if (!c) return;
      const [before, after] = await Promise.all([side(c, "before", i), side(c, "after", i)]);
      const runIds = [before.runId, after.runId].filter((id): id is string => id !== null);
      const [cost] = runIds.length
        ? await db
            .select({ usd: sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8` })
            .from(runs)
            .where(inArray(runs.id, runIds))
        : [{ usd: 0 }];
      const result: AgentEvalCase = { caseId: c.id, input: c.input, before: before.side, after: after.side };
      await db
        .update(agentEvals)
        .set({
          results: sql`${agentEvals.results} || ${JSON.stringify([result])}::jsonb`,
          costUsd: sql`${agentEvals.costUsd} + ${cost?.usd ?? 0}`,
        })
        .where(and(eq(agentEvals.id, row.id), eq(agentEvals.status, "running")));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(EVAL_CONCURRENCY, cases.length) }, worker));
  } catch (err) {
    stop = err instanceof Error ? err.message : String(err);
  }
  const [done] = await db.select().from(agentEvals).where(eq(agentEvals.id, row.id));
  if (done?.status !== "running") return;
  // In the cases' order (they run in parallel and arrive out of order).
  const order = new Map(cases.map((c, i) => [c.id, i]));
  const results = [...done.results].sort((a, b) => (order.get(a.caseId) ?? 0) - (order.get(b.caseId) ?? 0));
  await db
    .update(agentEvals)
    .set({
      status: stop === null ? "done" : "failed",
      error: stop,
      results,
      summary: summarize(results),
      finishedAt: deps.now(),
    })
    .where(and(eq(agentEvals.id, row.id), eq(agentEvals.status, "running")));
}

/** Runs and consolidations that were open when the server went down: the work in memory was lost. */
export async function failInterruptedAgentJobs(db: Db): Promise<void> {
  await db
    .update(agentEvals)
    .set({ status: "failed", error: "interrupted", finishedAt: new Date() })
    .where(eq(agentEvals.status, "running"));
  await db
    .update(memoryConsolidations)
    .set({ status: "failed", error: "interrupted", decidedAt: new Date() })
    .where(eq(memoryConsolidations.status, "running"));
}

/**
 * The JSON of a model's answer: the first object of the text, with or without a code fence. Null when there is
 * no object that parses.
 */
export function jsonFrom(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
