import { describe, expect, test } from "bun:test";
import { type PropDef, parsePropText } from "../props";
import { frontmatterToProps } from "../wiki/props-vault";
import { inferColumns } from "./csv";

const CHECKBOX: PropDef = { id: "c", name: "Done", type: "checkbox" };

describe("checkbox words", () => {
  test("every value the CSV inference reads as checked converts to true", () => {
    const checked = ["✓", "✔", "x", "X", "yes", "true", "sim"];
    const col = inferColumns(["Title", "Done"], [...checked.map((v) => ["a", v]), ["b", "no"]], () => "o")[1];
    expect(col?.type).toBe("checkbox");
    for (const v of checked) expect([v, parsePropText(CHECKBOX, v)]).toEqual([v, true]);
    for (const v of ["no", "false", "não", "nao"])
      expect([v, parsePropText(CHECKBOX, v)]).toEqual([v, false]);
  });

  test("front matter uses the same words", () => {
    const defs: PropDef[] = [CHECKBOX];
    expect(frontmatterToProps(defs, { Done: "✓" }).write).toEqual({ c: true });
    expect(frontmatterToProps(defs, { Done: "✔" }).write).toEqual({ c: true });
    expect(frontmatterToProps(defs, { Done: "no" }).write).toEqual({ c: false });
  });
});
