// Minimal types of server modules that a later slice of the port brings in. Each one says the module it comes
// from; that slice replaces the import with the real module and deletes the type here.

import type { AgentAction, AgentActionKind, EffectClass, GateReason } from "@vanr/contract";
import type { Db } from "@vanr/engine/db";
import type { Preview } from "@vanr/engine/effects";
import type { ModelProvider } from "@vanr/engine/models/types";
import type { BudgetScope } from "@vanr/engine/usage";
import type { AgentRow } from "./agents";
import type { AppDeps } from "./context";

/** From `runtime/tools`: what the model reviewer sees of the call, the exact effect, never the agent's reasoning. */
export interface ReviewRequest {
  tool: string;
  effect: EffectClass;
  reason: GateReason;
  preview: Preview;
}

/** From `runtime/runtime`: why there is no provider for the agent; it becomes the run's `errorCode`. */
export type ProviderUnavailable = { error: "no_credential" | "unsupported_provider" };

/** From `runtime/runtime`: only the workspace and the credential decide the provider. */
export type ProviderLookup = (
  agent: Pick<AgentRow, "workspaceId" | "credentialId">,
) => Promise<ModelProvider | ProviderUnavailable>;

/** From `runtime/tools`: the "always allow" predicate a person can remember for a call. */
export interface StandingRuleKey {
  /** What matches: the same tool, the same agent and this key. */
  key: string;
  /** The predicate as text, without a language (channel, recipients, command); the screen adds the tool's name. */
  label: string;
}

/** From `runtime/tools`: the effect again after a person edited the approval's input. */
export interface RevisedApproval {
  input: unknown;
  payloadHash: string;
  preview: Preview;
  effect: EffectClass;
  rule: StandingRuleKey | null;
}

/** From `runtime/tools`: how a person (or the clock) decided an approval a run waits on. */
export interface ApprovalOutcome {
  id: string;
  decision: "approved" | "rejected" | "expired" | "canceled";
  reason: string | null;
  byName: string | null;
  /** The approved input (the edited one, if the person edited it) and its hash. */
  input?: unknown;
  payloadHash?: string;
  edited?: boolean;
}

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

/** From `runtime/tools`: what `queueSend` (outbox) reads of the run that asks for a send. */
export interface ToolContext {
  deps: AppDeps;
  workspaceId: string;
  agent: Pick<AgentRow, "id">;
  runId: string;
  /**
   * Records an action a person can undo; the receipt goes with the agent's next message. With `tx`, the action is
   * written in that transaction (the outbox's: the queued send and its receipt exist together or not at all).
   */
  recordAction(
    action: {
      kind: AgentActionKind;
      target: AgentAction["target"];
      params?: Record<string, unknown>;
      /** Until when it can be undone; by default, the usual window (24 h). */
      revertibleUntil?: Date;
    },
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  ): Promise<void>;
}
