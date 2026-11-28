// What opens under a routine: what it costs, its last ten runs (read every 3 seconds while one is going)
// with a way into the conversation each happened in, and, for a webhook, its address and its secret,
// shown once when it is made.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Routine, RoutineRun } from "@vanr/contract";
import { Button, Chip, Dialog, DialogContent } from "@vanr/ui";
import { type ReactNode, useState } from "react";
import { AppLink } from "../../../app/navigation.tsx";
import { useLocale, useLookup, useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../issues/shared.tsx";
import { PartError, PartLoading } from "../parts.tsx";

const RUNS_SHOWN = 10;
const RUNS_REFRESH_MS = 3_000;
const unfinished = (run: RoutineRun) =>
  run.status === "pending" || run.status === "queued" || run.status === "running";

export function RoutineDetails({
  workspaceId,
  routine,
  mayEdit,
}: {
  workspaceId: string;
  routine: Routine;
  mayEdit: boolean;
}) {
  const t = useMessages("work");
  return (
    <div className="work-routine__details">
      <section className="work-section" aria-label={t("recur.instruction")}>
        <h3 className="work-subhead">{t("recur.instruction")}</h3>
        <p className="work-routine__full">{routine.prompt}</p>
      </section>
      <Cost workspaceId={workspaceId} routineId={routine.id} />
      <Runs workspaceId={workspaceId} routine={routine} />
      {routine.trigger.kind === "webhook" && (
        <Webhook workspaceId={workspaceId} routine={routine} mayEdit={mayEdit} />
      )}
    </div>
  );
}

function Cost({ workspaceId, routineId }: { workspaceId: string; routineId: string }) {
  const t = useMessages("work");
  const { locale } = useLocale();
  const estimate = useApiQuery("estimateRoutine", { workspaceId, routineId });
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  let body: ReactNode;
  if (estimate.isPending) body = <PartLoading />;
  else if (estimate.isError && estimate.data === undefined)
    body = (
      <PartError
        title={t("recur.cost.failed")}
        error={estimate.error}
        onRetry={() => void estimate.refetch()}
      />
    );
  else {
    const { upToUsd, recent } = estimate.data;
    const parts = [
      ...(upToUsd === null ? [] : [t("recur.cost.upTo", { value: usd.format(upToUsd) })]),
      ...(recent === null || recent.runs === 0
        ? []
        : [
            t("recur.cost.recent", {
              count: recent.runs,
              avg: usd.format(recent.avgUsd),
              max: usd.format(recent.maxUsd),
            }),
          ]),
    ];
    body = <p>{parts.length === 0 ? t("recur.cost.unknown") : parts.join(" ")}</p>;
  }
  return (
    <section className="work-section" aria-label={t("recur.cost")}>
      <h3 className="work-subhead">{t("recur.cost")}</h3>
      {body}
    </section>
  );
}

function Runs({ workspaceId, routine }: { workspaceId: string; routine: Routine }) {
  const t = useMessages("work");
  const { locale } = useLocale();
  const runs = useApiQuery(
    "listRoutineRuns",
    { workspaceId, routineId: routine.id },
    {
      refetchInterval: (query) =>
        routine.running || (query.state.data ?? []).some(unfinished) ? RUNS_REFRESH_MS : false,
    },
  );
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const lookup = useLookup("work");
  // The server's key read in the person's language; its own words when the key isn't one known here.
  const summaryOf = (run: RoutineRun) =>
    (run.summaryKey === null
      ? undefined
      : lookup(`summary.${run.summaryKey}`, run.summaryVars ?? undefined)) ??
    run.summary ??
    "";
  let body: ReactNode;
  if (runs.isPending) body = <PartLoading />;
  else if (runs.isError && runs.data === undefined)
    body = (
      <PartError title={t("recur.runs.failed")} error={runs.error} onRetry={() => void runs.refetch()} />
    );
  else if (runs.data.length === 0) body = <p className="page__muted">{t("recur.runs.none")}</p>;
  else {
    body = (
      <ol className="work-runs" aria-label={t("recur.runs")}>
        {runs.data.slice(0, RUNS_SHOWN).map((run) => {
          const late =
            run.scheduledFor !== null && run.startedAt !== null
              ? Math.round((Date.parse(run.startedAt) - Date.parse(run.scheduledFor)) / 60_000)
              : 0;
          return (
            <li key={run.id} className={`work-run work-run--${run.status}`}>
              <Chip>{t(`recur.status.${run.status}`)}</Chip>
              <time dateTime={run.at}>{when.format(new Date(run.at))}</time>
              {run.trigger !== null && <span className="page__muted">{t(`recur.via.${run.trigger}`)}</span>}
              {run.attempt > 1 && (
                <span className="page__muted">{t("recur.run.attempt", { count: run.attempt })}</span>
              )}
              {late >= 2 && <span className="page__muted">{t("recur.run.late", { minutes: late })}</span>}
              {run.status === "queued" && run.notBefore !== null && (
                <span className="page__muted">
                  {t("recur.run.queued", { when: when.format(new Date(run.notBefore)) })}
                </span>
              )}
              {summaryOf(run) !== "" && <p className="work-run__summary">{summaryOf(run)}</p>}
              {run.channelId !== null &&
                (run.threadId !== null ? (
                  <AppLink
                    className="app-link"
                    route="thread"
                    params={{ workspaceId, threadId: run.threadId }}
                  >
                    {t("recur.run.session")}
                  </AppLink>
                ) : (
                  <AppLink
                    className="app-link"
                    route="channel"
                    params={{ workspaceId, channelId: run.channelId }}
                  >
                    {t("recur.run.session")}
                  </AppLink>
                ))}
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <section className="work-section" aria-label={t("recur.runs")}>
      <h3 className="work-subhead">{t("recur.runs")}</h3>
      {body}
    </section>
  );
}

function Webhook({
  workspaceId,
  routine,
  mayEdit,
}: {
  workspaceId: string;
  routine: Routine;
  mayEdit: boolean;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const outcome = useOutcome();
  const [secret, setSecret] = useState<string | null>(null);
  const make = useApiMutation("createRoutineWebhookSecret", {
    invalidates: () => [{ method: "listRoutines", args: { workspaceId } }],
    onError: (error) => outcome.failed(error),
  });
  return (
    <section className="work-section" aria-label={t("recur.webhook")}>
      <h3 className="work-subhead">{t("recur.webhook")}</h3>
      {routine.webhookUrl !== null && <code className="work-code">{routine.webhookUrl}</code>}
      {!routine.webhookHasSecret && <p className="work-note">{t("recur.webhook.noSecret")}</p>}
      {mayEdit && (
        <Button
          size="sm"
          loading={make.isPending}
          onClick={() =>
            make.mutate(
              { workspaceId, routineId: routine.id },
              { onSuccess: (made) => setSecret(made.secret) },
            )
          }
        >
          {t(routine.webhookHasSecret ? "recur.webhook.replace" : "recur.webhook.make")}
        </Button>
      )}
      {secret !== null && (
        <Dialog open onOpenChange={(next) => !next && setSecret(null)}>
          <DialogContent
            title={t("recur.webhook.title")}
            description={t("recur.webhook.once")}
            closeLabel={common("action.close")}
            footer={
              <Button
                variant="primary"
                onClick={() =>
                  void navigator.clipboard.writeText(secret).then(
                    () => outcome.done(t("recur.webhook.copied")),
                    (error: unknown) => outcome.failed(error),
                  )
                }
              >
                {t("recur.webhook.copy")}
              </Button>
            }
          >
            <code className="work-code">{secret}</code>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
