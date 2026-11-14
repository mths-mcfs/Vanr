// Bases over HTTP: the API, the SQL query against the oracle, formulas and the recalculation (stopping the
// server halfway through it included), CSV, the Drive, isolation between workspaces, writes at the same time,
// the search and the undo of an agent's write. The workspace, its members, channels and wiki pages are rows
// seeded in the database (seed.ts): their routes come with later slices.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorRef } from "@vanr/contract";
import { type Filter, foldCase, rowMatches } from "@vanr/engine/bases/view";
import { openDb, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { Props } from "@vanr/engine/props";
import { and, eq, sql } from "drizzle-orm";
import { MAX_ROWS, type TableRow } from "../src/bases/core";
import { queryRows } from "../src/bases/query";
import { BASE_UNDOERS } from "../src/bases/undo";
import {
  createDatabase,
  createView,
  deleteView,
  importRows,
  resumeRecalcs,
  runRecalc,
} from "../src/bases/write";
import type { AppDeps } from "../src/context";
import { backfillSearch } from "../src/search-index";
import type { RunningServer } from "../src/server";
import { apiError, type BasesApi, basesApi, baseWithTypes, fuzzAgainstOracle } from "./bases-api";
import { Browser, body, SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

/** Rows straight into the domain (the import's path), without the CSV. */
const addRows = async (deps: AppDeps, table: TableRow, rows: { props: Props }[], actor: ActorRef) =>
  (await importRows(deps, table, { defs: null, rows: () => rows.map((r) => r.props), actor })).created;

let server: RunningServer;
let clock = Date.parse("2026-10-22T12:00:00Z");
/** What the search index keeps of the row: its chunks as they are in the database. */
const indexed = (rowId: string) =>
  server.deps.db
    .select()
    .from(schema.searchChunks)
    .where(and(eq(schema.searchChunks.sourceKind, "db_row"), eq(schema.searchChunks.sourceId, rowId)));

beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(clock) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@bases.test`;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

type Member = Person & { api: BasesApi };
const withApi = (p: Person): Member => ({ ...p, api: basesApi(p.browser) });

async function team() {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  return { workspaceId, general, ana, beto };
}

/** A Drive file created through its route. */
async function createFile(who: Person, workspaceId: string, input: Record<string, unknown>) {
  const res = await who.browser.json(`${W(workspaceId)}/files`, "POST", input);
  if (!res.ok) throw new Error(`file failed: ${res.status} ${await res.text()}`);
  return body(res);
}

/** A wiki page row, as the wiki route writes it (the wiki routes come with a later slice). */
async function seedPage(workspaceId: string, who: Person, title: string, opts: { trashed?: boolean } = {}) {
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${++n}`;
  await server.deps.db.insert(schema.knowledgePages).values({
    id: newId("kp"),
    workspaceId,
    slug,
    title,
    body: "text",
    updatedBy: { type: "person", id: who.user.id },
    ...(opts.trashed ? { deletedAt: new Date(clock) } : {}),
  });
  return { slug, title };
}

/** Everything the hub published to the workspace from now on, taken in order by type. */
function workspaceEvents(workspaceId: string) {
  const seen: Record<string, unknown>[] = [];
  const off = server.deps.hub.onPublish((target, event) => {
    if (target === `workspace:${workspaceId}`) seen.push(event);
  });
  return {
    event(type: string): Record<string, unknown> {
      const i = seen.findIndex((e) => e.type === type);
      if (i < 0) throw new Error(`no ${type} event (seen: ${seen.map((e) => e.type).join(", ")})`);
      const [found] = seen.splice(i, 1);
      return found ?? {};
    },
    close: off,
  };
}

describe("bases: API", () => {
  test(
    "creates, lists, a schema with every type, a row with a formula and the row version",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      expect(base.id.startsWith("dbs_")).toBe(true);
      expect(table.id.startsWith("dbt_")).toBe(true);
      expect(table.id).not.toBe(base.id);
      expect(table.schemaVersion).toBe(2);
      // the formula is kept with the reference by id and the inferred type
      const f = table.defs.find((d) => d.id === "p_f");
      expect(f?.formula).toEqual({ expression: 'prop("p_num") * 2', resultType: "number" });
      expect((await beto.api.list(workspaceId)).bases.map((b) => b.title)).toEqual(["Projects"]);

      const row = await beto.api.createRow(workspaceId, base.id, table.id, {
        props: {
          [table.titlePropId]: "New site",
          p_num: 21,
          p_sel: "o_b",
          p_multi: ["t_x", "t_y"],
          p_status: "s_doing",
          p_due: { start: "2026-11-01" },
          p_ok: true,
          p_who: [{ type: "person", id: ana.user.id }],
          p_url: "https://example.com",
        },
        body: "# Notes",
      });
      expect(row.id.startsWith("dbr_")).toBe(true);
      expect(row.computed.p_f).toBe(42);
      expect(row.createdBy).toEqual({ type: "person", id: beto.user.id });
      expect(row.version).toBe(1);
      expect(row.hasBody).toBe(true);

      const detail = await ana.api.getRow(workspaceId, base.id, row.id);
      expect(detail.body).toBe("# Notes");
      const edited = await ana.api.updateRow(workspaceId, base.id, row.id, {
        props: { p_num: 5 },
        parentVersion: 1,
      });
      expect(edited).toMatchObject({
        version: 2,
        computed: { p_f: 10 },
        editedBy: { type: "person", id: ana.user.id },
      });
      // Beto is still on version 1: 409 with the current row, nothing is overwritten
      const stale = await apiError(
        beto.api.updateRow(workspaceId, base.id, row.id, { props: { p_num: 7 }, parentVersion: 1 }),
      );
      expect(stale.status).toBe(409);
      expect(stale.code).toBe("base.row_conflict");
      expect((await ana.api.getRow(workspaceId, base.id, row.id)).props.p_num).toBe(5);

      // a schema read before another save conflicts too
      const schemaStale = await apiError(
        beto.api.saveSchema(workspaceId, base.id, table.id, { defs: table.defs, parentVersion: 1 }),
      );
      expect(schemaStale.code).toBe("base.schema_conflict");

      await ana.api.update(workspaceId, base.id, { title: "Projects 2026", icon: "📋" });
      expect((await beto.api.get(workspaceId, base.id)).title).toBe("Projects 2026");
      await beto.api.deleteRow(workspaceId, base.id, row.id);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "invalid values, a computed property and references from outside the workspace are rejected",
    async () => {
      const { workspaceId, ana } = await team();
      const other = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const write = (props: Record<string, unknown>) =>
        ana.api.createRow(workspaceId, base.id, table.id, { props });
      const outsiderFile = await createFile(other.ana, other.workspaceId, {
        title: "Secret",
        content: { kind: "document", markdown: "x" },
      });
      for (const props of [
        { p_sel: "o_missing" },
        { p_num: "twelve" },
        { p_f: 3 },
        { p_ct: "2026-01-01" },
        { unknown: 1 },
        { p_url: "javascript:alert(1)" },
        // a person and a file of another workspace: the id exists, but not in this workspace
        { p_who: [{ type: "person", id: other.ana.user.id }] },
        { p_file: [outsiderFile.id] },
      ]) {
        const err = await apiError(write(props));
        expect([err.status, err.code]).toEqual([400, "base.invalid_props"]);
      }
      const mine = await createFile(ana, workspaceId, {
        title: "Contract",
        content: { kind: "document", markdown: "y" },
      });
      expect((await write({ p_file: [mine.id] })).props.p_file).toEqual([mine.id]);
    },
    SERVER_TEST_MS,
  );

  test(
    "views: the filter, the order, the group, the columns and the quick filters are saved",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const t = table.titlePropId;
      for (const [name, num, status] of [
        ["c", 3, "s_todo"],
        ["a", 1, "s_done"],
        ["b", 2, "s_doing"],
        ["d", 4, "s_done"],
      ] as const) {
        await ana.api.createRow(workspaceId, base.id, table.id, {
          props: { [t]: name, p_num: num, p_status: status },
        });
      }
      const board = await ana.api.createView(workspaceId, base.id, {
        tableId: table.id,
        name: "Board",
        type: "board",
        config: {
          groupBy: { prop: "p_status" },
          sorts: [{ prop: "p_num", dir: "desc" }],
          columns: [{ prop: "p_num", width: 120 }],
          quickFilters: [{ prop: "p_num", op: "gte", value: 2 }],
        },
      });
      const grouped = await ana.api.query(workspaceId, base.id, table.id, { viewId: board.id });
      expect(grouped.groups).toEqual([
        { key: "s_todo", count: 1 },
        { key: "s_doing", count: 1 },
        { key: "s_done", count: 1 },
      ]);
      expect(grouped.rows.map((r) => r.props[t])).toEqual(["c", "b", "d"]);

      const list = await ana.api.createView(workspaceId, base.id, {
        tableId: table.id,
        name: "List",
        type: "list",
        config: {
          filter: { prop: "p_status", op: "group", value: "done" },
          sorts: [{ prop: t, dir: "asc" }],
        },
      });
      expect(
        (await ana.api.query(workspaceId, base.id, table.id, { viewId: list.id })).rows.map(
          (r) => r.props[t],
        ),
      ).toEqual(["a", "d"]);
      // the request's fields replace what is saved
      const all = await ana.api.query(workspaceId, base.id, table.id, { viewId: list.id, filter: null });
      expect(all.total).toBe(4);
      // a gallery and an unknown property
      await ana.api.updateView(workspaceId, base.id, list.id, {
        type: "gallery",
        name: "Gallery",
        afterId: null,
      });
      const bad = await apiError(
        ana.api.updateView(workspaceId, base.id, list.id, { config: { groupBy: { prop: "missing" } } }),
      );
      expect(bad.code).toBe("base.bad_view");
      const badFilter = await apiError(
        ana.api.query(workspaceId, base.id, table.id, {
          filter: { prop: "p_num", op: "contains", value: "1" },
        }),
      );
      expect(badFilter.code).toBe("base.bad_filter");

      const views = (await ana.api.get(workspaceId, base.id)).views;
      expect(views.map((v) => v.name)).toEqual(["Gallery", "", "Board"]);
      for (const v of views.slice(1)) await ana.api.deleteView(workspaceId, base.id, v.id);
      const last = await apiError(ana.api.deleteView(workspaceId, base.id, list.id));
      expect(last.code).toBe("base.last_view");
    },
    SERVER_TEST_MS,
  );

  test(
    "manual order: inserting after and before a row, paging by cursor",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Order" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const t = table.titlePropId;
      const a = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "a" } });
      const c = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "c" } });
      await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "b" }, afterId: a.id });
      await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "0" }, beforeId: a.id });
      await ana.api.updateRow(workspaceId, base.id, c.id, { beforeId: a.id });
      const titles = async () =>
        (await ana.api.query(workspaceId, base.id, table.id)).rows.map((r) => r.props[t]);
      expect(await titles()).toEqual(["0", "c", "a", "b"]);
      const p1 = await ana.api.query(workspaceId, base.id, table.id, { limit: 3 });
      expect(p1.nextCursor).toBe("3");
      const p2 = await ana.api.query(workspaceId, base.id, table.id, { limit: 3, cursor: p1.nextCursor });
      expect([...p1.rows, ...p2.rows].map((r) => r.props[t])).toEqual(["0", "c", "a", "b"]);
      expect((await ana.api.query(workspaceId, base.id, table.id, { search: "B" })).rows.length).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "a database inside a wiki page and a view linked to another database",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const other = await team();
      const page = await seedPage(workspaceId, ana, "Planning");
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Source");
      const inline = await ana.api.create(workspaceId, { title: "On the page", pageSlug: page.slug });
      expect(inline.page).toEqual({ slug: page.slug, title: "Planning" });
      const foreignPage = await seedPage(other.workspaceId, other.ana, "Outside");
      expect(
        (await apiError(ana.api.create(workspaceId, { title: "x", pageSlug: foreignPage.slug }))).status,
      ).toBe(404);
      // A page in the trash gets no new base.
      const trashed = await seedPage(workspaceId, ana, "Old draft", { trashed: true });
      expect(
        (await apiError(ana.api.create(workspaceId, { title: "x", pageSlug: trashed.slug }))).status,
      ).toBe(404);

      await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "row", p_num: 1 },
      });
      const linked = await beto.api.create(workspaceId, { title: "Linked", linkedTableId: table.id });
      expect(linked.kind).toBe("linked");
      expect(linked.tables.map((x) => x.id)).toEqual([table.id]);
      const viaLink = await beto.api.query(workspaceId, linked.id, table.id);
      expect(viaLink.total).toBe(1);
      const rowId = String(viaLink.rows[0]?.id);
      expect((await beto.api.getRow(workspaceId, linked.id, rowId)).props.p_num).toBe(1);
      // a database without a view of the source sees neither the source nor the row
      const unrelated = await beto.api.create(workspaceId, { title: "Other" });
      expect((await apiError(beto.api.query(workspaceId, unrelated.id, table.id))).status).toBe(404);
      expect((await apiError(beto.api.getRow(workspaceId, unrelated.id, rowId))).status).toBe(404);
      // a second linked view, by createView, in a database that already exists
      const v = await beto.api.createView(workspaceId, unrelated.id, {
        tableId: table.id,
        name: "Source",
        type: "table",
      });
      expect(v.tableId).toBe(table.id);
      expect((await beto.api.query(workspaceId, unrelated.id, table.id)).total).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "deleting: only its creator or an admin; the search and the linked views go with it",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "Indexed", p_num: 3 },
      });
      const [chunk] = await indexed(row.id);
      expect(chunk).toMatchObject({ title: "Indexed", scopeKind: "workspace", workspaceId });
      expect(chunk?.text).toContain("Double: 6");
      const err = await apiError(beto.api.remove(workspaceId, base.id));
      expect(err.status).toBe(403);
      expect((await beto.api.get(workspaceId, base.id)).deletable).toBe(false);
      expect((await ana.api.get(workspaceId, base.id)).deletable).toBe(true);
      await ana.api.remove(workspaceId, base.id);
      expect(await indexed(row.id)).toEqual([]);
      expect((await apiError(beto.api.get(workspaceId, base.id))).status).toBe(404);
      // an admin who didn't create it may delete it
      const kept = await beto.api.create(workspaceId, { title: "Beto's" });
      const caio = withApi(await memberOf(server, workspaceId, "Caio", email("caio"), "admin"));
      expect((await caio.api.get(workspaceId, kept.id)).deletable).toBe(true);
      await caio.api.remove(workspaceId, kept.id);
      expect((await apiError(beto.api.get(workspaceId, kept.id))).status).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "real-time events: base.created, base.rows, base.updated, base.deleted",
    async () => {
      const { workspaceId, ana } = await team();
      const socket = workspaceEvents(workspaceId);
      try {
        const base = await ana.api.create(workspaceId, { title: "Live" });
        expect(socket.event("base.created").baseId).toBe(base.id);
        const table = base.tables[0];
        if (!table) throw new Error("no table");
        const row = await ana.api.createRow(workspaceId, base.id, table.id, {
          props: { [table.titlePropId]: "x" },
        });
        expect(socket.event("base.rows")).toMatchObject({
          baseId: base.id,
          tableId: table.id,
          rowIds: [row.id],
        });
        await ana.api.update(workspaceId, base.id, { title: "Live 2" });
        expect(socket.event("base.updated").baseId).toBe(base.id);
        await ana.api.remove(workspaceId, base.id);
        expect(socket.event("base.deleted").baseId).toBe(base.id);
      } finally {
        socket.close();
      }
    },
    SERVER_TEST_MS,
  );
});

