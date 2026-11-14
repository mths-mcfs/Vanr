import { Button, Spinner } from "@vanr/ui";
import { useState } from "react";
import { z } from "zod";
import { useAuth } from "../../api/index.ts";
import { useRuntime } from "../../app/context.tsx";
import { AppLink, useSearch } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { href } from "../../routes.ts";
import { useSession } from "../../session/react.tsx";
import { linkToken } from "../../session/redirect.ts";
import { AccountPage, ServerProblem, useOnce, useSubmit } from "./shared.tsx";

const Search = z.object({ token: z.string().optional(), error: z.string().optional() });
const NO_SEARCH: z.infer<typeof Search> = {};

/**
 * Where the link in the confirmation email ends. With a token, the web confirms it; without one,
 * the server already did and sent the person here, with `error` when the link did not work.
 */
export function VerifyEmailScreen() {
  const t = useMessages("account");
  const search = useSearch(Search, NO_SEARCH);
  const auth = useAuth();
  const token = linkToken(search.token);
  const verification = useOnce(token ?? "", token !== undefined, () =>
    auth.verifyEmail({ query: { token: token ?? "" } }),
  );
  const failed =
    token === undefined
      ? search.error !== undefined || search.token !== undefined
      : verification === "failed";
  if (failed) return <LinkFailed />;
  if (verification === "working") {
    return (
      <AccountPage title={t("verify.working")}>
        <Spinner size="lg" label={t("verify.working")} />
      </AccountPage>
    );
  }
  return (
    <AccountPage title={t("verify.done.title")} why={t("verify.done.body")}>
      <p>
        <AppLink className="app-link" route="root" params={{}}>
          {t("verify.done.continue")}
        </AppLink>
      </p>
    </AccountPage>
  );
}

function LinkFailed() {
  const t = useMessages("account");
  const auth = useAuth();
  const { origin } = useRuntime();
  const { me } = useSession();
  const [sentTo, setSentTo] = useState<string | undefined>();
  const resend = useSubmit(async ({ signal }) => {
    if (me === null || me === undefined) return;
    await auth.sendVerificationEmail(
      { body: { email: me.user.email, callbackURL: `${origin}${href("verifyEmail", {})}` } },
      { signal },
    );
    setSentTo(me.user.email);
  });
  return (
    <AccountPage title={t("verify.failed.title")} why={t("verify.failed.body")}>
      {sentTo !== undefined ? (
        <p role="status">{t("verify.resent", { email: sentTo })}</p>
      ) : me === null ? (
        <p>
          <AppLink
            className="app-link"
            route="login"
            params={{}}
            search={{ redirect: href("verifyEmail", {}, { error: "expired" }) }}
          >
            {t("verify.signInFirst")}
          </AppLink>
        </p>
      ) : (
        me !== undefined && (
          <>
            <ServerProblem
              error={resend.error}
              waitUntil={resend.waitUntil}
              onRetry={() => void resend.run()}
            />
            <div className="acct__actions">
              <Button variant="primary" size="lg" loading={resend.busy} onClick={() => void resend.run()}>
                {t("verify.resend")}
              </Button>
            </div>
          </>
        )
      )}
    </AccountPage>
  );
}
