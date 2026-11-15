import { describe, expect, test } from "bun:test";
import { classifyRecipients } from "../integrations/destinations";
import { lineDiff, linksIn } from "./preview";

describe("preview: links with the real destination", () => {
  test("markdown, html and bare; text that shows another address is marked", () => {
    const text = [
      "See [the order](https://shop.test/p/1) and [bank.com](http://scam.test/login).",
      '<a href="https://x.test/a">click</a> and https://bare.test/b.',
    ].join("\n");
    expect(linksIn(text)).toEqual([
      "https://shop.test/p/1",
      "bank.com → http://scam.test/login",
      "https://x.test/a",
      "https://bare.test/b",
    ]);
    expect(linksIn("no link")).toEqual([]);
  });

  test("line diff: + comes in, - goes out, unchanged stays", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toBe("  a\n- b\n+ B\n  c\n+ d");
  });
});

describe("email destinations", () => {
  const known = {
    workspaceDomains: new Set(["workshop.test"]),
    allowList: ["@partner.test", "owner@gmail.com"],
    thread: ["John@Customer.test", "mary@gmail.com"],
  };
  test("only workspace domains and the admin list make recipients known", () => {
    expect(
      classifyRecipients(
        [
          "ana@workshop.test",
          "john@customer.test",
          "other@customer.test",
          "mary@gmail.com",
          "jane@gmail.com",
          "x@partner.test",
          "owner@gmail.com",
          "x@attacker.test",
        ],
        known,
      ),
    ).toEqual({
      known: ["ana@workshop.test", "x@partner.test", "owner@gmail.com"],
      fresh: [
        "john@customer.test",
        "other@customer.test",
        "mary@gmail.com",
        "jane@gmail.com",
        "x@attacker.test",
      ],
    });
  });
  test("an empty mailbox list allows nobody", () => {
    expect(
      classifyRecipients(["x@outside.test"], { workspaceDomains: new Set(), allowList: [], thread: [] }),
    ).toEqual({
      known: [],
      fresh: ["x@outside.test"],
    });
  });
});
