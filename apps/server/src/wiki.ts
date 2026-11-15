// The workspace's wiki: markdown pages with versions, folders, tags, typed properties, alternate titles,
// [[page]] links (page_links table), a 30-day trash and the agents' reads. Every saved version updates the
// links, the search (seam 5) and the page's live session, if there is one.
import type { ActorRef, WikiDraft, WikiPage, WikiPageSummary, WikiVersion } from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { applyProps, type PropDef, type PropError, type Props } from "@vanr/engine/props";
import { slugify } from "@vanr/engine/wiki/links";
import { and, asc, desc, eq, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { AppDeps, WorkspaceMember } from "./context";
import { pgCode } from "./db-errors";
import { forbidden, HttpError, notFound } from "./http";
import { reindex, unindex } from "./search-index";
import { checkLinks, namesOf, reresolveLinks, syncLinks } from "./wiki-links";

const { knowledgePages, pageRevisions, wikiPageViews, pageLinks, wikiPageDocs, wikiPropSchemas, members } =
  schema;
export type WikiRow = typeof knowledgePages.$inferSelect;
export type Author = ActorRef & { actingFor?: string };

export const MAX_BODY = 500_000;
/** Characters that break a [[link]] by title (Obsidian rejects them too; the vault import strips them). */
export const TITLE_BREAKS_LINK = /[[\]|#^]/;

/**
 * Text with a NUL character anywhere (Postgres text can't hold it): rejected at the border with 400, in a
 * value or a key, however deep.
 */
export function rejectNul(value: unknown): void {
  const has = (v: unknown): boolean =>
    typeof v === "string"
      ? v.includes("\0")
      : Array.isArray(v)
        ? v.some(has)
        : v !== null && typeof v === "object"
          ? Object.entries(v).some(([k, x]) => k.includes("\0") || has(x))
          : false;
  if (has(value)) throw new HttpError(400, "wiki.invalid_text", "Text can't contain a NUL character");
}

function checkTitle(title: string) {
  if (TITLE_BREAKS_LINK.test(title))
    throw new HttpError(400, "wiki.title_chars", "A page title can't have [ ] | # or ^");
}
const EXCERPT = 160;
const TRASH_DAYS = 30;
const MAX_ALT_TITLES = 20;

export function normalizeFolder(folder: string | undefined): string {
  return (folder ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .join("/")
    .slice(0, 200);
}

function normalizeTags(tags: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    const v = t.trim().replace(/^#/, "").toLowerCase().slice(0, 40);
    if (v) out.add(v);
    if (out.size === 20) break;
  }
  return [...out];
}

function normalizeAltTitles(aliases: string[] | undefined, title: string): string[] {
  const out: string[] = [];
  const seen = new Set([title.toLowerCase()]);
  for (const a of aliases ?? []) {
    const v = a
      .replace(/[[\]|#^]/g, "")
      .trim()
      .slice(0, 200);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length === MAX_ALT_TITLES) break;
  }
  return out;
}

/**
 * `[[target#…|…]]` (or `![[…]]`) → `target`, as `/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g` would replace it,
 * in one pass: the inner text runs to the first `]`. That expression rescanned the rest of the text from
 * every `[[` with no closing.
 */
function linkTargets(text: string): string {
  const stop = new Int32Array(text.length + 1).fill(text.length);
  for (let i = text.length - 1; i >= 0; i--) stop[i] = text[i] === "]" ? i : (stop[i + 1] as number);
  let out = "";
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const bang = text[i] === "!" && text.startsWith("[[", i + 1);
    if (!bang && !text.startsWith("[[", i)) continue;
    const from = i + (bang ? 3 : 2);
    const k = stop[from] as number;
    const first = text[from];
    if (k === from || first === "|" || first === "#" || text[k + 1] !== "]") continue;
    const inner = text.slice(from, k);
    const cut = inner.search(/[|#]/);
    out += text.slice(last, i) + (cut < 0 ? inner : inner.slice(0, cut));
    last = k + 2;
    i = k + 1;
  }
  return out + text.slice(last);
}

export function excerptOf(body: string): string {
  const plain = linkTargets(body.replace(/```[\s\S]*?```/g, " ").replace(/%%[\s\S]*?%%/g, " "))
    .replace(/[#>*_`~[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > EXCERPT ? `${plain.slice(0, EXCERPT - 1)}…` : plain;
}

const canEditPage = (row: WikiRow, me: WorkspaceMember | null) =>
  !!me && !row.deletedAt && (!row.locked || can(me.role, "configure"));

export function toSummary(row: WikiRow): WikiPageSummary {
  return {
    slug: row.slug,
    title: row.title,
    folder: row.folder,
    tags: row.tags,
    excerpt: excerptOf(row.body),
    sourceType: row.sourceType ?? null,
    pinned: row.pinned,
    locked: row.locked,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    props: row.props,
    altTitles: row.aliases,
  };
}

/** A page by its slug. One in the trash only with `trashed: true`. */
export async function pageBySlug(
  db: Db,
  workspaceId: string,
  slug: string,
  opts: { trashed?: boolean } = {},
): Promise<WikiRow> {
  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(
      and(
        eq(knowledgePages.workspaceId, workspaceId),
        eq(knowledgePages.slug, slug),
        opts.trashed ? isNotNull(knowledgePages.deletedAt) : isNull(knowledgePages.deletedAt),
      ),
    );
  if (!row) throw notFound("Page not found");
  return row;
}

/** Pages outside the trash. */
export async function allPages(db: Db, workspaceId: string): Promise<WikiRow[]> {
  return db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.workspaceId, workspaceId), isNull(knowledgePages.deletedAt)))
    .orderBy(asc(knowledgePages.folder), asc(knowledgePages.title));
}

export async function historyOf(db: Db, pageId: string): Promise<WikiVersion[]> {
  const rows = await db
    .select({
      version: pageRevisions.version,
      author: pageRevisions.author,
      createdAt: pageRevisions.createdAt,
      note: pageRevisions.note,
    })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(desc(pageRevisions.version));
  return rows.map((v) => ({
    version: v.version,
    author: v.author,
    at: v.createdAt.toISOString(),
    note: v.note,
  }));
}

async function draftOf(db: Db, pageId: string): Promise<WikiDraft | null> {
  const [d] = await db
    .select({
      parentVersion: wikiPageDocs.parentVersion,
      dirty: wikiPageDocs.dirty,
      editors: wikiPageDocs.editors,
      editedAt: wikiPageDocs.editedAt,
    })
    .from(wikiPageDocs)
    .where(eq(wikiPageDocs.pageId, pageId));
  if (!d) return null;
  return { ...d, editedAt: d.editedAt?.toISOString() ?? null };
}

export async function toPage(db: Db, row: WikiRow, me: WorkspaceMember | null): Promise<WikiPage> {
  const [history, reads, back, draft] = await Promise.all([
    historyOf(db, row.id),
    db.select().from(wikiPageViews).where(eq(wikiPageViews.pageId, row.id)),
    db
      .selectDistinct({ slug: knowledgePages.slug, title: knowledgePages.title })
      .from(pageLinks)
      .innerJoin(knowledgePages, eq(knowledgePages.id, pageLinks.sourceId))
      .where(
        and(eq(pageLinks.targetId, row.id), ne(pageLinks.sourceId, row.id), isNull(knowledgePages.deletedAt)),
      )
      .orderBy(asc(knowledgePages.title)),
    draftOf(db, row.id),
  ]);
  const authors: ActorRef[] = [];
  for (const v of history) {
    if (!authors.some((a) => a.type === v.author.type && a.id === v.author.id))
      authors.push({ type: v.author.type, id: v.author.id });
  }
  const last = reads.reduce<Date | null>((acc, r) => (!acc || r.lastAt > acc ? r.lastAt : acc), null);
  return {
    ...toSummary(row),
    body: row.body,
    authors,
    reads: {
      total: reads.reduce((n, r) => n + r.count, 0),
      agents: reads.filter((r) => r.readerType === "agent").map((r) => r.readerId),
      last: last?.toISOString() ?? null,
    },
    inboundLinks: back,
    history,
    editable: canEditPage(row, me),
    draft,
  };
}

async function freeSlug(db: Db | Tx, workspaceId: string, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(
    (
      await db
        .select({ slug: knowledgePages.slug })
        .from(knowledgePages)
        .where(
          and(eq(knowledgePages.workspaceId, workspaceId), sql`${knowledgePages.slug} like ${`${base}%`}`),
        )
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** After a write: search and live session. A failure here doesn't undo the version (it goes to the log). */
async function afterWrite(deps: AppDeps, row: WikiRow, origin: SaveOrigin) {
  await reindex(deps, { kind: "wiki", id: row.id });
  if (origin !== "live") deps.wikiLive.pageSaved(row);
}

/** Where the write came from: the live session doesn't get back what it published itself. */
export type SaveOrigin = "api" | "live";

/** A new page's fields. */
export interface NewPage {
  workspaceId: string;
  title: string;
  folder?: string;
  body?: string;
  tags?: string[];
  aliases?: string[];
  props?: Props;
  author: Author;
  sourceType?: "obsidian";
  note?: string | null;
}

export async function createPage(
  deps: AppDeps,
  input: NewPage & { propSchema?: { defs: PropDef[]; version: number } },
): Promise<WikiRow> {
  const [row] = await createPages(deps, input.workspaceId, input.author, [input], input.propSchema);
  if (!row) throw new Error("wiki insert failed");
  return row;
}

/**
 * New pages (and the property schema they need) in one transaction: all of them or none. Each one is
 * checked (title, text, links) before anything is written.
 */
export async function createPages(
  deps: AppDeps,
  workspaceId: string,
  author: Author,
  inputs: readonly NewPage[],
  propSchema?: { defs: PropDef[]; version: number },
): Promise<WikiRow[]> {
  for (const input of inputs) {
    checkTitle(input.title);
    rejectNul(input);
    checkLinks(input.body ?? "");
  }
  if (propSchema) rejectNul(propSchema.defs);
  const at = deps.now();
  const rows = await writeTx(deps.db, async (tx) => {
    await requireWriter(tx, workspaceId, author);
    if (propSchema) await writePropSchema(tx, workspaceId, propSchema.defs, propSchema.version, at);
    const out: WikiRow[] = [];
    for (const input of inputs) out.push(await insertPage(tx, { ...input, workspaceId }, at));
    return out;
  });
  for (const row of rows) await afterWrite(deps, row, "api");
  return rows;
}

async function insertPage(tx: Tx, input: NewPage, at: Date): Promise<WikiRow> {
  const slug = await freeSlug(tx, input.workspaceId, input.title);
  const id = newId("wiki");
  const body = input.body ?? "";
  const [created] = await tx
    .insert(knowledgePages)
    .values({
      id,
      workspaceId: input.workspaceId,
      slug,
      title: input.title,
      folder: normalizeFolder(input.folder),
      tags: normalizeTags(input.tags),
      aliases: normalizeAltTitles(input.aliases, input.title),
      props: input.props ?? {},
      body,
      version: 1,
      sourceType: input.sourceType ?? null,
      updatedBy: input.author,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!created) throw new Error("wiki insert failed");
  await tx.insert(pageRevisions).values({
    pageId: id,
    version: 1,
    title: input.title,
    body,
    props: created.props,
    author: input.author,
    note: input.note ?? null,
    createdAt: at,
  });
  await syncLinks(tx, created);
  await reresolveLinks(tx, created.workspaceId, namesOf(created));
  return created;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The page's row read for a write: locked until the write's transaction ends, so a lock, a trash or another
 * save that lands meanwhile waits and the write decides on the state it read here. FOR NO KEY UPDATE: no
 * write but the delete changes the page's key, and that lock doesn't conflict with the key-share lock a new
 * [[link]] row takes on the page it points to (so two saves that link to each other don't deadlock).
 * `forDelete` is the strong lock of the delete for good. Each write locks one page; a write that ever
 * needs more must lock them all first, in id order. A mutable seam: the Postgres race tests swap `row` for
 * an unlocked read (VANR_TEST_WIKI_UNLOCKED) and for the old FOR UPDATE (VANR_TEST_WIKI_FOR_UPDATE).
 */
export const pageLock = {
  row: async (tx: Tx, id: string): Promise<WikiRow | null> => {
    const [row] = await tx
      .select()
      .from(knowledgePages)
      .where(eq(knowledgePages.id, id))
      .for("no key update");
    return row ?? null;
  },
  forDelete: async (tx: Tx, id: string): Promise<WikiRow | null> => {
    const [row] = await tx.select().from(knowledgePages).where(eq(knowledgePages.id, id)).for("update");
    return row ?? null;
  },
};

/**
 * A wiki write's transaction. A deadlock or a serialization failure Postgres aborted becomes `wiki.busy`
 * (409, nothing was written), which the client may repeat, never a 500.
 */
export async function writeTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (err) {
    const code = pgCode(err);
    if (code === "40P01" || code === "40001")
      throw new HttpError(409, "wiki.busy", "The page is busy with another change; try again", {
        retry: true,
      });
    throw err;
  }
}

/** A person's role in the workspace read inside the write's transaction (null: not a member any more). */
/**
 * A person's membership read for a write: FOR SHARE, so a removal that comes after waits for the write to
 * commit, and one that committed before leaves nothing to read. A mutable seam: the Postgres race test
 * swaps it for a read without the lock (VANR_TEST_WIKI_MEMBER_UNLOCKED).
 */
export const memberLock = {
  role: async (tx: Tx, workspaceId: string, userId: string) => {
    const [m] = await tx
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)))
      .for("share");
    return m?.role ?? null;
  },
};

const roleIn = (tx: Tx, workspaceId: string, userId: string) => memberLock.role(tx, workspaceId, userId);

/** Whether `who` may write a locked page, decided with the role read in `tx`: only a person who is an admin. */
export async function bypassesLock(tx: Tx, workspaceId: string, who: ActorRef): Promise<boolean> {
  if (who.type !== "person") return false;
  const role = await roleIn(tx, workspaceId, who.id);
  return !!role && can(role, "configure");
}

/** A person who writes must still be a member when the write commits; an agent's access is its run's. */
export async function requireWriter(tx: Tx, workspaceId: string, who: ActorRef) {
  if (who.type === "person" && !(await roleIn(tx, workspaceId, who.id)))
    throw forbidden("You are not a member of this workspace any more");
}

const pageLocked = () => new HttpError(403, "wiki.page_locked", "This page is locked");

/** The page's row for a write that needs it outside the trash, locked in `tx`. */
async function livePage(tx: Tx, id: string): Promise<WikiRow> {
  const row = await pageLock.row(tx, id);
  if (!row || row.deletedAt) throw notFound("Page not found");
  return row;
}

/**
 * Saves a new version. The page is re-read locked inside the transaction: a lock, a trash or a newer
 * version that landed after the caller read `row` decides here. On a locked page only who may bypass the
 * lock writes: `canBypassLock` is the caller's ceiling, and the author's role is read again in the
 * transaction. `inTx` runs with the locked row before anything is written (the live session checks its
 * editors there).
 */
export async function savePage(
  deps: AppDeps,
  input: {
    row: WikiRow;
    author: Author;
    canBypassLock: boolean;
    parentVersion?: number;
    body?: string;
    title?: string;
    folder?: string;
    tags?: string[];
    aliases?: string[];
    props?: Props;
    note?: string | null;
    origin?: SaveOrigin;
    inTx?: (tx: Tx, page: WikiRow) => Promise<void>;
    /** Automatic publication may credit a former member for edits accepted before they left. */
    attributionOnly?: boolean;
  },
): Promise<WikiRow> {
  if (input.title !== undefined && input.title !== input.row.title) checkTitle(input.title);
  rejectNul([input.body, input.title, input.folder, input.tags, input.aliases, input.props, input.note]);
  if (input.body !== undefined) checkLinks(input.body);
  const at = deps.now();
  const result = await writeTx(deps.db, async (tx) => {
    const row = await livePage(tx, input.row.id);
    if (!input.attributionOnly) await requireWriter(tx, row.workspaceId, input.author);
    if (row.locked && !(input.canBypassLock && (await bypassesLock(tx, row.workspaceId, input.author))))
      throw pageLocked();
    // Without a parent version the caller saves over the version it read.
    const expected = input.parentVersion ?? input.row.version;
    if (expected !== row.version)
      throw new HttpError(409, "wiki.stale_draft", "Someone saved a newer version", {
        currentVersion: row.version,
      });
    await input.inTx?.(tx, row);
    const next = row.version + 1;
    const body = input.body ?? row.body;
    const title = input.title ?? row.title;
    const aliases = input.aliases !== undefined ? normalizeAltTitles(input.aliases, title) : row.aliases;
    const props = input.props ?? row.props;
    const [updated] = await tx
      .update(knowledgePages)
      .set({
        body,
        title,
        version: next,
        aliases,
        props,
        updatedBy: input.author,
        updatedAt: at,
        ...(input.folder !== undefined ? { folder: normalizeFolder(input.folder) } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      })
      .where(eq(knowledgePages.id, row.id))
      .returning();
    if (!updated) throw notFound("Page not found");
    await tx.insert(pageRevisions).values({
      pageId: row.id,
      version: next,
      title,
      body,
      props,
      author: input.author,
      note: input.note ?? null,
      createdAt: at,
    });
    if (body !== row.body) await syncLinks(tx, updated);
    const renamed =
      title !== row.title || updated.folder !== row.folder || aliases.join("\n") !== row.aliases.join("\n");
    if (renamed) await reresolveLinks(tx, updated.workspaceId, [...namesOf(row), ...namesOf(updated)]);
    return updated;
  });
  await afterWrite(deps, result, input.origin ?? "api");
  return result;
}

/**
 * A state change without a new version (pin, lock, move), on the page re-read locked; `guard` decides with
 * that row inside the transaction. Only the one with an author (move) counts as a change of the page;
 * pinning and locking keep the "who changed it and when" the page shows.
 */
export async function patchPage(
  deps: AppDeps,
  row: WikiRow,
  set: Partial<typeof knowledgePages.$inferInsert>,
  guard?: (tx: Tx, page: WikiRow) => Promise<void>,
) {
  rejectNul(set);
  const at = deps.now();
  const updated = await writeTx(deps.db, async (tx) => {
    const page = await livePage(tx, row.id);
    await guard?.(tx, page);
    const [changed] = await tx
      .update(knowledgePages)
      .set(set.updatedBy ? { ...set, updatedAt: at } : set)
      .where(eq(knowledgePages.id, row.id))
      .returning();
    if (!changed) throw notFound("Page not found");
    if (set.folder !== undefined)
      await reresolveLinks(tx, changed.workspaceId, [...namesOf(page), ...namesOf(changed)]);
    return changed;
  });
  if (set.locked !== undefined || set.folder !== undefined) await deps.wikiLive.recheckPage(updated);
  await reindex(deps, { kind: "wiki", id: updated.id });
  return updated;
}

/** Guard of a write that a lock forbids (move): only who bypasses the lock, by the role read in `tx`. */
export const unlockedFor = (who: ActorRef) => async (tx: Tx, page: WikiRow) => {
  await requireWriter(tx, page.workspaceId, who);
  if (page.locked && !(await bypassesLock(tx, page.workspaceId, who))) throw pageLocked();
};

/** Guard of the lock itself: an admin by the role read in `tx`. */
export const adminOnly = (who: ActorRef) => async (tx: Tx, page: WikiRow) => {
  if (!(await bypassesLock(tx, page.workspaceId, who))) throw forbidden("Only admins can lock pages");
};

/** Guard of a write any member may do (pin): still a member when it commits. */
export const memberOnly = (who: ActorRef) => async (tx: Tx, page: WikiRow) => {
  await requireWriter(tx, page.workspaceId, who);
};

export async function recordRead(deps: AppDeps, pageId: string, reader: ActorRef) {
  const at = deps.now();
  await deps.db
    .insert(wikiPageViews)
    .values({ pageId, readerType: reader.type, readerId: reader.id, count: 1, lastAt: at })
    .onConflictDoUpdate({
      target: [wikiPageViews.pageId, wikiPageViews.readerType, wikiPageViews.readerId],
      set: { count: sql`${wikiPageViews.count} + 1`, lastAt: at },
    });
}

async function firstAuthor(db: Db | Tx, pageId: string): Promise<ActorRef | undefined> {
  const [first] = await db
    .select({ author: pageRevisions.author })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(asc(pageRevisions.version))
    .limit(1);
  return first?.author;
}

/** Who may trash, restore or delete for good: who created the page or an admin, never past a lock. */
async function deleterCheck(db: Db | Tx, row: WikiRow, userId: string, role: WorkspaceMember["role"] | null) {
  if (!role) throw forbidden("You are not a member of this workspace any more");
  const admin = can(role, "configure");
  if (row.locked && !admin) throw pageLocked();
  const first = await firstAuthor(db, row.id);
  if (!admin && !(first?.type === "person" && first.id === userId))
    throw forbidden("Only who created the page or an admin can delete it");
}

/** The trash list's `canPurge`: the same rule, on the role the request carries (a read, nothing is written). */
export async function requireDeleter(db: Db, row: WikiRow, me: WorkspaceMember) {
  await deleterCheck(db, row, me.userId, me.role);
}

/** The page of a trash write, re-read locked, and the rule checked on it with the role read in `tx`. */
async function deletablePage(
  tx: Tx,
  id: string,
  me: WorkspaceMember,
  trashed: boolean,
  lock: (tx: Tx, id: string) => Promise<WikiRow | null> = pageLock.row,
): Promise<WikiRow> {
  const row = await lock(tx, id);
  if (!row || !!row.deletedAt !== trashed) throw notFound("Page not found");
  await deleterCheck(tx, row, me.userId, await roleIn(tx, row.workspaceId, me.userId));
  return row;
}

/** Sends to the trash: gone from lists, inbound links and search; comes back within 30 days. */
export async function trashPage(deps: AppDeps, row: WikiRow, me: WorkspaceMember): Promise<WikiRow> {
  const at = deps.now();
  // Leaves the search in the same commit that puts it in the trash (seam 5).
  const trashed = await writeTx(deps.db, async (tx) => {
    await deletablePage(tx, row.id, me, false);
    const [r] = await tx
      .update(knowledgePages)
      .set({
        deletedAt: at,
        deletedBy: { type: "person", id: me.userId },
        expungeAt: new Date(at.getTime() + TRASH_DAYS * 86_400_000),
      })
      .where(eq(knowledgePages.id, row.id))
      .returning();
    if (!r) throw notFound("Page not found");
    await unindex(tx, deps, { kind: "wiki", id: r.id });
    return r;
  });
  deps.wikiLive.pageClosed(trashed);
  // A link with the same name moves to another page outside the trash, if there is one.
  await reresolveLinks(deps.db, trashed.workspaceId, namesOf(trashed));
  return trashed;
}

export async function untrashPage(deps: AppDeps, row: WikiRow, me: WorkspaceMember): Promise<WikiRow> {
  const restored = await writeTx(deps.db, async (tx) => {
    await deletablePage(tx, row.id, me, true);
    const [r] = await tx
      .update(knowledgePages)
      .set({ deletedAt: null, deletedBy: null, expungeAt: null })
      .where(eq(knowledgePages.id, row.id))
      .returning();
    if (!r) throw notFound("Page not found");
    return r;
  });
  await reresolveLinks(deps.db, restored.workspaceId, namesOf(restored));
  await reindex(deps, { kind: "wiki", id: restored.id });
  return restored;
}

/**
 * Deletes for good (with versions, links and draft, by the cascade). From the trash route, `me` must still
 * be allowed when it commits; the trash tick passes none and checks the page is still due.
 */
export async function purgePage(deps: AppDeps, row: WikiRow, me?: WorkspaceMember) {
  const gone = await writeTx(deps.db, async (tx) => {
    if (me) await deletablePage(tx, row.id, me, true, pageLock.forDelete);
    else {
      const page = await pageLock.forDelete(tx, row.id);
      if (!page?.deletedAt || !page.expungeAt || page.expungeAt > deps.now()) return false;
    }
    await tx.delete(knowledgePages).where(eq(knowledgePages.id, row.id));
    await unindex(tx, deps, { kind: "wiki", id: row.id });
    return true;
  });
  if (gone) deps.wikiLive.pageClosed(row);
  return gone;
}

/** A page written outside createPage (redoing an undone creation): links and search. */
export async function refreshPage(deps: AppDeps, id: string) {
  const [row] = await deps.db.select().from(knowledgePages).where(eq(knowledgePages.id, id));
  if (!row || row.deletedAt) return;
  await syncLinks(deps.db, row);
  await reresolveLinks(deps.db, row.workspaceId, namesOf(row));
  await reindex(deps, { kind: "wiki", id: row.id });
}

/** Tick: deletes for good what passed the 30 days in the trash (up to 100 at a time). */
export async function purgeWikiTrash(deps: AppDeps): Promise<number> {
  const due = await deps.db
    .select()
    .from(knowledgePages)
    .where(and(isNotNull(knowledgePages.deletedAt), lte(knowledgePages.expungeAt, deps.now())))
    .limit(100);
  let purged = 0;
  for (const row of due) if (await purgePage(deps, row)) purged++;
  return purged;
}

/** Property definitions of the workspace's pages (seam 4). */
export async function propSchemaOf(
  db: Db | Tx,
  workspaceId: string,
): Promise<{ defs: PropDef[]; version: number }> {
  const [row] = await db.select().from(wikiPropSchemas).where(eq(wikiPropSchemas.workspaceId, workspaceId));
  return { defs: (row?.defs ?? []) as PropDef[], version: row?.version ?? 0 };
}

/** Replaces the definitions, checking the version (0 = doesn't exist yet). */
export async function savePropSchema(
  deps: AppDeps,
  workspaceId: string,
  defs: PropDef[],
  parentVersion: number,
  author: Author,
): Promise<{ defs: PropDef[]; version: number }> {
  return writeTx(deps.db, async (tx) => {
    await requireWriter(tx, workspaceId, author);
    return writePropSchema(tx, workspaceId, defs, parentVersion, deps.now());
  });
}

async function writePropSchema(
  tx: Tx,
  workspaceId: string,
  defs: PropDef[],
  parentVersion: number,
  at: Date,
): Promise<{ defs: PropDef[]; version: number }> {
  if (parentVersion === 0) {
    const inserted = await tx
      .insert(wikiPropSchemas)
      .values({ workspaceId, defs, version: 1, updatedAt: at })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { defs, version: 1 };
  } else {
    const [row] = await tx
      .update(wikiPropSchemas)
      .set({ defs, version: parentVersion + 1, updatedAt: at })
      .where(and(eq(wikiPropSchemas.workspaceId, workspaceId), eq(wikiPropSchemas.version, parentVersion)))
      .returning();
    if (row) return { defs, version: row.version };
  }
  const current = await propSchemaOf(tx, workspaceId);
  throw new HttpError(409, "wiki.stale_draft", "Someone changed the properties", {
    currentVersion: current.version,
  });
}

/** Partial write of properties through seam 4; a validation error becomes 400 with the list. */
export function writeProps(defs: PropDef[], current: Props, write: Record<string, unknown>): Props {
  const result = applyProps(defs, current, write);
  if (!result.ok)
    throw new HttpError(400, "wiki.invalid_props", "Invalid property values", {
      errors: result.errors as PropError[],
    });
  return result.props;
}
