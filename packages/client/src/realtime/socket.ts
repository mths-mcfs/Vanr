// The browser's realtime connection (/api/v1/realtime?workspaceId=). It reconnects on its own with a
// growing wait and a ceiling, subscribes again to every channel (and live view) it had after each
// reconnect, and hands each event over already validated against its payload schema. Two close codes end
// it for good: 4401 (the session ended) and 4003 (the person left the workspace).
//
// Events only signal: after a reconnect the app refetches over HTTP (`onReconnect`), since anything that
// happened while the socket was down was not delivered.
import { type Clock, systemClock } from "../clock.ts";
import * as s from "../schema.ts";
import { BROWSER_EVENTS, type BrowserEventName, type EventPayload, isBrowserEvent } from "./events.ts";

/** The part of a WebSocket the client uses (tests pass a fake one). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export const SOCKET_OPEN = 1;

/** The session ended (signed out, expired or revoked): reconnecting can't help. */
export const CLOSE_SESSION_ENDED = 4401;
/** Removed from the workspace. */
export const CLOSE_REMOVED = 4003;

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 30_000;
export const PING_EVERY_MS = 25_000;
/** With no frame at all for this long the connection is taken as dead and replaced. */
export const SILENCE_LIMIT_MS = 60_000;
/**
 * A connection counts as healthy once it has stayed open this long; only then does the wait go back to the
 * base. One that drops sooner (accepted, then cut right away) counts as a failed attempt.
 */
export const STABLE_AFTER_MS = 30_000;

export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "removed" | "signed_out" | "stopped";

/** Where an event came from: a channel the client subscribed to, the person, or the whole workspace. */
export type EventScope = { kind: "channel"; channelId: string } | { kind: "user" } | { kind: "workspace" };

export interface RealtimeEvent<E extends BrowserEventName = BrowserEventName> {
  type: E;
  payload: EventPayload<E>;
  scope: EventScope;
}

export type AnyRealtimeEvent = { [E in BrowserEventName]: RealtimeEvent<E> }[BrowserEventName];

export interface RealtimeOptions {
  /** Origin of the server; empty means the page's own (`ws(s)://` + host). */
  baseUrl?: string;
  workspaceId: string;
  createSocket?: (url: string) => SocketLike;
  clock?: Clock;
  /** 0..1, for the jitter on each wait (tests pass a fixed one). */
  random?: () => number;
  /** The socket came back after a drop: refetch what may have changed meanwhile. */
  onReconnect?: () => void;
  /** The connection ended for good (4401 or 4003). */
  onEnded?: (status: "removed" | "signed_out") => void;
  /** A frame that failed validation or named an event this client doesn't know. Dropped after this. */
  onIgnoredFrame?: (info: { reason: string; frame: unknown }) => void;
  /** The server stopped sending a channel (access to it was lost). */
  onUnsubscribed?: (channelId: string) => void;
}

/** Wait before reconnect attempt `attempt` (0-based): doubling from the base up to the cap, with jitter. */
export function reconnectDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
  // Between half and all of the ceiling, so many tabs that dropped together don't come back together.
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

const ServerFrame = s.union(
  s.object({ type: s.literal("ready"), workspaceId: s.string, userId: s.string }),
  s.object({ type: s.literal("pong") }),
  s.object({ type: s.literal("subscribed", "unsubscribed"), channelId: s.string }),
  s.object({ type: s.literal("error"), code: s.string, channelId: s.optional(s.string) }),
  s.object(
    { type: s.literal("live_view.status", "live_view.frame", "live_view.ended", "live_view.unavailable") },
    s.unknown,
  ),
  s.object({
    type: s.literal("event"),
    channelId: s.optional(s.string),
    scope: s.optional(s.literal("user", "workspace")),
    event: s.object({ type: s.string }, s.unknown),
  }),
);

type Listener = (event: AnyRealtimeEvent) => void;

