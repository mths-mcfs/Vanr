// Bases: the routes under /bases (/databases is the workspace's external databases). Everything is inside
// the workspace; a source and a row only show through the database that owns them or a view linked to them
// (core.tableIn). Every member reads and writes a base; deleting one is for its creator or an admin.
import type { ActorRef } from "@vanr/contract";
import {
  effectiveFilter,
  filterSchema,
  sortSchema,
  VIEW_TYPES,
  type ViewConfig,
} from "@vanr/engine/bases/view";
import { schema } from "@vanr/engine/db";
import { isStorable, MAX_PROPS, propDefSchema } from "@vanr/engine/props";
import { and, desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { type ZodType, z } from "zod";
import {
  databaseById,
  MAX_BODY,
  publishBase,
  requireDeleter,
  rowIn,
  tableIn,
  toBase,
  toRow,
  toSummaries,
  toTable,
  toView,
} from "../bases/core";
import { createFromCsv, databaseFromFile, exportCsv, importCsv } from "../bases/io";
import { queryRows } from "../bases/query";
import {
  createDatabase,
  createRow,
  createView,
  deleteDatabase,
  deleteRows,
  deleteView,
  refreshVolatile,
  saveSchema,
  touchDatabase,
  updateRow,
  updateView,
  viewIn,
} from "../bases/write";
import type { AppEnv, Ctx, WorkspaceMember } from "../context";
import { HttpError, notFound, param, readJson } from "../http";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { dbDatabases, dbTables } = schema;
const B = `${WORKSPACE}/bases`;
const me$ = (me: WorkspaceMember): ActorRef => ({ type: "person", id: me.userId });
const title = z.string().trim().min(1).max(200);
const icon = z.string().max(40).nullable();
const id = z.string().min(1).max(100);
/** A CSV in the JSON body: up to 10 MB of text (the reader rejects more than that). */
const csv = z.string().min(1).max(10_000_000);

// A NUL or half a surrogate pair doesn't go into Postgres (the insert and the LIKE would give a 500): the edge rejects it.
async function readBody<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const body = await readJson(c, schema);
  if (!isStorable(body))
    throw new HttpError(400, "base.invalid_text", "Text with a NUL or a broken character");
  return body;
}
function idOf(c: Context, name: string): string {
  const value = param(c, name);
  if (!isStorable(value)) throw notFound("Not found");
  return value;
}

async function database(c: Ctx, me: WorkspaceMember) {
  return databaseById(c.get("deps").db, me.workspaceId, idOf(c, "baseId"));
}

