// The agent's base tools (runtime/base-tools.ts) on a real database: the schema, a query by names, an upsert with
// the version read, a conflict, undo and redo through the route, relations by title and id, and the tools only
// with the bases' scope. Each write reads back through the bases routes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BasePropDef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { type BasesApi, basesApi, baseWithTypes } from "./bases-api";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { seedAgent, toolRun, undo } from "./tool-run";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@base-tools.test`;

type Member = Person & { api: BasesApi };
const withApi = (p: Person): Member => ({ ...p, api: basesApi(p.browser) });

/** Ana (owner), Beto (member) and Lia in #general; Beto asks Lia. */
async function withAgent(scopes?: string[]) {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  const lia = await seedAgent(server, workspaceId, ana, { channels: [general], scopes });
  const run = await toolRun(server, { workspaceId, agent: lia, channelId: general, asker: beto });
  return { workspaceId, general, ana, beto, lia, ...run };
}

describe("bases: the agent's tools", () => {
  test(
    "attack: the agent's search finds a base row only with the bases' scope (not with the wiki's)",
    async () => {
      const ws = await withAgent(["context:read", "wiki:read"]);
      const { base, table } = await baseWithTypes(ws.ana.api, ws.workspaceId, "Suppliers");
      await ws.ana.api.createRow(ws.workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "Zebrasupplier" },
      });
      expect((await ws.call("query_base", { base: base.id })).content).toContain("Unknown tool");
      expect((await ws.call("search", { query: "Zebrasupplier" })).content).not.toContain("db_row");
      const allowed = await withAgent(["context:read", "bases:read"]);
      const other = await baseWithTypes(allowed.ana.api, allowed.workspaceId, "Suppliers");
      await allowed.ana.api.createRow(allowed.workspaceId, other.base.id, other.table.id, {
        props: { [other.table.titlePropId]: "Zebrasupplier" },
      });
      await server.deps.runtime.settle();
      expect((await allowed.call("search", { query: "Zebrasupplier" })).content).toContain(
        "db_row · Zebrasupplier",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "schema, a query by name, an upsert with parentVersion, a conflict and undo/redo",
    async () => {
      const { workspaceId, ana, beto, call, action } = await withAgent();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Orders");
      const t = table.titlePropId;
      const first = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "Order 1", p_num: 10 },
      });

      expect((await call("list_bases", {})).content).toContain(`${base.id} · "Orders" · 1 rows`);
      const schemaText = (await call("read_base_schema", { base: "orders" })).content;
      expect(schemaText).toContain("- Stage (select) · options: Alpha, Beta");
      expect(schemaText).toContain('= prop("Amount") * 2 → number');

      const good = [
        { values: { Name: "Order 2", Amount: 7, Stage: "Beta", Status: "Done", Due: "2026-11-01" } },
        { id: first.id, parentVersion: 1, values: { Amount: 11 } },
      ];
      // one wrong row leaves the whole batch out
      const wrong = await call("upsert_base_rows", {
        base: base.id,
        rows: [...good, { values: { Stage: "Gamma" } }],
      });
      expect(wrong.isError).toBe(true);
      expect(wrong.content).toContain('#3 not saved: "Gamma" is not a valid select');
      expect(wrong.content).toContain("Nothing was saved");
      expect((await ana.api.query(workspaceId, base.id, table.id)).total).toBe(1);
      const created = await call("upsert_base_rows", { base: base.id, rows: good });
      expect(created.content).toContain("#1 created");
      expect(created.content).toContain(`#2 updated ${first.id} (parentVersion 2)`);
      const q = await call("query_base", {
        base: "Orders",
        filter: {
          and: [
            { prop: "Stage", op: "eq", value: "Beta" },
            { prop: "Status", op: "group", value: "done" },
          ],
        },
      });
      expect(q.content).toContain("1 rows match");
      expect(q.content).toContain('"Name":"Order 2"');
      expect(q.content).toContain('"Double":"14"');

      // someone saves after the agent read: the agent gets the current values, nothing is overwritten
      await beto.api.updateRow(workspaceId, base.id, first.id, { props: { p_num: 99 }, parentVersion: 2 });
      const stale = await call("upsert_base_rows", {
        base: base.id,
        rows: [{ id: first.id, parentVersion: 2, values: { Amount: 1 } }],
      });
      expect(stale.isError).toBe(true);
      expect(stale.content).toContain(`conflict: someone saved ${first.id}`);
      expect(stale.content).toContain('"Amount":"99"');
      expect((await ana.api.getRow(workspaceId, base.id, first.id)).props.p_num).toBe(99);

      // undoing the agent's write: the edited row changed since → conflict
      const actionId = await action("base_rows_upserted");
      expect((await undo(beto, workspaceId, actionId)).code).toBe("action.changed_since");
      await beto.api.updateRow(workspaceId, base.id, first.id, { props: { p_num: 11 }, parentVersion: 3 });
      // a version other than the one the agent left: still rejected
      expect((await undo(beto, workspaceId, actionId)).code).toBe("action.changed_since");
    },
    SERVER_TEST_MS,
  );

  test(
    "undo deletes the created rows and brings back the values from before; redo writes again",
    async () => {
      const { workspaceId, ana, beto, call, action } = await withAgent();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Groceries");
      const t = table.titlePropId;
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "Milk", p_num: 1 },
      });
      await call("upsert_base_rows", {
        base: "Groceries",
        rows: [
          { values: { Name: "Bread" } },
          { id: row.id, parentVersion: 1, values: { Amount: 3, Ok: true } },
        ],
      });
      const actionId = await action("base_rows_upserted");
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
      expect((await undo(beto, workspaceId, actionId)).status).toBe(200);
      expect(await titles()).toEqual([["Milk", 1, null]]);
      expect((await undo(beto, workspaceId, actionId, "redo")).status).toBe(200);
      const after = (await beto.api.query(workspaceId, base.id, table.id)).rows;
      expect(after.map((r) => r.props[t])).toEqual(["Milk", "Bread"]);
      expect(after[0]?.props).toMatchObject({ p_num: 3, p_ok: true });
      // and again: undo after redo
      expect((await undo(beto, workspaceId, actionId)).status).toBe(200);
      expect((await beto.api.query(workspaceId, base.id, table.id)).rows.map((r) => r.props[t])).toEqual([
        "Milk",
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "undo is all or nothing: if one row can't go back, none does",
    async () => {
      const { workspaceId, ana, beto, call, action } = await withAgent();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Stages");
      const t = table.titlePropId;
      const a = await ana.api.createRow(workspaceId, base.id, table.id, { props: { [t]: "A", p_num: 1 } });
      const b = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "B", p_sel: "o_a" },
      });
      await call("upsert_base_rows", {
        base: base.id,
        rows: [
          { id: a.id, parentVersion: 1, values: { Amount: 2 } },
          { id: b.id, parentVersion: 1, values: { Stage: "Beta" } },
        ],
      });
      const actionId = await action("base_rows_upserted");
      // someone removes the option B had before the agent: B can't go back
      const fresh = (await ana.api.get(workspaceId, base.id)).tables[0];
      if (!fresh) throw new Error("no table");
      await ana.api.saveSchema(workspaceId, base.id, table.id, {
        parentVersion: fresh.schemaVersion,
        defs: fresh.defs.map((d) =>
          d.id === "p_sel" ? { ...d, options: (d.options ?? []).filter((o) => o.id !== "o_a") } : d,
        ),
      });
      const snapshot = async () =>
        (await ana.api.query(workspaceId, base.id, table.id)).rows.map((r) => [r.props[t], r.version]);
      const before = await snapshot();
      for (let i = 0; i < 2; i++) {
        expect(await undo(beto, workspaceId, actionId)).toEqual({
          status: 409,
          code: "action.changed_since",
        });
        expect(await snapshot()).toEqual(before);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "the same row twice in one call can still be undone",
    async () => {
      const { workspaceId, ana, beto, call, action } = await withAgent();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Twice");
      const row = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [table.titlePropId]: "Milk", p_num: 1 },
      });
      await call("upsert_base_rows", {
        base: base.id,
        rows: [
          { id: row.id, parentVersion: 1, values: { Amount: 2 } },
          { id: row.id, parentVersion: 2, values: { Amount: 3 } },
        ],
      });
      const actionId = await action("base_rows_upserted");
      expect((await ana.api.getRow(workspaceId, base.id, row.id)).props.p_num).toBe(3);
      expect((await undo(beto, workspaceId, actionId)).status).toBe(200);
      expect((await ana.api.getRow(workspaceId, base.id, row.id)).props.p_num).toBe(1);
      expect((await undo(beto, workspaceId, actionId, "redo")).status).toBe(200);
      expect((await ana.api.getRow(workspaceId, base.id, row.id)).props.p_num).toBe(3);
    },
    SERVER_TEST_MS,
  );

  test(
    "the agent sees the title and id of linked rows and the rollup, and writes the relation by ids",
    async () => {
      const { workspaceId, ana, call } = await withAgent();
      const tasks = await ana.api.create(workspaceId, { title: "Tasks" });
      const tt = tasks.tables[0];
      if (!tt) throw new Error("no table");
      await ana.api.saveSchema(workspaceId, tasks.id, tt.id, {
        parentVersion: tt.schemaVersion,
        defs: [...tt.defs, { id: "hours", name: "Hours", type: "number" }],
      });
      const projects = await ana.api.create(workspaceId, { title: "Projects" });
      const pt = projects.tables[0];
      if (!pt) throw new Error("no table");
      const defs: BasePropDef[] = [
        ...pt.defs,
        { id: "rel", name: "Tasks", type: "relation", relation: { tableId: tt.id } },
        {
          id: "sum",
          name: "Hours",
          type: "rollup",
          rollup: { relationPropId: "rel", targetPropId: "hours", fn: "sum" },
        },
      ];
      await ana.api.saveSchema(workspaceId, projects.id, pt.id, { parentVersion: pt.schemaVersion, defs });
      const task = (title: string, hours: number) =>
        ana.api.createRow(workspaceId, tasks.id, tt.id, { props: { [tt.titlePropId]: title, hours } });
      const t1 = await task("Wash", 2);
      const t2 = await task("Dry", 3);
      const schemaText = (await call("read_base_schema", { base: projects.id })).content;
      expect(schemaText).toContain(`- Tasks (relation) · links rows of table ${tt.id}`);
      expect(schemaText).toContain('- Hours (rollup) · = sum over "Tasks" → number (read-only)');
      const saved = await call("upsert_base_rows", {
        base: projects.id,
        rows: [{ values: { Name: "House", Tasks: `${t1.id}, ${t2.id}` } }],
      });
      expect(saved.content).toContain("#1 created");
      await server.deps.runtime.settle();
      const q = await call("query_base", { base: projects.id });
      expect(q.content).toContain(`"Tasks":"Wash [${t1.id}], Dry [${t2.id}]"`);
      expect(q.content).toContain('"Hours":"5"');
      // a row id that is not of the linked source: rejected with the reason
      const bad = await call("upsert_base_rows", {
        base: projects.id,
        rows: [{ values: { Name: "Wrong", Tasks: ["dbr_none"] } }],
      });
      expect(bad.content).toContain("#1 not saved");
    },
    SERVER_TEST_MS,
  );

  test(
    "bad input is a tool error, never a throw: an unknown base, an unknown property, a bad filter",
    async () => {
      const { workspaceId, ana, call } = await withAgent();
      const { base } = await baseWithTypes(ana.api, workspaceId, "Inputs");
      await ana.api.create(workspaceId, { title: "Inputs" });
      for (const [tool, input, text] of [
        ["query_base", { base: "nope" }, "Database nope not found"],
        ["query_base", { base: "Inputs" }, 'More than one database is called "Inputs"'],
        [
          "query_base",
          { base: base.id, filter: { prop: "Ghost", op: "eq", value: 1 } },
          'Unknown property "Ghost"',
        ],
        ["query_base", { base: base.id, filter: "x" }, "Invalid filter"],
        ["query_base", { base: base.id, view: "Nope" }, 'View "Nope" not found'],
        ["upsert_base_rows", { base: base.id, rows: [] }, "Invalid input"],
        ["list_bases", { q: "a\u0000b" }, "Invalid input"],
      ] as const) {
        const out = await call(tool, input);
        expect(out.isError).toBe(true);
        expect(out.content).toContain(text);
      }
      const noVersion = await call("upsert_base_rows", {
        base: base.id,
        rows: [{ id: "dbr_x", values: { Amount: 1 } }],
      });
      expect(noVersion.content).toContain("pass the parentVersion you read with query_base");
    },
    SERVER_TEST_MS,
  );

  test(
    "a batch is all or nothing with its receipt: a wrong value or a conflict midway leaves no row and no undo",
    async () => {
      const { workspaceId, ana, lia, call } = await withAgent();
      const { base, table } = await baseWithTypes(ana.api, workspaceId, "Batch");
      const t = table.titlePropId;
      const first = await ana.api.createRow(workspaceId, base.id, table.id, {
        props: { [t]: "Kept", p_num: 1 },
      });
      const receipts = async () =>
        (
          await server.deps.db
            .select()
            .from(schema.reversibleActions)
            .where(eq(schema.reversibleActions.agentId, lia.id))
        ).length;
      const titles = async () =>
        (await ana.api.query(workspaceId, base.id, table.id)).rows.map((r) => r.props[t]).sort();
      // an object where text goes is a tool error, not a throw, and the valid row before it stays out
      const objectValue = await call("upsert_base_rows", {
        base: base.id,
        rows: [{ values: { Name: "valid" } }, { values: { Name: { toString: null } } }],
      });
      expect(objectValue).toMatchObject({ isError: true });
      expect(objectValue.content).toContain('#2 not saved: "Name" takes text');
      const badFilter = await call("query_base", {
        base: base.id,
        filter: { prop: { toString: null }, op: "eq" },
      });
      expect(badFilter).toMatchObject({ isError: true, content: "Invalid filter: prop is a property name" });
      // a conflict on the second row, after the first was created inside the transaction: both roll back
      await ana.api.updateRow(workspaceId, base.id, first.id, { props: { p_num: 2 }, parentVersion: 1 });
      const midway = await call("upsert_base_rows", {
        base: base.id,
        rows: [
          { values: { Name: "created then rolled back" } },
          { id: first.id, parentVersion: 1, values: { Amount: 9 } },
        ],
      });
      expect(midway.isError).toBe(true);
      expect(midway.content).toContain(`#2 conflict: someone saved ${first.id}`);
      expect(midway.content).toContain("Nothing was saved");
      expect(await titles()).toEqual(["Kept"]);
      expect((await ana.api.getRow(workspaceId, base.id, first.id)).props.p_num).toBe(2);
      expect(await receipts()).toBe(0);
      // a batch that saves writes its receipt with it
      expect(
        (await call("upsert_base_rows", { base: base.id, rows: [{ values: { Name: "New" } }] })).isError,
      ).toBe(false);
      expect(await titles()).toEqual(["Kept", "New"]);
      expect(await receipts()).toBe(1);
    },
    SERVER_TEST_MS,
  );
});
