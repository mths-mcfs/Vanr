// The trash: what was deleted, by whom it was made, when it went, and how many days are left before it
// is gone for good. Restoring is offered to the person who made the file and to the workspace's admins;
// everyone else is told who can.

import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { TrashedFile } from "@vanr/contract";
import { can } from "@vanr/contract";
import { Button, Callout, EmptyState, Icon } from "@vanr/ui";
import { RotateCcw } from "lucide-react";
import { ScreenError, ScreenLoading, useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useClock } from "../../../platform/clock.tsx";
import { useSession } from "../../../session/react.tsx";
import { KIND_ICON, useActorName, useRelativeTime } from "../shared.tsx";

const DAY_MS = 86_400_000;
/** The last days before a file is gone are marked. */
const SOON_DAYS = 3;

export function Trash({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("files");
  const clock = useClock();
  const { me } = useSession();
  const name = useActorName(workspaceId);
  const describe = useErrorMessage("files");
  const when = useRelativeTime();
  const trash = useApiQuery("getFileTrash", { workspaceId }, { refetchOnMount: "always" });
  const restore = useApiMutation("restoreFile", {
    invalidates: () => [
      { method: "getFileTrash", args: { workspaceId } },
      { method: "listFiles", args: { workspaceId } },
    ],
  });
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  const mayRestore = (file: TrashedFile) =>
    (file.createdBy.type === "person" && file.createdBy.id === me?.user.id) || can(role, "configure");

  if (trash.isPending) return <ScreenLoading />;
  if (trash.isError) {
    return (
      <ScreenError
        title={t("trash.failed")}
        error={trash.error}
        onRetry={() => void trash.refetch()}
        namespace="files"
      />
    );
  }
  if (trash.data.length === 0) {
    return (
      <EmptyState
        className="page__narrow"
        title={t("trash.empty.title")}
        description={t("trash.empty.body")}
      />
    );
  }
  return (
    <>
      {restore.isError && (
        <Callout tone="danger" role="alert" title={t("trash.restoreFailed")}>
          {describe(restore.error)}
        </Callout>
      )}
      <ul className="files__rows" aria-label={t("trash.list")}>
        {trash.data.map((file) => {
          const days = Math.max(0, Math.ceil((Date.parse(file.expungeAt) - clock.now()) / DAY_MS));
          return (
            <li key={file.id} className="files__row">
              <span className="files__open files__open--static">
                <span className="files__glyph" aria-hidden="true">
                  <Icon icon={KIND_ICON[file.kind]} />
                </span>
                <span className="files__name">{file.title}</span>
              </span>
              <span className="files__meta">{name(file.createdBy)}</span>
              <span className={days <= SOON_DAYS ? "files__meta files__meta--soon" : "files__meta"}>
                {t("trash.daysLeft", { count: days })}
              </span>
              <time className="files__meta" dateTime={file.deletedAt}>
                {t("trash.deleted", { when: when(file.deletedAt) })}
              </time>
              {mayRestore(file) ? (
                <Button
                  size="sm"
                  icon={<Icon icon={RotateCcw} />}
                  loading={restore.isPending && restore.variables?.fileId === file.id}
                  aria-label={t("trash.restoreNamed", { title: file.title })}
                  onClick={() => restore.mutate({ workspaceId, fileId: file.id })}
                >
                  {t("trash.restore")}
                </Button>
              ) : (
                <span className="files__meta">{t("trash.whoRestores")}</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
