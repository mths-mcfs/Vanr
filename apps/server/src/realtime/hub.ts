// Event fan-out to the connected browsers. The database is the source of truth:
// the event only signals, and the client fetches again over HTTP after reconnecting.
import type { ServerWebSocket } from "bun";
import { log } from "../logger";
import { recordEmitted } from "./coverage";

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface BrowserSocketData {
  kind: "browser";
  workspaceId: string;
  userId: string;
  /** The Better Auth session that opened the socket: when it ends, the socket closes. */
  sessionId: string;
  channels: Set<string>;
  lastTypingAt: Map<string, number>;
}

export type BrowserSocket = ServerWebSocket<BrowserSocketData>;

/** Who publishes events. Routes and services depend only on this; tests can record what went out. */
interface Publisher {
  toChannel(channelId: string, event: RealtimeEvent, opts?: { exceptUserId?: string }): void;
  toUser(workspaceId: string, userId: string, event: RealtimeEvent): void;
  toWorkspace(workspaceId: string, event: RealtimeEvent): void;
}

export class Hub implements Publisher {
  private readonly byChannel = new Map<string, Set<BrowserSocket>>();
  private readonly byUser = new Map<string, Set<BrowserSocket>>();
  private readonly byWorkspace = new Map<string, Set<BrowserSocket>>();
  private readonly listeners = new Set<(target: string, event: RealtimeEvent) => void>();

  /** For tests: receives everything that was published. */
  onPublish(listener: (target: string, event: RealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(ws: BrowserSocket): void {
    const { workspaceId, userId } = ws.data;
    add(this.byUser, `${workspaceId}:${userId}`, ws);
    add(this.byWorkspace, workspaceId, ws);
  }

  remove(ws: BrowserSocket): void {
    const { workspaceId, userId } = ws.data;
    remove(this.byUser, `${workspaceId}:${userId}`, ws);
    remove(this.byWorkspace, workspaceId, ws);
    for (const channelId of ws.data.channels) remove(this.byChannel, channelId, ws);
    ws.data.channels.clear();
  }

  subscribe(ws: BrowserSocket, channelId: string): void {
    ws.data.channels.add(channelId);
    add(this.byChannel, channelId, ws);
  }

  unsubscribe(ws: BrowserSocket, channelId: string): void {
    ws.data.channels.delete(channelId);
    remove(this.byChannel, channelId, ws);
  }

  isOnline(workspaceId: string, userId: string): boolean {
    return (this.byUser.get(`${workspaceId}:${userId}`)?.size ?? 0) > 0;
  }

  /** Every browser socket now (the revalidation sweep walks them). */
  sockets(): BrowserSocket[] {
    return [...this.byWorkspace.values()].flatMap((set) => [...set]);
  }

  /** The session ended (sign-out, revoked): its sockets close at once. */
  dropSession(sessionId: string): void {
    for (const ws of this.sockets()) if (ws.data.sessionId === sessionId) this.cut(ws, 4401, "session ended");
  }

  /**
   * Removes a channel from someone who lost access (left the private channel), or every socket of a person who
   * left the workspace. Whoever removes a member or changes a role (routes/workspaces) calls it in the same path.
   * Each socket that followed a channel it loses is told (`unsubscribed`), so the browser drops what it cached.
   */
  dropUser(workspaceId: string, userId: string, channelId?: string): void {
    for (const ws of [...(this.byUser.get(`${workspaceId}:${userId}`) ?? [])]) {
      for (const lost of channelId ? [channelId] : [...ws.data.channels]) {
        if (!ws.data.channels.has(lost)) continue;
        this.unsubscribe(ws, lost);
        send(ws, JSON.stringify({ type: "unsubscribed", channelId: lost }));
      }
      if (!channelId) this.cut(ws, 4003, "removed");
    }
  }

  /** Takes the socket out of every audience before closing it: nothing more goes to it from here. */
  cut(ws: BrowserSocket, code: number, reason: string): void {
    this.remove(ws);
    ws.close(code, reason);
  }

  toChannel(channelId: string, event: RealtimeEvent, opts: { exceptUserId?: string } = {}): void {
    this.emit(`channel:${channelId}`, event);
    const frame = JSON.stringify({ type: "event", channelId, event });
    for (const ws of this.byChannel.get(channelId) ?? []) {
      if (opts.exceptUserId && ws.data.userId === opts.exceptUserId) continue;
      send(ws, frame);
    }
  }

  toUser(workspaceId: string, userId: string, event: RealtimeEvent): void {
    this.emit(`user:${workspaceId}:${userId}`, event);
    const frame = JSON.stringify({ type: "event", scope: "user", event });
    for (const ws of this.byUser.get(`${workspaceId}:${userId}`) ?? []) send(ws, frame);
  }

  toWorkspace(workspaceId: string, event: RealtimeEvent): void {
    this.emit(`workspace:${workspaceId}`, event);
    const frame = JSON.stringify({ type: "event", scope: "workspace", event });
    for (const ws of this.byWorkspace.get(workspaceId) ?? []) send(ws, frame);
  }

  private emit(target: string, event: RealtimeEvent) {
    recordEmitted(event.type);
    for (const l of this.listeners) l(target, event);
  }
}

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function remove<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function send(ws: BrowserSocket, frame: string) {
  try {
    ws.send(frame);
  } catch (err) {
    log.warn("ws.send_failed", { err });
  }
}
