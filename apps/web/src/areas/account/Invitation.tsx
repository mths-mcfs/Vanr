import { isApiError } from "@vanr/client";
import { useApiQuery, useVanrClient } from "@vanr/client/react";
import type { InvitationPreview, Me } from "@vanr/contract";
import { Button, Callout, Spinner } from "@vanr/ui";
import { useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { href } from "../../routes.ts";
import { useCompleteSignIn, useSession, useSignOut } from "../../session/react.tsx";
import { linkToken } from "../../session/redirect.ts";
import { AccountPage, LoadFailed, ServerProblem, useSubmit } from "./shared.tsx";

/** A date for a person; the raw text when it is not a date. */
function useDay() {
  const { locale } = useLocale();
  return (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
  };
}

/** `/invite/$token`: what the invitation is, and the one next step for whoever opened it. */
export function InvitationScreen() {
  const t = useMessages("account");
  const common = useMessages("common");
  const describe = useErrorMessage();
  // What stands in the address may not be a token at all: then there is no invitation to ask for.
  const token = linkToken(useRouteParams("invitation").token);
  const invitation = useApiQuery("getInvitation", token === undefined ? undefined : { invitationId: token }, {
    enabled: token !== undefined,
    retry: false,
  });
  const { me, isLoading, failed, error, retry } = useSession();

  if (token === undefined) return <Gone token={undefined} />;

  if (invitation.isPending || isLoading) {
    return (
      <AccountPage title={t("invite.loading")}>
        <Spinner label={common("state.loading")} />
      </AccountPage>
    );
  }
  if (failed) {
    return (
      <AccountPage title={t("invite.failed.title")}>
        <LoadFailed error={error} onRetry={retry} />
      </AccountPage>
    );
  }
  if (invitation.isError) {
    if (invitation.error.rawCode === "invitation.used") {
      return <Used hasSession={me !== null && me !== undefined} />;
    }
    return (
      <AccountPage title={t("invite.failed.title")}>
        <p role="alert">{describe(invitation.error)}</p>
        <div className="acct__actions">
          <Button size="lg" onClick={() => void invitation.refetch()}>
            {common("action.retry")}
          </Button>
        </div>
      </AccountPage>
    );
  }
  // The client answers null for an invitation that does not exist, has expired or was withdrawn.
  if (invitation.data === null) return <Gone token={token} />;
  return <Open token={token} invitation={invitation.data} me={me} />;
}

function Facts({ invitation }: { invitation: InvitationPreview }) {
  const t = useMessages("account");
  const day = useDay();
  return (
    <dl className="acct__facts">
      <div>
        <dt>{t("invite.detail.role")}</dt>
        <dd>{t(`invite.role.${invitation.role}`)}</dd>
      </div>
      {invitation.invitedByName !== null && (
        <div>
          <dt>{t("invite.detail.invitedBy")}</dt>
          <dd>{invitation.invitedByName}</dd>
        </div>
      )}
      {invitation.email !== null && (
        <div>
          <dt>{t("invite.detail.email")}</dt>
          <dd className="acct__data">{invitation.email}</dd>
        </div>
      )}
      <div>
        <dt>{t("invite.detail.expires")}</dt>
        <dd>{day(invitation.expiresAt)}</dd>
      </div>
    </dl>
  );
}

function Open({
  token,
  invitation,
  me,
}: {
  token: string;
  invitation: InvitationPreview;
  me: Me | null | undefined;
}) {
  const t = useMessages("account");
  const { api } = useVanrClient();
  const go = useGo();
  const signOut = useSignOut();
  const completeSignIn = useCompleteSignIn();
  const here = href("invitation", { token });
  const carried = { redirect: here, ...(invitation.email !== null && { email: invitation.email }) };
  const [gone, setGone] = useState(false);

  const accept = useSubmit(async ({ signal }) => {
    try {
      const { workspaceId } = await api.acceptInvitation({ invitationId: token }, { signal });
      await completeSignIn();
      await go("home", { workspaceId }, { replace: true });
    } catch (cause) {
      // Expired or withdrawn between the preview and the click.
      if (isApiError(cause) && cause.status === 404) setGone(true);
      else throw cause;
    }
  });
  const switchAccount = useSubmit(() => signOut(carried));

  if (gone) return <Gone token={token} />;

  const member = me?.workspaces.some((workspace) => workspace.id === invitation.workspaceId) === true;
  const wrongEmail =
    me !== null &&
    me !== undefined &&
    !member &&
    ((invitation.email !== null && invitation.email !== me.user.email.toLowerCase()) ||
      (isApiError(accept.error) && accept.error.rawCode === "invitation.wrong_email"));

  return (
    <AccountPage title={t("invite.title", { workspace: invitation.workspaceName })}>
      <Facts invitation={invitation} />
      {me === null && (
        <>
          <p className="acct__why">
            {invitation.email === null
              ? t("invite.guest.why")
              : t("invite.guest.whyEmail", { email: invitation.email })}
          </p>
          <div className="acct__actions">
            <Button variant="primary" size="lg" onClick={() => void go("login", {}, { search: carried })}>
              {t("invite.guest.signIn")}
            </Button>
            <AppLink className="app-link" route="signup" params={{}} search={carried}>
              {t("invite.guest.signUp")}
            </AppLink>
          </div>
        </>
      )}
      {me !== null && me !== undefined && member && (
        <>
          <p className="acct__why">{t("invite.member.body", { workspace: invitation.workspaceName })}</p>
          <div className="acct__actions">
            <Button
              variant="primary"
              size="lg"
              onClick={() => void go("home", { workspaceId: invitation.workspaceId })}
            >
              {t("invite.member.action", { workspace: invitation.workspaceName })}
            </Button>
          </div>
        </>
      )}
      {me !== null && me !== undefined && wrongEmail && (
        <>
          <Callout tone="warning">
            {t("invite.wrongEmail.body", {
              invited: invitation.email ?? invitation.workspaceName,
              current: me.user.email,
            })}
          </Callout>
          <ServerProblem
            error={switchAccount.error}
            waitUntil={switchAccount.waitUntil}
            onRetry={() => void switchAccount.run()}
          />
          <div className="acct__actions">
            <Button size="lg" loading={switchAccount.busy} onClick={() => void switchAccount.run()}>
              {t("invite.wrongEmail.action")}
            </Button>
          </div>
        </>
      )}
      {me !== null && me !== undefined && !member && !wrongEmail && (
        <>
          <p className="acct__why">{t("invite.accept.why", { email: me.user.email })}</p>
          <ServerProblem
            error={accept.error}
            waitUntil={accept.waitUntil}
            onRetry={() => void accept.run()}
          />
          <div className="acct__actions">
            <Button variant="primary" size="lg" loading={accept.busy} onClick={() => void accept.run()}>
              {t("invite.accept.submit")}
            </Button>
          </div>
        </>
      )}
    </AccountPage>
  );
}

/** Expired, withdrawn or unknown: the person can ask whoever invited them for another. */
function Gone({ token }: { token: string | undefined }) {
  const t = useMessages("account");
  const { api } = useVanrClient();
  const [asked, setAsked] = useState(false);
  const ask = useSubmit(async ({ signal }) => {
    if (token === undefined) return;
    await api.requestInvitationNew({ invitationId: token }, { signal });
    setAsked(true);
  });
  return (
    <AccountPage title={t("invite.gone.title")} why={t("invite.gone.body")}>
      {asked ? (
        <p role="status">{t("invite.gone.requested")}</p>
      ) : (
        // Without a token there is nothing to ask a new one for.
        token !== undefined && (
          <>
            <ServerProblem error={ask.error} waitUntil={ask.waitUntil} onRetry={() => void ask.run()} />
            <div className="acct__actions">
              <Button variant="primary" size="lg" loading={ask.busy} onClick={() => void ask.run()}>
                {t("invite.gone.action")}
              </Button>
            </div>
          </>
        )
      )}
    </AccountPage>
  );
}

/** Already used: asking for another does not apply to it. */
function Used({ hasSession }: { hasSession: boolean }) {
  const t = useMessages("account");
  return (
    <AccountPage title={t("invite.used.title")} why={hasSession ? undefined : t("invite.used.body")}>
      {!hasSession && (
        <p>
          <AppLink className="app-link" route="login" params={{}}>
            {t("invite.used.action")}
          </AppLink>
        </p>
      )}
    </AccountPage>
  );
}
