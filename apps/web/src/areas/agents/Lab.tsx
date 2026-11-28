// The lab: test prompts with what each answer must and must not say, run against the agent's current
// instructions and a candidate text side by side. The result is advice: nothing changes until the
// instructions are saved. Whoever edits the agent keeps the cases; only whoever manages agents runs a
// candidate text (the server's rule). A run in progress is followed until it ends.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail, AgentEval, AgentEvalSide } from "@vanr/contract";
import { Button, Callout, Chip, EmptyState, Field, Textarea } from "@vanr/ui";
import { Play, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useMessages } from "../../i18n/react.tsx";
import {
  type AgentRights,
  INSTRUCTIONS_MAX,
  lines,
  PartError,
  PartLoading,
  Section,
  useOutcome,
} from "./shared.tsx";

/** The server's limits on cases. */
export const CASES_MAX = 50;
export const CASE_INPUT_MAX = 4000;
export const SNIPPETS_MAX = 10;
export const SNIPPET_MAX = 200;
/** How often a running evaluation is asked again. */
export const EVAL_POLL_MS = 1500;

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

export function Lab({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  // The server keeps the lab of an archived agent closed, reading included.
  if (agent.archivedAt !== null) {
    return (
      <EmptyState className="page__narrow" title={t("lab.archived")} description={t("lab.archivedBody")} />
    );
  }
  if (!rights.editor) {
    return <EmptyState className="page__narrow" title={t("lab.denied")} description={t("lab.deniedBody")} />;
  }
  return (
    <>
      <Cases agent={agent} workspaceId={workspaceId} rights={rights} />
      <Evaluate agent={agent} workspaceId={workspaceId} rights={rights} />
    </>
  );
}

function Cases({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const cases = useApiQuery("listAgentTestCases", args);
  const refetch = () => [{ method: "listAgentTestCases" as const, args }];
  const add = useApiMutation("createAgentTestCase", { invalidates: refetch });
  const remove = useApiMutation("deleteAgentTestCase", { invalidates: refetch });
  const [input, setInput] = useState("");
  const [must, setMust] = useState("");
  const [mustNot, setMustNot] = useState("");
  const include = lines(must);
  const exclude = lines(mustNot);
  const snippetsWrong = [...include, ...exclude].some((snippet) => snippet.length > SNIPPET_MAX);
  const tooMany = include.length > SNIPPETS_MAX || exclude.length > SNIPPETS_MAX;
  const editable = rights.editLook;

  let list: ReactNode;
  if (cases.isPending) list = <PartLoading />;
  else if (cases.isError)
    list = (
      <PartError title={t("lab.casesFailed")} error={cases.error} onRetry={() => void cases.refetch()} />
    );
  else if (cases.data.length === 0) list = <p className="page__muted">{t("lab.casesEmpty")}</p>;
  else
    list = (
      <ul className="lab-cases" aria-label={t("lab.cases")}>
        {cases.data.map((item) => (
          <li key={item.id} className="lab-case">
            <p className="lab-case__input">{item.input}</p>
            <p className="lab-case__checks">
              {item.mustInclude.map((snippet) => (
                <Chip key={`+${snippet}`}>{t("lab.includes", { snippet })}</Chip>
              ))}
              {item.mustNotInclude.map((snippet) => (
                <Chip key={`-${snippet}`}>{t("lab.excludes", { snippet })}</Chip>
              ))}
            </p>
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={16} />}
                aria-label={t("lab.remove", { input: item.input.slice(0, 40) })}
                disabled={remove.isPending}
                onClick={() => remove.mutate({ ...args, testCaseId: item.id }, { onError: outcome.failed })}
              />
            )}
          </li>
        ))}
      </ul>
    );

  const count = cases.data?.length ?? 0;
  return (
    <Section title={t("lab.cases")} help={t("lab.casesHelp")}>
      {list}
      {cases.isSuccess && <p className="page__muted">{t("lab.count", { count, max: CASES_MAX })}</p>}
      {editable && cases.isSuccess && count < CASES_MAX && (
        <form
          className="section-form"
          aria-label={t("lab.add")}
          onSubmit={(event) => {
            event.preventDefault();
            if (input.trim() === "" || tooMany || snippetsWrong) return;
            add.mutate(
              { ...args, body: { input: input.trim(), mustInclude: include, mustNotInclude: exclude } },
              {
                onSuccess: () => {
                  setInput("");
                  setMust("");
                  setMustNot("");
                },
                onError: outcome.failed,
              },
            );
          }}
        >
          <Field label={t("lab.input")}>
            <Textarea
              rows={2}
              value={input}
              disabled={add.isPending}
              maxLength={CASE_INPUT_MAX}
              onChange={(event) => setInput(event.target.value)}
            />
          </Field>
          <div className="lab-row">
            <Field
              label={t("lab.mustInclude")}
              hint={t("lab.snippetsHint", { max: SNIPPETS_MAX })}
              error={
                tooMany || snippetsWrong
                  ? t("lab.snippetsWrong", { max: SNIPPETS_MAX, length: SNIPPET_MAX })
                  : undefined
              }
            >
              <Textarea
                rows={2}
                value={must}
                disabled={add.isPending}
                onChange={(event) => setMust(event.target.value)}
              />
            </Field>
            <Field label={t("lab.mustNotInclude")}>
              <Textarea
                rows={2}
                value={mustNot}
                disabled={add.isPending}
                onChange={(event) => setMustNot(event.target.value)}
              />
            </Field>
          </div>
          <div>
            <Button
              type="submit"
              icon={<Plus size={16} />}
              disabled={input.trim() === "" || tooMany || snippetsWrong}
              loading={add.isPending}
            >
              {t("lab.add")}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function Evaluate({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const [text, setText] = useState(agent.instructions);
  const [evalId, setEvalId] = useState<string | null>(null);
  const history = useApiQuery("listAgentEvals", { ...args, query: {} });
  const shownId = evalId ?? history.data?.[0]?.id ?? null;
  const current = useApiQuery(
    "getAgentEval",
    { ...args, evalId: shownId ?? "" },
    {
      enabled: shownId !== null,
      refetchInterval: (query) => (query.state.data?.status === "running" ? EVAL_POLL_MS : false),
    },
  );
  const cases = useApiQuery("listAgentTestCases", args);
  const noCases = cases.data?.length === 0;
  const start = useApiMutation("createAgentEval", {
    invalidates: () => [{ method: "listAgentEvals" as const, args }],
  });
  const running = current.data?.status === "running";
  return (
    <Section title={t("lab.evaluate")} help={t("lab.evaluateHelp")}>
      {rights.editAll ? (
        <>
          <Field
            label={t("lab.candidate")}
            hint={t("field.count", { count: text.length, max: INSTRUCTIONS_MAX })}
          >
            <Textarea
              rows={8}
              value={text}
              maxLength={INSTRUCTIONS_MAX}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <div>
            <Button
              variant="primary"
              icon={<Play size={16} />}
              loading={start.isPending}
              disabled={running || noCases}
              onClick={() =>
                start.mutate(
                  { ...args, body: { instructions: text } },
                  { onSuccess: (started) => setEvalId(started.id), onError: outcome.failed },
                )
              }
            >
              {t("lab.run")}
            </Button>
            {noCases && <p className="page__muted">{t("lab.needCase")}</p>}
          </div>
        </>
      ) : (
        <p className="page__muted">{t("lab.runAdminOnly")}</p>
      )}
      {shownId !== null &&
        (current.isPending ? (
          <PartLoading />
        ) : current.isError ? (
          <PartError
            title={t("lab.evalFailed")}
            error={current.error}
            onRetry={() => void current.refetch()}
          />
        ) : (
          <EvalView run={current.data} />
        ))}
      {shownId === null && history.isError && (
        <PartError title={t("lab.evalFailed")} error={history.error} onRetry={() => void history.refetch()} />
      )}
    </Section>
  );
}

function EvalView({ run }: { run: AgentEval }) {
  const t = useMessages("agents");
  if (run.status === "running") {
    return (
      <p className="lab-progress" role="status">
        {t("lab.progress", { done: run.done, total: run.total })}
      </p>
    );
  }
  if (run.status === "failed") {
    return (
      <Callout tone="danger" role="alert" title={t("lab.runFailed")}>
        {run.error ?? ""}
      </Callout>
    );
  }
  const summary = run.summary;
  return (
    <section className="lab-result" aria-label={t("lab.result")}>
      {summary !== null && (
        <p role="status">
          {t("lab.summary", {
            before: summary.beforePass,
            after: summary.afterPass,
            cases: summary.cases,
          })}
          {summary.regressions > 0 && ` ${t("lab.regressions", { count: summary.regressions })}`}
        </p>
      )}
      <ul className="lab-cases" aria-label={t("lab.result")}>
        {run.results.map((result) => (
          <li key={result.caseId} className="lab-case lab-case--result">
            <p className="lab-case__input">{result.input}</p>
            <div className="lab-sides">
              <Side label={t("lab.before")} side={result.before} />
              <Side
                label={t("lab.after")}
                side={result.after}
                change={
                  result.before.pass === result.after.pass
                    ? undefined
                    : result.after.pass
                      ? "better"
                      : "worse"
                }
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Side({
  label,
  side,
  change,
}: {
  label: string;
  side: AgentEvalSide;
  /** The new text turned a failing case into a passing one, or the other way round. */
  change?: "better" | "worse" | undefined;
}) {
  const t = useMessages("agents");
  return (
    <section className="lab-side" aria-label={label} data-change={change}>
      <p>
        <strong>{label}</strong> <Chip>{t(side.pass ? "lab.pass" : "lab.fail")}</Chip>
        {change !== undefined && <span className="lab-side__change"> {t(`lab.${change}`)}</span>}
      </p>
      <p className="lab-side__text">{side.text}</p>
      {side.failed.length > 0 && (
        <ul className="agent-plain">
          {side.failed.map((reason) => (
            <li key={reason} className="page__muted">
              {failure(reason, t)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `include:snippet`, `exclude:snippet` or `error:code`, said for a person. */
function failure(reason: string, t: ReturnType<typeof useMessages<"agents">>): string {
  const at = reason.indexOf(":");
  const kind = reason.slice(0, at);
  const rest = reason.slice(at + 1);
  if (kind === "include") return t("lab.missing", { snippet: rest });
  if (kind === "exclude") return t("lab.present", { snippet: rest });
  return t("lab.errored", { code: rest });
}
