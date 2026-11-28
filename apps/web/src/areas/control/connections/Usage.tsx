// The Usage section of the settings: what the workspace spent this month against its budget, by kind of
// spend and by agent, and the budget a new agent starts with. The workspace's budget is the sum of its
// active agents' monthly budgets (one agent's default while it has none). It counts all of the
// workspace's model spend except the search index's embeddings, which this server pays: the agents'
// runs and the calls made for no agent (search answers, wiki checks, agent drafts), which stop once it is
// spent. Only someone who may see usage opens this section; changing the default needs `configure` too,
// and the server decides both.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import { can, type UsageReport, type WorkspaceSettings } from "@vanr/contract";
import { Button, Callout, EmptyState, Field, Input, Surface } from "@vanr/ui";
import { type ReactNode, useMemo, useState } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { decimalMark, formatLimit, readLimit } from "../../work/limits.ts";
import { useMe, useOutcome } from "../shared.tsx";
import { Block, PartError, PartLoading, useForgetReadOnLoss, useLatch } from "./shared.tsx";

// The server's bounds for the default (routes/workspaces.ts, agentBudgetDefaultUsd).
export const DEFAULT_BUDGET = { min: 0, max: 100_000, step: "any" } as const;
/** The one kind the server pays itself: it shows, but the workspace's budget leaves it out. */
const UNBUDGETED = "embedding";
/** The kinds of spend the server reports, each with its own label; any other reads as "other". */
const KINDS = [
  "model",
  "embedding",
  "search",
  "wiki",
  "memory",
  "advisor",
  "issue",
  "delegation",
  "review",
  "chat",
  "routine",
  "assignment",
  "debate",
  "other",
] as const;
const READS = ["getUsageReport", "getSettings"] as const;

/** Dollars in the person's language; an amount above zero but under a cent is not shown as zero. */
function useDollars() {
  const { locale } = useLocale();
  const t = useMessages("control");
  return useMemo(() => {
    const format = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
    return (usd: number | null | undefined) => {
      if (typeof usd !== "number" || !Number.isFinite(usd)) return t("use.unknownAmount");
      if (usd > 0 && usd < 0.01) return t("use.underCent", { cent: format.format(0.01) });
      return format.format(usd);
    };
  }, [locale, t]);
}

export function UsageSection() {
  const t = useMessages("control");
  const { workspaceId } = useRouteParams("settings");
  const report = useApiQuery("getUsageReport", { workspaceId, query: {} });
  const settings = useApiQuery("getSettings", { workspaceId });
  useForgetReadOnLoss(workspaceId, READS, report.error);
  let body: ReactNode;
  if (report.isPending) body = <PartLoading />;
  else if (report.isError)
    body = <PartError title={t("use.failed")} error={report.error} onRetry={() => void report.refetch()} />;
  else
    body = (
      <Report
        workspaceId={workspaceId}
        report={report.data}
        defaultBudget={settings.data?.agentBudgetDefaultUsd ?? null}
      />
    );
  return (
    <>
      <Block title={t("use.title")} lead={t("use.lead")}>
        {body}
      </Block>
      <Block title={t("use.defaultTitle")} lead={t("use.defaultLead")}>
        {settings.isPending ? (
          <PartLoading />
        ) : settings.isError ? (
          <PartError
            title={t("use.settingsFailed")}
            error={settings.error}
            onRetry={() => void settings.refetch()}
          />
        ) : (
          <DefaultBudget
            // A default saved elsewhere starts the field over from it.
            key={`${workspaceId}/${settings.data.agentBudgetDefaultUsd}`}
            workspaceId={workspaceId}
            settings={settings.data}
          />
        )}
      </Block>
    </>
  );
}

/** A share of a budget, as a bar that reads by its tone too: calm, near the end, or past it. */
function Meter({ spent, budget, label }: { spent: number; budget: number; label: string }) {
  const percent = budget > 0 ? Math.round((spent / budget) * 100) : spent > 0 ? 100 : 0;
  const tone = percent >= 100 ? "over" : percent >= 80 ? "near" : "calm";
  return (
    <meter
      className="spend-meter"
      aria-label={label}
      min={0}
      max={100}
      value={Math.min(percent, 100)}
      data-tone={tone}
    />
  );
}

