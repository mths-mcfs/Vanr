// Who is signed in. The answer lives in the query cache under the key of `getMe`, as the person
// or null, and this module is the only reader of that operation: screens use `useSession()`.

import type { QueryClient } from "@tanstack/react-query";
import type { Me } from "@vanr/contract";
import { z } from "zod";
import { type Api, isApiError, queryKey } from "../api/index.ts";
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

export function createSession(deps: { api: Api; queryClient: QueryClient; gate: SessionGate }): Session {
  const key = queryKey("getMe");
  const queryFn = async (): Promise<Me | null> => {
    try {
      const me = await deps.api.getMe();
      deps.gate.established(me.user.id);
      return me;
    } catch (cause) {
      // Nobody is signed in: an answer, not a failure.
      if (isApiError(cause) && cause.status === 401) return null;
      throw cause;
    }
  };
  const options = { queryKey: key, queryFn, staleTime: SESSION_FRESH_MS };
  const dropCachedData = () =>
    deps.queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== key[0] });
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
