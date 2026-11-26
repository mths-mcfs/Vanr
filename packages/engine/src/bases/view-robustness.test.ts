import { describe, expect, test } from "bun:test";
import { evaluateRow, planFormulas } from "../formula";
import type { PropDef } from "../props";
import {
  checkFilter,
  effectiveFilter,
  type Filter,
  type FilterCondition,
  pruneFilter,
  type RowView,
  resolveDay,
  rowMatches,
} from "./view";

const DEFS: PropDef[] = [
  {
    id: "s",
    name: "Status",
    type: "status",
    options: [{ id: "a", name: "A" }],
    groups: { todo: ["a"], inProgress: [], done: [] },
  },
  { id: "d", name: "When", type: "date" },
];
const ROW: RowView = {
  props: { s: "a", d: { start: "0001-01-01" } },
  computed: {},
  createdAt: "2026-01-01T00:00:00Z",
  editedAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  editedBy: null,
};
const match = (f: Filter) => rowMatches(f, DEFS, ROW, { now: Date.UTC(2026, 0, 1) });

describe("view filter robustness", () => {
  test("a group name inherited from the prototype matches nothing instead of throwing", () => {
    expect(match({ prop: "s", op: "group", value: "constructor" })).toBe(false);
    expect(match({ prop: "s", op: "group", value: "todo" })).toBe(true);
  });

  test("a filter day that does not exist is rejected", () => {
    expect(checkFilter({ prop: "d", op: "before", value: "2026-02-31" }, DEFS)).toEqual([
      "bad_value:d:before",
    ]);
    expect(checkFilter({ prop: "d", op: "before", value: "2026-02-28" }, DEFS)).toEqual([]);
  });

  test("days before year 1000 keep four digits", () => {
    const year5 = new Date(0);
    year5.setUTCFullYear(5, 0, 1);
    expect(resolveDay({ rel: "tomorrow" }, year5.getTime())).toBe("0005-01-02");
    const ct: PropDef[] = [{ id: "ct", name: "Created", type: "created_time" }];
    const old = { ...ROW, createdAt: "0001-01-01T10:00:00Z" };
    expect(rowMatches({ prop: "ct", op: "eq", value: "0001-01-01" }, ct, old, { now: 0 })).toBe(true);
  });
});

test("person formulas validate and match the querying actor", () => {
  const defs: PropDef[] = [
    { id: "who", name: "Creator", type: "creator" },
    { id: "f", name: "F", type: "formula", formula: { expression: 'prop("Creator")', resultType: "person" } },
  ];
  const me = { type: "person" as const, id: "u1" };
  const row = { ...ROW, id: "r", props: {}, createdBy: me };
  const computed = evaluateRow(planFormulas(defs), defs, row, { now: 0 }).computed;
  expect(computed.f).toEqual(me);
  for (const op of ["has", "has_not"]) {
    const filter = { prop: "f", op, value: "me" };
    expect(checkFilter(filter, defs)).toEqual([]);
    expect(rowMatches(filter, defs, { ...row, computed }, { now: 0, me })).toBe(op === "has");
  }
});

test("stored and computed dates use the same UTC day as system timestamps", () => {
  const defs: PropDef[] = [
    { id: "d", name: "D", type: "date" },
    { id: "f", name: "F", type: "formula", formula: { expression: 'prop("D")', resultType: "date" } },
    { id: "ct", name: "Created", type: "created_time" },
  ];
  const row = {
    ...ROW,
    id: "r",
    props: { d: { start: "2026-11-14T00:30:00+02:00" } },
    createdAt: "2026-11-14T00:30:00+02:00",
  };
  const computed = evaluateRow(planFormulas(defs), defs, row, { now: 0 }).computed;
  for (const prop of ["d", "f", "ct"]) {
    expect(rowMatches({ prop, op: "eq", value: "2026-11-13" }, defs, { ...row, computed }, { now: 0 })).toBe(
      true,
    );
  }
});

test("pruning removes references to deleted options for scalar and list operators", () => {
  for (const type of ["select", "status", "multi_select"] as const) {
    const def: PropDef = { id: "s", name: "S", type, options: [{ id: "todo", name: "Todo" }] };
    const ops = type === "multi_select" ? ["has", "has_all"] : ["eq", "in"];
    for (const op of ops) {
      const value = ["in", "has_all"].includes(op) ? ["todo", "removed"] : "removed";
      expect(pruneFilter({ prop: "s", op, value }, [def])).toBeNull();
    }
    const op = type === "multi_select" ? "has" : "eq";
    expect(checkFilter({ prop: "s", op, value: "todo" }, [def])).toEqual([]);
  }
});

test("quick filters choose the operator from the property family", () => {
  const defs: PropDef[] = [
    { id: "p", name: "Who", type: "person" },
    { id: "t", name: "Text", type: "text" },
    { id: "m", name: "Tags", type: "multi_select", options: [{ id: "a", name: "A" }] },
    { id: "d", name: "Date", type: "date" },
  ];
  const cases: [string, FilterCondition["value"], string][] = [
    ["p", "me", "has"],
    ["t", "me", "eq"],
    ["m", "a", "has"],
    ["m", ["a"], "has_any"],
    ["d", ["2026-11-01", "2026-11-02"], "between"],
  ];
  for (const [prop, value, op] of cases) {
    const filter = effectiveFilter({ quickFilters: [{ prop, value }] }, defs);
    expect(filter).toEqual({ prop, value, op });
    expect(filter && checkFilter(filter, defs)).toEqual([]);
  }
});
