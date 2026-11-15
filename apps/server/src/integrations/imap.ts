// Minimal IMAP client (RFC 9051/3501): only what an agent's mailbox uses — log in, list folders,
// search, read, flag and move. Direct TLS (993) or plain text in the tests.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { type NetPolicy, socketAddress } from "./net";

export class ImapError extends Error {
  constructor(
    message: string,
    /** `auth` when the server rejected the login; `unreachable` when it did not even connect. */
    readonly kind: "auth" | "unreachable" | "protocol" = "protocol",
  ) {
    super(message);
  }
}

export interface ImapOptions {
  host: string;
  port: number;
  /** Direct TLS; `false` (plain text) only when the installation allows it (`policy.allowPlaintext`). */
  secure: boolean;
  /** Where the connection may go: checked by `socketAddress` before connecting, to the IP it checked. */
  policy: NetPolicy;
  user: string;
  password: string;
  /** Silence the server may keep while a reply is due. */
  timeoutMs?: number;
  /** Time a whole command's reply may take, however the server trickles it (default 120 s). */
  commandMs?: number;
  /** Bytes a reply may hold, literals included (default `IMAP_MAX_REPLY_BYTES`). */
  maxReplyBytes?: number;
}

/** A reply above 32 MiB is a server misbehaving: the client stops reading and closes. */
export const IMAP_MAX_REPLY_BYTES = 32 * 1024 * 1024;

export interface ImapFolder {
  name: string;
  /** Special use announced by the server (RFC 6154). */
  special: "inbox" | "sent" | "drafts" | "trash" | "archive" | "junk" | null;
}

export interface FetchedMessage {
  uid: number;
  flags: string[];
  /** Raw message (up to the requested limit). */
  raw: string;
}

/** One reply: untagged lines (`*`) with the literals already inlined, and the final tagged line. */
interface Reply {
  untagged: { line: string; literals: string[] }[];
  status: "OK" | "NO" | "BAD";
  text: string;
}

/**
 * IMAP quoting: escapes \ and ". A quoted string can't hold CR, LF or NUL (RFC 9051): a line break would end
 * the command and start another one, so the value is rejected instead of cleaned.
 */
