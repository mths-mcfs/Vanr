// Price table versioned by date (USD per million tokens). A new price comes in as a new row with the date
// it takes effect; the old row stays, and the ledger keeps the version used for each call, so the past
// can be recomputed. Reference: Anthropic's pricing page (October 2026).
//
// Cache: a 5 min write = 1.25x the input, a 1 h write = 2x; a read = `cacheRead`. Batch: half. Fast mode
// (Opus 5.5): 2x. US-only inference (`inference_geo: us`): 1.1x.
import { type DatedPrice, datedPriceBook, type PriceBook, type TokenPrice } from "../usage";

const tokens = (input: number, output: number, cacheRead: number): TokenPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

/** Date of the first version: applies to every call before the next row of the same model. */
const FIRST = "2026-01-01";

export const PRICE_TABLE: readonly DatedPrice[] = [
  {
    model: "claude-haiku-5-5",
    from: FIRST,
    price: {
      ...tokens(0.1, 0.5, 0.01),
      longPrompt: { above: 100_000, price: tokens(0.5, 2.5, 0.05) },
      usGeo: 1.1,
    },
  },
  { model: "claude-sonnet-5-5", from: FIRST, price: { ...tokens(2, 10, 0.2), usGeo: 1.1 } },
  { model: "claude-opus-5-5", from: FIRST, price: { ...tokens(4, 20, 0.2), fast: 2, usGeo: 1.1 } },
  // Search embeddings (Voyage): input only. https://www.mongodb.com/docs/voyageai/management/billing/
  { model: "voyage-4", from: FIRST, price: tokens(0.06, 0, 0) },
];

export const PRICES: PriceBook = datedPriceBook(PRICE_TABLE);
