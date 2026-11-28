// How a message's text is read: blocks, inline marks, links that open only when safe, and mentions.
import { describe, expect, test } from "bun:test";
import { blocksOf, inlineOf } from "./body.tsx";

describe("a message's text", () => {
  test("splits into paragraphs, quotes, lists and fenced code", () => {
    expect(blocksOf("hi\nthere\n\n> said\n> twice\n- a\n- b\n1. one\n```\nx = 1\n```")).toEqual([
      { kind: "paragraph", lines: ["hi", "there"] },
      { kind: "quote", lines: ["said", "twice"] },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["one"] },
      { kind: "code", text: "x = 1" },
    ]);
  });

  test("an unclosed fence runs to the end, and nothing inside it is read", () => {
    expect(blocksOf("```\n**not bold**")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });

  test("nested marks end where they should, however many there are", () => {
    expect(inlineOf("a **b _c_** d ~~e~~ `**f**`")).toEqual([
      { kind: "text", text: "a " },
      {
        kind: "strong",
        children: [
          { kind: "text", text: "b " },
          { kind: "em", children: [{ kind: "text", text: "c" }] },
        ],
      },
      { kind: "text", text: " d " },
      { kind: "strike", children: [{ kind: "text", text: "e" }] },
      { kind: "text", text: " " },
      { kind: "code", text: "**f**" },
    ]);
    expect(inlineOf("**x** **y** **z**").filter((piece) => piece.kind === "strong")).toHaveLength(3);
  });

  test("a mention starts a word; an email address is not one", () => {
    expect(inlineOf("hey @scout, mail ana@birchwood.example")).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", handle: "scout" },
      { kind: "text", text: ", mail ana@birchwood.example" },
    ]);
  });

  test("links: written ones and bare web addresses", () => {
    expect(inlineOf("[docs](https://vanr.test/a) and https://vanr.test/b.")).toEqual([
      { kind: "link", href: "https://vanr.test/a", children: [{ kind: "text", text: "docs" }] },
      { kind: "text", text: " and " },
      {
        kind: "link",
        href: "https://vanr.test/b",
        children: [{ kind: "text", text: "https://vanr.test/b" }],
      },
      { kind: "text", text: "." },
    ]);
  });
});
