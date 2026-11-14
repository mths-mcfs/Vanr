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
  | "select"
  | "status"
  | "text"
  | "url";

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
  type: BasePropType;
  withTime?: boolean;
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
  title: string;
  updatedAt: string;
}

export interface Base extends BaseSummary {
  deletable: boolean;
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
