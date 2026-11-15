// Search vectors. Voyage (voyage-4, 1024 dimensions) only comes in with VOYAGE_API_KEY; in tests and
// without a key, `fakeEmbedder` gives deterministic vectors from letter trigrams (similar word, similar
// vector), enough to prove the vector leg and RRF without a network.
import { z } from "zod";
import { fold } from "./text";

export const EMBED_DIMS = 1024;

interface EmbedResult {
  vectors: number[][];
  /** Billed tokens (recorded in the ledger as `search`). */
  tokens: number;
}

export interface Embedder {
  /** Model name (the ledger records it). */
  readonly model: string;
  /** `document` when indexing, `query` when searching (Voyage uses different prompts). */
  embed(texts: readonly string[], kind: "document" | "query"): Promise<EmbedResult>;
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** 32-bit FNV-1a. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic and offline: sum of the word trigrams (with edges) over 1024 positions. */
export function fakeEmbedder(): Embedder & { calls: number } {
  const self = {
    model: "fake-embed",
    calls: 0,
    async embed(texts: readonly string[]): Promise<EmbedResult> {
      self.calls++;
      const vectors = texts.map((t) => {
        const v = new Array<number>(EMBED_DIMS).fill(0);
        for (const w of fold(t).match(/[\p{L}\p{N}]+/gu) ?? []) {
          const padded = ` ${w} `;
          for (let i = 0; i + 3 <= padded.length; i++) {
            const h = hash(padded.slice(i, i + 3));
            v[h % EMBED_DIMS] = (v[h % EMBED_DIMS] ?? 0) + (h & 0x10000 ? 1 : -1);
          }
        }
        return normalize(v);
      });
      const tokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
      return { vectors, tokens };
    },
  };
  return self;
}

const count = z.number().int().nonnegative();

/** The body of a Voyage embeddings response, as far as this module reads it. */
const VoyageResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number().finite()).length(EMBED_DIMS), index: count })),
  usage: z.object({ total_tokens: count.optional() }).optional(),
});

/**
 * The response as vectors in the order of the texts: exactly one per text, with unique indices covering
 * 0..n-1. Anything else is an error, so a vector never lands on the wrong text.
 */
function parseVoyage(json: unknown, texts: number): EmbedResult {
  const body = VoyageResponse.safeParse(json);
  if (!body.success) throw new Error("voyage: unexpected response");
  const vectors: number[][] = new Array(texts);
  for (const d of body.data.data) {
    if (d.index >= texts || vectors[d.index]) throw new Error("voyage: vectors do not match the texts");
    vectors[d.index] = d.embedding;
  }
  if (body.data.data.length !== texts) throw new Error("voyage: vectors do not match the texts");
  return { vectors, tokens: body.data.usage?.total_tokens ?? 0 };
}

/** Voyage AI (https://docs.voyageai.com/reference/embeddings-api). Without a key in the environment: unused. */
export function voyageEmbedder(opts: { apiKey: string; model?: string; fetch?: typeof fetch }): Embedder {
  const model = opts.model ?? "voyage-4";
  const doFetch = opts.fetch ?? fetch;
  return {
    model,
    async embed(texts, kind) {
      const res = await doFetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: EMBED_DIMS }),
      });
      if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return parseVoyage(await res.json(), texts.length);
    },
  };
}
