// The Voyage response is outside data: exactly one vector per text, unique indices covering 0..n-1, the
// right dimension, finite numbers and a non-negative token count, or the call fails and nothing is stored.
import { describe, expect, test } from "bun:test";
import { EMBED_DIMS, voyageEmbedder } from "./embeddings";

const vector = (x: number) => Array.from({ length: EMBED_DIMS }, () => x);
const embedWith = (body: unknown) =>
  voyageEmbedder({
    apiKey: "test-key",
    fetch: (async () => Response.json(body)) as unknown as typeof fetch,
  }).embed(["first", "second"], "document");

describe("Voyage response at the boundary", () => {
  test("vectors are matched to the texts by index, in any order", async () => {
    const r = await embedWith({
      data: [
        { index: 1, embedding: vector(0.2) },
        { index: 0, embedding: vector(0.1) },
      ],
      usage: { total_tokens: 7 },
    });
    expect(r.vectors.map((v) => v[0])).toEqual([0.1, 0.2]);
    expect(r.tokens).toBe(7);
  });

  test("a repeated, missing or out-of-range index, a wrong count, dimension or token count is an error", async () => {
    const bad = [
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 0, embedding: vector(0.2) },
        ],
      },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 2, embedding: vector(0.2) },
        ],
      },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: -1, embedding: vector(0.2) },
        ],
      },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 1.5, embedding: vector(0.2) },
        ],
      },
      { data: [{ index: 0, embedding: vector(0.1) }] },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 1, embedding: [0.1, 0.2] },
        ],
      },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 1, embedding: vector(0.2) },
        ],
        usage: { total_tokens: -1 },
      },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 1, embedding: vector(0.2) },
        ],
        usage: { total_tokens: 2.5 },
      },
      {
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 1, embedding: [...vector(0.2).slice(1), "x"] },
        ],
      },
    ];
    for (const body of bad) await expect(embedWith(body)).rejects.toThrow("voyage");
  });
});
