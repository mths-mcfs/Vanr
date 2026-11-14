import { describe, expect, test } from "bun:test";
import type { PropDef, Props } from "../props";
import {
  checkFormula,
  evaluateRow,
  FORMULA_LIMITS,
  FUNCTION_NAMES,
  planFormulas,
  previewFormula,
  type RowData,
  rewritePropRefs,
  typeName,
} from "./index";
import { parseFormula, tokenize } from "./syntax";

const DEFS: PropDef[] = [
  { id: "p_name", name: "Name", type: "text" },
  { id: "p_n", name: "Value", type: "number" },
  { id: "p_qty", name: "Qty", type: "number" },
  {
    id: "p_status",
    name: "Status",
    type: "status",
    options: [
      { id: "o_todo", name: "To do" },
      { id: "o_done", name: "Done" },
    ],
  },
  {
    id: "p_tags",
    name: "Tags",
    type: "multi_select",
    options: [
      { id: "o_a", name: "alpha" },
      { id: "o_b", name: "beta" },
      { id: "o_c", name: "gamma" },
    ],
  },
  { id: "p_when", name: "When", type: "date" },
  { id: "p_ok", name: "Ok", type: "checkbox" },
  { id: "p_who", name: "Who", type: "person" },
  { id: "p_created", name: "Created", type: "created_time" },
  { id: "p_by", name: "By", type: "creator" },
];

const NOW = Date.UTC(2026, 9, 22, 15, 30, 0); // 2026-10-22 15:30Z

function row(props: Props = {}): RowData {
  return {
    id: "row_1",
    props,
    createdAt: "2026-10-01T12:00:00.000Z",
    createdBy: { type: "person", id: "u1" },
    editedAt: "2026-10-02T12:00:00.000Z",
    editedBy: { type: "agent", id: "a1" },
  };
}

const BASE: Props = {
  p_name: "Ana Souza",
  p_n: 10,
  p_qty: 3,
  p_status: "o_done",
  p_tags: ["o_a", "o_c"],
  p_when: { start: "2026-10-20", end: "2026-10-25" },
  p_ok: true,
  p_who: [
    { type: "person", id: "u1" },
    { type: "agent", id: "a1" },
  ],
};

const names = (a: { type: string; id: string }) => (a.id === "u1" ? "Ana" : a.id === "a1" ? "Bot" : a.id);

/** Value as JSON, or `#code` for an error (from the checker or at runtime). */
function run(src: string, props: Props = BASE): unknown {
  const r = previewFormula(src, DEFS, row(props), { now: NOW, names });
  if (r.ok) return r.value;
  return "errors" in r ? `#${r.errors[0]?.code}` : `#${r.runtime}`;
}

describe("syntax", () => {
  test("precedence and associativity", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("2 ^ 3 ^ 2")).toBe(512);
    expect(run("-2 ^ 2")).toBe(-4);
    expect(run("10 - 4 - 3")).toBe(3);
    expect(run("7 % 4")).toBe(3);
    expect(run("1 < 2 and 2 < 3 or false")).toBe(true);
    expect(run("not true or true")).toBe(true);
    expect(run("!(1 == 1)")).toBe(false);
    expect(run("true ? 1 : 2")).toBe(1);
    expect(run("false ? 1 : true ? 2 : 3")).toBe(2);
  });

  test("literals, comments and dot notation", () => {
    expect(run('"a\\"b"')).toBe('a"b');
    expect(run("'simple'")).toBe("simple");
    expect(run("1.5e2")).toBe(150);
    expect(run(".5 + .5")).toBe(1);
    expect(run("/* comment */ 1 // end\n + 1")).toBe(2);
    expect(run('"abc".upper().length()')).toBe(3);
    expect(run("5.abs()")).toBe(5);
    expect(run("[1, 2, 3].map(current * 2)")).toEqual([2, 4, 6]);
    expect(run("[]")).toEqual([]);
  });

  test("syntax errors with a position", () => {
    expect(run("1 +")).toBe("#unexpected_token");
    expect(run('"open')).toBe("#unterminated_string");
    expect(run("/* no end")).toBe("#unterminated_comment");
    expect(run("1 # 2")).toBe("#unexpected_char");
    expect(run("(1 + 2")).toBe("#expected");
    expect(run("")).toBe("#empty");
    expect(run("1 2")).toBe("#unexpected_token");
    expect(run("prop(Name)")).toBe("#expected");
    const c = checkFormula("1 + * 2", DEFS);
    expect(c.errors[0]?.at).toEqual([4, 5]);
  });

  test("limits: length, depth and nodes", () => {
    expect(run("1".repeat(FORMULA_LIMITS.maxLength + 1))).toBe("#too_long");
    expect(run(`${"(".repeat(200)}1${")".repeat(200)}`)).toBe("#too_deep");
    expect(run(`${"-".repeat(500)}1`)).toBe("#too_deep");
    expect(run(`${"not ".repeat(500)}true`)).toBe("#too_deep");
    expect(run(Array.from({ length: 2500 }, () => "1").join("+"))).toBe("#too_many_nodes");
  });
});

