// Wiki: tree, page, search, create, edit with a version, rename (rewriting the [[links]]), move, lock, pin,
// trash, history with diff and restore, properties, links panel, live draft, graph, the pages agents read
// most and the Obsidian vault (zip). Saving a quote from a message, debate or assignment (`append`) comes
// with the slice of the chat, debates and assignments routes.
import type {
  ActorRef,
  WikiDecision,
  WikiDiff,
  WikiGraph,
  WikiPage,
  WikiTopRead,
  WikiTrashedPage,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { PROP_TYPES, propText } from "@vanr/engine/props";
import { diffText } from "@vanr/engine/wiki/diff";
import { and, desc, eq, gte, ilike, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx, WorkspaceMember } from "../context";
import { type Form, readFormFile } from "../drive";
import { forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { unindex } from "../search-index";
import {
  accessManagerOnly,
  adminOnly,
  allPages,
  createPage,
  historyOf,
  MAX_BODY,
  memberOnly,
  normalizeFolder,
  pageBySlug,
  patchPage,
  propSchemaOf,
  purgePage,
  requireDeleter,
  restrictedSlug,
  savePage,
  savePropSchema,
  toPage,
  toSummary,
  trashPage,
  unlockedFor,
  untrashPage,
  viewerOf,
  type WikiRow,
  writeProps,
} from "../wiki";
import { canReadPage, parseAccess, readablePagesSql } from "../wiki-access";
import {
  annotationsOf,
  createComment,
  decideProposal,
  deleteComment,
  MAX_QUOTE,
  resolveComment,
} from "../wiki-annotations";
import { CHANGES_PAGE, logChange, readChanges, readIndex } from "../wiki-changes";
import { CHECK_NOW_GAP_MS, checkWorkspace, readChecks } from "../wiki-checks";
import { linkingPages, panelOf, planRenames } from "../wiki-links";
import { attachmentsOf, exportVault, importVault, unzipVault } from "../wiki-vault";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { knowledgePages, pageRevisions, wikiPageViews, pageLinks } = schema;
const me$ = (me: WorkspaceMember): ActorRef => ({ type: "person", id: me.userId });
const title = z.string().trim().min(1).max(200);
const tags = z.array(z.string().max(60)).max(40);
const altTitles = z.array(z.string().max(200)).max(20);
const folder = z.string().max(300);
const isAdmin = (me: WorkspaceMember) => can(me.role, "configure");

const propDef = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(80),
    type: z.enum(PROP_TYPES),
    options: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            name: z.string().trim().min(1).max(100),
            color: z.string().max(32).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    groups: z
      .object({ todo: z.array(z.string()), inProgress: z.array(z.string()), done: z.array(z.string()) })
      .strict()
      .optional(),
    numberFormat: z.enum(["plain", "percent", "currency_brl", "currency_usd"]).optional(),
    withTime: z.boolean().optional(),
  })
  .strict();

/**
 * The page of the path (`:pageId` is the page's slug, which stays across renames), among the pages the
 * person reads: a restricted page they don't read is 404, like one that doesn't exist.
 */
async function page(c: Ctx, me: WorkspaceMember) {
  return pageBySlug(c.get("deps").db, viewerOf(me), param(c, "pageId"));
}

const accessInput = z.union([
  z.null(),
  z.object({ kind: z.literal("channel"), channelId: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal("private"),
      userIds: z.array(z.string().min(1).max(64)).max(200),
      agentIds: z.array(z.string().min(1).max(64)).max(100),
    })
    .strict(),
]);

const anchorInput = z
  .object({
    quote: z.string().min(1).max(MAX_QUOTE),
    prefix: z.string().max(64),
    suffix: z.string().max(64),
  })
  .strict();

async function versionRow(c: Ctx, row: WikiRow, version: number) {
  if (!Number.isInteger(version) || version < 1) throw notFound("Version not found");
  const [v] = await c
    .get("deps")
    .db.select()
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, row.id), eq(pageRevisions.version, version)));
  if (!v) throw notFound("Version not found");
  return v;
}

