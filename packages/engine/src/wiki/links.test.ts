import { describe, expect, test } from "bun:test";
import { blockIds, bodyTags, headings, parseWikiLinks, resolveTarget, rewriteLinks, slugify } from "./links";
import { VAULT_NOTES } from "./vault-fixture";

describe("parseWikiLinks", () => {
  test("target, heading, block, link text and embed", () => {
    const md = "See [[A]], [[Folder/B|bé]], [[C#Section 2]], [[D#^block-1|here]] and ![[img.png|300]].";
    expect(
      parseWikiLinks(md).map(({ target, anchor, linkText, embed }) => ({ target, anchor, linkText, embed })),
    ).toEqual([
      { target: "A", anchor: null, linkText: null, embed: false },
      { target: "Folder/B", anchor: null, linkText: "bé", embed: false },
      { target: "C", anchor: "Section 2", linkText: null, embed: false },
      { target: "D", anchor: "^block-1", linkText: "here", embed: false },
      { target: "img.png", anchor: null, linkText: "300", embed: true },
    ]);
  });

  test("code, backticks, comments and escapes do not count", () => {
    const md = [
      "```ts",
      "const x = '[[Inside the block]]';",
      "```",
      "",
      "Text `[[in backticks]]` and %% [[commented]] %% and \\[[escaped]] and [[Outside]].",
      "~~~",
      "[[another block]]",
      "~~~",
    ].join("\n");
    expect(parseWikiLinks(md).map((l) => l.target)).toEqual(["Outside"]);
  });

  test("the position matches the text", () => {
    const md = "x [[Target|y]] z";
    const [l] = parseWikiLinks(md);
    expect(l && md.slice(l.start, l.end)).toBe("[[Target|y]]");
  });

  test("finds the links of the onboarding note in the test vault", () => {
    const note = VAULT_NOTES.find((n) => n.path === "Processes/Onboarding.md");
    expect(parseWikiLinks(note?.text ?? "").map((l) => l.raw)).toEqual([
      "[[Values]]",
      "![[attachments/contract.pdf]]",
      "[[People/Bruno|Bruno]]",
    ]);
  });
});

describe("rewriteLinks", () => {
  test("replaces the target and keeps anchor, link text and embed; code stays", () => {
    const md = "[[Old]] [[old#T|a]] ![[Old#^b]] `[[Old]]` [[Other]]";
    const out = rewriteLinks(md, (l) => (l.target.toLowerCase() === "old" ? { target: "New" } : null));
    expect(out).toEqual({ md: "[[New]] [[New#T|a]] ![[New#^b]] `[[Old]]` [[Other]]", count: 3 });
    // New link text only when asked for; null removes the link text.
    expect(rewriteLinks("[[Old]] [[Old|a]]", () => ({ target: "x", linkText: "New" })).md).toBe(
      "[[x|New]] [[x|New]]",
    );
    expect(rewriteLinks("[[Old|a]]", () => ({ target: "x", linkText: null })).md).toBe("[[x]]");
  });
});

describe("resolveTarget", () => {
  const page = (slug: string, title: string, folder = "", aliases: string[] = []) => ({
    slug,
    title,
    folder,
    aliases,
  });

  test("slug, title, folder/title, alias and slug of the text, in that order; without .md", () => {
    const pages = [
      page("plan", "Other"),
      page("x", "Plan", "a"),
      page("y", "Target", "b", ["Goal"]),
      page("meeting-notes", "Notes", "c"),
    ];
    expect(resolveTarget("Plan", pages)?.slug).toBe("plan");
    expect(resolveTarget("a/Plan.md", pages)?.slug).toBe("x");
    expect(resolveTarget("goal", pages)?.slug).toBe("y");
    expect(resolveTarget("Meeting Notés", pages)?.slug).toBe("meeting-notes");
    expect(resolveTarget("  ", pages)).toBeUndefined();
  });

  test("tie: shortest folder and then the slug, whatever the list order", () => {
    const pages = [
      page("meeting-2", "Meeting", "bb"),
      page("meeting", "Meeting", "aa"),
      page("r3", "Meeting", "a/b"),
    ];
    for (let i = 0; i < 20; i++) {
      const shuffled = [...pages].sort(() => Math.random() - 0.5);
      expect(resolveTarget("Meeting", shuffled)?.slug).toBe("meeting");
    }
    expect(slugify("Réunion Agenda!")).toBe("reunion-agenda");
  });

  test("tie: a page the whole workspace reads wins over a restricted one, even with a shorter folder", () => {
    const pages = [
      { ...page("plan-restricted", "Plan", ""), restricted: true },
      page("plan", "Plan", "deep/folder"),
    ];
    expect(resolveTarget("Plan", pages)?.slug).toBe("plan");
    expect(resolveTarget("Plan", [pages[0] as (typeof pages)[0]])?.slug).toBe("plan-restricted");
  });
});

