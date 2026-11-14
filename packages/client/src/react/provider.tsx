// Puts a client (and, optionally, a realtime connection) in reach of the hooks, and wires realtime events
// to cache invalidation: each event refetches what the invalidation table says it made stale, and a
// ready connection refetches what this client cached (events sent before it was ready were lost).
import { type QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import type { VanrClient } from "../client.ts";
import type { RealtimeClient } from "../realtime/socket.ts";
import { invalidateForEvent } from "./invalidation.ts";
import { clientKey } from "./keys.ts";

interface VanrContextValue {
  client: VanrClient;
  realtime: RealtimeClient | null;
}

const VanrContext = createContext<VanrContextValue | null>(null);

export interface VanrProviderProps {
  client: VanrClient;
  /** Started on mount and stopped on unmount. */
  realtime?: RealtimeClient | null;
  /** When given, the provider also provides it to React Query; otherwise an outer QueryClientProvider must. */
  queryClient?: QueryClient;
  children?: ReactNode;
}

export function VanrProvider({ client, realtime = null, queryClient, children }: VanrProviderProps) {
  const value = useMemo(() => ({ client, realtime }), [client, realtime]);
  const inner = (
    <VanrContext.Provider value={value}>
      <RealtimeBridge realtime={realtime} />
      {children}
    </VanrContext.Provider>
  );
  return queryClient ? <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider> : inner;
}

function RealtimeBridge({ realtime }: { realtime: RealtimeClient | null }) {
  const qc = useQueryClient();
  const { client } = useVanrContext();
  useEffect(() => {
    if (!realtime) return;
    const offEvent = realtime.onAny((event) => {
      void invalidateForEvent(qc, event, realtime.workspaceId, client);
    });
    const offReady = realtime.onStatus((status) => {
      if (status === "open") void qc.invalidateQueries({ queryKey: clientKey(client) });
    });
    // Started a microtask later: StrictMode mounts, unmounts and mounts again in one go, and connecting
    // right away would open a socket only to close it.
    let live = true;
    queueMicrotask(() => {
      if (live) realtime.start();
    });
    return () => {
      live = false;
      offEvent();
      offReady();
      realtime.stop();
    };
  }, [qc, realtime, client]);
  return null;
}

export function useVanrContext(): VanrContextValue {
  const value = useContext(VanrContext);
  if (!value) throw new Error("Vanr hooks need a <VanrProvider> above them");
  return value;
}
