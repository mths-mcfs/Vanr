import { describe, expect, test } from "bun:test";
import { applyEdits } from "./wiki-edit";

describe("applyEdits", () => {
  test("replaces the unique snippet", () => {
    expect(applyEdits("a b c", [{ oldStr: "b", newStr: "B" }])).toEqual({
      ok: true,
      text: "a B c",
      replaced: 1,
    });
  });

  test("a missing, empty or unchanged snippet is rejected", () => {
    expect(applyEdits("a b c", [{ oldStr: "x", newStr: "y" }])).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(applyEdits("a", [{ oldStr: "", newStr: "y" }])).toMatchObject({ ok: false, code: "empty_old" });
    expect(applyEdits("a", [{ oldStr: "a", newStr: "a" }])).toMatchObject({ ok: false, code: "no_change" });
  });

  test("a repeated snippet only passes with replaceAll", () => {
    expect(applyEdits("x x", [{ oldStr: "x", newStr: "y" }])).toMatchObject({
      ok: false,
      code: "ambiguous",
      matches: 2,
    });
    expect(applyEdits("x x", [{ oldStr: "x", newStr: "y", replaceAll: true }])).toEqual({
      ok: true,
      text: "y y",
      replaced: 2,
    });
  });

  test("all or nothing, in order, and the new text is literal", () => {
    expect(
      applyEdits("one two", [
        { oldStr: "one", newStr: "1" },
        { oldStr: "three", newStr: "3" },
      ]),
    ).toMatchObject({ ok: false, code: "not_found", index: 1 });
    expect(
      applyEdits("one two", [
        { oldStr: "one", newStr: "$& $1" },
        { oldStr: "$& $1 two", newStr: "ok" },
      ]),
    ).toEqual({ ok: true, text: "ok", replaced: 2 });
  });

  test("a snippet that overlaps itself is not unique", () => {
    // Found in the adversarial review: "--" in "| --- |" passed as unique and replaced the first one.
    expect(applyEdits("| --- |", [{ oldStr: "--", newStr: "==" }])).toMatchObject({
      ok: false,
      code: "ambiguous",
      matches: 2,
    });
    expect(applyEdits("aaa", [{ oldStr: "aa", newStr: "b", replaceAll: true }])).toEqual({
      ok: true,
      text: "ba",
      replaced: 1,
    });
  });
});
