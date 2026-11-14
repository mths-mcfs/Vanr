import { useVanrClient } from "@vanr/client/react";
import type { Me } from "@vanr/contract";
import { Button, Field, Input, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useGo } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useCompleteSignIn, useDraft, useSession, useSignOut } from "../../session/react.tsx";
import { AccountForm, AccountPage, ServerProblem, useSubmit } from "./shared.tsx";

/** The browser's time zone, for the workspace's schedule; UTC when the browser will not say. */
function browserTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * `/onboarding`: the first workspace of an account, or another one. What is typed is kept as a
 * draft, so a session that ends in the middle does not cost the person the text.
 */
export function NewWorkspaceScreen() {
  const { me } = useSession();
  return <NewWorkspaceForm key={me?.user.id} me={me} />;
}

function NewWorkspaceForm({ me }: { me: Me | null | undefined }) {
  const t = useMessages("account");
  const common = useMessages("common");
  const { api } = useVanrClient();
  const go = useGo();
  const signOut = useSignOut();
  const leave = useSubmit(() => signOut());
  const completeSignIn = useCompleteSignIn();
  const [name, setName, discardName] = useDraft("onboarding.name");
  const [context, setContext, discardContext] = useDraft("onboarding.context");
  const [checked, setChecked] = useState(false);
  const [createdId, setCreatedId] = useState<string>();
  const nameError = name.trim() === "" ? ("validation.workspaceNameRequired" as const) : undefined;

  const submit = useSubmit(async ({ signal }) => {
    let workspaceId = createdId;
    if (workspaceId === undefined) {
      const { workspace } = await api.createWorkspace(
        {
          body: {
            name: name.trim(),
            ...(context.trim() !== "" && { context: context.trim() }),
            timezone: browserTimeZone(),
          },
        },
        { signal },
      );
      workspaceId = workspace.id;
      setCreatedId(workspaceId);
    }
    await completeSignIn();
    discardName();
    discardContext();
    await go("home", { workspaceId }, { replace: true });
  });

  return (
    <AccountPage
      title={t("workspace.title")}
      why={t("workspace.why")}
      footer={
        me !== null &&
        me !== undefined && (
          <>
            {t("workspace.signedInAs", { email: me.user.email })}{" "}
            <button
              type="button"
              className="app-link-button"
              disabled={leave.busy}
              onClick={() => void leave.run()}
            >
              {t("workspace.signOut")}
            </button>
          </>
        )
      }
    >
      <ServerProblem error={leave.error} waitUntil={leave.waitUntil} onRetry={() => void leave.run()} />
      <AccountForm
        onSubmit={() => {
          setChecked(true);
          if (createdId !== undefined || nameError === undefined) void submit.run();
        }}
      >
        <Field
          label={t("workspace.name")}
          error={checked && nameError !== undefined ? t(nameError) : undefined}
        >
          <Input
            size="lg"
            name="workspace"
            autoComplete="off"
            value={name}
            disabled={createdId !== undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t("workspace.context")} hint={t("workspace.contextHint")}>
          <Textarea
            name="context"
            rows={3}
            value={context}
            disabled={createdId !== undefined}
            onChange={(event) => setContext(event.target.value)}
          />
        </Field>
        <ServerProblem error={submit.error} waitUntil={submit.waitUntil} onRetry={() => void submit.run()} />
        <div className="acct__actions">
          <Button type="submit" variant="primary" size="lg" loading={submit.busy}>
            {createdId === undefined ? t("workspace.submit") : common("action.retry")}
          </Button>
        </div>
      </AccountForm>
    </AccountPage>
  );
}
