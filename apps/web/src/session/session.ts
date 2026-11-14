// Who is signed in. The answer is the client's `getMe` (the person, or null when nobody is) and
// lives in the query cache under that call's own key; screens read it with `useSession()`.

import type { QueryClient } from "@tanstack/react-query";
import type { VanrClient } from "@vanr/client";
import { queryKey } from "@vanr/client/react";
import type { Me } from "@vanr/contract";
import { z } from "zod";
import { type KeyValueStore, readStored, STORAGE_KEYS, writeStored } from "../platform/storage.ts";
import { href } from "../routes.ts";
import type { SessionGate } from "./gate.ts";

/** How long the answer to "who am I" is reused before asking again. */
export const SESSION_FRESH_MS = 30_000;

export type Session = {
  /** Query options for the signed-in person (null when nobody is). */
  options: {
    queryKey: readonly unknown[];
    queryFn: () => Promise<Me | null>;
    staleTime: number;
  };
  /** The signed-in person, from the cache when recent; `fresh` always asks the server. */
  load: (fresh?: boolean) => Promise<Me | null>;
  /** Forgets the person and everything cached for them. */
  forget: () => void;
  /** Drops what was cached for whoever was here before; keeps the answer to "who am I". */
  dropCachedData: () => void;
};

export function createSession(deps: {
  client: VanrClient;
  queryClient: QueryClient;
  gate: SessionGate;
}): Session {
  const key = queryKey(deps.client, "getMe");
  const queryFn = async (): Promise<Me | null> => {
    const me = await deps.client.call("getMe", undefined);
    if (me !== null) deps.gate.established(me.user.id);
    return me;
  };
  const options = { queryKey: key, queryFn, staleTime: SESSION_FRESH_MS };
  const dropCachedData = () =>
    deps.queryClient.removeQueries({ predicate: (query) => query.queryKey[2] !== key[2] });
  return {
    options,
    load: (fresh = false) =>
      deps.queryClient.fetchQuery({ ...options, staleTime: fresh ? 0 : SESSION_FRESH_MS }),
    forget() {
      deps.queryClient.setQueryData(key, null);
      dropCachedData();
    },
    dropCachedData,
  };
}

/** The workspace someone last had open, when it is still one of theirs. */
export function lastWorkspaceId(store: KeyValueStore, me: Me): string | undefined {
  const stored = readStored(store, STORAGE_KEYS.lastWorkspace, z.string());
  return me.workspaces.some((workspace) => workspace.id === stored) ? stored : undefined;
}

export function rememberWorkspace(store: KeyValueStore, workspaceId: string): void {
  writeStored(store, STORAGE_KEYS.lastWorkspace, workspaceId);
}

/** Where a signed-in person starts: the workspace they last had open, their first one, or creating one. */
export function startAddress(store: KeyValueStore, me: Me): string {
  const workspaceId = lastWorkspaceId(store, me) ?? me.workspaces[0]?.id;
  return workspaceId === undefined ? href("onboarding", {}) : href("home", { workspaceId });
}
