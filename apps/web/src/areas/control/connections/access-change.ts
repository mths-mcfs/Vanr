// One agent's access, changed from the matrix or from the agent's own tab. Every change reads the
// agent's scopes fresh and writes the whole list back, so it builds on what is saved now rather than
// on what the screen showed; one change at a time per agent, and a second press while one is on its
// way is dropped. A 404 or 403 drops what the screen kept of this agent's access.
import { useApiMutation, useVanrClient } from "@vanr/client/react";
import type { AgentAccess, ScopeGrant } from "@vanr/contract";
import { useOutcome } from "../shared.tsx";
import { type ConnLevel, everythingSpelledOut, withBuiltin, withLevel } from "./levels.ts";
import { useForgetOnLoss, useLatch } from "./shared.tsx";

const READS = ["getAgentAccess", "listAgentScopes"] as const;

export function useAccessChange(workspaceId: string, agentId: string, onDone?: () => void) {
  const client = useVanrClient();
  const outcome = useOutcome();
  const latch = useLatch();
  const forget = useForgetOnLoss(workspaceId, READS);
  const invalidates = () => [
    { method: "getAgentAccess" as const, args: { workspaceId, agentId } },
    { method: "listAgentScopes" as const, args: { workspaceId, agentId } },
  ];
  const scopes = useApiMutation("setAgentScopes", { invalidates });
  const everything = useApiMutation("setAgentAccess", { invalidates });
  const args = { workspaceId, agentId };
  const failed = (error: unknown) => {
    forget(error);
    outcome.failed(error);
  };
  const rewrite = (next: (current: ScopeGrant[]) => ScopeGrant[]) =>
    latch(() =>
      client
        .call("listAgentScopes", args)
        .then((current) => scopes.mutateAsync({ ...args, body: { scopes: next(current) } }))
        .then(() => onDone?.(), failed),
    );
  return {
    pending: scopes.isPending || everything.isPending,
    setLevel: (connection: AgentAccess["connectors"][number], level: ConnLevel) =>
      rewrite((current) => withLevel(current, connection, level)),
    setBuiltin: (scope: string, on: boolean) => rewrite((current) => withBuiltin(current, scope, on)),
    setEverything: (access: AgentAccess, on: boolean) =>
      on
        ? latch(() => everything.mutateAsync({ ...args, body: { all: true } }).then(() => onDone?.(), failed))
        : latch(() =>
            scopes
              .mutateAsync({ ...args, body: { scopes: everythingSpelledOut(access) } })
              .then(() => onDone?.(), failed),
          ),
  };
}
