// Bases (databases inside the workspace): tables, schema, rows, views, CSV import and export.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { BaseCsvExport, BaseImportResult, BaseQueryResult, BaseRowDetail } from "./shapes.ts";

export interface BaseQueryBody {
  viewId?: string;
  filter?: T.BaseFilter | null;
  sorts?: T.BaseSort[];
  groupBy?: { prop: string; hideEmpty?: boolean } | null;
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface BaseRowBody {
  props?: Record<string, unknown>;
  body?: string;
  /** Position: right after (or before) this row. */
  afterId?: string | null;
  beforeId?: string | null;
}

export const bases = {
  listBases: e("GET", "/api/v1/workspaces/:workspaceId/bases", s.field("bases", s.array(C.BaseSummary))),
  getBase: e("GET", "/api/v1/workspaces/:workspaceId/bases/:baseId", C.Base),
  createBase: e("POST", "/api/v1/workspaces/:workspaceId/bases", C.Base).body<{
    title: string;
    icon?: string;
    pageSlug?: string;
    linkedTableId?: string;
    titleName?: string;
  }>(),
  importBase: e("POST", "/api/v1/workspaces/:workspaceId/bases/import", C.Base).body<{
    title: string;
    csv: string;
  }>(),
  createBaseFromFile: e("POST", "/api/v1/workspaces/:workspaceId/bases/from-file", C.Base).body<{
    fileId: string;
  }>(),
  updateBase: e("PATCH", "/api/v1/workspaces/:workspaceId/bases/:baseId", C.Base).body<{
    title?: string;
    icon?: string | null;
  }>(),
  deleteBase: e("DELETE", "/api/v1/workspaces/:workspaceId/bases/:baseId", NOTHING),
  setBaseTableSchema: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/bases/:baseId/tables/:tableId/schema",
    C.BaseTable,
  ).body<{ defs: T.BasePropDef[]; parentVersion: number }>(),
  createBaseTableQuery: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/bases/:baseId/tables/:tableId/query",
    BaseQueryResult,
  ).body<BaseQueryBody>(),
  createBaseTableRow: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/bases/:baseId/tables/:tableId/rows",
    C.BaseRow,
  ).body<BaseRowBody>(),
  importBaseTable: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/bases/:baseId/tables/:tableId/import",
    BaseImportResult,
  ).body<{ csv: string }>(),
  exportBaseTable: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/bases/:baseId/tables/:tableId/export",
    BaseCsvExport,
  ).body<{ viewId?: string }>(),
  getBaseRow: e("GET", "/api/v1/workspaces/:workspaceId/bases/:baseId/rows/:rowId", BaseRowDetail),
  updateBaseRow: e("PATCH", "/api/v1/workspaces/:workspaceId/bases/:baseId/rows/:rowId", C.BaseRow).body<
    BaseRowBody & { parentVersion?: number }
  >(),
  deleteBaseRow: e("DELETE", "/api/v1/workspaces/:workspaceId/bases/:baseId/rows/:rowId", NOTHING),
  createBaseView: e("POST", "/api/v1/workspaces/:workspaceId/bases/:baseId/views", C.BaseView).body<{
    tableId: string;
    name: string;
    type: T.BaseViewType;
    config?: T.BaseViewConfig;
  }>(),
  updateBaseView: e("PATCH", "/api/v1/workspaces/:workspaceId/bases/:baseId/views/:viewId", C.BaseView).body<{
    name?: string;
    type?: T.BaseViewType;
    config?: T.BaseViewConfig;
    afterId?: string | null;
  }>(),
  deleteBaseView: e("DELETE", "/api/v1/workspaces/:workspaceId/bases/:baseId/views/:viewId", NOTHING),
};
