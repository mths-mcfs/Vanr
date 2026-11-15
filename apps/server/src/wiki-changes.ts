// The wiki's index (index.md) and change log (log.md): an agent opens the wiki through the index (what
// exists, by folder, with one line of each page) and through the log (what changed, in order). Both come
// out of the database when read, for the reader: a page they don't read shows in neither. That is why they
// aren't stored pages: an `index` page of the workspace would show everyone the restricted pages' titles.
import type { ActorRef, WikiChange, WikiIndex } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { readablePagesSql, type WikiViewer } from "./wiki-access";

const { wikiChangeLog, knowledgePages } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;
type Action = (typeof wikiChangeLog.$inferInsert)["action"];

/** One line of the log, written in the transaction of the change it records. */
export async function logChange(
  db: Conn,
  e: {
    page: { id: string; workspaceId: string; title: string };
    action: Action;
    author: ActorRef & { actingFor?: string };
    at: Date;
    detail?: string | null;
  },
): Promise<void> {
  await db.insert(wikiChangeLog).values({
    id: newId("wchg"),
    workspaceId: e.page.workspaceId,
    pageId: e.page.id,
    action: e.action,
    title: e.page.title,
    author: e.author.actingFor
      ? { type: e.author.type, id: e.author.id, actingFor: e.author.actingFor }
      : { type: e.author.type, id: e.author.id },
    detail: e.detail ?? null,
    at: e.at,
  });
}

export const CHANGES_PAGE = 50;

/**
 * The log lines the reader sees, newest first. A page deleted for good leaves the log (its rows lose the
 * page, and who read it can no longer be known); one in the trash shows without a link.
 */
export async function readChanges(
  db: Db,
  viewer: WikiViewer,
  opts: { before?: Date; limit?: number } = {},
): Promise<WikiChange[]> {
  const rows = await db
    .select({ log: wikiChangeLog, slug: knowledgePages.slug, trashed: knowledgePages.deletedAt })
    .from(wikiChangeLog)
    .innerJoin(knowledgePages, eq(knowledgePages.id, wikiChangeLog.pageId))
    .where(
      and(
        eq(wikiChangeLog.workspaceId, viewer.workspaceId),
        eq(knowledgePages.workspaceId, viewer.workspaceId),
        readablePagesSql(viewer),
        opts.before ? lt(wikiChangeLog.at, opts.before) : undefined,
      ),
    )
    .orderBy(desc(wikiChangeLog.at), desc(wikiChangeLog.id))
    .limit(opts.limit ?? CHANGES_PAGE);
  return rows.map((r) => ({
    id: r.log.id,
    action: r.log.action,
    title: r.log.title,
    slug: r.trashed ? null : r.slug,
    author: r.log.author,
    detail: r.log.detail,
    at: r.log.at.toISOString(),
  }));
}

const SUMMARY = 140;

/**
 * A page's summary line: the first paragraph that isn't a heading, without markup, up to 140 characters
 * (with only headings, the first of them).
 */
export function summaryLine(body: string): string {
  const paragraphs = body.replace(/^---\n[\s\S]*?\n---\n/, "").split(/\n\s*\n/);
  const prose = paragraphs.filter((p) => !/^\s*#{1,6}\s/.test(p));
  const text = (prose.length ? prose : paragraphs)
    .map((p) =>
      p
        .replace(/^#{1,6}\s+/gm, "")
        .replace(
          /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g,
          (_m, t: string, a?: string) => a ?? t,
        )
        .replace(/[*_`>~]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((p) => p.length > 0);
  if (!text) return "";
  return text.length > SUMMARY ? `${text.slice(0, SUMMARY - 1)}…` : text;
}

/** index.md: the pages the reader reads, by folder, each with its link and a summary line. */
export async function readIndex(db: Db, viewer: WikiViewer): Promise<WikiIndex> {
  const pages = await db
    .select({
      slug: knowledgePages.slug,
      title: knowledgePages.title,
      folder: knowledgePages.folder,
      body: knowledgePages.body,
      updatedAt: knowledgePages.updatedAt,
    })
    .from(knowledgePages)
    .where(
      and(
        eq(knowledgePages.workspaceId, viewer.workspaceId),
        isNull(knowledgePages.deletedAt),
        readablePagesSql(viewer),
      ),
    )
    .orderBy(asc(knowledgePages.folder), asc(knowledgePages.title));
  const lines = ["# Index", ""];
  let folder: string | null = null;
  for (const p of pages) {
    if (p.folder !== folder) {
      folder = p.folder;
      lines.push(`## ${folder || "/"}`, "");
    }
    const summary = summaryLine(p.body);
    lines.push(`- [[${p.title}]]${summary ? ` — ${summary}` : ""}`);
  }
  if (pages.length === 0) lines.push("(no pages yet)");
  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    pages: pages.length,
    updatedAt:
      pages
        .reduce<Date | null>((acc, p) => (!acc || p.updatedAt > acc ? p.updatedAt : acc), null)
        ?.toISOString() ?? null,
  };
}
