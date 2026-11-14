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