export function registerWiki(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/wiki/pages`, async (c) => {
    const me = requireMember(c);
    const pages = await allPages(c.get("deps").db, viewerOf(me));
    return c.json({ pages: pages.map(toSummary) });
  });

  app.get(`${WORKSPACE}/wiki/search`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const { q } = readQuery(c, z.object({ q: z.string().trim().max(200).default("") }));
    if (!q) return c.json({ pages: [] });
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const rows = await db
      .select()
      .from(knowledgePages)
      .where(
        and(
          eq(knowledgePages.workspaceId, me.workspaceId),
          isNull(knowledgePages.deletedAt),
          readablePagesSql(viewerOf(me)),
          or(
            ilike(knowledgePages.title, like),
            ilike(knowledgePages.body, like),
            sql`${knowledgePages.tags}::text ilike ${like}`,
            sql`${knowledgePages.aliases}::text ilike ${like}`,
          ),
        ),
      )
      // A title (or alternate title) that matches comes before the body.
      .orderBy(
        sql`case when ${knowledgePages.title} ilike ${like} or ${knowledgePages.aliases}::text ilike ${like} then 0 else 1 end`,
        desc(knowledgePages.updatedAt),
      )
      .limit(50);
    return c.json({ pages: rows.map(toSummary) });
  });

  app.post(`${WORKSPACE}/wiki/pages`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          title,
          folder: folder.optional(),
          body: z.string().max(MAX_BODY).optional(),
          tags: tags.optional(),
          altTitles: altTitles.optional(),
          props: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    );
    const props = input.props
      ? writeProps((await propSchemaOf(deps.db, me.workspaceId)).defs, {}, input.props)
      : undefined;
    const row = await createPage(deps, {
      workspaceId: me.workspaceId,
      title: input.title,
      folder: input.folder,
      body: input.body,
      tags: input.tags,
      aliases: input.altTitles,
      props,
      author: me$(me),
    });
    return c.json(await toPage(deps.db, row, me), 201);
  });

  app.get(`${WORKSPACE}/wiki/pages/:pageId`, async (c) => {
    const me = requireMember(c);
    return c.json(await toPage(c.get("deps").db, await page(c, me), me));
  });

  app.put(`${WORKSPACE}/wiki/pages/:pageId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const input = await readJson(
      c,
      z
        .object({
          body: z.string().max(MAX_BODY),
          parentVersion: z.number().int().min(1),
          folder: folder.optional(),
          tags: tags.optional(),
          note: z.string().trim().max(300).optional(),
        })
        .strict(),
    );
    const saved = await savePage(deps, {
      row,
      author: me$(me),
      canBypassLock: isAdmin(me),
      ...input,
    });
    return c.json(await toPage(deps.db, saved, me));
  });

  // Properties, alternate titles and tags: a partial write, with a new version and 409 on a stale parent.
  app.patch(`${WORKSPACE}/wiki/pages/:pageId/meta`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const input = await readJson(
      c,
      z
        .object({
          parentVersion: z.number().int().min(1),
          props: z.record(z.string(), z.unknown()).optional(),
          altTitles: altTitles.optional(),
          tags: tags.optional(),
          agentEdits: z.enum(["direct", "propose"]).optional(),
        })
        .strict(),
    );
    // How an agent changes the page is not a version: whoever may edit the page picks it.
    let current = row;
    if (input.agentEdits && input.agentEdits !== row.agentEdits)
      current = await patchPage(deps, row, { agentEdits: input.agentEdits }, unlockedFor(me$(me)));
    if (!input.props && !input.altTitles && !input.tags) return c.json(await toPage(deps.db, current, me));
    const props = input.props
      ? writeProps((await propSchemaOf(deps.db, me.workspaceId)).defs, row.props, input.props)
      : undefined;
    const saved = await savePage(deps, {
      row: current,
      author: me$(me),
      canBypassLock: isAdmin(me),
      parentVersion: input.parentVersion,
      props,
      aliases: input.altTitles,
      tags: input.tags,
      note: "meta",
    });
    return c.json(await toPage(deps.db, saved, me));
  });

  // The slug stays: addresses keep working. The [[links]] by the old title are rewritten in the pages that
  // point to this one; the ones that can't be rewritten (locked page) keep working because the old title
  // becomes an alternate title.
  app.post(`${WORKSPACE}/wiki/pages/:pageId/rename`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const input = await readJson(c, z.object({ title }).strict());
    if (input.title === row.title) return c.json(await toPage(deps.db, row, me));
    if (row.locked && !isAdmin(me)) throw new HttpError(403, "wiki.page_locked", "This page is locked");
    const linkers = (await linkingPages(deps.db, row.id)).filter((p) => p.id !== row.id);
    const rewritten: { slug: string; title: string }[] = [];
    const skipped: { slug: string; title: string }[] = [];
    const [self, ...planned] = await planRenames(deps.db, row, input.title, [
      row.body,
      ...linkers.map((p) => p.body),
    ]);
    const plans = linkers.map((p, i) => ({ p, plan: planned[i] ?? { md: p.body, count: 0 } }));
    const blocked = plans.filter(({ p, plan }) => plan.count > 0 && p.locked && !isAdmin(me));
    const saved = await savePage(deps, {
      row,
      author: me$(me),
      canBypassLock: isAdmin(me),
      title: input.title,
      body: self?.md ?? row.body,
      aliases: blocked.length ? [...row.aliases, row.title] : undefined,
      note: `renamed from "${row.title}"`,
    });
    for (const { p, plan } of plans) {
      if (plan.count === 0) continue;
      if (blocked.some((b) => b.p.id === p.id) || plan.md.length > MAX_BODY) {
        skipped.push({ slug: p.slug, title: p.title });
        continue;
      }
      try {
        await savePage(deps, {
          row: p,
          author: me$(me),
          canBypassLock: isAdmin(me),
          parentVersion: p.version,
          body: plan.md,
          note: `link: "${row.title}" → "${input.title}"`,
        });
        rewritten.push({ slug: p.slug, title: p.title });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        skipped.push({ slug: p.slug, title: p.title });
      }
    }
    // A page that couldn't be rewritten (a newer version in between) keeps pointing to the old title: it
    // becomes an alternate title, as on the locked ones, so the link doesn't break.
    let final = saved;
    const oldName = row.title.toLowerCase();
    if (skipped.length && !final.aliases.some((a) => a.toLowerCase() === oldName)) {
      final = await savePage(deps, {
        row: final,
        author: me$(me),
        canBypassLock: isAdmin(me),
        aliases: [...final.aliases, row.title],
        note: "meta",
      });
    }
    // The relinking holds in every page that links here; the answer names only the ones the person reads.
    const readable = new Set(
      (
        await Promise.all(
          linkers.map(async (p) => ((await canReadPage(deps.db, viewerOf(me), p)) ? p.slug : null)),
        )
      ).filter((x): x is string => x !== null),
    );
    const out: WikiPage = {
      ...(await toPage(deps.db, final, me)),
      relinked: {
        rewritten: rewritten.filter((p) => readable.has(p.slug)),
        skipped: skipped.filter((p) => readable.has(p.slug)),
      },
    };
    return c.json(out);
  });

  app.post(`${WORKSPACE}/wiki/pages/:pageId/move`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const input = await readJson(c, z.object({ folder }).strict());
    if (row.locked && !isAdmin(me)) throw new HttpError(403, "wiki.page_locked", "This page is locked");
    const moved = await patchPage(
      deps,
      row,
      { folder: normalizeFolder(input.folder), updatedBy: me$(me) },
      unlockedFor(me$(me)),
    );
    if (moved.folder !== row.folder)
      await logChange(deps.db, {
        page: moved,
        action: "move",
        author: me$(me),
        at: deps.now(),
        detail: moved.folder,
      });
    return c.json(await toPage(deps.db, moved, me));
  });

  app.post(`${WORKSPACE}/wiki/pages/:pageId/lock`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    if (!isAdmin(me)) throw forbidden("Only admins can lock pages");
    const row = await page(c, me);
    const { locked } = await readJson(c, z.object({ locked: z.boolean() }).strict());
    const updated = await patchPage(deps, row, { locked }, adminOnly(me$(me)));
    return c.json(await toPage(deps.db, updated, me));
  });

  app.post(`${WORKSPACE}/wiki/pages/:pageId/pin`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const { pinned } = await readJson(c, z.object({ pinned: z.boolean() }).strict());
    return c.json(await toPage(deps.db, await patchPage(deps, row, { pinned }, memberOnly(me$(me))), me));
  });

  // Deleting sends it to the trash (30 days). Deleting for good is in the trash.
  app.delete(`${WORKSPACE}/wiki/pages/:pageId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    await trashPage(deps, row, me);
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/wiki/trash`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(knowledgePages)
      .where(
        and(
          eq(knowledgePages.workspaceId, me.workspaceId),
          isNotNull(knowledgePages.deletedAt),
          readablePagesSql(viewerOf(me)),
        ),
      )
      .orderBy(desc(knowledgePages.deletedAt))
      .limit(500);
    const out: WikiTrashedPage[] = [];
    for (const r of rows) {
      const canPurge = await requireDeleter(deps.db, r, me).then(
        () => true,
        () => false,
      );
      const deletedAt = r.deletedAt ?? deps.now();
      out.push({
        slug: r.slug,
        title: r.title,
        folder: r.folder,
        deletedAt: deletedAt.toISOString(),
        deletedBy: r.deletedBy ?? null,
        expungeAt: (r.expungeAt ?? deletedAt).toISOString(),
        canPurge,
      });
    }
    return c.json({ pages: out });
  });

  app.post(`${WORKSPACE}/wiki/trash/:trashId/restore`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await pageBySlug(deps.db, viewerOf(me), param(c, "trashId"), { trashed: true });
    return c.json(await toPage(deps.db, await untrashPage(deps, row, me), me));
  });

  app.delete(`${WORKSPACE}/wiki/trash/:trashId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await pageBySlug(deps.db, viewerOf(me), param(c, "trashId"), { trashed: true });
    await purgePage(deps, row, me);
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/wiki/pages/:pageId/history`, async (c) => {
    const me = requireMember(c);
    const row = await page(c, me);
    return c.json({ versions: await historyOf(c.get("deps").db, row.id) });
  });

  app.get(`${WORKSPACE}/wiki/pages/:pageId/versions/:versionId`, async (c) => {
    const me = requireMember(c);
    const row = await page(c, me);
    const v = await versionRow(c, row, Number(param(c, "versionId")));
    return c.json({ version: v.version, body: v.body });
  });

  // The difference between two versions (by default: the previous and the current), with the properties
  // that changed.
  app.get(`${WORKSPACE}/wiki/pages/:pageId/diff`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const q = readQuery(
      c,
      z.object({
        from: z.coerce.number().int().min(1).optional(),
        to: z.coerce.number().int().min(1).optional(),
      }),
    );
    const toV = q.to ?? row.version;
    const fromV = q.from ?? Math.max(1, toV - 1);
    const [a, b] = await Promise.all([versionRow(c, row, fromV), versionRow(c, row, toV)]);
    const { defs } = await propSchemaOf(deps.db, me.workspaceId);
    const d = diffText(a.body, b.body);
    const props: WikiDiff["props"] = [];
    const pa = a.props ?? {};
    const pb = b.props ?? {};
    for (const def of defs) {
      const before = pa[def.id] === undefined ? "" : propText(def, pa[def.id] ?? null);
      const after = pb[def.id] === undefined ? "" : propText(def, pb[def.id] ?? null);
      if (before !== after) props.push({ propId: def.id, name: def.name, before, after });
    }
    const view = (v: typeof a) => ({
      version: v.version,
      author: v.author,
      at: v.createdAt.toISOString(),
      note: v.note,
      title: v.title,
    });
    const out: WikiDiff = {
      from: view(a),
      to: view(b),
      lines: d.rows,
      props,
      stats: { added: d.added, removed: d.removed },
    };
    return c.json(out);
  });

  // Restoring creates a new version with the old one's body and properties (nothing is lost).
  app.post(`${WORKSPACE}/wiki/pages/:pageId/versions/:versionId/restore`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const v = await versionRow(c, row, Number(param(c, "versionId")));
    const { parentVersion } = await readJson(
      c,
      z.object({ parentVersion: z.number().int().min(1) }).strict(),
    );
    const saved = await savePage(deps, {
      row,
      author: me$(me),
      canBypassLock: isAdmin(me),
      parentVersion,
      body: v.body,
      props: v.props ?? undefined,
      note: `restore:v${v.version}`,
    });
    return c.json(await toPage(deps.db, saved, me));
  });

  app.get(`${WORKSPACE}/wiki/pages/:pageId/panel`, async (c) => {
    const me = requireMember(c);
    return c.json(await panelOf(c.get("deps").db, await page(c, me), viewerOf(me)));
  });

  // Live draft: publish now (the button) or throw it away.
  app.post(`${WORKSPACE}/wiki/pages/:pageId/draft/publish`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const { force } = await readJson(c, z.object({ force: z.boolean().optional() }).strict());
    if (row.locked && !isAdmin(me)) throw new HttpError(403, "wiki.page_locked", "This page is locked");
    const saved = await deps.wikiLive.publish(row, me$(me), { force, canBypassLock: isAdmin(me) });
    return c.json(await toPage(deps.db, saved, me));
  });

  app.delete(`${WORKSPACE}/wiki/pages/:pageId/draft`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    if (row.locked && !isAdmin(me)) throw new HttpError(403, "wiki.page_locked", "This page is locked");
    await deps.wikiLive.discard(row, me$(me), isAdmin(me));
    return c.json(await toPage(deps.db, row, me));
  });

  // The pages' properties (seam 4): the definitions belong to the workspace.
  app.get(`${WORKSPACE}/wiki/props`, async (c) => {
    const me = requireMember(c);
    return c.json(await propSchemaOf(c.get("deps").db, me.workspaceId));
  });

  app.put(`${WORKSPACE}/wiki/props`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z.object({ defs: z.array(propDef).max(100), parentVersion: z.number().int().min(0) }).strict(),
    );
    const ids = new Set(input.defs.map((d) => d.id));
    const names = new Set(input.defs.map((d) => d.name.toLowerCase()));
    if (ids.size !== input.defs.length || names.size !== input.defs.length)
      throw new HttpError(400, "wiki.props.duplicate", "Property ids and names must be unique");
    return c.json(await savePropSchema(deps, me.workspaceId, input.defs, input.parentVersion, me$(me)));
  });

  // The graph: the whole wiki, or the local one around a page (`pageId`) up to `depth` steps. Only pages
  // the person reads and the links between them.
  app.get(`${WORKSPACE}/wiki/graph`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const q = readQuery(
      c,
      z.object({
        pageId: z.string().min(1).max(200).optional(),
        depth: z.coerce.number().int().min(1).max(3).default(1),
      }),
    );
    const pages = await allPages(db, viewerOf(me));
    const readable = new Set(pages.map((p) => p.slug));
    const target = alias(knowledgePages, "target");
    const all = await db
      .selectDistinct({ from: knowledgePages.slug, to: target.slug })
      .from(pageLinks)
      .innerJoin(knowledgePages, eq(knowledgePages.id, pageLinks.sourceId))
      .innerJoin(target, eq(target.id, pageLinks.targetId))
      .where(
        and(
          eq(pageLinks.workspaceId, me.workspaceId),
          ne(pageLinks.sourceId, target.id),
          isNull(knowledgePages.deletedAt),
          isNull(target.deletedAt),
        ),
      );
    let edges = all.filter((e) => readable.has(e.from) && readable.has(e.to));
    let nodes = pages;
    if (q.pageId) {
      if (!readable.has(q.pageId)) throw notFound("Page not found");
      const near = new Set([q.pageId]);
      let frontier = [q.pageId];
      for (let d = 0; d < q.depth && frontier.length; d++) {
        const next: string[] = [];
        for (const e of edges)
          for (const [a, b] of [
            [e.from, e.to],
            [e.to, e.from],
          ] as const)
            if (frontier.includes(a) && !near.has(b)) {
              near.add(b);
              next.push(b);
            }
        frontier = next;
      }
      nodes = pages.filter((p) => near.has(p.slug));
      edges = edges.filter((e) => near.has(e.from) && near.has(e.to));
    }
    const out: WikiGraph = {
      nodes: nodes.map((p) => ({ slug: p.slug, title: p.title, folder: p.folder })),
      edges,
      center: q.pageId ?? null,
    };
    return c.json(out);
  });

  // The pages agents read most in the last 7 days.
  app.get(`${WORKSPACE}/wiki/reads`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const since = new Date(deps.now().getTime() - 7 * 86_400_000);
    const rows = await deps.db
      .select({
        slug: knowledgePages.slug,
        title: knowledgePages.title,
        readerId: wikiPageViews.readerId,
        count: wikiPageViews.count,
      })
      .from(wikiPageViews)
      .innerJoin(knowledgePages, eq(knowledgePages.id, wikiPageViews.pageId))
      .where(
        and(
          eq(knowledgePages.workspaceId, me.workspaceId),
          isNull(knowledgePages.deletedAt),
          readablePagesSql(viewerOf(me)),
          eq(wikiPageViews.readerType, "agent"),
          gte(wikiPageViews.lastAt, since),
        ),
      );
    const bySlug = new Map<string, WikiTopRead>();
    for (const r of rows) {
      const top = bySlug.get(r.slug) ?? { slug: r.slug, title: r.title, total: 0, agents: [] };
      top.total += r.count;
      top.agents.push(r.readerId);
      bySlug.set(r.slug, top);
    }
    return c.json([...bySlug.values()].sort((a, b) => b.total - a.total).slice(0, 10));
  });

  // Loose notes (.md files read in the browser); the whole vault goes through the zip.
  app.post(`${WORKSPACE}/wiki/import`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          files: z
            .array(z.object({ path: z.string().min(1).max(500), text: z.string().max(MAX_BODY + 10_000) }))
            .min(1)
            .max(500),
          folder: folder.optional(),
        })
        .strict(),
    );
    const enc = new TextEncoder();
    const result = await importVault(deps, {
      workspaceId: me.workspaceId,
      author: me$(me),
      folder: input.folder,
      files: input.files
        .filter((f) => /\.md$/i.test(f.path))
        .map((f) => ({ path: f.path, bytes: enc.encode(f.text) })),
    });
    const skipped = input.files.filter((f) => !/\.md$/i.test(f.path)).length;
    return c.json({ created: result.created, skipped: result.skipped + skipped, failed: result.failed });
  });

  app.post(`${WORKSPACE}/wiki/import/vault`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    let form: Form;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw new HttpError(400, "file_required", "Send the zip as multipart/form-data");
    }
    const file = await readFormFile(form);
    const target = form.get("folder");
    // The zip is read whole, within the upload limit (readFormFile).
    const bytes = "bytes" in file ? file.bytes : new Uint8Array(await file.blob.arrayBuffer());
    const { entries, failed } = unzipVault(bytes);
    const result = await importVault(deps, {
      workspaceId: me.workspaceId,
      author: me$(me),
      folder: typeof target === "string" ? target.slice(0, 300) : undefined,
      files: entries,
      failed,
    });
    return c.json(result);
  });

  app.get(`${WORKSPACE}/wiki/export`, async (c) => {
    const me = requireMember(c);
    const zip = await exportVault(c.get("deps"), viewerOf(me));
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="wiki.zip"`,
        "Content-Length": String(zip.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  });

  app.get(`${WORKSPACE}/wiki/attachments`, async (c) => {
    const me = requireMember(c);
    return c.json({ attachments: await attachmentsOf(c.get("deps"), me.workspaceId) });
  });

  // Who reads the page: the workspace, whoever reads a channel, or a list of people and agents. Only who
  // created the page or an admin changes it (checked with the role read in the write's transaction).
  app.put(`${WORKSPACE}/wiki/pages/:pageId/access`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const { access } = await readJson(c, z.object({ access: accessInput }).strict());
    const next = await parseAccess(deps.db, me, access);
    // Restricting draws a new end for the slug: with the title's slug, someone else's new page with the same
    // title would become `-2` and confirm the restricted one exists.
    const slug = !row.access && next ? restrictedSlug(row.title) : undefined;
    const updated = await patchPage(
      deps,
      row,
      slug ? { access: next, slug } : { access: next },
      async (tx, p) => {
        await accessManagerOnly(me.userId)(tx, p);
        // The page leaves the search in the same commit; the reindex after it brings it back with the new
        // audience. If that reindex fails, the page is missing from the search, never shown to the old one.
        await unindex(tx, deps, { kind: "wiki", id: p.id });
      },
    );
    // Whoever is editing live and lost the read is closed now: patchPage checks the page's connections,
    // and a new slug leaves the ones at the old address to check here.
    if (updated.slug !== row.slug) await deps.wikiLive.recheckPage(row);
    return c.json(await toPage(deps.db, updated, me));
  });

  // The page's comments and proposals.
  app.get(`${WORKSPACE}/wiki/pages/:pageId/annotations`, async (c) => {
    const me = requireMember(c);
    return c.json(await annotationsOf(c.get("deps").db, await page(c, me)));
  });

  app.post(`${WORKSPACE}/wiki/pages/:pageId/comments`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await page(c, me);
    const input = await readJson(
      c,
      z
        .object({
          body: z.string().trim().min(1).max(10_000),
          anchor: anchorInput.optional(),
          parentId: z.string().min(1).max(64).optional(),
          agentId: z.string().min(1).max(64).optional(),
        })
        .strict(),
    );
    return c.json(await createComment(deps, me, row, input), 201);
  });

  // Resolving a thread is a state of it: PUT resolves, DELETE opens it again.
  app.put(`${WORKSPACE}/wiki/annotations/:annotationId/resolution`, async (c) => {
    const me = requireMember(c);
    return c.json(await resolveComment(c.get("deps"), me, param(c, "annotationId"), true));
  });

  app.delete(`${WORKSPACE}/wiki/annotations/:annotationId/resolution`, async (c) => {
    const me = requireMember(c);
    return c.json(await resolveComment(c.get("deps"), me, param(c, "annotationId"), false));
  });

  app.delete(`${WORKSPACE}/wiki/annotations/:annotationId`, async (c) => {
    const me = requireMember(c);
    await deleteComment(c.get("deps"), me, param(c, "annotationId"));
    return c.body(null, 204);
  });

  app.post(`${WORKSPACE}/wiki/annotations/:annotationId/decide`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z
        .object({
          decisions: z
            .array(z.object({ hunkId: z.string().min(1).max(16), accept: z.boolean() }).strict())
            .min(1)
            .max(50),
        })
        .strict(),
    );
    const { proposal, page: saved } = await decideProposal(
      deps,
      me,
      param(c, "annotationId"),
      input.decisions,
    );
    const out: WikiDecision = { proposal, page: await toPage(deps.db, saved, me) };
    return c.json(out);
  });

  // index.md and log.md, built for whoever reads.
  app.get(`${WORKSPACE}/wiki/index`, async (c) => {
    const me = requireMember(c);
    return c.json(await readIndex(c.get("deps").db, viewerOf(me)));
  });

  app.get(`${WORKSPACE}/wiki/changes`, async (c) => {
    const me = requireMember(c);
    const q = readQuery(
      c,
      z.object({
        before: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(CHANGES_PAGE),
      }),
    );
    const changes = await readChanges(c.get("deps").db, viewerOf(me), {
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit,
    });
    return c.json({ changes });
  });

  // The wiki check: the last result, and "run now" (once a minute per workspace).
  app.get(`${WORKSPACE}/wiki/checks`, async (c) => {
    const me = requireMember(c);
    return c.json(await readChecks(c.get("deps").db, viewerOf(me)));
  });

  app.post(`${WORKSPACE}/wiki/checks`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    // The model is looked up before the claim: until the runtime slice this answers `not_available`
    // with nothing written.
    const ran = await checkWorkspace(deps, me.workspaceId, {
      gapMs: CHECK_NOW_GAP_MS,
      model: () => deps.runtime.providerForWorkspace(me.workspaceId),
    });
    if (!ran) throw new HttpError(429, "wiki.checks.too_soon", "The wiki was checked less than a minute ago");
    return c.json(await readChecks(deps.db, viewerOf(me)));
  });
}
