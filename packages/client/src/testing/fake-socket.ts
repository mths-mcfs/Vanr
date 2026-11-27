// A WebSocket stand-in driven by the test: it records what the client sent and lets the test open it,
// push frames and close it with any code.
import type { SocketLike } from "../realtime/socket.ts";

export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    const frame: unknown = JSON.parse(data);
    if (typeof frame === "object" && frame !== null && !Array.isArray(frame)) {
      this.sent.push({ ...frame });
    }
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  /** The server accepted the connection; with `ready`, it also sends the greeting. */
  open(
    ready: { userId: string; workspaceId: string } | null = { userId: "user_1", workspaceId: "ws_1" },
  ): void {
    this.readyState = 1;
    this.onopen?.({});
    if (ready) this.push({ type: "ready", ...ready });
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  /** The server (or the network) closed it. */
  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** A socket factory that keeps every socket it made, newest last. */
export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    create: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    get last(): FakeSocket {
      const s = sockets.at(-1);
      if (!s) throw new Error("no socket was created");
      return s;
    },
  };
}