describe("references and types", () => {
  test("prop by name, by id and without case", () => {
    expect(run('prop("Value") * prop("Qty")')).toBe(30);
    expect(run('prop("p_n") + 1')).toBe(11);
    expect(run('prop("value")')).toBe(10);
    expect(run('prop("Status")')).toBe("Done");
    expect(run('prop("Tags")')).toEqual(["alpha", "gamma"]);
    expect(run('prop("Ok")')).toBe(true);
    expect(run('prop("Who").map(current.name())')).toEqual(["Ana", "Bot"]);
    expect(run('prop("By").name()')).toBe("Ana");
    expect(run('prop("Created").formatDate("DD/MM/YYYY")')).toBe("01/10/2026");
    expect(run('prop("Nothing")')).toBe("#unknown_prop");
  });

  test("type checking while typing", () => {
    expect(run('prop("Name") * 2')).toBe("#type_mismatch");
    expect(run('if(prop("Value"), 1, 2)')).toBe("#type_mismatch");
    expect(run('upper(prop("Value"))')).toBe("#type_mismatch");
    expect(run('dateAdd(prop("When"), 1, "moons")')).toBe("#invalid_unit");
    expect(run("doesNotExist(1)")).toBe("#unknown_function");
    expect(run("abs(1, 2)")).toBe("#arity");
    expect(run("current + 1")).toBe("#unknown_identifier");
    expect(run('1 < "a"')).toBe("#type_mismatch");
    const c = checkFormula('prop("Value") > 5 ? "high" : "low"', DEFS);
    expect(typeName(c.type)).toBe("text");
    expect(c.deps).toEqual(["p_n"]);
    expect(typeName(checkFormula('prop("Tags").map(current.length())', DEFS).type)).toBe("list<number>");
  });

  test("empty comes in as neutral", () => {
    expect(run('prop("Value") + 1', {})).toBe(1);
    expect(run('prop("Name") + "!"', {})).toBe("!");
    expect(run('prop("Value") > 5', {})).toBe(false);
    expect(run('prop("Tags").length()', {})).toBe(0);
    expect(run('prop("When").year()', {})).toBeNull();
    expect(run('empty(prop("Name"))', {})).toBe(true);
    expect(run('prop("When") > today()', {})).toBe(false);
  });
});

describe("logic", () => {
  test("if, ifs, and, or, not, empty, equal", () => {
    expect(run('if(prop("Ok"), "yes", "no")')).toBe("yes");
    expect(run('ifs(prop("Value") > 20, "high", prop("Value") > 5, "medium", "low")')).toBe("medium");
    expect(run("ifs(false, 1, false, 2, 3)")).toBe(3);
    expect(run("ifs(false, 1, false, 2)")).toBe("#arity");
    expect(run("and(true, true, false)")).toBe(false);
    expect(run("or(false, false, true)")).toBe(true);
    expect(run("not(false)")).toBe(true);
    expect(run("not false and false")).toBe(false);
    expect(run("not(true, false)")).toBe("#arity");
    expect(run('empty("")')).toBe(true);
    expect(run("empty(0)")).toBe(true);
    expect(run("empty([])")).toBe(true);
    expect(run("empty(false)")).toBe(false);
    expect(run('empty("x")')).toBe(false);
    expect(run("equal([1, [2]], [1, [2]])")).toBe(true);
    expect(run('unequal("a", "b")')).toBe(true);
    expect(run("[1, 2] == [1, 2]")).toBe(true);
    expect(run('"a" != "a"')).toBe(false);
  });

  test("the branch not taken does not run (no division error)", () => {
    expect(run("if(true, 1, 1 / 0)")).toBe(1);
    expect(run("false and 1 / 0 > 1")).toBe(false);
    expect(run("true or 1 / 0 > 1")).toBe(true);
    expect(run("ifs(true, 1, 1 / 0 > 0, 2, 3)")).toBe(1);
  });

  test("let and lets", () => {
    expect(run('let(x, prop("Value") * 2, x + 1)')).toBe(21);
    expect(run("lets(a, 1, b, a + 1, c, b * 10, a + b + c)")).toBe(23);
    expect(run("let(x, 1, let(x, 2, x))")).toBe(2);
    expect(run('let("x", 1, 2)')).toBe("#bad_variable");
    expect(run("let(current, 1, 2)")).toBe("#bad_variable");
    expect(run("lets(a, 1, b)")).toBe("#unknown_identifier");
  });
});

