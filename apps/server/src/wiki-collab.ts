// The wiki's live session: Hocuspocus (Yjs) inside Bun.serve, at /api/v1/wiki/collab?workspaceId=. One
// document per page (`wiki/<workspace>/<slug>`). The Yjs state is the draft: it lives in wiki_page_docs
// (debounced autosave) and becomes a version on publish (the button), after 5 min without an edit or when
// the last person leaves. A write through the API (agent, another tab, restore) enters the session with the
// smallest change; with a dirty draft it merges three ways against the parent version (parentVersion) and,
// if the changes cross, the draft stays put with a conflict notice.

import { type Document, Hocuspocus } from "@hocuspocus/server";
import type { ActorRef } from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { merge3 } from "@vanr/engine/wiki/merge";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { AppDeps } from "./context";
import { errorBody, HttpError } from "./http";
import { log } from "./logger";
import { type Author, MAX_BODY, pageBySlug, type SaveOrigin, savePage, type WikiRow } from "./wiki";
import { wikiMarkdown, YFRAGMENT } from "./wiki-md";

const { knowledgePages, pageRevisions, wikiPageDocs, members, agents } = schema;

export const COLLAB_PATH = "/api/v1/wiki/collab";
const docName = (workspaceId: string, slug: string) => `wiki/${workspaceId}/${slug}`;
/** The largest Yjs message accepted from a client (the page body is capped at 500 thousand characters). */
export const MAX_UPDATE = 2 * 1024 * 1024;
const AGENT_PRESENCE_MS = 10_000;
const AGENT_COLOR = "#2f6fed";

export interface WikiLive {
  /** A version was saved outside the live session (API, agent, restore). */
  pageSaved(row: WikiRow): void;
  /** The page went to the trash or was deleted: closes the session without publishing. */
  pageClosed(row: Pick<WikiRow, "workspaceId" | "slug">): void;
  /** Permission changed (lock): drops the connections; the client reconnects and goes through the check. */
  reconnect(row: Pick<WikiRow, "workspaceId" | "slug">): void;
  /** Publishes the draft now (the button). `force` goes over a newer version (conflict). */
  publish(row: WikiRow, by: Author, opts?: { force?: boolean; canBypassLock?: boolean }): Promise<WikiRow>;
  /** Throws the draft away: the session goes back to the published version. */
  discard(row: WikiRow): Promise<void>;
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
  req: Request;
  conn?: ReturnType<Hocuspocus["handleConnection"]>;
}

interface Ctx {
  workspaceId: string;
  userId: string;
  name: string;
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

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

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
    data: { kind: "wiki", workspaceId, userId: session.user.id, name: session.user.name, req },
  };
}

