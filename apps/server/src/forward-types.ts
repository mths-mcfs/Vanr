// Minimal types of server modules that a later slice of the port brings in. Each one says the module it comes
// from; that slice replaces the import with the real module and deletes the type here.

import type { EffectClass, GateReason } from "@vanr/contract";
import type { Db, schema } from "@vanr/engine/db";
import type { Preview } from "@vanr/engine/effects";
import type { ModelProvider } from "@vanr/engine/models/types";
import type { Sealer } from "@vanr/engine/seal";
import type { UsageLedger } from "@vanr/engine/usage";
import type { Config } from "./config";

/** From `agents`. */
export type AgentRow = typeof schema.agents.$inferSelect;

/** From `wiki`. */
export type WikiRow = typeof schema.knowledgePages.$inferSelect;

/** From `assignments/core`. */
export type AssignmentRow = typeof schema.assignments.$inferSelect;

/** From `assignments/plan`. */
export type PlanItemRow = typeof schema.assignmentPlanItems.$inferSelect;

/** From `runtime/tools`: what the model reviewer sees of the call, the exact effect, never the agent's reasoning. */
export interface ReviewRequest {
  tool: string;
  effect: EffectClass;
  reason: GateReason;
  preview: Preview;
}

/** From `mailer`. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Kind of message, so the tests find the right link (verify, reset, invite...). */
  kind: string;
  link?: string;
}

/** From `mailer`. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** From `runtime/runtime`: why there is no provider for the agent; it becomes the run's `errorCode`. */
export type ProviderUnavailable = { error: "no_credential" | "unsupported_provider" };

/** From `runtime/runtime`: only the workspace and the credential decide the provider. */
export type ProviderLookup = (
  agent: Pick<AgentRow, "workspaceId" | "credentialId">,
) => Promise<ModelProvider | ProviderUnavailable>;

/** From `realtime/hub`. */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

/** From `context`: the part of the app dependencies the modules of this slice read. */
export interface AppDeps {
  config: Config;
  db: Db;
  now: () => Date;
  /** Real time: where each event goes (from `realtime/hub`). */
  hub: {
    toChannel(channelId: string, event: RealtimeEvent, opts?: { exceptUserId?: string }): void;
    toWorkspace(workspaceId: string, event: RealtimeEvent): void;
  };
  ledger: UsageLedger;
  /** Cipher of the API keys kept in the database. */
  sealer: Sealer;
}
