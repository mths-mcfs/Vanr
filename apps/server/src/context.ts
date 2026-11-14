import type { ActiveRun, Message, MessageMeta, Role } from "@vanr/contract";
import type { BlobStore } from "@vanr/engine/blobs";
import type { Db } from "@vanr/engine/db";
import type { ModelProvider } from "@vanr/engine/models/types";
import type { Sealer } from "@vanr/engine/seal";
import type { PgSearchIndex } from "@vanr/engine/search-pg";
import type { SqlConnector } from "@vanr/engine/sqlconn";
import type { BudgetScope, UsageLedger, UsageSource } from "@vanr/engine/usage";
import type { Context } from "hono";
import type { AgentRow } from "./agents";
import type { Auth } from "./auth";
import type { ChannelRow } from "./channels";
import type { Config } from "./config";
import type {
  ApprovalOutcome,
  MessageRow,
  QuestionRow,
  RevisedApproval,
  RunEnd,
  RunLimits,
} from "./forward-types";
import { unauthorized } from "./http";
import type { Mailer } from "./mailer";
import type { PushSender } from "./push";
import type { Hub } from "./realtime/hub";
import type { RunnerHub } from "./runners/hub";

/**
 * Everything the routes need. Each slice of the server adds what it uses: S3 adds `wikiLive` (wiki-collab) and S5 adds `assignmentEngine` and `assignmentVerifier` (assignments/motor,
 * assignments/verify). The runtime is already here as a port; S6 puts the real one behind it.
 */
export interface AppDeps {
  config: Config;
  db: Db;
  auth: Auth;
  mailer: Mailer;
  /** Files; the Drive's go to the workspace's S3 once it configured one. */
  blobs: BlobStore;
  /** The server's own storage (the source of a migration to S3). */
  localBlobs: BlobStore;
  now: () => Date;
  /** Real time: who is connected and where each event goes. */
  hub: Hub;
  /**
   * The search index (Postgres). Whoever saves a source calls `reindex`, which reads the source back from the
   * database (search-index.ts); whoever hides it calls `unindex` in the same transaction.
   */
  search: PgSearchIndex;
  /**
   * Usage ledger and cap: every model call reserves before and records after. Routines, assignments,
   * debates and teams use it through here, with their own scopes.
   */
  ledger: UsageLedger;
  /** Cipher of the API keys kept in the database. */
  sealer: Sealer;
  /** Outgoing requests (GitHub). Tests replace it with a fake one. */
  fetchExternal: typeof fetch;
  /** Connection to the databases workspaces connect (a real Postgres; PGlite in the tests). */
  sql: SqlConnector;
  /** Paired runners connected now and the RPC with them. */
  runners: RunnerHub;
  /** Web Push (VAPID): public key and encrypted sending. */
  push: PushSender;
  /** Agents: routing, runs and reminders, as the modules outside runtime/ see them. */
  runtime: RuntimePort;
  /** For each agent of the workspace, whether the test model answers it now (no key). */
  testModelFor: (
    workspaceId: string,
  ) => Promise<(agent: Pick<AgentRow, "credentialId" | "harnessKind">) => boolean>;
}

/** What `RuntimePort.complete` asks for: a text from an agent outside a conversation. */
export interface CompleteInput {
  agent: AgentRow;
  /** Who asked (a routine, a debate). A personal-plan agent only serves whoever paired its runner. */
  initiatedBy: string | null;
  system: string;
  prompt: string;
  what: string;
  maxTokens?: number;
  /** The feature that pays for the call in the ledger (required: without it the line has no owner). */
  source: UsageSource;
  /** Caps beyond the agent's month (e.g. `routine_run`, `debate`, `assignment`). */
  scopes?: readonly BudgetScope[];
  /** The assignment that pays for the call (it goes into the ledger line). */
  assignmentId?: string;
  /** A debate's turn or synthesis: the run follows the debate's visibility (and hides while it is anonymous). */
  debateId?: string;
  /** The channel the request came from: whoever doesn't read it sees the run without the `what`. */
  sourceChannelId?: string | null;
  /** The call's time limit (default 15 min). */
  timeoutMs?: number;
  /** Another model than the agent's (the approvals reviewer uses Haiku). */
  model?: string;
  /** The channel the spend belongs to: it goes into the ledger and into the channel's cap. */
  channelId?: string | null;
}

export type CompleteResult =
  | { ok: true; text: string; runId: string }
  | {
      ok: false;
      code: "budget" | "routine_budget" | "failed" | "personal_plan";
      error: string;
      /** Which cap rejected it (only on `budget` and `routine_budget`). */
      scope?: BudgetScope["kind"];
    };

/**
 * The agent runtime as the modules outside runtime/ call it: exactly the methods they call in the origin.
 * Slice S6 (runtime/runtime) implements all of it. Until then the server answers `track` and `settle` with
 * the background work (runtime/background.ts) and every other method throws `not_available`; a route whose
 * flow can reach one of those is rejected at its entry, before any write. Each method says who calls it and
 * the slice that brings the caller in.
 */
