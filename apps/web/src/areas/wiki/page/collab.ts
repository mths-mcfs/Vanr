// A page's live document: one Y.Doc per open page, kept in sync by the server's Hocuspocus. The
// server stamps who each person is in the presence, and says by a stateless message when the draft
// was published, discarded or ran into a newer version.
//
// How the server ends a socket decides what happens next: an ended session sends the person to sign
// in, a rejected update (4412, 4413) drops the local document and loads the page again, and a lost
// right (4403) leaves the published text to read. Everything else reconnects on its own.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { useRuntime } from "../../../app/context.tsx";
import { WIKI_CLOSE, wikiCollabUrl, wikiDocumentName } from "../../../realtime/wiki-collab.ts";

export type LiveStatus = "connecting" | "synced" | "offline" | "denied";

export type LivePeer = {
  clientId: number;
  id: string;
  name: string;
  color: string;
  kind: "person" | "agent";
};

export type LiveEvent =
  | { type: "published"; version: number }
  | { type: "conflict"; version: number }
  | { type: "discarded"; version: number }
  | { type: "publish_failed" }
  | { type: "draft_save_failed" };

export type Live = { doc: Y.Doc; provider: HocuspocusProvider };

export type LiveState = {
  live: Live | null;
  status: LiveStatus;
  /** Changes made here that the server has not confirmed yet. */
  unsynced: number;
  peers: LivePeer[];
  /**
   * The document synced with the server at least once: from then on it stays the one on screen, also
   * while the connection is away (edits wait in it and sync on reconnect).
   */
  ready: boolean;
  /** The server opened the page to read only (a locked page, for someone who may not unlock it). */
  readOnly: boolean;
  /** Something changed the document here since it was opened or last published. */
  touched: boolean;
  clearTouched: () => void;
};

function parseEvent(payload: string): LiveEvent | null {
  try {
    const event: unknown = JSON.parse(payload);
    if (typeof event !== "object" || event === null || !("type" in event)) return null;
    const type = String(event.type);
    const version = "version" in event && typeof event.version === "number" ? event.version : 0;
    if (type === "published" || type === "conflict" || type === "discarded") return { type, version };
    if (type === "publish_failed" || type === "draft_save_failed") return { type };
    return null;
  } catch {
    return null;
  }
}

function peersOf(provider: HocuspocusProvider): LivePeer[] {
  const me = provider.awareness?.clientID;
  const peers: LivePeer[] = [];
  for (const [clientId, state] of provider.awareness?.getStates() ?? []) {
    const user: unknown = state.user;
    if (clientId === me || typeof user !== "object" || user === null) continue;
    const { id, name, color, kind } = user as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || name === "") continue;
    // One person in two tabs is one face.
    if (peers.some((peer) => peer.id === id)) continue;
    peers.push({
      clientId,
      id,
      name,
      color: typeof color === "string" ? color : "",
      kind: kind === "agent" ? "agent" : "person",
    });
  }
  return peers;
}

/** Opens the page's live document while `enabled`, and closes it when the page closes. */
export function useLive(
  workspaceId: string,
  slug: string,
  enabled: boolean,
  onEvent: (event: LiveEvent) => void,
): LiveState {
  const { openSocket, gate } = useRuntime();
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [unsynced, setUnsynced] = useState(0);
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [ready, setReady] = useState(false);
  const [touched, setTouched] = useState(false);
  // A rejected update means the local document is wrong: a new one is loaded from the server.
  const [generation, setGeneration] = useState(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` asks for a fresh document.
  useEffect(() => {
    if (!enabled) return;
    const socket = new HocuspocusProviderWebsocket({
      url: wikiCollabUrl(openSocket, workspaceId),
      ...(openSocket.wikiSocket !== undefined && { WebSocketPolyfill: openSocket.wikiSocket }),
    });
    const doc = new Y.Doc();
    let denied = false;
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: wikiDocumentName(workspaceId, slug),
      document: doc,
      // The session travels in the cookie; the token only fulfils the protocol.
      token: "session",
      onStateless: ({ payload }) => {
        const event = parseEvent(payload);
        if (event === null) return;
        if (event.type === "published" || event.type === "discarded") setTouched(false);
        handler.current(event);
      },
      onSynced: () => {
        setStatus("synced");
        setReady(true);
        setReadOnly(provider.authorizedScope === "readonly");
      },
      onAuthenticationFailed: () => {
        denied = true;
        setStatus("denied");
      },
      onStatus: ({ status: next }) => {
        if (denied) return;
        if (next === "disconnected") setStatus("offline");
        else if (next === "connecting")
          setStatus((current) => (current === "synced" ? "offline" : "connecting"));
      },
      onClose: ({ event }) => {
        if (event.code === WIKI_CLOSE.sessionEnded) gate.ended();
        else if (event.code === WIKI_CLOSE.revoked) {
          denied = true;
          setStatus("denied");
        } else if (event.code === WIKI_CLOSE.outOfSync || event.code === WIKI_CLOSE.tooLarge)
          setGeneration((n) => n + 1);
      },
      onUnsyncedChanges: ({ number }) => setUnsynced(number),
      onAwarenessChange: () => setPeers(peersOf(provider)),
    });
    provider.attach();
    // Being on the page is declared here; the server writes who it is over whatever is sent.
    provider.setAwarenessField("user", { present: true });
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== provider) setTouched(true);
    };
    doc.on("update", onUpdate);
    setStatus("connecting");
    setReady(false);
    setTouched(false);
    setLive({ doc, provider });
    return () => {
      doc.off("update", onUpdate);
      setLive(null);
      setPeers([]);
      provider.destroy();
      socket.destroy();
      doc.destroy();
    };
  }, [workspaceId, slug, enabled, openSocket, gate, generation]);

  return { live, status, unsynced, peers, ready, readOnly, touched, clearTouched: () => setTouched(false) };
}

/**
 * Waits up to about three seconds for the changes still on their way, before a publish reads them.
 * False when some are still on their way: publishing then would leave them out.
 */
export async function settle(live: Live | null): Promise<boolean> {
  for (let attempt = 0; attempt < 50 && live?.provider.hasUnsyncedChanges === true; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return live?.provider.hasUnsyncedChanges !== true;
}
