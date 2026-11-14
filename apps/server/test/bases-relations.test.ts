// Bases: relation and rollup (the propagation between sources, isolation between workspaces, cycles, the
// recovery after a crash), the footer's summary and the chart in SQL against the JS oracle (`rollupValue`),
// the calendar's window, and the grid's bulk write (all or nothing, the caps before any write). The locks
// only Postgres proves are in bases-postgres.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BasePropDef } from "@vanr/contract";
import { rollupValue } from "@vanr/engine/bases/rollup";
import { summaryFns } from "@vanr/engine/bases/summary";
import { type Filter, rowMatches } from "@vanr/engine/bases/view";
import { schema } from "@vanr/engine/db";
import { propValue } from "@vanr/engine/formula";
import { fromJson, toJson } from "@vanr/engine/formula/values";
import { eq, sql } from "drizzle-orm";
import { MAX_ROWS } from "../src/bases/core";
import { linkLocks } from "../src/bases/links";
import { MAX_CHART_GROUPS, MAX_SUMMARIES, summarizeRows } from "../src/bases/query";
import {
  bulkRows,
  MAX_BULK_CELLS,
  MAX_BULK_ROWS,
  MAX_LINK_FAILURES,
  resumeRecalcs,
  settleLinks,
  stopRecalcs,
} from "../src/bases/write";
import { HttpError } from "../src/http";
import type { RunningServer } from "../src/server";
import { apiError, type BasesApi, basesApi } from "./bases-api";
import { Browser, SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@bases-relations.test`;

type Member = Person & { api: BasesApi };
const withApi = (p: Person): Member => ({ ...p, api: basesApi(p.browser) });

async function team(s: RunningServer = server) {
  const ana = withApi(await signedIn(s, "Ana", email("ana")));
  const { workspaceId } = await seedWorkspace(s, ana, "Workshop");
  const beto = withApi(await memberOf(s, workspaceId, "Beto", email("beto")));
  return { workspaceId, ana, beto };
}

async function base(api: BasesApi, ws: string, title: string, extra: (titleId: string) => BasePropDef[]) {
  const b = await api.create(ws, { title });
  const t = b.tables[0];
  if (!t) throw new Error("no table");
  const saved = await api.saveSchema(ws, b.id, t.id, {
    parentVersion: t.schemaVersion,
    defs: [...t.defs, ...extra(t.titlePropId)],
  });
  return { id: b.id, tableId: t.id, titleId: t.titlePropId, table: saved };
}

/** Tasks (hours, done, due) and Projects (a relation to tasks, rollups and a formula reading the relation). */
async function projectsAndTasks(api: BasesApi, ws: string) {
  const tasks = await base(api, ws, "Tasks", () => [
    { id: "hours", name: "Hours", type: "number" },
    { id: "done", name: "Done", type: "checkbox" },
    { id: "due", name: "Due", type: "date" },
  ]);
  const projects = await base(api, ws, "Projects", () => [
    { id: "rel", name: "Tasks", type: "relation", relation: { tableId: tasks.tableId } },
    {
      id: "sum",
      name: "Hours",
      type: "rollup",
      rollup: { relationPropId: "rel", targetPropId: "hours", fn: "sum" },
    },
    {
      id: "pct",
      name: "Done %",
      type: "rollup",
      rollup: { relationPropId: "rel", targetPropId: "done", fn: "percent_checked" },
    },
    {
      id: "last",
      name: "Last due",
      type: "rollup",
      rollup: { relationPropId: "rel", targetPropId: "due", fn: "latest" },
    },
    { id: "names", name: "List", type: "formula", formula: { expression: 'join(prop("Tasks"), ", ")' } },
  ]);
  const task = (title: string, props: Record<string, unknown>) =>
    api.createRow(ws, tasks.id, tasks.tableId, { props: { [tasks.titleId]: title, ...props } });
  return { tasks, projects, task };
}

const notices = () => server.deps.db.select().from(schema.dbCalcDirty);

describe("bases: relation and rollup", () => {
  test(
    "a rollup sums, takes the share and the date of the linked tasks; editing or deleting a task recalculates the project; a formula reads the titles",
    async () => {
      const { workspaceId: ws, ana, beto } = await team();
      const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
      expect(projects.table.defs.find((d) => d.id === "sum")?.rollup?.resultType).toBe("number");
      expect(projects.table.defs.find((d) => d.id === "last")?.rollup?.resultType).toBe("date");
      const t1 = await task("Wash", { hours: 2, due: { start: "2026-11-01" } });
      const t2 = await task("Dry", { hours: 3, done: true, due: { start: "2026-11-09" } });
      const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id, t2.id] },
      });
      expect(p.computed).toEqual({ sum: 5, pct: 0.5, last: { start: "2026-11-09" }, names: "Wash, Dry" });

      // someone else edits the task: the project recalculates in the same request (a small source)
      await beto.api.updateRow(ws, tasks.id, t1.id, { props: { hours: 4, [tasks.titleId]: "Wash well" } });
      let detail = await ana.api.getRow(ws, projects.id, p.id);
      expect(detail.computed).toMatchObject({ sum: 7, names: "Wash well, Dry" });
      expect(detail.linked[t1.id]).toEqual({
        title: "Wash well",
        tableId: tasks.tableId,
        databaseId: tasks.id,
      });

      // the filter and the order by the rollup come from the SQL, like a formula's
      const big = await ana.api.query(ws, projects.id, projects.tableId, {
        filter: { prop: "sum", op: "gt", value: 6 },
      });
      expect(big.rows.map((r) => r.id)).toEqual([p.id]);
      expect(big.linked[t2.id]?.title).toBe("Dry");
      const none = await ana.api.query(ws, projects.id, projects.tableId, {
        filter: { prop: "sum", op: "gt", value: 7 },
      });
      expect(none.rows).toEqual([]);

      // deleting the task takes it out of the sum; the id left in the relation is ignored
      await ana.api.deleteRow(ws, tasks.id, t1.id);
      detail = await ana.api.getRow(ws, projects.id, p.id);
      expect(detail.computed).toMatchObject({ sum: 3, pct: 1, names: "Dry" });
      expect(Object.keys(detail.linked)).toEqual([t2.id]);
      // writing the relation again with the deleted id it already had passes (the screen sends what it had)
      await ana.api.updateRow(ws, projects.id, p.id, { props: { rel: [t1.id, t2.id] } });

      // the CSV shows the rollup and the titles, not ids
      const { csv } = await ana.api.exportCsv(ws, projects.id, projects.tableId);
      expect(csv).toContain("Home,Dry,3,1,2026-11-09,Dry");
      await settle(server);
      expect(await notices()).toEqual([]);
      // the base lists where its relations point
      const got = await ana.api.get(ws, projects.id);
      expect(got.relationTargets).toEqual([
        { tableId: tasks.tableId, databaseId: tasks.id, databaseTitle: "Tasks", titlePropId: tasks.titleId },
      ]);
      expect((await ana.api.list(ws)).bases.find((b) => b.id === projects.id)?.tableId).toBe(
        projects.tableId,
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: a relation to another workspace's source or row, to another source or made up is a 400; no one outside reads through the relation",
    async () => {
      const a = await team();
      const b = await team();
      const secret = await base(b.ana.api, b.workspaceId, "Salaries", () => [
        { id: "amount", name: "Amount", type: "number" },
      ]);
      const row = await b.ana.api.createRow(b.workspaceId, secret.id, secret.tableId, {
        props: { [secret.titleId]: "Board", amount: 99_000 },
      });
      // a schema pointing to the other workspace's source: rejected (without it the rollup would sum their salary)
      const mine = await a.ana.api.create(a.workspaceId, { title: "Spy" });
      const t = mine.tables[0];
      if (!t) throw new Error("no table");
      const err = await apiError(
        a.ana.api.saveSchema(a.workspaceId, mine.id, t.id, {
          parentVersion: t.schemaVersion,
          defs: [
            ...t.defs,
            { id: "rel", name: "R", type: "relation", relation: { tableId: secret.tableId } },
            {
              id: "s",
              name: "S",
              type: "rollup",
              rollup: { relationPropId: "rel", targetPropId: "amount", fn: "sum" },
            },
          ],
        }),
      );
      expect([err.status, err.code]).toEqual([400, "base.invalid_schema"]);

      const { tasks, projects, task } = await projectsAndTasks(a.ana.api, a.workspaceId);
      const myTask = await task("Mine", { hours: 1 });
      const other = await a.ana.api.createRow(a.workspaceId, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Another project" },
      });
      for (const bad of [[row.id], [other.id], ["dbr_madeup"], [myTask.id, row.id]]) {
        const e = await apiError(
          a.ana.api.createRow(a.workspaceId, projects.id, projects.tableId, { props: { rel: bad } }),
        );
        expect({ bad, status: e.status, code: e.code }).toEqual({
          bad,
          status: 400,
          code: "base.invalid_props",
        });
      }
      // a row of the other workspace written straight into the database (a bug, an old import): the
      // calculation and the titles ignore it
      const p = await a.ana.api.createRow(a.workspaceId, projects.id, projects.tableId, {
        props: { [projects.titleId]: "P", rel: [myTask.id] },
      });
      await server.deps.db
        .update(schema.dbRows)
        .set({
          props: sql`jsonb_set(${schema.dbRows.props}, '{rel}', ${JSON.stringify([myTask.id, row.id])}::jsonb)`,
        })
        .where(eq(schema.dbRows.id, p.id));
      await a.ana.api.updateRow(a.workspaceId, tasks.id, myTask.id, { props: { hours: 2 } });
      const detail = await a.ana.api.getRow(a.workspaceId, projects.id, p.id);
      expect(detail.computed).toMatchObject({ sum: 2 });
      expect(Object.keys(detail.linked)).toEqual([myTask.id]);
      expect(JSON.stringify(detail)).not.toContain("Board");
      const page = await a.ana.api.query(a.workspaceId, projects.id, projects.tableId);
      expect(JSON.stringify(page)).not.toContain("Board");
      const { csv } = await a.ana.api.exportCsv(a.workspaceId, projects.id, projects.tableId);
      expect(csv).not.toContain("Board");
      // and the other workspace's base doesn't show up as a target
      expect((await a.ana.api.get(a.workspaceId, projects.id)).relationTargets.map((r) => r.tableId)).toEqual(
        [tasks.tableId],
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "no cycle: a rollup of a rollup, of a relation or of a formula reading a rollup is rejected; a relation both ways ends",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
      // in the task, the way back: a relation to projects with a rollup and a formula reading that rollup
      const tv = (await ana.api.get(ws, tasks.id)).tables[0];
      if (!tv) throw new Error("no table");
      const withBack = await ana.api.saveSchema(ws, tasks.id, tasks.tableId, {
        parentVersion: tv.schemaVersion,
        defs: [
          ...tv.defs,
          { id: "proj", name: "Project", type: "relation", relation: { tableId: projects.tableId } },
          {
            id: "count",
            name: "Projects",
            type: "rollup",
            rollup: { relationPropId: "proj", targetPropId: projects.titleId, fn: "count" },
          },
          { id: "via", name: "Via", type: "formula", formula: { expression: 'prop("Projects") + 1' } },
          { id: "clock", name: "Clock", type: "formula", formula: { expression: "now()" } },
        ],
      });
      const pv = (await ana.api.get(ws, projects.id)).tables[0];
      if (!pv) throw new Error("no table");
      for (const targetPropId of ["count", "via", "proj", "clock"]) {
        const e = await apiError(
          ana.api.saveSchema(ws, projects.id, projects.tableId, {
            parentVersion: pv.schemaVersion,
            defs: [
              ...pv.defs,
              {
                id: "x",
                name: "X",
                type: "rollup",
                rollup: { relationPropId: "rel", targetPropId, fn: "sum" },
              },
            ],
          }),
        );
        expect({ targetPropId, code: e.code }).toEqual({ targetPropId, code: "base.invalid_schema" });
      }
      // both ways: editing the task recalculates the project, which notifies the task, which doesn't move: it ends
      const t1 = await task("Wash", { hours: 2 });
      const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      await ana.api.updateRow(ws, tasks.id, t1.id, { props: { proj: [p.id] } });
      for (let i = 0; i < 5; i++) await ana.api.updateRow(ws, tasks.id, t1.id, { props: { hours: 3 + i } });
      await settle(server);
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 7 });
      expect((await ana.api.getRow(ws, tasks.id, t1.id)).computed).toMatchObject({ count: 1, via: 2 });
      expect(await notices()).toEqual([]);
      expect(withBack.schemaVersion).toBeGreaterThan(tv.schemaVersion);
    },
    SERVER_TEST_MS,
  );

  test(
    "two schema edits that would close a cycle: the second one's target stops being readable, the rollup becomes an error and the propagation ends",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
      // the project rolls up a task formula that reads only stored values (allowed)...
      const tv = (await ana.api.get(ws, tasks.id)).tables[0];
      if (!tv) throw new Error("no table");
      const withDouble = await ana.api.saveSchema(ws, tasks.id, tasks.tableId, {
        parentVersion: tv.schemaVersion,
        defs: [
          ...tv.defs,
          { id: "proj", name: "Project", type: "relation", relation: { tableId: projects.tableId } },
          { id: "dbl", name: "Double", type: "formula", formula: { expression: 'prop("Hours") * 2' } },
        ],
      });
      const pv = (await ana.api.get(ws, projects.id)).tables[0];
      if (!pv) throw new Error("no table");
      await ana.api.saveSchema(ws, projects.id, projects.tableId, {
        parentVersion: pv.schemaVersion,
        defs: [
          ...pv.defs,
          {
            id: "dsum",
            name: "Doubled",
            type: "rollup",
            rollup: { relationPropId: "rel", targetPropId: "dbl", fn: "sum" },
          },
        ],
      });
      const t1 = await task("Wash", { hours: 2 });
      const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      await ana.api.updateRow(ws, tasks.id, t1.id, { props: { proj: [p.id] } });
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ dsum: 4 });
      // ...and the other edit, made without looking at the project, turns that formula into one over the
      // relation back to the project: the target isn't readable any more and the project's rollup becomes an
      // error instead of closing a loop
      await ana.api.saveSchema(ws, tasks.id, tasks.tableId, {
        parentVersion: withDouble.schemaVersion,
        defs: withDouble.defs.map((d) =>
          d.id === "dbl" ? { ...d, formula: { expression: 'length(prop("Project")) * 2' } } : d,
        ),
      });
      for (let i = 0; i < 3; i++) await ana.api.updateRow(ws, tasks.id, t1.id, { props: { hours: 5 + i } });
      await settle(server);
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed.dsum).toEqual({ err: "bad_rollup" });
      expect(await notices()).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "changing the linked source's schema: a new type in the rollup, a deleted target becomes an error in the cell; deleting the linked base empties the relation",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
      const t1 = await task("Wash", { hours: 2 });
      const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      const tv = (await ana.api.get(ws, tasks.id)).tables[0];
      if (!tv) throw new Error("no table");
      await ana.api.saveSchema(ws, tasks.id, tasks.tableId, {
        parentVersion: tv.schemaVersion,
        defs: tv.defs.filter((d) => d.id !== "hours"),
      });
      await settle(server);
      const after = await ana.api.getRow(ws, projects.id, p.id);
      expect(after.computed.sum).toEqual({ err: "bad_rollup" });
      expect(after.computed.pct).toBe(0);
      // the dependent source keeps its schema savable: the dangling rollup was saved before, it stays as it is
      const pv = (await ana.api.get(ws, projects.id)).tables[0];
      if (!pv) throw new Error("no table");
      const renamed = await ana.api.saveSchema(ws, projects.id, projects.tableId, {
        parentVersion: pv.schemaVersion,
        defs: pv.defs.map((d) => (d.id === projects.titleId ? { ...d, name: "Project" } : d)),
      });
      expect(renamed.schemaVersion).toBe(pv.schemaVersion + 1);
      // deleting the linked base: the rollups error out, the titles go, the formula over the relation empties
      await ana.api.remove(ws, tasks.id);
      await settle(server);
      const gone = await ana.api.getRow(ws, projects.id, p.id);
      expect(gone.computed).toMatchObject({
        sum: { err: "bad_rollup" },
        pct: { err: "bad_rollup" },
        names: "",
      });
      expect(gone.linked).toEqual({});
      expect((await ana.api.get(ws, projects.id)).relationTargets).toEqual([]);
      // a new relation to a source that no longer exists is rejected
      const pv2 = (await ana.api.get(ws, projects.id)).tables[0];
      if (!pv2) throw new Error("no table");
      const e = await apiError(
        ana.api.saveSchema(ws, projects.id, projects.tableId, {
          parentVersion: pv2.schemaVersion,
          defs: [
            ...pv2.defs,
            { id: "rel2", name: "Again", type: "relation", relation: { tableId: tasks.tableId } },
          ],
        }),
      );
      expect(e.code).toBe("base.invalid_schema");
    },
    SERVER_TEST_MS,
  );

  test(
    "a crash between the write and the marking: the notice stays in the database and the start finishes the job",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
      const t1 = await task("Wash", { hours: 2 });
      const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      // the task's write committed with its notice, and the process went down before marking the project
      await server.deps.db.transaction(async (tx) => {
        await tx
          .update(schema.dbRows)
          .set({ props: sql`jsonb_set(${schema.dbRows.props}, '{hours}', '10'::jsonb)` })
          .where(eq(schema.dbRows.id, t1.id));
        await tx
          .insert(schema.dbCalcDirty)
          .values({ id: "dcd_crash", workspaceId: ws, tableId: tasks.tableId, rowIds: [t1.id] });
      });
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 2 });
      await resumeRecalcs(server.deps);
      await settle(server);
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 10 });
      // running it again changes nothing
      await resumeRecalcs(server.deps);
      await settle(server);
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 10 });
      expect(await notices()).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "CSV: the export writes the titles and the rollup; importing it back skips the relation and the rollup cells",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const { projects, task } = await projectsAndTasks(ana.api, ws);
      const t1 = await task("=cmd()", { hours: 2 });
      await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id] },
      });
      const { csv } = await ana.api.exportCsv(ws, projects.id, projects.tableId);
      // the linked title is outside text too: a spreadsheet formula goes out protected
      expect(csv.split("\n")[1]).toBe("Home,'=cmd(),2,0,,'=cmd()");
      const done = await ana.api.importCsv(ws, projects.id, projects.tableId, { csv });
      expect(done.created).toBe(1);
      // the relation and the 3 rollups of the line that had values, and the formula
      expect(done.skipped).toBe(4);
      const q = await ana.api.query(ws, projects.id, projects.tableId, { search: "Home" });
      expect(q.rows.map((r) => r.props.rel ?? null)).toEqual([[t1.id], null]);
    },
    SERVER_TEST_MS,
  );
});

describe("bases: the footer's summary and the chart", () => {
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

  test(
    "fuzz: each summary in SQL = the same function in JS (rollupValue) over the filtered rows, edge values included",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await base(ana.api, ws, "Fuzz", () => [
        { id: "n", name: "N", type: "number" },
        { id: "d", name: "D", type: "date" },
        {
          id: "s",
          name: "S",
          type: "select",
          options: [
            { id: "o1", name: "One" },
            { id: "o2", name: "Two" },
            { id: "o3", name: "Three" },
          ],
        },
        {
          id: "m",
          name: "M",
          type: "multi_select",
          options: [
            { id: "t1", name: "x" },
            { id: "t2", name: "y" },
          ],
        },
        { id: "c", name: "C", type: "checkbox" },
        { id: "f", name: "F", type: "formula", formula: { expression: 'prop("N") * 2' } },
      ]);
      const r = rng(7);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      // edge values: big and tiny numbers, the first and the last day the calendar takes, an end before the start
      const edgeNumbers = [0, -0, 0.1, 0.2, 1e15, -9007199254740991, 1e-12, 123456.789];
      const edgeDates = [
        { start: "0001-01-01" },
        { start: "9999-12-31" },
        { start: "2026-02-28", end: "2026-02-01" },
        { start: "2024-02-29" },
      ];
      for (let i = 0; i < 80; i++) {
        const props: Record<string, unknown> = { [b.titleId]: r() < 0.15 ? "" : pick(["a", "b", "A", "c"]) };
        if (r() < 0.8) props.n = r() < 0.2 ? pick(edgeNumbers) : Math.round((r() * 200 - 50) * 100) / 100;
        if (r() < 0.7) {
          if (r() < 0.2) props.d = pick(edgeDates);
          else {
            const day = 1 + Math.floor(r() * 27);
            const start = `2026-0${1 + Math.floor(r() * 9)}-${String(day).padStart(2, "0")}`;
            props.d = r() < 0.3 ? { start, end: `${start.slice(0, 8)}28` } : { start };
          }
        }
        if (r() < 0.7) props.s = pick(["o1", "o2", "o3"]);
        if (r() < 0.6) props.m = pick([["t1"], ["t2"], ["t1", "t2"], []]);
        if (r() < 0.5) props.c = r() < 0.6;
        await ana.api.createRow(ws, b.id, b.tableId, {
          props: Object.fromEntries(Object.entries(props).filter(([, v]) => v !== "")),
        });
      }
      // text in a number column: a row the recalculation hasn't taken to the new type yet
      const [stale] = await server.deps.db
        .select({ id: schema.dbRows.id })
        .from(schema.dbRows)
        .where(eq(schema.dbRows.tableId, b.tableId))
        .limit(1);
      await server.deps.db
        .update(schema.dbRows)
        .set({ props: sql`jsonb_set(${schema.dbRows.props}, '{n}', '"abc"'::jsonb)` })
        .where(eq(schema.dbRows.id, String(stale?.id)));
      const table = (await ana.api.get(ws, b.id)).tables[0];
      if (!table) throw new Error("no table");
      const filters: (Filter | null)[] = [
        null,
        { prop: "n", op: "gt", value: 10 },
        {
          or: [
            { prop: "s", op: "eq", value: "o2" },
            { prop: "c", op: "eq", value: true },
          ],
        },
        { prop: "d", op: "overlaps", value: ["2026-02-10", "2026-03-31"] },
      ];
      let compared = 0;
      for (const filter of filters) {
        const all = await ana.api.query(ws, b.id, b.tableId, { ...(filter ? { filter } : {}), limit: 500 });
        const kept = all.rows.filter((row) =>
          filter ? rowMatches(filter, table.defs, row, { now: Date.now() }) : true,
        );
        expect(kept.length).toBe(all.rows.length);
        for (const def of table.defs) {
          const fns = summaryFns(def);
          const got = await ana.api.summaries(ws, b.id, b.tableId, {
            ...(filter ? { filter } : {}),
            summaries: Object.fromEntries(fns.map((fn) => [def.id, fn])),
          });
          expect(Object.keys(got.values)).toEqual([def.id]);
          for (const fn of fns) {
            const one = await ana.api.summaries(ws, b.id, b.tableId, {
              ...(filter ? { filter } : {}),
              summaries: { [def.id]: fn },
            });
            const values = all.rows.map((row) =>
              def.type === "formula"
                ? fromJson(row.computed[def.id])
                : propValue(def, {
                    id: row.id,
                    props: row.props as never,
                    createdAt: row.createdAt,
                    createdBy: row.createdBy,
                    editedAt: row.editedAt,
                    editedBy: row.editedBy,
                  }),
            );
            const want = toJson(rollupValue(fn, values)) ?? null;
            const v = one.values[def.id];
            const label = `${JSON.stringify(filter)} ${def.name} ${fn}`;
            if (typeof want === "number" && typeof v === "number")
              expect({ label, ok: close(v, want), v, want }).toMatchObject({ label, ok: true });
            else expect({ label, v }).toEqual({ label, v: want });
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(150);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "the chart: count and sum per group equal to the sum in JS; summary and chart saved in the view; 400s",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await base(ana.api, ws, "Sales", () => [
        { id: "v", name: "Amount", type: "number" },
        {
          id: "s",
          name: "Stage",
          type: "select",
          options: [
            { id: "o1", name: "Lead" },
            { id: "o2", name: "Won" },
          ],
        },
      ]);
      const data = [{ s: "o1", v: 10 }, { s: "o2", v: 5 }, { s: "o2", v: 7.5 }, { v: 1 }, { s: "o1" }];
      for (const props of data) await ana.api.createRow(ws, b.id, b.tableId, { props });
      const count = await ana.api.aggregate(ws, b.id, b.tableId, { x: "s", agg: "count" });
      expect(count).toEqual({
        groups: [
          { key: null, value: 1 },
          { key: "o1", value: 2 },
          { key: "o2", value: 2 },
        ],
        total: 5,
      });
      const sum = await ana.api.aggregate(ws, b.id, b.tableId, { x: "s", y: "v", agg: "sum" });
      expect(sum.groups).toEqual([
        { key: null, value: 1 },
        { key: "o1", value: 10 },
        { key: "o2", value: 12.5 },
      ]);
      const one = await ana.api.aggregate(ws, b.id, b.tableId, { y: "v", agg: "avg" });
      expect(one.groups).toEqual([{ key: null, value: 23.5 / 4 }]);
      // a saved view: the quick filter goes into both
      const view = await ana.api.createView(ws, b.id, {
        tableId: b.tableId,
        name: "Chart",
        type: "chart",
        config: {
          chart: { kind: "bar", x: "s", y: "v", agg: "sum" },
          quickFilters: [{ prop: "s", op: "eq", value: "o2" }],
          summaries: { v: "sum" },
        },
      });
      expect((await ana.api.aggregate(ws, b.id, b.tableId, { viewId: view.id })).groups).toEqual([
        { key: "o2", value: 12.5 },
      ]);
      expect((await ana.api.summaries(ws, b.id, b.tableId, { viewId: view.id })).values).toEqual({ v: 12.5 });
      // a summary that doesn't fit the type, a sum over a non-number, a group by a list: 400
      const e1 = await apiError(
        ana.api.summaries(ws, b.id, b.tableId, { summaries: { [b.titleId]: "sum" } }),
      );
      expect(e1.code).toBe("base.bad_summary");
      const e2 = await apiError(ana.api.aggregate(ws, b.id, b.tableId, { x: "s", y: "s", agg: "sum" }));
      expect(e2.code).toBe("base.bad_chart");
      const e3 = await apiError(ana.api.summaries(ws, b.id, b.tableId, { summaries: { nope: "count" } }));
      expect(e3.code).toBe("base.bad_summary");
    },
    SERVER_TEST_MS,
  );

  test(
    "caps: the chart returns up to MAX_CHART_GROUPS groups, the summary takes up to MAX_SUMMARIES columns",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await base(ana.api, ws, "Many", () => [{ id: "v", name: "Amount", type: "number" }]);
      const t = (await ana.api.get(ws, b.id)).tables[0];
      if (!t) throw new Error("no table");
      await ana.api.bulkRows(ws, b.id, b.tableId, {
        ops: Array.from({ length: MAX_CHART_GROUPS + 1 }, (_, i) => ({ props: { v: i } })),
      });
      const chart = await ana.api.aggregate(ws, b.id, b.tableId, { x: "v", agg: "count" });
      expect(chart.groups.length).toBe(MAX_CHART_GROUPS);
      expect(chart.total).toBe(MAX_CHART_GROUPS + 1);
      // the summary's cap comes before the columns are looked at: one past it says "too many"
      const at = (k: number) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`p${i}`, "count"]));
      const ctx = { now: Date.now(), me: { type: "person" as const, id: ana.user.id } };
      const [fresh] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.id, b.tableId));
      if (!fresh) throw new Error("no table");
      const fit = await summarizeRows(server.deps.db, fresh, { summaries: at(MAX_SUMMARIES) }, ctx).catch(
        (e) => e,
      );
      expect(fit instanceof HttpError && fit.message).toBe("This summary doesn't fit the property");
      const past = await summarizeRows(
        server.deps.db,
        fresh,
        { summaries: at(MAX_SUMMARIES + 1) },
        ctx,
      ).catch((e) => e);
      expect(past instanceof HttpError && past.message).toBe("Too many summaries");
      expect(
        (await apiError(ana.api.summaries(ws, b.id, b.tableId, { summaries: at(MAX_SUMMARIES + 1) }))).code,
      ).toBe("invalid_request");
    },
    SERVER_TEST_MS,
  );

  test(
    "the window (within): it adds to a saved filter of 3 levels and the quick one without passing the depth; an invalid one is a 400",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await base(ana.api, ws, "Agenda", () => [
        { id: "d", name: "Due", type: "date" },
        { id: "e", name: "Handover", type: "date" },
        { id: "v", name: "Amount", type: "number" },
      ]);
      const rows = [
        { v: 1, d: { start: "2026-10-05" } },
        { v: 2, d: { start: "2026-09-20" }, e: { start: "2026-10-02" } },
        { v: 3, d: { start: "2026-09-20" }, e: { start: "2026-09-25" } },
        { v: 4, d: { start: "2026-11-02" } },
        { v: 50, d: { start: "2026-10-10" } },
        { v: 6 },
      ];
      for (const props of rows) await ana.api.createRow(ws, b.id, b.tableId, { props });
      // a saved filter and a quick filter: the effective and[or[...], quick] already has 3 levels (the most);
      // the window, with 3 more, only passes because the server checks each one alone
      const deep = {
        or: [
          { prop: "v", op: "lt", value: 10 },
          { prop: "v", op: "eq", value: 99 },
        ],
      };
      const view = await ana.api.createView(ws, b.id, {
        tableId: b.tableId,
        name: "Calendar",
        type: "calendar",
        config: {
          filter: deep,
          quickFilters: [{ prop: "v", op: "gte", value: 1 }],
          dateProp: "d",
          endProp: "e",
          summaries: { v: "sum" },
          chart: { kind: "number", x: null, y: "v", agg: "sum" },
        },
      });
      const within = {
        or: [
          {
            and: [
              { prop: "d", op: "on_or_before", value: "2026-10-31" },
              { prop: "e", op: "on_or_after", value: "2026-10-01" },
            ],
          },
          {
            and: [
              { prop: "d", op: "on_or_before", value: "2026-10-31" },
              { prop: "d", op: "on_or_after", value: "2026-10-01" },
            ],
          },
        ],
      };
      const q = await ana.api.query(ws, b.id, b.tableId, { viewId: view.id, within });
      expect(q.rows.map((r) => r.props.v).sort()).toEqual([1, 2]);
      expect(q.total).toBe(2);
      const sums = await ana.api.summaries(ws, b.id, b.tableId, { viewId: view.id, within });
      expect(sums.values).toEqual({ v: 3 });
      const agg = await ana.api.aggregate(ws, b.id, b.tableId, { viewId: view.id, within });
      expect(agg).toEqual({ groups: [{ key: null, value: 3 }], total: 2 });
      // the window is checked alone: depth, property and value
      for (const bad of [
        { and: [within] },
        { prop: "none", op: "empty" },
        { prop: "d", op: "overlaps", value: ["2026-10-01"] },
      ]) {
        const e = await apiError(ana.api.query(ws, b.id, b.tableId, { viewId: view.id, within: bad }));
        expect(e.code).toBe("base.bad_filter");
      }
    },
    SERVER_TEST_MS,
  );
});

describe("bases: the grid's bulk write (a paste, the fill handle, clearing a range)", () => {
  async function sheet(api: BasesApi, ws: string) {
    return base(api, ws, "Sheet", () => [
      { id: "v", name: "Amount", type: "number" },
      {
        id: "s",
        name: "Stage",
        type: "select",
        options: [
          { id: "o1", name: "Lead" },
          { id: "o2", name: "Won" },
        ],
      },
      { id: "d", name: "Due", type: "date" },
      { id: "ok", name: "Paid", type: "checkbox" },
      { id: "f", name: "Double", type: "formula", formula: { expression: 'prop("Amount") * 2' } },
    ]);
  }

  test(
    "a paste: text converted by the column's type, a new row at the end, empty clears, a computed or invalid cell is skipped",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await sheet(ana.api, ws);
      const r1 = await ana.api.createRow(ws, b.id, b.tableId, { props: { [b.titleId]: "A", v: 1, s: "o1" } });
      const r2 = await ana.api.createRow(ws, b.id, b.tableId, { props: { [b.titleId]: "B", v: 2 } });
      const out = await ana.api.bulkRows(ws, b.id, b.tableId, {
        ops: [
          {
            rowId: r1.id,
            parentVersion: r1.version,
            text: { v: "1,5", s: "won", d: "2026-10-23", ok: "yes" },
          },
          { rowId: r2.id, parentVersion: r2.version, text: { v: "abc", s: "", f: "99", [b.titleId]: "B2" } },
          { text: { [b.titleId]: "C", v: "7", s: "Lead" } },
        ],
      });
      expect(out.skipped).toBe(2);
      expect(out.rows.map((r) => r.props[b.titleId])).toEqual(["A", "B2", "C"]);
      expect(out.rows[0]?.props).toMatchObject({ v: 1.5, s: "o2", d: { start: "2026-10-23" }, ok: true });
      expect(out.rows[0]?.computed.f).toBe(3);
      expect(out.rows[1]?.props.v).toBe(2);
      expect(out.rows[1]?.props.s).toBeUndefined();
      const q = await ana.api.query(ws, b.id, b.tableId, {});
      expect(q.rows.map((r) => r.props[b.titleId])).toEqual(["A", "B2", "C"]);
      // the fill handle: typed values over several rows at once
      const fill = await ana.api.bulkRows(ws, b.id, b.tableId, {
        ops: q.rows.map((r) => ({ rowId: r.id, parentVersion: r.version, props: { s: "o1", v: null } })),
      });
      expect(fill.rows.map((r) => [r.props.s, r.props.v])).toEqual([
        ["o1", undefined],
        ["o1", undefined],
        ["o1", undefined],
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "all or nothing: one row with an old version is a 409 and nothing of the bulk write stays",
    async () => {
      const { workspaceId: ws, ana, beto } = await team();
      const b = await sheet(ana.api, ws);
      const r1 = await ana.api.createRow(ws, b.id, b.tableId, { props: { [b.titleId]: "A", v: 1 } });
      const r2 = await ana.api.createRow(ws, b.id, b.tableId, { props: { [b.titleId]: "B", v: 2 } });
      await beto.api.updateRow(ws, b.id, r2.id, { props: { v: 20 }, parentVersion: r2.version });
      const e = await apiError(
        ana.api.bulkRows(ws, b.id, b.tableId, {
          ops: [
            { rowId: r1.id, parentVersion: r1.version, text: { v: "100" } },
            { text: { [b.titleId]: "new" } },
            { rowId: r2.id, parentVersion: r2.version, text: { v: "200" } },
          ],
        }),
      );
      expect(e.code).toBe("base.row_conflict");
      const q = await ana.api.query(ws, b.id, b.tableId, {});
      expect(q.rows.map((r) => [r.props[b.titleId], r.props.v])).toEqual([
        ["A", 1],
        ["B", 20],
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: a row of another source or of another workspace, a made-up column, a row twice, an invalid typed value, a computed value and a bulk too big",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await sheet(ana.api, ws);
      const other = await sheet(ana.api, ws);
      const mine = await ana.api.createRow(ws, b.id, b.tableId, { props: { [b.titleId]: "A", v: 1 } });
      const theirs = await ana.api.createRow(ws, other.id, other.tableId, { props: { v: 5 } });
      const stranger = await team();
      const far = await sheet(stranger.ana.api, stranger.workspaceId);
      const farRow = await stranger.ana.api.createRow(stranger.workspaceId, far.id, far.tableId, {
        props: { v: 9 },
      });
      const tries: [Record<string, unknown>[], string][] = [
        [[{ rowId: theirs.id, text: { v: "0" } }], "not_found"],
        [[{ rowId: farRow.id, text: { v: "0" } }], "not_found"],
        [[{ rowId: mine.id, text: { none: "1" } }], "base.invalid_props"],
        [[{ rowId: mine.id, props: { v: "one" } }], "base.invalid_props"],
        [[{ rowId: mine.id, props: { f: 3 } }], "base.invalid_props"],
        [
          [
            { rowId: mine.id, text: { v: "2" } },
            { rowId: mine.id, text: { v: "3" } },
          ],
          "base.bad_bulk",
        ],
        [Array.from({ length: MAX_BULK_ROWS + 1 }, () => ({ text: { v: "1" } })), "invalid_request"],
        [
          Array.from({ length: 20 }, () => ({
            text: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`c${i}`, "1"])),
          })),
          "base.bad_bulk",
        ],
      ];
      for (const [ops, code] of tries) {
        const e = await apiError(ana.api.bulkRows(ws, b.id, b.tableId, { ops }));
        expect([ops.length, e.code]).toEqual([ops.length, code]);
      }
      // nothing changed in any of the three sources
      expect((await ana.api.getRow(ws, b.id, mine.id)).props.v).toBe(1);
      expect((await ana.api.getRow(ws, other.id, theirs.id)).props.v).toBe(5);
      expect((await stranger.ana.api.getRow(stranger.workspaceId, far.id, farRow.id)).props.v).toBe(9);
      expect((await ana.api.query(ws, b.id, b.tableId, {})).total).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "the caps are the constants and come before any write: rows, cells and the source's row cap",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await sheet(ana.api, ws);
      const [table] = await server.deps.db
        .select()
        .from(schema.dbTables)
        .where(eq(schema.dbTables.id, b.tableId));
      if (!table) throw new Error("no table");
      const me = { type: "person" as const, id: ana.user.id };
      const code = (p: Promise<unknown>) =>
        p.then(
          () => "ok",
          (e: unknown) => (e instanceof HttpError ? e.code : String(e)),
        );
      // one row past the cap, straight into the domain (the route's schema has the same cap)
      const rows = (k: number) => Array.from({ length: k }, () => ({ props: {} }));
      expect(await code(bulkRows(server.deps, table, rows(MAX_BULK_ROWS + 1), me))).toBe("base.bad_bulk");
      // the cells: exactly at the cap the columns are looked at (an unknown one), one past it is rejected first
      const cells = (k: number) => [
        { text: Object.fromEntries(Array.from({ length: k }, (_, i) => [`c${i}`, "1"])) },
      ];
      expect(await code(bulkRows(server.deps, table, cells(MAX_BULK_CELLS), me))).toBe("base.invalid_props");
      expect(await code(bulkRows(server.deps, table, cells(MAX_BULK_CELLS + 1), me))).toBe("base.bad_bulk");
      expect((await ana.api.query(ws, b.id, b.tableId, {})).total).toBe(0);
      // the source one row short of full: two new rows are rejected whole, one fits
      await server.deps.db.execute(sql`
        insert into db_rows (id, workspace_id, table_id, position, props, computed, created_by, edited_by)
        select 'dbr_full' || g, ${ws}, ${b.tableId}, 'a' || lpad(g::text, 6, '0'), '{}'::jsonb, '{}'::jsonb,
               '{"type":"person","id":"x"}'::jsonb, '{"type":"person","id":"x"}'::jsonb
          from generate_series(1, ${MAX_ROWS - 2}) g`);
      const e = await apiError(ana.api.bulkRows(ws, b.id, b.tableId, { ops: [{}, {}, {}] }));
      expect([e.status, e.code]).toEqual([409, "base.too_many_rows"]);
      expect((await ana.api.query(ws, b.id, b.tableId, { limit: 1 })).total).toBe(MAX_ROWS - 2);
      await ana.api.bulkRows(ws, b.id, b.tableId, { ops: [{}, {}] });
      expect((await ana.api.query(ws, b.id, b.tableId, { limit: 1 })).total).toBe(MAX_ROWS);
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "a bulk write on the linked rows recalculates the projects that roll them up",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
      const t1 = await task("Wash", { hours: 1 });
      const t2 = await task("Dry", { hours: 1 });
      const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
        props: { [projects.titleId]: "Home", rel: [t1.id, t2.id] },
      });
      await ana.api.bulkRows(ws, tasks.id, tasks.tableId, {
        ops: [
          { rowId: t1.id, text: { hours: "10" } },
          { rowId: t2.id, text: { hours: "20" } },
        ],
      });
      expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 30 });
      expect(await notices()).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("bases: who can call the new routes", () => {
  test(
    "without a session 401, outside the workspace 404, another workspace's or base's ids 404, a view of another source 400",
    async () => {
      const { workspaceId: ws, ana } = await team();
      const b = await base(ana.api, ws, "Closed", () => [{ id: "v", name: "Amount", type: "number" }]);
      const row = await ana.api.createRow(ws, b.id, b.tableId, { props: { v: 1 } });
      const calls = (api: BasesApi, w: string, baseId: string, tableId: string) => [
        () => api.summaries(w, baseId, tableId, { summaries: { v: "sum" } }),
        () => api.aggregate(w, baseId, tableId, { agg: "count" }),
        () => api.bulkRows(w, baseId, tableId, { ops: [{ rowId: row.id, props: { v: 2 } }] }),
      ];
      for (const call of calls(basesApi(new Browser(server.url)), ws, b.id, b.tableId))
        expect((await apiError(call())).status).toBe(401);
      const outsider = withApi(await signedIn(server, "Zed", email("zed")));
      for (const call of calls(outsider.api, ws, b.id, b.tableId))
        expect((await apiError(call())).status).toBe(404);
      // their own workspace in the path, my base's ids
      const theirs = await team();
      for (const call of calls(theirs.ana.api, theirs.workspaceId, b.id, b.tableId))
        expect((await apiError(call())).status).toBe(404);
      // my workspace, another base's source through this base
      const other = await base(ana.api, ws, "Other", () => []);
      for (const call of calls(ana.api, ws, other.id, b.tableId))
        expect((await apiError(call())).status).toBe(404);
      // a view of another base in the body, and a view of this base that shows another source
      const otherView = (await ana.api.get(ws, other.id)).views[0];
      expect(
        (await apiError(ana.api.summaries(ws, b.id, b.tableId, { viewId: String(otherView?.id) }))).status,
      ).toBe(404);
      expect(
        (await apiError(ana.api.aggregate(ws, b.id, b.tableId, { viewId: String(otherView?.id) }))).status,
      ).toBe(404);
      const linkedView = await ana.api.createView(ws, b.id, {
        tableId: other.tableId,
        name: "Other",
        type: "table",
      });
      expect((await apiError(ana.api.summaries(ws, b.id, b.tableId, { viewId: linkedView.id }))).code).toBe(
        "base.view_table",
      );
      // every member reads and writes a base (no role check, as for the other row routes)
      const beto = withApi(await memberOf(server, ws, "Bia", email("bia"), "member"));
      expect(
        (await beto.api.bulkRows(ws, b.id, b.tableId, { ops: [{ rowId: row.id, props: { v: 3 } }] })).rows[0]
          ?.props.v,
      ).toBe(3);
      expect((await ana.api.getRow(ws, b.id, row.id)).props.v).toBe(3);
    },
    SERVER_TEST_MS,
  );
});

describe("bases: the propagation and the server's stop", () => {
  test(
    "a notice left by a held source tries again; once the server stops, nothing writes",
    async () => {
      const srv = await startTestServer();
      const original = linkLocks.claimSource;
      try {
        const ana = withApi(await signedIn(srv, "Ana", email("ana")));
        const { workspaceId: ws } = await seedWorkspace(srv, ana, "Stop");
        const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
        const t1 = await task("Wash", { hours: 1 });
        const p = await ana.api.createRow(ws, projects.id, projects.tableId, {
          props: { [projects.titleId]: "Home", rel: [t1.id] },
        });
        // the project's source held by another write: the marking skips it and keeps the notice
        let held = true;
        let tries = 0;
        linkLocks.claimSource = async (tx, id) => {
          tries++;
          return held ? false : original(tx, id);
        };
        await ana.api.updateRow(ws, tasks.id, t1.id, { props: { hours: 5 } });
        expect(tries).toBeGreaterThan(0);
        expect((await srv.deps.db.select().from(schema.dbCalcDirty)).length).toBe(1);
        expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 1 });
        // the hold ends: the retry already queued marks and recalculates
        held = false;
        await settle(srv);
        expect((await ana.api.getRow(ws, projects.id, p.id)).computed).toMatchObject({ sum: 5 });
        expect(await srv.deps.db.select().from(schema.dbCalcDirty)).toEqual([]);
        // held again, then the server stops: the waiting retry gives up, and after the stop nothing runs
        held = true;
        await ana.api.updateRow(ws, tasks.id, t1.id, { props: { hours: 6 } });
        await stopRecalcs(srv.deps);
        const after = tries;
        held = false;
        await settleLinks(srv.deps, false);
        await settle(srv);
        expect(tries).toBe(after);
        // the notice stays for the next start
        expect((await srv.deps.db.select().from(schema.dbCalcDirty)).length).toBe(1);
      } finally {
        linkLocks.claimSource = original;
        await srv.stop();
      }
    },
    SERVER_TEST_MS,
  );
});

describe("bases: a propagation that keeps failing", () => {
  test(
    "it tries MAX_LINK_FAILURES times, then stops and leaves the notice for later",
    async () => {
      const srv = await startTestServer();
      const original = linkLocks.claimSource;
      try {
        const ana = withApi(await signedIn(srv, "Ana", email("ana")));
        const { workspaceId: ws } = await seedWorkspace(srv, ana, "Broken");
        const { tasks, projects, task } = await projectsAndTasks(ana.api, ws);
        const t1 = await task("Wash", { hours: 1 });
        await ana.api.createRow(ws, projects.id, projects.tableId, {
          props: { [projects.titleId]: "Home", rel: [t1.id] },
        });
        let tries = 0;
        linkLocks.claimSource = async () => {
          tries++;
          throw new Error("broken");
        };
        // the write itself is committed and answers: the propagation's failure doesn't reach the writer
        await ana.api.updateRow(ws, tasks.id, t1.id, { props: { hours: 5 } });
        await settle(srv);
        expect(tries).toBe(MAX_LINK_FAILURES);
        expect((await srv.deps.db.select().from(schema.dbCalcDirty)).length).toBe(1);
      } finally {
        linkLocks.claimSource = original;
        await srv.stop();
      }
    },
    SERVER_TEST_MS,
  );
});
