// Wiki links: page_links is filled on every saved version and answers backlinks, outgoing links,
// unlinked mentions and renames without reading the body of every page.
import type { WikiPanel } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import {
  blockIds,
  cleanHeading,
  headings,
  parseWikiLinks,
  resolveTarget,
  rewriteLinks,
  slugify,
  stripMd,
} from "@vanr/engine/wiki/links";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { HttpError } from "./http";
import type { WikiRow } from "./wiki";
import { readablePagesSql, type WikiViewer } from "./wiki-access";

const { knowledgePages, pageLinks } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export type LinkTarget = Pick<WikiRow, "id" | "slug" | "title" | "folder" | "aliases"> & {
  restricted: boolean;
};

/** The most [[links]] one page keeps: a body past it is rejected before anything is written. */
export const MAX_LINKS = 5_000;
/** Link rows per insert: ten parameters each, far under Postgres's 65535 per statement. */
const LINK_BATCH = 1_000;

/** Rejects a body with more [[links]] than a page keeps (400). */
export function checkLinks(body: string): void {
  if (parseWikiLinks(body).length > MAX_LINKS)
    throw new HttpError(400, "wiki.too_many_links", `A page can have at most ${MAX_LINKS} links`, {
      max: MAX_LINKS,
    });
}

/** Ways of writing a page's target, in lowercase (without `.md`). */
export function namesOf(p: Pick<WikiRow, "slug" | "title" | "folder" | "aliases">): string[] {
  const t = p.title.toLowerCase();
  const out = new Set([p.slug, t, p.folder ? `${p.folder}/${p.title}`.toLowerCase() : t]);
  for (const a of p.aliases ?? []) out.add(a.toLowerCase());
  return [...out];
}

/**
 * Pages that can be the target of these texts (lean query, no body); with a viewer, only the ones they
 * read.
 */
async function candidates(
  db: Conn,
  workspaceId: string,
  targets: string[],
  viewer?: WikiViewer,
): Promise<LinkTarget[]> {
  if (!targets.length) return [];
  const names = [...new Set(targets.map((t) => stripMd(t).toLowerCase()))];
  // The title can be the whole target or the end of folder/title (and the title may contain "/").
  const titles = [...new Set([...names, ...names.map((n) => n.split("/").pop() ?? n)])];
  const slugs = [...new Set([...names, ...targets.map((t) => slugify(stripMd(t)))])];
  return db
    .select({
      id: knowledgePages.id,
      slug: knowledgePages.slug,
      title: knowledgePages.title,
      folder: knowledgePages.folder,
      aliases: knowledgePages.aliases,
      restricted: sql<boolean>`${knowledgePages.access} is not null`,
    })
    .from(knowledgePages)
    .where(
      and(
        eq(knowledgePages.workspaceId, workspaceId),
        isNull(knowledgePages.deletedAt),
        viewer ? readablePagesSql(viewer) : undefined,
        sql`(
          lower(${knowledgePages.title}) in ${titles}
          or ${knowledgePages.slug} in ${slugs}
          or exists (select 1 from jsonb_array_elements_text(${knowledgePages.aliases}) a where lower(a) in ${names})
        )`,
      ),
    );
}

/** A stored link: where its text points and the page it was resolved to (`page_links`). */
export interface StoredLink {
  sourceId: string;
  ordinal: number;
  targetId: string | null;
  targetText: string;
}

/**
 * Where each link leads for the viewer, in the order given. `page_links` resolves a link among every page of
 * the workspace; when the viewer reads that page, it is also the best among the pages they read and stays.
 * When they don't, the link is resolved again among the pages they read only, so a page they can't read
 * never changes where a link leads for them (nor shows it exists by turning a link into "missing").
 */
export async function targetsFor(
  db: Conn,
  viewer: WikiViewer,
  links: readonly StoredLink[],
): Promise<(string | null)[]> {
  const stored = [...new Set(links.flatMap((l) => (l.targetId ? [l.targetId] : [])))];
  const readable = new Set(
    stored.length
      ? (
          await db
            .select({ id: knowledgePages.id })
            .from(knowledgePages)
            .where(
              and(
                eq(knowledgePages.workspaceId, viewer.workspaceId),
                inArray(knowledgePages.id, stored),
                readablePagesSql(viewer),
              ),
            )
        ).map((r) => r.id)
      : [],
  );
  const again = links.filter((l) => l.targetId && !readable.has(l.targetId));
  const pages = again.length
    ? await candidates(db, viewer.workspaceId, [...new Set(again.map((l) => l.targetText))], viewer)
    : [];
  return links.map((l) => {
    if (!l.targetId || readable.has(l.targetId)) return l.targetId;
    return resolveTarget(l.targetText, pages)?.id ?? null;
  });
}

