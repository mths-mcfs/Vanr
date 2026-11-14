// The wiki's live session: Hocuspocus (Yjs) inside Bun.serve, at /api/v1/wiki/collab?workspaceId=. One
// document per page (`wiki/<workspace>/<slug>`). The Yjs state is the draft: it lives in wiki_page_docs
// (debounced autosave) and becomes a version on publish (the button), after 5 min without an edit or when
// the last person leaves. A write through the API (agent, another tab, restore) enters the session with the
// smallest change; with a dirty draft it merges three ways against the parent version (parentVersion) and,
// if the changes cross, the draft stays put with a conflict notice.
//
// A connection doesn't outlive the right that opened it. Every message to it and from it goes through its
// gate (`Peer`): the session, the membership and the page's lock are read again first, and a connection
// that lost them is closed instead (a member on a page locked since then is closed too, and reconnects read
// only). Every draft save and every publish reads the page locked and checks again, in its own
// transaction, everyone whose edits it carries. An update that would take the page past MAX_BODY is
// answered with SyncStatus false and never applied, stored or relayed.

import { type Document, Hocuspocus } from "@hocuspocus/server";
import type { ActorRef } from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { merge3 } from "@vanr/engine/wiki/merge";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import type { AppDeps } from "./context";
import { errorBody, HttpError, notFound } from "./http";
import { log } from "./logger";
import {
  type Author,
  anyBypasses,
  bypassesLock,
  MAX_BODY,
  pageBySlug,
  pageLock,
  type SaveOrigin,
  savePage,
  type WikiRow,
  writeTx,
} from "./wiki";
import { type WikiMarkdown, wikiMarkdown, YFRAGMENT } from "./wiki-md";

const { knowledgePages, pageRevisions, wikiPageDocs, members, agents, sessions: authSessions } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const COLLAB_PATH = "/api/v1/wiki/collab";
const docName = (workspaceId: string, slug: string) => `wiki/${workspaceId}/${slug}`;
/**
 * The largest message accepted from a client. The page body is capped at 500 thousand characters (MAX_BODY),
 * at most 3 bytes each in UTF-8 for one UTF-16 unit, so a whole page pasted at once (1.5 MB plus the Yjs
 * structure) fits; anything larger is closed before it is decoded.
 */
export const MAX_UPDATE = 2 * 1024 * 1024;
/** The socket's own frame cap, just above MAX_UPDATE: a larger frame never reaches the server's code. */
export const MAX_FRAME = MAX_UPDATE + 64 * 1024;
const AGENT_PRESENCE_MS = 10_000;
const AGENT_COLOR = "#2f6fed";
/**
 * How long a connection's right (session, membership, the pages' lock), once read from the database, stands
 * without reading it again, by the injected clock. Within it no message reads the database. What changes
 * through the server's own paths takes effect at once: a deleted session (the auth hook), a lock or unlock
 * and a membership or role change (recheckPage, recheckUser); the session's expiry is checked against the
 * clock on every message. Only a change made outside the server's routes waits up to this long.
 */
export const RIGHT_TTL_MS = 5_000;
/** How long the gate waits for the server to answer an update it forwarded (it always does, or closes). */
const ACK_MS = 30_000;
/** How long a stop waits for the live documents to save and unload before it stops writing. */
const CLOSE_MS = 10_000;

/** Close codes of a connection the server drops. */
const CLOSE = {
  sessionEnded: [4401, "session-ended"],
  revoked: [4403, "access-revoked"],
  readOnly: [4409, "reconnect-read-only"],
  malformed: [4400, "malformed-message"],
  // The client contract for 4413 and 4412: the local document diverged from the server's (an update of it
  // was rejected), so the client drops its local document and loads the page again from the server.
  tooLarge: [4413, "content-too-large"],
  outOfSync: [4412, "out-of-sync"],
} as const satisfies Record<string, readonly [number, string]>;

export interface WikiLive {
  /** A version was saved outside the live session (API, agent, restore). */
  pageSaved(row: WikiRow): void;
  /** The page went to the trash or was deleted: closes the session without publishing. */
  pageClosed(row: Pick<WikiRow, "workspaceId" | "slug">): void;
  /**
   * The page's access changed (lock, unlock): its connections are checked again now; a member on a locked
   * page is closed (it reconnects read only) and a read-only one on an unlocked page reconnects to write.
   */
  recheckPage(row: Pick<WikiRow, "workspaceId" | "slug">): Promise<void>;
  /** A person's membership or role changed: their connections in the workspace are checked again now. */
  recheckUser(workspaceId: string, userId: string): Promise<void>;
  /** A sign-in session ended (sign-out, revoked): its connections close now. */
  sessionEnded(sessionId: string): void;
  /** Publishes the draft now (the button). `force` goes over a newer version (conflict). */
  publish(row: WikiRow, by: Author, opts?: { force?: boolean; canBypassLock?: boolean }): Promise<WikiRow>;
  /** Throws the draft away: the session goes back to the published version. */
  discard(row: WikiRow, by: ActorRef, canBypassLock: boolean): Promise<void>;
  /** Waits for the queued work (tests and shutdown). */
  settled(): Promise<void>;
  /** Pages held in memory now (a live document with its session). */
  loaded(): number;
  close(): Promise<void>;
}

