// What a conversation keeps while it is open: its history (the first page, older pages asked for,
// and posts on their way), its live runs, who is typing, and marking it read.
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeEvent } from "@vanr/client";
import {
  prefixKey,
  queryKey,
  useApiMutation,
  useApiQuery,
  useRealtime,
  useRealtimeEvent,
  useVanrClient,
} from "@vanr/client/react";
import type { Message } from "@vanr/contract";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useClock } from "../../platform/clock.tsx";
import { applyRunEvent, type LiveRun, type RunEvent, type RunEventBase, reconcile } from "./live.ts";

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

/**
 * The conversation's messages, oldest first: older pages asked for, then the latest page, then the
 * posts of this tab still on their way or failed. A post is sent with an id the browser chose, so a
 * retry is stored once and its echo replaces the local copy.
 */
export function useHistory(workspaceId: string, channelId: string, authorId: string) {
  const client = useVanrClient();
  const queryClient = useQueryClient();
  const args = { workspaceId, channelId, query: { limit: PAGE } };
  const latest = useApiQuery("listChannelMessages", args);
  const [older, setOlder] = useState<{ messages: Message[]; more: boolean }>({ messages: [], more: true });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [local, setLocal] = useState<Message[]>([]);

  const server = latest.data ?? [];
  const messages = useMemo(() => {
    const seen = new Set<string>();
    const out: Message[] = [];
    for (const message of [...older.messages, ...server]) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      out.push(message);
    }
    const echoed = new Set(out.flatMap((message) => (message.clientId === null ? [] : [message.clientId])));
    return [...out, ...local.filter((message) => message.clientId === null || !echoed.has(message.clientId))];
  }, [older.messages, server, local]);

  const firstFull = server.length >= PAGE;
  const canLoadOlder = firstFull && older.more;

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
      setOlder((current) => ({ messages: [...page, ...current.messages], more: page.length >= PAGE }));
    } catch (error) {
      setOlderError(error);
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
      // The echo goes in the latest page at once, so the local copy and the server's never show together.
      queryClient.setQueryData<Message[]>(queryKey(client, "listChannelMessages", args), (current) =>
        current === undefined || current.some((m) => m.id === posted.id) ? current : [...current, posted],
      );
      setLocal((current) => current.filter((m) => m.clientId !== clientId));
      // Posting in a public channel joins it, and every post changes what is unread.
      void queryClient.invalidateQueries({
        queryKey: prefixKey(client, { method: "listChannels", args: { workspaceId } }),
      });
    } catch {
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

  return {
    latest,
    messages,
    send,
    retry,
    canLoadOlder,
    loadOlder,
    loadingOlder,
    olderError,
  };
}

type RunEventName =
  | "run.status_changed"
  | "run.text_delta"
  | "run.commentary"
  | "run.tool_call"
  | "run.tool_result"
  | "run.completed"
  | "run.stopped"
  | "run.idle";

const LIST_SLACK_MS = 5000;
type RunAction =
  | { kind: "event"; base: RunEventBase; event: RunEvent; now: number }
  | { kind: "list"; active: Parameters<typeof reconcile>[1]; readAt: number };

function runsReducer(runs: readonly LiveRun[], action: RunAction): readonly LiveRun[] {
  return action.kind === "event"
    ? applyRunEvent(runs, action.base, action.event, action.now)
    : reconcile(runs, action.active, action.readAt);
}

/** Listens to one run event in this channel and hands it to the reducer. */
function useRunEvent(name: RunEventName, channelId: string, dispatch: (action: RunAction) => void) {
  const clock = useClock();
  useRealtimeEvent(name, (event: RealtimeEvent<RunEventName>) => {
    const payload = event.payload;
    const inChannel =
      payload.channelId === channelId ||
      (event.scope.kind === "channel" && event.scope.channelId === channelId);
    if (!inChannel) return;
    dispatch({
      kind: "event",
      base: {
        agentId: payload.agentId,
        ...(payload.runId !== undefined && { runId: payload.runId }),
        ...(payload.threadId !== undefined && { threadId: payload.threadId }),
      },
      event: { ...payload, type: name } as RunEvent,
      now: clock.now(),
    });
  });
}

/** The live runs of a conversation: the server's list, kept current by the run events. */
export function useLiveRuns(workspaceId: string, channelId: string) {
  const active = useApiQuery("listChannelActiveRuns", { workspaceId, channelId });
  const [runs, dispatch] = useReducer(runsReducer, []);
  useRunEvent("run.status_changed", channelId, dispatch);
  useRunEvent("run.text_delta", channelId, dispatch);
  useRunEvent("run.commentary", channelId, dispatch);
  useRunEvent("run.tool_call", channelId, dispatch);
  useRunEvent("run.tool_result", channelId, dispatch);
  useRunEvent("run.completed", channelId, dispatch);
  useRunEvent("run.stopped", channelId, dispatch);
  useRunEvent("run.idle", channelId, dispatch);
  const clock = useClock();
  const { data } = active;
  useEffect(() => {
    // The list was read a moment ago: a run heard from in the last seconds may have started after it.
    if (data != null) dispatch({ kind: "list", active: data, readAt: clock.now() - LIST_SLACK_MS });
  }, [data, clock]);
  return { runs, active };
}

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
  const marked = useRef<string | undefined>(undefined);
  const { mutate } = mark;
  const markNow = useCallback(() => {
    if (!member || lastId === undefined || marked.current === lastId) return;
    if (document.visibilityState !== "visible") return;
    marked.current = lastId;
    mutate({ workspaceId, channelId });
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