describe("numbers", () => {
  test("functions", () => {
    expect(run("abs(-3)")).toBe(3);
    expect(run("ceil(1.2)")).toBe(2);
    expect(run("floor(-1.2)")).toBe(-2);
    expect(run("round(2.456, 2)")).toBe(2.46);
    expect(run("round(2.5)")).toBe(3);
    expect(run("round(1234, -2)")).toBe(1200);
    expect(run("sqrt(9)")).toBe(3);
    expect(run("cbrt(27)")).toBe(3);
    expect(run("sign(-5)")).toBe(-1);
    expect(run("mod(7, 3)")).toBe(1);
    expect(run("pow(2, 10)")).toBe(1024);
    expect(run("ln(e())")).toBe(1);
    expect(run("log10(1000)")).toBe(3);
    expect(run("log2(8)")).toBe(3);
    expect(run("exp(0)")).toBe(1);
    expect(run("round(pi(), 2)")).toBe(3.14);
    expect(run("sum(1, 2, [3, 4])")).toBe(10);
    expect(run("min(3, 1, 2)")).toBe(1);
    expect(run("max([3, 1, 2])")).toBe(3);
    expect(run("mean(1, 2, 3, 4)")).toBe(2.5);
    expect(run("median([5, 1, 3])")).toBe(3);
    expect(run("median([4, 1, 3, 2])")).toBe(2.5);
    expect(run("max([])")).toBeNull();
    expect(run('toNumber("2,5")')).toBe(2.5);
    expect(run('toNumber("abc")')).toBeNull();
    expect(run("toNumber(true)")).toBe(1);
    expect(run('toNumber(parseDate("1970-01-02"))')).toBe(864e5);
  });

  test("division by zero, not finite", () => {
    expect(run("1 / 0")).toBe("#division_by_zero");
    expect(run("1 % 0")).toBe("#division_by_zero");
    expect(run("mod(1, 0)")).toBe("#division_by_zero");
    expect(run("10 ^ 400")).toBe("#not_finite");
    expect(run("sqrt(-1)")).toBe("#not_finite");
    expect(run("ln(0)")).toBe("#not_finite");
  });

  test("stable number format", () => {
    expect(run("format(0.1 + 0.2)")).toBe("0.3");
    expect(run('"" + 1 / 3')).toBe("0.333333333333333");
  });
});