/** The wiki socket's data, filled in at the upgrade. */
export interface CollabSocketData {
  kind: "wiki";
  workspaceId: string;
  userId: string;
  name: string;
  /** The sign-in session that opened the socket: it must stay valid for the socket to stay open. */
  sessionId: string;
  /** When that session expires (ms): checked against the clock on every message, without the database. */
  sessionExpiresAt: number;
  req: Request;
  peer?: Peer;
  conn?: ReturnType<Hocuspocus["handleConnection"]>;
}

interface Ctx {
  workspaceId: string;
  userId: string;
  name: string;
  peer: Peer;
}

interface Session {
  pageId: string;
  workspaceId: string;
  parentVersion: number;
  /** Body of the parent version: the reference of the text-preserving serialization and of the merge. */
  baseBody: string;
  dirty: boolean;
  /** Counts the people's changes: whoever publishes knows whether someone typed while the version was saved. */
  edits: number;
  editors: ActorRef[];
  editedAt: Date | null;
  /** A newer version that couldn't be merged into the draft (the changes cross). */
  conflictVersion: number | null;
  closed: boolean;
  idle?: ReturnType<typeof setTimeout>;
  agentPresence?: ReturnType<typeof setTimeout>;
}

/** Why a draft save was rejected: nothing is written and the session closes without publishing. */
class DraftRejected extends Error {
  constructor(readonly reason: "gone" | "too_large") {
    super(`draft rejected: ${reason}`);
  }
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// ---- The wire format of a Hocuspocus message: varString(document key), varUint(type), then the payload.

const MSG_SYNC = 0;
const MSG_SYNC_REPLY = 4;
const MSG_CLOSE = 7;
const MSG_SYNC_STATUS = 8;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

/** A lib0 varUint at `at` and the position after it, or null past the end. */
function varUint(bytes: Uint8Array, at: number): [number, number] | null {
  let num = 0;
  let mult = 1;
  for (let i = at; i < bytes.length && i < at + 8; i++) {
    const b = bytes[i] ?? 0;
    num += (b & 0x7f) * mult;
    mult *= 128;
    if (b < 0x80) return [num, i + 1];
  }
  return null;
}

interface Head {
  rawKey: string;
  documentName: string;
  type: number;
  /** For a sync message that carries a document update (step 2 or update): the Yjs update. */
  update: Uint8Array | null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The message's head; null when it doesn't parse (a malformed message). */
function parseHead(bytes: Uint8Array): Head | null {
  const len = varUint(bytes, 0);
  if (!len || len[1] + len[0] > bytes.length) return null;
  let rawKey: string;
  try {
    rawKey = utf8.decode(bytes.subarray(len[1], len[1] + len[0]));
  } catch {
    return null;
  }
  const type = varUint(bytes, len[1] + len[0]);
  if (!type) return null;
  const sep = rawKey.indexOf("\0");
  const head: Head = {
    rawKey,
    documentName: sep < 0 ? rawKey : rawKey.slice(0, sep),
    type: type[0],
    update: null,
  };
  if (head.type === MSG_SYNC || head.type === MSG_SYNC_REPLY) {
    const sync = varUint(bytes, type[1]);
    if (!sync) return null;
    if (sync[0] === SYNC_STEP2 || sync[0] === SYNC_UPDATE) {
      const size = varUint(bytes, sync[1]);
      if (!size || size[1] + size[0] > bytes.length) return null;
      head.update = bytes.subarray(size[1], size[1] + size[0]);
    }
  }
  return head;
}

/** The SyncStatus a server answers to an update (false: rejected, nothing was applied). */
function syncStatus(rawKey: string, applied: boolean): Uint8Array {
  const key = new TextEncoder().encode(rawKey);
  const out: number[] = [];
  for (let n = key.length; ; ) {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
    if (!n) break;
  }
  return new Uint8Array([...out, ...key, MSG_SYNC_STATUS, applied ? 1 : 0]);
}

/**
 * A stable color per person. It stays away from the product's role colors: blue is an agent, amber is
 * "waiting for you", green is done and red is failed.
 */
function colorFor(id: string): string {
  const palette = ["#862e9c", "#c2255c", "#5f3dc4", "#0b7285", "#a61e4d", "#6b4f3a", "#495057"];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length] as string;
}

/** Checks origin, session and membership before opening the socket (the same rule as the realtime socket). */
export async function checkCollabUpgrade(
  deps: AppDeps,
  req: Request,
  trustedOrigins: string[],
): Promise<{ ok: true; data: CollabSocketData } | { ok: false; response: Response }> {
  const fail = (status: number, code: string, message: string) => ({
    ok: false as const,
    response: Response.json(errorBody(code, message), { status }),
  });
  const origin = req.headers.get("origin");
  if (origin && !trustedOrigins.includes(origin)) return fail(403, "forbidden", "Origin not allowed");
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  if (!workspaceId) return fail(400, "invalid_request", "Missing workspaceId");
  const session = await deps.auth.api.getSession({ headers: req.headers });
  if (!session) return fail(401, "unauthorized", "Sign in to continue");
  const [m] = await deps.db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, session.user.id)));
  if (!m) return fail(404, "not_found", "Workspace not found");
  return {
    ok: true,
    data: {
      kind: "wiki",
      workspaceId,
      userId: session.user.id,
      name: session.user.name,
      sessionId: session.session.id,
      sessionExpiresAt: new Date(session.session.expiresAt).getTime(),
      req,
    },
  };
}