describe("bases: isolation between workspaces (IDOR)", () => {
  test(
    "another workspace's ids give 404 on every route, and a linked view doesn't cross workspaces",
    async () => {
      const mine = await team();
      const theirs = await team();
      const { base, table } = await baseWithTypes(theirs.ana.api, theirs.workspaceId, "Theirs");
      const row = await theirs.ana.api.createRow(theirs.workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "secret" },
      });
      const view = (await theirs.ana.api.get(theirs.workspaceId, base.id)).views[0];
      const api = mine.ana.api;
      const o = mine.workspaceId;
      // with their workspace in the URL: not even a member (the workspace doesn't even show)
      expect((await apiError(api.get(theirs.workspaceId, base.id))).status).toBe(404);
      expect((await apiError(api.list(theirs.workspaceId))).status).toBe(404);
      // with my own workspace in the URL and their ids
      const attempts: (() => Promise<unknown>)[] = [
        () => api.get(o, base.id),
        () => api.update(o, base.id, { title: "x" }),
        () => api.remove(o, base.id),
        () => api.query(o, base.id, table.id),
        () => api.createRow(o, base.id, table.id, { props: {} }),
        () => api.getRow(o, base.id, row.id),
        () => api.updateRow(o, base.id, row.id, { props: {} }),
        () => api.deleteRow(o, base.id, row.id),
        () => api.saveSchema(o, base.id, table.id, { defs: table.defs, parentVersion: table.schemaVersion }),
        () => api.updateView(o, base.id, String(view?.id), { name: "x" }),
        () => api.deleteView(o, base.id, String(view?.id)),
        () => api.createView(o, base.id, { tableId: table.id, name: "x", type: "table" }),
        () => api.importCsv(o, base.id, table.id, { csv: "a\n1" }),
        () => api.exportCsv(o, base.id, table.id),
        () => api.create(o, { title: "Linked", linkedTableId: table.id }),
      ];
      for (const call of attempts) expect((await apiError(call())).status).toBe(404);
      // a database of mine, their source: the view is rejected; their row through my database too
      const own = await api.create(o, { title: "Mine" });
      const ownTable = own.tables[0];
      if (!ownTable) throw new Error("no table");
      expect(
        (await apiError(api.createView(o, own.id, { tableId: table.id, name: "x", type: "table" }))).status,
      ).toBe(404);
      expect((await apiError(api.query(o, own.id, table.id))).status).toBe(404);
      expect((await apiError(api.getRow(o, own.id, row.id))).status).toBe(404);
      expect((await apiError(api.updateRow(o, own.id, row.id, { props: {} }))).status).toBe(404);
      expect((await apiError(api.deleteRow(o, own.id, row.id))).status).toBe(404);
      // their view's id through my database
      expect((await apiError(api.updateView(o, own.id, String(view?.id), { name: "x" }))).status).toBe(404);
      expect(
        (await apiError(api.exportCsv(o, own.id, ownTable.id, { viewId: String(view?.id) }))).status,
      ).toBe(404);
      expect((await apiError(api.query(o, own.id, ownTable.id, { viewId: String(view?.id) }))).status).toBe(
        404,
      );
      // their file into a base of mine
      const theirFile = await createFile(theirs.ana, theirs.workspaceId, {
        title: "Stock",
        content: { kind: "table", columns: ["Item"], rows: [["Bolt"]] },
      });
      expect((await apiError(api.fromFile(o, theirFile.id))).status).toBe(404);
      // nothing changed on their side
      expect((await theirs.ana.api.getRow(theirs.workspaceId, base.id, row.id)).version).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "a property, a row or a view id of ANOTHER base of the same workspace in the path or the body",
    async () => {
      const { workspaceId, ana } = await team();
      const a = await baseWithTypes(ana.api, workspaceId, "A");
      const b = await ana.api.create(workspaceId, { title: "B" });
      const bTable = b.tables[0];
      const bView = b.views[0];
      if (!bTable || !bView) throw new Error("no table");
      const bRow = await ana.api.createRow(workspaceId, b.id, bTable.id, {
        props: { [bTable.titlePropId]: "b" },
      });
      // A's source and row through B, and B's row and view through A
      expect((await apiError(ana.api.query(workspaceId, b.id, a.table.id))).status).toBe(404);
      expect((await apiError(ana.api.getRow(workspaceId, a.base.id, bRow.id))).status).toBe(404);
      expect(
        (await apiError(ana.api.updateView(workspaceId, a.base.id, bView.id, { name: "x" }))).status,
      ).toBe(404);
      expect((await apiError(ana.api.deleteView(workspaceId, a.base.id, bView.id))).status).toBe(404);
      expect(
        (await apiError(ana.api.query(workspaceId, a.base.id, a.table.id, { viewId: bView.id }))).status,
      ).toBe(404);
      // A's property ids in B's body: unknown in B's schema
      expect(
        (await apiError(ana.api.createRow(workspaceId, b.id, bTable.id, { props: { p_num: 1 } }))).code,
      ).toBe("base.invalid_props");
      expect(
        (
          await apiError(
            ana.api.query(workspaceId, b.id, bTable.id, { filter: { prop: "p_num", op: "gt", value: 0 } }),
          )
        ).code,
      ).toBe("base.bad_filter");
      expect(
        (
          await apiError(
            ana.api.query(workspaceId, b.id, bTable.id, { sorts: [{ prop: "p_num", dir: "asc" }] }),
          )
        ).code,
      ).toBe("base.bad_sort");
      expect(
        (await apiError(ana.api.query(workspaceId, b.id, bTable.id, { groupBy: { prop: "p_sel" } }))).code,
      ).toBe("base.bad_group");
      expect(
        (
          await apiError(
            ana.api.updateView(workspaceId, b.id, bView.id, {
              config: { sorts: [{ prop: "p_num", dir: "asc" }] },
            }),
          )
        ).code,
      ).toBe("base.bad_sort");
      // a neighbor row of A to place B's row
      const aRow = await ana.api.createRow(workspaceId, a.base.id, a.table.id, {
        props: { [a.table.titlePropId]: "a" },
      });
      expect(
        (await apiError(ana.api.createRow(workspaceId, b.id, bTable.id, { props: {}, afterId: aRow.id })))
          .code,
      ).toBe("base.bad_position");
      expect((await ana.api.query(workspaceId, b.id, bTable.id)).total).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "without a session every route is a 401; a person outside the workspace gets 404",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Closed");
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "r" },
      });
      const view = (await ana.api.get(workspaceId, base.id)).views[0];
      const file = await createFile(ana, workspaceId, {
        title: "Stock",
        content: { kind: "table", columns: ["Item"], rows: [["Bolt"]] },
      });
      // every route of the bases, with real ids of this workspace
      const every = (api: BasesApi): (() => Promise<unknown>)[] => [
        () => api.list(workspaceId),
        () => api.create(workspaceId, { title: "x" }),
        () => api.createFromCsv(workspaceId, { title: "x", csv: "a\n1" }),
        () => api.fromFile(workspaceId, file.id),
        () => api.get(workspaceId, base.id),
        () => api.update(workspaceId, base.id, { title: "x" }),
        () => api.remove(workspaceId, base.id),
        () =>
          api.saveSchema(workspaceId, base.id, table.id, {
            defs: table.defs,
            parentVersion: table.schemaVersion,
          }),
        () => api.query(workspaceId, base.id, table.id),
        () => api.createRow(workspaceId, base.id, table.id, { props: {} }),
        () => api.getRow(workspaceId, base.id, row.id),
        () => api.updateRow(workspaceId, base.id, row.id, { props: {} }),
        () => api.deleteRow(workspaceId, base.id, row.id),
        () => api.createView(workspaceId, base.id, { tableId: table.id, name: "x", type: "table" }),
        () => api.updateView(workspaceId, base.id, String(view?.id), { name: "x" }),
        () => api.deleteView(workspaceId, base.id, String(view?.id)),
        () => api.importCsv(workspaceId, base.id, table.id, { csv: "a\n1" }),
        () => api.exportCsv(workspaceId, base.id, table.id),
      ];
      const anon = basesApi(new Browser(server.url));
      for (const call of every(anon)) expect((await apiError(call())).status).toBe(401);
      const outsider = basesApi((await signedIn(server, "Zed", email("zed"))).browser);
      for (const call of every(outsider)) expect((await apiError(call())).status).toBe(404);
      expect((await ana.api.getRow(workspaceId, base.id, row.id)).version).toBe(1);
      expect((await ana.api.list(workspaceId)).bases.map((b) => b.title)).toEqual(["Closed"]);
    },
    SERVER_TEST_MS,
  );
});

