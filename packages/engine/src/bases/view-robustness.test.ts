import { describe, expect, test } from "bun:test";
import type { PropDef } from "../props";
import { checkFilter, type Filter, type RowView, resolveDay, rowMatches } from "./view";

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
