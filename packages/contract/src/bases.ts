// Bases: typed tables, views and formulas.

import type { ActorRef } from "./common.ts";

export type BasePropType =
  | "checkbox"
  | "created_time"
  | "creator"
  | "date"
  | "edited_time"
  | "editor"
  | "file"
  | "formula"
  | "multi_select"
  | "number"
  | "person"
  | "relation"
  | "rollup"
  | "select"
  | "status"
  | "text"
  | "url";

export type BaseRollupFn =
  | "average"
  | "checked"
  | "count"
  | "count_empty"
  | "count_not_empty"
  | "count_unique"
  | "count_values"
  | "date_range"
  | "earliest"
  | "latest"
  | "max"
  | "median"
  | "min"
  | "percent_checked"
  | "percent_empty"
  | "percent_not_empty"
  | "percent_unchecked"
  | "range"
  | "show_original"
  | "show_unique"
  | "sum"
  | "unchecked";

export interface BasePropOption {
  id: string;
  color?: string;
  name: string;
}

export type BaseFormulaResultType = "any" | "boolean" | "date" | "list" | "number" | "person" | "text";

export interface BasePropDef {
  id: string;
  formula?: { expression: string; resultType?: BaseFormulaResultType };
  groups?: { done: string[]; inProgress: string[]; todo: string[] };
  name: string;
  numberFormat?: "currency_brl" | "currency_usd" | "percent" | "plain";
  options?: BasePropOption[];
  /** relation: the source (`dbt_…`) of the linked rows; the value is the list of row ids (`dbr_…`). */
  relation?: { tableId: string };
  /** rollup: `fn` over the property `targetPropId` of the rows linked by the relation `relationPropId`. */
  rollup?: {
    fn: BaseRollupFn;
    relationPropId: string;
    resultType?: BaseFormulaResultType;
    targetPropId: string;
  };
  type: BasePropType;
  withTime?: boolean;
}

/** A source a relation points to, with its database (to look for rows and open them). */
export interface BaseRelationTarget {
  databaseId: string;
  databaseTitle: string;
  tableId: string;
  titlePropId: string;
}

/** A row of another source that shows in a relation cell. */
export interface BaseLinkedRow {
  databaseId: string;
  tableId: string;
  title: string;
}

export type BaseViewType =
  | "board"
  | "calendar"
  | "chart"
  | "form"
  | "gallery"
  | "list"
  | "table"
  | "timeline";

export type BaseRelativeDate =
  | "one_month_ago"
  | "one_month_from_now"
  | "one_week_ago"
  | "one_week_from_now"
  | "today"
  | "tomorrow"
  | "yesterday";

type DateValue = string | { rel: BaseRelativeDate };

export type BaseFilterValue =
  | string
  | number
  | boolean
  | string[]
  | [DateValue, DateValue]
  | { rel: BaseRelativeDate }
  | ActorRef
  | "me";

export interface BaseFilterCondition {
  op: string;
  prop: string;
  value?: BaseFilterValue;
}

export type BaseFilter = BaseFilterCondition | { and: BaseFilter[] } | { or: BaseFilter[] };

export interface BaseSort {
  dir: "asc" | "desc";
  prop: string;
}

export interface BaseViewConfig {
  cardSize?: "large" | "medium" | "small";
  chart?: {
    agg?: "avg" | "count" | "max" | "min" | "sum";
    kind: "bar" | "column" | "donut" | "line" | "number";
    x?: string | null;
    y?: string | null;
  } | null;
  columns?: { hidden?: boolean; prop: string; width?: number }[];
  cover?: string | null;
  dateProp?: string | null;
  endProp?: string | null;
  filter?: BaseFilter | null;
  formProps?: string[];
  frozen?: number;
  groupBy?: { hideEmpty?: boolean; prop: string } | null;
  openMode?: "center" | "full" | "side";
  quickFilters?: { op?: string; prop: string; value?: BaseFilterValue }[];
  sorts?: BaseSort[];
  summaries?: Record<string, string>;
  wrap?: boolean;
}

export interface BaseFormulaError {
  at: [number, number];
  code: string;
  detail?: Record<string, string | number>;
}