/**
 * The links that lead to `row` for the viewer, from pages outside the trash they read (not the page itself):
 * the ones stored on it, and the ones stored on a page they don't read whose text leads here among theirs.
 */
export async function inboundFor(
  db: Conn,
  row: Pick<WikiRow, "id" | "workspaceId" | "slug" | "title" | "folder" | "aliases">,
  viewer: WikiViewer,
): Promise<{ sourceId: string; ordinal: number; slug: string; title: string; body: string }[]> {
  const keys = namesOf(row);
  const withMd = [...keys, ...keys.map((n) => `${n}.md`)];
  const rows = await db
    .select({
      sourceId: pageLinks.sourceId,
      ordinal: pageLinks.ordinal,
      targetId: pageLinks.targetId,
      targetText: pageLinks.targetText,
      slug: knowledgePages.slug,
      title: knowledgePages.title,
      body: knowledgePages.body,
    })
    .from(pageLinks)
    .innerJoin(knowledgePages, eq(knowledgePages.id, pageLinks.sourceId))
    .where(
      and(
        eq(pageLinks.workspaceId, row.workspaceId),
        ne(pageLinks.sourceId, row.id),
        isNull(knowledgePages.deletedAt),
        readablePagesSql(viewer),
        or(
          eq(pageLinks.targetId, row.id),
          and(
            sql`${pageLinks.targetId} is not null`,
            or(sql`lower(trim(${pageLinks.targetText})) in ${withMd}`, inArray(pageLinks.targetSlug, keys)),
          ),
        ),
      ),
    )
    .orderBy(asc(knowledgePages.title), asc(pageLinks.sourceId), asc(pageLinks.ordinal));
  const targets = await targetsFor(db, viewer, rows);
  return rows.filter((_, i) => targets[i] === row.id);
}

