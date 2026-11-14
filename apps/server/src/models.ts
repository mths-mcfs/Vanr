// Which provider runs an agent: the agent's credential, else the workspace's primary one, else the
// platform key (ANTHROPIC_API_KEY), else the fake provider (dev and tests without a key). In production
// there is no fake provider (`config.model` is never `fake` there): no credential and no key, `no_credential`.
import { schema } from "@vanr/engine/db";
import { anthropicProvider } from "@vanr/engine/models/anthropic";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelProvider } from "@vanr/engine/models/types";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDeps } from "./context";
import type { AgentRow, ProviderLookup } from "./forward-types";

const { credentials, workspaces } = schema;

export function createProviderLookup(deps: AppDeps, opts: { forceFake?: boolean }): ProviderLookup {
  const { config } = deps;
  const fake = fakeProvider({ chunkDelayMs: config.model.provider === "fake" ? config.model.delayMs : 0 });
  const platform = config.model.provider === "anthropic" ? anthropicProvider(config.model.apiKey) : null;
  // One client per credential; the key is part of the cache key so a rotation applies at once.
  const byCredential = new Map<string, ModelProvider>();

  return async (agent: Pick<AgentRow, "workspaceId" | "credentialId">) => {
    if (opts.forceFake || (config.model.provider === "fake" && config.model.forced)) return fake;
    let credentialId = agent.credentialId;
    if (!credentialId) {
      const [workspace] = await deps.db
        .select({ id: workspaces.primaryCredentialId })
        .from(workspaces)
        .where(eq(workspaces.id, agent.workspaceId));
      credentialId = workspace?.id ?? null;
    }
    if (credentialId) {
      const [cred] = await deps.db
        .select()
        .from(credentials)
        .where(and(eq(credentials.id, credentialId), eq(credentials.workspaceId, agent.workspaceId)));
      // A revoked credential stops the run: falling back to the platform key would spend the installation's
      // money on a workspace that turned its own key off.
      if (cred?.revokedAt) return { error: "no_credential" };
      if (cred) {
        if (cred.provider !== "anthropic") return { error: "unsupported_provider" };
        const cacheKey = `${cred.id}:${cred.secret}`;
        let provider = byCredential.get(cacheKey);
        if (!provider) {
          provider = anthropicProvider(deps.sealer.open(cred.secret));
          byCredential.set(cacheKey, provider);
        }
        return provider;
      }
    }
    if (platform) return platform;
    if (config.model.provider === "fake") return fake;
    return { error: "no_credential" };
  };
}

export const platformKeyAvailable = (deps: AppDeps) => deps.config.model.provider === "anthropic";

/**
 * For the UI: for each agent of the workspace, whether the test model would answer now. Same rule as the
 * lookup above, in two queries for the whole workspace. An agent whose harness runs on a runner does not use the lookup.
 */
export async function testModelCheck(
  deps: AppDeps,
  workspaceId: string,
  forceFake: boolean,
): Promise<(agent: Pick<AgentRow, "credentialId" | "harnessKind">) => boolean> {
  const { config, db } = deps;
  const viaApi = (agent: Pick<AgentRow, "harnessKind">) => agent.harnessKind === "model";
  if (forceFake || (config.model.provider === "fake" && config.model.forced)) return viaApi;
  // With the platform key, or in production (no fake provider), nobody answers through the test model.
  if (config.model.provider !== "fake") return () => false;
  const [workspace] = await db
    .select({ id: workspaces.primaryCredentialId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const live = new Set(
    (
      await db
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.workspaceId, workspaceId), isNull(credentials.revokedAt)))
    ).map((r) => r.id),
  );
  return (agent) => {
    const id = agent.credentialId ?? workspace?.id ?? null;
    return viaApi(agent) && !(id && live.has(id));
  };
}