describe("bases: SQL query = oracle", () => {
  test(
    "fuzz: 400 random filters give the same rows in SQL and in rowMatches",
    async () => {
      const { workspaceId, ana } = await team();
      expect(await fuzzAgainstOracle(server, ana, workspaceId, 400, clock)).toBeGreaterThan(1000);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "per property: generated names and values (quotes, backslash, semicolon, $1, new line, non-ASCII) filter as in memory",
    async () => {
      const { workspaceId, ana } = await team();
      let seed = 11;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed / 2 ** 31;
      };
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const nasty = [
        "'",
        '"',
        "\\",
        ";",
        "$1",
        "\n",
        "ção",
        "日本",
        "%",
        "_",
        "--",
        "')--",
        "a'b\"c",
        "\\'",
        "Ω",
      ];
      const word = () =>
        Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(nasty)).join(pick(["", " ", "x"]));
      // names made of the same characters: the server addresses properties by id, never by the name
      const names = new Set<string>();
      while (names.size < 6) names.add(`${word()} ${names.size}`.trim());
      const [nText, nNum, nSel, nMulti, nDate, nBox] = [...names];
      const base = await ana.api.create(workspaceId, { title: `Gen ${word()}` });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const optionNames = Array.from({ length: 4 }, (_, i) => `${word()} ${i}`);
      const options = optionNames.map((name, i) => ({ id: `opt_${i}`, name }));
      const saved = await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: table.schemaVersion,
        defs: [
          { id: table.titlePropId, name: String(nText), type: "text" },
          { id: "g_num", name: String(nNum), type: "number" },
          { id: "g_sel", name: String(nSel), type: "select", options },
          { id: "g_multi", name: String(nMulti), type: "multi_select", options },
          { id: "g_date", name: String(nDate), type: "date" },
          { id: "g_box", name: String(nBox), type: "checkbox" },
        ],
      });
      expect(saved.defs.map((d) => d.name)).toEqual([...names]);
      const t = saved.titlePropId;
      for (let i = 0; i < 40; i++) {
        const props: Record<string, unknown> = {};
        if (rnd() < 0.85) props[t] = word();
        if (rnd() < 0.8) props.g_num = pick([-2, 0, 1.5, 7, 1e9]);
        if (rnd() < 0.7) props.g_sel = pick(options).id;
        if (rnd() < 0.7) props.g_multi = [...new Set([pick(options).id, pick(options).id])];
        if (rnd() < 0.7) props.g_date = { start: pick(["2026-10-01", "2026-10-22", "2027-01-31"]) };
        if (rnd() < 0.7) props.g_box = rnd() < 0.5;
        await ana.api.createRow(workspaceId, base.id, saved.id, { props });
      }
      const [fresh] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.id, saved.id));
      if (!fresh) throw new Error("no table");
      const stored = await server.deps.db
        .select()
        .from(schema.dbRows)
        .where(eq(schema.dbRows.tableId, saved.id));
      const me = { type: "person" as const, id: ana.user.id };
      const value = (prop: string): [string, unknown][] => {
        switch (prop) {
          case t:
            return [
              ["eq", word()],
              ["neq", word()],
              ["contains", pick(nasty)],
              ["not_contains", pick(nasty)],
              ["starts_with", pick(nasty)],
              ["ends_with", pick(nasty)],
            ];
          case "g_num":
            return [
              ["gt", pick([-2, 0, 1.5])],
              ["lte", pick([7, 0])],
              ["eq", 7],
            ];
          case "g_sel":
            // ids that aren't options, made of the nasty characters, are plain values: they match nothing
            return [
              ["eq", pick([...options.map((o) => o.id), word()])],
              ["in", [pick(options).id, word()]],
              ["not_in", [word()]],
            ];
          case "g_multi":
            return [
              ["has", pick([...options.map((o) => o.id), word()])],
              ["has_any", [word(), pick(options).id]],
              ["has_all", [pick(options).id]],
            ];
          case "g_date":
            return [
              ["before", "2026-10-22"],
              ["on_or_after", { rel: "today" }],
            ];
          default:
            return [["eq", rnd() < 0.5]];
        }
      };
      let checked = 0;
      for (const prop of [t, "g_num", "g_sel", "g_multi", "g_date", "g_box"]) {
        for (let i = 0; i < 12; i++) {
          const [op, v] = pick(value(prop));
          const filter = { prop, op, value: v } as Filter;
          const page = await ana.api.query(workspaceId, base.id, saved.id, { filter, limit: 500 });
          const got = page.rows.map((r) => r.id).sort();
          const want = stored
            .filter((r) =>
              rowMatches(
                filter,
                fresh.defs,
                {
                  props: r.props,
                  computed: r.computed,
                  createdAt: r.createdAt.toISOString(),
                  editedAt: r.editedAt.toISOString(),
                  createdBy: r.createdBy,
                  editedBy: r.editedBy,
                },
                { now: clock, me },
              ),
            )
            .map((r) => r.id)
            .sort();
          if (JSON.stringify(got) !== JSON.stringify(want))
            throw new Error(`SQL ≠ memory for ${JSON.stringify(filter)}: ${got.length} vs ${want.length}`);
          checked += got.length;
        }
        // the search by title with the same characters, against the folded LIKE in memory
        const q = pick(nasty);
        const found = await ana.api.query(workspaceId, base.id, saved.id, { search: q, limit: 500 });
        const needle = foldCase(q.trim());
        expect(found.total).toBe(
          stored.filter((r) => foldCase(String(r.props[t] ?? "")).includes(needle)).length,
        );
      }
      expect(checked).toBeGreaterThan(50);
      // a property id that isn't in the schema, made of those characters, never reaches the SQL
      for (const prop of ["g_num'; drop table db_rows; --", "$1", 'a"b', "\\"]) {
        const err = await apiError(
          ana.api.query(workspaceId, base.id, saved.id, { filter: { prop, op: "eq", value: 1 } }),
        );
        expect([err.status, err.code]).toEqual([400, "base.bad_filter"]);
        const sort = await apiError(
          ana.api.query(workspaceId, base.id, saved.id, { sorts: [{ prop, dir: "asc" }] }),
        );
        expect(sort.code).toBe("base.bad_sort");
      }
      expect((await ana.api.query(workspaceId, base.id, saved.id)).total).toBe(40);
    },
    SERVER_TEST_MS * 2,
  );
});

