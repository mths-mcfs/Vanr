// Who is signed in. The answer is the client's `getMe` (the person, or null when nobody is) and
// lives in the query cache under that call's own key; screens read it with `useSession()`.

import type { QueryClient } from "@tanstack/react-query";
import { ApiError, type VanrClient } from "@vanr/client";
import { queryKey } from "@vanr/client/react";
import type { Me } from "@vanr/contract";
import { z } from "zod";
import { type KeyValueStore, readStored, STORAGE_KEYS, writeStored } from "../platform/storage.ts";
import { href } from "../routes.ts";
import type { SessionGate } from "./gate.ts";

/** How long the answer to "who am I" is reused before asking again. */
export const SESSION_FRESH_MS = 30_000;

type SessionOptions = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<Me | null>;
  staleTime: number;
};

export type Session = {
  /** Query options for the signed-in person (null when nobody is), in the open generation. */
  readonly options: SessionOptions;
  /** The signed-in person, from the cache when recent; `fresh` always asks the server. */
  load: (fresh?: boolean) => Promise<Me | null>;
  /** Forgets the person and everything cached for them. */
  forget: () => void;
  /** Drops what was cached for whoever was here before; keeps the answer to "who am I". */
  dropCachedData: () => void;
  /** The cached answer to "who am I" may be wrong: the next `load` asks the server. */
  expire: () => void;
};

export function createSession(deps: {
  /** The client is read at each call: it changes with the session generation. */
  api: { readonly client: VanrClient };
  queryClient: QueryClient;
  gate: SessionGate;
}): Session {
  const optionsFor = (client: VanrClient): SessionOptions => ({
    queryKey: queryKey(client, "getMe"),
    queryFn: async () => {
      const me = await client.call("getMe", undefined);
      if (me !== null) deps.gate.established(me.user.id);
      // The gate may have ended the generation just now (the answer names someone else than the
      // person this page knew): the answer belongs to the next one, which asks for itself.
      if (deps.api.client !== client) {
        throw new ApiError({ status: 0, code: "canceled", message: "The session changed" });
      }
      return me;
    },
    staleTime: SESSION_FRESH_MS,
  });
  const key = () => queryKey(deps.api.client, "getMe");
  const dropCachedData = () => {
    const mine = key();
    deps.queryClient.removeQueries({
      predicate: (query) => query.queryKey[1] !== mine[1] || query.queryKey[2] !== mine[2],
    });
  };
  return {
    get options() {
      return optionsFor(deps.api.client);
    },
    async load(fresh = false) {
      for (;;) {
        const client = deps.api.client;
        try {
          return await deps.queryClient.fetchQuery({
            ...optionsFor(client),
            staleTime: fresh ? 0 : SESSION_FRESH_MS,
          });
        } catch (cause) {
          // The generation ended while the answer was on its way: that answer was discarded, and
          // the question is asked again as whoever is here now.
          if (deps.api.client === client) throw cause;
        }
      }
    },
    forget() {
      deps.queryClient.setQueryData(key(), null);
      dropCachedData();
    },
    dropCachedData,
    expire() {
      void deps.queryClient.invalidateQueries({ queryKey: key(), refetchType: "none" });
    },
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
