// How the signed-in person appears in this workspace: their name, their handle (what others type
// after @) and their own time zone, or the workspace's when they leave it empty.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Person } from "@vanr/contract";
import { Avatar, Button, Callout, Field, Input, Surface } from "@vanr/ui";
import { type FormEvent, useState } from "react";
import { useRuntime } from "../../../app/context.tsx";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useSession } from "../../../session/react.tsx";
import {
  isTimeZone,
  SectionError,
  SectionLoading,
  timeZones,
  useOutcome,
  useWorkspaceAccess,
} from "./shared.tsx";

// The server's rules (routes/workspaces.ts and HANDLE_RE in the engine).
const NAME_MAX = 80;
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

type Draft = { name: string; handle: string; timezone: string };

export function ProfileSection() {
  const t = useMessages("settings");
  const { workspaceId } = useWorkspaceAccess();
  const { me } = useSession();
  const people = useApiQuery("getPeople", { workspaceId });

  if (people.isPending) return <SectionLoading />;
  if (people.isError) {
    return (
      <SectionError title={t("profile.failed")} error={people.error} onRetry={() => void people.refetch()} />
    );
  }
  const mine = people.data.find((person) => person.userId === me?.user.id);
  if (mine === undefined) {
    return (
      <SectionError title={t("profile.failed")} error={undefined} onRetry={() => void people.refetch()} />
    );
  }
  return <ProfileForm workspaceId={workspaceId} person={mine} />;
}

function ProfileForm({ workspaceId, person }: { workspaceId: string; person: Person }) {
  const t = useMessages("settings");
  const { session } = useRuntime();
  const outcome = useOutcome();
  const describe = useErrorMessage("settings");
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useApiMutation("updateMe", {
    invalidates: () => [
      { method: "getPeople", args: { workspaceId } },
      { method: "listMembers", args: { workspaceId } },
    ],
  });
  const value: Draft = draft ?? { name: person.name, handle: person.handle, timezone: person.timezone ?? "" };
  const handle = value.handle.trim().toLowerCase();
  const nameError = value.name.trim() === "" ? t("profile.nameRequired") : undefined;
  const handleError = HANDLE.test(handle) ? undefined : t("profile.handleInvalid");
  const timezoneError =
    value.timezone.trim() === "" || isTimeZone(value.timezone.trim())
      ? undefined
      : t("general.timezoneInvalid");
  const handleTaken = isApiError(save.error) && save.error.rawCode === "handle.taken";
  const invalid = nameError !== undefined || handleError !== undefined || timezoneError !== undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || invalid) return;
    const timezone = value.timezone.trim();
    const sent = draft;
    save.mutate(
      {
        workspaceId,
        body: { name: value.name.trim(), handle, timezone: timezone === "" ? null : timezone },
      },
      {
        onSuccess: async () => {
          // An edit made while this was saving stays a draft.
          setDraft((current) => (current === sent ? null : current));
          // The account menu shows the name from the session.
          if (value.name.trim() !== person.name) await session.load(true);
          outcome.done(t("profile.saved"));
        },
      },
    );
  };

  return (
    <Surface variant="card" className="section-card">
      <div className="profile-head">
        <Avatar
          name={value.name || person.name}
          src={person.avatarUrl ?? person.image ?? undefined}
          size="lg"
        />
        <div>
          <p className="listing__name">{person.name}</p>
          <p className="page__muted">{person.email}</p>
        </div>
      </div>
      <form className="section-form" onSubmit={submit} aria-label={t("profile.formLabel")} noValidate>
        <Field label={t("profile.name")} error={nameError}>
          <Input
            value={value.name}
            maxLength={NAME_MAX}
            autoComplete="name"
            onChange={(event) => setDraft({ ...value, name: event.target.value })}
          />
        </Field>
        <Field label={t("profile.handle")} hint={t("profile.handleHint")} error={handleError}>
          <Input
            mono
            value={value.handle}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft({ ...value, handle: event.target.value })}
          />
        </Field>
        <Field label={t("profile.timezone")} hint={t("profile.timezoneHint")} error={timezoneError}>
          <Input
            value={value.timezone}
            maxLength={64}
            autoComplete="off"
            list="profile-time-zones"
            onChange={(event) => setDraft({ ...value, timezone: event.target.value })}
          />
        </Field>
        <datalist id="profile-time-zones">
          {timeZones().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {save.isError && (
          <Callout tone="danger" role="alert" title={t("profile.saveFailed")}>
            {handleTaken ? t("profile.handleTaken", { handle }) : describe(save.error)}
          </Callout>
        )}
        {draft !== null && (
          <div className="section-form__actions">
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("action.discard")}
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={invalid}>
              {t("action.save")}
            </Button>
          </div>
        )}
      </form>
    </Surface>
  );
}