/** The graph's edges for the viewer: links between pages outside the trash they read, as slugs. */
export async function viewerEdges(db: Conn, viewer: WikiViewer): Promise<{ from: string; to: string }[]> {
  const pages = await db
    .select({ id: knowledgePages.id, slug: knowledgePages.slug })
    .from(knowledgePages)
    .where(
      and(
        eq(knowledgePages.workspaceId, viewer.workspaceId),
        isNull(knowledgePages.deletedAt),
        readablePagesSql(viewer),
      ),
    );
  const slugOf = new Map(pages.map((p) => [p.id, p.slug]));
  const links = await db
    .select({
      sourceId: pageLinks.sourceId,
      ordinal: pageLinks.ordinal,
      targetId: pageLinks.targetId,
      targetText: pageLinks.targetText,
    })
    .from(pageLinks)
    .where(eq(pageLinks.workspaceId, viewer.workspaceId));
  const mine = links.filter((l) => slugOf.has(l.sourceId));
  const targets = await targetsFor(db, viewer, mine);
  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  mine.forEach((l, i) => {
    const from = slugOf.get(l.sourceId);
    const to = targets[i] ? slugOf.get(targets[i] ?? "") : undefined;
    if (!from || !to || targets[i] === l.sourceId) return;
    const key = `${from}\n${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  });
  // In the pages' order, not the rows': where an updated link row lands on disk is no one's business.
  return edges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
}

/** Targets of the text's [[links]] that lead to no page outside the trash (attachment embeds are left out). */
export async function missingTargets(db: Conn, workspaceId: string, md: string): Promise<string[]> {
  const targets = [...new Set(parseWikiLinks(md).flatMap((r) => (r.embed || !r.target ? [] : [r.target])))];
  const pages = await candidates(db, workspaceId, targets);
  return targets.filter((t) => !resolveTarget(t, pages));
}

/** Replaces the page's links with the ones of the current body. Runs inside the transaction that saves the version. */
export async function syncLinks(db: Conn, page: Pick<WikiRow, "id" | "workspaceId" | "body">): Promise<void> {
  const refs = parseWikiLinks(page.body);
  checkLinks(page.body);
  await db.delete(pageLinks).where(eq(pageLinks.sourceId, page.id));
  if (!refs.length) return;
  const pages = await candidates(db, page.workspaceId, [
    ...new Set(refs.map((r) => r.target).filter(Boolean)),
  ]);
  const rows = refs.map((r, ordinal) => ({
    sourceId: page.id,
    ordinal,
    workspaceId: page.workspaceId,
    // [[#Heading]] points to the page itself.
    targetId: r.target ? (resolveTarget(r.target, pages)?.id ?? null) : page.id,
    targetText: r.target,
    targetSlug: r.target ? slugify(stripMd(r.target)) : "",
    anchor: r.anchor,
    linkText: r.linkText,
    embed: r.embed,
  }));
  for (let i = 0; i < rows.length; i += LINK_BATCH)
    await db.insert(pageLinks).values(rows.slice(i, i + LINK_BATCH));
}

/**
 * Recomputes the destination of the links written with one of these names (or whose text becomes one of these slugs):
 * page created, renamed, moved, with a new alias, in the trash or back from it. The destination is the one `resolveTarget` picks among the
 * pages outside the trash (the same one the UI shows). With none, a link that pointed to a
 * page in the trash stays on it (the panel shows "in the trash") and the rest has no destination.
 */
export async function reresolveLinks(db: Conn, workspaceId: string, names: readonly string[]): Promise<void> {
  const keys = [...new Set(names.map((n) => n.toLowerCase()))];
  if (!keys.length) return;
  const withMd = [...keys, ...keys.map((n) => `${n}.md`)];
  const links = await db
    .select({
      sourceId: pageLinks.sourceId,
      ordinal: pageLinks.ordinal,
      targetId: pageLinks.targetId,
      targetText: pageLinks.targetText,
      targetTrashed: knowledgePages.deletedAt,
    })
    .from(pageLinks)
    .leftJoin(knowledgePages, eq(knowledgePages.id, pageLinks.targetId))
    .where(
      and(
        eq(pageLinks.workspaceId, workspaceId),
        or(sql`lower(trim(${pageLinks.targetText})) in ${withMd}`, inArray(pageLinks.targetSlug, keys)),
      ),
    );
  if (!links.length) return;
  const pages = await candidates(db, workspaceId, [...new Set(links.map((l) => l.targetText))]);
  const moves = new Map<string | null, typeof links>();
  for (const l of links) {
    const next = resolveTarget(l.targetText, pages)?.id ?? (l.targetTrashed ? l.targetId : null);
    if (next === l.targetId) continue;
    moves.set(next, [...(moves.get(next) ?? []), l]);
  }
  for (const [targetId, group] of moves)
    await db
      .update(pageLinks)
      .set({ targetId })
      .where(
        sql`(${pageLinks.sourceId}, ${pageLinks.ordinal}) in (${sql.join(
          group.map((l) => sql`(${l.sourceId}, ${l.ordinal})`),
          sql`, `,
        )})`,
      );
}

/** Context of an occurrence: the line it is on, trimmed around it. */
function snippetAt(body: string, at: number, len: number): string {
  const lineStart = body.lastIndexOf("\n", at) + 1;
  const lineEnd = body.indexOf("\n", at + len);
  const line = body.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const rel = at - lineStart;
  const from = Math.max(0, rel - 80);
  const to = Math.min(line.length, rel + len + 80);
  return `${from > 0 ? "…" : ""}${line.slice(from, to).trim()}${to < line.length ? "…" : ""}`;
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

/**
 * Side panel, for the reader: who points to the page, who cites it without a link, where it points and the
 * outline. An inbound link or a mention from a page the reader doesn't read stays out, and a link to a page
 * they don't read shows as a page that doesn't exist.
 */
export async function panelOf(db: Db, row: WikiRow, viewer: WikiViewer): Promise<WikiPanel> {
  // Inbound links: links of pages outside the trash the reader reads that lead here for them.
  const back = await inboundFor(db, row, viewer);
  const bySource = new Map<string, WikiPanel["inboundLinks"][number]>();
  for (const b of back) {
    const entry = bySource.get(b.sourceId);
    if (entry) {
      entry.count++;
      continue;
    }
    const ref = parseWikiLinks(b.body)[b.ordinal];
    bySource.set(b.sourceId, {
      slug: b.slug,
      title: b.title,
      count: 1,
      snippet: ref ? snippetAt(b.body, ref.start, ref.end - ref.start) : "",
    });
  }
  const inboundLinks = [...bySource.values()].slice(0, 100);

  // Unlinked mentions: the title (or an alias) shows in the body as a word, with no [[ ]] to here.
  const names = [row.title, ...row.aliases].filter((n) => n.trim().length >= 3);
  const mentions: WikiPanel["mentions"] = [];
  if (names.length) {
    const linkers = new Set([...bySource.keys(), row.id]);
    const rows = await db
      .select({
        id: knowledgePages.id,
        slug: knowledgePages.slug,
        title: knowledgePages.title,
        body: knowledgePages.body,
      })
      .from(knowledgePages)
      .where(
        and(
          eq(knowledgePages.workspaceId, row.workspaceId),
          isNull(knowledgePages.deletedAt),
          ne(knowledgePages.id, row.id),
          readablePagesSql(viewer),
          sql`(${sql.join(
            names.map((n) => sql`${knowledgePages.body} ilike ${`%${escapeLike(n)}%`}`),
            sql` or `,
          )})`,
        ),
      )
      .limit(200);
    for (const p of rows) {
      if (linkers.has(p.id)) continue;
      const linkRanges = parseWikiLinks(p.body).map((l) => [l.start, l.end] as const);
      for (const n of names) {
        const re = new RegExp(
          `(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
          "iu",
        );
        const m = re.exec(p.body);
        if (m && !linkRanges.some(([a, b]) => (m.index ?? 0) >= a && (m.index ?? 0) < b)) {
          mentions.push({ slug: p.slug, title: p.title, snippet: snippetAt(p.body, m.index, m[0].length) });
          break;
        }
      }
      if (mentions.length >= 30) break;
    }
  }

  // Outgoing links, with the state of the destination and of the anchor, where they lead for the reader.
  const links = await db
    .select()
    .from(pageLinks)
    .where(eq(pageLinks.sourceId, row.id))
    .orderBy(asc(pageLinks.ordinal));
  const targetIds = await targetsFor(db, viewer, links);
  const wanted = [...new Set(targetIds.flatMap((id) => (id ? [id] : [])))];
  const targetPages = wanted.length
    ? await db
        .select({
          id: knowledgePages.id,
          slug: knowledgePages.slug,
          title: knowledgePages.title,
          body: knowledgePages.body,
          deletedAt: knowledgePages.deletedAt,
        })
        .from(knowledgePages)
        .where(inArray(knowledgePages.id, wanted))
    : [];
  const outgoing: WikiPanel["outgoing"] = links.map((link, i) => {
    const target = targetPages.find((p) => p.id === targetIds[i]) ?? null;
    const self = targetIds[i] === row.id;
    const body = self ? row.body : target?.body;
    let anchorOk = true;
    if (link.anchor && body !== undefined) {
      anchorOk = link.anchor.startsWith("^")
        ? blockIds(body).includes(link.anchor.slice(1))
        : headings(body).some((h) => h.text.toLowerCase() === cleanHeading(link.anchor ?? "").toLowerCase());
    }
    const state: WikiPanel["outgoing"][number]["state"] = !target
      ? "missing"
      : target.deletedAt
        ? "trashed"
        : anchorOk
          ? "ok"
          : "broken_anchor";
    return {
      target: link.targetText,
      anchor: link.anchor,
      label: link.linkText,
      embed: link.embed,
      page: target ? { slug: target.slug, title: target.title } : null,
      state,
    };
  });

  return { inboundLinks, mentions, outgoing, outline: headings(row.body) };
}

