// Minimal types of server modules that a later slice of the port brings in. Each one says the module it comes
// from; that slice replaces the import with the real module and deletes the type here.

import type { EffectClass, GateReason } from "@vanr/contract";
import type { schema } from "@vanr/engine/db";
import type { Preview } from "@vanr/engine/effects";
import type { ModelProvider } from "@vanr/engine/models/types";

/** From `agents`. */
export type AgentRow = typeof schema.agents.$inferSelect;

/** From `wiki`. */
export type WikiRow = typeof schema.knowledgePages.$inferSelect;

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
