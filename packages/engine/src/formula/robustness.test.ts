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