describe("bases: formulas and recalculation", () => {
  test(
    "changing the formula recalculates the rows; an error per row stays in computed",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const t = table.titlePropId;
      const a = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "a", p_num: 4 } });
      await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "b", p_num: 0 } });
      const defs = table.defs.map((d) =>
        d.id === "p_f"
          ? { ...d, formula: { expression: 'if(prop("Amount") == 0, 1 / 0, prop("Amount") + 1)' } }
          : d,
      );
      const saved = await ana.api.saveSchema(workspaceId, base.id, table.id, {
        defs,
        parentVersion: table.schemaVersion,
      });
      expect(saved.recalc.pending).toBe(false);
      const rows = (await ana.api.query(workspaceId, base.id, table.id, { sorts: [{ prop: t, dir: "asc" }] }))
        .rows;
      expect(rows.map((r) => r.computed.p_f)).toEqual([5, { err: "division_by_zero" }]);
      expect(rows[0]?.version).toBe(a.version);
      // a formula with a syntax or type error: the schema saves, the source says the error
      const broken = await ana.api.saveSchema(workspaceId, base.id, table.id, {
        defs: defs.map((d) =>
          d.id === "p_f" ? { ...d, formula: { expression: 'prop("Amount") + "x" * 2' } } : d,
        ),
        parentVersion: saved.schemaVersion,
      });
      expect(broken.formulaErrors.p_f?.length).toBeGreaterThan(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "a recalculation that went down halfway resumes at the start, and running it twice changes nothing",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const [fresh] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.id, table.id));
      if (!fresh) throw new Error("no table");
      await addRows(
        server.deps,
        fresh,
        Array.from({ length: 1200 }, (_, i) => ({ props: { [fresh.titlePropId]: `r${i}`, p_num: i } })),
        { type: "person", id: ana.user.id },
      );
      // the crash: the version went up (the schema changed) and only half of the rows were recalculated
      const changed = fresh.defs.map((d) =>
        d.id === "p_f" ? { ...d, formula: { expression: 'prop("p_num") * 3' } } : d,
      );
      await server.deps.db
        .update(schema.dbTables)
        .set({ defs: changed, calcVersion: sql`${schema.dbTables.calcVersion} + 1` })
        .where(eq(schema.dbTables.id, fresh.id));
      await server.deps.db.execute(
        sql`update db_rows set computed = jsonb_build_object('p_f', ((props->>'p_num')::int * 3)), calc_version = calc_version + 1
           where table_id = ${fresh.id} and (props->>'p_num')::int < 600`,
      );
      await resumeRecalcs(server.deps);
      await settle(server);
      const [after] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.id, fresh.id));
      expect(after?.calcDoneVersion).toBe(after?.calcVersion);
      const snapshot = async () =>
        (await server.deps.db.select().from(schema.dbRows).where(eq(schema.dbRows.tableId, fresh.id)))
          .map((r) => [r.id, r.computed.p_f, r.version, r.calcVersion])
          .sort();
      const once = await snapshot();
      expect(once.every(([, f]) => typeof f === "number")).toBe(true);
      expect(once.filter(([, f]) => f === 3 * 1199).length).toBe(1);
      await runRecalc(server.deps, fresh.id);
      expect(await snapshot()).toEqual(once);
      expect((await ana.api.get(workspaceId, base.id)).tables[0]?.recalc.pending).toBe(false);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "editing a row the recalculation didn't reach yet takes its other values to the new type",
    async () => {
      // adversarial review, round 2: the edit saved the new calc_version with the old text in a number
      // column, and the recalculation skipped the row for good
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Types" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const saved = await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: table.schemaVersion,
        defs: [...table.defs, { id: "p_v", name: "V", type: "text" }, { id: "p_q", name: "Q", type: "text" }],
      });
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "a", p_v: "42" },
      });
      // V becomes a number and the background recalculation didn't reach this row yet
      await server.deps.db
        .update(schema.dbTables)
        .set({
          defs: saved.defs.map((d) => (d.id === "p_v" ? { ...d, type: "number" as const } : d)),
          calcVersion: sql`${schema.dbTables.calcVersion} + 1`,
        })
        .where(eq(schema.dbTables.id, table.id));
      const patched = await ana.api.updateRow(workspaceId, base.id, row.id, { props: { p_q: "edited" } });
      expect(patched.props.p_v).toBe(42);
      await runRecalc(server.deps, table.id);
      await settle(server);
      const [stored] = await server.deps.db.select().from(schema.dbRows).where(eq(schema.dbRows.id, row.id));
      expect(stored?.props).toMatchObject({ p_v: 42, p_q: "edited" });
      const q = await ana.api.query(workspaceId, base.id, table.id, {
        filter: { prop: "p_v", op: "eq", value: 42 },
      });
      expect(q.total).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "today() recalculates on the first access of the next day",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Due" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const saved = await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: table.schemaVersion,
        defs: [
          ...table.defs,
          { id: "p_due", name: "Due", type: "date" },
          {
            id: "p_left",
            name: "Left",
            type: "formula",
            formula: { expression: 'dateBetween(prop("Due"), today(), "days")' },
          },
        ],
      });
      const row = await ana.api.createRow(workspaceId, base.id, saved.id, {
        props: { [saved.titlePropId]: "x", p_due: { start: "2026-10-30" } },
      });
      expect(row.computed.p_left).toBe(8);
      clock += 24 * 3600_000;
      try {
        const next = await ana.api.query(workspaceId, base.id, saved.id);
        expect(next.rows[0]?.computed.p_left).toBe(7);
      } finally {
        clock -= 24 * 3600_000;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "stopping the server in the middle of a recalculation loses no work and repeats none: the next start resumes",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vanr-bases-recalc-"));
      const env = { DATA_DIR: dir };
      try {
        const first = await startTestServer({ env });
        const ana = withApi(await signedIn(first, "Ana", email("ana")));
        const { workspaceId } = await seedWorkspace(first, ana, "Disk");
        const { table } = await baseWithTypes(ana.api, workspaceId);
        const rows = 1100; // three batches of up to 500
        await first.deps.db.execute(sql`
          insert into db_rows (id, workspace_id, table_id, position, props, computed, calc_version, created_by, edited_by)
          select 'dbr_disk' || lpad(g::text, 5, '0'), ${workspaceId}, ${table.id}, 'a' || lpad(g::text, 6, '0'),
                 jsonb_build_object('p_num', g), jsonb_build_object('p_f', g * 2), ${table.recalc.version},
                 '{"type":"person","id":"x"}'::jsonb, '{"type":"person","id":"x"}'::jsonb
            from generate_series(1, ${rows}) g`);
        // the stop starts as soon as the first batch is committed: it halts before the second
        let stopping: Promise<void> | null = null;
        first.deps.hub.onPublish((_, event) => {
          if (event.type === "base.recalc" && event.done === false) stopping ??= first.stop();
        });
        // the formula changes and the recalculation runs in the background (as for a big table, or at a start)
        await first.deps.db
          .update(schema.dbTables)
          .set({
            defs: table.defs.map((d) =>
              d.id === "p_f" ? { ...d, formula: { expression: 'prop("p_num") * 5' } } : d,
            ),
            calcVersion: sql`${schema.dbTables.calcVersion} + 1`,
          })
          .where(eq(schema.dbTables.id, table.id));
        await resumeRecalcs(first.deps);
        await settle(first);
        expect(stopping).not.toBeNull();
        await stopping;

        // what the first run finished before the stop, read from the files it left: one whole batch, each row
        // at the new version. Those rows get a mark, to see whether the next start does them again.
        const { dbRows, dbTables } = schema;
        const disk = await openDb({ kind: "pglite", dataDir: join(dir, "db") });
        const [t] = await disk.db.select().from(dbTables).where(eq(dbTables.id, table.id));
        if (!t) throw new Error("no table");
        const done = (await disk.db.select().from(dbRows).where(eq(dbRows.tableId, table.id))).filter(
          (r) => r.calcVersion === t.calcVersion,
        );
        expect(t.calcDoneVersion).toBeLessThan(t.calcVersion);
        expect(done.length).toBe(500);
        expect(done.every((r) => r.computed.p_f === Number(r.props.p_num) * 5)).toBe(true);
        await disk.db.execute(
          sql`update db_rows set computed = '{"p_f":"kept"}'::jsonb where table_id = ${table.id} and calc_version = ${t.calcVersion}`,
        );
        await disk.close();

        // the next start resumes on its own, before it takes requests
        const second = await startTestServer({ env });
        try {
          await settle(second);
          const [t2] = await second.deps.db.select().from(dbTables).where(eq(dbTables.id, table.id));
          expect(t2?.calcDoneVersion).toBe(t2?.calcVersion);
          const after = await second.deps.db.select().from(dbRows).where(eq(dbRows.tableId, table.id));
          expect(after).toHaveLength(rows);
          const doneIds = new Set(done.map((r) => r.id));
          // nothing lost: every other row has the new formula's value; nothing repeated: the batch the first
          // run committed was not recalculated again (its mark is still there), and no row's version moved
          expect(after.filter((r) => doneIds.has(r.id)).every((r) => r.computed.p_f === "kept")).toBe(true);
          expect(
            after
              .filter((r) => !doneIds.has(r.id))
              .every((r) => r.computed.p_f === Number(r.props.p_num) * 5),
          ).toBe(true);
          expect(after.every((r) => r.version === 1)).toBe(true);
        } finally {
          await second.stop();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    SERVER_TEST_MS * 4,
  );
});

describe("bases: CSV and Drive", () => {
  test(
    "a new CSV infers types; importing matches the header and creates a column; exporting escapes spreadsheet formulas",
    async () => {
      const { workspaceId, ana } = await team();
      const csv =
        'Task,Hours,Due date,Done,Phase\n"Write, review",2.5,2026-10-30,yes,Start\nPublish,1,2026-11-02,no,End\nReview,,2026-11-03,yes,Start\nLaunch,,2026-11-04,no,End\n';
      const base = await ana.api.createFromCsv(workspaceId, { title: "From CSV", csv });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      expect(table.defs.map((d) => [d.name, d.type])).toEqual([
        ["Task", "text"],
        ["Hours", "number"],
        ["Due date", "date"],
        ["Done", "checkbox"],
        ["Phase", "select"],
      ]);
      const rows = (await ana.api.query(workspaceId, base.id, table.id)).rows;
      expect(rows.map((r) => r.props[table.titlePropId])).toEqual([
        "Write, review",
        "Publish",
        "Review",
        "Launch",
      ]);

      const imported = await ana.api.importCsv(workspaceId, base.id, table.id, {
        csv: 'hours,Task,New column,Phase\n3,=HYPERLINK("http://x"),abc,Middle\n4,+cmd,x,End\n5,@SUM(1),y,End\n6,-2+3,z,End\n',
      });
      expect(imported.created).toBe(4);
      expect(imported.addedProps.length).toBe(1);
      const phase = imported.table.defs.find((d) => d.name === "Phase");
      expect(phase?.options?.map((o) => o.name)).toEqual(["Start", "End", "Middle"]);

      const out = await ana.api.exportCsv(workspaceId, base.id, table.id);
      expect(out.fileName).toBe("From CSV.csv");
      const lines = out.csv.trim().split(/\r?\n/);
      expect(lines[0]).toBe("Task,Hours,Due date,Done,Phase,New column");
      // a cell that starts with =, +, @ or - becomes text (no CSV injection)
      expect(out.csv).toContain(`"'=HYPERLINK(""http://x"")"`);
      expect(out.csv).toContain("'+cmd");
      expect(out.csv).toContain("'@SUM(1)");
      expect(out.csv).toContain("'-2+3");
      const broken = await apiError(
        ana.api.importCsv(workspaceId, base.id, table.id, { csv: 'a,b\n"no end' }),
      );
      expect(broken.code.startsWith("base.csv_")).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test(
    "an imported CSV is outside data: too many columns, a huge cell or a body past the limit are rejected and nothing goes in",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Limits" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const wide = `${Array.from({ length: 600 }, (_, i) => `c${i}`).join(",")}\n`;
      expect((await apiError(ana.api.importCsv(workspaceId, base.id, table.id, { csv: wide }))).code).toBe(
        "base.csv_too_many_columns",
      );
      const huge = `Name\n${"x".repeat(200_000)}\n`;
      expect((await apiError(ana.api.importCsv(workspaceId, base.id, table.id, { csv: huge }))).code).toBe(
        "base.csv_cell_too_long",
      );
      const tooBig = await apiError(
        ana.api.importCsv(workspaceId, base.id, table.id, { csv: "x".repeat(10_000_001) }),
      );
      expect(tooBig.status).toBe(400);
      expect((await apiError(ana.api.createFromCsv(workspaceId, { title: "Wide", csv: wide }))).code).toBe(
        "base.csv_too_many_columns",
      );
      const after = await ana.api.get(workspaceId, base.id);
      expect(after.tables[0]?.defs.map((d) => d.name)).toEqual(["Name"]);
      expect(after.tables[0]?.schemaVersion).toBe(table.schemaVersion);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(0);
      expect((await ana.api.list(workspaceId)).bases.map((b) => b.title)).toEqual(["Limits"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "exporting through a view follows its filter, its order and its hidden columns",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const t = table.titlePropId;
      for (const [name, num] of [
        ["b", 2],
        ["a", 1],
        ["c", 3],
      ] as const)
        await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: name, p_num: num } });
      const view = await ana.api.createView(workspaceId, base.id, {
        tableId: table.id,
        name: "Only 2+",
        type: "table",
        config: {
          filter: { prop: "p_num", op: "gte", value: 2 },
          sorts: [{ prop: "p_num", dir: "desc" }],
          columns: [
            { prop: "p_num" },
            ...table.defs
              .filter((d) => d.id !== "p_num" && d.id !== t)
              .map((d) => ({ prop: d.id, hidden: true })),
          ],
        },
      });
      const out = await ana.api.exportCsv(workspaceId, base.id, table.id, { viewId: view.id });
      expect(out.csv.trim().split(/\r?\n/)).toEqual(["Name,Amount", "c,3", "b,2"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a Drive table becomes a database only once; one from a private channel is rejected",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const file = await createFile(beto, workspaceId, {
        title: "Stock",
        channelId: general,
        content: {
          kind: "table",
          columns: ["Item", "Qty"],
          rows: [
            ["Bolt", "10"],
            ["Nut", "4"],
          ],
        },
      });
      const base = await beto.api.fromFile(workspaceId, file.id);
      expect(base.title).toBe("Stock");
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      expect(table.defs.map((d) => [d.name, d.type])).toEqual([
        ["Item", "text"],
        ["Qty", "number"],
      ]);
      expect((await beto.api.query(workspaceId, base.id, table.id)).total).toBe(2);
      // again, and two at the same time: always the same database
      const again = await Promise.all([
        beto.api.fromFile(workspaceId, file.id),
        ana.api.fromFile(workspaceId, file.id),
      ]);
      expect(again.map((b) => b.id)).toEqual([base.id, base.id]);
      expect((await ana.api.list(workspaceId)).bases.filter((b) => b.title === "Stock").length).toBe(1);

      const secret = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const hidden = await createFile(ana, workspaceId, {
        title: "Salaries",
        channelId: secret,
        content: { kind: "table", columns: ["Name", "Salary"], rows: [["Ana", "1"]] },
      });
      expect((await apiError(ana.api.fromFile(workspaceId, hidden.id))).status).toBe(403);
      // whoever doesn't see the file doesn't even learn it exists
      expect((await apiError(beto.api.fromFile(workspaceId, hidden.id))).status).toBe(404);
      const doc = await createFile(ana, workspaceId, {
        title: "Doc",
        content: { kind: "document", markdown: "x" },
      });
      expect((await apiError(ana.api.fromFile(workspaceId, doc.id))).code).toBe("base.not_a_table");
    },
    SERVER_TEST_MS,
  );
});

