// Real time for a workspace. The frame mounts <WorkspaceRealtime>, which owns the one connection
// (the client's RealtimeClient) and hands it to the client's own provider: every event refetches
// what the client's invalidation table says it made stale, and a reconnect refetches everything.
//
// Areas listen with `useRealtimeEvent` from `@vanr/client/react`. What this file adds is what the
// client leaves to the app: the connection's status, a reconnect on request, counted channel
// subscriptions, and refetching a call the invalidation table does not tie to an event.

import { useQueryClient } from "@tanstack/react-query";
import {
  type BrowserEventName,
  createRealtime,
  type RealtimeClient,
  type RealtimeStatus,
} from "@vanr/client";
import {
  type KeyPrefix,
  prefixKey,
  useRealtime,
  useRealtimeEvent,
  useVanrClient,
  VanrProvider,
} from "@vanr/client/react";
import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRuntime } from "../app/context.tsx";

/** Opens the workspace's connection while mounted and stops it on the way out. */
export function WorkspaceRealtime({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const client = useVanrClient();
  const { openSocket, clock, gate, session } = useRuntime();
  const realtime = useMemo(
    () =>
      createRealtime({
        workspaceId,
        baseUrl: openSocket.baseUrl,
        clock,
        ...(openSocket.createSocket !== undefined && { createSocket: openSocket.createSocket }),
        ...(openSocket.random !== undefined && { random: openSocket.random }),
        onEnded: (why) => {
          // The session is over: the same road as a 401. Removed from the workspace: ask again who
          // the person is, and the frame shows they are no longer a member.
          if (why === "signed_out") gate.ended();
          else void session.load(true);
        },
      }),
    [workspaceId, openSocket, clock, gate, session],
  );
  return (
    <VanrProvider client={client} realtime={realtime}>
      {children}
    </VanrProvider>
  );
}

const never = () => () => {};

/** The connection's status; `stopped` outside a workspace. */
export function useRealtimeStatus(): RealtimeStatus {
  const realtime = useRealtime();
  const subscribe = useCallback(
    (notify: () => void) => (realtime === null ? never() : realtime.onStatus(notify)),
    [realtime],
  );
  return useSyncExternalStore(
    subscribe,
    () => realtime?.status ?? "stopped",
    () => "stopped",
  );
}

/** Tries to connect right away instead of waiting out the current reconnection delay. */
export function useReconnectNow(): () => void {
  const realtime = useRealtime();
  return useCallback(() => {
    if (realtime === null || realtime.status !== "reconnecting") return;
    // The client has no "retry now": stopping and starting drops the wait and keeps the subscriptions.
    realtime.stop();
    realtime.start();
  }, [realtime]);
}

// How many mounted components follow each channel of each connection.
const followers = new WeakMap<RealtimeClient, Map<string, number>>();

/** Follows a channel's events while mounted. Two components on the same channel share one subscription. */
export function useChannelSubscription(channelId: string | undefined): void {
  const realtime = useRealtime();
  useEffect(() => {
    if (realtime === null || channelId === undefined) return;
    const counts = followers.get(realtime) ?? new Map<string, number>();
    followers.set(realtime, counts);
    const before = counts.get(channelId) ?? 0;
    counts.set(channelId, before + 1);
    if (before === 0) realtime.subscribe(channelId);
    return () => {
      const left = (counts.get(channelId) ?? 1) - 1;
      if (left > 0) counts.set(channelId, left);
      else {
        counts.delete(channelId);
        realtime.unsubscribe(channelId);
      }
    };
  }, [realtime, channelId]);
}

/**
 * Refetches a call when an event arrives, for the few pairs the client's invalidation table does
 * not have. Check the table first (`INVALIDATION` in `@vanr/client/react`): most events already
 * refetch what they change.
 */
export function useInvalidateOn(type: BrowserEventName, prefix: KeyPrefix): void {
  const queryClient = useQueryClient();
  const client = useVanrClient();
  const key = JSON.stringify(prefixKey(client, prefix));
  useRealtimeEvent(type, () => {
    const queryKey: unknown = JSON.parse(key);
    if (Array.isArray(queryKey)) void queryClient.invalidateQueries({ queryKey });
  });
}
