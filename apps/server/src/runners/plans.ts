// Claude Code and Codex use the plan (Claude Pro/Max, ChatGPT) of whoever paired the runner. The login stays
// in that runner's CLI; the server never sees a token. The subscription is personal (Anthropic's and
// OpenAI's terms treat the plan that way), and this is a lock, not an option: the agent that thinks with the
// plan only talks to whoever paired it (`planOwnerUserId` in the rule of `runtime/route.ts`), and only that
// person's messages, routines and assignments run on the plan. Not even the API fallback serves another person.
import type { AgentHarness, HarnessOption, HarnessUnavailableReason } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { DEFAULT_MODEL, MODELS } from "@vanr/engine/models/catalog";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDeps } from "../context";
import type { AgentRow } from "../forward-types";
import { forbidden, HttpError } from "../http";
import { talkBlock } from "../runtime/route";
import type { RunnerRow } from "./runners";

const { runners } = schema;

export type Executor = "claude_code" | "codex";
export const EXECUTOR_NAME: Record<Executor, string> = { claude_code: "Claude Code", codex: "Codex" };

/** Models of each CLI (empty = the CLI's default, which follows the plan). */
export const EXECUTOR_MODELS: Record<Executor, { value: string; label: string; recommended?: boolean }[]> = {
  claude_code: [
    { value: "", label: "Default", recommended: true },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  codex: [{ value: "", label: "Default", recommended: true }],
};

export const executorModelOk = (executor: Executor, model: string) =>
  EXECUTOR_MODELS[executor].some((m) => m.value === model);

const TOOL = { claude_code: "claude", codex: "codex" } as const;

/** Why this runner doesn't do for the executor (null: it does, it only has to be online). */
export function executorProblem(
  runner: RunnerRow | null,
  executor: Executor,
): HarnessUnavailableReason | null {
  if (!runner) return "no_environment";
  if (!runner.executors.includes(executor)) return "not_installed";
  if (!runner.access.tools[TOOL[executor]]) return "tool_off";
  if (runner.cli[executor]?.login !== "subscription") return "not_logged_in";
  return null;
}

/** Using the plan of whoever paired it: only that person. */
export const canUsePlan = (userId: string | null, runner: Pick<RunnerRow, "pairedByUserId">) =>
  userId !== null && runner.pairedByUserId === userId;

/** The agent with whoever paired its runner, if it thinks with the plan (the rule of who talks to it). */
export type Talker = AgentRow & { planOwnerUserId: string | null };

/**
 * Loads who paired the runner of each agent that thinks with the plan. Without a runner (or with it
 * removed) the agent uses no plan at all, and its audience applies.
 */
export async function withPlanOwners(db: Db, rows: AgentRow[]): Promise<Talker[]> {
  const ids = [
    ...new Set(rows.flatMap((r) => (r.harnessKind !== "model" && r.environmentId ? [r.environmentId] : []))),
  ];
  const owners = ids.length
    ? await db
        .select({ id: runners.id, pairedByUserId: runners.pairedByUserId })
        .from(runners)
        .where(and(inArray(runners.id, ids), isNull(runners.removedAt)))
    : [];
  const byId = new Map(owners.map((o) => [o.id, o.pairedByUserId]));
  return rows.map((r) => ({
    ...r,
    planOwnerUserId:
      r.harnessKind !== "model" && r.environmentId ? (byId.get(r.environmentId) ?? null) : null,
  }));
}

export async function withPlanOwner(db: Db, row: AgentRow): Promise<Talker> {
  const [talker] = await withPlanOwners(db, [row]);
  return talker ?? { ...row, planOwnerUserId: null };
}

export const PERSONAL_PLAN_TEXT =
  "thinks with the personal plan of who paired its environment and only talks to that person";

export const personalPlanError = () =>
  new HttpError(403, "agent.personal_plan", `This agent ${PERSONAL_PLAN_TEXT}`);

/** Blocks whoever doesn't talk to the agent: outside the audience, or another person on a personal-plan agent. */
export async function requireCanTalk(db: Db, agent: AgentRow, userId: string): Promise<void> {
  const block = talkBlock(await withPlanOwner(db, agent), userId);
  if (block === "personal_plan") throw personalPlanError();
  if (block) throw forbidden("This agent only talks to its audience");
}

async function liveRunner(db: Db, id: string | null): Promise<RunnerRow | null> {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.id, id), isNull(runners.removedAt)));
  return row ?? null;
}

