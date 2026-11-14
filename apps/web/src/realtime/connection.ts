// The one real-time connection of the open workspace. Areas listen to events by name and follow
// channels through it; none of them opens a socket. An event is only a signal: after a reconnect
// the app refetches over HTTP.
import { z } from "zod";
import type { Clock } from "../platform/clock.tsx";

/** Milliseconds before each reconnect attempt; the last one repeats. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000] as const;
/** How often an open connection pings the server. */
export const PING_INTERVAL_MS = 30_000;
/** The close code the server uses when the session or the membership behind the socket ended. */
export const ACCESS_ENDED_CODE = 4401;

export type SocketHandlers = {
  open: () => void;
  message: (data: unknown) => void;
  close: (code: number) => void;
};
export type SocketHandle = { send: (text: string) => void; close: () => void };
/** Opens the socket of a workspace. The browser's WebSocket in the app, a fake in tests. */
export type SocketOpener = (workspaceId: string, handlers: SocketHandlers) => SocketHandle;

/**
 * connecting: the first attempt. open: live. lost: it dropped or never opened, and a retry is
 * scheduled or running. ended: closed for good (the page left, or access ended).
 */
export type RealtimeStatus = "connecting" | "open" | "lost" | "ended";

export type RealtimeEvent = {
  /** The event name, e.g. `message.posted`. */
  type: string;
  scope: "channel" | "user" | "workspace";
  channelId: string | undefined;
  /** The event's fields, as sent. A handler validates what it reads. */
  data: Readonly<Record<string, unknown>>;
};

const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("pong") }),
  z.object({
    type: z.literal("event"),
    scope: z.enum(["user", "workspace"]).optional(),
    channelId: z.string().optional(),
    event: z.looseObject({ type: z.string().min(1) }),
  }),
  z.object({ type: z.literal("subscribed"), channelId: z.string() }),
  z.object({ type: z.literal("unsubscribed"), channelId: z.string() }),
  z.object({ type: z.literal("error"), code: z.string() }),
]);

/** A frame from the server, or undefined when it is not one the web understands. */
export function parseServerFrame(data: unknown): z.infer<typeof ServerFrame> | undefined {
  if (typeof data !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  const frame = ServerFrame.safeParse(raw);
  return frame.success ? frame.data : undefined;
}

export type RealtimeConnection = {
  status: () => RealtimeStatus;
  /** Calls `listener` whenever the status changes. Returns the unsubscribe function. */
  onStatus: (listener: () => void) => () => void;
  /** Calls `handler` for every event with this name. Returns the unsubscribe function. */
  on: (type: string, handler: (event: RealtimeEvent) => void) => () => void;
  /** Follows a channel's events until the returned function is called. Shared follows are counted. */
  followChannel: (channelId: string) => () => void;
  /** Sends an area's own frame (typing, live view). Dropped while the connection is not open. */
  send: (frame: { type: string } & Record<string, unknown>) => void;
  /** Skips the wait before the next reconnect attempt. */
  retryNow: () => void;
  close: () => void;
};

export function openRealtime(deps: {
  workspaceId: string;
  open: SocketOpener;
  clock: Clock;
  /** The connection is back after a drop: what was missed has to be fetched again. */
  onReconnected: () => void;
  /** The server closed the socket because the session or the membership ended. */
  onAccessEnded: () => void;
}): RealtimeConnection {
  let status: RealtimeStatus = "connecting";
  let socket: SocketHandle | undefined;
  let attempt = 0;
  let everOpened = false;
  let cancelRetry: (() => void) | undefined;
  let cancelPing: (() => void) | undefined;
  const statusListeners = new Set<() => void>();
  const handlers = new Map<string, Set<(event: RealtimeEvent) => void>>();
  const follows = new Map<string, number>();

  const setStatus = (next: RealtimeStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of [...statusListeners]) listener();
  };

  const write = (frame: Record<string, unknown>) => {
    if (status === "open") socket?.send(JSON.stringify(frame));
  };

  const armPing = () => {
    cancelPing = deps.clock.after(PING_INTERVAL_MS, () => {
      write({ type: "ping" });
      armPing();
    });
  };

  const dispatch = (data: unknown) => {
    const frame = parseServerFrame(data);
    if (frame?.type !== "event") return;
    const { type, ...fields } = frame.event;
    const event: RealtimeEvent = {
      type,
      scope: frame.scope ?? "channel",
      channelId: frame.channelId,
      data: fields,
    };
    for (const handler of [...(handlers.get(type) ?? [])]) handler(event);
  };

  const connect = () => {
    cancelRetry = undefined;
    // Each socket's callbacks only count while it is the current one.
    let mine: SocketHandle | undefined;
    const current = () => mine !== undefined && socket === mine;
    mine = deps.open(deps.workspaceId, {
      open() {
        if (!current()) return;
        attempt = 0;
        setStatus("open");
        for (const channelId of follows.keys()) write({ type: "subscribe", channelId });
        armPing();
        if (everOpened) deps.onReconnected();
        everOpened = true;
      },
      message(data) {
        if (current()) dispatch(data);
      },
      close(code) {
        if (!current()) return;
        socket = undefined;
        cancelPing?.();
        if (code === ACCESS_ENDED_CODE) {
          setStatus("ended");
          deps.onAccessEnded();
          return;
        }
        setStatus("lost");
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 0;
        attempt += 1;
        cancelRetry = deps.clock.after(delay, connect);
      },
    });
    socket = mine;
  };

  connect();

  return {
    status: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(type);
      };
    },
    followChannel(channelId) {
      const count = follows.get(channelId) ?? 0;
      follows.set(channelId, count + 1);
      if (count === 0) write({ type: "subscribe", channelId });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (follows.get(channelId) ?? 1) - 1;
        if (left > 0) follows.set(channelId, left);
        else {
          follows.delete(channelId);
          write({ type: "unsubscribe", channelId });
        }
      };
    },
    send: write,
    retryNow() {
      if (status !== "lost" || cancelRetry === undefined) return;
      cancelRetry();
      connect();
    },
    close() {
      cancelRetry?.();
      cancelPing?.();
      const open = socket;
      socket = undefined;
      setStatus("ended");
      open?.close();
    },
  };
}

/** The browser's WebSocket behind the opener interface. */
export function browserSocketOpener(origin: string): SocketOpener {
  return (workspaceId, handlers) => {
    const url = new URL("/api/v1/realtime", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("workspaceId", workspaceId);
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => handlers.open());
    socket.addEventListener("message", (event: MessageEvent<unknown>) => handlers.message(event.data));
    socket.addEventListener("close", (event) => handlers.close(event.code));
    return { send: (text) => socket.send(text), close: () => socket.close() };
  };
}
