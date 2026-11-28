// What a conversation keeps while it is open: its history (every message seen, and posts on their
// way), its live runs, who is typing, marking it read, and forgetting a channel the person lost.
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@vanr/client";
import {
  prefixKey,
  useApiMutation,
  useApiQuery,
  useRealtime,
  useRealtimeEvent,
  useVanrClient,
} from "@vanr/client/react";
import type { Message } from "@vanr/contract";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useClock } from "../../platform/clock.tsx";
import type { LiveRun } from "./live.ts";
import { channelRuns, forgetChannelRuns } from "./runs-store.ts";

/** One page of history, as the server sends it at most. */
export const PAGE = 100;

/** The current time, read again every `ms` while `on`. */
export function useTicker(on: boolean, ms: number): number {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    if (!on) return;
    let cancel = () => {};
    const tick = () => {
      setNow(clock.now());
      cancel = clock.setTimer(tick, ms);
    };
    cancel = clock.setTimer(tick, ms);
    return () => cancel();
  }, [on, ms, clock]);
  return on ? now : clock.now();
}

const newClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export type Outgoing = { body: string; replyTo?: string; replyExcerpt?: Message["meta"]["replyTo"] };

const byTime = (a: Message, b: Message) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1;

/** The answer a channel gives someone who can no longer read it: the same as one that does not exist. */
const isLost = (error: unknown) => isApiError(error) && (error.status === 404 || error.status === 403);

/**
 * The conversation's messages, oldest first. Every message seen is kept in one place, in its newest
 * version: the latest page each time it is read, the older pages asked for, and what the events say
 * about any of them. The posts of this tab still on their way, or failed, come last. A post is sent
 * with an id the browser chose, so a retry is stored once and its echo replaces the local copy.
 *
 * When the channel answers 404 or 403 the person lost it: what was shown is dropped and `lost` says
 * so; `useForgetChannel` then clears the cache once the conversation is off screen.
 */
