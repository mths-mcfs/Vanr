// Agent runs and their steps.

export type RunStatus =
  | "canceled"
  | "done"
  | "failed"
  | "paused_for_approval"
  | "paused_for_input"
  | "queued"
  | "running";

export interface Run {
  id: string;
  agentId: string;
  cachedTokens: number;
  channelId: string | null;
  costUsd: number;
  createdAt: string;
  deniedRepo: string | null;
  error: string | null;
  errorCode: string | null;
  errorVars: Record<string, string | number> | null;
  finishedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  repo: string | null;
  sourceMessageId: string | null;
  status: RunStatus;
  threadId: string | null;
  what: string;
}

export type RunStepKind = "text" | "tool_call" | "tool_result";

export interface RunStep {
  createdAt: string;
  data: {
    commentary?: string;
    content?: string;
    input?: unknown;
    isError?: boolean;
    name?: string;
    text?: string;
    toolUseId?: string;
    turn?: number;
  };
  kind: RunStepKind;
  seq: number;
}

export interface ActiveRun {
  agentId: string;
  /** The agent used the browser in this run and did not close it. */
  browser: boolean;
  channelId: string;
  heartbeatAt: string;
  /** Person who asked for this work; null when it came from a routine (schedule, event, email). */
  requestedBy: string | null;
  runId: string;
  sourceMessageId: string | null;
  startedAt: string;
  status: RunStatus;
  threadId: string | null;
}
