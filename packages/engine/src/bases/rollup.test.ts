import { describe, expect, test } from "bun:test";
import { evaluateRow, planFormulas, propFType } from "../formula";
import { type FValue, fromJson, T, toJson } from "../formula/values";
import { applyProps, checkDefs, MAX_RELATED, type PropDef, type Props, ROLLUP_FNS } from "../props";
import { type LinkedRow, linkedValues, rollupReadable, rollupType, rollupValue } from "./rollup";
import { cellOf, checkFilter, type Filter, filterKind, rowMatches } from "./view";

const day = (iso: string): FValue => ({ kind: "date", start: Date.parse(`${iso}T00:00:00Z`), time: false });

describe("rollup", () => {
  test("counts, percentages and uniques over the linked rows", () => {
    const vals: FValue[] = ["a", null, "b", "a", ""];
    expect(rollupValue("count", vals)).toBe(5);
    expect(rollupValue("count_values", vals)).toBe(3);
    expect(rollupValue("count_unique", vals)).toBe(2);
    expect(rollupValue("count_empty", vals)).toBe(2);
    expect(rollupValue("count_not_empty", vals)).toBe(3);
    expect(rollupValue("percent_empty", vals)).toBeCloseTo(0.4);
    expect(rollupValue("percent_not_empty", vals)).toBeCloseTo(0.6);
    expect(rollupValue("show_original", vals)).toEqual(["a", "b", "a"]);
    expect(rollupValue("show_unique", vals)).toEqual(["a", "b"]);
    // multi: each option counts as a value
    expect(rollupValue("count_values", [["x", "y"], ["y"], []])).toBe(3);
    expect(rollupValue("count_unique", [["x", "y"], ["y"], []])).toBe(2);
  });

  test("numbers, dates and checkbox; no linked row", () => {
    expect(rollupValue("sum", [3, null, 4.5])).toBe(7.5);
    expect(rollupValue("average", [2, 4, null])).toBe(3);
    expect(rollupValue("median", [5, 1, 3, 10])).toBe(4);
    expect(rollupValue("min", [5, -1, 3])).toBe(-1);
    expect(rollupValue("max", [5, -1, 3])).toBe(5);
    expect(rollupValue("range", [5, -1, 3])).toBe(6);
    expect(toJson(rollupValue("earliest", [day("2026-03-02"), null, day("2026-01-10")]))).toEqual({
      start: "2026-01-10",
    });
    expect(toJson(rollupValue("latest", [day("2026-03-02"), day("2026-01-10")]))).toEqual({
      start: "2026-03-02",
    });
    expect(toJson(rollupValue("date_range", [day("2026-03-02"), day("2026-01-10")]))).toEqual({
      start: "2026-01-10",
      end: "2026-03-02",
    });
    expect(rollupValue("checked", [true, false, null, true])).toBe(2);
    expect(rollupValue("unchecked", [true, false, null, true])).toBe(2);
    expect(rollupValue("percent_checked", [true, false, null, true])).toBe(0.5);
    // nothing linked: the count and the sum give 0, the average and the dates stay empty
    expect(rollupValue("count", [])).toBe(0);
    expect(rollupValue("sum", [])).toBe(0);
    expect(rollupValue("average", [])).toBeNull();
    expect(rollupValue("percent_checked", [])).toBeNull();
    expect(rollupValue("earliest", [])).toBeNull();
  });

  test("result type: a function that doesn't fit the target is rejected", () => {
    expect(rollupType("sum", T.number)).toEqual(T.number);
    expect(rollupType("sum", T.text)).toBeNull();
    expect(rollupType("earliest", T.date)).toEqual(T.date);
    expect(rollupType("earliest", T.number)).toBeNull();
    expect(rollupType("percent_checked", T.boolean)).toEqual(T.number);
    expect(rollupType("checked", T.text)).toBeNull();
    expect(rollupType("show_original", T.list(T.text))).toEqual(T.list(T.text));
    expect(rollupType("count", T.person)).toEqual(T.number);
    // every function has a type for a loose target (a formula of type any)
    for (const fn of ROLLUP_FNS) expect(rollupType(fn, T.any)).not.toBeNull();
  });

  test("schema: a relation needs its source; a rollup, a relation of the same source", () => {
    const rel: PropDef = { id: "rel", name: "Projects", type: "relation", relation: { tableId: "dbt_x" } };
    const ok: PropDef = {
      id: "r",
      name: "Hours",
      type: "rollup",
      rollup: { relationPropId: "rel", targetPropId: "h", fn: "sum" },
    };
    expect(checkDefs([rel, ok])).toEqual([]);
    expect(checkDefs([{ id: "rel", name: "R", type: "relation" }])).toEqual([
      { code: "missing_relation", propId: "rel" },
    ]);
    expect(checkDefs([{ ...ok, rollup: { relationPropId: "none", targetPropId: "h", fn: "sum" } }])).toEqual([
      { code: "bad_rollup", propId: "r" },
    ]);
  });

  test("the relation's value: row ids, no repeats, up to 100; a rollup isn't written", () => {
    const defs: PropDef[] = [
      { id: "rel", name: "R", type: "relation", relation: { tableId: "dbt_x" } },
      {
        id: "r",
        name: "Total",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "h", fn: "count" },
      },
    ];
    expect(applyProps(defs, {}, { rel: ["dbr_abc", "dbr_def"] })).toEqual({
      ok: true,
      props: { rel: ["dbr_abc", "dbr_def"] },
    });
    for (const bad of [
      ["dbr_abc", "dbr_abc"],
      ["x"],
      ["dbr_A"],
      "dbr_abc",
      Array.from({ length: MAX_RELATED + 1 }, (_, i) => `dbr_${i}`),
    ])
      expect(applyProps(defs, {}, { rel: bad }).ok).toBe(false);
    // the cap is the constant: exactly MAX_RELATED ids pass
    const full = Array.from({ length: MAX_RELATED }, (_, i) => `dbr_${i}`);
    expect(applyProps(defs, {}, { rel: full }).ok).toBe(true);
    expect(applyProps(defs, {}, { r: 3 })).toEqual({
      ok: false,
      errors: [{ propId: "r", code: "read_only" }],
    });
  });

  test("a formula reads the relation (titles) and the rollup; the rollup's filter by its result type", () => {
    const defs: PropDef[] = [
      { id: "rel", name: "Tasks", type: "relation", relation: { tableId: "dbt_x" } },
      {
        id: "r",
        name: "Hours",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "h", fn: "sum", resultType: "number" },
      },
      {
        id: "f",
        name: "Summary",
        type: "formula",
        formula: { expression: 'prop("Hours") * 2 + length(prop("Tasks"))' },
      },
    ];
    expect(propFType(defs[1] as PropDef)).toEqual(T.number);
    const plan = planFormulas(defs);
    expect(plan.errors.size).toBe(0);
    const out = evaluateRow(
      plan,
      defs,
      {
        id: "dbr_1",
        props: { rel: ["dbr_a", "dbr_b"] },
        createdAt: "2026-10-23T00:00:00Z",
        editedAt: "2026-10-23T00:00:00Z",
        createdBy: null,
        editedBy: null,
        extra: { rel: ["Wash", "Dry"], r: 7 },
      },
      { now: 0 },
    );
    expect(out.computed.f).toBe(16);
    const rollup = defs[1] as PropDef;
    expect(filterKind(rollup)).toBe("number");
    expect(filterKind(defs[0] as PropDef)).toBe("multi");
    const row = {
      props: { rel: ["dbr_a"] },
      computed: { r: 7 },
      createdAt: "",
      editedAt: "",
      createdBy: null,
      editedBy: null,
    };
    expect(cellOf(rollup, row)).toBe(7);
    expect(rowMatches({ prop: "r", op: "gt", value: 5 }, defs, row, { now: 0 })).toBe(true);
    expect(rowMatches({ prop: "rel", op: "has", value: "dbr_a" }, defs, row, { now: 0 })).toBe(true);
    expect(cellOf(rollup, { ...row, computed: { r: { err: "x" } } })).toBeUndefined();
  });

  test("fromJson undoes toJson (number, text, date, person, list)", () => {
    const samples: FValue[] = [
      3,
      "a",
      true,
      day("2026-01-02"),
      {
        kind: "date",
        start: Date.parse("2026-01-02T10:00:00Z"),
        end: Date.parse("2026-01-03T10:00:00Z"),
        time: true,
      },
      { kind: "person", type: "agent", id: "agt_1", name: "agt_1" },
      ["x", 2],
    ];
    for (const v of samples) expect(fromJson(toJson(v))).toEqual(v);
    expect(fromJson({ err: "x" })).toBeNull();
  });

  test("a rollup only reads a stored value or a formula that depends only on that (no cycle between sources)", () => {
    const defs: PropDef[] = [
      { id: "t", name: "Name", type: "text" },
      { id: "h", name: "Hours", type: "number" },
      { id: "rel", name: "R", type: "relation", relation: { tableId: "dbt_y" } },
      {
        id: "r",
        name: "Sum",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "h", fn: "sum" },
      },
      { id: "f1", name: "Double", type: "formula", formula: { expression: 'prop("Hours") * 2' } },
      { id: "f2", name: "Via", type: "formula", formula: { expression: 'prop("Double") + prop("Sum")' } },
      { id: "f3", name: "Titles", type: "formula", formula: { expression: 'length(prop("R"))' } },
      { id: "f4", name: "Broken", type: "formula", formula: { expression: "1 +" } },
      // the clock moves the value without the row changing: two sources would recalculate each other forever
      { id: "f5", name: "Age", type: "formula", formula: { expression: "now()" } },
      { id: "f6", name: "Late", type: "formula", formula: { expression: 'prop("Age") > prop("Hours")' } },
    ];
    expect(rollupReadable(defs, "h")).toBe(true);
    expect(rollupReadable(defs, "f1")).toBe(true);
    for (const id of ["rel", "r", "f2", "f3", "f4", "f5", "f6", "none"])
      expect({ id, ok: rollupReadable(defs, id) }).toEqual({ id, ok: false });
  });

  test("linkedValues: titles, rollup, an id of another source or deleted ignored, a forbidden target is an error", () => {
    const y = {
      id: "dbt_y",
      titlePropId: "yt",
      defs: [
        { id: "yt", name: "Task", type: "text" },
        { id: "yh", name: "Hours", type: "number" },
        {
          id: "yr",
          name: "Back",
          type: "rollup",
          rollup: { relationPropId: "x", targetPropId: "a", fn: "count" },
        },
      ] as PropDef[],
    };
    const row = (id: string, tableId: string, props: Props): LinkedRow => ({
      id,
      tableId,
      props,
      computed: {},
      createdAt: "2026-10-23T00:00:00Z",
      editedAt: "2026-10-23T00:00:00Z",
      createdBy: null,
      editedBy: null,
    });
    const rows = new Map([
      ["dbr_a", row("dbr_a", "dbt_y", { yt: "Wash", yh: 2 })],
      ["dbr_b", row("dbr_b", "dbt_y", { yt: "Dry", yh: 3.5 })],
      ["dbr_z", row("dbr_z", "dbt_other", { yt: "Intruder", yh: 100 })],
    ]);
    const defs: PropDef[] = [
      { id: "rel", name: "Tasks", type: "relation", relation: { tableId: "dbt_y" } },
      {
        id: "s",
        name: "Total",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "yh", fn: "sum" },
      },
      {
        id: "c",
        name: "Count",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "yt", fn: "count" },
      },
      {
        id: "bad",
        name: "Bad",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "yr", fn: "sum" },
      },
      {
        id: "gone",
        name: "Gone",
        type: "rollup",
        rollup: { relationPropId: "rel", targetPropId: "xx", fn: "sum" },
      },
    ];
    const out = linkedValues(
      defs,
      { rel: ["dbr_a", "dbr_b", "dbr_z", "dbr_deleted"] },
      { tables: new Map([["dbt_y", y]]), rows },
    );
    expect(out.extra.rel).toEqual(["Wash", "Dry"]);
    expect(out.computed).toEqual({ s: 5.5, c: 2, bad: { err: "bad_rollup" }, gone: { err: "bad_rollup" } });
    // nothing linked: sum 0, count 0
    expect(linkedValues(defs, {}, { tables: new Map([["dbt_y", y]]), rows }).computed).toMatchObject({
      s: 0,
      c: 0,
    });
  });

  test("overlaps: the span of the date touches the window, its end included; the value needs two dates", () => {
    const defs: PropDef[] = [{ id: "d", name: "When", type: "date" }];
    const row = (d: Props["d"] | undefined) => ({
      props: d === undefined ? {} : { d },
      computed: {},
      createdAt: "",
      editedAt: "",
      createdBy: null,
      editedBy: null,
    });
    const window: Filter = { prop: "d", op: "overlaps", value: ["2026-10-01", "2026-10-31"] };
    const cases: [Props["d"] | undefined, boolean][] = [
      [{ start: "2026-10-05" }, true],
      [{ start: "2026-09-20", end: "2026-10-01" }, true],
      [{ start: "2026-09-20", end: "2026-09-30" }, false],
      [{ start: "2026-10-31", end: "2026-12-01" }, true],
      [{ start: "2026-11-01" }, false],
      // an end before the start counts as the start alone
      [{ start: "2026-11-02", end: "2026-09-01" }, false],
      [undefined, false],
    ];
    for (const [d, want] of cases)
      expect({ d, got: rowMatches(window, defs, row(d), { now: 0 }) }).toEqual({ d, got: want });
    expect(checkFilter(window, defs)).toEqual([]);
    expect(checkFilter({ prop: "d", op: "overlaps", value: ["2026-10-01"] }, defs)).toEqual([
      "bad_value:d:overlaps",
    ]);
  });
});
