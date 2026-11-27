// The wiki's trash: the pages moved there, with their folder, who moved them, when, and when they are
// gone for good (30 days after). Who may bring one back or delete it for good is the server's answer
// per page (its author or an admin); everyone else is told who can.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import { Button, Callout, Dialog, DialogContent, EmptyState, Icon } from "@vanr/ui";
import { RotateCcw, Trash2 } from "lucide-react";
import { useGo } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { useActorName, useWikiRefresh } from "../shared.tsx";

export function TrashDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const describe = useErrorMessage("wiki");
  const when = useRelativeTime();
  const name = useActorName(workspaceId);
  const go = useGo();
  const refresh = useWikiRefresh(workspaceId);
  const trash = useApiQuery("getWikiTrash", { workspaceId }, { refetchOnMount: "always" });
  const restore = useApiMutation("restoreWikiTrash", {
    onSuccess: async (page) => {
      await refresh();
      onClose();
      await go("wikiPage", { workspaceId, pageId: page.slug });
    },
  });
  const purge = useApiMutation("deleteWikiTrash", { onSuccess: () => refresh() });
  const failure = restore.error ?? purge.error;

  let body: React.ReactNode;
  if (trash.isPending) body = <ScreenLoading />;
  else if (trash.isError)
    body = (
      <ScreenError
        title={t("trash.failed")}
        error={trash.error}
        onRetry={() => void trash.refetch()}
        namespace="wiki"
      />
    );
  else if (trash.data.length === 0)
    body = <EmptyState title={t("trash.empty.title")} description={t("trash.empty.body")} />;
  else
    body = (
      <ul className="wiki-trash" aria-label={t("trash.list")}>
        {trash.data.map((page) => (
          <li key={page.slug} className="wiki-trash__row">
            <div className="wiki-trash__what">
              <span className="wiki-trash__title">{page.title}</span>
              <span className="wiki-trash__meta">
                {page.deletedBy === null
                  ? t("trash.deleted", { when: when(page.deletedAt) })
                  : t("trash.deletedBy", { who: name(page.deletedBy), when: when(page.deletedAt) })}
              </span>
              <span className="wiki-trash__meta">{page.folder === "" ? t("index.root") : page.folder}</span>
              <span className="wiki-trash__meta">{t("trash.expires", { when: when(page.expungeAt) })}</span>
            </div>
            {page.canPurge ? (
              <div className="wiki-trash__actions">
                <Button
                  size="sm"
                  icon={<Icon icon={RotateCcw} />}
                  loading={restore.isPending && restore.variables?.trashId === page.slug}
                  aria-label={t("trash.restoreNamed", { title: page.title })}
                  onClick={() => restore.mutate({ workspaceId, trashId: page.slug })}
                >
                  {t("trash.restore")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Icon icon={Trash2} />}
                  loading={purge.isPending && purge.variables?.trashId === page.slug}
                  aria-label={t("trash.purgeNamed", { title: page.title })}
                  onClick={() => purge.mutate({ workspaceId, trashId: page.slug })}
                >
                  {t("trash.purge")}
                </Button>
              </div>
            ) : (
              <span className="wiki-trash__meta">{t("trash.whoRestores")}</span>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t("trash.title")}
        description={t("trash.lead")}
        closeLabel={common("action.close")}
      >
        {failure !== null && (
          <Callout tone="danger" role="alert">
            {describe(failure)}
          </Callout>
        )}
        {body}
      </DialogContent>
    </Dialog>
  );
}
