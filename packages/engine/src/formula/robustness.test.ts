import { describe, expect, test } from "bun:test";
import { applyProps, type PropDef } from "../props";
import { checkFormula, evaluateRow, planFormulas, previewFormula, type RowData } from "./index";

const ROW: RowData = {
  id: "r",
  props: {},
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  editedAt: "2026-01-01T00:00:00Z",
  editedBy: null,
};
const NOW = Date.UTC(2026, 9, 22);

function run(src: string): unknown {
  const r = previewFormula(src, [], ROW, { now: NOW });
  if (r.ok) return r.value;
  return "errors" in r ? `#${r.errors[0]?.code}` : `#${r.runtime}`;
}

function rowResult(expression: string) {
  const defs: PropDef[] = [{ id: "f", name: "F", type: "formula", formula: { expression } }];
  return evaluateRow(planFormulas(defs), defs, ROW, { now: NOW });
}

describe("lists cost steps by the size they copy or create", () => {
  const xs = 'split(repeat("x,", 1999), ",")';
  test.each([
    ["reverse", `let(xs, ${xs}, length(map(xs, reverse(xs))))`],
    ["slice", `let(xs, ${xs}, length(map(xs, slice(xs, 0))))`],
    ["sort", `let(xs, ${xs}, length(map(xs, sort(xs))))`],
    ["filter", `let(xs, ${xs}, length(map(xs, filter(xs, true))))`],
    ["concat", `let(xs, ${xs}, length(map(xs, concat(xs))))`],
    ["flat", `let(xs, ${xs}, length(map(xs, flat(xs))))`],
    ["sum", 'let(ns, map(split(repeat("x,", 1999), ","), 1), sum(map(ns, sum(ns))))'],
    ["median", 'let(ns, map(split(repeat("x,", 1999), ","), 1), sum(map(ns, median(ns))))'],
  ])("%s", (_name, expression) => {
    expect(rowResult(expression).computed.f).toEqual({ err: "too_many_steps" });
  });

  test("a small copy still runs", () => {
    expect(run("reverse([1, 2, 3])")).toEqual([3, 2, 1]);
    expect(run("sum([1, 2], 3)")).toBe(6);
  });
});

describe("names come only from the formula library", () => {
  test.each(["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"])("%s()", (name) => {
    expect(run(`${name}()`)).toBe("#unknown_function");
    expect(checkFormula(`1.${name}()`, []).errors[0]?.code).toBe("unknown_function");
  });

  test("a unit inherited from the prototype is not a unit", () => {
    expect(run('dateAdd(today(), 1, "constructor")')).toBe("#invalid_unit");
    expect(run('let(u, "toString", dateAdd(today(), 1, u))')).toBe("#invalid_unit");
  });
});

describe("numbers are always finite", () => {
  test("a literal that does not fit a number is a syntax error", () => {
    expect(run("1e309")).toBe("#invalid_number");
    expect(run("[1, 1e400]")).toBe("#invalid_number");
    expect(run("1e-400")).toBe(0);
  });

  test("an overflowing result is the not-finite error, never a value", () => {
    expect(run("median([1e308, 1.7e308])")).toBe("#not_finite");
    expect(run("1e308 * 10")).toBe("#not_finite");
    expect(run("mean(1.7e308, 1.7e308)")).toBe("#not_finite");
  });
});

describe("dates exist in the calendar and keep their year", () => {
  test("a day that does not exist is rejected, with or without a time", () => {
    expect(run('parseDate("2026-02-31")')).toBe("#invalid_date");
    expect(run('parseDate("2026-02-31T00:00:00Z")')).toBe("#invalid_date");
    expect(run('parseDate("2026-02-29T10:00:00-03:00")')).toBe("#invalid_date");
    expect(run('parseDate("2024-02-29T10:00:00Z")')).toEqual({ start: "2024-02-29T10:00:00Z" });
  });

  test("a year below 100 is kept as written", () => {
    expect(run('parseDate("0001-01-01")')).toEqual({ start: "0001-01-01" });
    expect(run('parseDate("0099-12-31T23:00:00Z")')).toEqual({ start: "0099-12-31T23:00:00Z" });
    expect(run('year(parseDate("0050-06-15"))')).toBe(50);
  });

  test("a stored date that does not exist is rejected on write", () => {
    const defs: PropDef[] = [{ id: "d", name: "D", type: "date" }];
    expect(applyProps(defs, {}, { d: { start: "2026-02-31" } }).ok).toBe(false);
    expect(applyProps(defs, {}, { d: { start: "2026-01-01", end: "2026-13-01" } }).ok).toBe(false);
    expect(applyProps(defs, {}, { d: { start: "0001-01-01" } }).ok).toBe(true);
  });
});

describe("date arithmetic keeps years below 100", () => {
  test("months, weeks and today do not jump to the 1900s", () => {
    expect(run('dateAdd(parseDate("0050-01-31"), 1, "months")')).toEqual({ start: "0050-02-28" });
    expect(run('dateAdd(parseDate("0004-02-29"), 1, "years")')).toEqual({ start: "0005-02-28" });
    expect(run('week(parseDate("0050-06-15"))')).toBe(24);
  });
});

