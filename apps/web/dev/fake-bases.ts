// Bases for the fake server: tables with their schema, views and rows, relations and two rollups (count
// and sum, worked out when a row is read), searches by title, and the version checks that give a
// conflict. Changes announce themselves on the workspace's socket. Never part of the production build.
import type * as T from "@vanr/contract";
import type { FilesHost, FilesReply } from "./fake-files.ts";

type FakeRow = Omit<T.BaseRow, "computed"> & { body: string };
export type FakeBase = {
  workspaceId: string;
  id: string;
  title: string;
  createdBy: T.ActorRef;
  updatedAt: string;
  table: T.BaseTable;
  views: T.BaseView[];
  rows: FakeRow[];
};

const reply = (status: number, body: unknown): FilesReply => ({ status, body });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const notFound = () => fail(404, "not_found", "Not found");
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const record = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** One condition on a row, for the few operators the tests use. */
function matches(condition: { prop: string; op?: string; value?: unknown }, row: FakeRow): boolean {
  const value = row.props[condition.prop];
  const empty =
    value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  switch (condition.op ?? "eq") {
    case "empty":
      return empty;
    case "not_empty":
      return !empty;
    case "neq":
      return value !== condition.value;
    case "contains":
      return typeof value === "string" && value.toLowerCase().includes(String(condition.value).toLowerCase());
    case "gt":
      return typeof value === "number" && value > Number(condition.value);
    case "lt":
      return typeof value === "number" && value < Number(condition.value);
    case "gte":
      return typeof value === "number" && value >= Number(condition.value);
    case "lte":
      return typeof value === "number" && value <= Number(condition.value);
    case "has":
      return Array.isArray(value) && value.includes(condition.value);
    default:
      return value === condition.value;
  }
}

/** A filter on a row: a condition, or groups of them joined by "and" or "or", nested as deep as given. */
function matchesFilter(filter: T.BaseFilter | null | undefined, row: FakeRow): boolean {
  if (filter === null || filter === undefined) return true;
  if ("and" in filter) return filter.and.every((each) => matchesFilter(each, row));
  if ("or" in filter) return filter.or.some((each) => matchesFilter(each, row));
  return matches(filter, row);
}

/** A view's saved filter and its quick filters, joined with "and", as the server reads a view. */
function matchesView(config: T.BaseViewConfig, row: FakeRow): boolean {
  return (config.quickFilters ?? []).every((each) => matches(each, row)) && matchesFilter(config.filter, row);
}

export class FakeBases {
  bases: FakeBase[] = [];
  private counter = 0;

  constructor(private readonly host: FilesHost) {}

