// A base: its title, the tabs of its views, what the open view shows (filter, sort, group, visible
// properties), its rows in the view's shape and the row open beside it (`?row=`). A change to a view
// shows at once and is then saved for everyone; a change to the properties saves the table's schema.
import { useQueryClient } from "@tanstack/react-query";
import { queryKey, useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type {
  Base as BaseData,
  BasePropDef,
  BaseTable,
  BaseView,
  BaseViewConfig,
  BaseViewType,
} from "@vanr/contract";
import { Button, ConfirmDialog, EmptyState, Icon, Input, useToast } from "@vanr/ui";
import { Download, Plus, Upload } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { TITLE_MAX, useActorName, useRefetch } from "../shared.tsx";
import { downloadText, useRows, useSaveRow } from "./data.ts";
import { type CellContext, flatFilter, viewName } from "./model.ts";
import { PropertyDialog } from "./PropertyDialog.tsx";
import { RowPanel } from "./Row.tsx";
import { type Panel, QuickFilters, ViewPanel } from "./toolbar.tsx";
import { BoardView, GalleryView, ListView, TableView, type ViewProps } from "./views.tsx";

const VIEW_TYPES: readonly BaseViewType[] = ["table", "board", "list", "gallery"];
const BaseAddress = z.object({ view: z.string().min(1).optional(), row: z.string().min(1).optional() });
type BaseAddress = z.infer<typeof BaseAddress>;
const EMPTY: BaseAddress = {};

export function BaseScreen() {
  const t = useMessages("files");
  const { workspaceId, baseId } = useRouteParams("base");
  const address = useSearch(BaseAddress, EMPTY);
  const base = useApiQuery("getBase", { workspaceId, baseId });
  useDocumentTitle(base.data?.title ?? t("bases.title"));
  if (base.isPending) return <ScreenLoading />;
  if (base.isError) {
    return (
      <>
        <h1 className="vr-visually-hidden">{t("bases.title")}</h1>
        <ScreenError
          title={t("base.failed")}
          error={base.error}
          onRetry={() => void base.refetch()}
          namespace="files"
        />
      </>
    );
  }
  const view = base.data.views.find((each) => each.id === address.view) ?? base.data.views[0];
  const table = base.data.tables.find((each) => each.id === view?.tableId);
  if (view === undefined || table === undefined) {
    return (
      <div className="page">
        <p className="page__muted">{t("base.noTable")}</p>
      </div>
    );
  }
  return <Loaded workspaceId={workspaceId} base={base.data} view={view} table={table} address={address} />;
}

function Loaded({
  workspaceId,
  base,
  view,
  table,
  address,
}: {
  workspaceId: string;
  base: BaseData;
  view: BaseView;
  table: BaseTable;
  address: BaseAddress;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const { locale } = useLocale();
  const client = useVanrClient();
  const queries = useQueryClient();
  const refetch = useRefetch();
  const go = useGo();
  const describe = useErrorMessage("files");
  const names = useActorName(workspaceId);
  const files = useApiQuery("listFiles", { workspaceId });
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim());
  const rows = useRows(workspaceId, base, table, view, search);
  const saveRow = useSaveRow(workspaceId, base.id);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [editing, setEditing] = useState<BasePropDef | "new" | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const writes = useRef(0);
  const viewWrites = useRef<Promise<unknown>>(Promise.resolve());
  // Each opening of the property dialog: a save that answers after it closed or another opened
  // doesn't close or mark the newer one.
  const opening = useRef(0);
  const toast = useToast();
  const baseKey = queryKey(client, "getBase", { workspaceId, baseId: base.id });
  const rowsPrefix = { method: "createBaseTableQuery" as const, args: { workspaceId, tableId: table.id } };
  const open = (next: BaseAddress) =>
    void go("base", { workspaceId, baseId: base.id }, { search: { view: next.view, row: next.row } });

  const all = rows.data?.pages.flatMap((page) => page.rows) ?? [];
  const first = rows.data?.pages[0];
  const linked = useMemo(
    () => Object.assign({}, ...(rows.data?.pages ?? []).map((page) => page.linked ?? {})),
    [rows.data],
  );
  const fileTitles = new Map((files.data ?? []).map((file) => [file.id, file.title]));
  const context: CellContext = { names, locale, files: (id) => fileTitles.get(id) ?? id, linked };
  const conditions =
    flatFilter(view.config.filter).conditions.length + (view.config.quickFilters?.length ?? 0);
  const filtered = conditions > 0 || search !== "";

  const setConfig = (config: BaseViewConfig) => {
    // A refresh of the base already on its way would bring back the old setting: it is dropped.
    void queries.cancelQueries({ queryKey: baseKey, exact: true });
    queries.setQueryData<BaseData>(baseKey, (old) =>
      old === undefined
        ? old
        : { ...old, views: old.views.map((each) => (each.id === view.id ? { ...each, config } : each)) },
    );
    // The view's writes go one after the other, so the server keeps the newest; only the newest one
    // brings the saved view back.
    writes.current += 1;
    const mine = writes.current;
    const write = () =>
      client.api
        .updateBaseView({ workspaceId, baseId: base.id, viewId: view.id, body: { config } })
        .catch((error: unknown) => {
          toast.push({ tone: "danger", title: t("base.viewSaveFailed"), description: describe(error) });
        });
    viewWrites.current = viewWrites.current.then(write, write).finally(() => {
      if (writes.current === mine) void queries.invalidateQueries({ queryKey: baseKey, exact: true });
    });
  };

  const saveSchema = useApiMutation("setBaseTableSchema", {
    invalidates: () => [{ method: "getBase", args: { workspaceId, baseId: base.id } }, rowsPrefix],
  });
  const writeDefs = (defs: BasePropDef[]) => {
    const mine = opening.current;
    saveSchema.mutate(
      { workspaceId, baseId: base.id, tableId: table.id, body: { defs, parentVersion: table.schemaVersion } },
      {
        onSuccess: () => {
          if (opening.current !== mine) return;
          setEditing(null);
          setSchemaError(null);
        },
        onError: (error) => {
          if (opening.current === mine) setSchemaError(describe(error));
        },
      },
    );
  };
  const edit = (next: BasePropDef | "new" | null) => {
    opening.current += 1;
    setEditing(next);
  };
  /** The property as it is now, when someone changed or deleted it since the dialog opened; else null. */
  const changedSince = (snapshot: BasePropDef) => {
    const current = table.defs.find((each) => each.id === snapshot.id);
    if (JSON.stringify(current) === JSON.stringify(snapshot)) return null;
    return current ?? "deleted";
  };
  const showChange = (change: BasePropDef | "deleted") => {
    if (change === "deleted") {
      toast.push({ tone: "warning", title: t("property.deletedMeanwhile") });
      edit(null);
      return;
    }
    setSchemaError(t("property.changed"));
    edit(change);
  };

  const newRow = useApiMutation("createBaseTableRow", {
    invalidates: () => [rowsPrefix],
    onSuccess: (row) => {
      if (view.type !== "table") open({ view: view.id, row: row.id });
    },
  });
  const addRow = (props?: Record<string, unknown>) =>
    newRow.mutate({
      workspaceId,
      baseId: base.id,
      tableId: table.id,
      body: props === undefined ? {} : { props },
    });

  const rename = useApiMutation("updateBase", {
    invalidates: () => [
      { method: "getBase", args: { workspaceId, baseId: base.id } },
      { method: "listBases", args: { workspaceId } },
    ],
  });
  const remove = useApiMutation("deleteBase", {
    invalidates: () => [{ method: "listBases", args: { workspaceId } }],
    onSuccess: () => void go("bases", { workspaceId }),
  });
  const addView = useApiMutation("createBaseView", {
    invalidates: () => [{ method: "getBase", args: { workspaceId, baseId: base.id } }],
    onSuccess: (created) => {
      setAdding(false);
      open({ view: created.id });
    },
  });
  const removeView = useApiMutation("deleteBaseView", {
    invalidates: () => [{ method: "getBase", args: { workspaceId, baseId: base.id } }],
    onSuccess: () => open({}),
  });
  const exportCsv = useApiMutation("exportBaseTable", {
    onSuccess: (file) => downloadText(file.fileName, file.csv),
  });
  const importCsv = useApiMutation("importBaseTable", {
    invalidates: () => [rowsPrefix, { method: "getBase", args: { workspaceId, baseId: base.id } }],
  });

  const createView = (type: BaseViewType) => {
    const group =
      table.defs.find((def) => def.type === "status") ?? table.defs.find((def) => def.type === "select");
    addView.mutate({
      workspaceId,
      baseId: base.id,
      body: {
        tableId: table.id,
        name: t(`view.type.${type}`),
        type,
        ...(type === "board" && group !== undefined && { config: { groupBy: { prop: group.id } } }),
      },
    });
  };

  const viewProps: ViewProps = {
    workspaceId,
    table,
    view,
    rows: all,
    context,
    relationTargets: base.relationTargets,
    onOpen: (row) => open({ view: view.id, row: row.id }),
    onSave: (row, propId, value) => void saveRow(row, { props: { [propId]: value } }),
    onNewRow: addRow,
    onEditProperty: edit,
    name: viewName(view, (type) => t(`view.type.${type}`)),
  };
  const failure = [rename, remove, addView, removeView, exportCsv, importCsv, newRow].find(
    (each) => each.isError,
  );

  return (
    <div className="page files bases">
      <header className="files__head">
        <div className="files__stack">
          {renaming === null ? (
            <h1 className="page__title">
              <button
                type="button"
                className="bases__rename"
                aria-label={t("base.rename", { title: base.title })}
                onClick={() => setRenaming(base.title)}
              >
                {base.title}
              </button>
            </h1>
          ) : (
            <Input
              autoFocus
              aria-label={t("base.name")}
              value={renaming}
              maxLength={TITLE_MAX}
              onChange={(event) => setRenaming(event.target.value)}
              onBlur={() => setRenaming(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenaming(null);
                if (event.key === "Enter" && renaming.trim() !== "") {
                  if (renaming.trim() !== base.title) {
                    rename.mutate({ workspaceId, baseId: base.id, body: { title: renaming.trim() } });
                  }
                  setRenaming(null);
                }
              }}
            />
          )}
          <p className="page__muted">
            {t("bases.rows", { count: first?.total ?? base.rowCount })}
            {base.kind === "linked" && ` ${t("base.linkedNote")}`}
            {table.recalc.pending && (
              <span className="bases__recalc" role="status">
                {" "}
                {t("base.recalc")}
              </span>
            )}
          </p>
        </div>
        <div className="files__actions">
          <Button
            variant="ghost"
            icon={<Icon icon={Download} />}
            loading={exportCsv.isPending}
            onClick={() =>
              exportCsv.mutate({ workspaceId, baseId: base.id, tableId: table.id, body: { viewId: view.id } })
            }
          >
            {t("base.export")}
          </Button>
          {base.kind === "database" && (
            <>
              <Button
                variant="ghost"
                icon={<Icon icon={Upload} />}
                loading={importCsv.isPending}
                onClick={() => picker.current?.click()}
              >
                {t("base.import")}
              </Button>
              <input
                ref={picker}
                type="file"
                accept=".csv,text/csv"
                hidden
                aria-label={t("base.import")}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file !== undefined) {
                    importCsv.mutate({
                      workspaceId,
                      baseId: base.id,
                      tableId: table.id,
                      body: { csv: await file.text() },
                    });
                  }
                }}
              />
            </>
          )}
          {base.deletable && (
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {t("base.delete")}
            </Button>
          )}
        </div>
      </header>
      {importCsv.data !== undefined && (
        <p className="files__meta" role="status">
          {t("base.imported", { created: importCsv.data.created, skipped: importCsv.data.skipped })}
        </p>
      )}
      {failure?.error != null && (
        <p className="bases__error" role="alert">
          {describe(failure.error)}
        </p>
      )}
      <div className="bases__tabs">
        <div role="tablist" aria-label={t("view.list")} className="bases__tablist">
          {base.views.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={each.id === view.id}
              className="bases__tab"
              onClick={() => open({ view: each.id })}
            >
              {viewName(each, (type) => t(`view.type.${type}`))}
            </button>
          ))}
        </div>
        {adding ? (
          <fieldset className="files__toggle">
            <legend className="vr-visually-hidden">{t("view.new")}</legend>
            {VIEW_TYPES.map((type) => (
              <Button
                key={type}
                size="sm"
                loading={addView.isPending && addView.variables?.body.type === type}
                onClick={() => createView(type)}
              >
                {t(`view.type.${type}`)}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {common("action.cancel")}
            </Button>
          </fieldset>
        ) : (
          <Button size="sm" variant="ghost" icon={<Icon icon={Plus} />} onClick={() => setAdding(true)}>
            {t("view.new")}
          </Button>
        )}
        {base.views.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            loading={removeView.isPending}
            onClick={() => removeView.mutate({ workspaceId, baseId: base.id, viewId: view.id })}
          >
            {t("view.delete", { name: viewName(view, (type) => t(`view.type.${type}`)) })}
          </Button>
        )}
      </div>
      <div className="files__toolbar">
        <Input
          type="search"
          aria-label={t("base.search")}
          placeholder={t("base.search")}
          value={query}
          maxLength={TITLE_MAX}
          onChange={(event) => setQuery(event.target.value)}
        />
        {(["filter", "sort", "group", "properties"] as const).map((each) => (
          <Button key={each} size="sm" variant="ghost" onClick={() => setPanel(each)}>
            {each === "filter" && conditions > 0
              ? t("panel.filterCount", { count: conditions })
              : t(`panel.${each}`)}
          </Button>
        ))}
        <Button size="sm" icon={<Icon icon={Plus} />} onClick={() => edit("new")}>
          {t("property.new")}
        </Button>
      </div>
      <QuickFilters table={table} config={view.config} onChange={setConfig} />
      {(view.type !== "table" || all.length === 0) && (
        <fieldset className="bases__defs">
          <legend className="vr-visually-hidden">{t("property.list")}</legend>
          {table.defs.map((def) => (
            <Button
              key={def.id}
              size="sm"
              variant="ghost"
              aria-label={t("property.editNamed", { name: def.name })}
              onClick={() => edit(def)}
            >
              {def.name}
            </Button>
          ))}
        </fieldset>
      )}
      {rows.isPending ? (
        <ScreenLoading />
      ) : rows.isError ? (
        <ScreenError
          title={t("base.rowsFailed")}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          namespace="files"
        />
      ) : all.length === 0 &&
        (filtered || view.config.groupBy == null || view.config.groupBy.hideEmpty === true) ? (
        filtered ? (
          <EmptyState
            className="page__narrow"
            title={t("base.none")}
            action={
              <Button
                onClick={() => {
                  setQuery("");
                  setConfig({ ...view.config, filter: null, quickFilters: [] });
                }}
              >
                {t("drive.none.clear")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            className="page__narrow"
            title={t("base.empty.title")}
            description={t("base.empty.body")}
            action={
              <Button variant="primary" loading={newRow.isPending} onClick={() => addRow()}>
                {t("row.new")}
              </Button>
            }
          />
        )
      ) : (
        <>
          {view.type === "board" ? (
            <BoardView {...viewProps} />
          ) : view.type === "list" ? (
            <ListView {...viewProps} />
          ) : view.type === "gallery" ? (
            <GalleryView {...viewProps} />
          ) : (
            <TableView {...viewProps} />
          )}
          {rows.hasNextPage && (
            <Button loading={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>
              {t("base.more")}
            </Button>
          )}
        </>
      )}
      {panel !== null && (
        <ViewPanel
          panel={panel}
          table={table}
          config={view.config}
          onChange={setConfig}
          onClose={() => setPanel(null)}
        />
      )}
      {editing !== null && (
        <PropertyDialog
          // A property shown again after someone changed it starts from their version.
          key={editing === "new" ? "new" : JSON.stringify(editing)}
          workspaceId={workspaceId}
          base={base}
          table={table}
          def={editing === "new" ? null : editing}
          sample={all[0] ?? null}
          names={names}
          saving={saveSchema.isPending}
          error={schemaError}
          onClose={() => {
            edit(null);
            setSchemaError(null);
          }}
          onSave={(def) => {
            // Someone changed or deleted this property while the dialog was open: theirs is shown instead.
            const change = editing === "new" ? null : changedSince(editing);
            if (change !== null) return showChange(change);
            writeDefs(
              editing === "new"
                ? [...table.defs, def]
                : table.defs.map((each) => (each.id === def.id ? def : each)),
            );
          }}
          {...(editing !== "new" && {
            onDelete: () => {
              const change = changedSince(editing);
              if (change !== null) return showChange(change);
              writeDefs(table.defs.filter((each) => each.id !== editing.id));
            },
          })}
        />
      )}
      {address.row !== undefined && (
        <RowPanel
          workspaceId={workspaceId}
          base={base}
          table={table}
          rowId={address.row}
          onClose={() => {
            open({ view: view.id });
            void refetch([rowsPrefix]);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("base.deleteTitle", { title: base.title })}
        description={t("base.deleteBody")}
        confirmLabel={t("base.delete")}
        cancelLabel={common("action.cancel")}
        tone="danger"
        confirming={remove.isPending}
        onConfirm={() => remove.mutate({ workspaceId, baseId: base.id })}
      />
    </div>
  );
}
