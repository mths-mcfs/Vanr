// JSON-RPC over the DevTools WebSocket of one Chrome: commands with an id and their answer, events to the listeners.
import { z } from "zod";

export function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A message from Chrome: the answer to a command (`id`) or an event (`method`). */
const cdpMessage = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});

export type Listener = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => void;

export class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  closed = false;
  /** Called before each command: it throws to keep the command from going (an aborted action's next step). */
  guard: ((method: string) => void) | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = cdpMessage.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser closed"));
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error("could not connect to the browser"));
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("browser closed"));
    try {
      this.guard?.(method);
    } catch (err) {
      return Promise.reject(err);
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: Listener): void {
    this.listeners.add(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