type Verdict = "ok" | "revoked" | "session_ended" | "read_only";

/**
 * One socket: the gate every message to it and from it waits at. Messages queue in order; before a batch
 * goes out or in, the connection's right is read again (`verdict`); a connection that lost it is closed and
 * its queue dropped.
 */
export class Peer {
  /** Documents this socket authenticated to, and whether it got them read only. */
  readonly docs = new Map<string, { slug: string; readOnly: boolean }>();
  private readonly out: Uint8Array[] = [];
  private readonly in: Uint8Array[] = [];
  private pumping = false;
  closed = false;
  /** When this connection's right was last read from the database (ms, by the injected clock). */
  rightReadAt: number | null = null;
  /** Waiters for the server's SyncStatus on a document key (the answer to a forwarded update). */
  readonly acks = new Map<string, () => void>();
  /** What Hocuspocus sees as the socket: its sends go through the gate. */
  readonly socket: {
    readonly readyState: number;
    send(bytes: Uint8Array): void;
    close(code?: number, reason?: string): void;
  };

  constructor(
    readonly data: CollabSocketData,
    private readonly ws: Bun.ServerWebSocket<CollabSocketData>,
    private readonly hooks: {
      verdict: (p: Peer) => Promise<Verdict>;
      deliver: (p: Peer, bytes: Uint8Array) => Promise<void>;
    },
  ) {
    this.socket = {
      get readyState() {
        return ws.readyState;
      },
      send: (bytes) => this.send(bytes),
      close: (code, reason) => ws.close(code, reason),
    };
  }

  send(bytes: Uint8Array) {
    if (this.closed) return;
    const head = bytes.length > 1 ? parseHead(bytes) : null;
    if (head?.type === MSG_SYNC_STATUS) this.acks.get(head.rawKey)?.();
    // The server closed this document's connection (an error in one of its messages): the socket is no
    // longer authenticated to it, and an update waiting for its answer won't get one.
    if (head?.type === MSG_CLOSE) {
      this.docs.delete(head.documentName);
      this.acks.get(head.rawKey)?.();
    }
    this.out.push(bytes);
    void this.pump();
  }

  receive(bytes: Uint8Array) {
    if (this.closed) return;
    this.in.push(bytes);
    void this.pump();
  }

  /** Sends now, past the queue: only an answer to a message of this connection, right after its verdict. */
  sendNow(bytes: Uint8Array) {
    if (!this.closed) this.ws.send(bytes);
  }

  close([code, reason]: readonly [number, string]) {
    if (this.closed) return;
    this.ended();
    this.ws.close(code, reason);
  }

  /** The socket closed (or is closing): nothing more goes out or in. */
  ended() {
    this.closed = true;
    this.out.length = 0;
    this.in.length = 0;
    for (const release of [...this.acks.values()]) release();
    this.acks.clear();
  }

  /** Closes the connection for a verdict other than ok; true when it is still open. */
  apply(verdict: Verdict): boolean {
    if (verdict === "ok") return true;
    this.close(
      verdict === "session_ended"
        ? CLOSE.sessionEnded
        : verdict === "read_only"
          ? CLOSE.readOnly
          : CLOSE.revoked,
    );
    return false;
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && (this.out.length || this.in.length)) {
        const outs = this.out.splice(0);
        const ins = this.in.splice(0);
        if (!this.apply(await this.hooks.verdict(this))) return;
        for (const bytes of outs) this.ws.send(bytes);
        for (const bytes of ins) {
          if (this.closed) return;
          await this.hooks.deliver(this, bytes);
        }
      }
    } catch (err) {
      log.error("wiki.peer_failed", { err });
      this.close(CLOSE.revoked);
    } finally {
      this.pumping = false;
    }
  }
}