export function registerBases(app: Hono<AppEnv>) {
  app.get(B, async (c) => {
    const me = requireMember(c);
    const { db } = c.get("deps");
    const rows = await db
      .select()
      .from(dbDatabases)
      .where(eq(dbDatabases.workspaceId, me.workspaceId))
      .orderBy(desc(dbDatabases.updatedAt))
      .limit(500);
    return c.json({ bases: await toSummaries(db, rows) });
  });

  app.post(B, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readBody(
      c,
      z
        .object({
          title,
          icon: icon.optional(),
          pageSlug: z.string().min(1).max(120).optional(),
          linkedTableId: id.optional(),
          titleName: z.string().trim().min(1).max(100).optional(),
        })
        .strict(),
    );
    const row = await createDatabase(deps, { workspaceId: me.workspaceId, actor: me$(me), ...input });
    return c.json(await toBase(deps.db, row, me), 201);
  });

  app.post(`${B}/import`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readBody(c, z.object({ title, csv }).strict());
    const row = await createFromCsv(deps, me.workspaceId, input.title, input.csv, me$(me));
    return c.json(await toBase(deps.db, row, me), 201);
  });

  app.post(`${B}/from-file`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { fileId } = await readBody(c, z.object({ fileId: id }).strict());
    const row = await databaseFromFile(deps, me.workspaceId, fileId, me$(me));
    return c.json(await toBase(deps.db, row, me), 201);
  });

  app.get(`${B}/:baseId`, async (c) => {
    const me = requireMember(c);
    return c.json(await toBase(c.get("deps").db, await database(c, me), me));
  });

  app.patch(`${B}/:baseId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const input = await readBody(c, z.object({ title: title.optional(), icon: icon.optional() }).strict());
    const [saved] = await deps.db
      .update(dbDatabases)
      .set({ ...input, updatedAt: deps.now() })
      .where(eq(dbDatabases.id, row.id))
      .returning();
    publishBase(deps, me.workspaceId, row.id);
    return c.json(await toBase(deps.db, saved ?? row, me));
  });

  app.delete(`${B}/:baseId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    requireDeleter(row, me);
    await deleteDatabase(deps, row);
    return c.body(null, 204);
  });

  app.put(`${B}/:baseId/tables/:tableId/schema`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const table = await tableIn(deps.db, me.workspaceId, row.id, idOf(c, "tableId"));
    const input = await readBody(
      c,
      z
        .object({
          defs: z.array(propDefSchema).min(1).max(MAX_PROPS),
          parentVersion: z.number().int().min(1),
        })
        .strict(),
    );
    const saved = await saveSchema(deps, table, input);
    return c.json(toTable(saved));
  });

  app.post(`${B}/:baseId/tables/:tableId/query`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    let table = await tableIn(deps.db, me.workspaceId, row.id, idOf(c, "tableId"));
    const q = await readBody(
      c,
      z
        .object({
          viewId: id.optional(),
          filter: filterSchema.nullable().optional(),
          sorts: z.array(sortSchema).max(10).optional(),
          groupBy: z.object({ prop: id, hideEmpty: z.boolean().optional() }).strict().nullable().optional(),
          search: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          cursor: z.string().max(20).nullable().optional(),
        })
        .strict(),
    );
    table = await refreshVolatile(deps, table);
    let cfg: ViewConfig = {};
    if (q.viewId) {
      const view = await viewIn(deps.db, row, q.viewId);
      if (view.tableId !== table.id)
        throw new HttpError(400, "base.view_table", "This view shows another table");
      cfg = view.config;
    }
    const filter = q.filter !== undefined ? q.filter : effectiveFilter(cfg);
    const page = await queryRows(
      deps.db,
      table,
      {
        filter,
        sorts: q.sorts ?? cfg.sorts,
        groupBy: q.groupBy !== undefined ? q.groupBy : (cfg.groupBy ?? null),
        search: q.search,
        limit: q.limit,
        cursor: q.cursor,
      },
      { now: deps.now().getTime(), me: me$(me) },
    );
    return c.json({
      rows: page.rows.map((r) => toRow(r, table.databaseId)),
      total: page.total,
      nextCursor: page.nextCursor,
      ...(page.groups ? { groups: page.groups } : {}),
    });
  });

  const rowInput = {
    props: z.record(z.string().max(64), z.unknown()).optional(),
    body: z.string().max(MAX_BODY).optional(),
    afterId: id.nullable().optional(),
    beforeId: id.nullable().optional(),
  };

  app.post(`${B}/:baseId/tables/:tableId/rows`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const table = await tableIn(deps.db, me.workspaceId, row.id, idOf(c, "tableId"));
    const input = await readBody(c, z.object(rowInput).strict());
    const created = await createRow(deps, table, { ...input, actor: me$(me) });
    await touchDatabase(deps.db, table.databaseId, deps.now());
    return c.json(toRow(created, table.databaseId), 201);
  });

  app.get(`${B}/:baseId/rows/:rowId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const db = await database(c, me);
    const { row, table } = await rowIn(deps.db, me.workspaceId, db.id, idOf(c, "rowId"));
    return c.json({ ...toRow(row, table.databaseId), body: row.body ?? "" });
  });

  app.patch(`${B}/:baseId/rows/:rowId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const db = await database(c, me);
    const { row, table } = await rowIn(deps.db, me.workspaceId, db.id, idOf(c, "rowId"));
    const input = await readBody(
      c,
      z.object({ ...rowInput, parentVersion: z.number().int().min(1).optional() }).strict(),
    );
    const { row: saved } = await updateRow(deps, table, row.id, { ...input, actor: me$(me) });
    await touchDatabase(deps.db, table.databaseId, deps.now());
    return c.json(toRow(saved, table.databaseId));
  });

  app.delete(`${B}/:baseId/rows/:rowId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const db = await database(c, me);
    const { row, table } = await rowIn(deps.db, me.workspaceId, db.id, idOf(c, "rowId"));
    await deleteRows(deps, table, [row.id], me$(me));
    return c.body(null, 204);
  });

  const viewType = z.enum(VIEW_TYPES);

  app.post(`${B}/:baseId/views`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const input = await readBody(
      c,
      z
        .object({
          tableId: id,
          name: z.string().trim().max(100),
          type: viewType,
          config: z.unknown().optional(),
        })
        .strict(),
    );
    // a source of this database or of another one of the workspace (a linked view)
    const [table] = await deps.db
      .select()
      .from(dbTables)
      .where(and(eq(dbTables.id, input.tableId), eq(dbTables.workspaceId, me.workspaceId)));
    if (!table) throw notFound("Table not found");
    const view = await createView(deps, row, table, input);
    return c.json(toView(view), 201);
  });

  app.patch(`${B}/:baseId/views/:viewId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const view = await viewIn(deps.db, row, idOf(c, "viewId"));
    const table = await tableIn(deps.db, me.workspaceId, row.id, view.tableId);
    const input = await readBody(
      c,
      z
        .object({
          name: z.string().trim().max(100).optional(),
          type: viewType.optional(),
          config: z.unknown().optional(),
          afterId: id.nullable().optional(),
        })
        .strict(),
    );
    return c.json(toView(await updateView(deps, row, view, table, input)));
  });

  app.delete(`${B}/:baseId/views/:viewId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const view = await viewIn(deps.db, row, idOf(c, "viewId"));
    await deleteView(deps, row, view);
    return c.body(null, 204);
  });

  app.post(`${B}/:baseId/tables/:tableId/import`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const table = await tableIn(deps.db, me.workspaceId, row.id, idOf(c, "tableId"));
    const input = await readBody(c, z.object({ csv }).strict());
    const r = await importCsv(deps, table, input.csv, me$(me));
    return c.json({
      created: r.created,
      skipped: r.skipped,
      addedProps: r.addedProps,
      table: toTable(r.table),
    });
  });

  app.post(`${B}/:baseId/tables/:tableId/export`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await database(c, me);
    const table = await tableIn(deps.db, me.workspaceId, row.id, idOf(c, "tableId"));
    const { viewId } = await readBody(c, z.object({ viewId: id.optional() }).strict());
    const view = viewId ? await viewIn(deps.db, row, viewId) : null;
    return c.json(await exportCsv(deps, table, view, me$(me)));
  });
}
