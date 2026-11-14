// Real time for components: the provider the frame mounts and the hooks areas use.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type ApiMethod, type ParamsOf, useInvalidate } from "../api/index.ts";
import { useClock } from "../platform/clock.tsx";
import {
  openRealtime,
  type RealtimeConnection,
  type RealtimeEvent,
  type RealtimeStatus,
  type SocketOpener,
} from "./connection.ts";

const RealtimeContext = createContext<RealtimeConnection | null>(null);

export function RealtimeProvider({
  workspaceId,
  open,
  onReconnected,
  onAccessEnded,
  children,
}: {
  workspaceId: string;
  open: SocketOpener;
  onReconnected: () => void;
  onAccessEnded: () => void;
  children: ReactNode;
}) {
  const clock = useClock();
  const [connection, setConnection] = useState<RealtimeConnection | null>(null);
  // The latest callbacks, without reopening the socket when a parent re-renders.
  const callbacks = useRef({ onReconnected, onAccessEnded });
  callbacks.current = { onReconnected, onAccessEnded };
  useEffect(() => {
    const opened = openRealtime({
      workspaceId,
      open,
      clock,
      onReconnected: () => callbacks.current.onReconnected(),
      onAccessEnded: () => callbacks.current.onAccessEnded(),
    });
    setConnection(opened);
    return () => {
      opened.close();
      setConnection(null);
    };
  }, [workspaceId, open, clock]);
  return <RealtimeContext.Provider value={connection}>{children}</RealtimeContext.Provider>;
}

const noSubscription = () => () => {};

/** The connection's status; `connecting` before the frame has opened it. */
export function useRealtimeStatus(): RealtimeStatus {
  const connection = useContext(RealtimeContext);
  return useSyncExternalStore(
    connection?.onStatus ?? noSubscription,
    () => connection?.status() ?? "connecting",
    () => "connecting",
  );
}

/** Asks for a reconnect attempt right away. */
export function useRealtimeRetry(): () => void {
  const connection = useContext(RealtimeContext);
  return () => connection?.retryNow();
}

/** Runs `handler` for every event with one of these names while the component is mounted. */
export function useRealtimeEvent(types: string | readonly string[], handler: (event: RealtimeEvent) => void) {
  const connection = useContext(RealtimeContext);
  const latest = useRef(handler);
  latest.current = handler;
  const names = typeof types === "string" ? types : types.join("\n");
  useEffect(() => {
    if (connection === null) return;
    const offs = names.split("\n").map((type) => connection.on(type, (event) => latest.current(event)));
    return () => {
      for (const off of offs) off();
    };
  }, [connection, names]);
}

/** Refetches one cached call whenever one of these events arrives. */
export function useInvalidateOn<M extends ApiMethod>(
  types: string | readonly string[],
  method: M,
  params?: ParamsOf<M>,
) {
  const invalidate = useInvalidate();
  useRealtimeEvent(types, () => void invalidate(method, params));
}

/** Follows a channel's events while the component is mounted. */
export function useChannelSubscription(channelId: string | undefined) {
  const connection = useContext(RealtimeContext);
  useEffect(() => {
    if (connection === null || channelId === undefined) return;
    return connection.followChannel(channelId);
  }, [connection, channelId]);
}

/** Sends an area's own frame over the shared connection. */
export function useRealtimeSend(): RealtimeConnection["send"] {
  const connection = useContext(RealtimeContext);
  return (frame) => connection?.send(frame);
}