describe("bases: search", () => {
  test(
    "a row is found through the search route by its members only; editing and deleting it follow",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const other = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Suppliers");
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "Zebrasupplier", p_num: 4 },
      });
      const search = async (who: Person, ws: string, q: string) => {
        const res = await who.browser.fetch(`${W(ws)}/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const { hits }: { hits: { kind: string; sourceId: string; title: string; url: string }[] } =
          await body(res);
        return hits.filter((h) => h.kind === "db_row");
      };
      expect(await search(beto, workspaceId, "Zebrasupplier")).toMatchObject([
        {
          sourceId: row.id,
          title: "Zebrasupplier",
          url: `/workspace/${workspaceId}/bases/${base.id}?row=${row.id}`,
        },
      ]);
      expect(await search(other.ana, other.workspaceId, "Zebrasupplier")).toEqual([]);
      await ana.api.updateRow(workspaceId, base.id, row.id, {
        props: { [table.titlePropId]: "Quaggasupplier" },
      });
      expect(await search(beto, workspaceId, "Zebrasupplier")).toEqual([]);
      expect(await search(beto, workspaceId, "Quaggasupplier")).toHaveLength(1);
      await ana.api.deleteRow(workspaceId, base.id, row.id);
      expect(await search(beto, workspaceId, "Quaggasupplier")).toEqual([]);
      expect(await indexed(row.id)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the boot's backfill indexes a row that went in without the search",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Backfill" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const id = newId("dbr");
      await server.deps.db.insert(schema.dbRows).values({
        id,
        workspaceId,
        tableId: table.id,
        position: "a0",
        props: { [table.titlePropId]: "Ocelotrow" },
        createdBy: { type: "person", id: ana.user.id },
        editedBy: { type: "person", id: ana.user.id },
      });
      expect(await indexed(id)).toEqual([]);
      expect(await backfillSearch(server.deps)).toBeGreaterThanOrEqual(1);
      const [chunk] = await indexed(id);
      expect(chunk).toMatchObject({ title: "Ocelotrow", scopeKind: "workspace", workspaceId });
    },
    SERVER_TEST_MS,
  );
});

describe("bases: adversarial review (each reproduced attack becomes a test)", () => {
  test(
    "text with a NUL or half a surrogate pair gives 400, not 500, and nothing is saved",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const t = table.titlePropId;
      const attempts = [
        () => ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "a\u0000b" } }),
        () => ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "a\uD800b" } }),
        () => ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "x" }, body: "a\u0000b" }),
        () => ana.api.query(workspaceId, base.id, table.id, { search: "a\u0000" }),
        () => ana.api.update(workspaceId, base.id, { title: "b\uDC00" }),
        () => ana.api.importCsv(workspaceId, base.id, table.id, { csv: "Name\nok\nx\u0000y\n" }),
      ];
      for (const attempt of attempts) {
        const err = await apiError(attempt());
        expect([err.status, err.code]).toEqual([400, "base.invalid_text"]);
      }
      expect((await apiError(ana.api.get(workspaceId, "dbs_\u0000"))).status).toBe(404);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "a filter with a value of the wrong shape gives 400 and isn't saved in a view",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const bad = [
        { prop: "p_who", op: "has", value: ["x"] }, // became invalid SQL (500)
        { prop: "p_sel", op: "eq", value: ["o_a"] }, // the SQL said yes, the oracle said no
        { prop: "p_sel", op: "neq", value: ["o_a"] },
      ] as Filter[];
      for (const filter of bad) {
        const q = await apiError(ana.api.query(workspaceId, base.id, table.id, { filter }));
        expect([q.status, q.code]).toEqual([400, "base.bad_filter"]);
        const v = await apiError(
          ana.api.createView(workspaceId, base.id, {
            tableId: table.id,
            name: "V",
            type: "table",
            config: { filter },
          }),
        );
        expect(v.status).toBe(400);
      }
      const views = [
        { quickFilters: [{ prop: "p_who", op: "zzz", value: "a" }] },
        { quickFilters: [{ prop: "p_who", op: "zzz" }] },
        { groupBy: { prop: "p_multi" } },
      ];
      for (const config of views) {
        const err = await apiError(
          ana.api.createView(workspaceId, base.id, { tableId: table.id, name: "V", type: "board", config }),
        );
        expect(err.status).toBe(400);
      }
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "deleting a column takes its filter, its order and its group out of the views; out of the linked view too",
    async () => {
      const { workspaceId, ana } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const t = table.titlePropId;
      await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "a", p_num: 5, p_sel: "o_a" },
      });
      const view = await ana.api.createView(workspaceId, base.id, {
        tableId: table.id,
        name: "Board",
        type: "board",
        config: {
          filter: {
            and: [
              { prop: "p_num", op: "gt", value: 1 },
              { prop: t, op: "contains", value: "a" },
            ],
          },
          sorts: [{ prop: "p_num", dir: "desc" }],
          groupBy: { prop: "p_sel" },
          quickFilters: [{ prop: "p_sel", value: "o_a" }],
          columns: [{ prop: "p_num", hidden: true }],
        },
      });
      const linked = await ana.api.create(workspaceId, { title: "Linked", linkedTableId: table.id });
      const linkedView = linked.views[0];
      if (!linkedView) throw new Error("no linked view");
      await ana.api.updateView(workspaceId, linked.id, linkedView.id, {
        config: { filter: { prop: "p_num", op: "gt", value: 1 } },
      });
      const fresh = (await ana.api.get(workspaceId, base.id)).tables[0];
      if (!fresh) throw new Error("no table");
      await ana.api.saveSchema(workspaceId, base.id, table.id, {
        defs: fresh.defs.filter((d) => d.id !== "p_num" && d.id !== "p_sel" && d.id !== "p_f"),
        parentVersion: fresh.schemaVersion,
      });
      const after = (await ana.api.get(workspaceId, base.id)).views.find((v) => v.id === view.id);
      expect(after?.config).toEqual({
        filter: { and: [{ prop: t, op: "contains", value: "a" }] },
        sorts: [],
        groupBy: null,
        quickFilters: [],
        columns: [],
      });
      expect((await ana.api.query(workspaceId, base.id, table.id, { viewId: view.id })).total).toBe(1);
      const linkedAfter = (await ana.api.get(workspaceId, linked.id)).views[0];
      expect(linkedAfter?.config.filter ?? null).toBeNull();
      expect((await ana.api.query(workspaceId, linked.id, table.id, { viewId: linkedView.id })).total).toBe(
        1,
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "importing is all or nothing: a failure halfway leaves no row and no half database",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Import" });
      const [table] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.databaseId, base.id));
      if (!table) throw new Error("no table");
      const actor = { type: "person" as const, id: ana.user.id };
      // the domain trusts props already validated; a NUL in batch 3 brings the insert down in the database
      const rows = Array.from({ length: 1500 }, (_, i) => ({
        props: { [table.titlePropId]: i === 1200 ? "x\u0000y" : `n${i}` },
      }));
      await expect(addRows(server.deps, table, rows, actor)).rejects.toThrow();
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(0);
      const good = rows.map((r, i) => (i === 1200 ? { props: { [table.titlePropId]: "x" } } : r));
      expect(await addRows(server.deps, table, good, actor)).toBe(1500);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(1500);

      const before = (await ana.api.list(workspaceId)).bases.length;
      await expect(
        createDatabase(server.deps, {
          workspaceId,
          title: "Halfway",
          actor,
          defs: [{ id: "p_t", name: "Name", type: "text" }],
          titlePropId: "p_t",
          rows: rows.map((_, i) => ({ p_t: i === 1200 ? "x\u0000y" : `n${i}` })),
        }),
      ).rejects.toThrow();
      expect((await ana.api.list(workspaceId)).bases.length).toBe(before);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "deleting the source base deletes the linked view left with no view at all",
    async () => {
      const { workspaceId, ana } = await team();
      const src = await ana.api.create(workspaceId, { title: "Source" });
      const other = await ana.api.create(workspaceId, { title: "Other" });
      const srcTable = src.tables[0];
      const otherTable = other.tables[0];
      if (!srcTable || !otherTable) throw new Error("no table");
      const only = await ana.api.create(workspaceId, {
        title: "Only the source",
        linkedTableId: srcTable.id,
      });
      const both = await ana.api.create(workspaceId, { title: "Both", linkedTableId: srcTable.id });
      await ana.api.createView(workspaceId, both.id, {
        tableId: otherTable.id,
        name: "Other",
        type: "table",
      });
      const socket = workspaceEvents(workspaceId);
      try {
        await ana.api.remove(workspaceId, src.id);
        const deleted = new Set([socket.event("base.deleted").baseId, socket.event("base.deleted").baseId]);
        expect(deleted).toEqual(new Set([src.id, only.id]));
      } finally {
        socket.close();
      }
      expect((await apiError(ana.api.get(workspaceId, only.id))).status).toBe(404);
      const kept = await ana.api.get(workspaceId, both.id);
      expect(kept.views.map((v) => v.tableId)).toEqual([otherTable.id]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a plain base that only showed the deleted source gets its own source's view back",
    async () => {
      const { workspaceId, ana } = await team();
      const src = await ana.api.create(workspaceId, { title: "Source" });
      const own = await ana.api.create(workspaceId, { title: "Own" });
      const srcTable = src.tables[0];
      const ownTable = own.tables[0];
      const ownView = own.views[0];
      if (!srcTable || !ownTable || !ownView) throw new Error("no table");
      await ana.api.createView(workspaceId, own.id, {
        tableId: srcTable.id,
        name: "From the source",
        type: "table",
      });
      await ana.api.deleteView(workspaceId, own.id, ownView.id);
      const socket = workspaceEvents(workspaceId);
      try {
        await ana.api.remove(workspaceId, src.id);
        expect(socket.event("base.updated").baseId).toBe(own.id);
      } finally {
        socket.close();
      }
      const after = await ana.api.get(workspaceId, own.id);
      expect(after.views.map((v) => [v.tableId, v.type])).toEqual([[ownTable.id, "table"]]);
    },
    SERVER_TEST_MS,
  );

  test(
    "importing a CSV into a base that would pass the cap leaves no new column behind",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Almost full" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      await server.deps.db.execute(sql`
      insert into db_rows (id, workspace_id, table_id, position, props, computed, created_by, edited_by)
      select 'dbr_full' || g, ${workspaceId}, ${table.id}, 'a' || lpad(g::text, 6, '0'), '{}'::jsonb, '{}'::jsonb,
             '{"type":"person","id":"x"}'::jsonb, '{"type":"person","id":"x"}'::jsonb
        from generate_series(1, ${MAX_ROWS - 1}) g`);
      const err = await apiError(
        ana.api.importCsv(workspaceId, base.id, table.id, { csv: "Name,Extra\nx,1\ny,2\n" }),
      );
      expect([err.status, err.code]).toEqual([409, "base.too_many_rows"]);
      const after = (await ana.api.get(workspaceId, base.id)).tables[0];
      expect(after?.defs.map((d) => d.name)).toEqual(table.defs.map((d) => d.name));
      expect(after?.schemaVersion).toBe(table.schemaVersion);
      // one row left under the cap and five creations at once: exactly one goes in
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          ana.api.createRow(workspaceId, base.id, table.id, { props: { [table.titlePropId]: `c${i}` } }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected"))
        expect(await apiError(Promise.reject(r.reason))).toEqual({ status: 409, code: "base.too_many_rows" });
      expect((await ana.api.query(workspaceId, base.id, table.id, { limit: 1 })).total).toBe(MAX_ROWS);
    },
    SERVER_TEST_MS * 3,
  );

  test(
    "the read caps: a page is at most 500 rows whatever is asked, a group shows 100, a grouped answer 2,000",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Groups" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const t = table.titlePropId;
      // 2,100 rows: 2,000 in 20 groups of 100 plus 100 more, so each cap is passed by what is there
      await server.deps.db.execute(sql`
      insert into db_rows (id, workspace_id, table_id, position, props, computed, created_by, edited_by)
      select 'dbr_grp' || g, ${workspaceId}, ${table.id}, 'a' || lpad(g::text, 6, '0'),
             case when g <= 150 then '{}'::jsonb else jsonb_build_object(${t}::text, 'g' || lpad((g % 20)::text, 2, '0')) end,
             '{}'::jsonb, '{"type":"person","id":"x"}'::jsonb, '{"type":"person","id":"x"}'::jsonb
        from generate_series(1, 2100) g`);
      const [stored] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.id, table.id));
      if (!stored) throw new Error("no table");
      const me = { type: "person" as const, id: ana.user.id };
      expect(
        (await queryRows(server.deps.db, stored, { limit: 10_000 }, { now: clock, me })).rows,
      ).toHaveLength(500);
      const grouped = await ana.api.query(workspaceId, base.id, table.id, { groupBy: { prop: t } });
      expect(grouped.groups?.length).toBe(21);
      expect(grouped.groups?.[0]).toEqual({ key: null, count: 150 });
      // the empty group first: 100 of its 150 rows, then 100 of each group until the 2,000 rows of the answer
      expect(grouped.rows.filter((r) => r.props[t] === undefined)).toHaveLength(100);
      expect(grouped.rows).toHaveLength(2_000);
    },
    SERVER_TEST_MS,
  );

  test(
    "a formula that makes too much text fails fast instead of holding the server",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Heavy" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const heavy = 'map(split(repeat("a", 300), ""), repeat("b", 100000))';
      await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: table.schemaVersion,
        defs: [
          ...table.defs,
          ...[1, 2, 3].map((k) => ({
            id: `f${k}`,
            name: `F${k}`,
            type: "formula" as const,
            formula: { expression: heavy },
          })),
        ],
      });
      const t0 = performance.now();
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "x" },
      });
      expect(performance.now() - t0).toBeLessThan(3_000);
      expect(row.computed).toEqual({
        f1: { err: "too_many_steps" },
        f2: { err: "too_many_steps" },
        f3: { err: "too_many_steps" },
      });
    },
    SERVER_TEST_MS,
  );
});

/**
 * The server's dependencies with the database's reads of `db_views` held until `parties` of them arrived (the
 * SQL and its results are the real ones; only their arrival waits). A writer that counts the views outside a
 * lock then reads the same count as every other writer: the race made deterministic.
 */
function heldViews(deps: AppDeps, parties: number): AppDeps {
  let arrived = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // biome-ignore lint/suspicious/noExplicitAny: a pass-through proxy over drizzle's query builder
  const hold = (q: any, views: boolean): any =>
    new Proxy(q, {
      get(target, key) {
        if (key === "then")
          // biome-ignore lint/suspicious/noExplicitAny: the builder's own then
          return (ok: any, bad: any) =>
            target.then(async (v: unknown) => {
              if (views && ++arrived <= parties) {
                if (arrived === parties) release();
                await gate;
              }
              return ok(v);
            }, bad);
        const item = target[key];
        if (typeof item !== "function") return item;
        return (...args: unknown[]) =>
          hold(item.apply(target, args), views || (key === "from" && args[0] === schema.dbViews));
      },
    });
  const db = new Proxy(deps.db, {
    get(target, key) {
      if (key === "select")
        return (...args: Parameters<typeof target.select>) => hold(target.select(...args), false);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...deps, db };
}

describe("bases: caps and checks at the same time", () => {
  /** Extra views written as the view route writes them, to start next to the cap without 49 requests. */
  async function addViews(workspaceId: string, databaseId: string, tableId: string, n: number) {
    const at = new Date(clock);
    await server.deps.db.insert(schema.dbViews).values(
      Array.from({ length: n }, (_, i) => ({
        id: newId("dbv"),
        workspaceId,
        databaseId,
        tableId,
        name: `v${i}`,
        type: "table" as const,
        position: `b${String(i).padStart(3, "0")}`,
        config: {},
        createdAt: at,
        updatedAt: at,
      })),
    );
  }

  test(
    "deleting the last views at once leaves one: the delete that would leave none is rejected",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const base = await ana.api.create(workspaceId, { title: "Two views" });
      const table = base.tables[0];
      const first = base.views[0];
      if (!table || !first) throw new Error("no table");
      const second = await ana.api.createView(workspaceId, base.id, {
        tableId: table.id,
        name: "2",
        type: "table",
      });
      const two = await Promise.allSettled([
        ana.api.deleteView(workspaceId, base.id, first.id),
        beto.api.deleteView(workspaceId, base.id, second.id),
      ]);
      expect(two.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [rejected] = two.filter((r) => r.status === "rejected");
      expect(await apiError(Promise.reject(rejected?.reason))).toEqual({
        status: 409,
        code: "base.last_view",
      });
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(1);
      // five views, five deletes at once: four go, one stays
      await addViews(workspaceId, base.id, table.id, 4);
      const views = (await ana.api.get(workspaceId, base.id)).views;
      expect(views).toHaveLength(5);
      const five = await Promise.allSettled(views.map((v) => ana.api.deleteView(workspaceId, base.id, v.id)));
      expect(five.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "creating views at once from 49 stops at the cap of 50",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Many views" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      await addViews(workspaceId, base.id, table.id, 48);
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(49);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          ana.api.createView(workspaceId, base.id, { tableId: table.id, name: `r${i}`, type: "table" }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected"))
        expect(await apiError(Promise.reject(r.reason))).toEqual({
          status: 409,
          code: "base.too_many_views",
        });
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(50);
      // a linked view into another database counts in that database
      const other = await ana.api.create(workspaceId, { title: "Other" });
      expect(
        (
          await apiError(
            ana.api.createView(workspaceId, base.id, {
              tableId: String(other.tables[0]?.id),
              name: "x",
              type: "table",
            }),
          )
        ).code,
      ).toBe("base.too_many_views");
    },
    SERVER_TEST_MS,
  );

  test(
    "moving views at once gives each its own place",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const base = await ana.api.create(workspaceId, { title: "Tabs" });
      const table = base.tables[0];
      const first = base.views[0];
      if (!table || !first) throw new Error("no table");
      const made = [];
      for (const name of ["b", "c", "d", "e"])
        made.push(await ana.api.createView(workspaceId, base.id, { tableId: table.id, name, type: "table" }));
      // three tabs moved right after the first one, at the same time
      await Promise.all(
        made
          .slice(1)
          .map((v, i) =>
            (i % 2 ? ana : beto).api.updateView(workspaceId, base.id, v.id, { afterId: first.id }),
          ),
      );
      const views = (await ana.api.get(workspaceId, base.id)).views;
      expect(new Set(views.map((v) => v.position)).size).toBe(5);
      expect(views[0]?.id).toBe(first.id);
      expect(
        views
          .slice(1, 4)
          .map((v) => v.name)
          .sort(),
      ).toEqual(["c", "d", "e"]);
      expect(views[4]?.name).toBe("b");
    },
    SERVER_TEST_MS,
  );

  test(
    "the same races with each read of the views held until every writer has read: still one view, still 50",
    async () => {
      const { workspaceId, ana } = await team();
      const { dbDatabases, dbTables, dbViews } = schema;
      const rowOf = async (id: string) => {
        const [row] = await server.deps.db.select().from(dbDatabases).where(eq(dbDatabases.id, id));
        if (!row) throw new Error("no base");
        return row;
      };
      // two deletes of the last two views
      const two = await ana.api.create(workspaceId, { title: "Held deletes" });
      const twoTable = two.tables[0];
      if (!twoTable) throw new Error("no table");
      await ana.api.createView(workspaceId, two.id, { tableId: twoTable.id, name: "2", type: "table" });
      const views = await server.deps.db.select().from(dbViews).where(eq(dbViews.databaseId, two.id));
      const twoRow = await rowOf(two.id);
      const heldTwo = heldViews(server.deps, 2);
      const deletes = await Promise.allSettled(views.map((v) => deleteView(heldTwo, twoRow, v)));
      expect(deletes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await server.deps.db.select().from(dbViews).where(eq(dbViews.databaseId, two.id))).toHaveLength(
        1,
      );
      // four creations from 49
      const cap = await ana.api.create(workspaceId, { title: "Held creations" });
      const capTable = cap.tables[0];
      if (!capTable) throw new Error("no table");
      await addViews(workspaceId, cap.id, capTable.id, 48);
      const [table] = await server.deps.db.select().from(dbTables).where(eq(dbTables.id, capTable.id));
      if (!table) throw new Error("no table");
      const capRow = await rowOf(cap.id);
      const heldFour = heldViews(server.deps, 4);
      const creations = await Promise.allSettled(
        Array.from({ length: 4 }, () => createView(heldFour, capRow, table, { name: "race", type: "table" })),
      );
      expect(creations.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await server.deps.db.select().from(dbViews).where(eq(dbViews.databaseId, cap.id))).toHaveLength(
        50,
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "the schema from the same version saved twice at once, and two imports adding columns at once: one each",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const saves = await Promise.allSettled([
        ana.api.saveSchema(workspaceId, base.id, table.id, {
          defs: [...table.defs, { id: "p_a", name: "A", type: "text" }],
          parentVersion: table.schemaVersion,
        }),
        beto.api.saveSchema(workspaceId, base.id, table.id, {
          defs: [...table.defs, { id: "p_b", name: "A", type: "number" }],
          parentVersion: table.schemaVersion,
        }),
      ]);
      expect(saves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [lost] = saves.filter((r) => r.status === "rejected");
      expect(await apiError(Promise.reject(lost?.reason))).toEqual({
        status: 409,
        code: "base.schema_conflict",
      });
      const now = (await ana.api.get(workspaceId, base.id)).tables[0];
      expect(now?.defs.filter((d) => d.name === "A")).toHaveLength(1);
      const imports = await Promise.allSettled([
        ana.api.importCsv(workspaceId, base.id, table.id, { csv: "Name,Fresh\nx,1\n" }),
        beto.api.importCsv(workspaceId, base.id, table.id, { csv: "Name,Fresh\ny,2\n" }),
      ]);
      // the second either read the first's column (and adds none) or lost the schema race (409, nothing in)
      const done = imports.filter((r) => r.status === "fulfilled");
      expect(done.length).toBeGreaterThanOrEqual(1);
      for (const r of imports.filter((x) => x.status === "rejected"))
        expect(await apiError(Promise.reject(r.reason))).toEqual({
          status: 409,
          code: "base.schema_conflict",
        });
      const after = (await ana.api.get(workspaceId, base.id)).tables[0];
      expect(after?.defs.filter((d) => d.name === "Fresh")).toHaveLength(1);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(done.length);
    },
    SERVER_TEST_MS,
  );

  test(
    "the field cap holds for an import; options from a CSV stop at 200, with names cut at 100",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Wide" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const full = await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: table.schemaVersion,
        defs: [
          ...table.defs,
          { id: "p_sel", name: "Phase", type: "select", options: [] },
          ...Array.from({ length: 197 }, (_, i) => ({ id: `p_${i}`, name: `C${i}`, type: "text" as const })),
        ],
      });
      expect(full.defs).toHaveLength(199);
      const over = await apiError(
        ana.api.importCsv(workspaceId, base.id, table.id, { csv: "Name,New one,New two\nx,1,2\n" }),
      );
      expect([over.status, over.code]).toEqual([400, "base.invalid_schema"]);
      expect((await ana.api.get(workspaceId, base.id)).tables[0]?.defs).toHaveLength(199);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(0);
      const long = "L".repeat(150);
      const csv = `Name,Phase\n${Array.from({ length: 250 }, (_, i) => `r${i},${i === 0 ? long : `o${i}`}`).join("\n")}\n`;
      const imported = await ana.api.importCsv(workspaceId, base.id, table.id, { csv });
      const phase = imported.table.defs.find((d) => d.id === "p_sel");
      expect(phase?.options).toHaveLength(200);
      expect(phase?.options?.[0]?.name).toBe("L".repeat(100));
      expect(imported.created).toBe(250);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "a row's body stops at 500,000 characters",
    async () => {
      const { workspaceId, ana } = await team();
      const base = await ana.api.create(workspaceId, { title: "Body" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const ok = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: {},
        body: "b".repeat(500_000),
      });
      expect(ok.hasBody).toBe(true);
      expect(
        (await apiError(ana.api.createRow(workspaceId, base.id, table.id, { body: "b".repeat(500_001) })))
          .status,
      ).toBe(400);
      expect(
        (await apiError(ana.api.updateRow(workspaceId, base.id, ok.id, { body: "b".repeat(500_001) })))
          .status,
      ).toBe(400);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(1);
    },
    SERVER_TEST_MS,
  );
});

describe("bases: automatic properties", () => {
  test(
    "created and edited, by whom and when: exported, filtered and sorted from the row's columns, and back in by CSV",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const base = await ana.api.create(workspaceId, { title: "Automatic" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const t = table.titlePropId;
      await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: table.schemaVersion,
        defs: [
          ...table.defs,
          { id: "a_ct", name: "Created", type: "created_time" },
          { id: "a_cb", name: "Author", type: "creator" },
          { id: "a_et", name: "Edited", type: "edited_time" },
          { id: "a_eb", name: "Editor", type: "editor" },
        ],
      });
      const start = clock;
      try {
        const first = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "first" } });
        clock += 60_000;
        const second = await beto.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "second" } });
        clock += 60_000;
        const edited = await beto.api.updateRow(workspaceId, base.id, first.id, { props: { [t]: "first!" } });
        const out = await ana.api.exportCsv(workspaceId, base.id, table.id);
        expect(out.csv.split("\r\n")).toEqual([
          "Name,Created,Author,Edited,Editor",
          `first!,${first.createdAt},Ana,${edited.editedAt},Beto`,
          `second,${second.createdAt},Beto,${second.editedAt},Beto`,
        ]);
        // the search reads the same columns
        const [chunk] = await indexed(first.id);
        expect(chunk?.text).toContain("Author: Ana");
        expect(chunk?.text).toContain("Editor: Beto");
        // filter and order by them
        const by = (filter: unknown, sorts?: { prop: string; dir: "asc" | "desc" }[]) =>
          ana.api.query(workspaceId, base.id, table.id, { filter, ...(sorts ? { sorts } : {}) });
        const names = (p: { rows: { props: Record<string, unknown> }[] }) => p.rows.map((r) => r.props[t]);
        expect(
          names(await by({ prop: "a_cb", op: "has", value: { type: "person", id: beto.user.id } })),
        ).toEqual(["second"]);
        expect(names(await by({ prop: "a_eb", op: "has", value: "me" }))).toEqual([]);
        expect(names(await by(null, [{ prop: "a_et", dir: "desc" }]))).toEqual(["first!", "second"]);
        expect(names(await by(null, [{ prop: "a_ct", dir: "desc" }]))).toEqual(["second", "first!"]);
        expect(
          names(await by({ prop: "a_ct", op: "on_or_after", value: first.createdAt.slice(0, 10) })),
        ).toHaveLength(2);
        // and back: a new base from the export keeps the values as text and dates
        const back = await ana.api.createFromCsv(workspaceId, { title: "Back", csv: out.csv });
        const backTable = back.tables[0];
        if (!backTable) throw new Error("no table");
        expect(backTable.defs.map((d) => d.name)).toEqual(["Name", "Created", "Author", "Edited", "Editor"]);
        const again = await ana.api.exportCsv(workspaceId, back.id, backTable.id);
        expect(
          again.csv
            .split("\r\n")
            .slice(1)
            .map((l) => l.split(",")[2]),
        ).toEqual(["Ana", "Beto"]);
      } finally {
        clock = start;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "exporting through a view of another source is rejected",
    async () => {
      const { workspaceId, ana } = await team();
      const a = await ana.api.create(workspaceId, { title: "A" });
      const b = await ana.api.create(workspaceId, { title: "B" });
      const aTable = a.tables[0];
      const bTable = b.tables[0];
      if (!aTable || !bTable) throw new Error("no table");
      const foreign = await ana.api.createView(workspaceId, a.id, {
        tableId: bTable.id,
        name: "B here",
        type: "table",
      });
      const err = await apiError(ana.api.exportCsv(workspaceId, a.id, aTable.id, { viewId: foreign.id }));
      expect(err).toEqual({ status: 400, code: "base.view_table" });
    },
    SERVER_TEST_MS,
  );
});

describe("bases: writes at the same time", () => {
  /** Rows whose computed formula doesn't match their values now (`Double` = `Amount` * 2). */
  const staleCells = async (tableId: string) =>
    (await server.deps.db.select().from(schema.dbRows).where(eq(schema.dbRows.tableId, tableId))).filter(
      (r) => r.computed.p_f !== (typeof r.props.p_num === "number" ? r.props.p_num * 2 : null),
    );

  test(
    "two people edit the same cell from the same version: one saves, the other gets the current row",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const row = await ana.api.createRow(workspaceId, base.id, table.id, { props: { p_num: 1 } });
      const results = await Promise.allSettled([
        ana.api.updateRow(workspaceId, base.id, row.id, { props: { p_num: 10 }, parentVersion: 1 }),
        beto.api.updateRow(workspaceId, base.id, row.id, { props: { p_num: 20 }, parentVersion: 1 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [rejected] = results.filter((r) => r.status === "rejected");
      const lost = await apiError(Promise.reject(rejected?.reason));
      expect([lost.status, lost.code]).toEqual([409, "base.row_conflict"]);
      const now = await ana.api.getRow(workspaceId, base.id, row.id);
      expect(now.version).toBe(2);
      expect([10, 20]).toContain(Number(now.props.p_num));
      expect(now.computed.p_f).toBe(Number(now.props.p_num) * 2);
      // without a version, ten edits at once of different cells all land and the formula follows the last one
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? ana : beto).api.updateRow(workspaceId, base.id, row.id, {
            props: i === 9 ? { p_num: 99 } : { [table.titlePropId]: `t${i}` },
          }),
        ),
      );
      const last = await ana.api.getRow(workspaceId, base.id, row.id);
      expect(last.version).toBe(12);
      expect(last.props.p_num).toBe(99);
      expect(await staleCells(table.id)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a formula change while rows are being edited leaves no computed cell with an old value",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const rows = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          ana.api.createRow(workspaceId, base.id, table.id, { props: { p_num: i } }),
        ),
      );
      const triple = table.defs.map((d) =>
        d.id === "p_f" ? { ...d, formula: { expression: 'prop("Amount") * 3' } } : d,
      );
      await Promise.all([
        ana.api.saveSchema(workspaceId, base.id, table.id, {
          defs: triple,
          parentVersion: table.schemaVersion,
        }),
        ...rows.map((r, i) => beto.api.updateRow(workspaceId, base.id, r.id, { props: { p_num: 100 + i } })),
      ]);
      await settle(server);
      const stored = await server.deps.db
        .select()
        .from(schema.dbRows)
        .where(eq(schema.dbRows.tableId, table.id));
      const [t] = await server.deps.db.select().from(schema.dbTables).where(eq(schema.dbTables.id, table.id));
      expect(stored.map((r) => r.props.p_num).sort()).toEqual(rows.map((_, i) => 100 + i).sort());
      expect(stored.every((r) => r.computed.p_f === Number(r.props.p_num) * 3)).toBe(true);
      expect(stored.every((r) => r.calcVersion === t?.calcVersion)).toBe(true);
      expect(t?.calcDoneVersion).toBe(t?.calcVersion);
    },
    SERVER_TEST_MS,
  );

  test(
    "renaming a property and deleting another while someone edits a row",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { p_num: 2, p_sel: "o_a" },
      });
      // rename Amount (the formula refers to it by id) and delete Stage, while Beto writes both
      const next = table.defs
        .filter((d) => d.id !== "p_sel")
        .map((d) => (d.id === "p_num" ? { ...d, name: "Total" } : d));
      const [schemaSave, edit] = await Promise.allSettled([
        ana.api.saveSchema(workspaceId, base.id, table.id, {
          defs: next,
          parentVersion: table.schemaVersion,
        }),
        beto.api.updateRow(workspaceId, base.id, row.id, { props: { p_num: 7, p_sel: "o_b" } }),
      ]);
      expect(schemaSave.status).toBe("fulfilled");
      // the edit either came first (and Stage went with the column) or found Stage gone (and nothing changed)
      const now = await ana.api.getRow(workspaceId, base.id, row.id);
      if (edit.status === "fulfilled") expect(now.props.p_num).toBe(7);
      else {
        expect(await apiError(Promise.reject(edit.reason))).toEqual({
          status: 400,
          code: "base.invalid_props",
        });
        expect(now.props.p_num).toBe(2);
      }
      await settle(server);
      const [stored] = await server.deps.db.select().from(schema.dbRows).where(eq(schema.dbRows.id, row.id));
      expect(stored?.computed.p_f).toBe(Number(stored?.props.p_num) * 2);
      expect(
        (await ana.api.get(workspaceId, base.id)).tables[0]?.defs.find((d) => d.id === "p_num")?.name,
      ).toBe("Total");
      // the deleted property can't be written any more, and a query on it is rejected
      expect(
        (await apiError(beto.api.updateRow(workspaceId, base.id, row.id, { props: { p_sel: "o_a" } }))).code,
      ).toBe("base.invalid_props");
      expect(
        (
          await apiError(
            ana.api.query(workspaceId, base.id, table.id, { filter: { prop: "p_sel", op: "empty" } }),
          )
        ).code,
      ).toBe("base.bad_filter");
    },
    SERVER_TEST_MS,
  );

  test(
    "reordering rows at the same time keeps every row once, in a stable order",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const base = await ana.api.create(workspaceId, { title: "Moves" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const t = table.titlePropId;
      const made = [];
      for (const name of ["a", "b", "c", "d", "e", "f"])
        made.push(await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: name } }));
      const [a, , , , e, f] = made;
      if (!a || !e || !f) throw new Error("no rows");
      // three moves to the same place at once: right after `a`
      await Promise.all([
        ana.api.updateRow(workspaceId, base.id, f.id, { afterId: a.id }),
        beto.api.updateRow(workspaceId, base.id, e.id, { afterId: a.id }),
        ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "n" }, afterId: a.id }),
      ]);
      const order = async () =>
        (await ana.api.query(workspaceId, base.id, table.id)).rows.map((r) => r.props[t]);
      const first = await order();
      expect(first).toHaveLength(7);
      expect(new Set(first).size).toBe(7);
      expect(first[0]).toBe("a");
      expect(first.slice(1, 4).sort()).toEqual(["e", "f", "n"]);
      expect(first.slice(4)).toEqual(["b", "c", "d"]);
      expect(await order()).toEqual(first);
    },
    SERVER_TEST_MS,
  );

  test(
    "importing while someone edits: the import's new column and rows and the edit all stay",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const row = await ana.api.createRow(workspaceId, base.id, table.id, { props: { p_num: 1 } });
      const [imported] = await Promise.all([
        ana.api.importCsv(workspaceId, base.id, table.id, { csv: "Name,Amount,Fresh\nx,3,a\ny,4,b\n" }),
        beto.api.updateRow(workspaceId, base.id, row.id, { props: { p_num: 5 } }),
      ]);
      expect(imported.created).toBe(2);
      const fresh = imported.table.defs.find((d) => d.name === "Fresh");
      expect(fresh).toBeDefined();
      const all = (
        await ana.api.query(workspaceId, base.id, table.id, { sorts: [{ prop: "p_num", dir: "asc" }] })
      ).rows;
      expect(all.map((r) => r.props.p_num)).toEqual([3, 4, 5]);
      expect(all.map((r) => r.computed.p_f)).toEqual([6, 8, 10]);
      expect(await staleCells(table.id)).toEqual([]);
      // an import against a schema someone changed meanwhile: 409 and nothing goes in
      const [t] = await server.deps.db.select().from(schema.dbTables).where(eq(schema.dbTables.id, table.id));
      if (!t) throw new Error("no table");
      await ana.api.saveSchema(workspaceId, base.id, table.id, {
        defs: t.defs,
        parentVersion: t.schemaVersion,
      });
      const conflict = await apiError(
        importRows(server.deps, t, {
          defs: [...t.defs, { id: "p_late", name: "Late", type: "text" }],
          rows: () => [{ p_late: "x" }],
          actor: { type: "person", id: ana.user.id },
        }),
      );
      expect([conflict.status, conflict.code]).toEqual([409, "base.schema_conflict"]);
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(3);
    },
    SERVER_TEST_MS,
  );
});

describe("bases: undo and redo of an agent's write", () => {
  // The agent's tool that writes rows and records the action (runtime/base-tools) and the undo route
  // (routes/control) come with later slices; here the action is the row the tool writes, and the undo is
  // called as the control registry calls it.
  async function withAction() {
    const t = await team();
    const agentId = newId("agt");
    await server.deps.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: t.workspaceId,
      name: "Lia",
      handle: `lia${++n}`,
      model: "claude-haiku-5-5",
      ownerUserId: t.ana.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    });
    const record = async (params: Record<string, unknown>) => {
      const id = newId("act");
      await server.deps.db.insert(schema.reversibleActions).values({
        id,
        workspaceId: t.workspaceId,
        agentId,
        kind: "base_rows_upserted",
        target: { type: "base", id: "x" },
        params,
      });
      return async () => {
        const [row] = await server.deps.db
          .select()
          .from(schema.reversibleActions)
          .where(eq(schema.reversibleActions.id, id));
        if (!row) throw new Error("no action");
        return row;
      };
    };
    return { ...t, agentId, record };
  }
  const { base_rows_upserted: undoer } = BASE_UNDOERS;

  test(
    "undo deletes the rows created and gives back the values from before; redo writes again",
    async () => {
      const { workspaceId, beto, ana, record } = await withAction();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Groceries");
      const t = table.titlePropId;
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "Milk", p_num: 1 },
      });
      // what the agent did: created "Bread" and edited "Milk"
      const bread = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "Bread" } });
      const edited = await ana.api.updateRow(workspaceId, base.id, row.id, {
        props: { p_num: 3, p_ok: true },
        parentVersion: 1,
      });
      const action = await record({
        tableId: table.id,
        created: [bread.id],
        updated: [{ id: row.id, before: row.props, after: edited.props, version: edited.version }],
      });
      const titles = async () =>
        (await beto.api.query(workspaceId, base.id, table.id)).rows.map((r) => [
          r.props[t],
          r.props.p_num ?? null,
          r.props.p_ok ?? null,
        ]);
      expect(await titles()).toEqual([
        ["Milk", 3, true],
        ["Bread", null, null],
      ]);
      await undoer.undo(server.deps, await action(), beto.user.id);
      expect(await titles()).toEqual([["Milk", 1, null]]);
      expect(await indexed(bread.id)).toEqual([]);
      await undoer.redo(server.deps, await action(), beto.user.id);
      const after = (await beto.api.query(workspaceId, base.id, table.id)).rows;
      expect(after.map((r) => r.props[t])).toEqual(["Milk", "Bread"]);
      expect(after[0]?.props).toMatchObject({ p_num: 3, p_ok: true });
      // and again: undo after a redo
      await undoer.undo(server.deps, await action(), beto.user.id);
      expect((await beto.api.query(workspaceId, base.id, table.id)).rows.map((r) => r.props[t])).toEqual([
        "Milk",
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "undo is all or nothing: if one row can't go back, none does; an edit after the agent rejects it",
    async () => {
      const { workspaceId, beto, ana, record } = await withAction();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Stages");
      const t = table.titlePropId;
      const a = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "A", p_num: 1 } });
      const b = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "B", p_sel: "o_a" },
      });
      const a2 = await ana.api.updateRow(workspaceId, base.id, a.id, {
        props: { p_num: 2 },
        parentVersion: 1,
      });
      const b2 = await ana.api.updateRow(workspaceId, base.id, b.id, {
        props: { p_sel: "o_b" },
        parentVersion: 1,
      });
      const action = await record({
        tableId: table.id,
        created: [],
        updated: [
          { id: a.id, before: a.props, after: a2.props, version: a2.version },
          { id: b.id, before: b.props, after: b2.props, version: b2.version },
        ],
      });
      // someone takes out the option B had before the agent: B can't go back
      const fresh = (await ana.api.get(workspaceId, base.id)).tables[0];
      if (!fresh) throw new Error("no table");
      await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: fresh.schemaVersion,
        defs: fresh.defs.map((d) =>
          d.id === "p_sel" ? { ...d, options: (d.options ?? []).filter((o) => o.id !== "o_a") } : d,
        ),
      });
      const snapshot = async () =>
        (await ana.api.query(workspaceId, base.id, table.id)).rows.map((r) => [
          r.props[t],
          r.props.p_num,
          r.version,
        ]);
      const before = await snapshot();
      for (let i = 0; i < 2; i++) {
        const err = await apiError(undoer.undo(server.deps, await action(), beto.user.id));
        expect([err.status, err.code]).toEqual([409, "action.changed_since"]);
        expect(await snapshot()).toEqual(before);
      }
      // an edit after the agent: the version the agent left is gone, the undo rejects it
      await beto.api.updateRow(workspaceId, base.id, a.id, { props: { p_num: 9 } });
      const only = await record({
        tableId: table.id,
        created: [],
        updated: [{ id: a.id, before: a.props, after: a2.props, version: a2.version }],
      });
      const err = await apiError(undoer.undo(server.deps, await only(), beto.user.id));
      expect(err.code).toBe("action.changed_since");
      expect((await ana.api.getRow(workspaceId, base.id, a.id)).props.p_num).toBe(9);
    },
    SERVER_TEST_MS,
  );

  test(
    "an action of a base that no longer exists, or of another workspace, is gone",
    async () => {
      const { workspaceId, ana, beto, record } = await withAction();
      const other = await team();
      const theirs = await other.ana.api.create(other.workspaceId, { title: "Theirs" });
      const theirTable = theirs.tables[0];
      if (!theirTable) throw new Error("no table");
      const action = await record({ tableId: theirTable.id, created: [], updated: [] });
      const err = await apiError(undoer.undo(server.deps, await action(), beto.user.id));
      expect([err.status, err.code]).toEqual([409, "action.gone"]);
      const mine = await ana.api.create(workspaceId, { title: "Mine" });
      const mineTable = mine.tables[0];
      if (!mineTable) throw new Error("no table");
      const gone = await record({ tableId: mineTable.id, created: [], updated: [] });
      await ana.api.remove(workspaceId, mine.id);
      const err2 = await apiError(undoer.redo(server.deps, await gone(), beto.user.id));
      expect(err2.code).toBe("action.gone");
    },
    SERVER_TEST_MS,
  );
});