export function useHistory(workspaceId: string, channelId: string, authorId: string) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const args = { workspaceId, channelId, query: { limit: PAGE } };
  const latest = useApiQuery("listChannelMessages", args);
  const [known, setKnown] = useState<ReadonlyMap<string, Message>>(() => new Map());
  const [more, setMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [local, setLocal] = useState<Message[]>([]);
  const [lost, setLost] = useState(false);

  const upsert = useCallback((list: readonly Message[]) => {
    if (list.length === 0) return;
    setKnown((current) => {
      const next = new Map(current);
      for (const message of list) next.set(message.id, message);
      return next;
    });
  }, []);
  const patch = useCallback((messageId: string, change: (message: Message) => Message) => {
    setKnown((current) => {
      const message = current.get(messageId);
      return message === undefined ? current : new Map(current).set(messageId, change(message));
    });
  }, []);

  useEffect(() => {
    if (latest.data !== undefined) upsert(latest.data);
  }, [latest.data, upsert]);
  // The events refetch only the latest page: these keep the older ones current too.
  useRealtimeEvent("message.posted", (event) => {
    const { message } = event.payload;
    if (message.channelId === channelId && message.threadId === null) upsert([message]);
  });
  useRealtimeEvent("message.reactions_updated", (event) =>
    patch(event.payload.messageId, (message) => ({ ...message, reactions: event.payload.reactions })),
  );
  useRealtimeEvent("message.actions_updated", (event) =>
    patch(event.payload.messageId, (message) => ({ ...message, actions: event.payload.actions })),
  );
  useRealtimeEvent("message.memories_updated", (event) =>
    patch(event.payload.messageId, (message) => ({ ...message, memories: event.payload.memories })),
  );

  const forget = useCallback(() => {
    setLost(true);
    setKnown(new Map());
    setLocal([]);
  }, []);

  useEffect(() => {
    if (latest.isError && isLost(latest.error)) forget();
  }, [latest.isError, latest.error, forget]);

  const messages = useMemo(() => {
    const out = [...known.values()].sort(byTime);
    const echoed = new Set(out.flatMap((message) => (message.clientId === null ? [] : [message.clientId])));
    return [...out, ...local.filter((message) => message.clientId === null || !echoed.has(message.clientId))];
  }, [known, local]);

  const canLoadOlder = (latest.data?.length ?? 0) >= PAGE && more;

  const loadOlder = async () => {
    const first = messages.find((message) => message.local === undefined);
    if (first === undefined || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await client.api.listChannelMessages({
        workspaceId,
        channelId,
        query: { before: first.id, limit: PAGE },
      });
      upsert(page);
      setMore(page.length >= PAGE);
    } catch (error) {
      if (isLost(error)) forget();
      else setOlderError(error);
    } finally {
      setLoadingOlder(false);
    }
  };

  const deliver = async (message: Message) => {
    const clientId = message.clientId ?? "";
    setLocal((current) => current.map((m) => (m.clientId === clientId ? { ...m, local: "pending" } : m)));
    try {
      const posted = await client.api.createChannelMessage({
        workspaceId,
        channelId,
        body: {
          body: message.body,
          clientId,
          ...(message.meta.replyTo !== undefined && { replyTo: message.meta.replyTo.messageId }),
        },
      });
      // The echo goes in at once, so the local copy and the server's never show together.
      upsert([posted]);
      setLocal((current) => current.filter((m) => m.clientId !== clientId));
      // Posting in a public channel joins it, and every post changes what is unread.
      void queryClient.invalidateQueries({
        queryKey: prefixKey(client, { method: "listChannels", args: { workspaceId } }),
      });
    } catch (error) {
      if (isLost(error)) forget();
      else
        setLocal((current) => current.map((m) => (m.clientId === clientId ? { ...m, local: "failed" } : m)));
    }
  };

  const send = (outgoing: Outgoing) => {
    const clientId = newClientId();
    const message: Message = {
      id: `local-${clientId}`,
      actions: [],
      agentMentionIds: [],
      author: { type: "person", id: authorId },
      body: outgoing.body,
      channelId,
      clientId,
      createdAt: new Date().toISOString(),
      editedAt: null,
      local: "pending",
      memories: [],
      meta: outgoing.replyExcerpt === undefined ? {} : { replyTo: outgoing.replyExcerpt },
      reactions: [],
      receipts: { claimedBy: [], handled: [], viewedBy: [] },
      replyCount: 0,
      runId: null,
      threadId: null,
      usage: null,
    };
    setLocal((current) => [...current, message]);
    void deliver(message);
  };

  const retry = (message: Message) => void deliver(message);

  return { latest, messages, send, retry, canLoadOlder, loadOlder, loadingOlder, olderError, lost };
}

/** The live runs of a conversation: the server's list, kept current by the run events. */
export function useLiveRuns(workspaceId: string, channelId: string) {
  const realtime = useRealtime();
  const clock = useClock();
  const store = useMemo(
    () => (realtime === null ? null : channelRuns(realtime, channelId, clock)),
    [realtime, channelId, clock],
  );
  const runs = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.snapshot ?? noRuns,
    store?.snapshot ?? noRuns,
  );
  // Every answer is a new value, even one equal to the last: an empty list read again after a
  // reconnect still ends the runs heard of in between.
  const active = useApiQuery(
    "listChannelActiveRuns",
    { workspaceId, channelId },
    { structuralSharing: false },
  );
  const { data, fetchStatus } = active;
  // When the list was asked for: a run heard from after that may be missing from it and still be live.
  const askedAt = useRef(clock.now());
  useEffect(() => {
    if (fetchStatus === "fetching") askedAt.current = clock.now();
  }, [fetchStatus, clock]);
  useEffect(() => {
    if (data != null) store?.list(data, askedAt.current);
  }, [data, store]);
  return { runs, active };
}

