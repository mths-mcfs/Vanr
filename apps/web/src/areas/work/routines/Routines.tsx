// The routines the person can see: what each one does, with which agent, when and where it answers,
// when it runs next and how its last run went. Whoever created one, and whoever sets the workspace up,
// turns it on or off, runs it now, duplicates it and deletes it. No event tells this screen about a run,
// so it reads the list every 3 seconds while one is running and every minute otherwise.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Routine } from "@vanr/contract";
import { Button, Chip, ConfirmDialog, EmptyState, Switch } from "@vanr/ui";
import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import { useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { type Actors, useActors, useConfigures, useMyId, useOutcome } from "../issues/shared.tsx";
import { NewRoutineDialog } from "./NewRoutine.tsx";
import { RoutineDetails } from "./RoutineDetails.tsx";
import { useTargetText, useTriggerText } from "./words.ts";

export const RUNNING_REFRESH_MS = 3_000;
const IDLE_REFRESH_MS = 60_000;

export function RoutinesScreen() {
  const { workspaceId } = useRouteParams("routines");
  return <RoutinesView key={workspaceId} workspaceId={workspaceId} />;
}

function RoutinesView({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("work");
  const shell = useMessages("shell");
  const actors = useActors(workspaceId);
  const [creating, setCreating] = useState(false);
  useDocumentTitle(shell("route.routines"));
  const routines = useApiQuery(
    "listRoutines",
    { workspaceId },
    {
      refetchInterval: (query) =>
        query.state.data?.some((routine) => routine.running) ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS,
    },
  );
  const channels = useApiQuery("listChannels", { workspaceId });

  if (routines.isPending) return <ScreenLoading />;
  if (routines.isError && routines.data === undefined) {
    return (
      <ScreenError
        title={t("routines.failed")}
        error={routines.error}
        onRetry={() => void routines.refetch()}
        namespace="work"
      />
    );
  }
  const noAgent = actors.reachable.length === 0;
  const add = (
    <Button variant="primary" icon={<Plus size={16} />} disabled={noAgent} onClick={() => setCreating(true)}>
      {t("routines.new")}
    </Button>
  );
  const channelName = (id: string) => channels.data?.find((channel) => channel.id === id)?.name;

  return (
    <div className="page page--wide work">
      <header className="work__head">
        <div>
          <h1 className="page__title">{shell("route.routines")}</h1>
          <p className="page__muted">{t("routines.lead")}</p>
        </div>
        {add}
      </header>
      {noAgent && <p className="work-note">{t("routines.noAgent")}</p>}
      {routines.data.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t("routines.empty.title")}
          description={t("routines.empty.body")}
          action={noAgent ? undefined : add}
        />
      ) : (
        <ul className="work-routines" aria-label={t("routines.list")}>
          {routines.data.map((routine) => (
            <li key={routine.id}>
              <RoutineCard
                workspaceId={workspaceId}
                routine={routine}
                actors={actors}
                channelName={channelName}
              />
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <NewRoutineDialog
          workspaceId={workspaceId}
          actors={actors}
          channels={channels.data ?? []}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function RoutineCard({
  workspaceId,
  routine,
  actors,
  channelName,
}: {
  workspaceId: string;
  routine: Routine;
  actors: Actors;
  channelName: (id: string) => string | undefined;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const { locale } = useLocale();
  const ago = useRelativeTime();
  const me = useMyId();
  const configures = useConfigures(workspaceId);
  const outcome = useOutcome();
  const triggerText = useTriggerText();
  const targetText = useTargetText();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mayEdit = routine.createdBy === me || configures;
  // A copy runs as the person who makes it: with an agent they may set to work, answering where they can write.
  const mayDuplicate =
    actors.reachable.some((agent) => agent.id === routine.agentId) &&
    (routine.target.kind !== "channel" || channelName(routine.target.channelId) !== undefined);
  const refresh = () => [
    { method: "listRoutines" as const, args: { workspaceId } },
    { method: "listRoutineRuns" as const, args: { workspaceId, routineId: routine.id } },
  ];
  const failed = (error: unknown) => outcome.failed(error);
  const toggle = useApiMutation("setRoutineEnabled", { invalidates: refresh, onError: failed });
  const run = useApiMutation("runRoutine", { invalidates: refresh, onError: failed });
  const duplicate = useApiMutation("duplicateRoutine", { invalidates: refresh, onError: failed });
  const remove = useApiMutation("deleteRoutine", { invalidates: refresh, onError: failed });
  const when = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const agentName = actors.name({ type: "agent", id: routine.agentId });

  return (
    <article className={routine.active ? "work-routine" : "work-routine is-paused"} aria-label={routine.name}>
      <header className="work-routine__head">
        <h2 className="work-routine__name">{routine.name}</h2>
        {routine.running && <Chip>{t("routines.running")}</Chip>}
        {routine.pausedReason === "failures" ? (
          <Chip>{t("routines.pausedFailures", { count: routine.policy.pauseAfterFailures })}</Chip>
        ) : (
          !routine.active && <Chip>{t("routines.paused")}</Chip>
        )}
        {mayEdit && (
          <Switch
            className="work-routine__switch"
            label={t("routines.active", { name: routine.name })}
            checked={routine.active}
            disabled={toggle.isPending}
            onCheckedChange={(active) =>
              toggle.mutate(
                { workspaceId, routineId: routine.id, body: { active } },
                {
                  onSuccess: () =>
                    outcome.done(
                      t(active ? "routines.enabled" : "routines.disabled", { name: routine.name }),
                    ),
                },
              )
            }
          />
        )}
      </header>
      <dl className="work-facts work-facts--inline">
        <dt>{t("routines.agent")}</dt>
        <dd>{agentName}</dd>
        <dt>{t("routines.trigger")}</dt>
        <dd>{triggerText(routine.trigger)}</dd>
        <dt>{t("routines.target")}</dt>
        <dd>{targetText(routine.target, channelName)}</dd>
      </dl>
      <p className="work-routine__prompt">{routine.prompt}</p>
      <p className="work-routine__times">
        {routine.nextFireAt === null
          ? t("routines.noNext")
          : t("routines.next", { when: when.format(new Date(routine.nextFireAt)) })}
        {routine.lastRun !== null && (
          <span>
            {t("routines.last", {
              when: ago(routine.lastRun.at),
              status: t(`routines.status.${routine.lastRun.status}`),
            })}
          </span>
        )}
      </p>
      <div className="work-routine__actions">
        {mayEdit && (
          <Button
            size="sm"
            loading={run.isPending}
            onClick={() =>
              run.mutate(
                { workspaceId, routineId: routine.id, body: { key: crypto.randomUUID() } },
                {
                  onSuccess: () => {
                    setOpen(true);
                    outcome.done(t("routines.started", { name: routine.name }));
                  },
                },
              )
            }
          >
            {t("routines.runNow")}
          </Button>
        )}
        {mayDuplicate && (
          <Button
            size="sm"
            variant="ghost"
            loading={duplicate.isPending}
            onClick={() =>
              duplicate.mutate(
                { workspaceId, routineId: routine.id, body: {} },
                { onSuccess: () => outcome.done(t("routines.duplicated", { name: routine.name })) },
              )
            }
          >
            {t("routines.duplicate")}
          </Button>
        )}
        {mayEdit && (
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            trigger={
              <Button size="sm" variant="ghost">
                {t("routines.delete")}
              </Button>
            }
            title={t("routines.deleteTitle", { name: routine.name })}
            description={t("routines.deleteBody")}
            confirmLabel={t("routines.delete")}
            cancelLabel={common("action.cancel")}
            tone="danger"
            confirming={remove.isPending}
            onConfirm={() =>
              remove.mutate(
                { workspaceId, routineId: routine.id },
                {
                  onSuccess: () => {
                    setDeleting(false);
                    outcome.done(t("routines.deleted", { name: routine.name }));
                  },
                },
              )
            }
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          className="work-routine__more"
          icon={<ChevronDown size={14} className={open ? "work-chevron is-open" : "work-chevron"} />}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t("routines.details", { name: routine.name })}
        </Button>
      </div>
      {open && <RoutineDetails workspaceId={workspaceId} routine={routine} mayEdit={mayEdit} />}
    </article>
  );
}
