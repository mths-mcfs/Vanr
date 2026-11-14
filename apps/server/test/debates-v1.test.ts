// Ported from the origin's debate v1 tests: the scenarios that need no route. The others drive rounds, claims and
// the benchmark through routes/debates and the runtime (a later slice); src/debates.test.ts and
// src/debate-extras.test.ts cover them without those.
import { describe, expect, test } from "bun:test";
import { challengeContext, type DebatePostRow } from "../src/debates";

describe("debates v1: rounds, claim and majority", () => {
  test("P0-02: the shuffled order changes from reader to reader", () => {
    const posts = ["a1", "a2", "a3", "a4", "a5", "a6"].map(
      (id, i) =>
        ({
          id: `p${i}`,
          author: { type: "agent", id },
          kind: "turn",
          round: 0,
          body: `post ${id}`,
          claimData: {
            answer: `r${i}`,
            key: `r${i}`,
            confidence: null,
            reason: "",
            evidence: [],
            changed: false,
          },
        }) as unknown as DebatePostRow,
    );
    const pseudonyms = Object.fromEntries(posts.map((p, i) => [p.author.id, "ABCDEF"[i] as string]));
    const names = new Map(Object.entries(pseudonyms).map(([id, a]) => [id, `Participant ${a}`]));
    const orders = new Set(
      ["a1", "a2", "a3", "a4", "a5", "a6"].map((reader) =>
        [...challengeContext(posts, { id: "deb_x", pseudonyms }, 1, reader, names).matchAll(/answer: (r\d)/g)]
          .map((m) => m[1])
          .join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(3);
  });
});
