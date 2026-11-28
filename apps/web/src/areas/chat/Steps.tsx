// How an agent got to its answer: the notes it made and the tools it called, each tool with what it
// was asked and what came back, failures marked. Live, the steps come from the run's events; once the
// answer is posted, the saved steps are read from the run when someone opens them.
import { useApiQuery } from "@vanr/client/react";
import type { RunStep } from "@vanr/contract";
import { Icon, Skeleton } from "@vanr/ui";
import { ChevronRight, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import { useId, useState } from "react";
import { useMessages } from "../../i18n/react.tsx";
import { useConversation } from "./context.tsx";
import type { LiveStep } from "./live.ts";

const PREVIEW = 4000;

const preview = (text: string) => (text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text);

function ToolStep({ step }: { step: Extract<LiveStep, { kind: "tool" }> }) {
  const t = useMessages("chat");
  const [open, setOpen] = useState(false);
  const panel = useId();
  const state = step.running ? t("step.running") : step.isError ? t("step.failed") : t("step.done");
  return (
    <li className="chat-step chat-step--tool" data-error={step.isError || undefined}>
      <button
        type="button"
        className="chat-step__toggle"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={ChevronRight} size="sm" className="chat-step__chevron" />
        <Icon icon={step.running ? LoaderCircle : step.isError ? CircleAlert : Wrench} size="sm" />
        <span className="chat-step__tool">{step.tool}</span>
        {step.detail !== null && step.detail !== "" && (
          <span className="chat-step__detail">{step.detail}</span>
        )}
        <span className="vr-visually-hidden">{state}</span>
      </button>
      {open && (
        <div className="chat-step__out" id={panel}>
          {step.input !== null && (
            <section aria-label={t("step.input")}>
              <pre>{preview(step.input)}</pre>
            </section>
          )}
          {step.output === null ? (
            <p className="chat-note">{step.running ? t("step.waiting") : t("step.noOutput")}</p>
          ) : (
            <section aria-label={step.isError ? t("step.error") : t("step.output")}>
              <pre>{preview(step.output)}</pre>
            </section>
          )}
        </div>
      )}
    </li>
  );
}

export function StepList({ steps, label }: { steps: readonly LiveStep[]; label: string }) {
  if (steps.length === 0) return null;
  return (
    <ol className="chat-steps" aria-label={label}>
      {steps.map((step) =>
        step.kind === "note" ? (
          <li key={step.key} className="chat-step chat-step--note">
            {step.text}
          </li>
        ) : (
          <ToolStep key={step.key} step={step} />
        ),
      )}
    </ol>
  );
}

/** The saved steps of a run in the shape the live ones have. */
export function stepsOf(saved: readonly RunStep[]): LiveStep[] {
  const out: LiveStep[] = [];
  for (const step of saved) {
    const { data } = step;
    if (step.kind === "tool_call") {
      if (data.commentary !== undefined && data.commentary !== "")
        out.push({ kind: "note", key: `note-${step.seq}`, text: data.commentary });
      out.push({
        kind: "tool",
        key: data.toolUseId ?? `tool-${step.seq}`,
        tool: data.name ?? "",
        detail: null,
        input: data.input === undefined ? null : JSON.stringify(data.input, null, 2),
        output: null,
        isError: false,
        running: false,
      });
    } else if (step.kind === "tool_result") {
      const index = out.findIndex((entry) => entry.kind === "tool" && entry.key === data.toolUseId);
      const call = out[index];
      if (call?.kind === "tool")
        out[index] = { ...call, output: data.content ?? "", isError: data.isError === true };
    }
  }
  return out;
}

function SavedList({ runId }: { runId: string }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const { workspaceId } = useConversation();
  const run = useApiQuery("getRun", { workspaceId, runId });
  if (run.isPending)
    return (
      <div aria-busy="true">
        <span className="vr-visually-hidden" role="status">
          {common("state.loading")}
        </span>
        <Skeleton />
      </div>
    );
  if (run.isError)
    return (
      <p className="chat-note chat-note--danger" role="alert">
        {t("steps.failed")}{" "}
        <button type="button" className="app-link-button" onClick={() => void run.refetch()}>
          {common("action.retry")}
        </button>
      </p>
    );
  const steps = stepsOf(run.data.steps);
  if (steps.length === 0) return <p className="chat-note">{t("steps.none")}</p>;
  return <StepList steps={steps} label={t("steps.label")} />;
}

export function SavedSteps({ runId, count }: { runId: string; count: number }) {
  const t = useMessages("chat");
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="chat-saved-steps">
      <button
        type="button"
        className="chat-step__toggle chat-saved-steps__toggle"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={ChevronRight} size="sm" className="chat-step__chevron" />
        {t("steps.show", { count })}
      </button>
      {open && (
        <div id={panel}>
          <SavedList runId={runId} />
        </div>
      )}
    </div>
  );
}
