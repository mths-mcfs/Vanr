// The workspace's name, the context its agents read and its time zone, and the approval reviewer.
// Every member can read them; only someone who may configure the workspace can change them.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { WorkspaceSettings } from "@vanr/contract";
import { Button, Callout, Field, Input, Surface, Switch, Textarea } from "@vanr/ui";
import { type FormEvent, useState } from "react";
import { useRuntime } from "../../../app/context.tsx";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import {
  isTimeZone,
  SectionError,
  SectionLoading,
  timeZones,
  useOutcome,
  useWorkspaceAccess,
} from "./shared.tsx";

// The server's limits (routes/workspaces.ts).
const NAME_MAX = 80;
const CONTEXT_MAX = 20_000;
const TIMEZONE_MAX = 64;
/** The context shows how much is left once it is this close to the limit. */
const CONTEXT_WARN = Math.floor(CONTEXT_MAX * 0.8);

type Draft = Pick<WorkspaceSettings, "name" | "context" | "timezone">;

export function GeneralSection() {
  const t = useMessages("settings");
  const { workspaceId, may } = useWorkspaceAccess();
  const settings = useApiQuery("getSettings", { workspaceId });

  if (settings.isPending) return <SectionLoading />;
  if (settings.isError) {
    return (
      <SectionError
        title={t("general.failed")}
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  const editable = may("configure");
  return (
    <>
      {!editable && <p className="page__muted">{t("general.readOnly")}</p>}
      <WorkspaceForm workspaceId={workspaceId} saved={settings.data} editable={editable} />
      <Reviewer workspaceId={workspaceId} on={settings.data.approvalReviewer} editable={editable} />
    </>
  );
}

function WorkspaceForm({
  workspaceId,
  saved,
  editable,
}: {
  workspaceId: string;
  saved: WorkspaceSettings;
  editable: boolean;
}) {
  const t = useMessages("settings");
  const { session } = useRuntime();
  const outcome = useOutcome();
  const describe = useErrorMessage("settings");
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useApiMutation("updateSettings", {
    invalidates: () => [
      { method: "getSettings", args: { workspaceId } },
      { method: "getWorkspace", args: { workspaceId } },
    ],
  });
  const value: Draft = draft ?? { name: saved.name, context: saved.context, timezone: saved.timezone };
  const nameError = value.name.trim() === "" ? t("general.nameRequired") : undefined;
  const timezoneError = isTimeZone(value.timezone) ? undefined : t("general.timezoneInvalid");
  const contextLeft = CONTEXT_MAX - value.context.length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || nameError !== undefined || timezoneError !== undefined) return;
    const sent = draft;
    save.mutate(
      { workspaceId, body: { ...draft, name: draft.name.trim() } },
      {
        onSuccess: async () => {
          // An edit made while this was saving stays a draft.
          setDraft((current) => (current === sent ? null : current));
          // The frame shows the workspace's name from the session.
          if (draft.name.trim() !== saved.name) await session.load(true);
          outcome.done(t("general.saved"));
        },
      },
    );
  };

  return (
    <Surface variant="card" className="section-card">
      <form className="section-form" onSubmit={submit} aria-label={t("general.formLabel")} noValidate>
        <Field label={t("general.name")} error={editable ? nameError : undefined}>
          <Input
            value={value.name}
            maxLength={NAME_MAX}
            readOnly={!editable}
            onChange={(event) => setDraft({ ...value, name: event.target.value })}
          />
        </Field>
        <Field
          label={t("general.context")}
          hint={
            value.context.length >= CONTEXT_WARN
              ? t("general.contextLeft", { count: contextLeft })
              : t("general.contextHint")
          }
        >
          <Textarea
            rows={6}
            value={value.context}
            maxLength={CONTEXT_MAX}
            readOnly={!editable}
            onChange={(event) => setDraft({ ...value, context: event.target.value })}
          />
        </Field>
        <Field
          label={t("general.timezone")}
          hint={t("general.timezoneHint")}
          error={editable ? timezoneError : undefined}
        >
          <Input
            value={value.timezone}
            maxLength={TIMEZONE_MAX}
            readOnly={!editable}
            autoComplete="off"
            list={editable ? "settings-time-zones" : undefined}
            onChange={(event) => setDraft({ ...value, timezone: event.target.value })}
          />
        </Field>
        {editable && (
          <datalist id="settings-time-zones">
            {timeZones().map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        )}
        {save.isError && (
          <Callout tone="danger" role="alert" title={t("general.saveFailed")}>
            {describe(save.error)}
          </Callout>
        )}
        {editable && draft !== null && (
          <div className="section-form__actions">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("action.discard")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={save.isPending}
              disabled={nameError !== undefined || timezoneError !== undefined}
            >
              {t("action.save")}
            </Button>
          </div>
        )}
      </form>
    </Surface>
  );
}

/** A small model decides the risk-flagged approval requests for the person. Off by default. */
function Reviewer({ workspaceId, on, editable }: { workspaceId: string; on: boolean; editable: boolean }) {
  const t = useMessages("settings");
  const outcome = useOutcome();
  const save = useApiMutation("updateSettings", {
    invalidates: () => [{ method: "getSettings", args: { workspaceId } }],
  });
  return (
    <Surface variant="card" className="section-card">
      <Switch
        label={t("general.reviewer")}
        hint={t("general.reviewerHint")}
        checked={on}
        disabled={!editable || save.isPending}
        onCheckedChange={(next) =>
          save.mutate(
            { workspaceId, body: { approvalReviewer: next } },
            {
              onSuccess: () => outcome.done(t(next ? "general.reviewerOn" : "general.reviewerOff")),
              onError: outcome.failed,
            },
          )
        }
      />
    </Surface>
  );
}
