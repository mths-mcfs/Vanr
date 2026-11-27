// The live wiki page's socket for tests: a WebSocket that speaks enough of the Hocuspocus wire protocol
// (auth, sync, stateless notices, close codes) for a page to go live, lose its rights and reconnect,
// without a server. Pass it to `renderApp({ wikiSocket: FakeCollabSocket })`.
import * as Y from "yjs";

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

function writeVarUint(out: number[], num: number) {
  let n = num;
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
}
function writeVarBytes(out: number[], bytes: Uint8Array) {
  writeVarUint(out, bytes.length);
  for (const b of bytes) out.push(b);
}
function writeVarString(out: number[], str: string) {
  writeVarBytes(out, utf8Enc.encode(str));
}
function readVarUint(buf: Uint8Array, pos: { i: number }): number {
  let num = 0;
  let mult = 1;
  while (pos.i < buf.length) {
    const b = buf[pos.i++] ?? 0;
    num += (b & 0x7f) * mult;
    if (b < 0x80) return num;
    mult *= 128;
  }
  return num;
}
function readVarString(buf: Uint8Array, pos: { i: number }): string {
  const len = readVarUint(buf, pos);
  const str = utf8Dec.decode(buf.subarray(pos.i, pos.i + len));
  pos.i += len;
  return str;
}

/**
 * A live wiki socket that speaks enough of the Hocuspocus protocol for the page to sync: it answers the
 * token with the scope it is given, the first sync with the server's document, and every update as
 * applied. A test pushes stateless notices and closes it with the server's codes.
 */
export class FakeCollabSocket {
  static instances: FakeCollabSocket[] = [];
  static nextScope: "read-write" | "readonly" = "read-write";
  static failHandshake = false;
  static autoOpen = true;

  readonly url: string;
  readyState = 0; // CONNECTING
  binaryType = "arraybuffer";
  closed = false;
  closeCalls: { code?: number; reason?: string }[] = [];
  authTokens: string[] = [];
  docNames: string[] = [];
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  private serverDoc = new Y.Doc();

  constructor(url: string) {
    this.url = url;
    FakeCollabSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      if (FakeCollabSocket.failHandshake) {
        // Browser WebSocket behavior when server rejects upgrade with HTTP 401: error + close(1006).
        this.readyState = 3;
        this.emit("error", new Event("error"));
        this.emit("close", { code: 1006, reason: "" });
        return;
      }
      if (!FakeCollabSocket.autoOpen) return;
      this.readyState = 1; // OPEN
      this.emit("open", {});
    });
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  private emit(type: string, ev: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  send(data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length <= 1) return;
    const pos = { i: 0 };
    const docName = readVarString(bytes, pos);
    const msgType = readVarUint(bytes, pos);
    if (!this.docNames.includes(docName)) this.docNames.push(docName);

    if (msgType === 2) {
      // MessageType.Auth
      const authType = readVarUint(bytes, pos);
      if (authType === 0) {
        const token = readVarString(bytes, pos);
        this.authTokens.push(token);
        // Reply AuthMessageType.Authenticated (2) with scope
        const out: number[] = [];
        writeVarString(out, docName);
        writeVarUint(out, 2); // Auth
        writeVarUint(out, 2); // Authenticated
        writeVarString(out, FakeCollabSocket.nextScope);
        this.emit("message", { data: new Uint8Array(out) });
      }
    } else if (msgType === 0) {
      // MessageType.Sync -> reply with SyncStep2 (current server doc) so provider marks synced
      const syncType = readVarUint(bytes, pos);
      if (syncType === 0) {
        const out: number[] = [];
        writeVarString(out, docName);
        writeVarUint(out, 0); // Sync
        writeVarUint(out, 1); // messageYjsSyncStep2
        writeVarBytes(out, Y.encodeStateAsUpdate(this.serverDoc));
        this.emit("message", { data: new Uint8Array(out) });
        const ack: number[] = [];
        writeVarString(ack, docName);
        writeVarUint(ack, 8); // SyncStatus
        writeVarUint(ack, 1); // applied = true (clears initial resetUnsyncedChanges)
        this.emit("message", { data: new Uint8Array(ack) });
      } else if (syncType === 2) {
        // Update: reply SyncStatus applied = 1
        const out: number[] = [];
        writeVarString(out, docName);
        writeVarUint(out, 8); // SyncStatus
        writeVarUint(out, 1);
        this.emit("message", { data: new Uint8Array(out) });
      }
    }
  }

  pushStateless(docName: string, payload: Record<string, unknown>) {
    const out: number[] = [];
    writeVarString(out, docName);
    writeVarUint(out, 5); // MessageType.Stateless
    writeVarString(out, JSON.stringify(payload));
    this.emit("message", { data: new Uint8Array(out) });
  }

  /** Opens a socket that waited (made while `autoOpen` was off): a retry that now gets through. */
  open() {
    if (this.closed || this.readyState === 1) return;
    this.readyState = 1;
    this.emit("open", {});
  }

  serverClose(code: number, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
  }
}
