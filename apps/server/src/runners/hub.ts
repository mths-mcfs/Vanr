// The runners' connections and the RPC over them. `call` sends a `request` and waits for the `result`; a
// caller that asked for a stream gets the `output` frames on the way. A runner serves at most MAX_INFLIGHT
// requests at a time; the rest wait for a slot here. If the runner drops, everything pending fails with `offline`.

import { newId } from "@vanr/engine/ids";
import {
  type AgentRef,
  type HarnessEvent,
  MAX_INFLIGHT,
  type OpArgs,
  type RunnerErrorCode,
  type RunnerOp,
  type ServerFrame,
} from "@vanr/engine/runner-protocol";
import type { ServerWebSocket } from "bun";
import { log } from "../logger";

export interface RunnerSocketData {
  kind: "runner";
  runnerId: string | null;
  workspaceId: string | null;
  lastFrameAt: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  /** The close handler ran: an `hello` still awaiting must not register it nor arm a timer. */
  closed: boolean;
  /**
   * The `lastOnlineAt` this connection's hello wrote: the row still carries it only while this is the runner's
   * current connection, so the close writes the disconnection (and says the runner left) only then.
   */
  onlineAt: Date | null;
}

export type RunnerSocket = ServerWebSocket<RunnerSocketData>;

export class RunnerCallError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Agent tool called by the harness on the runner during a `harness.turn`. */
type HarnessToolHandler = (name: string, input: unknown) => Promise<{ content: string; isError: boolean }>;

interface Pending {
  runnerId: string;
  /** The connection the request went out on: only frames from it count for the request. */
  socket: RunnerSocket;
  /** The agent the request is for (null: the runner itself). */
  agentId: string | null;
  resolve: (data: unknown) => void;
  reject: (err: RunnerCallError) => void;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  onHarnessEvent?: (event: HarnessEvent) => void;
  onHarnessTool?: HarnessToolHandler;
  timer: ReturnType<typeof setTimeout>;
}

interface CallOptions {
  agent?: AgentRef | null;
  timeoutMs?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  onHarnessEvent?: (event: HarnessEvent) => void;
  onHarnessTool?: HarnessToolHandler;
  signal?: AbortSignal;
}

export class RunnerHub {
  private readonly sockets = new Map<string, RunnerSocket>();
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();
  /** Connections the server cut (revoked, removed, re-paired): nothing they send counts any more. */
  private readonly cut = new WeakSet<RunnerSocket>();

  isOnline(runnerId: string): boolean {
    return this.sockets.has(runnerId);
  }

  online(): string[] {
    return [...this.sockets.keys()];
  }

  /** Registers the runner's connection and returns the previous one (which must be rejected with `replaced`). */
  register(runnerId: string, ws: RunnerSocket): RunnerSocket | null {
    const previous = this.sockets.get(runnerId) ?? null;
    this.sockets.set(runnerId, ws);
    if (previous) this.failAll(runnerId, "offline", "The runner reconnected");
    return previous && previous !== ws ? previous : null;
  }

  /** Removes the connection (if it is still the current one). Returns true when the runner went offline. */
  unregister(ws: RunnerSocket): boolean {
    const id = ws.data.runnerId;
    if (!id || this.sockets.get(id) !== ws) return false;
    this.sockets.delete(id);
    this.failAll(id, "offline", "The runner went offline");
    return true;
  }

