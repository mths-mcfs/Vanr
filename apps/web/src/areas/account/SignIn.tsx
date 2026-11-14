import { Button, Callout, Field, Input } from "@vanr/ui";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useApi, useApiQuery } from "../../api/index.ts";
import { useRuntime } from "../../app/context.tsx";
import { AppLink, useGo, useGoToAddress, useSearch } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useCompleteSignIn } from "../../session/react.tsx";
import { safeRedirect } from "../../session/redirect.ts";
import { startAddress } from "../../session/session.ts";
import { AccountForm, AccountPage, emailProblem, ServerProblem, useSubmit } from "./shared.tsx";

const Search = z.object({
  redirect: z.string().optional(),
  email: z.string().optional(),
  reason: z.enum(["signed_out", "ended", "password_changed"]).optional(),
});
const NO_SEARCH: z.infer<typeof Search> = {};

const NOTICE = {
  signed_out: "signIn.notice.signedOut",
  ended: "signIn.notice.sessionEnded",
  password_changed: "signIn.notice.passwordChanged",
} as const;

export function SignInScreen() {
  const t = useMessages("account");
  const api = useApi();
  const { store } = useRuntime();
  const search = useSearch(Search, NO_SEARCH);
  const go = useGo();
  const goToAddress = useGoToAddress();
  const completeSignIn = useCompleteSignIn();
  const config = useApiQuery("getAuthConfig", undefined, { staleTime: 60_000 });
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const emailError = emailProblem(email);
  const passwordError = password === "" ? ("validation.passwordRequired" as const) : undefined;

  // An installation without accounts has nobody to sign in: the first screen is creating one.
  const firstRun = config.data?.firstRun === true;
  useEffect(() => {
    if (firstRun) void go("signup", {}, { replace: true });
  }, [firstRun, go]);

  const submit = useSubmit(async () => {
    await api.signIn({ email: email.trim(), password });
    const me = await completeSignIn();
    if (me === null) throw new Error("signed in, but the server sees no session");
    await goToAddress(safeRedirect(search.redirect) ?? startAddress(store, me), { replace: true });
  });

  const carried = {
    ...(search.redirect !== undefined && { redirect: search.redirect }),
    ...(email.trim() !== "" && { email: email.trim() }),
  };

  return (
    <AccountPage
      title={t("signIn.title")}
      why={t("signIn.why")}
      footer={
        <>
          {t("signIn.toSignUp.lead")}{" "}
          <AppLink className="app-link" route="signup" params={{}} search={carried}>
            {t("signIn.toSignUp.link")}
          </AppLink>
        </>
      }
    >
      {search.reason !== undefined && (
        <Callout tone="info" role="status">
          {t(NOTICE[search.reason])}
        </Callout>
      )}
      <AccountForm
        onSubmit={() => {
          setChecked(true);
          if (emailError === undefined && passwordError === undefined) void submit.run();
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
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field
          label={t("field.password")}
          error={checked && passwordError !== undefined ? t(passwordError) : undefined}
        >
          <Input
            size="lg"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <ServerProblem
          error={submit.error}
          failureTime={submit.failureTime}
          onRetry={() => void submit.run()}
        />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {t("signIn.submit")}
          </Button>
          <AppLink
            className="app-link"
            route="forgotPassword"
            params={{}}
            {...(email.trim() !== "" && { search: { email: email.trim() } })}
          >
            {t("signIn.forgot")}
          </AppLink>
        </div>
      </AccountForm>
    </AccountPage>
  );
}
