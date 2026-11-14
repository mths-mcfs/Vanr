// Ported from the origin's debate tests: the scenarios that need no route. The others drive the debate through
// routes/debates and the runtime (a later slice); src/debates.test.ts covers the debate engine without them.
import { describe, expect, test } from "bun:test";
import { type DebatePostRow, POST_CHARS, TRANSCRIPT_CHARS, transcript } from "../src/debates";

describe("debates", () => {
  test("cutting the transcript: each post and the total have a ceiling, the latest stay", () => {
    const posts = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      author: { type: "agent", id: "ag" },
      kind: "turn",
      round: i + 1,
      body: `${String(i).padStart(2, "0")}${"x".repeat(5000)}`,
    })) as unknown as DebatePostRow[];
    const text = transcript(posts, new Map([["ag", "Lia"]]));
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_CHARS + 100);
    expect(text).toContain("earlier post(s) omitted");
    expect(text).toContain('<post round="20" from="Lia">\n19');
    expect(text).not.toContain('<post round="1" from="Lia">\n00');
    for (const line of text.split("\n\n").slice(1)) expect(line.length).toBeLessThan(POST_CHARS + 40);
  });
});
