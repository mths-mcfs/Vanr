// The agents at work in this conversation, drawn as they work: the agent lit, where its run stands,
// how long it has been at it, the notes and tools so far, and the answer as it streams. Whoever may
// stop a run gets a stop button (and two quick Escapes stop the latest one they may stop); a run that
// went quiet offers to check on it.
import { isApiError } from "@vanr/client";
import { useApiMutation } from "@vanr/client/react";
import { AgentSigil, Button, ConfirmDialog, StatusBadge, type WorkStatus } from "@vanr/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useClock } from "../../platform/clock.tsx";
import { useOutcome } from "../control/shared.tsx";
import { useConversation } from "./context.tsx";
import { isQuiet, type LiveRun } from "./live.ts";
import { StepList } from "./Steps.tsx";

const BADGE: Record<string, WorkStatus> = {
  queued: "running",
  running: "running",
  paused_for_approval: "awaiting-approval",
  paused_for_input: "awaiting-reply",
};

const STATUS_TEXT: Record<string, "run.queued" | "run.running" | "run.approval" | "run.input"> = {
  queued: "run.queued",
  running: "run.running",
  paused_for_approval: "run.approval",
  paused_for_input: "run.input",
};

function useStop(onEnded: () => void) {
  const t = useMessages("chat");
  const { workspaceId } = useConversation();
  const outcome = useOutcome();
  const describe = useErrorMessage("chat");
  const cancel = useApiMutation("cancelRun", {
    invalidates: () => [{ method: "listChannelActiveRuns", args: { workspaceId } }],
  });
  const stop = (runId: string) =>
    cancel.mutate(
      { workspaceId, runId },
      {
        onError: (error) => {
          if (isApiError(error) && error.rawCode === "run.already_ended") {
            outcome.warn(t("run.alreadyEnded"));
            onEnded();
          } else outcome.warn(t("run.stopFailed", { error: describe(error) }));
        },
      },
    );
  return { stop, stopping: cancel.isPending };
}

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}

function LiveRunView({
  run,
  now,
  onCheck,
  stop,
  stopping,
}: {
  run: LiveRun;
  now: number;
  onCheck: () => void;
  stop: (runId: string) => void;
  stopping: boolean;
}) {
  const t = useMessages("chat");
  const { directory, mayStop } = useConversation();
  const [confirming, setConfirming] = useState(false);
  const name = directory.agentName(run.agentId);
  const quiet = isQuiet(run, now);
  const status = STATUS_TEXT[run.status] ?? "run.running";
  const time = elapsed(now - run.startedAt);
  const ended = run.endedAt !== null;
  return (
    <section
      className="chat-live"
      aria-label={t("run.label", { agent: name })}
      data-ended={ended || undefined}
    >
      <div className="chat-message__mark">
        <AgentSigil agentId={run.agentId} name={name} size="md" working={!ended} />
      </div>
      <div className="chat-live__main">
        <header className="chat-message__head">
          <span className="chat-message__author">{name}</span>
          <StatusBadge
            status={ended ? "done" : (BADGE[run.status] ?? "running")}
            label={ended ? t("run.done") : t(status)}
          />
          <span className="chat-message__time">
            {time.minutes > 0 ? t("run.elapsedLong", time) : t("run.elapsed", { seconds: time.seconds })}
          </span>
          {!ended && mayStop(run.agentId, run.initiatedBy) && (
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              trigger={
                <Button size="sm" variant="ghost" className="chat-live__stop" loading={stopping}>
                  {t("run.stop")}
                </Button>
              }
              title={t("run.stopTitle", { agent: name })}
              description={t("run.stopText")}
              confirmLabel={t("run.stopConfirm")}
              cancelLabel={t("run.stopKeep")}
              tone="danger"
              onConfirm={() => {
                setConfirming(false);
                stop(run.runId);
              }}
            />
          )}
        </header>
        {run.consulting !== null && !ended && (
          <p className="chat-note" role="status">
            {t("run.consulting", { agent: directory.agentName(run.consulting) })}
          </p>
        )}
        <StepList steps={run.steps} label={t("run.steps", { agent: name })} />
        {run.text !== "" ? (
          <p className="chat-live__text" data-testid="run-text">
            {run.text}
            {!ended && <span className="chat-live__caret" aria-hidden="true" />}
          </p>
        ) : (
          !ended &&
          run.steps.length === 0 && <p className="chat-note">{t("run.thinking", { agent: name })}</p>
        )}
        {quiet && (
          <p className="chat-note" role="status">
            {t("run.quiet", { agent: name })}{" "}
            <button type="button" className="app-link-button" onClick={onCheck}>
              {t("run.check")}
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

/** Stops the latest run the person may stop when Escape is pressed twice quickly inside `scope`. */
function useDoubleEscape(
  scope: RefObject<HTMLElement | null>,
  target: () => string | undefined,
  stop: (runId: string) => void,
) {
  const clock = useClock();
  const last = useRef(Number.NEGATIVE_INFINITY);
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    const element = scope.current;
    if (element === null) return;
    const onKey = (event: KeyboardEvent) => {
      // A held key repeats: only two separate presses stop a run.
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
      const now = clock.now();
      if (now - last.current < 600) {
        last.current = Number.NEGATIVE_INFINITY;
        const runId = latest.current();
        if (runId !== undefined) stop(runId);
      } else last.current = now;
    };
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, [scope, clock, stop]);
}

export function LiveRuns({
  runs,
  now,
  onCheck,
  scope,
  thread = null,
}: {
  runs: readonly LiveRun[];
  now: number;
  onCheck: () => void;
  /** Where two quick Escapes stop a run: the conversation. */
  scope: RefObject<HTMLElement | null>;
  /** The thread shown, or null for the conversation itself. */
  thread?: string | null;
}) {
  const t = useMessages("chat");
  const { directory, mayStop } = useConversation();
  const { stop, stopping } = useStop(onCheck);
  const here = runs.filter((run) => run.threadId === thread);
  const elsewhere =
    thread === null ? runs.filter((run) => run.threadId !== null && run.endedAt === null) : [];
  useDoubleEscape(
    scope,
    () =>
      [...here].reverse().find((run) => run.endedAt === null && mayStop(run.agentId, run.initiatedBy))?.runId,
    stop,
  );
  if (here.length === 0 && elsewhere.length === 0) return null;
  return (
    <div className="chat-live-list">
      {here.map((run) => (
        <LiveRunView key={run.runId} run={run} now={now} onCheck={onCheck} stop={stop} stopping={stopping} />
      ))}
      {elsewhere.length > 0 && (
        <p className="chat-note">
          {t("run.inThread", {
            agents: [...new Set(elsewhere.map((run) => directory.agentName(run.agentId)))].join(", "),
          })}
        </p>
      )}
    </div>
  );
}
