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
import type { WikiRow } from "./wiki";

const { knowledgePages, pageLinks } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export type LinkTarget = Pick<WikiRow, "id" | "slug" | "title" | "folder" | "aliases">;

/** Ways of writing a page's target, in lowercase (without `.md`). */
export function namesOf(p: Pick<WikiRow, "slug" | "title" | "folder" | "aliases">): string[] {
  const t = p.title.toLowerCase();
  const out = new Set([p.slug, t, p.folder ? `${p.folder}/${p.title}`.toLowerCase() : t]);
  for (const a of p.aliases ?? []) out.add(a.toLowerCase());
  return [...out];
}

/** Pages that can be the target of these texts (lean query, no body). */
async function candidates(db: Conn, workspaceId: string, targets: string[]): Promise<LinkTarget[]> {
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
    })
    .from(knowledgePages)
    .where(
      and(
        eq(knowledgePages.workspaceId, workspaceId),
        isNull(knowledgePages.deletedAt),
        sql`(
          lower(${knowledgePages.title}) in ${titles}
          or ${knowledgePages.slug} in ${slugs}
          or exists (select 1 from jsonb_array_elements_text(${knowledgePages.aliases}) a where lower(a) in ${names})
        )`,
      ),
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
  await db.delete(pageLinks).where(eq(pageLinks.sourceId, page.id));
  if (!refs.length) return;
  const pages = await candidates(db, page.workspaceId, refs.map((r) => r.target).filter(Boolean));
  await db.insert(pageLinks).values(
    refs.map((r, ordinal) => ({
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
    })),
  );
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

/** Side panel: who points to the page, who cites it without a link, where it points and the outline. */
export async function panelOf(db: Db, row: WikiRow): Promise<WikiPanel> {
  // Backlinks: links of pages outside the trash that point to this one.
  const back = await db
    .select({
      slug: knowledgePages.slug,
      title: knowledgePages.title,
      body: knowledgePages.body,
      sourceId: pageLinks.sourceId,
      ordinal: pageLinks.ordinal,
    })
    .from(pageLinks)
    .innerJoin(knowledgePages, eq(knowledgePages.id, pageLinks.sourceId))
    .where(
      and(eq(pageLinks.targetId, row.id), ne(pageLinks.sourceId, row.id), isNull(knowledgePages.deletedAt)),
    )
    .orderBy(asc(knowledgePages.title), asc(pageLinks.ordinal));
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

  // Outgoing links, with the state of the destination and of the anchor.
  const outs = await db
    .select({
      link: pageLinks,
      target: {
        slug: knowledgePages.slug,
        title: knowledgePages.title,
        body: knowledgePages.body,
        deletedAt: knowledgePages.deletedAt,
      },
    })
    .from(pageLinks)
    .leftJoin(knowledgePages, eq(knowledgePages.id, pageLinks.targetId))
    .where(eq(pageLinks.sourceId, row.id))
    .orderBy(asc(pageLinks.ordinal));
  const outgoing: WikiPanel["outgoing"] = outs.map(({ link, target }) => {
    const self = link.targetId === row.id;
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
