// The wiki's pure pieces: how a batch of notes is cut for the import, a link path split into folder
// and title, a backlink snippet without its syntax, the server's version notes, and the `/` search.
import { describe, expect, test } from "bun:test";
import { formatMessage } from "../../i18n/format.ts";
import en from "../../messages/wiki/en.ts";
import { filterSlash } from "./editor/slash.ts";
import { importBatches, plainSnippet, splitPath, versionNote } from "./shared.tsx";

const t = ((key: keyof typeof en, params?: Record<string, string | number>) =>
  formatMessage(en[key], params, "en")) as Parameters<typeof versionNote>[1];

describe("the wiki's pieces", () => {
  test("the import cuts batches of at most 500 notes, leaves out what is too large, and counts the rest", () => {
    const notes = Array.from({ length: 501 }, (_, n) => ({ path: `note-${n}.md`, text: "x" }));
    const huge = { path: "huge.md", text: "x".repeat(510_001) };
    const plan = importBatches([
      ...notes,
      huge,
      { path: "photo.png", text: "" },
      { path: `${"a".repeat(501)}.md`, text: "" },
    ]);
    expect(plan.batches.map((batch) => batch.length)).toEqual([500, 1]);
    expect(plan.tooLarge).toEqual(["huge.md", `${"a".repeat(501)}.md`]);
    expect(plan.skipped).toBe(1);
  });

  test("a batch closes before its JSON passes 24 MB, counted in UTF-8 bytes", () => {
    const big = (n: number) => ({ path: `big-${n}.md`, text: "x".repeat(500_000) });
    expect(importBatches(Array.from({ length: 49 }, (_, n) => big(n))).batches.map((b) => b.length)).toEqual([
      47, 2,
    ]);
    // Two bytes a letter: half as many notes fit.
    const accented = (n: number) => ({ path: `acc-${n}.md`, text: "é".repeat(500_000) });
    expect(
      importBatches(Array.from({ length: 30 }, (_, n) => accented(n))).batches.map((b) => b.length),
    ).toEqual([23, 7]);
  });

  test("every batch fits the server's 32 MiB request, even with three-byte letters", () => {
    const notes = Array.from({ length: 24 }, (_, n) => ({
      path: `notes/note-${n}.md`,
      text: "漢".repeat(500_000),
    }));
    const plan = importBatches(notes);
    const sizes = plan.batches.map(
      (batch) => new TextEncoder().encode(JSON.stringify({ files: batch })).length,
    );
    expect(plan.batches.flat()).toHaveLength(24);
    expect(sizes.every((size) => size <= 32 * 1024 * 1024)).toBe(true);
  });

  test("a link path is a folder and a title", () => {
    expect(splitPath("Guides/ Onboarding /First day")).toEqual({
      folder: "Guides/Onboarding",
      title: "First day",
    });
    expect(splitPath("Holidays")).toEqual({ folder: "", title: "Holidays" });
    expect(splitPath("")).toEqual({ folder: "", title: "" });
  });

  test("a backlink snippet reads as a person would read it", () => {
    expect(plainSnippet("See [[Press checklist#After|the end]] and [[Ink suppliers#^b1]].")).toBe(
      "See the end and Ink suppliers › b1.",
    );
  });

  test("the server's notes are told in the interface language; a person's note stays as written", () => {
    expect(versionNote('renamed from "Old"', t)).toBe("Renamed from “Old”");
    expect(versionNote("restore:v3", t)).toBe("Restored version 3");
    expect(versionNote("idle +2", t)).toBe("Published after a quiet spell, with 2 others");
    expect(versionNote("proposal wpr_1", t)).toBe("Accepted a proposal");
    expect(versionNote("Fixed the opening hours", t)).toBe("Fixed the opening hours");
  });

  test("the / menu finds blocks by English or Portuguese words, without accents", () => {
    const label = (item: { id: string }) => item.id;
    expect(filterSlash("tabela", label).map((item) => item.id)).toEqual(["table"]);
    expect(filterSlash("CÓDIGO", label).map((item) => item.id)).toEqual(["code"]);
    expect(filterSlash("", label)).toHaveLength(12);
  });
});