describe("blocks, headings and tags", () => {
  test("block ids at the end of a line and alone", () => {
    expect(blockIds("Line ^abc\n\n| a |\n|---|\n\n^table-1\n\n`x ^notone`\n")).toEqual(["abc", "table-1"]);
  });

  test("ATX and setext headings, outside code, without markup", () => {
    const md = "Heading\n===\n\n## With **bold** and [[A|link]]\n\n```\n# not\n```\nSub\n---\n";
    expect(headings(md).map((h) => [h.level, h.text])).toEqual([
      [1, "Heading"],
      [2, "With bold and link"],
      [2, "Sub"],
    ]);
  });

  test("body tags: nested, no digits only, no headings and no code", () => {
    const md = "# Heading\n\nText #Project and #team/product, (#between) not #123 nor a#b.\n\n`#code`";
    expect(bodyTags(md).sort()).toEqual(["between", "project", "team/product"]);
  });
});

test("table aliases resolve and keep their escaped delimiter when renamed", () => {
  const md = "| [[Page\\|Label]] | Keep |";
  const page = { slug: "page-2", title: "Page", folder: "" };
  expect(resolveTarget(parseWikiLinks(md)[0]?.target ?? "", [page])).toEqual(page);
  expect(rewriteLinks(md, () => ({ target: "New" }))).toEqual({ md: "| [[New\\|Label]] | Keep |", count: 1 });
});

test("fences in list and quote containers end before outside links", () => {
  for (const [open, body, close] of [
    ["- ```md", "  ", "  ```"],
    ["> ```md", "> ", "> ```"],
    ["- ~~~", "  ", "  ~~~"],
    ["```md", "> ", "```"],
    ["> ```md", "> > ", "> ```"],
  ]) {
    const md = `${open}\n${body}[[Old]]\n${body}\n${body}# Not a heading\n${body}\n${close}\n\n[[Old]]\n`;
    expect(rewriteLinks(md, () => ({ target: "New" }))).toEqual({
      md: `${md.slice(0, md.lastIndexOf("[[Old]]"))}[[New]]\n`,
      count: 1,
    });
    expect(headings(md)).toEqual([]);
  }
});

test("long unmatched delimiter runs stay literal and preserve following links", () => {
  for (const source of [`x ${"`".repeat(40000)}x`, `${"[".repeat(40000)}x`]) {
    expect(parseWikiLinks(`${source}\n\n[[Outside]]`).map((l) => l.target)).toEqual(["Outside"]);
  }
  expect(parseWikiLinks("`` unmatched `[[Hidden]]` [[Visible]]").map((l) => l.target)).toEqual(["Visible"]);
});

test("CRLF headings and literal underscores keep their anchor text", () => {
  expect(headings("# Main\r\n\r\nSub\r\n---\r\n")).toEqual([
    { level: 1, text: "Main", line: 0 },
    { level: 2, text: "Sub", line: 2 },
  ]);
  expect(headings("## API_key and `a_b` with **bold** and _italic_")[0]?.text).toBe(
    "API_key and a_b with bold and italic",
  );
});

test("comments can surround fences without exposing links, headings or tags", () => {
  for (const fence of ["```md", "~~~md"]) {
    const comment = `%%\n## Hidden [[Old]] #hidden\n${fence}\nexample\n${fence.slice(0, 3)}\n## Hidden [[Old]] #hidden\n%%\n\n`;
    const source = `${comment}## Visible\n[[Old]] #visible\n`;
    expect(parseWikiLinks(source).map((link) => link.start)).toEqual([source.lastIndexOf("[[Old]]")]);
    expect(rewriteLinks(source, () => ({ target: "New" }))).toEqual({
      md: `${comment}## Visible\n[[New]] #visible\n`,
      count: 1,
    });
    expect(headings(source).map((heading) => heading.text)).toEqual(["Visible"]);
    expect(bodyTags(source)).toEqual(["visible"]);
  }
});

test.each([
  ["***Important***", "Important"],
  ["___Important___", "Important"],
  ["**bold *italic***", "bold italic"],
  ["__bold _italic___", "bold italic"],
  ["*italic **bold***", "italic bold"],
  ["_italic __bold___", "italic bold"],
  ["API_key and `***a_b***` with **_nested_**", "API_key and ***a_b*** with nested"],
  ["Literal \\*stars\\* and under_score", "Literal *stars* and under_score"],
])("nested emphasis is omitted from heading anchors: %s", (markup, text) => {
  expect(headings(`## ${markup}`)[0]?.text).toBe(text);
  expect(headings(`${markup}\n---\n`)[0]?.text).toBe(text);
});
