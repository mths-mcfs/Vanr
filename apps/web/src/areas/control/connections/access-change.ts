// One agent's access, changed from the matrix or from the agent's own tab. Every change reads the
// agent's access fresh and writes from what is saved now rather than from what the screen showed. One
// change at a time per agent: the controls stay disabled from the fresh read until the write is done,
// then the control the person used gets the focus back (a browser drops it on a control it disables).
// A 404 or 403 drops what the screen kept of this agent's access; a connection that is no longer active
// or an archived agent loads the reads again, so the screen stops offering them.
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@vanr/client";
import { prefixKey, useApiMutation, useVanrClient } from "@vanr/client/react";
import type { AgentAccess, ScopeGrant } from "@vanr/contract";
import { type FocusEvent, useEffect, useRef, useState } from "react";
import { useOutcome } from "../shared.tsx";
import { type ConnLevel, everythingSpelledOut, withBuiltin, withLevel } from "./levels.ts";
import { useForgetOnLoss, useLatch } from "./shared.tsx";

const READS = ["getAgentAccess", "listAgentScopes"] as const;
/** What a stale column or agent shows in: the matrix, the agent's page and its access. */
const STALE = ["listAgents", "getAgent", ...READS] as const;

/** The answer says the screen offered something that is gone: a connection, or the agent itself. */
const isStale = (error: unknown) =>
  isApiError(error) &&
  ((error.status === 400 && error.code === "access.unknown_connection") ||
    (error.status === 409 && error.code === "agent.archived"));

export function useAccessChange(workspaceId: string, agentId: string, onDone?: () => void) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const outcome = useOutcome();
  const latch = useLatch();
  const [busy, setBusy] = useState(false);
  // The last control focused inside the agent's controls (not a menu it opened elsewhere on the page).
  const lastFocused = useRef<HTMLElement | null>(null);
  const giveBack = useRef<HTMLElement | null>(null);
  const forget = useForgetOnLoss(workspaceId, READS);
  const args = { workspaceId, agentId };
  const invalidates = () => [
    { method: "getAgentAccess" as const, args },
    { method: "listAgentScopes" as const, args },
  ];
  const scopes = useApiMutation("setAgentScopes", { invalidates });
  const everything = useApiMutation("setAgentAccess", { invalidates });
  const reload = () => {
    for (const { method, args: of } of invalidates())
      void queryClient.invalidateQueries({ queryKey: prefixKey(client, { method, args: of }) });
  };
  const failed = (error: unknown) => {
    forget(error);
    if (isStale(error))
      for (const method of STALE)
        void queryClient.invalidateQueries({
          queryKey: prefixKey(client, { method, args: { workspaceId } }),
        });
    outcome.failed(error);
  };
  /** Runs one change: the fresh read, then the write it decides on, or nothing when nothing is left to do. */
  const run = (work: () => Promise<"written" | "unchanged">) =>
    latch(() => {
      giveBack.current = lastFocused.current;
      setBusy(true);
      return work()
        .then((done) => (done === "written" ? onDone?.() : reload()), failed)
        .finally(() => setBusy(false));
    });
  const rewrite = (next: (current: ScopeGrant[]) => ScopeGrant[]) =>
    run(() =>
      client
        .call("listAgentScopes", args)
        .then((current) => scopes.mutateAsync({ ...args, body: { scopes: next(current) } }))
        .then(() => "written" as const),
    );
  const pending = busy || scopes.isPending || everything.isPending;
  useEffect(() => {
    if (pending) return;
    const control = giveBack.current;
    giveBack.current = null;
    // Only when the focus fell to the page: a person who moved on keeps the focus where they put it.
    const fell = document.activeElement === null || document.activeElement === document.body;
    if (fell && control?.isConnected === true && !control.hasAttribute("disabled")) control.focus();
  }, [pending]);
  return {
    pending,
    /** For the element that holds this agent's controls: notes which one the person is using. */
    onFocusCapture: (event: FocusEvent<HTMLElement>) => {
      if (event.target instanceof HTMLElement && event.currentTarget.contains(event.target))
        lastFocused.current = event.target;
    },
    setLevel: (connection: AgentAccess["connectors"][number], level: ConnLevel) =>
      rewrite((current) => withLevel(current, connection, level)),
    setBuiltin: (scope: string, on: boolean) => rewrite((current) => withBuiltin(current, scope, on)),
    // From the access as it is now: when someone else already made the switch, nothing is written and
    // the screen catches up, so a stale screen never widens or resets what they saved.
    setEverything: (on: boolean) =>
      run(() =>
        client.call("getAgentAccess", args).then((access) => {
          if (access.all === on) return "unchanged" as const;
          const write = on
            ? everything.mutateAsync({ ...args, body: { all: true } })
            : scopes.mutateAsync({ ...args, body: { scopes: everythingSpelledOut(access) } });
          return write.then(() => "written" as const);
        }),
      ),
  };
}