export function createWikiCollab(
  getDeps: () => AppDeps,
  opts: { idlePublishMs?: number; debounceMs?: number } = {},
) {
  const idleMs = opts.idlePublishMs ?? 5 * 60_000;
  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<unknown>>();
  const peers = new Set<Peer>();
  /** Per document: updates are checked and applied one at a time, so the size check sees the real state. */
  const applying = new Map<string, Promise<unknown>>();
  /** Updates waiting for their document to load. */
  const loading = new Map<string, Set<(s: Session | null) => void>>();
  /** Set once a stop finished: nothing reads or writes the database after it. */
  let stopped = false;
  let md: WikiMarkdown | null = null;
  const markdown = async () => {
    md ??= await wikiMarkdown();
    return md;
  };

  /** One thing at a time per page: an API write, a publish and a load don't cross. */
  function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const run = () => (stopped ? Promise.reject(new Error("wiki live session stopped")) : job());
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  }

  function oneAtATime<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = applying.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    applying.set(key, tail);
    void tail.then(() => {
      if (applying.get(key) === tail) applying.delete(key);
    });
    return next;
  }

  // ---- Who may stay connected, and who may have their edits saved.

  /** Right reads in flight: a stop waits for them, and none starts once it began. */
  const reading = new Set<Promise<Verdict>>();
  let closing = false;

  function verdict(p: Peer, opts: { force?: boolean } = {}): Promise<Verdict> {
    if (closing || stopped) return Promise.resolve("revoked");
    const job = readRight(p, opts);
    reading.add(job);
    void job.finally(() => reading.delete(job)).catch(() => undefined);
    return job;
  }

  async function readRight(p: Peer, opts: { force?: boolean }): Promise<Verdict> {
    const { db, now } = getDeps();
    const at = now().getTime();
    const fresh = p.rightReadAt !== null && at - p.rightReadAt < RIGHT_TTL_MS;
    if (!opts.force && fresh && at < p.data.sessionExpiresAt) return "ok";
    const { workspaceId, userId, sessionId } = p.data;
    const [sess] = await db
      .select({ expiresAt: authSessions.expiresAt })
      .from(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)));
    if (closing) return "revoked";
    if (!sess || sess.expiresAt.getTime() <= at) return "session_ended";
    // The session may have been extended since the upgrade: the clock checks against the stored expiry.
    p.data.sessionExpiresAt = sess.expiresAt.getTime();
    const [m] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
    if (closing || !m) return "revoked";
    if (!p.docs.size) {
      p.rightReadAt = at;
      return "ok";
    }
    const slugs = [...p.docs.values()].map((d) => d.slug);
    const pages = await db
      .select({
        slug: knowledgePages.slug,
        locked: knowledgePages.locked,
        deletedAt: knowledgePages.deletedAt,
      })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.workspaceId, workspaceId), inArray(knowledgePages.slug, slugs)));
    if (closing) return "revoked";
    for (const doc of p.docs.values()) {
      const page = pages.find((x) => x.slug === doc.slug);
      if (!page || page.deletedAt) return "revoked";
      if (page.locked && !doc.readOnly && !can(m.role, "configure")) return "read_only";
    }
    p.rightReadAt = at;
    return "ok";
  }

  async function versionBody(pageId: string, version: number, current: WikiRow): Promise<string> {
    if (version === current.version) return current.body;
    const [v] = await getDeps()
      .db.select({ body: pageRevisions.body })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.version, version)));
    return v?.body ?? current.body;
  }

  /** The page's markdown the document holds now (what a publish would save). */
  async function textOf(s: Session, doc: Y.Doc) {
    const m = await markdown();
    return m.serializePreserving(m.fromYDoc(doc), s.baseBody);
  }

  /**
   * Saves the draft: everything the session accepted while each editor had the right is legitimate and is
   * kept, like an HTTP save made a second before a removal. The page is read locked in the same transaction
   * (it must exist outside the trash); `extra` adds the check of whoever asked for this save (discard).
   */
  async function persist(s: Session, doc: Y.Doc, extra?: (tx: Tx, page: WikiRow) => Promise<void>) {
    if (stopped) throw new Error("wiki live session stopped");
    if ((await textOf(s, doc)).length > MAX_BODY) throw new DraftRejected("too_large");
    const deps = getDeps();
    const values = {
      state: b64(Y.encodeStateAsUpdate(doc)),
      parentVersion: s.parentVersion,
      dirty: s.dirty,
      editors: s.editors,
      editedAt: s.editedAt,
      updatedAt: deps.now(),
    };
    await writeTx(deps.db, async (tx) => {
      const page = await pageLock.row(tx, s.pageId);
      if (!page || page.deletedAt) throw new DraftRejected("gone");
      await extra?.(tx, page);
      await tx
        .insert(wikiPageDocs)
        .values({ pageId: s.pageId, ...values })
        .onConflictDoUpdate({ target: wikiPageDocs.pageId, set: values });
    });
  }

  /** A draft that can't be saved: the session closes without publishing and its memory is let go. */
  function abandon(name: string, s: Session, err: unknown) {
    log.warn("wiki.draft_rejected", { err, pageId: s.pageId });
    s.closed = true;
    clearTimeout(s.idle);
    hocuspocus.closeConnections(name);
  }

  async function freshPage(s: Session): Promise<WikiRow | null> {
    const [row] = await getDeps().db.select().from(knowledgePages).where(eq(knowledgePages.id, s.pageId));
    return row && !row.deletedAt ? row : null;
  }

  /**
   * Brings version `row` into the document. Without a draft it becomes the version. With a draft, a
   * three-way merge; if the changes cross (or the merge would pass MAX_BODY), nothing changes and the
   * conflict is marked. Returns the block where the change began (for the agent's presence) or null.
   */
  async function reconcile(s: Session, doc: Y.Doc, row: WikiRow): Promise<number | null> {
    if (row.version <= s.parentVersion) return null;
    const m = await markdown();
    const before = m.fromYDoc(doc);
    const current = m.serializePreserving(before, s.baseBody);
    let target = row.body;
    if (s.dirty && current !== s.baseBody) {
      const merged = merge3(s.baseBody, current, row.body);
      if (!merged.ok || merged.text.length > MAX_BODY) {
        s.conflictVersion = row.version;
        return null;
      }
      target = merged.text;
    }
    m.replaceYContent(doc, target, "wiki-server");
    s.parentVersion = row.version;
    s.baseBody = row.body;
    s.dirty = target !== row.body;
    s.conflictVersion = null;
    if (!s.dirty) s.editors = [];
    const after = m.fromYDoc(doc);
    for (let i = 0; i < after.childCount; i++)
      if (i >= before.childCount || !after.child(i).eq(before.child(i))) return i;
    return null;
  }

  function broadcast(name: string, payload: Record<string, unknown>) {
    hocuspocus.documents.get(name)?.broadcastStateless(JSON.stringify(payload));
  }

  /** The blue ghost: the agent's presence on the block it changed, for a few seconds. */
  async function agentPresence(
    name: string,
    s: Session,
    document: Document,
    author: ActorRef,
    block: number,
  ) {
    const [agent] = await getDeps()
      .db.select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, author.id));
    const el = document.getXmlFragment(YFRAGMENT).get(block);
    const at = el instanceof Y.XmlElement ? Y.createRelativePositionFromTypeIndex(el, 0) : null;
    document.awareness.setLocalState({
      user: { id: author.id, name: agent?.name ?? "Agent", color: AGENT_COLOR, kind: "agent" },
      ...(at ? { cursor: { anchor: Y.relativePositionToJSON(at), head: Y.relativePositionToJSON(at) } } : {}),
    });
    clearTimeout(s.agentPresence);
    s.agentPresence = setTimeout(() => {
      if (hocuspocus.documents.get(name) === document) document.awareness.setLocalState(null);
    }, AGENT_PRESENCE_MS);
  }

  /**
   * Publishes the document as a version. The save's transaction reads the page locked (savePage): it must
   * exist outside the trash and, if locked, someone who decides the lock must be an admin there. The button's
   * publisher is the person who asked; the automatic publish credits whoever edited last, and its lock is
   * decided by the session's editors (an admin among them, by the role read in the transaction).
   */
  async function publishSession(
    name: string,
    s: Session,
    doc: Y.Doc,
    by: Author,
    note: string,
    opts: { force?: boolean; canBypassLock?: boolean; origin?: SaveOrigin; automatic?: boolean },
  ): Promise<WikiRow | null> {
    const deps = getDeps();
    const page = await freshPage(s);
    if (!page) return null;
    const seen = s.edits;
    const text = await textOf(s, doc);
    if (text.length > MAX_BODY) throw new HttpError(400, "wiki.too_large", "The page is too long");
    if (s.parentVersion !== page.version && !opts.force)
      throw new HttpError(409, "wiki.stale_draft", "Someone saved a newer version", {
        currentVersion: page.version,
      });
    const deciders: ActorRef[] = opts.automatic ? s.editors : [by];
    if (text === page.body) {
      // Nothing to publish, but the draft is saved clean: by someone who may write the page, checked in the
      // save's transaction; only once it committed does the session take the new state.
      const clean = {
        dirty: false,
        editors: [],
        parentVersion: page.version,
        baseBody: page.body,
        conflictVersion: null,
      };
      await persist({ ...s, ...clean }, doc, async (tx, locked) => {
        if (locked.locked && !(opts.canBypassLock && (await anyBypasses(tx, locked.workspaceId, deciders))))
          throw new HttpError(403, "wiki.page_locked", "This page is locked");
      });
      Object.assign(s, clean);
      return page;
    }
    const saved = await savePage(deps, {
      row: page,
      author: by,
      canBypassLock: opts.canBypassLock ?? false,
      parentVersion: page.version,
      body: text,
      note,
      origin: "live",
      attributionOnly: opts.automatic === true,
      lockBypassBy: deciders,
    });
    s.parentVersion = saved.version;
    s.baseBody = saved.body;
    // What was typed while saving didn't go into the version: the draft stays dirty, with who edited, and
    // goes out on the next publish (or into the merge of a version that comes from outside).
    s.dirty = s.edits !== seen;
    if (!s.dirty) s.editors = [];
    s.conflictVersion = null;
    await persist(s, doc);
    broadcast(name, { type: "published", version: saved.version });
    return saved;
  }

  /** Automatic publish (quiet or end of the session): the author is whoever edited last. */
  async function autoPublish(name: string, s: Session, doc: Y.Doc, note: string) {
    if (!s.dirty || s.closed || s.conflictVersion !== null) return;
    const author = s.editors.at(-1);
    if (!author) return;
    const others = s.editors.length - 1;
    try {
      await publishSession(name, s, doc, author, others > 0 ? `${note} +${others}` : note, {
        // The role is read again in the save's transaction (savePage); this is only the ceiling.
        canBypassLock: true,
        automatic: true,
      });
    } catch (err) {
      // Conflict or lock: the draft stays saved and the page shows the notice.
      log.warn("wiki.autopublish_skipped", { err, pageId: s.pageId });
    }
  }

  function armIdle(name: string, s: Session, doc: Y.Doc) {
    clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      void serial(s.pageId, () => autoPublish(name, s, doc, "idle")).catch(() => undefined);
    }, idleMs);
  }

  const hocuspocus = new Hocuspocus<Ctx>({
    name: "wiki",
    debounce: opts.debounceMs ?? 2000,
    maxDebounce: 10_000,
    quiet: true,
    async onAuthenticate({ documentName, context, connectionConfig }) {
      const [kind, workspaceId, slug, ...rest] = documentName.split("/");
      if (kind !== "wiki" || !workspaceId || !slug || rest.length || workspaceId !== context.workspaceId)
        throw new Error("forbidden");
      const deps = getDeps();
      const [m] = await deps.db
        .select({ role: members.role })
        .from(members)
        .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, context.userId)));
      if (!m) throw new Error("forbidden");
      const page = await pageBySlug(deps.db, workspaceId, slug).catch(() => null);
      if (!page) throw new Error("not_found");
      if (page.locked && !can(m.role, "configure")) connectionConfig.readOnly = true;
      context.peer.docs.set(documentName, { slug, readOnly: connectionConfig.readOnly });
    },
    async onLoadDocument({ document, documentName }) {
      const [, workspaceId = "", slug = ""] = documentName.split("/");
      const deps = getDeps();
      const page = await pageBySlug(deps.db, workspaceId, slug);
      return serial(page.id, async () => {
        const [saved] = await deps.db.select().from(wikiPageDocs).where(eq(wikiPageDocs.pageId, page.id));
        const s: Session = {
          pageId: page.id,
          workspaceId,
          parentVersion: page.version,
          baseBody: page.body,
          dirty: false,
          edits: 0,
          editors: [],
          editedAt: null,
          conflictVersion: null,
          closed: false,
        };
        if (saved) {
          Y.applyUpdate(document, unb64(saved.state));
          Object.assign(s, {
            parentVersion: saved.parentVersion,
            baseBody: await versionBody(page.id, saved.parentVersion, page),
            dirty: saved.dirty,
            editors: saved.editors,
            editedAt: saved.editedAt,
          });
          await reconcile(s, document, page);
        } else {
          // The page's first session: seed it from the markdown and save it at once, so whoever reconnects
          // later merges with the same history (and doesn't duplicate the text).
          const m = await markdown();
          Y.applyUpdate(document, Y.encodeStateAsUpdate(m.toYDoc(page.body)));
        }
        await persist(s, document);
        sessions.set(documentName, s);
        for (const done of [...(loading.get(documentName) ?? [])]) done(s);
        loading.delete(documentName);
        return document;
      });
    },
    async beforeHandleAwareness({ states, context, connection }) {
      // Presence is declared by the client: the server stamps who it is (nobody passes for another person
      // or for the agent).
      if (!connection || !context) return;
      for (const [id, state] of states) {
        if (!state || typeof state !== "object") {
          states.delete(id);
          continue;
        }
        states.set(id, {
          ...(state.cursor ? { cursor: state.cursor } : {}),
          user: { id: context.userId, name: context.name, color: colorFor(context.userId), kind: "person" },
        });
      }
    },
    async onChange({ documentName, connection, context }) {
      if (!connection || !context?.userId) return;
      const s = sessions.get(documentName);
      const document = hocuspocus.documents.get(documentName);
      if (!s || !document) return;
      s.dirty = true;
      s.edits++;
      s.editedAt = getDeps().now();
      s.editors = [
        ...s.editors.filter((e) => e.id !== context.userId),
        { type: "person", id: context.userId },
      ];
      armIdle(documentName, s, document);
    },
    async onStoreDocument({ documentName, document }) {
      const s = sessions.get(documentName);
      if (!s || s.closed) return;
      await serial(s.pageId, () => persist(s, document)).catch((err) => {
        if (err instanceof DraftRejected) abandon(documentName, s, err);
        else log.error("wiki.draft_save_failed", { err, pageId: s.pageId });
      });
    },
    async beforeUnloadDocument({ documentName, document }) {
      const s = sessions.get(documentName);
      if (!s) return;
      clearTimeout(s.idle);
      clearTimeout(s.agentPresence);
      // End of the session: the draft becomes a version. An error here can't hold the document in memory.
      await serial(s.pageId, () => autoPublish(documentName, s, document, "session")).catch((err) =>
        log.warn("wiki.session_publish_failed", { err, pageId: s.pageId }),
      );
    },
    async afterUnloadDocument({ documentName }) {
      sessions.delete(documentName);
    },
  });

  /**
   * A message from a socket that passed its gate. An update to a document is checked against the document
   * as it is (one update per document at a time, until the server acknowledges it): an invalid one closes
   * the connection; one that would take the page past MAX_BODY is answered with SyncStatus false and
   * dropped.
   */
  async function deliver(p: Peer, bytes: Uint8Array) {
    const conn = p.data.conn;
    if (!conn) return;
    if (bytes.byteLength > MAX_UPDATE) return p.close(CLOSE.tooLarge);
    // A ping or pong is one byte; Hocuspocus answers it.
    if (bytes.length === 1) return conn.handleMessage(bytes);
    const head = parseHead(bytes);
    if (!head) return p.close(CLOSE.malformed);
    const doc = p.docs.get(head.documentName);
    if (!head.update) return conn.handleMessage(bytes);
    // An update for a document this socket hasn't authenticated to is dropped: Hocuspocus would queue it and
    // apply it after the authentication, past the checks below.
    if (!doc) return;
    if (doc.readOnly) return conn.handleMessage(bytes);
    const update = head.update;
    await oneAtATime(head.documentName, async () => {
      if (p.closed || !p.apply(await verdict(p))) return;
      const s = await whenLoaded(head.documentName);
      const document = hocuspocus.documents.get(head.documentName);
      if (!s || !document) return p.close(CLOSE.revoked);
      const size = await sizeAfter(s, document, update);
      if (size === null) return p.close(CLOSE.malformed);
      // Rejected: the client's document now differs from the server's and every later update of it depends
      // on this one, so the connection closes after the rejection instead of acknowledging what can't apply.
      if (size > MAX_BODY) {
        p.sendNow(syncStatus(head.rawKey, false));
        return p.close(CLOSE.tooLarge);
      }
      const pendingBefore = hasPending(document);
      const acked = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ACK_MS);
        p.acks.set(head.rawKey, () => {
          clearTimeout(timer);
          p.acks.delete(head.rawKey);
          resolve();
        });
      });
      conn.handleMessage(bytes);
      await acked;
      // An update that depends on something the server never got stays pending: it was not applied, so the
      // positive answer still in this connection's queue is dropped with the connection, after a negative one.
      if (!pendingBefore && hasPending(document)) {
        p.sendNow(syncStatus(head.rawKey, false));
        p.close(CLOSE.outOfSync);
      }
    });
  }

  /** Whether the document holds updates Yjs couldn't apply yet (they miss what they depend on). */
  const hasPending = (doc: Y.Doc) => doc.store.pendingStructs !== null || doc.store.pendingDs !== null;

  /** The document's session once it loaded (an update waits for it, to be checked against it); null if it didn't. */
  function whenLoaded(name: string): Promise<Session | null> {
    const s = sessions.get(name);
    if (s) return Promise.resolve(s);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ACK_MS);
      const done = (value: Session | null) => {
        clearTimeout(timer);
        loading.get(name)?.delete(done);
        resolve(value);
      };
      const waiting = loading.get(name) ?? new Set();
      waiting.add(done);
      loading.set(name, waiting);
    });
  }

  /** The page's length once `update` is applied to a copy of the document; null for an invalid update. */
  async function sizeAfter(s: Session, document: Y.Doc, update: Uint8Array): Promise<number | null> {
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
      Y.applyUpdate(probe, update);
      return (await textOf(s, probe)).length;
    } catch {
      return null;
    } finally {
      probe.destroy();
    }
  }

  /** Opens the loaded document (or the saved one) for a change made by the server. */
  async function withDocument<T>(
    row: Pick<WikiRow, "id" | "workspaceId" | "slug">,
    fn: (s: Session, doc: Y.Doc, live: Document | null) => Promise<T>,
    opts: { persist?: boolean } = {},
  ): Promise<T | null> {
    const save = opts.persist ?? true;
    const name = docName(row.workspaceId, row.slug);
    const loaded = hocuspocus.documents.get(name);
    const s = sessions.get(name);
    if (loaded && s) {
      const result = await fn(s, loaded, loaded);
      if (save)
        await persist(s, loaded).catch((err) => {
          if (err instanceof DraftRejected) abandon(name, s, err);
          throw err;
        });
      return result;
    }
    // No open session: works on the saved state, if the page already had a session.
    const deps = getDeps();
    const [saved] = await deps.db.select().from(wikiPageDocs).where(eq(wikiPageDocs.pageId, row.id));
    if (!saved) return null;
    const [page] = await deps.db.select().from(knowledgePages).where(eq(knowledgePages.id, row.id));
    if (!page) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, unb64(saved.state));
    const offline: Session = {
      pageId: row.id,
      workspaceId: row.workspaceId,
      parentVersion: saved.parentVersion,
      baseBody: await versionBody(row.id, saved.parentVersion, page),
      dirty: saved.dirty,
      edits: 0,
      editors: saved.editors,
      editedAt: saved.editedAt,
      conflictVersion: null,
      closed: false,
    };
    try {
      const result = await fn(offline, doc, null);
      if (save) await persist(offline, doc);
      return result;
    } finally {
      doc.destroy();
    }
  }

  /** Checks a socket's right now, outside a message: closes it, or makes a read-only one reconnect to write. */
  async function recheck(p: Peer, slug?: string) {
    if (p.closed || !p.apply(await verdict(p, { force: true }))) return;
    if (!slug) return;
    const doc = [...p.docs.values()].find((d) => d.slug === slug);
    if (!doc?.readOnly) return;
    const [page] = await getDeps()
      .db.select({ locked: knowledgePages.locked })
      .from(knowledgePages)
      .where(and(eq(knowledgePages.workspaceId, p.data.workspaceId), eq(knowledgePages.slug, slug)));
    if (page && !page.locked) p.close(CLOSE.readOnly);
  }

  const toHttp = (err: unknown) => {
    if (err instanceof DraftRejected)
      return err.reason === "too_large"
        ? new HttpError(400, "wiki.too_large", "The page is too long")
        : notFound("Page not found");
    return err;
  };

  const live: WikiLive = {
    pageSaved(row) {
      void serial(row.id, () =>
        withDocument(row, async (s, doc, document) => {
          const block = await reconcile(s, doc, row);
          const name = docName(row.workspaceId, row.slug);
          if (s.conflictVersion !== null) broadcast(name, { type: "conflict", version: s.conflictVersion });
          else broadcast(name, { type: "published", version: row.version });
          if (document && block !== null && row.updatedBy.type === "agent")
            await agentPresence(name, s, document, row.updatedBy, block);
        }),
      ).catch((err) => log.error("wiki.live_save_failed", { err, pageId: row.id }));
    },
    pageClosed(row) {
      const name = docName(row.workspaceId, row.slug);
      const s = sessions.get(name);
      if (s) {
        s.closed = true;
        clearTimeout(s.idle);
      }
      hocuspocus.closeConnections(name);
    },
    async recheckPage(row) {
      const name = docName(row.workspaceId, row.slug);
      await Promise.all([...peers].filter((p) => p.docs.has(name)).map((p) => recheck(p, row.slug)));
    },
    async recheckUser(workspaceId, userId) {
      await Promise.all(
        [...peers]
          .filter((p) => p.data.workspaceId === workspaceId && p.data.userId === userId)
          .map((p) => recheck(p)),
      );
    },
    sessionEnded(sessionId) {
      for (const p of peers) if (p.data.sessionId === sessionId) p.close(CLOSE.sessionEnded);
    },
    async publish(row, by, opts = {}) {
      const saved = await serial(row.id, () =>
        withDocument(row, (s, doc) =>
          s.dirty || opts.force
            ? publishSession(docName(row.workspaceId, row.slug), s, doc, by, "publish", opts)
            : Promise.resolve(null),
        ),
      ).catch((err) => {
        throw toHttp(err);
      });
      return saved ?? row;
    },
    async discard(row, by, canBypassLock) {
      await serial(row.id, () =>
        withDocument(
          row,
          async (s, doc) => {
            // The reset is built on a copy and saved under the transaction that authorizes it (the lock, by
            // the role read there); only once that committed does the shared document change and hear of it.
            const m = await markdown();
            const copy = new Y.Doc();
            try {
              Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
              m.replaceYContent(copy, row.body, "wiki-server");
              const reset = {
                parentVersion: row.version,
                baseBody: row.body,
                dirty: false,
                editors: [],
                conflictVersion: null,
              };
              await persist({ ...s, ...reset }, copy, async (tx, page) => {
                if (page.locked && !(canBypassLock && (await bypassesLock(tx, page.workspaceId, by))))
                  throw new HttpError(403, "wiki.page_locked", "This page is locked");
              });
              m.replaceYContent(doc, row.body, "wiki-server");
              Object.assign(s, reset);
            } finally {
              copy.destroy();
            }
            clearTimeout(s.idle);
            broadcast(docName(row.workspaceId, row.slug), { type: "discarded", version: row.version });
          },
          { persist: false },
        ),
      ).catch((err) => {
        throw toHttp(err);
      });
    },
    async settled() {
      while (queues.size || applying.size) await Promise.all([...queues.values(), ...applying.values()]);
    },
    loaded() {
      return hocuspocus.documents.size;
    },
    async close() {
      if (stopped) return;
      // No new right read starts; the ones in flight, the draft saves and the publishes are waited for (the
      // database closes right after), the sessions saving their drafts on the way out.
      closing = true;
      hocuspocus.closeConnections();
      for (const p of peers) p.close(CLOSE.revoked);
      let warned = false;
      const end = Date.now() + CLOSE_MS;
      while (hocuspocus.documents.size || queues.size || applying.size || reading.size) {
        await Promise.allSettled([...queues.values(), ...applying.values(), ...reading.values()]);
        if (!warned && Date.now() > end) {
          warned = true;
          log.error("wiki.close_slow", { documents: hocuspocus.documents.size, queues: queues.size });
        }
        await Bun.sleep(10);
      }
      // From here nothing touches the database: a late job is dropped.
      stopped = true;
    },
  };

  const socket = {
    open(ws: Bun.ServerWebSocket<CollabSocketData>) {
      const peer = new Peer(ws.data, ws, { verdict, deliver });
      ws.data.peer = peer;
      peers.add(peer);
      const { workspaceId, userId, name } = ws.data;
      ws.data.conn = hocuspocus.handleConnection(peer.socket as never, ws.data.req, {
        workspaceId,
        userId,
        name,
        peer,
      });
    },
    message(ws: Bun.ServerWebSocket<CollabSocketData>, raw: string | Buffer) {
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
      ws.data.peer?.receive(bytes);
    },
    close(ws: Bun.ServerWebSocket<CollabSocketData>, code: number, reason: string) {
      const peer = ws.data.peer;
      if (peer) {
        peer.ended();
        peers.delete(peer);
      }
      ws.data.conn?.handleClose({ code, reason });
    },
  };

  return { live, socket };
}
