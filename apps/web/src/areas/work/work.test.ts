// The work area's pure rules: a description's list lines as criteria, a card's place between two others,
// and the formatted text people write.
import { describe, expect, test } from "bun:test";
import { positionBetween, splitCriteria } from "./issues/shared.tsx";
import { blocksOf, safeHref } from "./RichText.tsx";

describe("criteria from a description", () => {
  test("list lines and boxes become criteria, the rest stays, and a bare marker is dropped", () => {
    expect(splitCriteria("Intro\n- one\n* two\n[ ] three\n- [x] four\n-\n[ ]\n\nOutro")).toEqual({
      description: "Intro\n\nOutro",
      criteria: ["one", "two", "three", "four"],
    });
    expect(splitCriteria("no list here")).toEqual({ description: "no list here", criteria: [] });
    expect(splitCriteria("-dash glued to a word")).toEqual({
      description: "-dash glued to a word",
      criteria: [],
    });
  });
});

describe("a place on the board", () => {
  test("between two neighbours, before the first, after the last, or alone", () => {
    expect(positionBetween(10, 20)).toBe(15);
    expect(positionBetween(undefined, 20)).toBe(20 - 1024);
    expect(positionBetween(10, undefined)).toBe(10 + 1024);
    expect(positionBetween(undefined, undefined)).toBe(0);
  });
});

describe("formatted text", () => {
  test("only http and https open as links", () => {
    expect(safeHref("https://git.example/pr/7")).toBe("https://git.example/pr/7");
    expect(safeHref("http://a.example")).toBe("http://a.example/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/relative", "ftp://x.example"]) {
      expect(safeHref(bad)).toBe(undefined);
    }
  });

  test("headings, lists, quotes, code and paragraphs become blocks", () => {
    const kinds = blocksOf(
      "# Title\n\nA line\nand more\n\n- a\n- b\n\n1. one\n\n> said\n\n```\ncode\n```",
    ).map((block) => block.kind);
    expect(kinds).toEqual(["heading", "paragraph", "list", "list", "quote", "code"]);
  });
});