function executorOption(executor: Executor, runner: RunnerRow | null, viewerId: string): HarnessOption {
  const problem =
    executorProblem(runner, executor) ?? (runner && !canUsePlan(viewerId, runner) ? "personal_plan" : null);
  return {
    kind: executor,
    available: problem === null,
    reason: problem,
    defaultModel: "",
    models: EXECUTOR_MODELS[executor],
  };
}

/** The agent's harness as seen by whoever opens the screen (the options depend on who may use the plan). */
export async function harnessView(deps: AppDeps, agent: AgentRow, viewerId: string): Promise<AgentHarness> {
  const environment = await liveRunner(deps.db, agent.environmentId);
  const mine = await deps.db
    .select()
    .from(runners)
    .where(
      and(
        eq(runners.workspaceId, agent.workspaceId),
        isNull(runners.removedAt),
        eq(runners.pairedByUserId, viewerId),
      ),
    );
  const model: HarnessOption = {
    kind: "model",
    available: true,
    reason: null,
    defaultModel: DEFAULT_MODEL,
    models: MODELS.map((m) => ({
      value: m.id,
      label: m.label,
      ...(m.recommended ? { recommended: true } : {}),
    })),
  };
  return {
    harness: agent.harnessKind,
    resolvedModel: agent.harnessKind === "model" ? agent.model : (agent.harnessModel ?? ""),
    fallback: agent.harnessFallback,
    options: [
      model,
      executorOption("claude_code", environment, viewerId),
      executorOption("codex", environment, viewerId),
    ],
    runners: mine.map((m) => ({
      runnerId: m.id,
      name: m.name,
      online: deps.runners.isOnline(m.id),
      options: [executorOption("claude_code", m, viewerId), executorOption("codex", m, viewerId)],
    })),
    environment: agent.environmentId,
  };
}

export type UnavailableCode =
  | HarnessUnavailableReason
  | "offline"
  | "paused"
  | "plan_limit"
  | "harness_failed";

export type RunHarness =
  | { kind: "model" }
  | { kind: "remote"; executor: Executor; runner: RunnerRow; model: string | null }
  | { kind: "unavailable"; executor: Executor; code: UnavailableCode; runner: RunnerRow | null };

/**
 * Who thinks in this run. `userId` is the person who asked (their message or routine). A request from
 * another person gives `personal_plan`, which doesn't fall to the API fallback: the plan's agent serves
 * no one but whoever paired it.
 */
export async function runHarnessFor(
  deps: AppDeps,
  agent: AgentRow,
  userId: string | null,
): Promise<RunHarness> {
  if (agent.harnessKind === "model") return { kind: "model" };
  const executor = agent.harnessKind;
  const runner = await liveRunner(deps.db, agent.environmentId);
  const out = (code: UnavailableCode): RunHarness => ({ kind: "unavailable", executor, code, runner });
  if (!runner) return out("no_environment");
  // Who asks comes before the runner's state: `offline` and the like fall to the fallback, `personal_plan` doesn't.
  if (!canUsePlan(userId, runner)) return out("personal_plan");
  if (!deps.runners.isOnline(runner.id)) return out("offline");
  if (runner.paused) return out("paused");
  const problem = executorProblem(runner, executor);
  if (problem) return out(problem);
  return { kind: "remote", executor, runner, model: agent.harnessModel || null };
}
