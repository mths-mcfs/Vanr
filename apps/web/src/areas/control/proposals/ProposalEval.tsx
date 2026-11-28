// On the card of a pending change to an agent's instructions: run the agent's test cases with the
// current and the proposed text and compare. It only informs the decision. While a run is going it is
// read again every 1.5 s, as the cases finish one by one. When the cases can't be read, the block
// stays out of the way.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentEval, AgentEvalSide, Proposal } from "@vanr/contract";
import { Button, Callout, Chip } from "@vanr/ui";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { Block, useOutcome } from "../shared.tsx";

const POLL_MS = 1500;

function failure(code: string, t: ReturnType<typeof useMessages<"control">>): string {
  const [kind, ...rest] = code.split(":");
  const text = rest.join(":");
  if (kind === "include") return t("eval.missing", { text });
  if (kind === "exclude") return t("eval.forbidden", { text });
  return t("eval.error", { code: text });
}

function Side({ label, side }: { label: string; side: AgentEvalSide }) {
  const t = useMessages("control");
  return (
    <div className="eval-side" data-pass={side.pass}>
      <span className="eval-side__label">
        {label} <Chip>{side.pass ? t("eval.pass") : t("eval.fail")}</Chip>
      </span>
      <p className="eval-side__text">{side.text}</p>
      {side.failed.length > 0 && (
        <ul className="eval-side__why">
          {side.failed.map((code) => (
            <li key={code}>{failure(code, t)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvalResult({ run }: { run: AgentEval }) {
  const t = useMessages("control");
  const { locale } = useLocale();
  if (run.status === "running")
    return (
      <p className="eval__running" role="status">
        {t("eval.running", { done: run.done, total: run.total })}
        <progress max={run.total} value={run.done} />
      </p>
    );
  const summary = run.summary;
  const worse = (side: AgentEval["results"][number]) => side.before.pass && !side.after.pass;
  // The cases that got worse come first: they are what weighs on the decision.
  const rows = [...run.results].sort((a, b) => Number(worse(b)) - Number(worse(a)));
  // The cost is null without view_usage: the line then says only that the run is advisory.
  const cost =
    run.costUsd === null
      ? null
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 4,
        }).format(run.costUsd);
  return (
    <div className="eval">
      {run.status === "failed" && (
        <Callout tone="danger">{t("eval.failed", { error: run.error ?? "" })}</Callout>
      )}
      {summary !== null && (
        <p className="eval__score">
          <strong>
            {t("eval.score", { before: summary.beforePass, after: summary.afterPass, cases: summary.cases })}
          </strong>{" "}
          <Chip>
            {summary.regressions > 0
              ? t("eval.regressions", { count: summary.regressions })
              : t("eval.noRegressions")}
          </Chip>
        </p>
      )}
      <ol className="eval__cases">
        {rows.map((row) => (
          <li key={row.caseId} className="eval-case" data-worse={worse(row) || undefined}>
            <p className="eval-case__input">{row.input}</p>
            <div className="eval-case__sides">
              <Side label={t("eval.before")} side={row.before} />
              <Side label={t("eval.after")} side={row.after} />
            </div>
          </li>
        ))}
      </ol>
      <p className="control-note">
        {t("eval.advisory")}
        {cost !== null && <> {t("eval.cost", { value: cost })}</>}
      </p>
    </div>
  );
}

export function ProposalEval({ workspaceId, proposal }: { workspaceId: string; proposal: Proposal }) {
  const t = useMessages("control");
  const outcome = useOutcome();
  const agentId = proposal.target.kind === "agent_prompt" ? proposal.target.agentId : "";
  const cases = useApiQuery(
    "listAgentTestCases",
    { workspaceId, agentId },
    { enabled: agentId !== "", retry: false },
  );
  const evals = useApiQuery(
    "listAgentEvals",
    { workspaceId, agentId, query: { proposalId: proposal.id } },
    {
      enabled: agentId !== "",
      retry: false,
      refetchInterval: (query) => (query.state.data?.[0]?.status === "running" ? POLL_MS : false),
    },
  );
  const start = useApiMutation("createAgentEval", {
    invalidates: () => [{ method: "listAgentEvals", args: { workspaceId, agentId } }],
  });
  if (agentId === "" || cases.isError || cases.isPending) return null;
  const latest = evals.data?.[0];
  const count = cases.data.length;
  return (
    <Block label={t("eval.title")}>
      {latest !== undefined && <EvalResult run={latest} />}
      {count === 0 ? (
        <p className="control-note">{t("eval.noCases")}</p>
      ) : (
        latest?.status !== "running" &&
        proposal.status === "pending" && (
          <div>
            <Button
              variant="secondary"
              loading={start.isPending}
              onClick={() =>
                start.mutate(
                  { workspaceId, agentId, body: { proposalId: proposal.id } },
                  { onError: (error) => outcome.failed(error) },
                )
              }
            >
              {latest === undefined ? t("eval.run", { count }) : t("eval.rerun")}
            </Button>
          </div>
        )
      )}
    </Block>
  );
}
