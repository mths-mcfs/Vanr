import { describe, expect, test } from "bun:test";
import { isBlockRaw } from "./milkdown";

// The expression isBlockRaw replaced: the oracle for what it accepts.
const OLD = /^(?:\$\$[\s\S]*?\$\$|%%[\s\S]*?%%)\s*$|<[A-Za-z][\w-]*\s[^<>]*\n[^<>]*>/;

describe("a raw block paragraph", () => {
  test("accepts and rejects what the old expression did", () => {
    const cases = [
      "$$\nx^2\n$$",
      "$$ a $$  \n",
      "$$$",
      "$$$$",
      "%% note\nmore %%",
      "%%%",
      "$$ open",
      '<div class="a"\n  id="b">',
      "<div\nclass>",
      "<div\n\nx>",
      "<div class=a>",
      "text <span a\nb> tail",
      "<1a b\nc>",
      "<a b\nc <d e\nf>",
      "<a b\nc",
      "< a\nb>",
      "plain paragraph",
      "",
    ];
    for (const c of cases) expect([c, isBlockRaw(c)]).toEqual([c, OLD.test(c)]);
  });

  test("agrees with the old expression on random paragraphs made of its tokens", () => {
    const tokens = ["<", ">", "a", "Z", "-", "_", "1", " ", "\n", "\t", "$$", "%%", "x", "<b ", " "];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let n = 0; n < 5_000; n++) {
      let s = "";
      const len = next() % 14;
      for (let i = 0; i < len; i++) s += tokens[next() % tokens.length];
      expect([s, isBlockRaw(s)]).toEqual([s, OLD.test(s)]);
    }
  });

  test("an unclosed tag over 200 thousand characters of lines is answered at once", () => {
    const text = `<a ${"x\n".repeat(100_000)}`;
    const started = performance.now();
    expect(isBlockRaw(text)).toBe(false);
    expect(isBlockRaw(`${text}>`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
