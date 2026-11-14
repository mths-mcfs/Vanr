// Relation and rollup on a real Postgres (the CI `postgres` job): what PGlite can't prove, since it runs one
// transaction at a time. The propagation between linked sources never waits for a lock: a dependent row or
// source another write holds is skipped and its notice stays for the next round, so two writes that cross
// (A rolls up B and B rolls up A) never end in a deadlock or a 500.
//
// VANR_TEST_BASES_LINKS=late swaps the propagation's first lock (`linkLocks.claimSource`) for a double that
// doesn't take the dependent source before its rows; the CI runs the forced interleaving that way too and
// expects it to FAIL (the propagation then waits for the held source).
// Here, without VANR_TEST_POSTGRES_URL, the file skips with the reason in the name.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BasePropDef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { linkLocks } from "../src/bases/links";
import type { RunningServer } from "../src/server";
import { type BasesApi, basesApi } from "./bases-api";
import { SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const LINKS = process.env.VANR_TEST_BASES_LINKS;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("bases relations on Postgres"), () => {
  let pg: RunningServer;
  let n = 0;
  const original = linkLocks.claimSource;
  beforeAll(async () => {
    pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("baselinks") } });
    // the double: says the source is taken without locking it, so the marking locks the rows first
    if (LINKS === "late") linkLocks.claimSource = async () => true;
  }, SERVER_TEST_MS);
  afterAll(async () => {
    linkLocks.claimSource = original;
    await pg?.stop();
  }, SERVER_TEST_MS);

  async function owner(name: string) {
    const who = await signedIn(pg, "Ana", `link${++n}@bases-pg.test`);
    const { workspaceId } = await seedWorkspace(pg, who, name);
    return { ws: workspaceId, api: basesApi(who.browser) };
  }

  async function base(api: BasesApi, ws: string, title: string, extra: BasePropDef[]) {
    const b = await api.create(ws, { title });
    const t = b.tables[0];
    if (!t) throw new Error("no table");
    await api.saveSchema(ws, b.id, t.id, { parentVersion: t.schemaVersion, defs: [...t.defs, ...extra] });
    return { id: b.id, tableId: t.id, titleId: t.titlePropId };
  }

  /** Tasks with hours, and projects that sum them. */
  async function projectsAndTasks(api: BasesApi, ws: string) {
    const tasks = await base(api, ws, "Tasks", [{ id: "hours", name: "Hours", type: "number" }]);
    const projects = await base(api, ws, "Projects", [
      { id: "rel", name: "Tasks", type: "relation", relation: { tableId: tasks.tableId } },
      {
        id: "sum",
        name: "Hours",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "hours", fn: "sum" },
      },
    ]);
    return { tasks, projects };
  }

  const notices = () => pg.deps.db.select().from(schema.dbCalcDirty);
  /** The rows of a raw statement (postgres.js answers an array). */
  const rowsOf = (result: unknown): unknown[] => (Array.isArray(result) ? result : []);
  /** The backend pid in the answer of `select pg_backend_pid() as pid`. */
  const pidIn = (rows: unknown[]) =>
    z
      .array(z.object({ pid: z.coerce.number() }))
      .min(1)
      .parse([...rows])[0]?.pid ?? 0;
  /** Resolves when some backend waits for a lock `pid` holds. */
  async function blockedBy(pid: number, signal: { stop: boolean }) {
    while (!signal.stop) {
      const rows = await pg.deps.db.execute(
        sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
      );
      if (rowsOf(rows).length) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  test(
    "a dependent row held by another transaction: the propagation doesn't wait, comes back and gets it right",
    async () => {
      const { ws, api } = await owner("Held");
      const { tasks, projects } = await projectsAndTasks(api, ws);
      const t1 = await api.createRow(ws, tasks.id, tasks.tableId, {
        props: { [tasks.titleId]: "Wash", hours: 2 },
      });
      const p = await api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      let locked = () => {};
      const isLocked = new Promise<void>((r) => {
        locked = r;
      });
      const holder = pg.deps.db.transaction(async (tx) => {
        await tx.select().from(schema.dbRows).where(eq(schema.dbRows.id, p.id)).for("update");
        locked();
        await held;
      });
      await isLocked;
      // the task's write isn't stuck on the project's lock
      await api.updateRow(ws, tasks.id, t1.id, { props: { hours: 5 } });
      const [dirty] = await notices();
      expect(dirty?.rowIds).toEqual([t1.id]);
      release();
      await holder;
      await settle(pg);
      expect((await api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 5 });
      expect(await notices()).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "writes that cross at the same time (A rolls up B, B rolls up A): all answer, none is a deadlock or a 500",
    async () => {
      const { ws, api } = await owner("Cross");
      const a = await base(api, ws, "A", [{ id: "x", name: "X", type: "number" }]);
      const b = await base(api, ws, "B", [
        { id: "y", name: "Y", type: "number" },
        { id: "toA", name: "To A", type: "relation", relation: { tableId: a.tableId } },
        {
          id: "sumX",
          name: "Sum X",
          type: "rollup",
          rollup: { relationPropId: "toA", targetPropId: "x", fn: "sum" },
        },
      ]);
      const at = (await api.get(ws, a.id)).tables[0];
      if (!at) throw new Error("no table");
      await api.saveSchema(ws, a.id, a.tableId, {
        parentVersion: at.schemaVersion,
        defs: [
          ...at.defs,
          { id: "toB", name: "To B", type: "relation", relation: { tableId: b.tableId } },
          {
            id: "sumY",
            name: "Sum Y",
            type: "rollup",
            rollup: { relationPropId: "toB", targetPropId: "y", fn: "sum" },
          },
        ],
      });
      const as = await Promise.all(
        [1, 2, 3].map((i) => api.createRow(ws, a.id, a.tableId, { props: { x: i } })),
      );
      const bs = await Promise.all(
        [1, 2, 3].map((i) =>
          api.createRow(ws, b.id, b.tableId, { props: { y: i * 10, toA: as.map((r) => r.id) } }),
        ),
      );
      for (const r of as) await api.updateRow(ws, a.id, r.id, { props: { toB: bs.map((x) => x.id) } });
      // 30 writes at once, each side over the rows the other one rolls up
      const writes = Array.from({ length: 30 }, (_, i) =>
        i % 2
          ? api.updateRow(ws, a.id, String(as[i % 3]?.id), { props: { x: 100 + i } })
          : api.updateRow(ws, b.id, String(bs[i % 3]?.id), { props: { y: 1000 + i } }),
      );
      const ends = await Promise.allSettled(writes);
      expect(
        ends.filter((e): e is PromiseRejectedResult => e.status === "rejected").map((e) => String(e.reason)),
      ).toEqual([]);
      await settle(pg);
      const xs = await Promise.all(as.map(async (r) => (await api.getRow(ws, a.id, r.id)).props.x));
      const ys = await Promise.all(bs.map(async (r) => (await api.getRow(ws, b.id, r.id)).props.y));
      const sum = (v: unknown[]) => v.reduce((s: number, x) => s + Number(x), 0);
      for (const r of as) expect((await api.getRow(ws, a.id, r.id)).computed.sumY).toBe(sum(ys));
      for (const r of bs) expect((await api.getRow(ws, b.id, r.id)).computed.sumX).toBe(sum(xs));
      expect(await notices()).toEqual([]);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "forced interleaving: links: a source another write holds isn't waited for, so its row lock after that can't close a deadlock",
    async () => {
      const { ws, api } = await owner("Order");
      const { tasks, projects } = await projectsAndTasks(api, ws);
      const t1 = await api.createRow(ws, tasks.id, tasks.tableId, {
        props: { [tasks.titleId]: "Wash", hours: 2 },
      });
      const p = await api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      // a write of the projects in the middle of its transaction: the source shared (as a row edit takes it)
      let reached!: (pid: number) => void;
      const holding = new Promise<number>((r) => {
        reached = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const holder = pg.deps.db
        .transaction(async (tx) => {
          await tx
            .select()
            .from(schema.dbTables)
            .where(eq(schema.dbTables.id, projects.tableId))
            .for("share");
          reached(pidIn(rowsOf(await tx.execute(sql`select pg_backend_pid() as pid`))));
          await gate;
          // and then the row it edits: free, unless the propagation took it before waiting for the source
          await tx.select().from(schema.dbRows).where(eq(schema.dbRows.id, p.id)).for("update");
        })
        .then(
          () => "done",
          (err: { code?: string }) => err.code ?? "error",
        );
      const pid = await holding;
      const signal = { stop: false };
      const write = api.updateRow(ws, tasks.id, t1.id, { props: { hours: 7 } }).then(() => false);
      const blocked = await Promise.race([write, blockedBy(pid, signal)]);
      signal.stop = true;
      release();
      const holderEnd = await holder;
      await write;
      // the propagation never waited for the held source, and the holder's row lock went through
      expect(blocked).toBe(false);
      expect(holderEnd).toBe("done");
      await settle(pg);
      expect((await api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 7 });
      expect(await notices()).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});