const NO_RUNS: readonly LiveRun[] = [];
const noRuns = () => NO_RUNS;
const noSubscription = () => () => {};

/**
 * Marks the conversation read up to its last message, while the tab is in front. A tab in the
 * background leaves it unread and marks it when it comes back.
 */
export function useMarkRead(
  workspaceId: string,
  channelId: string,
  member: boolean,
  lastId: string | undefined,
) {
  const mark = useApiMutation("markChannelRead", {
    invalidates: () => [
      { method: "listChannels", args: { workspaceId } },
      { method: "getDms", args: { workspaceId } },
    ],
  });
  // The last message marked, or on its way to be; a failure clears it, so coming back tries again.
  const marked = useRef<string | undefined>(undefined);
  const { mutate } = mark;
  const markNow = useCallback(() => {
    if (!member || lastId === undefined || marked.current === lastId) return;
    if (document.visibilityState !== "visible") return;
    marked.current = lastId;
    mutate(
      { workspaceId, channelId },
      {
        onError: () => {
          if (marked.current === lastId) marked.current = undefined;
        },
      },
    );
  }, [member, lastId, workspaceId, channelId, mutate]);
  useEffect(() => {
    markNow();
    document.addEventListener("visibilitychange", markNow);
    return () => document.removeEventListener("visibilitychange", markNow);
  }, [markNow]);
}

/** The people typing in this channel now, other than `me`; a person leaves the list when they post. */
export function useTypingPeople(channelId: string, me: string): string[] {
  const clock = useClock();
  const [typing, setTyping] = useState<ReadonlyMap<string, number>>(new Map());
  useRealtimeEvent("person.typing", (event) => {
    if (event.scope.kind !== "channel" || event.scope.channelId !== channelId) return;
    if (event.payload.userId === me) return;
    const until = clock.now() + event.payload.ttlMs;
    setTyping((current) => new Map(current).set(event.payload.userId, until));
  });
  useRealtimeEvent("message.posted", (event) => {
    const { author } = event.payload.message;
    if (author.type !== "person") return;
    setTyping((current) => {
      if (!current.has(author.id)) return current;
      const next = new Map(current);
      next.delete(author.id);
      return next;
    });
  });
  const next = Math.min(...typing.values());
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    return clock.setTimer(
      () => {
        const now = clock.now();
        setTyping((current) => new Map([...current].filter(([, until]) => until > now)));
      },
      Math.max(0, next - clock.now()),
    );
  }, [next, clock]);
  return [...typing.keys()];
}

/** Tells the channel the person is typing, at most once every few seconds. */
export function useTypingSignal(channelId: string): () => void {
  const realtime = useRealtime();
  const clock = useClock();
  const last = useRef(Number.NEGATIVE_INFINITY);
  return useCallback(() => {
    const now = clock.now();
    if (realtime === null || now - last.current < 3000) return;
    last.current = now;
    realtime.typing(channelId);
  }, [realtime, clock, channelId]);
}

/**
 * Drops everything cached about a channel the person lost: its history, directory, runs, members and
 * pins, and reads the lists of conversations again. Called once nothing that reads them is on screen,
 * so nothing reads them back in.
 */
export function useForgetChannel(workspaceId: string, channelId: string) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const realtime = useRealtime();
  useEffect(() => {
    for (const method of [
      "listChannelMessages",
      "getChannelDirectory",
      "listChannelActiveRuns",
      "listChannelMembers",
      "listChannelPinnedMessages",
    ] as const)
      queryClient.removeQueries({
        queryKey: prefixKey(client, { method, args: { workspaceId, channelId } }),
      });
    for (const method of ["listChannels", "getDms"] as const)
      void queryClient.invalidateQueries({ queryKey: prefixKey(client, { method, args: { workspaceId } }) });
    if (realtime !== null) forgetChannelRuns(realtime, channelId);
  }, [queryClient, client, workspaceId, channelId, realtime]);
}
