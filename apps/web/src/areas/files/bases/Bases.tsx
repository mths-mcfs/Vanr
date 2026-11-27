// The workspace's bases: each one's name, rows, the wiki page or source it belongs to, who made it and
// when it last changed. A new base starts from a name, a CSV file, a table in Files, or as a linked
// view of another base, whose rows it shares: an edit on either side shows on both.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Base } from "@vanr/contract";
import { Button, Callout, Dialog, DialogContent, EmptyState, Field, Icon, Input } from "@vanr/ui";
import { FileSpreadsheet, Link2, Plus, Table2, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { TITLE_MAX, useActorName, useRelativeTime } from "../shared.tsx";

type Making = "new" | "fromFile" | "linked" | null;

export function BasesScreen() {
  const t = useMessages("files");
  const { workspaceId } = useRouteParams("bases");
  const go = useGo();
  const name = useActorName(workspaceId);
  const when = useRelativeTime();
  const describe = useErrorMessage("files");
  const bases = useApiQuery("listBases", { workspaceId });
  const [making, setMaking] = useState<Making>(null);
  const picker = useRef<HTMLInputElement>(null);
  useDocumentTitle(t("bases.title"));
  const opened = (base: Base) => void go("base", { workspaceId, baseId: base.id });
  const importCsv = useApiMutation("importBase", {
    invalidates: () => [{ method: "listBases", args: { workspaceId } }],
    onSuccess: opened,
  });

  const actions = (
    <div className="files__actions">
      <Button icon={<Icon icon={Link2} />} variant="ghost" onClick={() => setMaking("linked")}>
        {t("bases.linked")}
      </Button>
      <Button icon={<Icon icon={FileSpreadsheet} />} variant="ghost" onClick={() => setMaking("fromFile")}>
        {t("bases.fromFile")}
      </Button>
      <Button
        icon={<Icon icon={Upload} />}
        loading={importCsv.isPending}
        onClick={() => picker.current?.click()}
      >
        {t("bases.importCsv")}
      </Button>
      <Button variant="primary" icon={<Icon icon={Plus} />} onClick={() => setMaking("new")}>
        {t("bases.new")}
      </Button>
      <input
        ref={picker}
        type="file"
        accept=".csv,text/csv"
        hidden
        aria-label={t("bases.importCsv")}
        data-testid="bases-import"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file === undefined) return;
          importCsv.mutate({
            workspaceId,
            body: { title: file.name.replace(/\.csv$/i, "").slice(0, TITLE_MAX), csv: await file.text() },
          });
        }}
      />
    </div>
  );

  let body: React.ReactNode;
  if (bases.isPending) body = <ScreenLoading />;
  else if (bases.isError) {
    body = (
      <ScreenError
        title={t("bases.failed")}
        error={bases.error}
        onRetry={() => void bases.refetch()}
        namespace="files"
      />
    );
  } else if (bases.data.length === 0) {
    body = (
      <EmptyState
        className="page__narrow"
        icon={<Icon icon={Table2} size="lg" />}
        title={t("bases.empty.title")}
        description={t("bases.empty.body")}
        action={
          <Button variant="primary" onClick={() => setMaking("new")}>
            {t("bases.new")}
          </Button>
        }
      />
    );
  } else {
    body = (
      <ul className="files__rows bases__list" aria-label={t("bases.list")}>
        {bases.data.map((base) => (
          <li key={base.id} className="files__row bases__list-row">
            <AppLink className="app-link files__name" route="base" params={{ workspaceId, baseId: base.id }}>
              {base.title}
            </AppLink>
            <span className="files__meta">{t("bases.rows", { count: base.rowCount })}</span>
            <span className="files__meta bases__wide">
              {base.page !== null
                ? t("bases.onPage", { page: base.page.title })
                : base.kind === "linked"
                  ? t("bases.isLinked")
                  : ""}
            </span>
            <span className="files__meta bases__wide">{name(base.createdBy)}</span>
            <time className="files__meta bases__wide" dateTime={base.updatedAt}>
              {when(base.updatedAt)}
            </time>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="page files">
      <header className="files__head">
        <div>
          <h1 className="page__title">{t("bases.title")}</h1>
          <p className="page__muted">{t("bases.lead")}</p>
        </div>
        {actions}
      </header>
      {importCsv.isError && (
        <Callout tone="danger" role="alert" title={t("bases.importFailed")}>
          {describe(importCsv.error)}
        </Callout>
      )}
      {body}
      {making === "new" && (
        <NewBase workspaceId={workspaceId} onClose={() => setMaking(null)} onDone={opened} />
      )}
      {making === "fromFile" && (
        <FromFile workspaceId={workspaceId} onClose={() => setMaking(null)} onDone={opened} />
      )}
      {making === "linked" && (
        <LinkedView workspaceId={workspaceId} onClose={() => setMaking(null)} onDone={opened} />
      )}
    </div>
  );
}

type Making2 = { workspaceId: string; onClose: () => void; onDone: (base: Base) => void };

function NewBase({ workspaceId, onClose, onDone }: Making2) {
  const t = useMessages("files");
  const common = useMessages("common");
  const describe = useErrorMessage("files");
  const [title, setTitle] = useState("");
  const create = useApiMutation("createBase", {
    invalidates: () => [{ method: "listBases", args: { workspaceId } }],
    onSuccess: onDone,
  });
  const formId = useId();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("bases.new")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={title.trim() === ""}
              loading={create.isPending}
            >
              {t("bases.create")}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="files__stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() !== "") create.mutate({ workspaceId, body: { title: title.trim() } });
          }}
        >
          <Field label={t("bases.name")} required>
            <Input value={title} maxLength={TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          {create.isError && (
            <Callout tone="danger" role="alert">
              {describe(create.error)}
            </Callout>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A base made from a table in Files (only the tables written in the app, not any uploaded CSV). */
function FromFile({ workspaceId, onClose, onDone }: Making2) {
  const t = useMessages("files");
  const common = useMessages("common");
  const describe = useErrorMessage("files");
  const tables = useApiQuery("listFiles", { workspaceId, query: { kind: "table" } });
  const convert = useApiMutation("createBaseFromFile", {
    invalidates: () => [{ method: "listBases", args: { workspaceId } }],
    onSuccess: onDone,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={t("bases.fromFile")} closeLabel={common("action.close")}>
        {tables.isPending ? (
          <ScreenLoading />
        ) : tables.isError ? (
          <ScreenError error={tables.error} onRetry={() => void tables.refetch()} namespace="files" />
        ) : tables.data.length === 0 ? (
          <p className="page__muted">{t("bases.noTables")}</p>
        ) : (
          <ul className="files__rows" aria-label={t("bases.tables")}>
            {tables.data.map((file) => (
              <li key={file.id} className="bases__pick-row">
                <span className="files__name">{file.title}</span>
                <Button
                  size="sm"
                  loading={convert.isPending && convert.variables?.body.fileId === file.id}
                  aria-label={t("bases.useTable", { title: file.title })}
                  onClick={() => convert.mutate({ workspaceId, body: { fileId: file.id } })}
                >
                  {t("bases.use")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {convert.isError && (
          <Callout tone="danger" role="alert">
            {describe(convert.error)}
          </Callout>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A linked view: a new base that shows the rows of another base's source. */
function LinkedView({ workspaceId, onClose, onDone }: Making2) {
  const t = useMessages("files");
  const common = useMessages("common");
  const describe = useErrorMessage("files");
  const bases = useApiQuery("listBases", { workspaceId });
  const sources = (bases.data ?? []).filter((each) => each.kind === "database" && each.tableId !== null);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const create = useApiMutation("createBase", {
    invalidates: () => [{ method: "listBases", args: { workspaceId } }],
    onSuccess: onDone,
  });
  const formId = useId();
  const sourceId = useId();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("bases.linked")}
        description={t("bases.linkedLead")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={title.trim() === "" || source === ""}
              loading={create.isPending}
            >
              {t("bases.create")}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="files__stack"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ workspaceId, body: { title: title.trim(), linkedTableId: source } });
          }}
        >
          <Field label={t("bases.linkedSource")} controlId={sourceId} required>
            <select
              id={sourceId}
              className="bases__select bases__select--field"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            >
              <option value="">{t("property.chooseBase")}</option>
              {sources.map((each) => (
                <option key={each.id} value={each.tableId ?? ""}>
                  {each.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("bases.name")} required>
            <Input value={title} maxLength={TITLE_MAX} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          {create.isError && (
            <Callout tone="danger" role="alert">
              {describe(create.error)}
            </Callout>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
