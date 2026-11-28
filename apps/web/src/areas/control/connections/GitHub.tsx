// The GitHub App: the GitHub accounts and organizations that installed it for this workspace, how many
// repositories each one shares, and whether GitHub suspended it. Installing happens on GitHub, which
// sends the person back here; removing an installation stops the workspace's agents from reaching it.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { GitHubAppInstallation } from "@vanr/contract";
import { Button, Chip, ConfirmDialog, EmptyState, Icon } from "@vanr/ui";
import { ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../shared.tsx";
import {
  Block,
  comeBackTo,
  isLost,
  leaveFor,
  PartError,
  PartLoading,
  useForgetOnLoss,
  useForgetReadOnLoss,
  useLatch,
  useReturnFocus,
} from "./shared.tsx";

const READS = ["getGithubApp", "listGithubRepositories"] as const;

export function GitHubApp({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("control");
  const common = useMessages("common");
  const outcome = useOutcome();
  const latch = useLatch();
  const focus = useReturnFocus();
  const forget = useForgetOnLoss(workspaceId, READS);
  const app = useApiQuery("getGithubApp", { workspaceId });
  const installed = (app.data?.installations.length ?? 0) > 0;
  const repositories = useApiQuery("listGithubRepositories", { workspaceId }, { enabled: installed });
  const [removing, setRemoving] = useState<GitHubAppInstallation | null>(null);
  const install = useApiMutation("installGithubApp");
  const remove = useApiMutation("deleteGithubAppInstallation", {
    invalidates: () => [
      { method: "getGithubApp" as const, args: { workspaceId } },
      { method: "listGithubRepositories" as const, args: { workspaceId } },
    ],
  });
  // Either read may be the one that says the workspace lost it, while the other fails for another reason.
  useForgetReadOnLoss(workspaceId, READS, isLost(app.error) ? app.error : repositories.error);
  // A suspended account lists nothing; an account missing from the answer is not known yet. Counts from
  // before a failed read are not shown as if they were current.
  const counts = repositories.isError ? undefined : repositories.data;
  const shared = (login: string) =>
    counts?.accounts.find((account) => account.login === login)?.repositories.length;

  let body: ReactNode;
  if (app.isPending) body = <PartLoading />;
  else if (app.isError)
    body = <PartError title={t("gh.failed")} error={app.error} onRetry={() => void app.refetch()} />;
  else if (!app.data.installable)
    body = <EmptyState title={t("gh.notSetUp")} description={t("gh.notSetUpBody")} />;
  else if (app.data.installations.length === 0)
    body = <EmptyState title={t("gh.none")} description={t("gh.noneBody")} />;
  else
    body = (
      <ul className="wire-list" aria-label={t("gh.title")}>
        {app.data.installations.map((each) => {
          const count = shared(each.accountUsername);
          return (
            <li key={each.id} className="wire-row" data-state={each.suspended ? "suspended" : "active"}>
              <div className="wire-row__who">
                <span className="wire-row__name">{each.accountUsername}</span>
                <span className="wire-row__what">{t(`gh.scope.${each.repoScope}`)}</span>
              </div>
              <div className="wire-row__chips">
                {each.suspended ? (
                  <Chip className="wire-chip--stopped">{t("gh.suspended")}</Chip>
                ) : (
                  count !== undefined && <Chip>{t("gh.repoCount", { count })}</Chip>
                )}
              </div>
              <div className="wire-row__actions">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("gh.removeNamed", { account: each.accountUsername })}
                  onClick={() => {
                    focus.remember();
                    setRemoving(each);
                  }}
                >
                  {t("gh.remove")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );

  return (
    <Block
      title={t("gh.title")}
      lead={t("gh.lead")}
      action={
        app.data?.installable === true && (
          <Button
            icon={<Icon icon={ExternalLink} />}
            loading={install.isPending}
            onClick={() =>
              latch(() =>
                install
                  .mutateAsync({ workspaceId, body: { nextPath: comeBackTo(workspaceId, "connectors") } })
                  .then(
                    (installUrl) => leaveFor(installUrl),
                    (error: unknown) => {
                      forget(error);
                      outcome.failed(error);
                    },
                  ),
              )
            }
          >
            {t(installed ? "gh.installMore" : "gh.install")}
          </Button>
        )
      }
    >
      {body}
      {repositories.isError && installed && (
        <p className="page__muted" role="status">
          {t("gh.reposFailed")}{" "}
          <Button size="sm" variant="ghost" onClick={() => void repositories.refetch()}>
            {common("action.retry")}
          </Button>
        </p>
      )}
      <ConfirmDialog
        returnFocus={focus.back}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setRemoving(null);
        }}
        tone="danger"
        title={t("gh.removeTitle", { account: removing?.accountUsername ?? "" })}
        description={t("gh.removeBody")}
        confirmLabel={t("gh.remove")}
        cancelLabel={t("wire.keep")}
        confirming={remove.isPending}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          latch(() =>
            remove.mutateAsync({ workspaceId, installationId: target.id }).then(
              (removed) => {
                setRemoving(null);
                const account = target.accountUsername;
                if (removed.uninstalledOnGitHub) outcome.done(t("gh.removed", { account }));
                else outcome.warn(t("gh.removedStillOnGitHub", { account }));
              },
              (error: unknown) => {
                setRemoving(null);
                forget(error);
                outcome.failed(error);
              },
            ),
          );
        }}
      />
    </Block>
  );
}