export const quote = (s: string) => {
  if (/[\r\n]/.test(s) || s.includes("\0"))
    throw new ImapError("A folder or login has a line break", "protocol");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Date in the SEARCH SINCE format: 1-Oct-2026. */
export const imapDate = (d: Date) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/** Reads a LIST reply: `* LIST (\HasNoChildren \Sent) "/" "Sent"`. */
export function parseList(line: string): ImapFolder | null {
  const m = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$/i.exec(line);
  if (!m?.[2]) return null;
  const flags = (m[1] ?? "").toLowerCase().split(/\s+/);
  if (flags.includes("\\noselect") || flags.includes("\\nonexistent")) return null;
  let name = m[2].trim();
  if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  const special =
    name.toUpperCase() === "INBOX"
      ? "inbox"
      : flags.includes("\\sent")
        ? "sent"
        : flags.includes("\\drafts")
          ? "drafts"
          : flags.includes("\\trash")
            ? "trash"
            : flags.includes("\\archive") || flags.includes("\\all")
              ? "archive"
              : flags.includes("\\junk")
                ? "junk"
                : null;
  return { name, special };
}

export class ImapClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed = false;
  private tag = 0;
  /** Why the client closed the connection itself: past the byte cap or the command's deadline. */
  private stopped: ImapError | null = null;
  /** When the current command's reply has to be complete. */
  private deadline = Number.POSITIVE_INFINITY;
  /** Bytes of the current reply read so far. */
  private replyBytes = 0;

  private constructor(private readonly opts: ImapOptions) {}

  static async open(opts: ImapOptions): Promise<ImapClient> {
    const client = new ImapClient(opts);
    await client.connect();
    return client;
  }

  private get maxReplyBytes() {
    return this.opts.maxReplyBytes ?? IMAP_MAX_REPLY_BYTES;
  }

  /** Closes the connection on the client's side; whoever waits for a reply gets `reason`. */
  private stop(reason: ImapError) {
    this.stopped ??= reason;
    this.socket?.destroy();
  }

  private async connect(): Promise<void> {
    const { host, port, secure } = this.opts;
    const to = await socketAddress(host, secure, this.opts.policy);
    this.deadline = Date.now() + (this.opts.commandMs ?? 120_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy();
        reject(new ImapError("Mail server did not answer in time", "unreachable"));
      }, this.opts.timeoutMs ?? 15_000);
      const socket = secure
        ? tlsConnect({ host: to, port, servername: host })
        : netConnect({ host: to, port });
      this.socket = socket;
      socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        // Bytes waiting to be read count against the cap too: a server that never ends a line can't grow it.
        if (this.buffer.length > this.maxReplyBytes)
          this.stop(new ImapError("The mail server sent a reply that is too large", "protocol"));
        for (const w of this.waiters.splice(0)) w();
      });
      socket.on("close", () => {
        this.closed = true;
        for (const w of this.waiters.splice(0)) w();
      });
      // An error after connecting only closes: whoever waits for a reply gets "Connection closed".
      socket.on("error", (err) => {
        this.closed = true;
        for (const w of this.waiters.splice(0)) w();
        clearTimeout(timer);
        reject(new ImapError(`Could not reach the mail server: ${err.message}`, "unreachable"));
      });
      this.readLine()
        .then((greeting) => {
          clearTimeout(timer);
          if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new ImapError("Unexpected greeting", "protocol");
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        });
    });
  }

  private async waitData(): Promise<void> {
    if (this.stopped) throw this.stopped;
    if (this.closed) throw new ImapError("Connection closed", "protocol");
    const left = this.deadline - Date.now();
    if (left <= 0) {
      this.stop(new ImapError("Mail server did not answer in time", "unreachable"));
      throw this.stopped;
    }
    const idle = this.opts.timeoutMs ?? 15_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () =>
          left < idle
            ? this.stop(new ImapError("Mail server did not answer in time", "unreachable"))
            : this.socket?.destroy(),
        Math.min(idle, left),
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const at = this.buffer.indexOf("\r\n");
      if (at >= 0) {
        const line = this.buffer.subarray(0, at).toString("utf8");
        this.buffer = this.buffer.subarray(at + 2);
        this.count(at + 2);
        return line;
      }
      await this.waitData();
    }
  }

  /** Counts `n` bytes of the current reply; past the cap, the connection closes. */
  private count(n: number) {
    this.replyBytes += n;
    if (this.replyBytes > this.maxReplyBytes) {
      this.stop(new ImapError("The mail server sent a reply that is too large", "protocol"));
      throw this.stopped;
    }
  }

  private async readBytes(n: number): Promise<string> {
    // The size comes from the server: check it before waiting for that many bytes.
    this.count(n);
    while (this.buffer.length < n) await this.waitData();
    const out = this.buffer.subarray(0, n).toString("utf8");
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Reads one logical line: when it ends in {n}, the literal comes next and the line goes on. */
  private async readLogical(): Promise<{ line: string; literals: string[] }> {
    let line = await this.readLine();
    const literals: string[] = [];
    for (;;) {
      const m = /\{(\d+)\}$/.exec(line);
      if (!m?.[1]) return { line, literals };
      literals.push(await this.readBytes(Number(m[1])));
      line = `${line}\u0000${await this.readLine()}`;
    }
  }

  /** A command starts: its reply gets the whole byte budget and a deadline of its own. */
  private startReply() {
    this.replyBytes = 0;
    this.deadline = Date.now() + (this.opts.commandMs ?? 120_000);
  }

  async command(text: string): Promise<Reply> {
    if (!this.socket || this.closed) throw new ImapError("Not connected", "protocol");
    const tag = `A${++this.tag}`;
    this.startReply();
    this.socket.write(`${tag} ${text}\r\n`);
    const untagged: Reply["untagged"] = [];
    for (;;) {
      const logical = await this.readLogical();
      if (logical.line.startsWith(`${tag} `)) {
        const rest = logical.line.slice(tag.length + 1);
        const status = rest.slice(0, rest.indexOf(" ") === -1 ? undefined : rest.indexOf(" ")).toUpperCase();
        if (status !== "OK" && status !== "NO" && status !== "BAD")
          throw new ImapError("Bad reply", "protocol");
        return { untagged, status, text: rest };
      }
      untagged.push(logical);
    }
  }

  private async ok(text: string, what: string): Promise<Reply> {
    const reply = await this.command(text);
    if (reply.status !== "OK") throw new ImapError(`${what} failed: ${reply.text}`, "protocol");
    return reply;
  }

  async login(): Promise<void> {
    const reply = await this.command(`LOGIN ${quote(this.opts.user)} ${quote(this.opts.password)}`);
    if (reply.status !== "OK") throw new ImapError("The mail server rejected the login", "auth");
  }

  async folders(): Promise<ImapFolder[]> {
    const reply = await this.ok('LIST "" "*"', "LIST");
    return reply.untagged.map((u) => parseList(u.line)).filter((f): f is ImapFolder => f !== null);
  }

  /** Opens the folder; `readOnly` uses EXAMINE and does not change flags. */
  async open(folder: string, readOnly = true): Promise<{ exists: number; uidValidity: number | null }> {
    const reply = await this.ok(`${readOnly ? "EXAMINE" : "SELECT"} ${quote(folder)}`, "SELECT");
    let exists = 0;
    let uidValidity: number | null = null;
    for (const { line } of reply.untagged) {
      const e = /^\* (\d+) EXISTS/i.exec(line);
      if (e?.[1]) exists = Number(e[1]);
      const v = /UIDVALIDITY (\d+)/i.exec(line);
      if (v?.[1]) uidValidity = Number(v[1]);
    }
    return { exists, uidValidity };
  }

  /** UID SEARCH with criteria already built (e.g. `SINCE 1-Oct-2026 FROM "x@y"`). */
  async search(criteria: string): Promise<number[]> {
    const reply = await this.ok(`UID SEARCH ${criteria}`, "SEARCH");
    const uids: number[] = [];
    for (const { line } of reply.untagged) {
      const m = /^\* SEARCH ?(.*)$/i.exec(line);
      if (m) for (const n of (m[1] ?? "").trim().split(/\s+/)) if (n) uids.push(Number(n));
    }
    return uids.sort((a, b) => a - b);
  }

  /** Fetches the raw messages (up to `maxBytes` each) without marking them as read. */
  async fetch(uids: readonly number[], maxBytes = 65_536): Promise<FetchedMessage[]> {
    if (uids.length === 0) return [];
    const reply = await this.ok(
      `UID FETCH ${uids.join(",")} (UID FLAGS BODY.PEEK[]<0.${maxBytes}>)`,
      "FETCH",
    );
    const out: FetchedMessage[] = [];
    for (const { line, literals } of reply.untagged) {
      if (!/^\* \d+ FETCH/i.test(line)) continue;
      const uid = /UID (\d+)/i.exec(line)?.[1];
      if (!uid) continue;
      const flags = /FLAGS \(([^)]*)\)/i.exec(line)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
      out.push({ uid: Number(uid), flags, raw: literals[0] ?? "" });
    }
    return out.sort((a, b) => a.uid - b.uid);
  }

  async addFlags(uid: number, flags: string): Promise<void> {
    await this.ok(`UID STORE ${uid} +FLAGS (${flags})`, "STORE");
  }

  /** Moves with the MOVE extension; without it, copies and deletes. Needs the folder opened with SELECT. */
  async move(uid: number, to: string): Promise<void> {
    const moved = await this.command(`UID MOVE ${uid} ${quote(to)}`);
    if (moved.status === "OK") return;
    const capabilities = await this.ok("CAPABILITY", "CAPABILITY");
    if (!capabilities.untagged.some(({ line }) => /^\* CAPABILITY .*\bUIDPLUS\b/i.test(line)))
      throw new ImapError("Moving safely requires MOVE or UIDPLUS", "protocol");
    await this.ok(`UID COPY ${uid} ${quote(to)}`, "COPY");
    await this.addFlags(uid, "\\Deleted");
    await this.ok(`UID EXPUNGE ${uid}`, "EXPUNGE");
  }

  async append(folder: string, raw: string, flags = "\\Seen"): Promise<void> {
    if (!this.socket) throw new ImapError("Not connected", "protocol");
    const tag = `A${++this.tag}`;
    this.startReply();
    const size = Buffer.byteLength(raw, "utf8");
    this.socket.write(`${tag} APPEND ${quote(folder)} (${flags}) {${size}}\r\n`);
    const go = await this.readLine();
    if (!go.startsWith("+")) throw new ImapError("APPEND rejected", "protocol");
    this.socket.write(`${raw}\r\n`);
    for (;;) {
      const { line } = await this.readLogical();
      if (line.startsWith(`${tag} `)) {
        if (!/^A\d+ OK/i.test(line)) throw new ImapError(`APPEND failed: ${line}`, "protocol");
        return;
      }
    }
  }

  async close(): Promise<void> {
    if (!this.socket || this.closed) return;
    const timer = setTimeout(() => this.socket?.destroy(), 1000);
    try {
      await this.command("LOGOUT");
    } catch {
      // already closed
    }
    clearTimeout(timer);
    this.socket.destroy();
    this.closed = true;
  }
}
