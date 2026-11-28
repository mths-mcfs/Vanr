// The side panels of the approvals page: the "always allow" rules the person answers for (the server
// lists only those, the same ones it lets them revoke), and the gate's numbers by reach for people
// who see usage.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { ApprovalRule } from "@vanr/contract";
import { Button, ConfirmDialog, ErrorState, Skeleton } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useLookup, useMessages } from "../../../i18n/react.tsx";
import { duration, ruleText, shortDateTime } from "../format.ts";
import { type Directory, useOutcome } from "../shared.tsx";

function PanelLoading() {
  const common = useMessages("common");
  return (
    <div aria-busy="true">
      <span className="vr-visually-hidden" role="status">
        {common("state.loading")}
      </span>
      <Skeleton />
      <Skeleton />
    </div>
  );
}

function PanelError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const common = useMessages("common");
  const describe = useErrorMessage("control");
  return (
    <ErrorState
      title={title}
      description={describe(error)}
      action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
    />
  );
}

export function RulesPanel({ workspaceId, directory }: { workspaceId: string; directory: Directory }) {
  const t = useMessages("control");
  const rules = useApiQuery("listApprovalRules", { workspaceId });
  return (
    <section className="control-panel" aria-labelledby="control-rules">
      <h2 className="control-panel__title" id="control-rules">
        {t("rules.title")}
      </h2>
      <p className="control-panel__lead">{t("rules.lead")}</p>
      {rules.isPending ? (
        <PanelLoading />
      ) : rules.isError ? (
        <PanelError title={t("rules.failed")} error={rules.error} onRetry={() => void rules.refetch()} />
      ) : rules.data.length === 0 ? (
        <p className="control-note">{t("rules.empty")}</p>
      ) : (
        <ul className="control-rules" aria-label={t("rules.list")}>
          {rules.data.map((rule) => (
            <RuleRow key={rule.id} workspaceId={workspaceId} rule={rule} directory={directory} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleRow({
  workspaceId,
  rule,
  directory,
}: {
  workspaceId: string;
  rule: ApprovalRule;
  directory: Directory;
}) {
  const t = useMessages("control");
  const lookup = useLookup("control");
  const common = useMessages("common");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const [confirming, setConfirming] = useState(false);
  const revoke = useApiMutation("deleteApprovalRule", {
    invalidates: () => [{ method: "listApprovalRules", args: { workspaceId } }],
  });
  const agent = directory.agentName(rule.agentId);
  const text = ruleText(rule.tool, rule.label, lookup);
  return (
    <li className="control-rule">
      <span className="control-rule__agent">{agent}</span>
      <span className="control-rule__text">{text}</span>
      <span className="control-rule__meta">
        {rule.uses === 0 ? t("rules.unused") : t("rules.uses", { count: rule.uses })}
      </span>
      <span className="control-rule__meta">
        {t("rules.expires", { when: shortDateTime(rule.expiresAt, locale) })}
      </span>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        trigger={
          <Button size="sm" variant="ghost" aria-label={t("rules.revokeLabel", { rule: text, agent })}>
            {t("rules.revoke")}
          </Button>
        }
        title={t("rules.confirmTitle")}
        description={t("rules.confirmBody", { agent, rule: text })}
        confirmLabel={t("rules.revoke")}
        cancelLabel={common("action.cancel")}
        tone="danger"
        confirming={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(
            { workspaceId, approvalRuleId: rule.id },
            {
              onSuccess: () => {
                setConfirming(false);
                outcome.done(t("rules.revoked"));
              },
              onError: (error) => outcome.failed(error),
            },
          )
        }
      />
    </li>
  );
}

export function StatsPanel({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("control");
  const { locale } = useLocale();
  const stats = useApiQuery("listApprovalStats", { workspaceId, query: { days: 30 } });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return (
    <section className="control-panel" aria-labelledby="control-stats">
      <h2 className="control-panel__title" id="control-stats">
        {t("stats.title")}
      </h2>
      <p className="control-panel__lead">{t("stats.lead")}</p>
      {stats.isPending ? (
        <PanelLoading />
      ) : stats.isError ? (
        <PanelError title={t("stats.failed")} error={stats.error} onRetry={() => void stats.refetch()} />
      ) : stats.data.byEffect.length === 0 ? (
        <p className="control-note">{t("stats.empty")}</p>
      ) : (
        <ul className="control-stats" aria-label={t("stats.caption")}>
          {stats.data.byEffect.map((row) => (
            <li key={row.effect} className="control-stats__row">
              <h3 className="control-stats__effect">
                <span className="control-stats__code">{row.effect}</span> {t(`effect.${row.effect}`)}
              </h3>
              <dl>
                {(
                  [
                    ["stats.calls", number(row.calls)],
                    ["stats.auto", number(row.auto)],
                    ["stats.asked", number(row.asked)],
                    ["stats.approved", number(row.approved + row.edited)],
                    ["stats.rejected", number(row.rejected)],
                    ["stats.expired", number(row.expired)],
                    ["stats.wait", row.p50Ms === null ? t("stats.noWait") : duration(row.p50Ms, locale)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>{t(label)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
