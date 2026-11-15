import { useApiQuery } from "@vanr/client/react";
import { Button, Field, Input, Spinner } from "@vanr/ui";
import { useState } from "react";
import { z } from "zod";
import { useAuth } from "../../api/index.ts";
import { useRuntime } from "../../app/context.tsx";
import { AppLink, useGoToAddress, useSearch } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { href } from "../../routes.ts";
import { useCompleteSignIn } from "../../session/react.tsx";
import { invitationTokenIn, safeRedirect } from "../../session/redirect.ts";
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

export function SignUpScreen() {
  const t = useMessages("account");
  const search = useSearch(Search, NO_SEARCH);
  const config = useApiQuery("getAuthConfig", undefined, { staleTime: 60_000 });
  const token = invitationTokenIn(search.redirect);
  const invitation = useApiQuery("getInvitation", token === undefined ? undefined : { invitationId: token }, {
    enabled: token !== undefined,
    retry: false,
    staleTime: 60_000,
  });

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
  if (invitation.isError) {
    if (invitation.error.rawCode === "invitation.used") {
      return (
        <AccountPage title={t("invite.used.title")} why={t("invite.used.body")}>
          <AppLink className="app-link" route="login" params={{}}>
            {t("invite.used.action")}
          </AppLink>
        </AccountPage>
      );
    }
    return (
      <AccountPage title={t("signUp.title")}>
        <LoadFailed error={invitation.error} onRetry={() => void invitation.refetch()} />
      </AccountPage>
    );
  }
  // null: the invitation is gone, so the person is treated like anyone else.
  const invited = invitation.data ?? undefined;
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
  const auth = useAuth();
  const { store, origin } = useRuntime();
  const goToAddress = useGoToAddress();
  const completeSignIn = useCompleteSignIn();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(startEmail ?? "");
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const nameError = name.trim() === "" ? ("validation.nameRequired" as const) : undefined;
  const emailError = emailProblem(email);
  const passwordError = newPasswordProblem(password);

  const submit = useSubmit(async ({ signal }) => {
    await auth.signUp(
      {
        body: {
          name: name.trim(),
          email: email.trim(),
          password,
          callbackURL: `${origin}${href("verifyEmail", {})}`,
        },
      },
      { signal },
    );
    const me = await completeSignIn();
    if (me === null) throw new Error("signed up, but the server sees no session");
    await goToAddress(safeRedirect(redirect) ?? startAddress(store, me), { replace: true });
  });

  return (
    <AccountPage
      title={t("signUp.title")}
      why={why}
      footer={
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
        <ServerProblem error={submit.error} waitUntil={submit.waitUntil} onRetry={() => void submit.run()} />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {t("signUp.submit")}
          </Button>
        </div>
      </AccountForm>
    </AccountPage>
  );
}
