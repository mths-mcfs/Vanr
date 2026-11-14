// The live wiki's test client: the Hocuspocus provider over the real /api/v1/wiki/collab socket, with the
// session cookie of a signed-in `Browser`, and the waits the live tests share.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { RunningServer } from "../src/server";
import { COLLAB_PATH } from "../src/wiki-collab";
import { wikiMarkdown } from "../src/wiki-md";
import type { Browser } from "./harness";

/** Waits for a condition the server or the socket makes true (each check is a fresh read). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(20);
  }
}

/** The session's queued work is done and no page of this server is held in memory. */
export const unloaded = (srv: RunningServer) =>
  until(async () => {
    await srv.deps.wikiLive.settled();
    return srv.deps.wikiLive.loaded() === 0;
  });

export interface Client {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  stateless: Record<string, unknown>[];
  /** SyncStatus answers of the server: `false` is an update it rejected (a read-only connection). */
  syncStatus: boolean[];
  /** Close codes of the socket, in order (the server's 44xx say why it dropped the connection). */
  closeCodes: number[];
  synced: Promise<void>;
  md(base?: string): Promise<string>;
  edit(fn: (md: string) => string): Promise<void>;
  close(): void;
}

/** Reads a lib0 varUint at `at`; returns the value and the next position. */
function varUint(bytes: Uint8Array, at: number): [number, number] {
  let num = 0;
  let mult = 1;
  for (;;) {
    const b = bytes[at++] ?? 0;
    num += (b & 0x7f) * mult;
    mult *= 128;
    if (b < 0x80) return [num, at];
  }
}

/** The SyncStatus of a server message (type 8: document name, type, then a varInt 1 or 0), or null. */
function syncStatusOf(data: ArrayBuffer | Uint8Array): boolean | null {
  const bytes = new Uint8Array(data);
  const [nameLength, afterLength] = varUint(bytes, 0);
  const [type, afterType] = varUint(bytes, afterLength + nameLength);
  return type === 8 ? (bytes[afterType] ?? 0) === 1 : null;
}

export function connect(
  srv: RunningServer,
  browser: Browser,
  workspaceId: string,
  name: string,
  opts: { origin?: string } = {},
): Client {
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const origin = opts.origin ?? srv.url;
  class CookieSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { cookie, origin } } as never);
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: `${srv.url.replace(/^http/, "ws")}${COLLAB_PATH}?workspaceId=${encodeURIComponent(workspaceId)}`,
    WebSocketPolyfill: CookieSocket,
    maxAttempts: 1,
  });
  const doc = new Y.Doc();
  const stateless: Record<string, unknown>[] = [];
  const syncStatus: boolean[] = [];
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const synced = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token: "cookie",
    onSynced: () => resolve(),
    onAuthenticationFailed: ({ reason }) => reject(new Error(`auth: ${reason}`)),
    onStateless: ({ payload }) => stateless.push(JSON.parse(payload)),
  });
  provider.on("message", ({ event }: { event: MessageEvent }) => {
    const status = syncStatusOf(event.data);
    if (status !== null) syncStatus.push(status);
  });
  const closeCodes: number[] = [];
  provider.on("close", ({ event }: { event: CloseEvent }) => closeCodes.push(event.code));
  provider.attach();
  return {
    doc,
    provider,
    stateless,
    syncStatus,
    closeCodes,
    synced,
    async md(base) {
      const md = await wikiMarkdown();
      const pm = md.fromYDoc(doc);
      return base === undefined ? md.serialize(pm) : md.serializePreserving(pm, base);
    },
    async edit(fn) {
      const md = await wikiMarkdown();
      md.replaceYContent(doc, fn(md.serialize(md.fromYDoc(doc))));
    },
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
}
