import { describe, expect, test } from "bun:test";
import {
  applyProps,
  isStorable,
  normalizeProps,
  type PropDef,
  type PropValue,
  parsePropText,
  propText,
  storableText,
} from "./props";

const DEFS: PropDef[] = [
  { id: "p_title", name: "Title", type: "text" },
  { id: "p_n", name: "Value", type: "number" },
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
      { id: "o_a", name: "Alpha" },
      { id: "o_b", name: "Beta" },
    ],
  },
  { id: "p_when", name: "When", type: "date" },
  { id: "p_ok", name: "Ok", type: "checkbox" },
  { id: "p_who", name: "Who", type: "person" },
  { id: "p_url", name: "Link", type: "url" },
  { id: "p_created", name: "Created", type: "created_time" },
];

describe("applyProps", () => {
  test("a valid write adds to the current values; null clears", () => {
    const r = applyProps(DEFS, { p_title: "a", p_n: 1 }, { p_n: 2, p_status: "o_done", p_title: null });
    expect(r).toEqual({ ok: true, props: { p_n: 2, p_status: "o_done" } });
  });

  test("rejects an unknown property, a computed one, a missing option and a wrong type", () => {
    const r = applyProps(
      DEFS,
      {},
      {
        p_x: 1,
        p_created: "2026-01-01",
        p_status: "o_no",
        p_tags: ["o_a", "o_z"],
        p_n: "3",
        p_url: "javascript:alert(1)",
        p_when: { start: "yesterday" },
        p_who: [{ type: "bot", id: "x" }],
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.fromEntries(r.errors.map((e) => [e.propId, e.code]))).toEqual({
      p_x: "unknown_prop",
      p_created: "read_only",
      p_status: "unknown_option",
      p_tags: "unknown_option",
      p_n: "invalid",
      p_url: "invalid",
      p_when: "invalid",
      p_who: "invalid",
    });
  });

  test("a non-finite number is rejected", () => {
    expect(applyProps(DEFS, {}, { p_n: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  test("text Postgres cannot store (NUL, lone surrogate half) is rejected", () => {
    for (const bad of ["a\u0000b", "a\uD800", "\uDC00b"]) {
      const r = applyProps(DEFS, {}, { p_title: bad, p_url: `https://x.test/${bad}` });
      expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["invalid", "invalid"]);
    }
    expect(applyProps(DEFS, {}, { p_title: "whole emoji \u{1F600}" }).ok).toBe(true);
    expect(isStorable({ a: ["x", { "k\u0000": 1 }] })).toBe(false);
    expect(storableText("a\u0000b\uD800c")).toBe("ab�c");
  });
});

describe("text round trip (CSV, front matter)", () => {
  const cases: [string, unknown][] = [
    ["p_title", "café"],
    ["p_n", 3.5],
    ["p_status", "o_done"],
    ["p_tags", ["o_a", "o_b"]],
    ["p_when", { start: "2026-10-22", end: "2026-10-23" }],
    ["p_ok", true],
    ["p_url", "https://example.com/x"],
  ];
  for (const [id, value] of cases) {
    test(id, () => {
      const def = DEFS.find((d) => d.id === id) as PropDef;
      const text = propText(def, value as never);
      expect(parsePropText(def, text)).toEqual(value as never);
    });
  }

  test("option by name without case; number with a comma", () => {
    const status = DEFS[2] as PropDef;
    expect(parsePropText(status, "done")).toBe("o_done");
    expect(parsePropText(DEFS[1] as PropDef, "2,5")).toBe(2.5);
    expect(parsePropText(status, "other")).toBeUndefined();
  });
});

test("editable text and lists round trip without losing characters", () => {
  const cases: [PropDef, PropValue][] = [
    [{ id: "p", name: "P", type: "text" }, "  café\n\n"],
    [{ id: "p", name: "P", type: "text" }, ""],
    [
      { id: "p", name: "P", type: "multi_select", options: [{ id: "design", name: 'Design, "UX"' }] },
      ["design"],
    ],
    [
      { id: "p", name: "P", type: "person" },
      [
        { type: "person", id: "u,1" },
        { type: "agent", id: "a1" },
      ],
    ],
    [{ id: "p", name: "P", type: "file" }, ["file_1", "file,2"]],
  ];
  for (const [def, value] of cases) {
    expect(applyProps([def], {}, { p: parsePropText(def, propText(def, value)) })).toEqual({
      ok: true,
      props: { p: value },
    });
  }
});

test("unknown checkbox words are not silently converted to false", () => {
  const def: PropDef = { id: "c", name: "Check", type: "checkbox" };
  expect(parsePropText(def, "maybe")).toBeUndefined();
  expect(normalizeProps([def], { c: "maybe" })).toEqual({});
});

test("date writes reject invalid clocks and offsets on either endpoint", () => {
  const def: PropDef = { id: "d", name: "D", type: "date" };
  for (const time of ["99:30:00Z", "12:00:00+99:00"]) {
    const invalid = `2026-11-14T${time}`;
    for (const value of [{ start: invalid }, { start: "2026-11-14", end: invalid }])
      expect(applyProps([def], {}, { d: value }).ok).toBe(false);
  }
  expect(applyProps([def], {}, { d: { start: "2026-11-14T23:59:59.123-03:00" } }).ok).toBe(true);
});
