// An agent's runs in one conversation while they happen, built from the run events. Nothing here is
// stored: the answer the run posts (`message.posted`) takes the place of the streamed text, and the list
// of active runs (`listChannelActiveRuns`) is the truth whenever it is read again.
import type { ActiveRun } from "@vanr/contract";

/** A step of a live run: a note the agent made between tools, or a tool it called. */
export type LiveStep =
  | { kind: "note"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      tool: string;
      detail: string | null;
      /** What the tool was asked, when the saved steps carry it. */
      input: string | null;
      output: string | null;
      isError: boolean;
      running: boolean;
    };

export type LiveRun = {
  runId: string;
  agentId: string;
  threadId: string | null;
  status: string;
  /** The person who asked for this work; null for a routine, or before the server says. */
  initiatedBy: string | null;
  startedAt: number;
  /** The text of the current turn, as it streams. */
  text: string;
  /** The last text delta applied; a delta at or below it is a repeat. */
  lastSeq: number;
  steps: LiveStep[];
  lastEventAt: number;
  /** Set once the run ended with an answer: the line stays until that answer is on screen. */
  answerId: string | null;
  endedAt: number | null;
};

/** The run events this file reads, by name, with the fields it reads. */
export type RunEvent =
  | { type: "run.status_changed"; status?: string; initiatedBy?: string | null; startedAt?: string }
  | { type: "run.text_delta"; text?: string; seq?: number }
  | { type: "run.commentary"; text?: string }
  | { type: "run.tool_call"; tool?: string | null; toolUseId?: string; detail?: string | null }
  | { type: "run.tool_result"; toolUseId?: string; text?: string; isError?: boolean; tool?: string }
  | { type: "run.completed"; messageId?: string | null }
  | { type: "run.stopped" }
  | { type: "run.idle" };

export type RunEventBase = { runId?: string; agentId: string; threadId?: string | null };

/** A run without a word or an event for this long is shown as quiet, with a way to check on it. */
export const QUIET_AFTER_MS = 3 * 60_000;
/** An ended run whose answer never shows (it was hidden, or went to a thread) leaves after this. */
export const LANDING_MS = 10_000;

function fresh(base: RunEventBase & { runId: string }, now: number): LiveRun {
  return {
    runId: base.runId,
    agentId: base.agentId,
    threadId: base.threadId ?? null,
    status: "running",
    initiatedBy: null,
    startedAt: now,
    text: "",
    lastSeq: -1,
    steps: [],
    lastEventAt: now,
    answerId: null,
    endedAt: null,
  };
}

function withRun(
  runs: readonly LiveRun[],
  base: RunEventBase & { runId: string },
  now: number,
  change: (run: LiveRun) => LiveRun,
): LiveRun[] {
  const found = runs.find((run) => run.runId === base.runId);
  const next = change({ ...(found ?? fresh(base, now)), lastEventAt: now });
  return found === undefined ? [...runs, next] : runs.map((run) => (run === found ? next : run));
}

