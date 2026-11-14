// Puts a client (and, optionally, a realtime connection) in reach of the hooks, and wires realtime events
// to cache invalidation: each event refetches what the invalidation table says it made stale, and a
// reconnect refetches everything the client cached (events sent while it was down were lost).
import { type QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import type { VanrClient } from "../client.ts";
import type { RealtimeClient } from "../realtime/socket.ts";
import { invalidateForEvent } from "./invalidation.ts";
import { KEY_ROOT } from "./keys.ts";

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
  useEffect(() => {
    if (!realtime) return;
    const offEvent = realtime.onAny((event) => {
      void invalidateForEvent(qc, event, realtime.workspaceId);
    });
    const offReconnect = realtime.onReconnect(() => {
      void qc.invalidateQueries({ queryKey: [KEY_ROOT] });
    });
    realtime.start();
    return () => {
      offEvent();
      offReconnect();
      realtime.stop();
    };
  }, [qc, realtime]);
  return null;
}

export function useVanrContext(): VanrContextValue {
  const value = useContext(VanrContext);
  if (!value) throw new Error("Vanr hooks need a <VanrProvider> above them");
  return value;
}