export interface BaseTable {
  id: string;
  databaseId: string;
  defs: BasePropDef[];
  /** Formula errors per property (the editor shows them; the cell shows the code). */
  formulaErrors: Record<string, BaseFormulaError[]>;
  name: string;
  /** Formula recalculation after a schema change: `done < version` = in progress. */
  recalc: { done: number; pending: boolean; version: number };
  schemaVersion: number;
  titlePropId: string;
}

export interface BaseView {
  id: string;
  config: BaseViewConfig;
  databaseId: string;
  name: string;
  position: string;
  tableId: string;
  type: BaseViewType;
}

export interface BaseSummary {
  id: string;
  createdBy: ActorRef;
  icon: string | null;
  kind: "database" | "linked";
  /** Wiki page where the database is embedded (the page keeps the block; the database keeps the link). */
  page: { slug: string; title: string } | null;
  rowCount: number;
  /** The database's own source; `null` for a linked database. */
  tableId: string | null;
  title: string;
  updatedAt: string;
}

export interface Base extends BaseSummary {
  deletable: boolean;
  /** The sources the relations of the sources below point to. */
  relationTargets: BaseRelationTarget[];
  /** The database's sources and, in the linked view, the sources of other databases the views show. */
  tables: BaseTable[];
  views: BaseView[];
}

export interface BaseRow {
  id: string;
  computed: Record<string, unknown>;
  createdAt: string;
  createdBy: ActorRef;
  databaseId: string;
  editedAt: string;
  editedBy: ActorRef;
  hasBody: boolean;
  position: string;
  props: Record<string, unknown>;
  tableId: string;
  version: number;
}

export interface BaseRowDetail extends BaseRow {
  body: string;
  /** Title and place of each row the relations link (the ones that exist). */
  linked: Record<string, BaseLinkedRow>;
}

export interface BaseQueryResult {
  groups?: { count: number; key: string | null }[];
  /** Title and place of each row the relations of the returned rows link (the ones that exist). */
  linked: Record<string, BaseLinkedRow>;
  nextCursor: string | null;
  rows: BaseRow[];
  total: number;
}

export type BaseSummaryFn = Exclude<BaseRollupFn, "show_original" | "show_unique">;

/** The footer's summaries: one per column, over the rows the filter keeps (not only the page shown). */
export interface BaseSummariesInput {
  filter?: BaseFilter | null;
  /** Search in the title, as in the query. */
  search?: string;
  /** One summary per column (property id → function); without it, the view's. */
  summaries?: Record<string, BaseSummaryFn>;
  /** Uses the view's filter (with its quick filters) and summaries; the fields here replace them. */
  viewId?: string;
  /** A narrowing ANDed to the filter, checked on its own: the calendar's and the timeline's window. */
  within?: BaseFilter | null;
}

export interface BaseSummariesResult {
  /** Per property: a number, a date as `{ start }` (`{ start, end }` for the range) or `null`. */
  values: Record<string, unknown>;
}

export type BaseChartAgg = "avg" | "count" | "max" | "min" | "sum";

/** The chart: the filter's rows grouped by `x`, counted or with `agg` over the number column `y`. */
export interface BaseAggregateInput {
  agg?: BaseChartAgg;
  filter?: BaseFilter | null;
  search?: string;
  /** Uses the view's filter and chart; the fields here replace them. */
  viewId?: string;
  within?: BaseFilter | null;
  x?: string | null;
  y?: string | null;
}

export interface BaseAggregateResult {
  /** In the grid's group order; without `x`, one group with the `null` key. Up to 100. */
  groups: { key: string | null; value: number | null }[];
  total: number;
}

/** One row of the grid's bulk write (a paste, the fill handle, clearing a range). */
export interface BaseBulkOp {
  /** The row version read: a different one answers 409 and nothing of the bulk write stays. */
  parentVersion?: number;
  /** Values in the column's type. */
  props?: Record<string, unknown>;
  /** Without it: a new row at the end. */
  rowId?: string;
  /** Pasted text, converted by the column's type as in the CSV; empty clears the cell. */
  text?: Record<string, string>;
}

export interface BaseBulkResult {
  /** The rows written, in the order of the ops. */
  rows: BaseRow[];
  /** Text cells that didn't fit the type or fell on a computed column. */
  skipped: number;
}