function Report({
  workspaceId,
  report,
  defaultBudget,
}: {
  workspaceId: string;
  report: UsageReport;
  /** One agent's default budget: the workspace's own while it has no agents; null until it is known. */
  defaultBudget: number | null;
}) {
  const t = useMessages("control");
  const { locale } = useLocale();
  const dollars = useDollars();
  const since = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(report.since),
  );
  // The very numbers the server's cap uses: the sum of the active agents' monthly budgets (one agent's
  // default while there are none), and every spend but the embeddings this server pays.
  const budget =
    report.agents.length === 0
      ? defaultBudget
      : report.agents.reduce((sum, agent) => sum + agent.budgetPerMonthUsd, 0);
  const unbudgeted = report.perKind
    .filter((each) => each.kind === UNBUDGETED)
    .reduce((sum, each) => sum + each.costUsd, 0);
  const counted = report.spendUsd - unbudgeted;
  const percent = budget !== null && budget > 0 ? Math.round((counted / budget) * 100) : null;
  const kinds = report.perKind.map((each) => ({
    ...each,
    label: t(`use.kind.${KINDS.find((kind) => kind === each.kind) ?? "other"}`),
  }));
  return (
    <div className="spend">
      <Surface variant="card" className="spend__total">
        <p className="spend__since">{t("use.since", { date: since })}</p>
        <p className="spend__figure">
          <span className="spend__amount">{dollars(counted)}</span>{" "}
          <span className="spend__of">{t("use.ofBudget", { budget: dollars(budget) })}</span>
        </p>
        <Meter spent={counted} budget={budget ?? 0} label={t("use.workspaceMeter")} />
        <p className="page__muted">
          {percent === null
            ? t("use.noBudget")
            : percent >= 100
              ? t("use.spentAll")
              : t("use.percent", { percent })}
        </p>
        {unbudgeted > 0 && (
          <p className="page__muted">
            {t("use.withIndex", { total: dollars(report.spendUsd), index: dollars(unbudgeted) })}
          </p>
        )}
        <p className="page__muted spend__why">
          {report.agents.length === 0
            ? t("use.whereFromNoAgents")
            : t("use.whereFrom", { count: report.agents.length })}
        </p>
      </Surface>

      <section aria-label={t("use.byKind")} className="spend__part">
        <h4 className="page__heading">{t("use.byKind")}</h4>
        {kinds.length === 0 ? (
          <p className="page__muted">{t("use.nothingYet")}</p>
        ) : (
          <ul className="spend-list" aria-label={t("use.byKind")}>
            {kinds.map((each) => (
              <li key={each.kind} className="spend-list__row">
                <span className="spend-list__name">{each.label}</span>
                <span className="spend-list__calls">
                  {t("use.calls", { count: each.calls })}
                  {each.kind === UNBUDGETED && <> {t("use.notCounted")}</>}
                </span>
                <span className="spend-list__amount">{dollars(each.costUsd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("use.byAgent")} className="spend__part">
        <h4 className="page__heading">{t("use.byAgent")}</h4>
        {report.agents.length === 0 ? (
          <EmptyState title={t("use.noAgents")} description={t("use.noAgentsBody")} />
        ) : (
          <ul className="spend-list" aria-label={t("use.byAgent")}>
            {report.agents.map((agent) => (
              <li key={agent.agentId} className="spend-list__row spend-list__row--agent">
                <AppLink
                  className="app-link spend-list__name"
                  route="agent"
                  params={{ workspaceId, agentId: agent.agentId }}
                >
                  {agent.name}
                </AppLink>
                <span className="spend-list__calls">
                  {t(agent.budgetInherited ? "use.agentDefault" : "use.agentOwn", {
                    budget: dollars(agent.budgetPerMonthUsd),
                  })}
                </span>
                <span className="spend-list__amount">{dollars(agent.costUsd)}</span>
                <Meter
                  spent={agent.costUsd}
                  budget={agent.budgetPerMonthUsd}
                  label={t("use.agentMeter", { agent: agent.name })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The monthly budget an agent gets when it has none of its own. Read by whoever sees usage; changed with `configure`. */
function DefaultBudget({ workspaceId, settings }: { workspaceId: string; settings: WorkspaceSettings }) {
  const t = useMessages("control");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const latch = useLatch();
  const { locale } = useLocale();
  const mark = decimalMark(locale);
  const dollars = useDollars();
  const may = can(useMe(workspaceId).role, "configure");
  const [text, setText] = useState(formatLimit(settings.agentBudgetDefaultUsd, mark));
  const save = useApiMutation("updateSettings", {
    invalidates: () => [
      { method: "getSettings" as const, args: { workspaceId } },
      { method: "getUsageReport" as const, args: { workspaceId } },
    ],
  });
  const value = readLimit(text, DEFAULT_BUDGET, mark);
  const changed = value !== undefined && value !== settings.agentBudgetDefaultUsd;
  const problem =
    text.trim() !== "" && value === undefined
      ? t("use.defaultInvalid", {
          max: dollars(DEFAULT_BUDGET.max),
          example: mark === "," ? "12,50" : "12.50",
        })
      : undefined;
  return (
    <form
      className="section-form spend__default"
      aria-label={t("use.defaultTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        if (!may || value === undefined || !changed) return;
        latch(() =>
          save
            .mutateAsync({ workspaceId, body: { agentBudgetDefaultUsd: value } })
            .then(() => outcome.done(t("use.defaultSaved", { budget: dollars(value) }))),
        );
      }}
    >
      <Field label={t("use.defaultField")} hint={t("use.defaultHint")} error={problem}>
        <Input
          inputMode="decimal"
          value={text}
          readOnly={!may}
          disabled={save.isPending}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {!may && <p className="page__muted">{t("use.defaultReadOnly")}</p>}
      {save.isError && (
        <Callout tone="danger" role="alert">
          {describe(save.error)}
        </Callout>
      )}
      {may && (
        <div className="section-form__actions">
          <Button type="submit" variant="primary" disabled={!changed} loading={save.isPending}>
            {t("use.defaultSave")}
          </Button>
        </div>
      )}
    </form>
  );
}
