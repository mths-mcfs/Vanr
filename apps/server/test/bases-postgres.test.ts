// Bases on a real Postgres (the CI `postgres` job): the manual order with collate "C", the filters, groups and
// formulas, the fuzz against the oracle with accents, LIKE and jsonb, and the locks PGlite can't prove (it
// runs one transaction at a time): the row cap with 20 creations at once, a linked base created while its
// source is deleted, the same cell edited at the same time and a formula change while rows are being edited.
// Here, without VANR_TEST_POSTGRES_URL, the file skips with the reason in the name.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseRow } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq, sql } from "drizzle-orm";
import { MAX_ROWS } from "../src/bases/core";
import type { RunningServer } from "../src/server";
import { apiError, basesApi, baseWithTypes, fuzzAgainstOracle } from "./bases-api";
import { SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("bases on Postgres"), () => {
  let pg: RunningServer;
  let n = 0;
  beforeAll(async () => {
    pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("bases") } });
  }, SERVER_TEST_MS);
  afterAll(() => pg?.stop(), SERVER_TEST_MS);

  async function owner(name: string) {
    const who = await signedIn(pg, "Ana", `ana${++n}@bases-pg.test`);
    const { workspaceId } = await seedWorkspace(pg, who, name);
    return { workspaceId, ana: { ...who, api: basesApi(who.browser) } };
  }

  test(
    "the migration, the order with collate C, a filter, a group and a formula on Postgres",
    async () => {
      const { workspaceId, ana } = await owner("PG");
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const t = table.titlePropId;
      let prev: string | null = null;
      for (const [name, num, status] of [
        ["b", 2, "s_done"],
        ["a", 1, "s_todo"],
        ["B", 3, "s_done"],
      ] as const) {
        const r: BaseRow = await ana.api.createRow(workspaceId, base.id, table.id, {
          props: { [t]: name, p_num: num, p_status: status, p_multi: ["t_x"] },
          ...(prev ? { afterId: prev } : {}),
        });
        prev = r.id;
      }
      const manual = await ana.api.query(workspaceId, base.id, table.id);
      expect(manual.rows.map((r) => r.props[t])).toEqual(["b", "a", "B"]);
      const filtered = await ana.api.query(workspaceId, base.id, table.id, {
        filter: {
          and: [
            { prop: "p_multi", op: "has", value: "t_x" },
            { prop: "p_status", op: "group", value: "done" },
          ],
        },
        sorts: [{ prop: "p_f", dir: "desc" }],
      });
      expect(filtered.rows.map((r) => r.computed.p_f)).toEqual([6, 4]);
      const grouped = await ana.api.query(workspaceId, base.id, table.id, { groupBy: { prop: "p_status" } });
      expect(grouped.groups).toEqual([
        { key: "s_todo", count: 1 },
        { key: "s_done", count: 2 },
      ]);
      const contains = await ana.api.query(workspaceId, base.id, table.id, {
        filter: { prop: t, op: "contains", value: "b" },
      });
      expect(contains.total).toBe(2);
    },
    SERVER_TEST_MS,
  );

  test(
    "fuzz SQL = oracle on Postgres too (accents, LIKE, jsonb)",
    async () => {
      const { workspaceId, ana } = await owner("PG2");
      expect(await fuzzAgainstOracle(pg, ana, workspaceId, 250, Date.now())).toBeGreaterThan(500);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "a linked base created while its source is deleted isn't left without a view",
    async () => {
      // adversarial review, round 3: the linked base's transaction already has its view and commits with the
      // delete waiting; the sweep of the orphans has to see the linked base that came in the middle
      const { workspaceId, ana } = await owner("PG4");
      const src = await ana.api.create(workspaceId, { title: "Source" });
      const table = src.tables[0];
      if (!table) throw new Error("no table");
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let inserted = () => {};
      const ready = new Promise<void>((r) => {
        inserted = r;
      });
      const at = new Date();
      const holder = pg.deps.db.transaction(async (tx) => {
        await tx.insert(schema.dbDatabases).values({
          id: "dbs_race",
          workspaceId,
          title: "In the middle",
          kind: "linked",
          createdBy: { type: "person", id: ana.user.id },
          createdAt: at,
          updatedAt: at,
        });
        await tx.insert(schema.dbViews).values({
          id: "dbv_race",
          workspaceId,
          databaseId: "dbs_race",
          tableId: table.id,
          name: "",
          type: "table",
          position: "a0",
          config: {},
          createdAt: at,
          updatedAt: at,
        });
        inserted();
        await gate;
      });
      await ready;
      const removed = ana.api.remove(workspaceId, src.id);
      // the delete is in: it waits on the lock the holder's view keeps on the source
      await waitForLockWait(pg);
      release();
      await holder;
      await removed;
      const views = await pg.deps.db
        .select({ id: schema.dbViews.databaseId })
        .from(schema.dbViews)
        .where(eq(schema.dbViews.workspaceId, workspaceId));
      const bases = await pg.deps.db
        .select({ id: schema.dbDatabases.id })
        .from(schema.dbDatabases)
        .where(eq(schema.dbDatabases.workspaceId, workspaceId));
      expect(bases.filter((b) => !views.some((v) => v.id === b.id))).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the row cap holds with 20 creations at the same time",
    async () => {
      const { workspaceId, ana } = await owner("PG3");
      const base = await ana.api.create(workspaceId, { title: "Full" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const fill = MAX_ROWS - 5;
      await pg.deps.db.execute(sql`
      insert into db_rows (id, workspace_id, table_id, position, props, computed, created_by, edited_by)
      select 'dbr_fill' || g, ${workspaceId}, ${table.id}, 'a' || lpad(g::text, 6, '0'), '{}'::jsonb, '{}'::jsonb,
             '{"type":"person","id":"x"}'::jsonb, '{"type":"person","id":"x"}'::jsonb
        from generate_series(1, ${fill}) g`);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          ana.api.createRow(workspaceId, base.id, table.id, { props: { [table.titlePropId]: `c${i}` } }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      expect((await ana.api.query(workspaceId, base.id, table.id, { limit: 1 })).total).toBe(MAX_ROWS);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "the same cell edited at the same time from the same version: exactly one saves",
    async () => {
      const { workspaceId, ana } = await owner("PG5");
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const row = await ana.api.createRow(workspaceId, base.id, table.id, { props: { p_num: 1 } });
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          ana.api.updateRow(workspaceId, base.id, row.id, { props: { p_num: 10 + i }, parentVersion: 1 }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected"))
        expect((await apiError(Promise.reject(r.reason))).code).toBe("base.row_conflict");
      const now = await ana.api.getRow(workspaceId, base.id, row.id);
      expect(now.version).toBe(2);
      expect(now.computed.p_f).toBe(Number(now.props.p_num) * 2);
    },
    SERVER_TEST_MS,
  );

  test(
    "a formula change while rows are being edited leaves no computed cell with an old value",
    async () => {
      const { workspaceId, ana } = await owner("PG6");
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const rows = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
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
        ...rows.map((r, i) => ana.api.updateRow(workspaceId, base.id, r.id, { props: { p_num: 100 + i } })),
      ]);
      await settle(pg);
      const stored = await pg.deps.db.select().from(schema.dbRows).where(eq(schema.dbRows.tableId, table.id));
      const [t] = await pg.deps.db.select().from(schema.dbTables).where(eq(schema.dbTables.id, table.id));
      expect(stored.every((r) => r.computed.p_f === Number(r.props.p_num) * 3)).toBe(true);
      expect(stored.every((r) => r.calcVersion === t?.calcVersion)).toBe(true);
      expect(t?.calcDoneVersion).toBe(t?.calcVersion);
    },
    SERVER_TEST_MS,
  );
});

/** Waits until a backend of the server's database waits on a lock (the signal, not a timer). */
async function waitForLockWait(server: RunningServer) {
  for (let i = 0; i < 400; i++) {
    const rows = await server.deps.db.execute(
      sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Array.isArray(rows) && rows.length > 0) return;
    await Bun.sleep(25);
  }
  throw new Error("the delete never waited on the lock");
}
