import { useVanrClient } from "@vanr/client/react";
import { Button, Field, Input, Spinner } from "@vanr/ui";
import { useState } from "react";
import { z } from "zod";
import { AppLink, useSearch } from "../../app/navigation.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { AccountForm, AccountPage, emailProblem, ServerProblem, useOnce, useSubmit } from "./shared.tsx";

/** Sign-up is closed and the person has no invitation: they can leave an email. */
export function WaitlistForm({
  email: startEmail,
  redirect,
}: {
  email: string | undefined;
  redirect: string | undefined;
}) {
  const t = useMessages("account");
  const { api } = useVanrClient();
  const { locale } = useLocale();
  const [email, setEmail] = useState(startEmail ?? "");
  const [checked, setChecked] = useState(false);
  const [joined, setJoined] = useState<string | undefined>();
  const emailError = emailProblem(email);

  const submit = useSubmit(async () => {
    await api.createWaitlist({ body: { email: email.trim(), locale } });
    setJoined(email.trim());
  });

  const footer = (
    <>
      {t("signUp.toSignIn.lead")}{" "}
      <AppLink
        className="app-link"
        route="login"
        params={{}}
        {...(redirect !== undefined && { search: { redirect } })}
      >
        {t("signUp.toSignIn.link")}
      </AppLink>
    </>
  );

  if (joined !== undefined) {
    return (
      <AccountPage
        title={t("waitlist.done.title")}
        why={t("waitlist.done.body", { email: joined })}
        footer={footer}
      />
    );
  }
  return (
    <AccountPage title={t("waitlist.title")} why={t("waitlist.why")} footer={footer}>
      <AccountForm
        onSubmit={() => {
          setChecked(true);
          if (emailError === undefined) void submit.run();
        }}
      >
        <Field
          label={t("field.email")}
          error={checked && emailError !== undefined ? t(emailError) : undefined}
        >
          <Input
            size="lg"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <ServerProblem
          error={submit.error}
          failureTime={submit.failureTime}
          onRetry={() => void submit.run()}
        />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {t("waitlist.submit")}
          </Button>
        </div>
      </AccountForm>
    </AccountPage>
  );
}

const ConfirmSearch = z.object({ confirm: z.string().optional() });
const NO_SEARCH: z.infer<typeof ConfirmSearch> = {};

/** The address in the waitlist email: `/?confirm=<token>`. Confirming twice is harmless. */
export function WaitlistConfirmScreen() {
  const t = useMessages("account");
  const { confirm } = useSearch(ConfirmSearch, NO_SEARCH);
  const { api } = useVanrClient();
  const confirmation = useOnce(confirm ?? "", confirm !== undefined, () =>
    api.confirmWaitlist({ body: { token: confirm ?? "" } }),
  );
  if (confirmation === "done") {
    return <AccountPage title={t("waitlist.confirm.done.title")} why={t("waitlist.confirm.done.body")} />;
  }
  if (confirmation === "failed" || confirmation === "idle") {
    return (
      <AccountPage title={t("waitlist.confirm.failed.title")} why={t("waitlist.confirm.failed.body")}>
        <p>
          <AppLink className="app-link" route="signup" params={{}}>
            {t("waitlist.confirm.again")}
          </AppLink>
        </p>
      </AccountPage>
    );
  }
  return (
    <AccountPage title={t("waitlist.confirm.working")}>
      <Spinner size="lg" label={t("waitlist.confirm.working")} />
    </AccountPage>
  );
}
