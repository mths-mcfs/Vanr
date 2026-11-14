import { describe, expect, test } from "bun:test";
import { merge3 } from "./merge";

const base = "# Title\n\nOne.\n\nTwo.\n\nThree.\n";

describe("merge3", () => {
  test("changes in different paragraphs are combined", () => {
    const ours = base.replace("One.", "One, from the draft.");
    const theirs = base.replace("Three.", "Three, from the agent.");
    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: "# Title\n\nOne, from the draft.\n\nTwo.\n\nThree, from the agent.\n",
    });
  });

  test("insertions at different points and at the end", () => {
    const ours = `${base}\nNew from the draft.\n`;
    const theirs = base.replace("# Title\n", "# Title\n\nBefore.\n");
    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: "# Title\n\nBefore.\n\nOne.\n\nTwo.\n\nThree.\n\nNew from the draft.\n",
    });
  });

  test("the same line changed on both sides is a conflict", () => {
    const r = merge3(base, base.replace("Two.", "Two A."), base.replace("Two.", "Two B."));
    expect(r).toEqual({ ok: false, conflicts: 1 });
  });

  test("touching changes go in order: editing the last line and appending after it", () => {
    const short = "# Closing\n\nClose at 6 pm.\n";
    const ours = short.replace("6 pm.", "6 pm. Saturday until noon.");
    // The agent appends without a trailing newline (update_wiki_page in append mode).
    const theirs = `${short}\n## Holidays\n\nClosed on holidays.`;
    expect(merge3(short, ours, theirs)).toEqual({
      ok: true,
      text: "# Closing\n\nClose at 6 pm. Saturday until noon.\n\n## Holidays\n\nClosed on holidays.\n",
    });
    // An insertion touching the start of a changed range comes before it.
    const before = merge3(
      base,
      base.replace("Two.", "2."),
      base.replace("\nTwo.", "One and a half.\n\nTwo."),
    );
    expect(before).toEqual({ ok: true, text: "# Title\n\nOne.\nOne and a half.\n\n2.\n\nThree.\n" });
  });

  test("both sides inserting at the same point, or an insertion inside a changed range, is a conflict", () => {
    expect(merge3(base, `${base}A\n`, `${base}B\n`)).toEqual({ ok: false, conflicts: 1 });
    const lines = "a\nb\nc\n";
    expect(merge3(lines, "a\nX\n", "a\nb\nnew\nc\n")).toEqual({ ok: false, conflicts: 1 });
  });

  test("the same change on both sides is not a conflict", () => {
    const both = base.replace("Two.", "Two!");
    expect(merge3(base, both, both)).toEqual({ ok: true, text: both });
  });

  test("a side without changes returns the other", () => {
    const ours = base.replace("One.", "1.");
    expect(merge3(base, ours, base)).toEqual({ ok: true, text: ours });
    expect(merge3(base, base, ours)).toEqual({ ok: true, text: ours });
  });

  test("deleting on one side and editing near it on the other, with a blank line between", () => {
    const ours = base.replace("One.\n\n", "");
    const theirs = base.replace("Three.", "3.");
    expect(merge3(base, ours, theirs)).toEqual({ ok: true, text: "# Title\n\nTwo.\n\n3.\n" });
  });

  test("fuzz: with changes on distant lines, the result has both", () => {
    for (let seed = 1; seed < 200; seed++) {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`);
      const i = seed % 10;
      const j = 15 + (seed % 13);
      const ours = lines.map((l, k) => (k === i ? `ours ${seed}\n` : l)).join("");
      const theirs = lines.map((l, k) => (k === j ? `theirs ${seed}\n` : l)).join("");
      const r = merge3(lines.join(""), ours, theirs);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.text).toContain(`ours ${seed}\n`);
        expect(r.text).toContain(`theirs ${seed}\n`);
        expect(r.text.split("\n").length).toBe(31);
      }
    }
  });
});
