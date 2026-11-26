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
}

/** Connection transitions a runner may have waiting at once; a runner reconnecting in a loop past it is turned away (close 1013). */
export const MAX_TRANSITIONS = 8;

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
  op: RunnerOp;
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
  authorized?: () => boolean;
}

export class RunnerHub {
  private readonly sockets = new Map<string, RunnerSocket>();
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Map<string, number>();
  private readonly waiting = new Map<
    string,
    { agentId: string | null; go: () => void; cancel: (err: RunnerCallError) => void }[]
  >();
  private readonly grants = new Map<string, object>();
  /** Connections the server cut (revoked, removed, re-paired): nothing they send counts any more. */
  private readonly cut = new WeakSet<RunnerSocket>();
  /** Each runner's connection transitions, one at a time: the tail of the chain and how many wait on it. */
  private readonly transitions = new Map<string, { tail: Promise<void>; size: number }>();

  /**
   * Runs `step` after the runner's earlier connection transitions (a hello that registers, a close that
   * unregisters, each with its writes and presence events), so a close never runs in the middle of a hello.
   * Per runner: the others don't wait. False when the runner already has MAX_TRANSITIONS waiting (the step
   * doesn't run); the entry goes away once nothing is waiting.
   */
  transition(runnerId: string, step: () => Promise<void>): Promise<boolean> {
    const queue = this.transitions.get(runnerId) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= MAX_TRANSITIONS) return Promise.resolve(false);
    queue.size += 1;
    const run = queue.tail
      .then(step)
      .catch((err: unknown) => log.error("runner.transition_failed", { err, runnerId }));
    queue.tail = run.finally(() => {
      queue.size -= 1;
      if (queue.size === 0 && this.transitions.get(runnerId) === queue) this.transitions.delete(runnerId);
    });
    this.transitions.set(runnerId, queue);
    return queue.tail.then(() => true);
  }

  /** The runners with a transition waiting (tests). */
  pendingTransitions(): number {
    return this.transitions.size;
  }

  /** Resolves when every runner's transitions ran (the server's stop waits for it). */
  async settled(): Promise<void> {
    while (this.transitions.size) await Promise.all([...this.transitions.values()].map((q) => q.tail));
  }

  /** The socket closed: what it had pending fails now, before its turn to unregister comes. */
  failSocket(ws: RunnerSocket) {
    for (const [id, p] of this.pending) {
      if (p.socket !== ws) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new RunnerCallError("offline", "The runner went offline"));
    }
  }

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
    return (
      !ws.data.closed && !this.cut.has(ws) && !!ws.data.runnerId && this.sockets.get(ws.data.runnerId) === ws
    );
  }

  /** Captures the connection and access under which an operation was authorized, including before DB waits. */
  authorization(runnerId: string, agentId?: string): () => boolean {
    const keys = [runnerId, `${runnerId}/${agentId ?? ""}`];
    const grants = keys.map((key) => this.grants.get(key));
    const socket = this.sockets.get(runnerId);
    return () =>
      !!socket && this.isCurrent(socket) && keys.every((key, i) => this.grants.get(key) === grants[i]);
  }

  private async slot(runnerId: string, agentId: string | null, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RunnerCallError("canceled", "Canceled");
    const used = this.busy.get(runnerId) ?? 0;
    if (used >= MAX_INFLIGHT) {
      await new Promise<void>((resolve, reject) => {
        const list = this.waiting.get(runnerId) ?? [];
        // A reused signal keeps no listener once the slot comes: `go` takes it off.
        const cancel = (err: RunnerCallError) => {
          signal?.removeEventListener("abort", onAbort);
          this.waiting.set(
            runnerId,
            (this.waiting.get(runnerId) ?? []).filter((g) => g !== entry),
          );
          reject(err);
        };
        const onAbort = () => cancel(new RunnerCallError("canceled", "Canceled"));
        const go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const entry = { agentId, go, cancel };
        list.push(entry);
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
      this.waiting.get(runnerId)?.shift()?.go();
    };
  }

  async call<O extends RunnerOp, T = unknown>(
    runnerId: string,
    op: O,
    args: OpArgs<O>,
    opts: CallOptions = {},
  ): Promise<T> {
    const canceled = () => new RunnerCallError("canceled", "Canceled");
    // A request whose caller already gave up never goes out.
    if (opts.signal?.aborted) throw canceled();
    if (!this.isOnline(runnerId)) throw new RunnerCallError("offline", "The runner is offline");
    const authorized = opts.authorized ?? this.authorization(runnerId, opts.agent?.id);
    const release = await this.slot(runnerId, opts.agent?.id ?? null, opts.signal);
    const id = newId("rq");
    let onAbort = () => {};
    try {
      if (opts.signal?.aborted) throw canceled();
      if (!authorized()) throw new RunnerCallError("canceled", "Canceled: the access it ran under changed");
      return await new Promise<T>((resolve, reject) => {
        // Given up while waiting: the runner is told to stop, the deadline goes and the call ends now; an answer
        // that comes after it finds no request and is dropped.
        onAbort = () => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          this.send(runnerId, { type: "cancel", id });
          reject(canceled());
        };
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
          op,
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
   * every pending request of the runner. `exceptOp` preserves only results already in flight, never queued work.
   */
  cancelPending(runnerId: string, agentId?: string, exceptOp?: "access.reduce") {
    this.grants.set(agentId === undefined ? runnerId : `${runnerId}/${agentId}`, {});
    for (const w of [...(this.waiting.get(runnerId) ?? [])])
      if (agentId === undefined || w.agentId === agentId)
        w.cancel(new RunnerCallError("canceled", "Canceled: the access it ran under changed"));
    for (const [id, p] of this.pending) {
      if (p.runnerId !== runnerId || (agentId !== undefined && p.agentId !== agentId) || p.op === exceptOp)
        continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      this.send(runnerId, { type: "cancel", id });
      p.reject(new RunnerCallError("canceled", "Canceled: the access it ran under changed"));
    }
  }

  private failAll(runnerId: string, code: RunnerErrorCode, message: string) {
    this.grants.set(runnerId, {});
    for (const w of [...(this.waiting.get(runnerId) ?? [])]) w.cancel(new RunnerCallError(code, message));
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
