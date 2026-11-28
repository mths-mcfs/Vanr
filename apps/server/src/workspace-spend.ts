// Calls the workspace pays with no agent behind them: search answers, wiki checks and agent drafts. Each one
// reserves against the workspace's month budget before it goes out (`workspaceBudgetScope`) and settles at its real
// cost, so once the month's spend reaches the budget they stop with 402 `workspace.budget`. The test model (no key)
// costs nothing and skips the ledger.

import { PRICES } from "@vanr/engine/models/prices";
import type { Usage } from "@vanr/engine/models/types";
import { estimateUsd, type UsageSource } from "@vanr/engine/usage";
import { workspaceBudgetScope } from "./agents";
import type { AppDeps } from "./context";
import { HttpError } from "./http";

export const workspaceOutOfBudget = () =>
  new HttpError(402, "workspace.budget", "This workspace has spent its budget for this month");

export interface WorkspaceCall {
  workspaceId: string;
  userId: string | null;
  source: UsageSource;
  model: string;
  /** What the prompt weighs (system and messages), for the reservation's ceiling. */
  promptBytes: number;
  maxTokens: number;
  /** The test model answers: nothing is reserved or recorded. */
  test: boolean;
}

/**
 * Runs one model call on the workspace's budget: reserve, call, settle at the real cost (a failed call frees its
 * reservation). Out of budget, the call never goes out and this throws `workspaceOutOfBudget`.
 */
export async function onWorkspaceBudget<T>(
  deps: AppDeps,
  call: WorkspaceCall,
  run: () => Promise<{ value: T; usage: Usage }>,
): Promise<T> {
  if (call.test) return (await run()).value;
  const at = deps.now();
  const held = await deps.ledger.reserve({
    workspaceId: call.workspaceId,
    scopes: [await workspaceBudgetScope(deps.db, call.workspaceId)],
    estimateUsd: estimateUsd(PRICES, {
      model: call.model,
      promptBytes: call.promptBytes,
      maxTokens: call.maxTokens,
      at,
    }),
    at,
  });
  if (!held.ok) throw workspaceOutOfBudget();
  let done: { value: T; usage: Usage };
  try {
    done = await run();
  } catch (err) {
    await deps.ledger.release(held.reservation);
    throw err;
  }
  await deps.ledger.settle(held.reservation, {
    workspaceId: call.workspaceId,
    agentId: null,
    userId: call.userId,
    runId: null,
    source: call.source,
    model: call.model,
    usage: done.usage,
    at: deps.now(),
  });
  return done.value;
}
