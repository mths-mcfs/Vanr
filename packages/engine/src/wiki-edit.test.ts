import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe("wiki editor markdown round trip", () => {
  let parse: import("@milkdown/kit/transformer").Parser;
  let serialize: import("@milkdown/kit/transformer").Serializer;
  let cleanup: (() => void | Promise<void>)[] = [];
  beforeAll(async () => {
    const core = await import("@milkdown/kit/core");
    const { Clock, Container, Ctx } = await import("@milkdown/kit/ctx");
    const cm = await import("@milkdown/kit/preset/commonmark");
    const gfm = await import("@milkdown/kit/preset/gfm");
    const { configureWikiMarkdown, wikiMarkdownPlugins } = await import("./wiki/milkdown");
    const presets = new Set([...cm.commonmark, ...gfm.gfm]);
    const parsing = new Set([
      ...cm.schema,
      ...gfm.schema,
      ...cm.remarkInlineLinkPlugin,
      ...cm.remarkPreserveEmptyLinePlugin,
      ...gfm.remarkGFMPlugin,
    ]);
    const ctx = new Ctx(new Container(), new Clock());
    const plugins = [
      core.schema,
      core.parser,
      core.serializer,
      core.init(core.Editor.make()),
      core.config(configureWikiMarkdown),
      ...wikiMarkdownPlugins.filter((p) => !presets.has(p) || parsing.has(p)),
    ];
    const runners = plugins.map((p) => p(ctx));
    const results = await Promise.all(runners.map((run) => run()));
    cleanup = results.filter((fn): fn is () => void | Promise<void> => typeof fn === "function");
    parse = ctx.get(core.parserCtx);
    serialize = ctx.get(core.serializerCtx);
  });
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
  test.each([
    "Literal \\[[Page]] and math $\\{x\\}$.\n",
    "See [[Page|`token`]] and [[Page|**Label**]].\n",
    "> $$\n> x = 2\n> $$\n",
    "- $$\n  x = 2\n  $$\n",
    "```html\n- <br />\n```\n",
    "- <br />\n",
    "-\n",
  ])("preserves source on save: %s", (source) => {
    expect(serialize(parse(source))).toBe(source);
  });
  test("an escaped alias stays in one table cell after saving", () => {
    const source = "| Link | Note |\n| --- | --- |\n| [[Page\\|Label]] | Keep |\n";
    const saved = serialize(parse(source));
    expect(saved).toContain("[[Page\\|Label]]");
    expect(parse(saved).child(0).child(1).childCount).toBe(2);
    expect(serialize(parse(saved))).toBe(saved);
  });
});
