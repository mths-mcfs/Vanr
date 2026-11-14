// Wiki: tree, page, search, create, edit with a version, rename (rewriting the [[links]]), move, lock, pin,
// trash, history with diff and restore, properties, links panel, live draft, graph, the pages agents read
// most and the Obsidian vault (zip). Saving a quote from a message, debate or assignment (`append`) comes
// with the slice of the chat, debates and assignments routes.
import type { ActorRef, WikiDiff, WikiPage, WikiTopRead, WikiTrashedPage } from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { PROP_TYPES, propText } from "@vanr/engine/props";
import { diffText } from "@vanr/engine/wiki/diff";
import { WIKI_PROP_LIMITS } from "@vanr/engine/wiki/props-vault";
import { and, desc, eq, gte, ilike, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx, WorkspaceMember } from "../context";
import { type Form, readFormFile } from "../drive";
import { badRequest, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import {
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
  rejectNul,
  requireDeleter,
  savePage,
  savePropSchema,
  toPage,
  toSummary,
  trashPage,
  unlockedFor,
  untrashPage,
  type WikiRow,
  writeProps,
} from "../wiki";
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
/** Versions and other numbers of the routes are Postgres integers: past 32 bits they are rejected here. */
const INT32_MAX = 2_147_483_647;
const version = z.number().int().min(1).max(INT32_MAX);
/** The largest JSON body a wiki route reads: room for an import of many notes at the page's cap. */
export const WIKI_JSON_BYTES = 32 * 1024 * 1024;

/** The request's body, read up to `max` bytes (413 past it, also when it comes without a length). */
async function cappedText(req: Request, max: number): Promise<string> {
  const tooLarge = () =>
    new HttpError(413, "payload_too_large", "The request is too large", { maxBytes: max });
  if (Number(req.headers.get("content-length") ?? 0) > max) throw tooLarge();
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.byteLength;
    if (size > max) throw tooLarge();
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

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
      .max(WIKI_PROP_LIMITS.options)
      .optional(),
    groups: z
      .object({ todo: z.array(z.string()), inProgress: z.array(z.string()), done: z.array(z.string()) })
      .strict()
      .optional(),
    numberFormat: z.enum(["plain", "percent", "currency_brl", "currency_usd"]).optional(),
    withTime: z.boolean().optional(),
  })
  .strict();

/** The page of the path (`:pageId` is the page's slug, which stays across renames). */
async function page(c: Ctx, me: WorkspaceMember) {
  return pageBySlug(c.get("deps").db, me.workspaceId, param(c, "pageId"));
}

async function versionRow(c: Ctx, row: WikiRow, version: number) {
  if (!Number.isInteger(version) || version < 1) throw notFound("Version not found");
  if (version > INT32_MAX) throw badRequest("Invalid version");
  const [v] = await c
    .get("deps")
    .db.select()
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, row.id), eq(pageRevisions.version, version)));
  if (!v) throw notFound("Version not found");
  return v;
}

export function registerWiki(app: Hono<AppEnv>) {
  // At the border of every wiki route: no NUL in the path, the query or the JSON body (Postgres text can't
  // hold it), and no JSON body past WIKI_JSON_BYTES. The body read here is the one the route reads after.
  app.use(`${WORKSPACE}/wiki/*`, async (c, next) => {
    const url = new URL(c.req.url);
    rejectNul([decoded(url.pathname), [...url.searchParams].flat()]);
    const type = c.req.header("content-type") ?? "";
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !type.startsWith("multipart/form-data")) {
      const text = await cappedText(c.req.raw, WIKI_JSON_BYTES);
      c.req.bodyCache.text = text;
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the route's own reading says so.
      }
      rejectNul(body);
    }
    await next();
  });

  app.get(`${WORKSPACE}/wiki/pages`, async (c) => {
    const me = requireMember(c);
    const pages = await allPages(c.get("deps").db, me.workspaceId);
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
          parentVersion: version,
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
          parentVersion: version,
          props: z.record(z.string(), z.unknown()).optional(),
          altTitles: altTitles.optional(),
          tags: tags.optional(),
        })
        .strict(),
    );
    const props = input.props
      ? writeProps((await propSchemaOf(deps.db, me.workspaceId)).defs, row.props, input.props)
      : undefined;
    const saved = await savePage(deps, {
      row,
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
    const out: WikiPage = { ...(await toPage(deps.db, final, me)), relinked: { rewritten, skipped } };
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
      .where(and(eq(knowledgePages.workspaceId, me.workspaceId), isNotNull(knowledgePages.deletedAt)))
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
    const row = await pageBySlug(deps.db, me.workspaceId, param(c, "trashId"), { trashed: true });
    return c.json(await toPage(deps.db, await untrashPage(deps, row, me), me));
  });

  app.delete(`${WORKSPACE}/wiki/trash/:trashId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await pageBySlug(deps.db, me.workspaceId, param(c, "trashId"), { trashed: true });
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
        from: z.coerce.number().int().min(1).max(INT32_MAX).optional(),
        to: z.coerce.number().int().min(1).max(INT32_MAX).optional(),
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
    const { parentVersion } = await readJson(c, z.object({ parentVersion: version }).strict());
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
    return c.json(await panelOf(c.get("deps").db, await page(c, me)));
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
      z
        .object({
          defs: z.array(propDef).max(WIKI_PROP_LIMITS.defs),
          parentVersion: z.number().int().min(0).max(INT32_MAX),
        })
        .strict(),
    );
    const ids = new Set(input.defs.map((d) => d.id));
    const names = new Set(input.defs.map((d) => d.name.toLowerCase()));
    if (ids.size !== input.defs.length || names.size !== input.defs.length)
      throw new HttpError(400, "wiki.props.duplicate", "Property ids and names must be unique");
    return c.json(await savePropSchema(deps, me.workspaceId, input.defs, input.parentVersion, me$(me)));
  });

  app.get(`${WORKSPACE}/wiki/graph`, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const pages = await allPages(db, me.workspaceId);
    const target = alias(knowledgePages, "target");
    const edges = await db
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
    return c.json({ nodes: pages.map((p) => ({ slug: p.slug, title: p.title, folder: p.folder })), edges });
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
    const zip = await exportVault(c.get("deps"), me.workspaceId);
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="wiki.zip"`,
        "Cache-Control": "private, no-store",
      },
    });
  });

  app.get(`${WORKSPACE}/wiki/attachments`, async (c) => {
    const me = requireMember(c);
    return c.json({ attachments: await attachmentsOf(c.get("deps"), me.workspaceId) });
  });
}
