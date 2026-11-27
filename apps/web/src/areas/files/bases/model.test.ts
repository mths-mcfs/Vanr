// The base screens' own reckoning: a cell's text, the columns of a view, a new condition per type, the
// group a row falls in and the value that moves it there, and a number typed with a comma.
import { describe, expect, test } from "bun:test";
import type { BasePropDef, BaseRow, BaseTable } from "@vanr/contract";
import { parseNumber } from "./cells.tsx";
import {
  cellText,
  flatFilter,
  groupKeyOf,
  newCondition,
  toFilter,
  toggleColumn,
  valueForGroup,
  viewColumns,
} from "./model.ts";

const row = (props: Record<string, unknown>, computed: Record<string, unknown> = {}): BaseRow => ({
  id: "dbr_1",
  databaseId: "db_1",
  tableId: "dbt_1",
  position: "a",
  props,
  computed,
  createdAt: "2026-11-01T10:00:00.000Z",
  createdBy: { type: "person", id: "usr_ana" },
  editedAt: "2026-11-02T10:00:00.000Z",
  editedBy: { type: "agent", id: "agt_scout" },
  hasBody: false,
  version: 1,
});
const context = { names: (actor: { id: string }) => actor.id, locale: "en" };
const def = (type: BasePropDef["type"], extra: Partial<BasePropDef> = {}): BasePropDef => ({
  id: "p",
  name: "P",
  type,
  ...extra,
});
const table: BaseTable = {
  id: "dbt_1",
  databaseId: "db_1",
  name: "T",
  titlePropId: "title",
  schemaVersion: 1,
  defs: [
    def("text", { id: "title", name: "Name" }),
    def("number", { id: "n", name: "N" }),
    def("date", { id: "d", name: "D" }),
  ],
  formulaErrors: {},
  recalc: { done: 0, pending: false, version: 0 },
};

describe("a cell's text", () => {
  test("by type, in the interface language", () => {
    expect(
      cellText(def("number", { numberFormat: "currency_brl" }), row({ p: 12.5 }), {
        ...context,
        locale: "pt-BR",
      }),
    ).toMatch(/^R\$\s12,50$/);
    expect(cellText(def("date"), row({ p: { start: "2026-11-01", end: "2026-11-03" } }), context)).toBe(
      "Nov 1, 2026 → Nov 3, 2026",
    );
    expect(cellText(def("checkbox"), row({ p: true }), context)).toBe("✓");
    const status = def("status", { options: [{ id: "o1", name: "Doing" }] });
    expect(cellText(status, row({ p: "o1" }), context)).toBe("Doing");
    expect(cellText(def("editor"), row({}), context)).toBe("agt_scout");
  });

  test("a relation by the linked rows' titles, a rollup by its computed value, an error as empty", () => {
    const linked = {
      r1: { databaseId: "db_2", tableId: "dbt_2", title: "Wash" },
      r2: { databaseId: "db_2", tableId: "dbt_2", title: "Dry" },
    };
    expect(cellText(def("relation"), row({ p: ["r1", "r2", "gone"] }), { ...context, linked })).toBe(
      "Wash, Dry",
    );
    expect(cellText(def("rollup"), row({}, { p: 5 }), context)).toBe("5");
    expect(cellText(def("formula"), row({}, { p: { err: "division_by_zero" } }), context)).toBe("");
  });
});

describe("a view's columns", () => {
  test("the title first, then the saved order, then the new ones; hidden ones out, the title never", () => {
    const config = { columns: [{ prop: "d" }, { prop: "n", hidden: true }] };
    expect(viewColumns(table, config).map((each) => each.id)).toEqual(["title", "d"]);
    expect(viewColumns(table, toggleColumn(table, config, "n")).map((each) => each.id)).toEqual([
      "title",
      "d",
      "n",
    ]);
    expect(toggleColumn(table, config, "title")).toBe(config);
  });
});

describe("filters and groups", () => {
  test("a new condition fits its type, and the flat filter round-trips", () => {
    expect(newCondition(def("checkbox"))).toEqual({ prop: "p", op: "eq", value: true });
    expect(newCondition(def("person"))).toEqual({ prop: "p", op: "has", value: "me" });
    expect(newCondition(def("relation"))).toEqual({ prop: "p", op: "not_empty" });
    const conditions = [newCondition(def("number")), newCondition(def("text"))];
    expect(flatFilter(toFilter("or", conditions))).toEqual({ mode: "or", conditions });
    expect(toFilter("and", [])).toBeNull();
  });

  test("the first person decides the group; a date groups by its start day; dragging sets the value back", () => {
    const people = def("person");
    expect(
      groupKeyOf(
        people,
        row({
          p: [
            { type: "agent", id: "agt_1" },
            { type: "person", id: "usr_2" },
          ],
        }),
      ),
    ).toBe("agent:agt_1");
    expect(groupKeyOf(def("date"), row({ p: { start: "2026-11-01T10:00:00Z" } }))).toBe("2026-11-01");
    expect(valueForGroup(people, "person:usr_2")).toEqual([{ type: "person", id: "usr_2" }]);
    expect(valueForGroup(def("checkbox"), "true")).toBe(true);
    expect(valueForGroup(def("multi_select"), "x")).toBeUndefined();
  });
});

describe("a number typed in a cell", () => {
  test("takes a comma or a dot, empties to null and refuses the rest", () => {
    expect(parseNumber("4,5")).toBe(4.5);
    expect(parseNumber(" 1 200.25 ")).toBe(1200.25);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("lots")).toBeUndefined();
    expect(parseNumber("1e999")).toBeUndefined();
  });
});