  send(runnerId: string, frame: ServerFrame): boolean {
    const ws = this.sockets.get(runnerId);
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.warn("runner.send_failed", { err, runnerId });
      return false;
    }
  }

  close(runnerId: string, frame: ServerFrame | null, code = 1000) {
    const ws = this.sockets.get(runnerId);
    if (!ws) return;
    if (frame) this.send(runnerId, frame);
    // Cut at once: the pending requests fail now and the socket's frames stop counting, before its close ends.
    this.cut.add(ws);
    this.failAll(runnerId, "offline", "The runner was disconnected");
    ws.close(code, "closed");
  }

  /** The socket is the runner's current connection and the server didn't cut it. */
  isCurrent(ws: RunnerSocket): boolean {
    return !this.cut.has(ws) && !!ws.data.runnerId && this.sockets.get(ws.data.runnerId) === ws;
  }

  private async slot(runnerId: string, signal?: AbortSignal): Promise<() => void> {
    const used = this.busy.get(runnerId) ?? 0;
    if (used >= MAX_INFLIGHT) {
      await new Promise<void>((resolve, reject) => {
        const list = this.waiting.get(runnerId) ?? [];
        // A reused signal keeps no listener once the slot comes: `go` takes it off.
        const onAbort = () => {
          this.waiting.set(
            runnerId,
            (this.waiting.get(runnerId) ?? []).filter((g) => g !== go),
          );
          reject(new RunnerCallError("canceled", "Canceled"));
        };
        const go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        list.push(go);
        this.waiting.set(runnerId, list);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.busy.set(runnerId, (this.busy.get(runnerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.set(runnerId, Math.max(0, (this.busy.get(runnerId) ?? 1) - 1));
      this.waiting.get(runnerId)?.shift()?.();
    };
  }

  async call<O extends RunnerOp, T = unknown>(
    runnerId: string,
    op: O,
    args: OpArgs<O>,
    opts: CallOptions = {},
  ): Promise<T> {
    if (!this.isOnline(runnerId)) throw new RunnerCallError("offline", "The runner is offline");
    const release = await this.slot(runnerId, opts.signal);
    const id = newId("rq");
    const onAbort = () => {
      if (this.pending.has(id)) this.send(runnerId, { type: "cancel", id });
    };
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.send(runnerId, { type: "cancel", id });
          reject(new RunnerCallError("timeout", "The runner did not answer in time"));
        }, opts.timeoutMs ?? 60_000);
        const socket = this.sockets.get(runnerId);
        if (!socket) {
          clearTimeout(timer);
          reject(new RunnerCallError("offline", "The runner is offline"));
          return;
        }
        this.pending.set(id, {
          runnerId,
          socket,
          agentId: opts.agent?.id ?? null,
          resolve: (d) => resolve(d as T),
          reject,
          onOutput: opts.onOutput,
          onHarnessEvent: opts.onHarnessEvent,
          onHarnessTool: opts.onHarnessTool,
          timer,
        });
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        const sent = this.send(runnerId, {
          type: "request",
          id,
          op,
          agent: opts.agent ?? null,
          stream: !!opts.onOutput,
          args: args as Record<string, unknown>,
        });
        if (!sent) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new RunnerCallError("offline", "The runner is offline"));
        }
      });
    } finally {
      // However the call ended (result, error, deadline, runner gone, server stopping).
      opts.signal?.removeEventListener("abort", onAbort);
      release();
    }
  }

  /** The answer to a request: it counts only from the runner the request went to (another one's is dropped). */
  onResult(
    from: RunnerSocket,
    frame:
      | { id: string; ok: true; data: unknown }
      | { id: string; ok: false; error: { code: RunnerErrorCode; message: string } },
  ) {
    const p = this.pendingOf(from, frame.id);
    if (!p) {
      if (this.pending.has(frame.id))
        log.warn("runner.foreign_result", { runnerId: from.data.runnerId, id: frame.id });
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.data);
    else p.reject(new RunnerCallError(frame.error.code, frame.error.message));
  }

  /** A piece of a request's output: only from the runner the request went to. */
  onOutput(from: RunnerSocket, frame: { id: string; stream: "stdout" | "stderr"; chunk: string }) {
    const p = this.pendingOf(from, frame.id);
    if (!p) {
      if (this.pending.has(frame.id))
        log.warn("runner.foreign_output", { runnerId: from.data.runnerId, id: frame.id });
      return;
    }
    p.onOutput?.(frame.stream, frame.chunk);
  }

  /** Only valid for the request this same runner is serving. */
  private pendingOf(from: RunnerSocket, id: string): Pending | null {
    const p = this.pending.get(id);
    return p && p.socket === from ? p : null;
  }

  onHarnessEvent(from: RunnerSocket, frame: { id: string; event: HarnessEvent }) {
    const p = this.pendingOf(from, frame.id);
    if (!p && this.pending.has(frame.id))
      log.warn("runner.foreign_harness_event", { runnerId: from.data.runnerId, id: frame.id });
    p?.onHarnessEvent?.(frame.event);
  }

  /** The harness called a tool: runs it and returns the result to the runner. */
  onHarnessTool(from: RunnerSocket, frame: { id: string; callId: string; name: string; input: unknown }) {
    const handler = this.pendingOf(from, frame.id)?.onHarnessTool;
    const runnerId = from.data.runnerId ?? "";
    const reply = (out: { content: string; isError: boolean }) =>
      this.send(runnerId, {
        type: "harness.tool_result",
        id: frame.id,
        callId: frame.callId,
        content: out.content.slice(0, 400_000),
        isError: out.isError,
      });
    if (!handler) {
      reply({ content: "This turn is over", isError: true });
      return;
    }
    handler(frame.name, frame.input).then(reply, (err) =>
      reply({ content: err instanceof Error ? err.message : String(err), isError: true }),
    );
  }

  /**
   * The right a request ran under ended (the agent moved to another runner or lost it, the runner's access was
   * reduced): its pending requests fail with `canceled` and the runner is told to stop them. With no `agentId`,
   * every pending request of the runner.
   */
  cancelPending(runnerId: string, agentId?: string) {
    for (const [id, p] of this.pending) {
      if (p.runnerId !== runnerId || (agentId !== undefined && p.agentId !== agentId)) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      this.send(runnerId, { type: "cancel", id });
      p.reject(new RunnerCallError("canceled", "Canceled: the access it ran under changed"));
    }
  }

  private failAll(runnerId: string, code: RunnerErrorCode, message: string) {
    for (const [id, p] of this.pending) {
      if (p.runnerId !== runnerId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new RunnerCallError(code, message));
    }
  }

  /** The server is stopping: every pending call fails and every runner connection closes. */
  closeAll() {
    for (const id of this.sockets.keys()) this.failAll(id, "offline", "The server is stopping");
    for (const ws of this.sockets.values()) ws.close(1001, "server stopping");
    this.sockets.clear();
  }
}