export function createWikiCollab(
  getDeps: () => AppDeps,
  opts: { idlePublishMs?: number; debounceMs?: number } = {},
) {
  const idleMs = opts.idlePublishMs ?? 5 * 60_000;
  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<unknown>>();

  /** One thing at a time per page: an API write, a publish and a load don't cross. */
  function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return next;
  }

  async function versionBody(pageId: string, version: number, current: WikiRow): Promise<string> {
    if (version === current.version) return current.body;
    const [v] = await getDeps()
      .db.select({ body: pageRevisions.body })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.pageId, pageId), eq(pageRevisions.version, version)));
    return v?.body ?? current.body;
  }

  async function persist(s: Session, doc: Y.Doc) {
    const deps = getDeps();
    const values = {
      state: b64(Y.encodeStateAsUpdate(doc)),
      parentVersion: s.parentVersion,
      dirty: s.dirty,
      editors: s.editors,
      editedAt: s.editedAt,
      updatedAt: deps.now(),
    };
    await deps.db
      .insert(wikiPageDocs)
      .values({ pageId: s.pageId, ...values })
      .onConflictDoUpdate({ target: wikiPageDocs.pageId, set: values });
  }

  async function freshPage(s: Session): Promise<WikiRow | null> {
    const [row] = await getDeps().db.select().from(knowledgePages).where(eq(knowledgePages.id, s.pageId));
    return row && !row.deletedAt ? row : null;
  }

  /**
   * Brings version `row` into the document. Without a draft it becomes the version. With a draft, a
   * three-way merge; if the changes cross, nothing changes and the conflict is marked. Returns the block
   * where the change began (for the agent's presence) or null.
   */
  async function reconcile(s: Session, doc: Y.Doc, row: WikiRow): Promise<number | null> {
    if (row.version <= s.parentVersion) return null;
    const md = await wikiMarkdown();
    const before = md.fromYDoc(doc);
    const current = md.serializePreserving(before, s.baseBody);
    let target = row.body;
    if (s.dirty && current !== s.baseBody) {
      const merged = merge3(s.baseBody, current, row.body);
      if (!merged.ok) {
        s.conflictVersion = row.version;
        return null;
      }
      target = merged.text;
    }
    md.replaceYContent(doc, target, "wiki-server");
    s.parentVersion = row.version;
    s.baseBody = row.body;
    s.dirty = target !== row.body;
    s.conflictVersion = null;
    if (!s.dirty) s.editors = [];
    const after = md.fromYDoc(doc);
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

  async function publishSession(
    name: string,
    s: Session,
    doc: Y.Doc,
    by: Author,
    note: string,
    opts: { force?: boolean; canBypassLock?: boolean; origin?: SaveOrigin },
  ): Promise<WikiRow | null> {
    const deps = getDeps();
    const page = await freshPage(s);
    if (!page) return null;
    const md = await wikiMarkdown();
    const seen = s.edits;
    const text = md.serializePreserving(md.fromYDoc(doc), s.baseBody);
    if (text.length > MAX_BODY) throw new HttpError(400, "wiki.too_large", "The page is too long");
    if (s.parentVersion !== page.version && !opts.force)
      throw new HttpError(409, "wiki.stale_draft", "Someone saved a newer version", {
        currentVersion: page.version,
      });
    if (text === page.body) {
      s.dirty = false;
      s.editors = [];
      s.parentVersion = page.version;
      s.baseBody = page.body;
      s.conflictVersion = null;
      await persist(s, doc);
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

  async function canBypass(workspaceId: string, actor: ActorRef): Promise<boolean> {
    if (actor.type !== "person") return false;
    const [m] = await getDeps()
      .db.select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, actor.id)));
    return !!m && can(m.role, "configure");
  }

  /** Automatic publish (quiet or end of the session): the author is whoever edited last. */
  async function autoPublish(name: string, s: Session, doc: Y.Doc, note: string) {
    if (!s.dirty || s.closed || s.conflictVersion !== null) return;
    const author = s.editors.at(-1);
    if (!author) return;
    const others = s.editors.length - 1;
    try {
      await publishSession(name, s, doc, author, others > 0 ? `${note} +${others}` : note, {
        canBypassLock: await canBypass(s.workspaceId, author),
      });
    } catch (err) {
      // Conflict or lock: the draft stays saved and the page shows the notice.
      log.warn("wiki.autopublish_skipped", { err, pageId: s.pageId });
    }
  }

  function armIdle(name: string, s: Session, doc: Y.Doc) {
    clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      void serial(s.pageId, () => autoPublish(name, s, doc, "idle"));
    }, idleMs);
  }

  const hocuspocus = new Hocuspocus<Ctx>({
    name: "wiki",
    debounce: opts.debounceMs ?? 2000,
    maxDebounce: 10_000,
    quiet: true,
    async onAuthenticate({ documentName, context, connectionConfig }) {
      const [kind, workspaceId, slug] = documentName.split("/");
      if (kind !== "wiki" || !workspaceId || !slug || workspaceId !== context.workspaceId)
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
          const md = await wikiMarkdown();
          Y.applyUpdate(document, Y.encodeStateAsUpdate(md.toYDoc(page.body)));
        }
        await persist(s, document);
        sessions.set(documentName, s);
        return document;
      });
    },
    async beforeHandleMessage({ update }) {
      if (update.byteLength > MAX_UPDATE) throw new Error("update_too_large");
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
      await serial(s.pageId, () => persist(s, document));
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

  /** Opens the loaded document (or the saved one) for a change made by the server. */
  async function withDocument<T>(
    row: Pick<WikiRow, "id" | "workspaceId" | "slug">,
    fn: (s: Session, doc: Y.Doc, live: Document | null) => Promise<T>,
  ): Promise<T | null> {
    const name = docName(row.workspaceId, row.slug);
    const loaded = hocuspocus.documents.get(name);
    const s = sessions.get(name);
    if (loaded && s) {
      const result = await fn(s, loaded, loaded);
      await persist(s, loaded);
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
      await persist(offline, doc);
      return result;
    } finally {
      doc.destroy();
    }
  }

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
    reconnect(row) {
      hocuspocus.closeConnections(docName(row.workspaceId, row.slug));
    },
    async publish(row, by, opts = {}) {
      const saved = await serial(row.id, () =>
        withDocument(row, (s, doc) =>
          s.dirty || opts.force
            ? publishSession(docName(row.workspaceId, row.slug), s, doc, by, "publish", opts)
            : Promise.resolve(null),
        ),
      );
      return saved ?? row;
    },
    async discard(row) {
      await serial(row.id, () =>
        withDocument(row, async (s, doc) => {
          const md = await wikiMarkdown();
          md.replaceYContent(doc, row.body, "wiki-server");
          Object.assign(s, {
            parentVersion: row.version,
            baseBody: row.body,
            dirty: false,
            editors: [],
            conflictVersion: null,
          });
          clearTimeout(s.idle);
          broadcast(docName(row.workspaceId, row.slug), { type: "discarded", version: row.version });
        }),
      );
    },
    async settled() {
      while (queues.size) await Promise.all([...queues.values()]);
    },
    loaded() {
      return hocuspocus.documents.size;
    },
    async close() {
      hocuspocus.closeConnections();
      const end = Date.now() + 3000;
      while ((hocuspocus.documents.size || queues.size) && Date.now() < end) {
        await live.settled();
        await Bun.sleep(10);
      }
    },
  };

  const socket = {
    open(ws: Bun.ServerWebSocket<CollabSocketData>) {
      const { workspaceId, userId, name, req } = ws.data;
      ws.data.conn = hocuspocus.handleConnection(ws as never, req, { workspaceId, userId, name });
    },
    message(ws: Bun.ServerWebSocket<CollabSocketData>, raw: string | Buffer) {
      const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
      ws.data.conn?.handleMessage(bytes);
    },
    close(ws: Bun.ServerWebSocket<CollabSocketData>, code: number, reason: string) {
      ws.data.conn?.handleClose({ code, reason });
    },
  };

  return { live, socket };
}
