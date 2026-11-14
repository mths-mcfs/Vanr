import { describe, expect, test } from "bun:test";
import { diffText } from "./diff";

describe("diffText", () => {
  test("equal text has no changed line and no context", () => {
    expect(diffText("a\nb\n", "a\nb\n")).toEqual({ rows: [{ kind: "gap", count: 2 }], added: 0, removed: 0 });
  });

  test("a changed line marks the words; 3 lines of context and gaps", () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`)
      .join("\n")
      .concat("\n");
    const after = before.replace("l6\n", "l6 changed\n");
    const { rows, added, removed } = diffText(before, after);
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
    expect(rows[0]).toEqual({ kind: "gap", count: 3 });
    expect(rows.at(-1)).toEqual({ kind: "gap", count: 2 });
    expect(rows.filter((r) => r.kind === "same").map((r) => (r as { text: string }).text)).toEqual([
      "l3",
      "l4",
      "l5",
      "l7",
      "l8",
      "l9",
    ]);
    expect(rows.find((r) => r.kind === "add")).toEqual({
      kind: "add",
      text: "l6 changed",
      parts: [
        { kind: "same", text: "l6" },
        { kind: "add", text: " changed" },
      ],
    });
  });

  test("blocks of different sizes become whole lines", () => {
    const { rows } = diffText("a\nb\n", "a\nx\ny\n");
    expect(rows).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  test("an empty page on one side", () => {
    expect(diffText("", "one\ntwo\n")).toMatchObject({ added: 2, removed: 0 });
    expect(diffText("one\n", "")).toMatchObject({ added: 0, removed: 1 });
  });
});