describe("every list that enters the evaluation pays for its items", () => {
  const loop = (body: string) => `sum(map(split(repeat("x,", 9999), ","), ${body}))`;
  const ids = Array.from({ length: 100 }, (_, i) => `i${i}`);
  const defs: PropDef[] = [
    { id: "files", name: "Files", type: "file" },
    { id: "tags", name: "Tags", type: "multi_select", options: ids.map((id) => ({ id, name: id })) },
    { id: "who", name: "Who", type: "person" },
    { id: "list", name: "List", type: "formula", formula: { expression: 'split(repeat("y,", 99), ",")' } },
  ];
  const row: RowData = {
    ...ROW,
    props: { files: ids, tags: ids, who: ids.map((id) => ({ type: "person" as const, id })) },
  };
  const evalOne = (expression: string) => {
    const all: PropDef[] = [...defs, { id: "f", name: "F", type: "formula", formula: { expression } }];
    return evaluateRow(planFormulas(all), all, row, { now: NOW });
  };

  test.each([
    ["stored file list", loop('length(prop("Files"))')],
    ["stored multi-select", loop('length(prop("Tags"))')],
    ["stored people", loop('length(prop("Who"))')],
    ["another formula's list", loop('length(prop("List"))')],
    ["a list literal", loop(`length([${ids.map(() => "1").join(", ")}])`)],
  ])("%s, read 10 thousand times, exceeds the step limit", (_door, expression) => {
    expect(evalOne(expression).computed.f).toEqual({ err: "too_many_steps" });
  });

  test("one read pays for the items once and still runs", () => {
    expect(evalOne('length(prop("Files")) + length(prop("List"))').computed.f).toBe(200);
  });

  test("a let variable and `current` hand over the same list, without a copy", () => {
    const r = evalOne(`let(xs, prop("Files"), ${loop("length(xs)")})`);
    expect(r.computed.f).toBe(1_000_000);
    const items = evalOne('map(split(repeat("x,", 99), ","), current)');
    expect(items.computed.f).toHaveLength(100);
  });
});

test("repeated numeric conversion pays for a long string variable", () => {
  expect(
    rowResult(
      'lets(s, repeat(" ", 99999) + "1", xs, split(repeat("x,", 9999), ","), sum(map(xs, toNumber(s))))',
    ).computed.f,
  ).toEqual({ err: "too_many_steps" });
});

test("unary plus is bounded before exhausting the runtime stack", () => {
  const source = `${"+".repeat(9900)}1`;
  expect(checkFormula(source, []).errors[0]?.code).toBe("too_deep");
  expect(run(source)).toBe("#too_deep");
});

test("discarded output leaves room for independent formulas but errors its dependents", () => {
  const defs: PropDef[] = ['repeat("x", 60000)', 'repeat("y", 60000)', "42", 'prop("f1")'].map(
    (expression, i) => ({ id: `f${i}`, name: `F${i}`, type: "formula", formula: { expression } }),
  );
  const { computed } = evaluateRow(planFormulas(defs), defs, ROW, { now: NOW });
  expect(computed.f0).toBe("x".repeat(60000));
  expect(computed.f1).toEqual({ err: "too_large" });
  expect(computed.f2).toBe(42);
  expect(computed.f3).toEqual({ err: "dependency_error" });
});

test("person output accounts for maximum length ids and JSON escapes", () => {
  const defs: PropDef[] = [
    { id: "who", name: "Who", type: "person" },
    {
      id: "f",
      name: "F",
      type: "formula",
      formula: { expression: 'let(p, first(prop("Who")), map(split(repeat("x,", 1199), ","), p))' },
    },
  ];
  for (const id of ["u".repeat(100), '\\"'.repeat(50)]) {
    const row = { ...ROW, props: { who: [{ type: "person" as const, id }] } };
    expect(applyProps(defs, {}, row.props).ok).toBe(true);
    expect(evaluateRow(planFormulas(defs), defs, row, { now: NOW }).computed.f).toEqual({ err: "too_large" });
  }
});

test("predicates require booleans even for empty lists; map and sort allow other types", () => {
  for (const fn of ["filter", "find", "findIndex", "some", "every"]) {
    for (const args of ["[1,2], current", "[], 1"])
      expect(checkFormula(`${fn}(${args})`, []).errors[0]?.code).toBe("type_mismatch");
  }
  expect(run("map([2,1], current)")).toEqual([2, 1]);
  expect(run("sort([2,1], current)")).toEqual([1, 2]);
});

test("date arithmetic and JSON preserve hours, milliseconds and both endpoints", () => {
  expect(run('dateAdd(parseDate("2026-01-01"), 12, "hours")')).toEqual({ start: "2026-01-01T12:00:00Z" });
  const defs: PropDef[] = [{ id: "d", name: "D", type: "date" }];
  const stored = applyProps(defs, {}, { d: run("dateRange(fromTimestamp(123), fromTimestamp(456))") });
  if (!stored.ok) throw new Error("Serialized date must be accepted on write");
  for (const [part, expected] of [
    ["dateStart", 123],
    ["dateEnd", 456],
  ] as const)
    expect(
      previewFormula(`timestamp(${part}(prop("D")))`, defs, { ...ROW, props: stored.props }, { now: NOW }),
    ).toMatchObject({ ok: true, value: expected });
});
