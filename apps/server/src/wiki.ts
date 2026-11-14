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
import { forbidden, HttpError, notFound } from "./http";
import { reindex, unindex } from "./search-index";
import { namesOf, reresolveLinks, syncLinks } from "./wiki-links";

const { knowledgePages, pageRevisions, wikiPageViews, pageLinks, wikiPageDocs, wikiPropSchemas } = schema;
export type WikiRow = typeof knowledgePages.$inferSelect;
export type Author = ActorRef & { actingFor?: string };

export const MAX_BODY = 500_000;
/** Characters that break a [[link]] by title (Obsidian refuses them too; the vault import strips them). */
export const TITLE_BREAKS_LINK = /[[\]|#^]/;

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

function excerptOf(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/%%[\s\S]*?%%/g, " ")
    .replace(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
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

async function freeSlug(db: Db, workspaceId: string, title: string): Promise<string> {
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

export async function createPage(
  deps: AppDeps,
  input: {
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
  },
): Promise<WikiRow> {
  checkTitle(input.title);
  const at = deps.now();
  const slug = await freeSlug(deps.db, input.workspaceId, input.title);
  const id = newId("wiki");
  const body = input.body ?? "";
  const row = await deps.db.transaction(async (tx) => {
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
  });
  await afterWrite(deps, row, "api");
  return row;
}

/** Saves a new version. On a locked page only whoever may bypass the lock (an admin) writes. */
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
  },
): Promise<WikiRow> {
  const { row } = input;
  if (row.deletedAt) throw notFound("Page not found");
  if (row.locked && !input.canBypassLock) throw new HttpError(403, "wiki.page_locked", "This page is locked");
  if (input.parentVersion !== undefined && input.parentVersion !== row.version)
    throw new HttpError(409, "wiki.stale_draft", "Someone saved a newer version", {
      currentVersion: row.version,
    });
  if (input.title !== undefined && input.title !== row.title) checkTitle(input.title);
  const at = deps.now();
  const next = row.version + 1;
  const body = input.body ?? row.body;
  const title = input.title ?? row.title;
  const aliases = input.aliases !== undefined ? normalizeAltTitles(input.aliases, title) : row.aliases;
  const props = input.props ?? row.props;
  const saved = await deps.db.transaction(async (tx) => {
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
      .where(
        and(
          eq(knowledgePages.id, row.id),
          eq(knowledgePages.version, row.version),
          isNull(knowledgePages.deletedAt),
        ),
      )
      .returning();
    if (!updated)
      throw new HttpError(409, "wiki.stale_draft", "Someone saved a newer version", {
        currentVersion: row.version + 1,
      });
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
  await afterWrite(deps, saved, input.origin ?? "api");
  return saved;
}

/**
 * A state change without a new version (pin, lock, move). Only the one with an author (move) counts as a
 * change of the page; pinning and locking keep the "who changed it and when" the page shows.
 */
export async function patchPage(
  deps: AppDeps,
  row: WikiRow,
  set: Partial<typeof knowledgePages.$inferInsert>,
) {
  const [updated] = await deps.db
    .update(knowledgePages)
    .set(set.updatedBy ? { ...set, updatedAt: deps.now() } : set)
    .where(eq(knowledgePages.id, row.id))
    .returning();
  if (!updated) throw notFound("Page not found");
  if (set.folder !== undefined)
    await reresolveLinks(deps.db, updated.workspaceId, [...namesOf(row), ...namesOf(updated)]);
  await reindex(deps, { kind: "wiki", id: updated.id });
  return updated;
}

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

async function firstAuthor(db: Db, pageId: string): Promise<ActorRef | undefined> {
  const [first] = await db
    .select({ author: pageRevisions.author })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(asc(pageRevisions.version))
    .limit(1);
  return first?.author;
}

export async function requireDeleter(db: Db, row: WikiRow, me: WorkspaceMember) {
  const admin = can(me.role, "configure");
  if (row.locked && !admin) throw new HttpError(403, "wiki.page_locked", "This page is locked");
  const first = await firstAuthor(db, row.id);
  if (!admin && !(first?.type === "person" && first.id === me.userId))
    throw forbidden("Only who created the page or an admin can delete it");
}

/** Sends to the trash: gone from lists, inbound links and search; comes back within 30 days. */
export async function trashPage(deps: AppDeps, row: WikiRow, by: ActorRef): Promise<WikiRow> {
  const at = deps.now();
  // Leaves the search in the same commit that puts it in the trash (seam 5).
  const trashed = await deps.db.transaction(async (tx) => {
    const [r] = await tx
      .update(knowledgePages)
      .set({ deletedAt: at, deletedBy: by, expungeAt: new Date(at.getTime() + TRASH_DAYS * 86_400_000) })
      .where(and(eq(knowledgePages.id, row.id), isNull(knowledgePages.deletedAt)))
      .returning();
    if (r) await unindex(tx, deps, { kind: "wiki", id: r.id });
    return r;
  });
  if (!trashed) throw notFound("Page not found");
  // A link with the same name moves to another page outside the trash, if there is one.
  await reresolveLinks(deps.db, trashed.workspaceId, namesOf(trashed));
  deps.wikiLive.pageClosed(trashed);
  return trashed;
}

export async function untrashPage(deps: AppDeps, row: WikiRow): Promise<WikiRow> {
  const [restored] = await deps.db
    .update(knowledgePages)
    .set({ deletedAt: null, deletedBy: null, expungeAt: null })
    .where(and(eq(knowledgePages.id, row.id), isNotNull(knowledgePages.deletedAt)))
    .returning();
  if (!restored) throw notFound("Page not found");
  await reresolveLinks(deps.db, restored.workspaceId, namesOf(restored));
  await reindex(deps, { kind: "wiki", id: restored.id });
  return restored;
}

/** Deletes for good (with versions, links and draft, by the cascade). */
export async function purgePage(deps: AppDeps, row: WikiRow) {
  deps.wikiLive.pageClosed(row);
  await deps.db.transaction(async (tx) => {
    await tx.delete(knowledgePages).where(eq(knowledgePages.id, row.id));
    await unindex(tx, deps, { kind: "wiki", id: row.id });
  });
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
  for (const row of due) await purgePage(deps, row);
  return due.length;
}

/** Property definitions of the workspace's pages (seam 4). */
export async function propSchemaOf(
  db: Db,
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
): Promise<{ defs: PropDef[]; version: number }> {
  const at = deps.now();
  if (parentVersion === 0) {
    const inserted = await deps.db
      .insert(wikiPropSchemas)
      .values({ workspaceId, defs, version: 1, updatedAt: at })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { defs, version: 1 };
  } else {
    const [row] = await deps.db
      .update(wikiPropSchemas)
      .set({ defs, version: parentVersion + 1, updatedAt: at })
      .where(and(eq(wikiPropSchemas.workspaceId, workspaceId), eq(wikiPropSchemas.version, parentVersion)))
      .returning();
    if (row) return { defs, version: row.version };
  }
  const current = await propSchemaOf(deps.db, workspaceId);
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
