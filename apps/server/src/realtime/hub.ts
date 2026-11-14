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

  /** Removes a channel from someone who lost access (left the private channel or the workspace). */
  dropUser(workspaceId: string, userId: string, channelId?: string): void {
    for (const ws of [...(this.byUser.get(`${workspaceId}:${userId}`) ?? [])]) {
      if (channelId) this.unsubscribe(ws, channelId);
      else ws.close(4003, "removed");
    }
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
