import { isApiError } from "@vanr/client";
import { Button, Field, Input } from "@vanr/ui";
import { useState } from "react";
import { z } from "zod";
import { useAuth } from "../../api/index.ts";
import { useRuntime } from "../../app/context.tsx";
import { AppLink, useGo, useSearch } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { href } from "../../routes.ts";
import { linkToken } from "../../session/redirect.ts";
import {
  AccountForm,
  AccountPage,
  emailProblem,
  newPasswordProblem,
  PASSWORD_MAX,
  ServerProblem,
  useSubmit,
} from "./shared.tsx";

const ForgotSearch = z.object({ email: z.string().optional() });
const NO_FORGOT: z.infer<typeof ForgotSearch> = {};

/** Asks for the email that gets the reset link. The answer is the same whether or not an account uses it. */
export function ForgotPasswordScreen() {
  const t = useMessages("account");
  const auth = useAuth();
  const { origin } = useRuntime();
  const search = useSearch(ForgotSearch, NO_FORGOT);
  const [email, setEmail] = useState(search.email ?? "");
  const [checked, setChecked] = useState(false);
  const [sentTo, setSentTo] = useState<string | undefined>();
  const emailError = emailProblem(email);
  const submit = useSubmit(async ({ signal }) => {
    await auth.requestPasswordReset(
      { body: { email: email.trim(), redirectTo: `${origin}${href("resetPassword", {})}` } },
      { signal },
    );
    setSentTo(email.trim());
  });
  const back = (
    <AppLink className="app-link" route="login" params={{}}>
      {t("forgot.back")}
    </AppLink>
  );
  if (sentTo !== undefined) {
    return (
      <AccountPage
        title={t("forgot.sent.title")}
        why={t("forgot.sent.body", { email: sentTo })}
        footer={back}
      />
    );
  }
  return (
    <AccountPage title={t("forgot.title")} why={t("forgot.why")} footer={back}>
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
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <ServerProblem error={submit.error} waitUntil={submit.waitUntil} onRetry={() => void submit.run()} />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {t("forgot.submit")}
          </Button>
        </div>
      </AccountForm>
    </AccountPage>
  );
}

const ResetSearch = z.object({ token: z.string().optional(), error: z.string().optional() });
const NO_RESET: z.infer<typeof ResetSearch> = {};

/** Where the reset link ends: the token arrives in the address, or `error` when the link is spent. */
export function ResetPasswordScreen() {
  const t = useMessages("account");
  const auth = useAuth();
  const go = useGo();
  const search = useSearch(ResetSearch, NO_RESET);
  const token = search.error === undefined ? linkToken(search.token) : undefined;
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const passwordError = newPasswordProblem(password);
  const submit = useSubmit(async ({ signal }) => {
    await auth.resetPassword({ body: { token: token ?? "", newPassword: password } }, { signal });
    await go("login", {}, { search: { reason: "password_changed" }, replace: true });
  });
  const spent = isApiError(submit.error) && submit.error.rawCode === "invalid_token";
  if (token === undefined || spent) {
    return (
      <AccountPage title={t("reset.invalid.title")} why={t("reset.invalid.body")}>
        <p>
          <AppLink className="app-link" route="forgotPassword" params={{}}>
            {t("reset.invalid.action")}
          </AppLink>
        </p>
      </AccountPage>
    );
  }
  return (
    <AccountPage title={t("reset.title")} why={t("reset.why")}>
      <AccountForm
        onSubmit={() => {
          setChecked(true);
          if (passwordError === undefined) void submit.run();
        }}
      >
        <Field
          label={t("field.newPassword")}
          {...(!(checked && passwordError !== undefined) && { hint: t("field.passwordHint") })}
          error={checked && passwordError !== undefined ? t(passwordError) : undefined}
        >
          <Input
            size="lg"
            type="password"
            name="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <ServerProblem error={submit.error} waitUntil={submit.waitUntil} onRetry={() => void submit.run()} />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {t("reset.submit")}
          </Button>
        </div>
      </AccountForm>
    </AccountPage>
  );
}