/**
 * On rename: in each body, rewrites the [[links]] that used the old title (or folder/title)
 * and led to this page; a link with the same text that led to another page stays. The new text is
 * the shortest one that leads to this page after the rename: the title, the folder/title or, if another
 * page takes both, the slug with the title as link text. Links by slug or by alias keep
 * working and stay as they are. Runs before the new title is saved.
 */
export async function planRenames(
  db: Conn,
  row: Pick<WikiRow, "id" | "workspaceId" | "slug" | "title" | "folder">,
  newTitle: string,
  bodies: readonly string[],
): Promise<{ md: string; count: number }[]> {
  const old = row.title.toLowerCase();
  const oldPath = row.folder ? `${row.folder}/${row.title}`.toLowerCase() : null;
  const newPath = row.folder ? `${row.folder}/${newTitle}` : null;
  const targets = [...new Set(bodies.flatMap((b) => parseWikiLinks(b).map((l) => l.target)))].filter(Boolean);
  const before = await candidates(db, row.workspaceId, [...targets, newTitle, ...(newPath ? [newPath] : [])]);
  const after = before.map((p) => (p.id === row.id ? { ...p, title: newTitle } : p));
  const leadsHere = (t: string, pages: LinkTarget[]) => resolveTarget(t, pages)?.id === row.id;
  return bodies.map((body) =>
    rewriteLinks(body, (l) => {
      const k = stripMd(l.target).toLowerCase();
      const byPath = oldPath !== null && k === oldPath;
      if ((k !== old && !byPath) || !leadsHere(l.target, before)) return null;
      const options = byPath && newPath ? [newPath, newTitle] : [newTitle, ...(newPath ? [newPath] : [])];
      const target = options.find((t) => leadsHere(t, after));
      return target ? { target } : { target: row.slug, linkText: l.linkText ?? newTitle };
    }),
  );
}

/** Pages (outside the trash, not counting this one) with links that point to this one. */
export async function linkingPages(db: Db, pageId: string): Promise<WikiRow[]> {
  const ids = (
    await db.selectDistinct({ id: pageLinks.sourceId }).from(pageLinks).where(eq(pageLinks.targetId, pageId))
  ).map((r) => r.id);
  if (!ids.length) return [];
  return db
    .select()
    .from(knowledgePages)
    .where(and(inArray(knowledgePages.id, ids), isNull(knowledgePages.deletedAt)));
}