describe("text", () => {
  test("functions", () => {
    expect(run('length("café")')).toBe(4);
    expect(run('length("😀a")')).toBe(2);
    expect(run('substring("abcdef", 1, 3)')).toBe("bc");
    expect(run('substring("abcdef", 2)')).toBe("cdef");
    expect(run('slice("abcdef", -2)')).toBe("ef");
    expect(run('contains("Ana Souza", "Sou")')).toBe(true);
    expect(run('test("abc", "b")')).toBe(true);
    expect(run('test("abc", ".*")')).toBe(false); // literal, no regex
    expect(run('startsWith("abc", "ab")')).toBe(true);
    expect(run('endsWith("abc", "bc")')).toBe(true);
    expect(run('replace("a-b-c", "-", "+")')).toBe("a+b-c");
    expect(run('replace("a", "a", "$&$&")')).toBe("$&$&");
    expect(run('replaceAll("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(run('replaceAll("abc", "", "x")')).toBe("abc");
    expect(run('lower("ÁB")')).toBe("áb");
    expect(run('upper("ab")')).toBe("AB");
    expect(run('trim("  a  ")')).toBe("a");
    expect(run('repeat("ab", 3)')).toBe("ababab");
    expect(run('repeat("ab", -1)')).toBe("");
    expect(run('padStart("7", 3, "0")')).toBe("007");
    expect(run('padEnd("7", 3)')).toBe("7  ");
    expect(run('split("a,b,c", ",")')).toEqual(["a", "b", "c"]);
    expect(run('split("ab", "")')).toEqual(["a", "b"]);
    expect(run('split("a b")')).toEqual(["a", "b"]);
    expect(run('join(["a", 1, true], " | ")')).toBe("a | 1 | true");
    expect(run('prop("Tags").join()')).toBe("alpha, gamma");
    expect(run('format(prop("When"))')).toBe("2026-10-20 → 2026-10-25");
    expect(run('format(prop("Who"))')).toBe("Ana, Bot");
    expect(run('"Total: " + prop("Value") * prop("Qty")')).toBe("Total: 30");
    expect(run('1 + "a"')).toBe("1a");
  });

  test("text limits", () => {
    expect(run('repeat("ab", 100000)')).toBe("#text_too_long");
    expect(run('padStart("a", 1000000)')).toBe("#text_too_long");
    expect(run('let(a, repeat("x", 60000), a + a)')).toBe("#text_too_long");
  });
});

describe("dates (UTC)", () => {
  test("parts", () => {
    expect(run('year(parseDate("2026-10-22"))')).toBe(2026);
    expect(run('month(parseDate("2026-10-22"))')).toBe(10);
    expect(run('date(parseDate("2026-10-22"))')).toBe(22);
    expect(run('day(parseDate("2026-10-25"))')).toBe(7); // Sunday
    expect(run('day(parseDate("2026-10-19"))')).toBe(1); // Monday
    expect(run('week(parseDate("2026-01-01"))')).toBe(1);
    expect(run('week(parseDate("2027-01-01"))')).toBe(53);
    expect(run('hour(parseDate("2026-10-22T13:45:00Z"))')).toBe(13);
    expect(run('minute(parseDate("2026-10-22T13:45:00-03:00"))')).toBe(45);
    expect(run('hour(parseDate("2026-10-22T13:45:00-03:00"))')).toBe(16);
  });

  test("now and today use the same clock", () => {
    expect(run("now()")).toEqual({ start: "2026-10-22T15:30:00Z" });
    expect(run("today()")).toEqual({ start: "2026-10-22" });
    expect(checkFormula("today()", DEFS).volatile).toBe(true);
    expect(checkFormula("1", DEFS).volatile).toBe(false);
  });

  test("dateAdd, dateSubtract, dateBetween with month ends", () => {
    expect(run('dateAdd(parseDate("2026-01-31"), 1, "months")')).toEqual({ start: "2026-02-28" });
    expect(run('dateAdd(parseDate("2024-02-29"), 1, "years")')).toEqual({ start: "2025-02-28" });
    expect(run('dateAdd(parseDate("2026-10-22"), 2, "weeks")')).toEqual({ start: "2026-11-05" });
    expect(run('dateAdd(parseDate("2026-10-22"), 1, "quarter")')).toEqual({ start: "2027-01-22" });
    expect(run('dateSubtract(parseDate("2026-03-01"), 1, "days")')).toEqual({ start: "2026-02-28" });
    expect(run('dateAdd(parseDate("2026-10-22T10:00:00Z"), 90, "minutes")')).toEqual({
      start: "2026-10-22T11:30:00Z",
    });
    expect(run('dateAdd(prop("When"), 1, "days")')).toEqual({ start: "2026-10-21", end: "2026-10-26" });
    expect(run('dateBetween(parseDate("2026-10-25"), parseDate("2026-10-20"), "days")')).toBe(5);
    expect(run('dateBetween(parseDate("2026-10-20"), parseDate("2026-10-25"), "days")')).toBe(-5);
    // consistent with dateAdd: 01-31 + 1 month = 02-28, so there is 1 month between the two
    expect(run('dateBetween(parseDate("2026-02-28"), parseDate("2026-01-31"), "months")')).toBe(1);
    expect(run('dateBetween(parseDate("2026-02-27"), parseDate("2026-01-31"), "months")')).toBe(0);
    expect(run('dateBetween(parseDate("2026-03-31"), parseDate("2026-01-31"), "months")')).toBe(2);
    expect(run('dateBetween(parseDate("2027-10-21"), parseDate("2026-10-22"), "years")')).toBe(0);
    expect(run('dateBetween(parseDate("2027-10-22"), parseDate("2026-10-22"), "years")')).toBe(1);
    expect(run('dateAdd(today(), 1e300, "years")')).toBe("#invalid_date");
    expect(run('dateAdd(today(), 1, prop("Name"))')).toBe("#invalid_unit");
  });

  test("ranges, timestamp, formatDate, parseDate", () => {
    expect(run('dateStart(prop("When"))')).toEqual({ start: "2026-10-20" });
    expect(run('dateEnd(prop("When"))')).toEqual({ start: "2026-10-25" });
    expect(run('dateRange(parseDate("2026-01-01"), parseDate("2026-01-05"))')).toEqual({
      start: "2026-01-01",
      end: "2026-01-05",
    });
    expect(run('timestamp(parseDate("1970-01-01T00:00:01Z"))')).toBe(1000);
    expect(run("fromTimestamp(0)")).toEqual({ start: "1970-01-01T00:00:00Z" });
    expect(run('formatDate(parseDate("2026-10-22T09:05:00Z"), "DD/MM/YY [at] HH:mm A h")')).toBe(
      "22/10/26 at 09:05 AM 9",
    );
    expect(run('formatDate(parseDate("2026-10-22"))')).toBe("2026-10-22");
    expect(run('parseDate("2026-02-31")')).toBe("#invalid_date");
    expect(run('parseDate("yesterday")')).toBe("#invalid_date");
    expect(run('parseDate("")')).toBeNull();
    expect(run('parseDate("2026-10-20") < parseDate("2026-10-21")')).toBe(true);
    expect(run('prop("When") == prop("When")')).toBe(true);
  });
});

describe("lists", () => {
  test("map, filter, find, findIndex, some, every with current and index", () => {
    expect(run("[1, 2, 3].map(current + index)")).toEqual([1, 3, 5]);
    expect(run("[1, 2, 3, 4].filter(current % 2 == 0)")).toEqual([2, 4]);
    expect(run("[1, 2, 3].find(current > 1)")).toBe(2);
    expect(run("[1, 2, 3].find(current > 5)")).toBeNull();
    expect(run("[1, 2, 3].findIndex(current == 3)")).toBe(2);
    expect(run("[1, 2, 3].findIndex(current == 9)")).toBe(-1);
    expect(run("[1, 2].some(current > 1)")).toBe(true);
    expect(run("[1, 2].every(current > 1)")).toBe(false);
    expect(run("[[1, 2], [3]].map(current.map(current * 10))")).toEqual([[10, 20], [30]]);
    expect(run('prop("Tags").filter(current != "alpha").map(upper(current))')).toEqual(["GAMMA"]);
    expect(run('prop("Tags").map(current * 2)')).toBe("#type_mismatch");
  });

  test("sort, reverse, at, first, last, slice, concat, includes, unique, flat, length", () => {
    expect(run("sort([3, 1, 2])")).toEqual([1, 2, 3]);
    expect(run('sort(["b", "a", "C"])')).toEqual(["C", "a", "b"]);
    expect(run('sort(["ccc", "a", "bb"], current.length())')).toEqual(["a", "bb", "ccc"]);
    expect(run("sort([2, 1]).reverse()")).toEqual([2, 1]);
    expect(run("at([1, 2, 3], 1)")).toBe(2);
    expect(run("at([1, 2, 3], -1)")).toBe(3);
    expect(run("at([1, 2, 3], 9)")).toBeNull();
    expect(run("first([4, 5])")).toBe(4);
    expect(run("last([4, 5])")).toBe(5);
    expect(run("first([])")).toBeNull();
    expect(run("slice([1, 2, 3, 4], 1, 3)")).toEqual([2, 3]);
    expect(run("concat([1], [2, 3], [])")).toEqual([1, 2, 3]);
    expect(run("includes([1, 2], 2)")).toBe(true);
    expect(run('includes(prop("Tags"), "beta")')).toBe(false);
    expect(run("unique([1, 1, [2], [2]])")).toEqual([1, [2]]);
    expect(run("flat([[1, 2], 3, [4]])")).toEqual([1, 2, 3, 4]);
    expect(run("length([1, [2, 3]])")).toBe(2);
    expect(run("sum([1, 2].map(current * 3))")).toBe(9);
  });

  test("a list doubling inside a list does not blow up (steps counted)", () => {
    // 2^25 logical items in little memory: flat/format/equal count a step per item
    const nest = Array.from({ length: 25 }, (_, i) => `let(x${i + 1}, [x${i}, x${i}], `).join("");
    const src = `let(x0, [1], ${nest}format(x25)${")".repeat(25)})`;
    expect(String(run(src))).toMatch(/^#(too_many_steps|text_too_long)$/);
    expect(run(`let(x0, [1], ${nest}flat(flat(x25)).length()${")".repeat(25)})`)).toBe(8);
    // two equal trees with no shared reference: equality walks down item by item
    const pairs = Array.from(
      { length: 25 },
      (_, i) => `x${i + 1}, [x${i}, x${i}], y${i + 1}, [y${i}, y${i}]`,
    ).join(", ");
    expect(run(`lets(x0, [1], y0, [1], ${pairs}, x25 == y25)`)).toBe("#too_many_steps");
  });

  test("a nested map exceeds the step limit", () => {
    const big = 'split(repeat("a", 5000), "")';
    expect(run(`${big}.map(${big}.length()).length()`)).toBe("#too_many_steps");
  });

  test("a list larger than the limit", () => {
    expect(run('split(repeat("a", 20000), "")')).toBe("#list_too_long");
  });
});

describe("limits of the whole row", () => {
  const formulas = (exprs: string[]): PropDef[] =>
    exprs.map((expression, i) => ({ id: `f${i}`, name: `F${i}`, type: "formula", formula: { expression } }));

  test("attack: big text inside map neither holds the server nor reaches the database", () => {
    // adversarial review: 3 formulas like this wrote 90 million characters in a 10 s createRow
    const defs = formulas(Array(3).fill('map(split(repeat("a", 300), ""), repeat("b", 100000))'));
    const t0 = performance.now();
    const r = evaluateRow(planFormulas(defs), defs, row(), { now: NOW });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(Object.values(r.computed)).toEqual(Array(3).fill({ err: "too_many_steps" }));
  });

  test("attack: huge text is rejected before it exists, and comparing big text costs steps", () => {
    // adversarial review, round 2: each of these allocated 1 to 1.8 GB or took hundreds of ms
    const refs = 'let(x, repeat("b", 100000), map(split(repeat("a", 9999), ""), x))';
    const cases: [string, string][] = [
      ['length(replaceAll(repeat("a", 20000), "a", repeat("b", 50000)))', "text_too_long"],
      [refs, "too_large"],
      [`length(sort(${refs}))`, "too_many_steps"],
      [`length(unique(${refs}))`, "too_many_steps"],
      [`${refs} == ${refs}`, "too_many_steps"],
      ['length(upper(repeat("ß", 100000)))', "text_too_long"],
      // round 3: reading the whole text (length, substring, slice, split by character) costs too
      [`sum(map(${refs}, length(current)))`, "too_many_steps"],
      [`length(map(${refs}, substring(current, 0, 1)))`, "too_many_steps"],
      [`length(map(${refs}, slice(current, -1)))`, "too_many_steps"],
      [`length(map(${refs}, length(split(current, ""))))`, "list_too_long"],
      // JSON escapes a line break with 2 characters: the output limit counts the escape
      ['repeat("\\n", 99000)', "too_large"],
    ];
    for (const [expr, code] of cases) {
      const defs = formulas([expr]);
      const rss = process.memoryUsage().rss;
      const t0 = performance.now();
      const r = evaluateRow(planFormulas(defs), defs, row(), { now: NOW });
      expect([expr, performance.now() - t0 < 200]).toEqual([expr, true]);
      expect(process.memoryUsage().rss - rss).toBeLessThan(200e6);
      expect(r.computed.f0).toEqual({ err: code });
    }
    // a control character becomes \u0001 in JSON: 6 characters for 1
    const control = [...DEFS, ...formulas(['prop("Name")'])];
    const r = evaluateRow(planFormulas(control), control, row({ p_name: "\u0001".repeat(99_000) }), {
      now: NOW,
    });
    expect(r.computed.f0).toEqual({ err: "too_large" });
    expect(run('replaceAll("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(run('length(sort(split(repeat("ab,", 500), ",")))')).toBe(501);
  });

  test("the steps add up all formulas of the row", () => {
    const expr = 'split(repeat("a", 3000), "").map(current + "b").length()';
    const alone = evaluateRow(planFormulas(formulas([expr])), formulas([expr]), row(), { now: NOW });
    expect(alone.computed.f0).toBe(3000);
    expect(alone.steps).toBeLessThan(FORMULA_LIMITS.maxSteps);
    const many = formulas(Array(Math.floor(FORMULA_LIMITS.maxSteps / alone.steps) + 1).fill(expr));
    const r = evaluateRow(planFormulas(many), many, row(), { now: NOW });
    expect(r.computed.f0).toBe(3000);
    expect(r.computed[`f${many.length - 1}`]).toEqual({ err: "too_many_steps" });
  });

  test("the stored result of the row has a limit; what depends on the one that passed it fails", () => {
    const defs = formulas(['repeat("x", 60000)', 'repeat("y", 60000)', 'length(prop("F1"))']);
    const r = evaluateRow(planFormulas(defs), defs, row(), { now: NOW });
    expect(String(r.computed.f0).length).toBe(60_000);
    expect(r.computed.f1).toEqual({ err: "too_large" });
    expect(r.computed.f2).toEqual({ err: "dependency_error" });
    expect(JSON.stringify(r.computed).length).toBeLessThan(FORMULA_LIMITS.maxRowOutput);
  });

  test("text out of a formula goes into Postgres: no NUL and no lone surrogate half", () => {
    // the text functions count by whole character; this covers what comes from outside unvalidated
    expect(run('substring("\u{1F600}x", 0, 1)')).toBe("\u{1F600}");
    expect(run('prop("Name") + "!"', { p_name: "a\u0000b\uD800c" })).toBe("ab\uFFFDc!");
  });
});

describe("people and row", () => {
  test("name, id", () => {
    expect(run('prop("Who").first().name()')).toBe("Ana");
    expect(run('prop("Who").last().id()')).toBe("a1");
    expect(run("id()")).toBe("row_1");
    expect(run('prop("Who").first() == prop("By")')).toBe(true);
  });
});

describe("table: dependencies, cycles and errors", () => {
  const defs: PropDef[] = [
    { id: "p_n", name: "Value", type: "number" },
    { id: "f_a", name: "Double", type: "formula", formula: { expression: 'prop("Value") * 2' } },
    { id: "f_b", name: "Quadruple", type: "formula", formula: { expression: 'prop("Double") * 2' } },
    { id: "f_c", name: "Text", type: "formula", formula: { expression: '"x" + prop("f_b")' } },
    { id: "f_x", name: "X", type: "formula", formula: { expression: 'prop("Y") + 1' } },
    { id: "f_y", name: "Y", type: "formula", formula: { expression: 'prop("X") + 1' } },
    { id: "f_self", name: "Self", type: "formula", formula: { expression: 'prop("Self")' } },
    { id: "f_bad", name: "Bad", type: "formula", formula: { expression: "1 +" } },
    { id: "f_dep", name: "DependsOnBad", type: "formula", formula: { expression: 'prop("Bad") + 1' } },
    { id: "f_div", name: "Div", type: "formula", formula: { expression: '1 / prop("Value")' } },
    { id: "f_after", name: "AfterDiv", type: "formula", formula: { expression: 'prop("Div") + 1' } },
  ];

  test("topological order, regardless of column order", () => {
    const shuffled = [defs[3], defs[2], defs[0], defs[1]] as PropDef[];
    const plan = planFormulas(shuffled);
    expect(plan.order.map((f) => f.propId)).toEqual(["f_a", "f_b", "f_c"]);
    const r = evaluateRow(plan, shuffled, row({ p_n: 5 }), { now: NOW });
    expect(r.computed).toEqual({ f_a: 10, f_b: 20, f_c: "x20" });
    expect(typeName(plan.types.get("f_c") ?? { k: "any" })).toBe("text");
  });

  test("a cycle, bad syntax and a runtime error stay only where they are and in what depends on them", () => {
    const plan = planFormulas(defs);
    expect(plan.errors.get("f_x")?.[0]?.code).toBe("cycle");
    expect(plan.errors.get("f_y")?.[0]?.code).toBe("cycle");
    expect(plan.errors.get("f_self")?.[0]?.code).toBe("cycle");
    expect(plan.errors.get("f_bad")?.[0]?.code).toBe("unexpected_token");
    const r = evaluateRow(plan, defs, row({ p_n: 0 }), { now: NOW });
    expect(r.computed.f_a).toBe(0);
    expect(r.computed.f_x).toEqual({ err: "cycle" });
    expect(r.computed.f_dep).toEqual({ err: "dependency_error" });
    expect(r.computed.f_div).toEqual({ err: "division_by_zero" });
    expect(r.computed.f_after).toEqual({ err: "dependency_error" });
    expect(evaluateRow(plan, defs, row({ p_n: 4 }), { now: NOW }).computed.f_after).toBe(1.25);
  });

  test("the type of a referenced formula enters the check", () => {
    const d: PropDef[] = [
      { id: "f_t", name: "T", type: "formula", formula: { expression: '"a"' } },
      { id: "f_u", name: "U", type: "formula", formula: { expression: 'prop("T") * 2' } },
    ];
    expect(planFormulas(d).errors.get("f_u")?.[0]?.code).toBe("type_mismatch");
  });
});

describe("references by id ↔ name", () => {
  test("replaces only the quoted text and keeps comments", () => {
    const src = '/* total */ prop("Value") * prop( "Qty" ) + prop("Value") // "Value"';
    const toIds = rewritePropRefs(src, (ref) => DEFS.find((d) => d.name === ref)?.id);
    expect(toIds).toBe('/* total */ prop("p_n") * prop( "p_qty" ) + prop("p_n") // "Value"');
    const back = rewritePropRefs(toIds, (ref) => DEFS.find((d) => d.id === ref)?.name);
    expect(back).toBe(src);
  });

  test("a name with quotes comes out escaped", () => {
    const out = rewritePropRefs('prop("p_q")', () => 'Says "hi"');
    expect(out).toBe('prop("Says \\"hi\\"")');
    expect(checkFormula(out, [{ id: "x", name: 'Says "hi"', type: "text" }]).errors).toEqual([]);
  });

  test("text with a syntax error comes back unchanged", () => {
    expect(rewritePropRefs('prop("a', () => "b")).toBe('prop("a');
  });
});

describe("library", () => {
  test("every function has a test case in this file", async () => {
    const self = await Bun.file(new URL(import.meta.url).pathname).text();
    const missing = FUNCTION_NAMES.filter((name) => !new RegExp(`\\b${name}\\(`).test(self));
    expect(missing).toEqual([]);
  });
});

// ---------- fuzz ----------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ATOMS = [
  "1",
  "0",
  "-3.5",
  '"a"',
  '""',
  "true",
  "false",
  "[]",
  "[1, 2]",
  'prop("Value")',
  'prop("Name")',
  'prop("Tags")',
  'prop("When")',
  "current",
  "x",
];
const OPS = ["+", "-", "*", "/", "%", "^", "==", "!=", "<", ">=", "and", "or"];

function randomExpr(r: () => number, depth: number): string {
  if (depth <= 0 || r() < 0.25) return ATOMS[Math.floor(r() * ATOMS.length)] as string;
  const k = r();
  if (k < 0.35)
    return `(${randomExpr(r, depth - 1)}) ${OPS[Math.floor(r() * OPS.length)]} (${randomExpr(r, depth - 1)})`;
  if (k < 0.45) return `(${randomExpr(r, depth - 1)})`;
  if (k < 0.5) return `not ${randomExpr(r, depth - 1)}`;
  if (k < 0.55)
    return `${randomExpr(r, depth - 1)} ? ${randomExpr(r, depth - 1)} : ${randomExpr(r, depth - 1)}`;
  if (k < 0.62) return `let(x, ${randomExpr(r, depth - 1)}, ${randomExpr(r, depth - 1)})`;
  if (k < 0.7)
    return `[${randomExpr(r, depth - 1)}, ${randomExpr(r, depth - 1)}].map(${randomExpr(r, depth - 1)})`;
  const fn = FUNCTION_NAMES[Math.floor(r() * FUNCTION_NAMES.length)] as string;
  const n = Math.floor(r() * 4);
  return `${fn}(${Array.from({ length: n }, () => randomExpr(r, depth - 1)).join(", ")})`;
}

describe("fuzz", () => {
  test("random text: only typed syntax errors, never a raw exception", () => {
    const r = rng(7);
    const alphabet = "abcprop()[]\"',.+-*/%^!?:<>=&|01 9\n\\/*éx_";
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(r() * 60);
      let src = "";
      for (let j = 0; j < len; j++) src += alphabet[Math.floor(r() * alphabet.length)];
      const c = checkFormula(src, DEFS);
      expect(Array.isArray(c.errors)).toBe(true);
      if (!c.errors.length) {
        const out = previewFormula(src, DEFS, row(BASE), { now: NOW, names });
        expect(typeof out.ok).toBe("boolean");
      }
    }
  });

  test("random well-formed expressions: evaluate or give a typed error, within the limit", () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      for (let i = 0; i < 800; i++) {
        const src = randomExpr(r, 5);
        expect(() => parseFormula(src)).not.toThrow();
        const out = previewFormula(src, DEFS, row(BASE), { now: NOW, names });
        if (!out.ok && "runtime" in out) expect(out.runtime).not.toBe("internal");
      }
    }
  });

  test("tokenize round trip: joining the slices gives back the text without spaces", () => {
    const r = rng(11);
    for (let i = 0; i < 300; i++) {
      const src = randomExpr(r, 4);
      const toks = tokenize(src);
      const glued = toks.map((t) => src.slice(t.at[0], t.at[1])).join("");
      expect(glued).toBe(src.replace(/\s+/g, ""));
    }
  });
});
