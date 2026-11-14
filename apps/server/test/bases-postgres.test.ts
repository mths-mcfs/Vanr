// Bases on a real Postgres (the CI `postgres` job): the manual order with collate "C", the filters, groups and
// formulas, the fuzz against the oracle with accents, LIKE and jsonb, and the locks PGlite can't prove (it
// runs one transaction at a time): the row cap with 20 creations at once, a linked base created while its
// source is deleted, the same cell edited at the same time, a formula change while rows are being edited, the
// view cap and the last view, the schema version and the order of the views; and the one lock order, by
// interleavings forced with a held transaction (no `40P01` between a source's delete and its linked base).
// Here, without VANR_TEST_POSTGRES_URL, the file skips with the reason in the name.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseRow } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq, sql } from "drizzle-orm";
import { MAX_ROWS } from "../src/bases/core";
import {
  baseLocks,
  createView,
  deleteDatabase,
  deleteView,
  type LockPoint,
  updateView,
} from "../src/bases/write";
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

  test(
    "the view cap and the last view hold with deletes and creations at the same time",
    async () => {
      const { workspaceId, ana } = await owner("PG7");
      const base = await ana.api.create(workspaceId, { title: "Views" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      const extra = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          ana.api.createView(workspaceId, base.id, { tableId: table.id, name: `v${i}`, type: "table" }),
        ),
      );
      const all = [...base.views, ...extra];
      expect(all).toHaveLength(5);
      const deletes = await Promise.allSettled(
        all.map((v) => ana.api.deleteView(workspaceId, base.id, v.id)),
      );
      expect(deletes.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(1);
      for (let i = 0; i < 48; i++)
        await ana.api.createView(workspaceId, base.id, { tableId: table.id, name: `w${i}`, type: "table" });
      const creations = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          ana.api.createView(workspaceId, base.id, { tableId: table.id, name: `r${i}`, type: "table" }),
        ),
      );
      expect(creations.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await ana.api.get(workspaceId, base.id)).views).toHaveLength(50);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "the schema from the same version and two imports adding a column: one each; moves get their own places",
    async () => {
      const { workspaceId, ana } = await owner("PG8");
      const { base, table } = await baseWithTypes(ana.api, workspaceId);
      const saves = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          ana.api.saveSchema(workspaceId, base.id, table.id, {
            defs: [...table.defs, { id: `p_x${i}`, name: "X", type: "text" }],
            parentVersion: table.schemaVersion,
          }),
        ),
      );
      expect(saves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const now = (await ana.api.get(workspaceId, base.id)).tables[0];
      if (!now) throw new Error("no table");
      const imports = await Promise.allSettled(
        Array.from({ length: 4 }, (_, i) =>
          ana.api.importCsv(workspaceId, base.id, now.id, { csv: `Name,Fresh\nr${i},1\n` }),
        ),
      );
      const done = imports.filter((r) => r.status === "fulfilled");
      for (const r of imports.filter((x) => x.status === "rejected"))
        expect((await apiError(Promise.reject(r.reason))).code).toBe("base.schema_conflict");
      const after = (await ana.api.get(workspaceId, base.id)).tables[0];
      expect(after?.defs.filter((d) => d.name === "Fresh")).toHaveLength(1);
      expect((await ana.api.query(workspaceId, base.id, now.id)).total).toBe(done.length);
      const first = base.views[0];
      if (!first) throw new Error("no view");
      const tabs = [];
      for (const name of ["b", "c", "d", "e"])
        tabs.push(await ana.api.createView(workspaceId, base.id, { tableId: table.id, name, type: "table" }));
      await Promise.all(
        tabs.map((v) => ana.api.updateView(workspaceId, base.id, v.id, { afterId: first.id })),
      );
      const views = (await ana.api.get(workspaceId, base.id)).views;
      expect(new Set(views.map((v) => v.position)).size).toBe(views.length);
      expect(views[0]?.id).toBe(first.id);
    },
    SERVER_TEST_MS * 2,
  );
});

/**
 * VANR_TEST_BASES_LOCKS swaps the lock of the one order (`baseLocks.databases`) for a double, so the forced
 * interleavings below are shown to depend on it; the CI runs them that way too and expects them to FAIL:
 * - `own`: each write locks only its own database (the order before round 3); the deletes then deadlock and
 *   one side answers `base.busy`.
 * - `none`: no database lock at all; the view writes then pass the cap, take the last view or share a place.
 */
