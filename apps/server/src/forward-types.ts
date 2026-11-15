// Minimal types of server modules that a later slice of the port brings in. Each one says the module it comes
// from; that slice replaces the import with the real module and deletes the type here.

import type { EffectClass, GateReason } from "@vanr/contract";
import type { schema } from "@vanr/engine/db";
import type { Preview } from "@vanr/engine/effects";
import type { ModelProvider } from "@vanr/engine/models/types";
import type { BudgetScope } from "@vanr/engine/usage";
import type { AgentRow } from "./agents";
import type { AppDeps } from "./context";

/** From `assignments/core`. */
export type AssignmentRow = typeof schema.assignments.$inferSelect;

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

/** From `messages`. */
export type MessageRow = typeof schema.messages.$inferSelect;

/** From `control`. */
export type QuestionRow = typeof schema.questions.$inferSelect;

/** From `control`: an agent action a person can undo and redo. */
export type ActionRow = typeof schema.reversibleActions.$inferSelect;

/** From `control`: what undoing and redoing one kind of action does. */
export type Undoer = {
  undo(deps: AppDeps, row: ActionRow, actorUserId: string): Promise<void>;
  redo(deps: AppDeps, row: ActionRow, actorUserId: string): Promise<void>;
};

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
