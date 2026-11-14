// Where a workspace's real-time connection opens its socket. The connection itself (reconnecting
// with a growing wait, subscribing again, stopping for good on 4401) is the client's RealtimeClient;
// the web only says which server and, in tests, which socket.
import type { SocketLike } from "@vanr/client";

export type SocketSource = {
  /** Origin of the server the socket connects to. */
  baseUrl: string;
  /** Left out, the browser's WebSocket. Tests and the fake server pass their own. */
  createSocket?: (url: string) => SocketLike;
  /** 0..1, for the jitter on each reconnection wait. Tests pass a fixed one. */
  random?: () => number;
};

/** The browser's own WebSocket, against this origin. */
export function browserSocketOpener(origin: string): SocketSource {
  return { baseUrl: origin };
}