export interface RuntimePort {
  /**
   * Background work that `settle` also waits for; its error is logged and breaks nothing. Callers:
   * the notification queue (S1b), agent-lab (S2), debates, routines and memory-consolidation (S3), mail-trigger
   * and routes/routines (S4), the assignment engine (S5).
   */
  track(work: Promise<unknown>, what: string): void;
  /** Waits until every run and every background work ended (tests and shutdown). Caller: the debate harness (S4). */
  settle(): Promise<void>;
  /**
   * Asks an agent for a text outside a conversation (a debate turn, a synthesis, a routine that writes a
   * file), reserving on the caps first. Callers: agent-lab (S2), debates, routines, memory-consolidation and
   * the assignment verifier (S3), agent-builder and skill-drafts (S4).
   */
  complete(input: CompleteInput): Promise<CompleteResult>;
  /**
   * Runs the agent for one message without a mention (a scheduled routine); a message for a conversation
   * the agent is already running in goes into that run. Callers: routines (S3), the assignment engine (S5).
   */
  runFor(input: {
    agent: AgentRow;
    channel: ChannelRow;
    trigger: MessageRow;
    replyMeta?: MessageMeta;
    /** The run's hard caps. With them, the message doesn't go into a run already live in the conversation (`busy`). */
    limits?: RunLimits;
  }): Promise<
    | { ok: true; runId: string; done: Promise<void> }
    | { ok: false; code: "budget" | "personal_plan" | "busy" }
  >;
  /** The agent's active run in that conversation. Callers: assignments/engine and the assignment engine (S5). */
  activeRun(agentId: string, channelId: string, threadId: string | null): string | null;
  /** Live runs of the workspace (or of one channel). Caller: routes/agents (S5). */
  activeRuns(filter: { workspaceId: string; channelId?: string }): ActiveRun[];
  /** Where a live run is. Caller: the assignment engine (S5). */
  liveRun(runId: string): { workspaceId: string; channelId: string } | null;
  /** Who may stop a live run: whoever started it and the agent's owner. Caller: routes/agents (S5). */
  liveInfo(runId: string): { triggerAuthorId: string; ownerUserId: string } | null;
  /** Stops the run; false when it had already ended. Callers: assignments/engine, the assignment engine and routes/agents (S5). */
  cancel(runId: string, actorUserId: string | null): boolean;
  /** Tells the end of every run (after its status is saved). Caller: the assignment engine (S5). */
  onRunEnd(listener: (end: RunEnd) => void): void;
  /** Called after a person posts; doesn't wait for the runs. Caller: assignments/core (S3). */
  onPersonMessage(input: { workspaceId: string; channel: ChannelRow; message: Message }): Promise<void>;
  /** The workspace's provider (its default credential or the platform's), before the agent exists. Caller: agent-builder (S4). */
  providerForWorkspace(workspaceId: string): Promise<ModelProvider | { error: string }>;
  /** Whether the agent is in a run now. Caller: routes/agents (S5). */
  isBusy(agentId: string): boolean;
  /** The agents in a run now. Caller: routes/agents (S5). */
  busyAgents(): Set<string>;
  /** Whether a run waits on this approval. Caller: routes/control (S5). */
  awaitsApproval(approvalId: string): boolean;
  /** The route decided: wakes the waiting run; false when no run waits. Caller: routes/control (S5). */
  resolveApproval(approvalId: string, outcome: ApprovalOutcome): boolean;
  /**
   * The person edited the approval before deciding: the run validates and returns the new effect, or the
   * error the route answers as 400; null when no run waits. Caller: routes/control (S5).
   */
  reviseApproval(
    approvalId: string,
    edits: Record<string, unknown>,
  ): Promise<RevisedApproval | { error: string } | null>;
  /** Answers an open question and wakes the run; null when it was no longer open. Caller: routes/control (S5). */
  answerQuestion(questionId: string, answer: string, actorUserId: string): Promise<QuestionRow | null>;
  /** Delivers the send queue at `at` without waiting for the next sweep. Caller: outbox (S3). */
  wakeAt(at: Date): void;
}

/** Marks a runtime method that isn't there yet (the port in server.ts until slice S6); it holds the thrower. */
export const ABSENT = Symbol("runtime.absent");

/**
 * Rejects at an entry, before any write, when a runtime method the flow will reach isn't there yet: the absent
 * method throws `not_available` itself. With the real runtime (S6) it does nothing.
 */
export function requireRuntime(runtime: RuntimePort, method: keyof RuntimePort): void {
  const absent: unknown = Reflect.get(runtime[method], ABSENT);
  if (typeof absent === "function") absent();
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  role: Role;
  handle: string;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    user: SessionUser | null;
    /** Set by the middleware of /api/v1/workspaces/:workspaceId. */
    member: WorkspaceMember | null;
  };
};

export type Ctx = Context<AppEnv>;

export function requireUser(c: Ctx): SessionUser {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}
