// The per-column summary (the grid's footer) and the chart's sums. The summary's functions are the rollup's,
// over the rows of the view instead of the linked rows: the server computes them in SQL, and `rollupValue`
// is the test's oracle. Each family of property offers only what makes sense for it.
import type { PropDef, RollupFn } from "../props";
import { filterKind } from "./view";

export type SummaryFn = Exclude<RollupFn, "show_original" | "show_unique">;

const COUNTS: readonly SummaryFn[] = [
  "count",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
];
const NUMBERS: readonly SummaryFn[] = ["sum", "average", "median", "min", "max", "range"];
const DATES: readonly SummaryFn[] = ["earliest", "latest", "date_range"];
const CHECKS: readonly SummaryFn[] = [
  "count",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
];

/** The summaries the footer offers for the property. */
export function summaryFns(def: PropDef): readonly SummaryFn[] {
  switch (filterKind(def)) {
    case "number":
      return [...COUNTS, ...NUMBERS];
    case "date":
      return [...COUNTS, ...DATES];
    case "checkbox":
      return CHECKS;
    default:
      return COUNTS;
  }
}

/** The chart's sums: how many rows, or the sum, average, minimum and maximum of a number column. */
export const CHART_AGGS = ["count", "sum", "avg", "min", "max"] as const;
export type ChartAgg = (typeof CHART_AGGS)[number];
