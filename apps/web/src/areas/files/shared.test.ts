// The files area's helpers: the query's words marked in a snippet, sizes and relative times.
import { describe, expect, test } from "bun:test";
import { formatBytes, highlightParts, relativeTime } from "./shared.tsx";

describe("the words of a query marked in a text", () => {
  test("ignores case and accents, and skips operators and excluded words", () => {
    expect(highlightParts("Ação no Pátio", "patio")).toEqual([
      { text: "Ação no ", hit: false },
      { text: "Pátio", hit: true },
    ]);
    expect(highlightParts("ink from:@ana", "from:@ana -ink")).toEqual([
      { text: "ink from:@ana", hit: false },
    ]);
  });

  test("a query of accents alone marks nothing and returns at once", () => {
    expect(highlightParts("plain text", "́̀")).toEqual([{ text: "plain text", hit: false }]);
  });
});

describe("sizes and times in the interface language", () => {
  test("bytes in the largest unit above one", () => {
    expect(formatBytes(512, "en")).toBe("512 byte");
    expect(formatBytes(1536, "en")).toBe("1.5 kB");
  });

  test("the distance from now in the largest unit that fits", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(relativeTime("2026-11-13T12:00:00Z", now, "en")).toBe("yesterday");
    expect(relativeTime("2026-11-14T11:59:40Z", now, "en")).toBe("this minute");
  });
});
