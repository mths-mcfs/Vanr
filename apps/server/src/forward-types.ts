// Minimal types of server modules that a later slice of the port brings in. Each one says the module it comes
// from; that slice replaces the import with the real module and deletes the type here.

import type { ModelProvider } from "@vanr/engine/models/types";
import type { BudgetScope } from "@vanr/engine/usage";
import type { AgentRow } from "./agents";

/** From `runtime/runtime`: why there is no provider for the agent; it becomes the run's `errorCode`. */
export type ProviderUnavailable = { error: "no_credential" | "unsupported_provider" };

/** From `runtime/runtime`: only the workspace and the credential decide the provider. */
export type ProviderLookup = (
  agent: Pick<AgentRow, "workspaceId" | "credentialId">,
) => Promise<ModelProvider | ProviderUnavailable>;

/** From `runtime/runtime`: the end of a run, for whoever follows it (the assignment engine wakes the thread's assignment). */
export interface RunEnd {
  runId: string;
  workspaceId: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  status: "done" | "failed" | "canceled";
  errorCode: string | null;
}

/**
 * From `runtime/runtime`: the hard caps of a run nobody follows (a routine's execution): spend caps beyond
 * the agent's month, model turns and time. Past any of them the run stops with `budget_exhausted`
 * (`routine_budget` when it was the execution's cap), `step_limit` or `time_limit`.
 */
export interface RunLimits {
  scopes: readonly BudgetScope[];
  maxTurns: number;
  timeoutMs: number;
  /**
   * The execution's key (the same on every attempt): an outside effect (K2/K3 or an external destination)
   * with the same key and the same payload doesn't run again on the retry.
   */
  effectKey?: string;
}
