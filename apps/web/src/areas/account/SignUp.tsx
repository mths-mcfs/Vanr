import { Button, Field, Input, Spinner } from "@vanr/ui";
import { useState } from "react";
import { z } from "zod";
import { useApi, useApiQuery } from "../../api/index.ts";
import { useRuntime } from "../../app/context.tsx";
import { AppLink, useGoToAddress, useSearch } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useCompleteSignIn } from "../../session/react.tsx";
import { safeRedirect } from "../../session/redirect.ts";
import { startAddress } from "../../session/session.ts";
import {
  AccountForm,
  AccountPage,
  emailProblem,
  LoadFailed,
  newPasswordProblem,
  PASSWORD_MAX,
  ServerProblem,
  useSubmit,
} from "./shared.tsx";
import { WaitlistForm } from "./Waitlist.tsx";

const Search = z.object({ redirect: z.string().optional(), email: z.string().optional() });
const NO_SEARCH: z.infer<typeof Search> = {};

/** The invitation token in an address like `/invite/<token>`, when the person came from one. */
export function invitationTokenIn(address: string | undefined): string | undefined {
  const match = /^\/invite\/([^/?#]+)/.exec(safeRedirect(address) ?? "");
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

export function SignUpScreen() {
  const t = useMessages("account");
  const search = useSearch(Search, NO_SEARCH);
  const config = useApiQuery("getAuthConfig", undefined, { staleTime: 60_000 });
  const token = invitationTokenIn(search.redirect);
  const invitation = useApiQuery(
    "getInvitation",
    { invitationId: token ?? "" },
    { enabled: token !== undefined, retry: false, staleTime: 60_000 },
  );

  if (config.isPending || (token !== undefined && invitation.isPending)) {
    return (
      <AccountPage title={t("signUp.title")}>
        <Spinner size="lg" label={t("signUp.title")} />
      </AccountPage>
    );
  }
  if (config.isError) {
    return (
      <AccountPage title={t("signUp.title")}>
        <LoadFailed error={config.error} onRetry={() => void config.refetch()} />
      </AccountPage>
    );
  }
  const invited = invitation.data;
  if (invited === undefined && !config.data.signupOpen && !config.data.firstRun) {
    return <WaitlistForm email={search.email} redirect={search.redirect} />;
  }
  const why =
    invited !== undefined
      ? t("signUp.why.invited", { workspace: invited.workspaceName })
      : config.data.firstRun
        ? t("signUp.why.first")
        : t("signUp.why.open");
  return <SignUpForm why={why} email={invited?.email ?? search.email} redirect={search.redirect} />;
}

function SignUpForm({
  why,
  email: startEmail,
  redirect,
}: {
  why: string;
  email: string | undefined;
  redirect: string | undefined;
}) {
  const t = useMessages("account");
  const api = useApi();
  const { store } = useRuntime();
  const goToAddress = useGoToAddress();
  const completeSignIn = useCompleteSignIn();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(startEmail ?? "");
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const nameError = name.trim() === "" ? ("validation.nameRequired" as const) : undefined;
  const emailError = emailProblem(email);
  const passwordError = newPasswordProblem(password);

  const submit = useSubmit(async () => {
    await api.signUp({ name: name.trim(), email: email.trim(), password });
    const me = await completeSignIn();
    if (me === null) throw new Error("signed up, but the server sees no session");
    await goToAddress(safeRedirect(redirect) ?? startAddress(store, me), { replace: true });
  });

  return (
    <AccountPage
      title={t("signUp.title")}
      why={why}
      foot={
        <>
          {t("signUp.toSignIn.lead")}{" "}
          <AppLink
            className="app-link"
            route="login"
            params={{}}
            search={{
              ...(redirect !== undefined && { redirect }),
              ...(email.trim() !== "" && { email: email.trim() }),
            }}
          >
            {t("signUp.toSignIn.link")}
          </AppLink>
        </>
      }
    >
      <AccountForm
        onSubmit={() => {
          setChecked(true);
          if (nameError === undefined && emailError === undefined && passwordError === undefined)
            void submit.run();
        }}
      >
        <Field label={t("field.name")} error={checked && nameError !== undefined ? t(nameError) : undefined}>
          <Input
            size="lg"
            name="name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
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
        <ServerProblem error={submit.error} failedAt={submit.failedAt} onRetry={() => void submit.run()} />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {t("signUp.submit")}
          </Button>
        </div>
      </AccountForm>
    </AccountPage>
  );
}
