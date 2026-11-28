// What the debates of the last 90 days came to, over the debates the person sees: how many concluded,
// how many verdicts stood, whether anyone changed their mind after a challenge, the blind reads and,
// for who may see spend, the average cost. Loaded only once opened.
import { useApiQuery } from "@vanr/client/react";
import { Button, Callout } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { useMoney, useSeesSpend } from "./shared.tsx";

const DAYS = 90;

export function DebateMetrics({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("debates");
  const [open, setOpen] = useState(false);
  return (
    <details className="debate-metrics" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="debate-metrics__toggle">{t("metrics.toggle", { days: DAYS })}</summary>
      {open && <MetricsBody workspaceId={workspaceId} />}
    </details>
  );
}

function MetricsBody({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("debates");
  const common = useMessages("common");
  const describe = useErrorMessage("debates");
  const money = useMoney();
  const { locale } = useLocale();
  const count = new Intl.NumberFormat(locale);
  const seesSpend = useSeesSpend(workspaceId);
  const metrics = useApiQuery("listDebateMetrics", { workspaceId, query: { days: DAYS } });
  if (metrics.isPending)
    return (
      <p className="debate-metrics__note" role="status">
        {t("metrics.loading")}
      </p>
    );
  if (metrics.isError && metrics.data === undefined)
    return (
      <Callout tone="danger" role="alert">
        {t("metrics.failed")}: {describe(metrics.error)}{" "}
        <Button size="sm" onClick={() => void metrics.refetch()}>
          {common("action.retry")}
        </Button>
      </Callout>
    );
  const m = metrics.data;
  // Spend comes only to who may see it; the number is shown only to them, and never as zero by default.
  const cost = seesSpend ? money(m.meanCostUsd) : null;
  const figures: { key: string; label: string; value: string; long?: true }[] = [
    { key: "settled", label: t("metrics.settled"), value: count.format(m.settled) },
    { key: "accepted", label: t("metrics.accepted"), value: count.format(m.accepted) },
    { key: "reverted", label: t("metrics.reverted"), value: count.format(m.reverted30) },
    {
      key: "moved",
      label: t("metrics.moved"),
      value: t("metrics.moved.of", { changed: m.changedDebates, challenged: m.challenged }),
      long: true,
    },
    {
      key: "blind",
      label: t("metrics.blind"),
      value: t("metrics.blind.value", {
        debate: m.blindReviews.debate,
        single: m.blindReviews.single,
        tie: m.blindReviews.tie,
      }),
      long: true,
    },
    ...(cost === null ? [] : [{ key: "cost", label: t("metrics.cost"), value: cost }]),
  ];
  return (
    <div className="debate-metrics__body">
      <dl className="debate-metrics__figures">
        {figures.map((figure) => (
          <div key={figure.key} className="debate-metrics__figure" data-long={figure.long}>
            <dt>{figure.label}</dt>
            <dd>{figure.value}</dd>
          </div>
        ))}
      </dl>
      {m.theater && (
        <Callout tone="warning" role="status">
          {t("metrics.theater")}
        </Callout>
      )}
    </div>
  );
}
