// One row: its title, its properties, its page of text, and who made and changed it. The side panel
// over the base and the full page share this editor; the full page adds the way back to the base.
// The title saves on leaving it or on Enter; the text saves when asked, and only once it changed.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Base, BaseTable } from "@vanr/contract";
import { Button, ConfirmDialog, Drawer, DrawerContent, Icon, Textarea } from "@vanr/ui";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useActorName, useRelativeTime } from "../shared.tsx";
import { CellEditor, TEXT_MAX } from "./cells.tsx";
import { useSaveRow } from "./data.ts";
import type { CellContext } from "./model.ts";

const BODY_MAX = 500_000;

function RowEditor({
  workspaceId,
  base,
  table,
  rowId,
  onDeleted,
  full,
}: {
  workspaceId: string;
  base: Base;
  table: BaseTable;
  rowId: string;
  onDeleted: () => void;
  full: boolean;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const { locale } = useLocale();
  const names = useActorName(workspaceId);
  const when = useRelativeTime();
  const row = useApiQuery("getBaseRow", { workspaceId, baseId: base.id, rowId });
  const save = useSaveRow(workspaceId, base.id);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const saved = row.data;
  const savedTitle =
    typeof saved?.props[table.titlePropId] === "string" ? String(saved.props[table.titlePropId]) : "";
  // A change made elsewhere shows here: the title and the text follow the saved row.
  useEffect(() => setTitle(savedTitle), [savedTitle]);
  useEffect(() => setBody(saved?.body ?? ""), [saved?.body]);
  const remove = useApiMutation("deleteBaseRow", {
    invalidates: () => [{ method: "createBaseTableQuery", args: { workspaceId, tableId: table.id } }],
    onSuccess: onDeleted,
  });

  if (row.isPending) return <ScreenLoading />;
  if (row.isError || saved === undefined) {
    return (
      <ScreenError
        title={t("row.failed")}
        error={row.error}
        onRetry={() => void row.refetch()}
        namespace="files"
      />
    );
  }
  const context: CellContext = { names, locale, linked: saved.linked ?? {} };
  const commit = async (patch: Parameters<typeof save>[1]) => {
    await save(saved, patch);
    await row.refetch();
  };
  return (
    <div className="files__stack bases__row">
      <input
        className="bases__row-title"
        aria-label={t("row.title")}
        placeholder={t("row.untitled")}
        value={title}
        maxLength={TEXT_MAX}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (title !== savedTitle) void commit({ props: { [table.titlePropId]: title } });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <dl className="bases__props">
        {table.defs
          .filter((def) => def.id !== table.titlePropId)
          .map((def) => (
            <div key={def.id} className="bases__prop">
              <dt>{def.name}</dt>
              <dd>
                <CellEditor
                  workspaceId={workspaceId}
                  def={def}
                  row={saved}
                  context={context}
                  rowTitle={savedTitle}
                  relationTargets={base.relationTargets}
                  onSave={(value) => void commit({ props: { [def.id]: value } })}
                />
              </dd>
            </div>
          ))}
      </dl>
      <Textarea
        aria-label={t("row.body")}
        rows={full ? 16 : 8}
        value={body}
        maxLength={BODY_MAX}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="files__actions bases__row-actions">
        <span className="files__meta">
          {t("row.made", { name: names(saved.createdBy), when: when(saved.createdAt) })}{" "}
          {t("row.changed", { name: names(saved.editedBy), when: when(saved.editedAt) })}
        </span>
        <Button variant="danger" onClick={() => setConfirming(true)}>
          {t("row.delete")}
        </Button>
        <Button variant="primary" disabled={body === saved.body} onClick={() => void commit({ body })}>
          {t("row.saveBody")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("row.deleteTitle")}
        description={t("row.deleteBody")}
        confirmLabel={t("row.delete")}
        cancelLabel={common("action.cancel")}
        tone="danger"
        confirming={remove.isPending}
        onConfirm={() => remove.mutate({ workspaceId, baseId: base.id, rowId })}
      />
    </div>
  );
}

/** The row in a side panel over the base. */
export function RowPanel({
  workspaceId,
  base,
  table,
  rowId,
  onClose,
}: {
  workspaceId: string;
  base: Base;
  table: BaseTable;
  rowId: string;
  onClose: () => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent side="right" title={t("row.panel")} className="bases__panel">
        <div className="bases__panel-head">
          <AppLink className="app-link" route="baseRow" params={{ workspaceId, baseId: base.id, rowId }}>
            <Icon icon={Maximize2} /> {t("row.fullPage")}
          </AppLink>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {common("action.close")}
          </Button>
        </div>
        <RowEditor
          workspaceId={workspaceId}
          base={base}
          table={table}
          rowId={rowId}
          onDeleted={onClose}
          full={false}
        />
      </DrawerContent>
    </Drawer>
  );
}

/** The row on a page of its own, with the way back to its base. */
export function RowScreen() {
  const t = useMessages("files");
  const { workspaceId, baseId, rowId } = useRouteParams("baseRow");
  const go = useGo();
  const base = useApiQuery("getBase", { workspaceId, baseId });
  const row = useApiQuery("getBaseRow", { workspaceId, baseId, rowId });
  useDocumentTitle(base.data?.title ?? t("bases.title"));
  if (base.isPending) return <ScreenLoading />;
  if (base.isError) {
    return (
      <>
        <h1 className="vr-visually-hidden">{t("row.panel")}</h1>
        <ScreenError
          title={t("base.failed")}
          error={base.error}
          onRetry={() => void base.refetch()}
          namespace="files"
        />
      </>
    );
  }
  const table = base.data.tables.find((each) => each.id === row.data?.tableId) ?? base.data.tables[0];
  return (
    <div className="page files">
      <AppLink className="app-link" route="base" params={{ workspaceId, baseId }}>
        <Icon icon={ArrowLeft} /> {t("row.back", { base: base.data.title })}
      </AppLink>
      <h1 className="vr-visually-hidden">{t("row.panel")}</h1>
      {table === undefined ? (
        <p className="page__muted">{t("base.noTable")}</p>
      ) : (
        <RowEditor
          workspaceId={workspaceId}
          base={base.data}
          table={table}
          rowId={rowId}
          full
          onDeleted={() => void go("base", { workspaceId, baseId })}
        />
      )}
    </div>
  );
}