  private nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}_${this.counter.toString(36).padStart(4, "0")}`;
  }

  /** A base with a title property and one grid view. */
  make(workspaceId: string, title: string, createdBy: T.ActorRef, extra: T.BasePropDef[] = []): FakeBase {
    const id = this.nextId("db");
    const tableId = `${id}_t`;
    const titlePropId = `${id}_title`;
    const base: FakeBase = {
      workspaceId,
      id,
      title,
      createdBy,
      updatedAt: this.host.now().toISOString(),
      table: {
        id: tableId,
        databaseId: id,
        name: title,
        titlePropId,
        schemaVersion: 1,
        defs: [{ id: titlePropId, name: "Name", type: "text" }, ...extra],
        formulaErrors: {},
        recalc: { done: 0, pending: false, version: 0 },
      },
      views: [
        { id: `${id}_v1`, databaseId: id, tableId, name: "Grid", type: "table", position: "a", config: {} },
      ],
      rows: [],
    };
    this.bases.push(base);
    return base;
  }

  row(base: FakeBase, props: Record<string, unknown>, by: T.ActorRef): FakeRow {
    const now = this.host.now().toISOString();
    const row: FakeRow = {
      id: this.nextId("dbr"),
      databaseId: base.id,
      tableId: base.table.id,
      position: String(base.rows.length).padStart(4, "0"),
      props,
      createdAt: now,
      createdBy: by,
      editedAt: now,
      editedBy: by,
      hasBody: false,
      version: 1,
      body: "",
    };
    base.rows.push(row);
    return row;
  }

  /** Tasks (a status and hours) and Projects, whose Tasks relation sums their hours. */
  seed(): void {
    this.bases = [];
    const ana: T.ActorRef = { type: "person", id: "usr_ana" };
    const status: T.BasePropDef = {
      id: "status",
      name: "Status",
      type: "status",
      options: [
        { id: "todo", name: "To do" },
        { id: "doing", name: "Doing" },
        { id: "done", name: "Done" },
      ],
      groups: { todo: ["todo"], inProgress: ["doing"], done: ["done"] },
    };
    const tasks = this.make("workspace_birchwood", "Tasks", ana, [
      status,
      { id: "hours", name: "Hours", type: "number" },
    ]);
    const wash = this.row(tasks, { [tasks.table.titlePropId]: "Wash", status: "todo", hours: 2 }, ana);
    const dry = this.row(tasks, { [tasks.table.titlePropId]: "Dry", status: "done", hours: 3 }, ana);
    const projects = this.make("workspace_birchwood", "Projects", ana, [
      { id: "tasks", name: "Tasks", type: "relation", relation: { tableId: tasks.table.id } },
      {
        id: "total",
        name: "Total hours",
        type: "rollup",
        rollup: { relationPropId: "tasks", targetPropId: "hours", fn: "sum", resultType: "number" },
      },
    ]);
    this.row(projects, { [projects.table.titlePropId]: "Home", tasks: [wash.id, dry.id] }, ana);
  }

  private find(workspaceId: string, id: unknown) {
    return this.bases.find((base) => base.workspaceId === workspaceId && base.id === id);
  }

  private rowById(id: string) {
    for (const base of this.bases) {
      const row = base.rows.find((each) => each.id === id);
      if (row !== undefined) return { base, row };
    }
    return undefined;
  }

  private computed(base: FakeBase, row: FakeRow): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const def of base.table.defs) {
      if (def.type !== "rollup" || def.rollup === undefined) continue;
      const ids = row.props[def.rollup.relationPropId];
      const linked = (Array.isArray(ids) ? ids : []).flatMap((id) => {
        const found = this.rowById(String(id));
        return found === undefined ? [] : [found.row];
      });
      const target = def.rollup.targetPropId;
      out[def.id] =
        def.rollup.fn === "count"
          ? linked.length
          : def.rollup.fn === "sum"
            ? linked.reduce(
                (sum, each) =>
                  sum + (typeof each.props[target] === "number" ? (each.props[target] as number) : 0),
                0,
              )
            : null;
    }
    return out;
  }

  private shown(base: FakeBase, row: FakeRow): T.BaseRow {
    const { body: _body, ...rest } = row;
    return { ...rest, computed: this.computed(base, row) };
  }

  private linked(rows: FakeRow[], base: FakeBase): Record<string, T.BaseLinkedRow> {
    const out: Record<string, T.BaseLinkedRow> = {};
    for (const def of base.table.defs.filter((each) => each.type === "relation")) {
      for (const row of rows) {
        const ids = row.props[def.id];
        for (const id of Array.isArray(ids) ? ids : []) {
          const found = this.rowById(String(id));
          if (found === undefined) continue;
          const title = found.row.props[found.base.table.titlePropId];
          out[String(id)] = {
            databaseId: found.base.id,
            tableId: found.base.table.id,
            title: typeof title === "string" ? title : "",
          };
        }
      }
    }
    return out;
  }

  private summary(base: FakeBase): T.BaseSummary {
    return {
      id: base.id,
      createdBy: base.createdBy,
      icon: null,
      kind: "database",
      page: null,
      rowCount: base.rows.length,
      tableId: base.table.id,
      title: base.title,
      updatedAt: base.updatedAt,
    };
  }

  private detail(base: FakeBase): T.Base {
    const relationTargets = base.table.defs.flatMap((def) => {
      const target = this.bases.find((each) => each.table.id === def.relation?.tableId);
      return target === undefined
        ? []
        : [
            {
              databaseId: target.id,
              databaseTitle: target.title,
              tableId: target.table.id,
              titlePropId: target.table.titlePropId,
            },
          ];
    });
    return {
      ...this.summary(base),
      deletable: true,
      relationTargets,
      tables: [base.table],
      views: base.views,
    };
  }

  private touched(base: FakeBase, type = "base.updated") {
    base.updatedAt = this.host.now().toISOString();
    this.host.emit(base.workspaceId, { type, baseId: base.id });
  }

  operations(): Record<string, (params: Record<string, unknown>, session: string | undefined) => FilesReply> {
    const within =
      (
        handler: (
          scope: { workspaceId: string; user: T.User },
          params: Record<string, unknown>,
        ) => FilesReply,
      ) =>
      (params: Record<string, unknown>, session: string | undefined) => {
        const scope = this.host.scope(params, session);
        return "status" in scope ? scope : handler(scope, params);
      };
    const inBase = (handler: (base: FakeBase, params: Record<string, unknown>, user: T.User) => FilesReply) =>
      within((scope, params) => {
        const base = this.find(scope.workspaceId, params.baseId);
        return base === undefined ? notFound() : handler(base, params, scope.user);
      });
    const me = (user: T.User): T.ActorRef => ({ type: "person", id: user.id });
    return {
      listBases: within((scope) =>
        reply(200, {
          bases: this.bases
            .filter((base) => base.workspaceId === scope.workspaceId)
            .map((base) => this.summary(base)),
        }),
      ),
      getBase: inBase((base) => reply(200, this.detail(base))),
      createBase: within((scope, params) => {
        const title = text(params.title)?.trim();
        if (title === undefined || title === "") return fail(400, "invalid_request", "Invalid body");
        const base = this.make(scope.workspaceId, title, { type: "person", id: scope.user.id });
        this.host.emit(scope.workspaceId, { type: "base.created", baseId: base.id });
        return reply(201, this.detail(base));
      }),
      updateBase: inBase((base, params) => {
        const title = text(params.title)?.trim();
        if (title !== undefined && title !== "") base.title = title;
        this.touched(base);
        return reply(200, this.detail(base));
      }),
      deleteBase: inBase((base) => {
        this.bases = this.bases.filter((each) => each !== base);
        this.host.emit(base.workspaceId, { type: "base.deleted", baseId: base.id });
        return reply(204, null);
      }),
      setBaseTableSchema: inBase((base, params) => {
        if (params.parentVersion !== base.table.schemaVersion)
          return fail(409, "base.schema_conflict", "Changed first");
        const defs = Array.isArray(params.defs) ? (params.defs as T.BasePropDef[]) : [];
        if (defs.find((def) => def.id === base.table.titlePropId)?.type !== "text") {
          return fail(400, "base.title_required", "The title stays text");
        }
        base.table = {
          ...base.table,
          defs: defs.map((def) =>
            def.type === "rollup" && def.rollup !== undefined
              ? { ...def, rollup: { ...def.rollup, resultType: "number" } }
              : def,
          ),
          schemaVersion: base.table.schemaVersion + 1,
        };
        this.touched(base);
        return reply(200, base.table);
      }),
      createBaseTableQuery: inBase((base, params) => {
        const search = text(params.search)?.toLowerCase();
        const view = base.views.find((each) => each.id === params.viewId);
        const rows = base.rows.filter((row) => {
          const title = row.props[base.table.titlePropId];
          const found =
            search === undefined || (typeof title === "string" && title.toLowerCase().includes(search));
          // The filter sent with the query wins over the view's, as on the server.
          const kept =
            params.filter !== undefined
              ? matchesFilter(params.filter as T.BaseFilter | null, row)
              : view === undefined || matchesView(view.config, row);
          return found && kept;
        });
        return reply(200, {
          rows: rows.map((row) => this.shown(base, row)),
          total: rows.length,
          nextCursor: null,
          linked: this.linked(rows, base),
        });
      }),
      createBaseTableRow: inBase((base, params, user) => {
        const row = this.row(base, record(params.props) ?? {}, me(user));
        this.touched(base, "base.rows");
        return reply(201, this.shown(base, row));
      }),
      getBaseRow: inBase((base, params) => {
        const row = base.rows.find((each) => each.id === params.rowId);
        if (row === undefined) return notFound();
        return reply(200, { ...this.shown(base, row), body: row.body, linked: this.linked([row], base) });
      }),
      updateBaseRow: inBase((base, params, user) => {
        const row = base.rows.find((each) => each.id === params.rowId);
        if (row === undefined) return notFound();
        if (params.parentVersion !== undefined && params.parentVersion !== row.version) {
          return fail(409, "base.row_conflict", "Changed first");
        }
        row.props = { ...row.props, ...(record(params.props) ?? {}) };
        if (typeof params.body === "string") {
          row.body = params.body;
          row.hasBody = params.body !== "";
        }
        row.version += 1;
        row.editedAt = this.host.now().toISOString();
        row.editedBy = me(user);
        this.host.emit(base.workspaceId, { type: "base.rows", baseId: base.id, tableId: base.table.id });
        return reply(200, this.shown(base, row));
      }),
      deleteBaseRow: inBase((base, params) => {
        base.rows = base.rows.filter((each) => each.id !== params.rowId);
        this.touched(base, "base.rows");
        return reply(204, null);
      }),
      createBaseView: inBase((base, params) => {
        const view: T.BaseView = {
          id: this.nextId("dbv"),
          databaseId: base.id,
          tableId: base.table.id,
          name: text(params.name) ?? "View",
          type: (text(params.type) ?? "table") as T.BaseViewType,
          position: String(base.views.length),
          config: (record(params.config) ?? {}) as T.BaseViewConfig,
        };
        base.views.push(view);
        this.touched(base);
        return reply(201, view);
      }),
      updateBaseView: inBase((base, params) => {
        const view = base.views.find((each) => each.id === params.viewId);
        if (view === undefined) return notFound();
        if (params.config !== undefined) view.config = params.config as T.BaseViewConfig;
        if (typeof params.name === "string") view.name = params.name;
        this.touched(base);
        return reply(200, view);
      }),
      deleteBaseView: inBase((base, params) => {
        if (base.views.length <= 1) return fail(409, "base.last_view", "Keep one view");
        base.views = base.views.filter((each) => each.id !== params.viewId);
        this.touched(base);
        return reply(204, null);
      }),
      exportBaseTable: inBase((base) =>
        reply(200, {
          fileName: `${base.title}.csv`,
          csv: ["Name", ...base.rows.map((row) => String(row.props[base.table.titlePropId] ?? ""))].join(
            "\n",
          ),
        }),
      ),
    };
  }
}
