// The bases routes over raw HTTP, with the shape the origin's typed client had (`api.bases.*`), for the bases
// tests. The typed client comes with the client package; until then each call is a real request through the
// browser's session, and a rejected one throws `ApiError` with the status and the code of the envelope.
import type {
  Base,
  BasePropDef,
  BaseRow,
  BaseSummary,
  BaseTable,
  BaseView,
  BaseViewType,
} from "@vanr/contract";
import { type Filter, rowMatches } from "@vanr/engine/bases/view";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { queryRows } from "../src/bases/query";
import { importRows } from "../src/bases/write";
import { HttpError } from "../src/http";
import type { RunningServer } from "../src/server";
import { type Browser, body } from "./harness";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** The status and the code of a call that must fail: a route's answer, or a domain call's `HttpError`. */
export async function apiError(call: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ApiError || err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("the call should have failed");
}

export interface RowPage {
  rows: BaseRow[];
  total: number;
  nextCursor: string | null;
  groups?: { key: string | null; count: number }[];
}

export interface QueryInput {
  viewId?: string;
  filter?: unknown;
  sorts?: { prop: string; dir: "asc" | "desc" }[];
  groupBy?: { prop: string; hideEmpty?: boolean } | null;
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface RowInput {
  props?: Record<string, unknown>;
  body?: string;
  afterId?: string | null;
  beforeId?: string | null;
}

export function basesApi(browser: Browser) {
  const call = async (method: string, path: string, input?: unknown) => {
    const res = await browser.json(path, method, input);
    if (res.status === 204) return null;
    const data = await body(res);
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `http_${res.status}`);
    return data;
  };
  const B = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/bases`;
  return {
    list: (ws: string): Promise<{ bases: BaseSummary[] }> => call("GET", B(ws)),
    create: (
      ws: string,
      input: {
        title: string;
        icon?: string | null;
        pageSlug?: string;
        linkedTableId?: string;
        titleName?: string;
      },
    ): Promise<Base> => call("POST", B(ws), input),
    get: (ws: string, id: string): Promise<Base> => call("GET", `${B(ws)}/${encodeURIComponent(id)}`),
    update: (ws: string, id: string, input: { title?: string; icon?: string | null }): Promise<Base> =>
      call("PATCH", `${B(ws)}/${id}`, input),
    remove: (ws: string, id: string): Promise<null> => call("DELETE", `${B(ws)}/${id}`),
    saveSchema: (
      ws: string,
      id: string,
      tableId: string,
      input: { defs: BasePropDef[]; parentVersion: number },
    ): Promise<BaseTable> => call("PUT", `${B(ws)}/${id}/tables/${tableId}/schema`, input),
    query: (ws: string, id: string, tableId: string, input: QueryInput = {}): Promise<RowPage> =>
      call("POST", `${B(ws)}/${id}/tables/${tableId}/query`, input),
    createRow: (ws: string, id: string, tableId: string, input: RowInput): Promise<BaseRow> =>
      call("POST", `${B(ws)}/${id}/tables/${tableId}/rows`, input),
    getRow: (ws: string, id: string, rowId: string): Promise<BaseRow & { body: string }> =>
      call("GET", `${B(ws)}/${id}/rows/${rowId}`),
    updateRow: (
      ws: string,
      id: string,
      rowId: string,
      input: RowInput & { parentVersion?: number },
    ): Promise<BaseRow> => call("PATCH", `${B(ws)}/${id}/rows/${rowId}`, input),
    deleteRow: (ws: string, id: string, rowId: string): Promise<null> =>
      call("DELETE", `${B(ws)}/${id}/rows/${rowId}`),
    createView: (
      ws: string,
      id: string,
      input: { tableId: string; name: string; type: BaseViewType; config?: unknown },
    ): Promise<BaseView> => call("POST", `${B(ws)}/${id}/views`, input),
    updateView: (
      ws: string,
      id: string,
      viewId: string,
      input: { name?: string; type?: BaseViewType; config?: unknown; afterId?: string | null },
    ): Promise<BaseView> => call("PATCH", `${B(ws)}/${id}/views/${viewId}`, input),
    deleteView: (ws: string, id: string, viewId: string): Promise<null> =>
      call("DELETE", `${B(ws)}/${id}/views/${viewId}`),
    importCsv: (
      ws: string,
      id: string,
      tableId: string,
      input: { csv: string },
    ): Promise<{ created: number; skipped: number; addedProps: string[]; table: BaseTable }> =>
      call("POST", `${B(ws)}/${id}/tables/${tableId}/import`, input),
    createFromCsv: (ws: string, input: { title: string; csv: string }): Promise<Base> =>
      call("POST", `${B(ws)}/import`, input),
    exportCsv: (
      ws: string,
      id: string,
      tableId: string,
      input: { viewId?: string } = {},
    ): Promise<{ fileName: string; csv: string }> =>
      call("POST", `${B(ws)}/${id}/tables/${tableId}/export`, input),
    fromFile: (ws: string, fileId: string): Promise<Base> => call("POST", `${B(ws)}/from-file`, { fileId }),
  };
}

export type BasesApi = ReturnType<typeof basesApi>;

/** A schema with one property of each type (the ids come from the server after saving). */
export function allTypes(titleId: string): BasePropDef[] {
  return [
    { id: titleId, name: "Name", type: "text" },
    { id: "p_num", name: "Amount", type: "number" },
    {
      id: "p_sel",
      name: "Stage",
      type: "select",
      options: [
        { id: "o_a", name: "Alpha" },
        { id: "o_b", name: "Beta" },
      ],
    },
    {
      id: "p_multi",
      name: "Tags",
      type: "multi_select",
      options: [
        { id: "t_x", name: "x" },
        { id: "t_y", name: "y" },
      ],
    },
    {
      id: "p_status",
      name: "Status",
      type: "status",
      options: [
        { id: "s_todo", name: "To do" },
        { id: "s_doing", name: "Doing" },
        { id: "s_done", name: "Done" },
      ],
      groups: { todo: ["s_todo"], inProgress: ["s_doing"], done: ["s_done"] },
    },
    { id: "p_due", name: "Due", type: "date" },
    { id: "p_ok", name: "Ok", type: "checkbox" },
    { id: "p_who", name: "Owner", type: "person" },
    { id: "p_url", name: "Site", type: "url" },
    { id: "p_file", name: "Attachments", type: "file" },
    { id: "p_ct", name: "Created at", type: "created_time" },
    { id: "p_cb", name: "Created by", type: "creator" },
    { id: "p_et", name: "Edited at", type: "edited_time" },
    { id: "p_eb", name: "Edited by", type: "editor" },
    { id: "p_f", name: "Double", type: "formula", formula: { expression: 'prop("Amount") * 2' } },
  ];
}

export async function baseWithTypes(api: BasesApi, workspaceId: string, title = "Projects") {
  const base = await api.create(workspaceId, { title });
  const table = base.tables[0];
  if (!table) throw new Error("no table");
  const saved = await api.saveSchema(workspaceId, base.id, table.id, {
    defs: allTypes(table.titlePropId),
    parentVersion: table.schemaVersion,
  });
  return { base, table: saved };
}

/** Random filters: the SQL has to return the same rows as the `rowMatches` oracle. */
export async function fuzzAgainstOracle(
  srv: RunningServer,
  ana: { api: BasesApi; user: { id: string } },
  workspaceId: string,
  iterations: number,
  now: number,
): Promise<number> {
  const { table } = await baseWithTypes(ana.api, workspaceId, "Fuzz");
  const [fresh] = await srv.deps.db.select().from(schema.dbTables).where(eq(schema.dbTables.id, table.id));
  if (!fresh) throw new Error("no table");
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const words = ["", "Ana", "ana", "ÁRVORE", "árvore", "x%y", "a_b", "Ção", "zeta", "maçã"];
  const days = ["2026-10-01", "2026-10-21", "2026-10-22", "2026-10-23", "2026-11-22", "2025-01-01"];
  const me = { type: "person" as const, id: ana.user.id };
  const rows = Array.from({ length: 120 }, () => {
    const props: Record<string, unknown> = {};
    if (rnd() < 0.9) props[fresh.titlePropId] = pick(words);
    if (rnd() < 0.8) props.p_num = pick([-1, 0, 0.5, 2, 10, 1e6]);
    if (rnd() < 0.7) props.p_sel = pick(["o_a", "o_b"]);
    if (rnd() < 0.7) props.p_multi = pick([[], ["t_x"], ["t_y"], ["t_x", "t_y"]]);
    if (rnd() < 0.7) props.p_status = pick(["s_todo", "s_doing", "s_done"]);
    if (rnd() < 0.7) props.p_due = { start: pick(days) };
    if (rnd() < 0.7) props.p_ok = rnd() < 0.5;
    if (rnd() < 0.5) props.p_who = pick([[], [me]]);
    return { props: props as never };
  });
  await importRows(srv.deps, fresh, { defs: null, rows: () => rows.map((r) => r.props), actor: me });
  const stored = await srv.deps.db.select().from(schema.dbRows).where(eq(schema.dbRows.tableId, fresh.id));
  const condition = (): Filter => {
    const def = pick(fresh.defs.filter((d) => !["p_url", "p_file"].includes(d.id)));
    const ops: Record<string, readonly [string, () => unknown][]> = {
      text: [
        ["eq", () => pick(words)],
        ["neq", () => pick(words)],
        ["contains", () => pick(["a", "Á", "ár", "%", "_", "ção", "MAÇ"])],
        ["not_contains", () => pick(["a", "x%", "ÇÃO"])],
        ["starts_with", () => pick(["a", "Á", "z"])],
        ["ends_with", () => pick(["a", "E", "ã"])],
        ["empty", () => undefined],
        ["not_empty", () => undefined],
      ],
      number: [
        ["eq", () => pick([0, 2, 4])],
        ["neq", () => pick([0, 2])],
        ["gt", () => pick([0, 1, 1e6])],
        ["gte", () => pick([0.5, 2])],
        ["lt", () => pick([0, 10])],
        ["lte", () => pick([-1, 20])],
        ["empty", () => undefined],
      ],
      option: [
        ["eq", () => pick(["o_a", "o_b"])],
        ["neq", () => "o_a"],
        ["in", () => pick([["o_a"], ["o_a", "o_b"], []])],
        ["not_in", () => pick([["o_b"], []])],
        ["empty", () => undefined],
      ],
      status: [
        ["eq", () => "s_done"],
        ["group", () => pick(["todo", "inProgress", "done"])],
        ["not_in", () => ["s_todo"]],
      ],
      multi: [
        ["has", () => pick(["t_x", "t_y"])],
        ["has_not", () => "t_x"],
        ["has_any", () => pick([["t_x"], ["t_x", "t_y"], []])],
        ["has_all", () => pick([["t_x", "t_y"], []])],
        ["empty", () => undefined],
        ["not_empty", () => undefined],
      ],
      person: [
        ["has", () => pick(["me", me])],
        ["has_not", () => "me"],
        ["empty", () => undefined],
      ],
      date: [
        ["eq", () => pick([...days, { rel: "today" }])],
        ["before", () => pick([{ rel: "tomorrow" }, "2026-10-22"])],
        ["after", () => pick([{ rel: "one_week_ago" }, "2026-10-22"])],
        ["on_or_before", () => "2026-10-23"],
        [
          "on_or_after",
          () => {
            return { rel: "yesterday" };
          },
        ],
        ["between", () => ["2026-10-01", { rel: "one_month_from_now" }]],
        ["empty", () => undefined],
      ],
      checkbox: [["eq", () => rnd() < 0.5]],
    };
    const kind = {
      text: "text",
      number: "number",
      select: "option",
      status: "status",
      multi_select: "multi",
      person: "person",
      creator: "person",
      editor: "person",
      date: "date",
      created_time: "date",
      edited_time: "date",
      checkbox: "checkbox",
      formula: "number",
    }[def.type as string] as string;
    const [op, value] = pick(ops[kind] ?? ops.text ?? []);
    const v = value();
    return { prop: def.id, op, ...(v === undefined ? {} : { value: v }) } as Filter;
  };
  const filter = (depth: number): Filter => {
    if (depth >= 2 || rnd() < 0.5) return condition();
    const parts = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => filter(depth + 1));
    return rnd() < 0.5 ? { and: parts } : { or: parts };
  };
  let checked = 0;
  for (let i = 0; i < iterations; i++) {
    const f = filter(0);
    const page = await queryRows(srv.deps.db, fresh, { filter: f, limit: 500 }, { now, me });
    const got = page.rows.map((r) => r.id).sort();
    const want = stored
      .filter((r) =>
        rowMatches(
          f,
          fresh.defs,
          {
            props: r.props,
            computed: r.computed,
            createdAt: r.createdAt.toISOString(),
            editedAt: r.editedAt.toISOString(),
            createdBy: r.createdBy,
            editedBy: r.editedBy,
          },
          { now, me },
        ),
      )
      .map((r) => r.id)
      .sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`SQL ≠ oracle for ${JSON.stringify(f)}: ${got.length} vs ${want.length}`);
    }
    checked += got.length;
  }
  return checked;
}
