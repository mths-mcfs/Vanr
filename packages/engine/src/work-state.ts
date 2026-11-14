// Work states and activities. One work state enum for chat, team, assignment, inbox, issue, routine and
// debate; the activity kinds of a run; and the table of tone, icon and text.
//
// The state comes from the server's event (the stored status), never from guessing in the web app. Each
// screen converts its status with the functions below and draws it with WORK_STATE_VISUAL.
//
// No database or Bun dependency: the web app imports this file. The status types are the contract's.
import type {
  AssignmentStatus,
  DebateStatus,
  JobStatus,
  PlanItemStatus,
  RoutineRunStatus,
  RunStatus,
  WorkStateName,
} from "@vanr/contract";

/**
 * running: an agent working · blocked_on_you: stopped, waiting on a person · stopped: stopped without news
 * (stale) or paused · due: scheduled, with a time · failed: failed · done: done or closed.
 */
export const WORK_STATES = [
  "running",
  "blocked_on_you",
  "stopped",
  "due",
  "failed",
  "done",
] as const satisfies readonly WorkStateName[];

/** Tone of the UI Chip (blue agent, amber waiting on you, green done, red failed). */
type WorkTone = "agent" | "waiting" | "neutral" | "done" | "danger";

interface WorkStateVisual {
  tone: WorkTone;
  /** Icon name from the UI kit (IconName). */
  icon: "sparkle" | "question" | "pause" | "clock" | "warning" | "check";
  /** i18n key of the short label. */
  labelKey: `workState.${WorkStateName}`;
  /** Announce in a polite region when entering this state. */
  announce: boolean;
}

export const WORK_STATE_VISUAL: Record<WorkStateName, WorkStateVisual> = {
  running: { tone: "agent", icon: "sparkle", labelKey: "workState.running", announce: true },
  blocked_on_you: { tone: "waiting", icon: "question", labelKey: "workState.blocked_on_you", announce: true },
  stopped: { tone: "neutral", icon: "pause", labelKey: "workState.stopped", announce: false },
  due: { tone: "neutral", icon: "clock", labelKey: "workState.due", announce: false },
  failed: { tone: "danger", icon: "warning", labelKey: "workState.failed", announce: true },
  done: { tone: "done", icon: "check", labelKey: "workState.done", announce: true },
};

// ---- stored statuses → work state ----

export function runWorkState(status: RunStatus): WorkStateName {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "paused_for_input":
    case "paused_for_approval":
      return "blocked_on_you";
    case "failed":
      return "failed";
    case "canceled":
      return "stopped";
    case "done":
      return "done";
  }
}

/** `waitingOnPerson`: a pending decision, review, command or submission (the threads' action-needed rule). */
export function assignmentWorkState(
  status: AssignmentStatus,
  o: { waitingOnPerson: boolean; stale?: boolean },
): WorkStateName {
  if (status === "done") return "done";
  if (status === "canceled") return "stopped";
  if (o.waitingOnPerson || status === "proposed" || status === "wrapping_up") return "blocked_on_you";
  if (status === "paused" || o.stale) return "stopped";
  return "running";
}

export function planItemWorkState(status: PlanItemStatus): WorkStateName {
  switch (status) {
    case "todo":
      return "due";
    case "doing":
      return "running";
    case "blocked_on_you":
      return "blocked_on_you";
    case "done":
      return "done";
    case "dropped":
      return "stopped";
  }
}

export function jobWorkState(status: JobStatus): WorkStateName {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "canceled":
      return "stopped";
  }
}

/** A skipped routine is just a skip (not "blocked on you"): neutral. Pending or queued has a time to run. */
export function routineRunWorkState(status: RoutineRunStatus): WorkStateName {
  if (status === "failed") return "failed";
  if (status === "skipped") return "stopped";
  if (status === "running") return "running";
  if (status === "pending" || status === "queued") return "due";
  return "done";
}

export function debateWorkState(status: DebateStatus, o: { waitingPerson: boolean }): WorkStateName {
  if (status === "done") return "done";
  if (status === "canceled" || status === "stalled") return "stopped";
  return o.waitingPerson ? "blocked_on_you" : "running";
}

// ---- activities of a run ----

const ACTIVITY_KINDS = ["thought", "action", "elicitation", "response", "error"] as const;
/**
 * thought: the agent's intermediate speech · action: a tool call (with its result) · elicitation: a question or
 * approval for a person · response: the final answer · error: a failure.
 */
type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  kind: ActivityKind;
  runId: string;
  /** Order within the run (the run event's seq). */
  seq: number;
  at: string;
  text?: string;
  /** action: the tool's name and result. */
  tool?: string;
  ok?: boolean;
  /** elicitation: the linked approval or question. */
  approvalId?: string;
  questionId?: string;
}

/** A stored step (run events). The last text of the run becomes the response. */
interface StoredStep {
  seq: number;
  kind: "text" | "tool_call" | "tool_result";
  at: string;
  data: { text?: string; name?: string; isError?: boolean; toolUseId?: string };
}

/**
 * Activities of a run from the stored steps. Each tool's result joins its action; `ask_user` and
 * `request_approval` become elicitation.
 */
export function activitiesFromSteps(runId: string, steps: readonly StoredStep[], failed = false): Activity[] {
  const out: Activity[] = [];
  const byUse = new Map<string, Activity>();
  const lastText = steps.reduce((last, s, i) => (s.kind === "text" ? i : last), -1);
  steps.forEach((s, i) => {
    if (s.kind === "text") {
      out.push({
        kind: i === lastText && !failed ? "response" : "thought",
        runId,
        seq: s.seq,
        at: s.at,
        text: s.data.text,
      });
    } else if (s.kind === "tool_call") {
      const name = s.data.name ?? "";
      const kind: ActivityKind =
        name === "ask_user" || name === "request_approval" ? "elicitation" : "action";
      const a: Activity = { kind, runId, seq: s.seq, at: s.at, tool: name };
      if (s.data.toolUseId) byUse.set(s.data.toolUseId, a);
      out.push(a);
    } else {
      const a = s.data.toolUseId ? byUse.get(s.data.toolUseId) : undefined;
      if (a) a.ok = s.data.isError !== true;
    }
  });
  if (failed)
    out.push({ kind: "error", runId, seq: (steps.at(-1)?.seq ?? 0) + 1, at: steps.at(-1)?.at ?? "" });
  return out;
}