/** The runs after one event. An event without a run id changes nothing. */
export function applyRunEvent(
  runs: readonly LiveRun[],
  base: RunEventBase,
  event: RunEvent,
  now: number,
): readonly LiveRun[] {
  const { runId } = base;
  if (runId === undefined) return runs;
  const known = runs.find((run) => run.runId === runId);
  // A run that already ended only waits for its answer: late events do not bring it back.
  if (known?.endedAt != null) return runs;
  const at = { ...base, runId };
  switch (event.type) {
    case "run.stopped":
    case "run.idle":
      return runs.filter((run) => run.runId !== runId);
    case "run.completed":
      if (known === undefined) return runs;
      if (event.messageId == null) return runs.filter((run) => run.runId !== runId);
      return withRun(runs, at, now, (run) => ({ ...run, answerId: event.messageId ?? null, endedAt: now }));
    case "run.status_changed":
      return withRun(runs, at, now, (run) => ({
        ...run,
        status: event.status ?? run.status,
        initiatedBy: event.initiatedBy ?? run.initiatedBy,
        startedAt: event.startedAt === undefined ? run.startedAt : Date.parse(event.startedAt),
      }));
    case "run.text_delta": {
      const seq = event.seq ?? (known?.lastSeq ?? -1) + 1;
      if (known !== undefined && seq <= known.lastSeq) return runs;
      return withRun(runs, at, now, (run) => ({ ...run, text: run.text + (event.text ?? ""), lastSeq: seq }));
    }
    case "run.commentary":
      // The text of the turn so far became a note before a tool: it moves into the steps.
      return withRun(runs, at, now, (run) => ({
        ...run,
        text: "",
        steps:
          event.text === undefined || event.text === ""
            ? run.steps
            : [...run.steps, { kind: "note", key: `note-${run.steps.length}`, text: event.text }],
      }));
    case "run.tool_call": {
      const id = event.toolUseId ?? "";
      if (event.tool == null)
        return withRun(runs, at, now, (run) => ({
          ...run,
          steps: run.steps.map((step) =>
            step.kind === "tool" && step.key === id ? { ...step, running: false } : step,
          ),
        }));
      const tool = event.tool;
      return withRun(runs, at, now, (run) =>
        run.steps.some((step) => step.key === id)
          ? run
          : {
              ...run,
              steps: [
                ...run.steps,
                {
                  kind: "tool",
                  key: id,
                  tool,
                  detail: event.detail ?? null,
                  input: null,
                  output: null,
                  isError: false,
                  running: true,
                },
              ],
            },
      );
    }
    case "run.tool_result":
      return withRun(runs, at, now, (run) => ({
        ...run,
        steps: run.steps.map((step) =>
          step.kind === "tool" && step.key === event.toolUseId
            ? { ...step, output: event.text ?? "", isError: event.isError === true }
            : step,
        ),
      }));
  }
}

/**
 * The runs once the server's list of active runs arrived. The list is the truth for what is running;
 * a run the list lacks stays only while it is newer than the list (it started after the list was read)
 * or is waiting for its answer to show.
 */
export function reconcile(
  runs: readonly LiveRun[],
  active: readonly ActiveRun[],
  readAt: number,
  ended: ReadonlySet<string> = new Set(),
): readonly LiveRun[] {
  // A run known to have ended stays ended, even when a list read before the end still names it.
  const listed = new Map(active.filter((run) => !ended.has(run.runId)).map((run) => [run.runId, run]));
  const kept = runs.flatMap((run): LiveRun[] => {
    const row = listed.get(run.runId);
    if (row !== undefined)
      return [{ ...run, status: row.status, initiatedBy: row.initiatedBy, threadId: row.threadId }];
    return run.endedAt !== null || run.lastEventAt > readAt ? [run] : [];
  });
  const known = new Set(runs.map((run) => run.runId));
  const added = [...listed.values()]
    .filter((row) => !known.has(row.runId))
    .map(
      (row): LiveRun => ({
        ...fresh(
          { runId: row.runId, agentId: row.agentId, threadId: row.threadId },
          Date.parse(row.lastPingAt),
        ),
        status: row.status,
        initiatedBy: row.initiatedBy,
        startedAt: Date.parse(row.startedAt),
      }),
    );
  return [...kept, ...added];
}

/** The runs still worth a line: an ended one goes once its answer is on screen, or after a while. */
export function showing(runs: readonly LiveRun[], answers: ReadonlySet<string>, now: number): LiveRun[] {
  return runs.filter(
    (run) =>
      run.endedAt === null ||
      (!(run.answerId !== null && answers.has(run.answerId)) && now - run.endedAt < LANDING_MS),
  );
}

export const isQuiet = (run: LiveRun, now: number) =>
  run.endedAt === null && now - run.lastEventAt >= QUIET_AFTER_MS;
