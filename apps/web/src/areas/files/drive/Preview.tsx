// One file, open over the Drive: the content of the chosen version, who made it, the history, and what
// the person may do with it. A new version of an uploaded file goes up the same resumable way as the
// list's uploads. A document's edit keeps the version it started from; if someone saved first, the
// server refuses it and the person picks between dropping their text and saving it over the newer one.
import { isApiError, uploadInParts } from "@vanr/client";
import { useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { FileDetail } from "@vanr/contract";
import { Button, Callout, Chip, Dialog, DialogContent, Icon, Textarea } from "@vanr/ui";
import { Download, Pencil, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { ScreenError, ScreenLoading, useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { DOCUMENT_MAX, formatBytes, useActorName, useRefetch, useRelativeTime } from "../shared.tsx";
import { FileBody } from "./preview-parts.tsx";

type Edit = { text: string; parentVersion: number };

export function Preview({
  workspaceId,
  fileId,
  version,
  page,
  onClose,
  onVersion,
}: {
  workspaceId: string;
  fileId: string;
  version?: number;
  page?: number;
  onClose: () => void;
  onVersion: (version: number | undefined) => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const detail = useApiQuery(
    "getFile",
    { workspaceId, fileId, ...(version !== undefined && { query: { version } }) },
    { refetchOnMount: "always", retry: (count, error) => error.status !== 404 && count < 2 },
  );
  // Gone to the trash (or removed) while open: the next answer is a 404 and the old data goes.
  const gone = detail.error?.status === 404;
  const shown = gone ? undefined : detail.data;
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        size="lg"
        className="files__preview"
        title={shown?.title ?? (detail.isError ? t("preview.title") : common("state.loading"))}
        closeLabel={common("action.close")}
      >
        {gone ? (
          <p className="page__muted">{t("preview.gone")}</p>
        ) : shown === undefined ? (
          detail.isError ? (
            <ScreenError
              title={t("preview.failed")}
              error={detail.error}
              onRetry={() => void detail.refetch()}
              namespace="files"
            />
          ) : (
            <ScreenLoading />
          )
        ) : (
          <Opened
            workspaceId={workspaceId}
            detail={shown}
            {...(page !== undefined && { page })}
            onClose={onClose}
            onVersion={onVersion}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Opened({
  workspaceId,
  detail,
  page,
  onClose,
  onVersion,
}: {
  workspaceId: string;
  detail: FileDetail;
  page?: number;
  onClose: () => void;
  onVersion: (version: number | undefined) => void;
}) {
  const t = useMessages("files");
  const common = useMessages("common");
  const { locale } = useLocale();
  const client = useVanrClient();
  const describe = useErrorMessage("files");
  const name = useActorName(workspaceId);
  const when = useRelativeTime();
  const refetch = useRefetch();
  const versions = useApiQuery("listFileVersions", { workspaceId, fileId: detail.id });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [conflict, setConflict] = useState(false);
  const [sending, setSending] = useState<{ sent: number; total: number } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const picker = useRef<HTMLInputElement>(null);
  const latest = detail.viewVersion === detail.version;
  const fresh = () =>
    refetch([
      { method: "getFile", args: { workspaceId, fileId: detail.id } },
      { method: "listFileVersions", args: { workspaceId, fileId: detail.id } },
      { method: "listFiles", args: { workspaceId } },
    ]);

  const save = useApiMutation("createFileVersion");
  const remove = useApiMutation("deleteFile", {
    invalidates: () => [
      { method: "listFiles", args: { workspaceId } },
      { method: "getFileTrash", args: { workspaceId } },
    ],
    onSuccess: onClose,
  });
  const download = useApiMutation("getFileDownload", {
    onSuccess: (link) => {
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.download = detail.title;
      anchor.click();
    },
  });

  const submit = (current: Edit) => {
    setFailure(null);
    save.mutate(
      {
        workspaceId,
        fileId: detail.id,
        body: { content: { kind: "document", markdown: current.text }, parentVersion: current.parentVersion },
      },
      {
        onSuccess: async () => {
          setEdit(null);
          setConflict(false);
          await fresh();
        },
        onError: async (error) => {
          if (error.rawCode !== "file.version_conflict") return setFailure(error);
          // Someone saved first: the text stays, and saving now goes over the version they saved.
          const newest = await client.api.getFile({ workspaceId, fileId: detail.id }).catch(() => null);
          setConflict(true);
          setEdit({ ...current, parentVersion: newest?.version ?? current.parentVersion });
          await fresh();
        },
      },
    );
  };

  const sendVersion = async (file: File) => {
    setFailure(null);
    setSending({ sent: 0, total: file.size });
    try {
      await uploadInParts(
        client.api,
        workspaceId,
        file,
        {
          fileName: file.name,
          ...(file.type !== "" && { contentType: file.type }),
          fileId: detail.id,
          parentVersion: detail.version,
        },
        { onProgress: (progress) => setSending(progress) },
      );
      await fresh();
    } catch (error) {
      setFailure(isApiError(error) ? error : null);
    } finally {
      setSending(null);
    }
  };

  const canEdit = latest && detail.editable && detail.content.kind === "document";
  return (
    <div className="files__opened">
      <div className="files__main">
        <div className="files__bar">
          <Chip>{t(`kind.${detail.kind}`)}</Chip>
          <span className="files__meta" data-testid="files-version">
            {t("preview.versionOf", { shown: detail.viewVersion, latest: detail.version })}
          </span>
          {!latest && (
            <Button size="sm" variant="ghost" onClick={() => onVersion(undefined)}>
              {t("preview.latest")}
            </Button>
          )}
          <span className="files__spacer" />
          {detail.content.kind === "file" && (
            <Button
              size="sm"
              icon={<Icon icon={Download} />}
              loading={download.isPending}
              onClick={() =>
                download.mutate({ workspaceId, fileId: detail.id, query: { version: detail.viewVersion } })
              }
            >
              {t("preview.download")}
            </Button>
          )}
          {latest && detail.content.kind === "file" && (
            <>
              <Button
                size="sm"
                icon={<Icon icon={Upload} />}
                loading={sending !== null}
                onClick={() => picker.current?.click()}
              >
                {t("preview.newVersion")}
              </Button>
              <input
                ref={picker}
                type="file"
                hidden
                aria-label={t("preview.newVersion")}
                data-testid="files-new-version"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file !== undefined) void sendVersion(file);
                }}
              />
            </>
          )}
          {canEdit && edit === null && (
            <Button
              size="sm"
              icon={<Icon icon={Pencil} />}
              onClick={() => {
                setConflict(false);
                setEdit({
                  text: detail.content.kind === "document" ? detail.content.markdown : "",
                  parentVersion: detail.version,
                });
              }}
            >
              {t("preview.edit")}
            </Button>
          )}
          {detail.deletable && (
            <Button
              size="sm"
              variant="danger"
              icon={<Icon icon={Trash2} />}
              loading={remove.isPending}
              onClick={() => remove.mutate({ workspaceId, fileId: detail.id })}
            >
              {t("preview.delete")}
            </Button>
          )}
        </div>
        {sending !== null && (
          <p className="files__meta" role="status">
            {t("upload.progress", {
              sent: formatBytes(sending.sent, locale),
              total: formatBytes(sending.total, locale),
            })}
          </p>
        )}
        {(failure !== null || remove.isError || download.isError) && (
          <Callout tone="danger" role="alert">
            {describe(failure ?? remove.error ?? download.error)}
          </Callout>
        )}
        {edit !== null ? (
          <div className="files__stack">
            {conflict && (
              <Callout tone="warning" role="alert">
                {t("preview.conflict", { version: edit.parentVersion, name: name(detail.updatedBy) })}
              </Callout>
            )}
            <Textarea
              aria-label={t("preview.content")}
              rows={14}
              value={edit.text}
              maxLength={DOCUMENT_MAX}
              onChange={(event) => setEdit({ ...edit, text: event.target.value })}
            />
            <div className="files__actions">
              <Button
                variant="ghost"
                onClick={() => {
                  setEdit(null);
                  setConflict(false);
                }}
              >
                {conflict ? t("preview.discardMine") : common("action.cancel")}
              </Button>
              <Button variant="primary" loading={save.isPending} onClick={() => submit(edit)}>
                {conflict ? t("preview.saveOver", { version: edit.parentVersion }) : t("preview.save")}
              </Button>
            </div>
          </div>
        ) : (
          <FileBody workspaceId={workspaceId} detail={detail} {...(page !== undefined && { page })} />
        )}
      </div>
      <aside className="files__aside" aria-label={t("preview.about")}>
        <h3 className="files__aside-title">{t("preview.madeBy")}</h3>
        <p className="files__meta">
          {t("preview.madeByLine", { name: name(detail.createdBy), when: when(detail.createdAt) })}
        </p>
        <h3 className="files__aside-title">{t("preview.history")}</h3>
        {versions.isError ? (
          <p className="page__muted">{describe(versions.error)}</p>
        ) : (
          <ol className="files__versions" aria-label={t("preview.history")}>
            {[...(versions.data ?? [])]
              .sort((a, b) => b.version - a.version)
              .map((each) => (
                <li key={each.version}>
                  <button
                    type="button"
                    className="files__version"
                    aria-current={each.version === detail.viewVersion ? "true" : undefined}
                    onClick={() => onVersion(each.version === detail.version ? undefined : each.version)}
                  >
                    <strong>{t("preview.versionShort", { version: each.version })}</strong>
                    <span>
                      {t("preview.versionLine", { name: name(each.author), when: when(each.createdAt) })}
                    </span>
                    {each.note !== null && <span className="files__note">{each.note}</span>}
                  </button>
                </li>
              ))}
          </ol>
        )}
      </aside>
    </div>
  );
}
