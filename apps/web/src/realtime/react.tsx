// Real time for a workspace. The frame mounts <WorkspaceRealtime>, which owns the one connection
// (the client's RealtimeClient) and hands it to the client's own provider: every event refetches
// what the client's invalidation table says it made stale, and a reconnect refetches everything.
//
// Areas listen with `useRealtimeEvent` from `@vanr/client/react`. What this file adds is what the
// client leaves to the app: the connection's status, a reconnect on request, counted channel
// subscriptions, and refetching a call the invalidation table does not tie to an event.

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  type BrowserEventName,
  createRealtime,
  type RealtimeClient,
  type RealtimeStatus,
  type VanrClient,
} from "@vanr/client";
import {
  KEY_ROOT,
  type KeyPrefix,
  prefixKey,
  useRealtime,
  useRealtimeEvent,
  useVanrClient,
  VanrProvider,
} from "@vanr/client/react";
import type { ThreadInfo } from "@vanr/contract";
import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRuntime } from "../app/context.tsx";

/** Opens the workspace's connection while mounted and stops it on the way out. */
export function WorkspaceRealtime({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const { openSocket, clock, gate, session } = useRuntime();
  const realtime = useMemo(() => {
    const created: RealtimeClient = createRealtime({
      workspaceId,
      baseUrl: openSocket.baseUrl,
      clock,
      // The server stopped this browser's subscription to a channel: the person may have lost it.
      // Its list and its history are read again; a channel they can no longer read answers 404 there.
      onUnsubscribed: (channelId) => {
        // Nothing follows the channel anymore: a later follow subscribes again from scratch.
        followers.get(created)?.delete(channelId);
        for (const listener of lostListeners.get(created) ?? []) listener(channelId);
        // What was cached about it goes, open or not; an open conversation reads again and is told.
        forgetChannelQueries(queryClient, client, workspaceId, channelId);
        // The workspace's thread lists start over; the channel's list and direct messages read again.
        void queryClient.resetQueries({
          queryKey: prefixKey(client, { method: "listThreads", args: { workspaceId } }),
        });
        for (const method of ["listChannels", "getDms"] as const)
          void queryClient.invalidateQueries({
            queryKey: prefixKey(client, { method, args: { workspaceId } }),
          });
      },
      ...(openSocket.createSocket !== undefined && { createSocket: openSocket.createSocket }),
      ...(openSocket.random !== undefined && { random: openSocket.random }),
      onEnded: (why) => {
        // The session is over: the same road as a 401. Removed from the workspace: ask again who
        // the person is, and the frame shows they are no longer a member.
        if (why === "signed_out") gate.ended();
        else void session.load(true);
      },
    });
    return created;
  }, [workspaceId, openSocket, clock, gate, session, queryClient, client]);
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
// Who wants to hear when the server stops a channel's subscription, per connection.
const lostListeners = new WeakMap<RealtimeClient, Set<(channelId: string) => void>>();

/** The per-channel queries that hold what a channel says, dropped when the person loses it. */
const CHANNEL_QUERIES = [
  "listChannelMessages",
  "listChannelThreads",
  "getChannelDirectory",
  "listChannelActiveRuns",
  "listChannelMembers",
  "listChannelPinnedMessages",
] as const;

/**
 * Drops what the cache holds about a channel: the queries made for it, and any answer that says it
 * belongs to it (a thread, say). Shared by the connection and by a screen that finds the channel lost.
 */
export function forgetChannelQueries(
  queryClient: QueryClient,
  client: VanrClient,
  workspaceId: string,
  channelId: string,
): void {
  for (const method of CHANNEL_QUERIES)
    queryClient.removeQueries({ queryKey: prefixKey(client, { method, args: { workspaceId, channelId } }) });
  // Its threads (one moved out of it too) are keyed by thread: they go by what they say they belong to,
  // with their assignments.
  const lostThreads = queryClient
    .getQueriesData<ThreadInfo>({
      queryKey: prefixKey(client, { method: "getThread", args: { workspaceId } }),
    })
    .flatMap(([, thread]) =>
      thread !== undefined && (thread.channelId === channelId || thread.context.channelId === channelId)
        ? [thread.id]
        : [],
    );
  for (const threadId of lostThreads)
    for (const method of ["getThread", "getThreadAssignment"] as const)
      queryClient.removeQueries({ queryKey: prefixKey(client, { method, args: { workspaceId, threadId } }) });
  // The channel list keeps the others; the lost one leaves it at once, before any refetch.
  queryClient.setQueriesData<unknown>(
    { queryKey: prefixKey(client, { method: "listChannels", args: { workspaceId } }) },
    (data: unknown) =>
      Array.isArray(data)
        ? data.filter(
            (channel: unknown) =>
              !(
                typeof channel === "object" &&
                channel !== null &&
                "id" in channel &&
                channel.id === channelId
              ),
          )
        : data,
  );
  // A list of threads keeps its other rows; the lost channel's leave it at once, before any refetch.
  queryClient.setQueriesData<unknown>(
    { queryKey: prefixKey(client, { method: "listThreads", args: { workspaceId } }) },
    (data: unknown) => withoutChannel(data, channelId),
  );
  queryClient.removeQueries({
    queryKey: [KEY_ROOT],
    predicate: (query) => {
      const data: unknown = query.state.data;
      return typeof data === "object" && data !== null && "channelId" in data && data.channelId === channelId;
    },
  });
}

/** A page of threads, or pages of them, without the threads of one channel. */
function withoutChannel(data: unknown, channelId: string): unknown {
  const keep = (page: unknown): unknown => {
    if (typeof page !== "object" || page === null || !("threads" in page) || !Array.isArray(page.threads))
      return page;
    return {
      ...page,
      threads: page.threads.filter(
        (thread: unknown) =>
          !(
            typeof thread === "object" &&
            thread !== null &&
            "channelId" in thread &&
            thread.channelId === channelId
          ),
      ),
    };
  };
  if (typeof data === "object" && data !== null && "pages" in data && Array.isArray(data.pages))
    return { ...data, pages: data.pages.map(keep) };
  return keep(data);
}

/** Calls `listener` with each channel whose subscription the server ends on this connection. */
export function onChannelLost(realtime: RealtimeClient, listener: (channelId: string) => void): () => void {
  const set = lostListeners.get(realtime) ?? new Set();
  lostListeners.set(realtime, set);
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * Follows a channel's events until the returned function is called. Every follower of a channel
 * shares one subscription, so one leaving never ends another's.
 */
export function followChannel(realtime: RealtimeClient, channelId: string): () => void {
  const counts = followers.get(realtime) ?? new Map<string, number>();
  followers.set(realtime, counts);
  const before = counts.get(channelId) ?? 0;
  counts.set(channelId, before + 1);
  if (before === 0) realtime.subscribe(channelId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // The server already ended it: nothing is left to let go of.
    const current = counts.get(channelId);
    if (current === undefined) return;
    const left = current - 1;
    if (left > 0) counts.set(channelId, left);
    else {
      counts.delete(channelId);
      realtime.unsubscribe(channelId);
    }
  };
}

/** Follows a channel's events while mounted. Two components on the same channel share one subscription. */
export function useChannelSubscription(channelId: string | undefined): void {
  const realtime = useRealtime();
  useEffect(() => {
    if (realtime === null || channelId === undefined) return;
    return followChannel(realtime, channelId);
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