/** A real WebSocket behind the SocketLike shape. */
function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const adapter: SocketLike = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = (ev) => adapter.onopen?.(ev);
  ws.onmessage = (ev) => adapter.onmessage?.({ data: ev.data });
  ws.onclose = (ev) => adapter.onclose?.({ code: ev.code, reason: ev.reason });
  ws.onerror = (ev) => adapter.onerror?.(ev);
  return adapter;
}

export function realtimeUrl(baseUrl: string, workspaceId: string): string {
  const origin = baseUrl || (typeof location === "undefined" ? "" : location.origin);
  const ws = origin.replace(/^http/, "ws");
  return `${ws}/api/v1/realtime?workspaceId=${encodeURIComponent(workspaceId)}`;
}

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private everOpened = false;
  private cancelRetry: (() => void) | null = null;
  private cancelPing: (() => void) | null = null;
  private cancelStable: (() => void) | null = null;
  private lastFrameAt = 0;
  private readonly channels = new Set<string>();
  private readonly pendingUnsubscribes = new Map<string, number>();
  private readonly liveViews = new Set<string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly anyListeners = new Set<Listener>();
  private readonly statusListeners = new Set<(s: RealtimeStatus) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly url: string;
  status: RealtimeStatus = "stopped";

  constructor(private readonly options: RealtimeOptions) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.createSocket = options.createSocket ?? browserSocket;
    this.url = realtimeUrl(options.baseUrl ?? "", options.workspaceId);
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  start(): void {
    if (this.status !== "stopped") return;
    this.connect("connecting");
  }

  /** Closes the connection and stops reconnecting (the app unmounted or switched workspace). */
  stop(): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "client stopped");
    }
    this.setStatus("stopped");
  }

  /** Receives the channel's events from now on, across reconnects. */
  subscribe(channelId: string): void {
    this.channels.add(channelId);
    this.send({ type: "subscribe", channelId });
  }

  unsubscribe(channelId: string): void {
    this.channels.delete(channelId);
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.pendingUnsubscribes.set(channelId, (this.pendingUnsubscribes.get(channelId) ?? 0) + 1);
    }
    this.send({ type: "unsubscribe", channelId });
  }

  /** Tells the channel the person is typing (the server throttles it). */
  typing(channelId: string): void {
    this.send({ type: "typing", channelId });
  }

  watchLiveView(agentId: string): void {
    this.liveViews.add(agentId);
    this.send({ type: "live_view.subscribe", agentId });
  }

  unwatchLiveView(agentId: string): void {
    this.liveViews.delete(agentId);
    this.send({ type: "live_view.unsubscribe", agentId });
  }

  sendLiveViewInput(agentId: string, events: Record<string, unknown>[]): void {
    this.send({ type: "live_view.input", agentId, events });
  }

  on<E extends BrowserEventName>(type: E, listener: (event: RealtimeEvent<E>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // The map holds listeners for any event; this one is only ever called with events of type E.
    const l = listener as Listener;
    set.add(l);
    return () => set.delete(l);
  }

  onAny(listener: Listener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  onStatus(listener: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Called after each reconnect (not the first connection): what changed meanwhile wasn't delivered. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  private setStatus(status: RealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }

  private send(frame: Record<string, unknown>) {
    if (this.socket?.readyState === SOCKET_OPEN) this.socket.send(JSON.stringify(frame));
  }

  private clearTimers() {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.cancelPing?.();
    this.cancelPing = null;
    this.cancelStable?.();
    this.cancelStable = null;
  }

  private connect(status: "connecting" | "reconnecting") {
    this.clearTimers();
    this.pendingUnsubscribes.clear();
    this.setStatus(status);
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.clock.now();
      // Subscriptions don't survive a reconnect on the server: ask for all of them again.
      for (const channelId of this.channels) this.send({ type: "subscribe", channelId });
      for (const agentId of this.liveViews) this.send({ type: "live_view.subscribe", agentId });
      this.schedulePing();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = this.clock.now();
      this.receive(ev.data);
    };
    socket.onerror = () => {};
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (ev.code === CLOSE_SESSION_ENDED || ev.code === CLOSE_REMOVED) {
        const ended = ev.code === CLOSE_SESSION_ENDED ? "signed_out" : "removed";
        this.setStatus(ended);
        this.options.onEnded?.(ended);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    const delay = reconnectDelay(this.attempt, this.random);
    this.attempt++;
    this.setStatus("reconnecting");
    this.cancelRetry = this.clock.setTimer(() => {
      this.cancelRetry = null;
      this.connect("reconnecting");
    }, delay);
  }

  private schedulePing() {
    this.cancelPing = this.clock.setTimer(() => {
      this.cancelPing = null;
      const socket = this.socket;
      if (!socket) return;
      if (this.clock.now() - this.lastFrameAt >= SILENCE_LIMIT_MS) {
        // Half-open connection: nothing arrives and no close event will. Replace it.
        this.socket = null;
        socket.onclose = null;
        socket.close(4000, "silent");
        this.scheduleReconnect();
        return;
      }
      this.send({ type: "ping" });
      this.schedulePing();
    }, PING_EVERY_MS);
  }

  private ignore(reason: string, frame: unknown) {
    this.options.onIgnoredFrame?.({ reason, frame });
  }

  private receive(data: unknown) {
    if (typeof data !== "string") return this.ignore("not a text frame", data);
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return this.ignore("not JSON", data);
    }
    const parsed = ServerFrame.check(raw, "$");
    if (!parsed.ok)
      return this.ignore(`unexpected frame: ${parsed.issue.expected} at ${parsed.issue.path}`, raw);
    const frame = parsed.value;
    switch (frame.type) {
      case "ready": {
        const reconnected = this.everOpened;
        this.everOpened = true;
        this.cancelStable?.();
        this.cancelStable = this.clock.setTimer(() => {
          this.cancelStable = null;
          this.attempt = 0;
        }, STABLE_AFTER_MS);
        this.setStatus("open");
        if (reconnected) {
          this.options.onReconnect?.();
          for (const l of this.reconnectListeners) l();
        }
        return;
      }
      case "unsubscribed": {
        const pending = this.pendingUnsubscribes.get(frame.channelId) ?? 0;
        if (pending > 0) {
          if (pending === 1) this.pendingUnsubscribes.delete(frame.channelId);
          else this.pendingUnsubscribes.set(frame.channelId, pending - 1);
          return;
        }
        if (this.channels.delete(frame.channelId)) this.options.onUnsubscribed?.(frame.channelId);
        return;
      }
      case "error":
        if (frame.code === "forbidden" && frame.channelId && this.channels.delete(frame.channelId)) {
          this.options.onUnsubscribed?.(frame.channelId);
        }
        return;
      case "pong":
      case "subscribed":
        return;
      case "event":
        return this.deliver(frame, raw);
      case "live_view.status":
      case "live_view.frame":
      case "live_view.ended":
      case "live_view.unavailable":
        return this.deliver({ event: frame }, raw);
    }
  }

  private deliver(
    frame: {
      channelId?: string;
      scope?: "user" | "workspace";
      event: { type: string } & Record<string, unknown>;
    },
    raw: unknown,
  ) {
    const { type, ...rest } = frame.event;
    if (!isBrowserEvent(type)) return this.ignore(`unknown event ${type}`, raw);
    const payload = BROWSER_EVENTS[type].check(rest, "$.event");
    if (!payload.ok) return this.ignore(`${type}: ${payload.issue.expected} at ${payload.issue.path}`, raw);
    const scope: EventScope = frame.channelId
      ? { kind: "channel", channelId: frame.channelId }
      : { kind: frame.scope ?? "workspace" };
    // `payload` was checked by the schema of `type`, which is what pairs them.
    const event = { type, payload: payload.value, scope } as AnyRealtimeEvent;
    for (const l of this.listeners.get(type) ?? []) l(event);
    for (const l of this.anyListeners) l(event);
  }
}

export const createRealtime = (options: RealtimeOptions) => new RealtimeClient(options);