const LOCKS = process.env.VANR_TEST_BASES_LOCKS;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("bases forced interleavings on Postgres"), () => {
  let pg: RunningServer;
  let n = 0;
  const original = baseLocks.databases;
  const originalPause = baseLocks.pause;
  beforeAll(async () => {
    pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("baselocks") } });
    if (LOCKS === "own" || LOCKS === "none")
      baseLocks.databases = async (tx, ids) => {
        // the existence the write reads, without the locks it no longer takes
        const found = LOCKS === "own" ? await original(tx, ids.slice(0, 1)) : new Set<string>();
        for (const id of ids) {
          const [row] = await tx
            .select({ id: schema.dbDatabases.id })
            .from(schema.dbDatabases)
            .where(eq(schema.dbDatabases.id, id));
          if (row) found.add(row.id);
        }
        return found;
      };
  }, SERVER_TEST_MS);
  afterAll(async () => {
    baseLocks.databases = original;
    baseLocks.pause = originalPause;
    await pg?.stop();
  }, SERVER_TEST_MS);

  async function owner(name: string) {
    const who = await signedIn(pg, "Ana", `lock${++n}@bases-pg.test`);
    const { workspaceId } = await seedWorkspace(pg, who, name);
    return { workspaceId, api: basesApi(who.browser) };
  }
  const one = <R>(rows: R[], what: string): R => {
    const [found] = rows;
    if (!found) throw new Error(`no ${what}`);
    return found;
  };
  const { dbDatabases, dbTables, dbViews } = schema;
  const baseRow = async (id: string) =>
    one(await pg.deps.db.select().from(dbDatabases).where(eq(dbDatabases.id, id)), "base");
  const tableRow = async (id: string) =>
    one(await pg.deps.db.select().from(dbTables).where(eq(dbTables.id, id)), "table");
  const viewRow = async (id: string) =>
    one(await pg.deps.db.select().from(dbViews).where(eq(dbViews.id, id)), "view");

  /**
   * Holds the first transaction that reaches `point` (after its locks), runs `second`, waits until a backend
   * is blocked by the held one's pid (pg_blocking_pids) or `second` already ended, then lets the first go.
   * Returns how each side ended: "done", or the error's code.
   */
  async function interleave(point: LockPoint, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let reached!: (pid: number) => void;
    let release!: () => void;
    const holding = new Promise<number>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    baseLocks.pause = async (at, tx) => {
      if (at !== point || held) return;
      held = true;
      const [me] = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
      reached(Number(me?.pid));
      await gate;
    };
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => "done",
        (err: { code?: string }) => err.code ?? "error",
      );
    try {
      const one = outcome(first());
      const pid = await holding;
      const two = outcome(second());
      const blocked = async () => {
        for (;;) {
          const rows = await pg.deps.db.execute(
            sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
          );
          if (Array.isArray(rows) && rows.length) return;
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      await Promise.race([two, blocked()]);
      release();
      return { first: await one, second: await two };
    } finally {
      baseLocks.pause = originalPause;
    }
  }

  /** A source base A and a linked base L whose only view shows A's source. */
  async function sourceAndLinked(api: ReturnType<typeof basesApi>, workspaceId: string) {
    const a = await api.create(workspaceId, { title: "Source" });
    const source = a.tables[0];
    if (!source) throw new Error("no table");
    const l = await api.create(workspaceId, { title: "Linked", linkedTableId: source.id });
    const v = l.views[0];
    if (!v) throw new Error("no view");
    return { a, l, source, v };
  }

  test(
    "forced interleaving: deleting a source while its linked base moves the view ends without a deadlock",
    async () => {
      const { workspaceId, api } = await owner("Move");
      const { a, l, source, v } = await sourceAndLinked(api, workspaceId);
      const [aRow, lRow, vRow, sRow] = await Promise.all([
        baseRow(a.id),
        baseRow(l.id),
        viewRow(v.id),
        tableRow(source.id),
      ]);
      const ends = await interleave(
        "base:deleted",
        () => deleteDatabase(pg.deps, aRow),
        () => updateView(pg.deps, lRow, vRow, sRow, { afterId: null }),
      );
      expect([ends.first, ends.second]).not.toContain("base.busy");
      // the source's delete took the view and the linked base left bare; the move then finds no view
      expect(ends).toEqual({ first: "done", second: "not_found" });
      const left = await pg.deps.db
        .select({ id: schema.dbDatabases.id })
        .from(schema.dbDatabases)
        .where(eq(schema.dbDatabases.workspaceId, workspaceId));
      expect(left).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced interleaving: deleting a source and its linked base at once ends without a deadlock",
    async () => {
      const { workspaceId, api } = await owner("Both");
      const { a, l } = await sourceAndLinked(api, workspaceId);
      const [aRow, lRow] = await Promise.all([baseRow(a.id), baseRow(l.id)]);
      const ends = await interleave(
        "base:deleted",
        () => deleteDatabase(pg.deps, aRow),
        () => deleteDatabase(pg.deps, lRow),
      );
      expect([ends.first, ends.second]).not.toContain("base.busy");
      expect(ends).toEqual({ first: "done", second: "done" });
      const left = await pg.deps.db
        .select({ id: schema.dbDatabases.id })
        .from(schema.dbDatabases)
        .where(eq(schema.dbDatabases.workspaceId, workspaceId));
      expect(left).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced interleaving: views: a creation counted at 49 holds the next one, which then counts 50",
    async () => {
      const { workspaceId, api } = await owner("Cap");
      const base = await api.create(workspaceId, { title: "Cap" });
      const table = base.tables[0];
      if (!table) throw new Error("no table");
      for (let i = 0; i < 48; i++)
        await api.createView(workspaceId, base.id, { tableId: table.id, name: `v${i}`, type: "table" });
      const [bRow0, tRow] = await Promise.all([baseRow(base.id), tableRow(table.id)]);
      const ends = await interleave(
        "view:counted",
        () => createView(pg.deps, bRow0, tRow, { name: "first", type: "table" }),
        () => createView(pg.deps, bRow0, tRow, { name: "second", type: "table" }),
      );
      expect(ends.second).toBe("base.too_many_views");
      expect((await api.get(workspaceId, base.id)).views).toHaveLength(50);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "forced interleaving: views: a delete counted at two holds the other, which then keeps the last view",
    async () => {
      const { workspaceId, api } = await owner("Last");
      const base = await api.create(workspaceId, { title: "Last" });
      const table = base.tables[0];
      const one = base.views[0];
      if (!table || !one) throw new Error("no table");
      const two = await api.createView(workspaceId, base.id, { tableId: table.id, name: "2", type: "table" });
      const [bRow1, v1, v2] = await Promise.all([baseRow(base.id), viewRow(one.id), viewRow(two.id)]);
      const ends = await interleave(
        "view:deleting",
        () => deleteView(pg.deps, bRow1, v1),
        () => deleteView(pg.deps, bRow1, v2),
      );
      expect(ends.second).toBe("base.last_view");
      expect((await api.get(workspaceId, base.id)).views.map((v) => v.id)).toEqual([two.id]);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced interleaving: views: a move that read its neighbors holds the other, which then gets its own place",
    async () => {
      const { workspaceId, api } = await owner("Move views");
      const base = await api.create(workspaceId, { title: "Tabs" });
      const table = base.tables[0];
      const first = base.views[0];
      if (!table || !first) throw new Error("no table");
      const tabs = [];
      for (const name of ["x", "b", "c"])
        tabs.push(await api.createView(workspaceId, base.id, { tableId: table.id, name, type: "table" }));
      const [, b, c] = tabs;
      if (!b || !c) throw new Error("no views");
      const [bRow2, tRow2, bRow, cRow] = await Promise.all([
        baseRow(base.id),
        tableRow(table.id),
        viewRow(b.id),
        viewRow(c.id),
      ]);
      // both to right after the first tab: without the lock both read [first, x] around them and take one key
      const ends = await interleave(
        "view:moving",
        () => updateView(pg.deps, bRow2, cRow, tRow2, { afterId: first.id }),
        () => updateView(pg.deps, bRow2, bRow, tRow2, { afterId: first.id }),
      );
      expect(ends).toEqual({ first: "done", second: "done" });
      const views = (await api.get(workspaceId, base.id)).views;
      expect(new Set(views.map((v) => v.position)).size).toBe(4);
      expect(views.map((v) => v.name)).toEqual(["", "b", "c", "x"]);
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
