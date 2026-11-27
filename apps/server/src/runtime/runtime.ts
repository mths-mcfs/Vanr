// The agents' runtime: routes people's messages, runs at most one run per agent and conversation, streams
// the work over the channel's WebSocket, records the steps and posts the final answer.
//
// Conversation = (agent, channel, thread). A new message in a conversation with a live run goes into it
// (`run.steered`); a lone "stop" stops the run.
//
// Control: every tool call goes through the gate (seam 1) with the run's A/B/C flags; what it asks for puts the
// run in `paused_for_approval` until the decision (or 24 h); `ask_user` puts it in `paused_for_input` until the
// asked person answers, on the card or with a message in the conversation. At boot the server cancels the
// approvals and questions of runs that no longer exist.
//
// Cost: every model call through the API reserves its worst case on the agent's cap first (seam 2) and records
// the real cost in the ledger after; without room for the reservation, the call doesn't go out.

import type { ActiveRun, HandledStatus, Message, MessageMeta, RunStatus } from "@vanr/contract";
import { actionCredential, type CredentialRef } from "@vanr/engine/action-credential";
import { schema } from "@vanr/engine/db";
import { breakerOpen, type GateDecision, RiskTracker } from "@vanr/engine/effects";
import { newId } from "@vanr/engine/ids";
import { ADVISOR_MAX_TOKENS, advisorPairOk, DEFAULT_MODEL } from "@vanr/engine/models/catalog";
import { PRICES } from "@vanr/engine/models/prices";
import {
  type AdvisorSpec,
  addUsage,
  emptyUsage,
  ModelError,
  type ModelMessage,
  type ModelProvider,
  type Usage,
} from "@vanr/engine/models/types";
import { parseMentions } from "@vanr/engine/text";
import {
  type BudgetScope,
  estimateUsd,
  type Reservation,
  type UsageSource,
  utf8Bytes,
} from "@vanr/engine/usage";
import { PRODUCT } from "@vanr/product";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { failInterruptedAgentJobs } from "../agent-lab";
import { memoryPrompt } from "../agent-memory";
import { type AgentRow, agentBudgetScope, agentNames, monthKey, workspaceBudgetDefaults } from "../agents";
import { assignmentOfRun } from "../assignments/budget";
import { publishAssignment } from "../assignments/core";
import { assignmentPrompt, assignmentRouting } from "../assignments/tools";
import { type ChannelRow, channelBudgetScope, channelSpendScope } from "../channels";
import type { AppDeps, CompleteInput, CompleteResult, RuntimePort } from "../context";
import {
  DECISION_TTL_MS,
  publishActions,
  publishApproval,
  publishQuestion,
  type QuestionRow,
  toQuestion,
  trailEntry,
  UNDO_WINDOW_MS,
} from "../control";
import { debateDeadlines, resumeDebates } from "../debates";
import { pollEmailRoutines } from "../integrations/mail-trigger";
import { resumeStorageMigrations } from "../integrations/storage";
import { toolsFor } from "../integrations/tools";
import { settleIssueWork } from "../issues";
import { log } from "../logger";
import { type MessageRow, postMessage } from "../messages";
import { closeNotifications, notificationTick } from "../notifications";
import { deliverDue } from "../outbox";
import { drainQueues, dueRoutines } from "../routines";
import {
  canUsePlan,
  EXECUTOR_NAME,
  PERSONAL_PLAN_TEXT,
  runHarnessFor,
  withPlanOwner,
  withPlanOwners,
} from "../runners/plans";
import { expireRunnerRequests } from "../runners/requests";
import { canUseRunner, type RunnerRow } from "../runners/runners";
import { matchRule } from "../standing-rules";
import { purgeReservations } from "../usage-ledger";
import { BackgroundWork } from "./background";
import { HarnessError, harnessNotice, remoteProvider, type ToolInvoker } from "./remote-harness";
import {
  personSaid,
  REVIEWER_MAX_TOKENS,
  REVIEWER_MODEL,
  REVIEWER_SYSTEM,
  recentVerdicts,
  reviewPrompt,
  verdictOf,
} from "./reviewer";
import { type BlockReason, isStopRequest, type RouteAgent, route } from "./route";
import { pinnedTools, withLoading } from "./tool-loading";
import {
  type ApprovalOutcome,
  type ApprovalRequest,
  cut,
  type DecisionBy,
  type ReviewRequest,
  runTool,
  type ToolContext,
  toolSpecs,
} from "./tools";

const {
  agents,
  runs,
  runEvents,
  messages,
  channelMemberships,
  channels,
  messageDispatches,
  skills,
  skillGrants,
} = schema;
const {
  members,
  workspaces,
  users,
  reminders,
  delegations,
  approvals,
  questions,
  reversibleActions,
  assignments,
  assignmentCommands,
  gateDecisions,
  runners,
} = schema;

type Answer = { answer: string; actorUserId: string } | null;

const ACTIVE_STATUSES = ["queued", "running", "paused_for_input", "paused_for_approval"] as const;
const MAX_TURNS = 12;
const MAX_TOKENS = 16_000;
const HISTORY_LIMIT = 30;
const HEARTBEAT_MS = 15_000;
/** The server gives up on a delegation after 15 min (the client shows up to 20). */
const CONSULT_TIMEOUT_MS = 15 * 60_000;
const CONSULT_MAX_TOKENS = 4000;
const BUDGET_WARNING_RATIO = 0.8;
/** The channel cap's warnings: one of each per month, plus the "ran out" one. */
const CHANNEL_WARNINGS = [0.75, 0.9] as const;

/** Only the workspace and the credential decide the provider (drafting an agent asks before the agent exists). */
export type ProviderLookup = (
  agent: Pick<AgentRow, "workspaceId" | "credentialId">,
) => Promise<ModelProvider | ProviderUnavailable>;

/** Why there is no provider for the agent; it becomes the run's `errorCode`. */
export type ProviderUnavailable = { error: "no_credential" | "unsupported_provider" };

export interface RuntimeOptions {
  providerFor: ProviderLookup;
  /** The sweep's interval; 0 turns the timer off (the tests call tick()). */
  tickEveryMs?: number;
}

class RunCanceled extends Error {
  constructor() {
    super("Run canceled");
    this.name = "RunCanceled";
  }
}

/** The month's cap (the agent's or the channel's) or the execution's (`routine_run`) doesn't fit the next call: the reservation was rejected. */
class BudgetExhausted extends Error {
  constructor(readonly scope: BudgetScope["kind"] = "agent") {
    super(
      scope === "assignment"
        ? "Assignment budget exhausted"
        : scope === "channel"
          ? "Channel monthly budget exhausted"
          : scope === "routine_run"
            ? "Routine run spending cap reached"
            : "Monthly budget exhausted",
    );
    this.name = "BudgetExhausted";
  }
}

/** The end of a run, for whoever follows it (the assignment engine wakes the thread's assignment). */
export interface RunEnd {
  runId: string;
  workspaceId: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  status: "done" | "failed" | "canceled";
  errorCode: string | null;
}

/** The run went past the model turns the caller allowed (`RunLimits.maxTurns`). */
class StepLimit extends Error {
  constructor(turns: number) {
    super(`Stopped after ${turns} model turns (step limit)`);
    this.name = "StepLimit";
  }
}

/** The server is stopping: no run starts. */
class RuntimeStopping extends Error {
  constructor() {
    super("The agent runtime is stopping");
    this.name = "RuntimeStopping";
  }
}

/** The run went past the time the caller allowed (`RunLimits.timeoutMs`). */
class TimeLimit extends Error {
  constructor(ms: number) {
    super(`Stopped after ${Math.round(ms / 60_000)} min (time limit)`);
    this.name = "TimeLimit";
  }
}

/**
 * A fencing token for `runFor`: one key per piece of work (an assignment's item) and a token that grows with each
 * attempt. A late attempt with a lower token than one already seen gets `fenced`, and `cancel` with the fence only
 * stops the run while that attempt is still the last one that went into it.
 */
export interface RunFence {
  key: string;
  token: number;
}

/**
 * The hard caps of a run nobody follows (a routine's execution): spend caps beyond the agent's month, model
 * turns and time. Past any of them the run stops with `budget_exhausted` (`routine_budget` when it was the
 * execution's cap), `step_limit` or `time_limit`.
 */
export interface RunLimits {
  scopes: readonly BudgetScope[];
  maxTurns: number;
  timeoutMs: number;
  /**
   * The execution's key (the same on every attempt): an outside effect (K2/K3 or an external destination)
   * with the same key and the same payload doesn't run again on the retry.
   */
  effectKey?: string;
}

interface Live {
  runId: string;
  workspaceId: string;
  agent: AgentRow;
  channel: ChannelRow;
  threadId: string | null;
  key: string;
  trigger: MessageRow;
  /** Messages that arrived during the run and aren't in the context yet. */
  inbox: MessageRow[];
  /** Messages this run will still answer (the trigger and the ones that joined later). */
  handles: string[];
  /**
   * The run already decided its final answer (or failed) and is closing: a new message no longer joins it.
   * It waits here and opens a new run as soon as this one ends.
   */
  closing: boolean;
  after: MessageRow[];
  controller: AbortController;
  canceledBy: string | null;
  status: RunStatus;
  startedAt: Date;
  lastPingAt: Date;
  done: Promise<void>;
  /** This run's open question: the asked person's next message answers it. */
  waitingQuestion: { id: string; askedUserId: string | null } | null;
  /** The run's A/B/C flags (seam 1): the gate reads them before each tool. */
  risk: RiskTracker;
  /** Extra meta on this run's answers (e.g. `fromRoutine`). */
  replyMeta?: MessageMeta;
  /**
   * The runner whose plan (Claude Code/Codex) this run uses. A message from someone who can't use the plan
   * doesn't join the run: it waits and opens its own run after.
   */
  plan: RunnerRow | null;
  /**
   * The runner lent to the agent when the run started. The run's tools act with the access of whoever started
   * it, so a message from someone who may not use this runner doesn't join the run: it opens its own, checked
   * for that person.
   */
  runner: RunnerRow | null;
  /** The agent used the browser in this run and didn't close it: whoever reopens the conversation sees the card (`activeRuns`). */
  browser: boolean;
  /** The agent's assignment thread: the calls also reserve on its cap and go into the ledger as `assignment`. */
  assignment: { assignmentId: string; scope: BudgetScope | null } | null;
  /** The end's code (a failure), for the end-of-run notice. */
  errorCode: string | null;
  /**
   * The run's `/memories/you` store: the person who asked, while only they spoke in it (`id`), and whether the
   * run already opened their store (`pinned`). Someone else who speaks before the store opens takes the store
   * away from the run; once it is open, their message waits for its own run, because the context already holds the owner's data.
   */
  person: { id: string | null; pinned: boolean };
  /** The run's hard caps (a routine); without them the agent's month and `MAX_TURNS` apply. */
  limits?: RunLimits;
  /** The last fenced attempt that went into this run (`runFor`). */
  fence?: RunFence;
}

/**
 * The run takes no more messages: its last turn already looked at the inbox, or it was stopped (the abort lands at
 * its next await). What comes now is the next run's.
 */
const ending = (live: Pick<Live, "closing" | "controller">) => live.closing || live.controller.signal.aborted;

const personOf = (row: Pick<MessageRow, "authorKind" | "authorId">) =>
  row.authorKind === "person" ? row.authorId : null;
/**
 * Who asked for the run now: the trigger message's person. A routine (schedule, event, email) posts with its
 * creator as the author, but nobody is waiting; then it is null.
 */
/**
 * The caps a run's model calls pay into beyond the agent's month: its routine execution's and its assignment's.
 * The run's own turns, its delegations and its reviewer all reserve against them.
 */
const capsOf = (live: Pick<Live, "limits" | "assignment">): BudgetScope[] => [
  ...(live.limits?.scopes ?? []),
  ...(live.assignment?.scope ? [live.assignment.scope] : []),
];

export const requesterOf = (row: Pick<MessageRow, "authorKind" | "authorId" | "meta">) =>
  row.meta.routine ? null : personOf(row);
/**
 * The budget is the API's. An agent that thinks on a runner (a plan, no cost here) isn't stopped before the
 * run; if the run falls back to the model through the API, the run itself checks the budget before calling.
 */
const apiBudgetGates = (agent: AgentRow) => agent.harnessKind === "model";

/** The agent's advisor as it goes in the request, or nothing (off, or a pair that stopped being valid). */
function advisorOf(agent: AgentRow): AdvisorSpec | undefined {
  if (!agent.advisorModel || !advisorPairOk(agent.model, agent.advisorModel)) return undefined;
  return { model: agent.advisorModel, maxUses: agent.advisorMaxUses, maxTokens: ADVISOR_MAX_TOKENS };
}

export class AgentRuntime implements RuntimePort {
  private readonly live = new Map<string, Live>();
  private readonly byKey = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Timers of the send queue's deliveries (one per due time), besides the tick's sweep. */
  private readonly wakes = new Set<ReturnType<typeof setTimeout>>();
  private ticking = false;
  private stopped = false;
  private readonly approvalWaiters = new Map<string, (o: ApprovalOutcome) => void>();
  /** A person's edit of a waiting approval: the run revalidates and plans again. */
  private readonly approvalRevisers = new Map<string, ApprovalRequest["revise"]>();
  private readonly questionWaiters = new Map<string, (a: Answer) => void>();
  private readonly background = new BackgroundWork();
  private readonly runEndListeners: ((end: RunEnd) => void)[] = [];
  /** The highest token seen per fence key (`runFor`). */
  private readonly fences = new Map<string, number>();
  /** The tail of each conversation key's admissions (`admit`). */
  private readonly admissions = new Map<string, Promise<void>>();

  constructor(
    private readonly getDeps: () => AppDeps,
    private readonly opts: RuntimeOptions,
  ) {}

  private get deps(): AppDeps {
    return this.getDeps();
  }

  /**
   * Runs that were live when the server fell don't come back: they become `failed` with `interrupted`, the
   * approvals and questions they waited on are canceled (nobody will use the decision any more) and the
   * work asked of them is blocked.
   */
  async start(): Promise<void> {
    const at = this.deps.now();
    const { db } = this.deps;
    const dead = await db
      .select({ id: runs.id, workspaceId: runs.workspaceId })
      .from(runs)
      .where(inArray(runs.status, [...ACTIVE_STATUSES]));
    await this.closeWaits(null);
    // Work that waited on one of these runs ("Ask an agent") is blocked, not working forever.
    for (const run of dead) {
      const claimed = await db
        .select({ messageId: messageDispatches.messageId })
        .from(messageDispatches)
        .where(and(eq(messageDispatches.runId, run.id), eq(messageDispatches.state, "claimed")));
      await settleIssueWork(
        db,
        run.workspaceId,
        claimed.map((r) => r.messageId),
        { state: "blocked", reason: "interrupted", runId: run.id },
      );
    }
    // Last: a fall before this leaves the runs active, and the next boot does all of the above again for them.
    if (dead.length)
      await db
        .update(runs)
        .set({ status: "failed", errorCode: "interrupted", error: "Server restarted", finishedAt: at })
        .where(
          and(
            inArray(
              runs.id,
              dead.map((r) => r.id),
            ),
            inArray(runs.status, [...ACTIVE_STATUSES]),
          ),
        );
    // A debate open in the middle of a round moves again (the rounds run in memory).
    await resumeDebates(this.deps);
    // A Drive migration to S3 that the restart cut.
    await resumeStorageMigrations(this.deps);
    // Case evaluations and memory consolidations the restart cut become `failed`.
    await failInterruptedAgentJobs(this.deps.db);
    const every = this.opts.tickEveryMs ?? 15_000;
    if (every > 0) {
      // Tracked, so stop() waits for a sweep already under way before the database closes.
      this.timer = setInterval(() => this.track(this.tick(), "tick"), every);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.wakes) clearTimeout(t);
    this.wakes.clear();
    for (const l of this.live.values()) l.controller.abort(new RunCanceled());
    await this.settle();
  }

  /** Waits until every run and the background work ended (tests and shutdown). */
  async settle(): Promise<void> {
    do {
      // An admission under way may still write a run or a claim (it never waits for a run to end).
      await Promise.allSettled([...this.admissions.values()]);
      await Promise.allSettled([...this.live.values()].map((l) => l.done));
      await this.background.settle();
    } while (this.live.size > 0);
  }

  /** Tells the end of every run (after its status is saved). */
  onRunEnd(listener: (end: RunEnd) => void): void {
    this.runEndListeners.push(listener);
  }

  /**
   * Delivers the send queue at `at` (outbox.ts), without waiting for the next sweep. Without timers
   * (`tickEveryMs: 0`, the tests), only tick() delivers.
   */
  wakeAt(at: Date): void {
    if ((this.opts.tickEveryMs ?? 15_000) <= 0 || this.stopped) return;
    const t = setTimeout(
      () => {
        this.wakes.delete(t);
        this.track(deliverDue(this.deps), "outbox");
      },
      Math.max(0, at.getTime() - Date.now()) + 50,
    );
    this.wakes.add(t);
  }

  /** Background work (debate rounds, routines) that settle also waits for. */
  track(work: Promise<unknown>, what: string): void {
    this.background.track(work, what);
  }

  /**
   * The port with every method bound to this runtime, as a plain object: a test can spread it and replace one
   * method (`StartOptions.runtime`).
   */
  port(): RuntimePort {
    const bind = <K extends keyof RuntimePort>(k: K): RuntimePort[K] => {
      const method: unknown = this[k];
      if (typeof method !== "function") throw new Error(`runtime.${k} is not a method`);
      return method.bind(this);
    };
    return {
      track: bind("track"),
      settle: bind("settle"),
      complete: bind("complete"),
      runFor: bind("runFor"),
      activeRun: bind("activeRun"),
      activeRuns: bind("activeRuns"),
      liveRun: bind("liveRun"),
      liveInfo: bind("liveInfo"),
      cancel: bind("cancel"),
      dropFences: bind("dropFences"),
      onRunEnd: bind("onRunEnd"),
      onPersonMessage: bind("onPersonMessage"),
      providerForWorkspace: bind("providerForWorkspace"),
      isBusy: bind("isBusy"),
      busyAgents: bind("busyAgents"),
      awaitsApproval: bind("awaitsApproval"),
      resolveApproval: bind("resolveApproval"),
      reviseApproval: bind("reviseApproval"),
      answerQuestion: bind("answerQuestion"),
      wakeAt: bind("wakeAt"),
    };
  }

  /**
   * Asks an agent for a text outside a conversation (a debate turn, a synthesis, a routine that writes a file).
   * Reserves on the agent's monthly cap (and the scopes the caller passes: routine, debate, assignment) before
   * calling; without room it doesn't even call the model.
   */
  async complete(input: CompleteInput): Promise<CompleteResult> {
    const { db } = this.deps;
    const { agent } = input;
    const planOwner = (await withPlanOwner(db, agent)).planOwnerUserId;
    if (planOwner !== null && planOwner !== input.initiatedBy)
      return { ok: false, code: "personal_plan", error: `${agent.name} ${PERSONAL_PLAN_TEXT}` };
    const at = this.deps.now();
    const maxTokens = input.maxTokens ?? 4000;
    const model = input.model ?? agent.model;
    const channelId = input.channelId ?? null;
    const held = await this.reserveCall({
      agent,
      model,
      channelId,
      scopes: input.scopes,
      promptBytes: utf8Bytes(input.system) + utf8Bytes(input.prompt),
      maxTokens,
    });
    if (!held.ok) {
      const scope = held.scope.kind;
      if (scope === "channel" && channelId) {
        await this.channelBudgetCheck(channelId, input.initiatedBy, true);
        return { ok: false, code: "budget", scope, error: "This channel is out of budget this month" };
      }
      if (scope === "routine_run")
        return {
          ok: false,
          code: "routine_budget",
          scope,
          error: "The routine run spending cap does not fit this call",
        };
      // Only the agent's monthly cap tells the owner; a debate's cap belongs to whoever opened it.
      if (scope === "agent") {
        await this.budgetCheck(agent, true);
        return { ok: false, code: "budget", scope, error: `${agent.name} is out of budget this month` };
      }
      return { ok: false, code: "budget", scope, error: `${agent.name} hit the ${scope} budget cap` };
    }
    const reservation = held.reservation;
    // From here every way out settles or releases the reservation.
    const provider = await this.releasing(reservation, () => this.opts.providerFor(agent));
    if ("error" in provider) {
      await this.deps.ledger.release(reservation);
      return { ok: false, code: "failed", error: provider.error };
    }
    const runId = newId("run");
    await this.releasing(reservation, () =>
      db.insert(runs).values({
        id: runId,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        sourceChannelId: input.sourceChannelId ?? null,
        debateId: input.debateId ?? null,
        status: "running",
        what: whatOf(input.what),
        model,
        createdAt: at,
        startedAt: at,
      }),
    );
    let usage = emptyUsage();
    try {
      let text = "";
      let turned = false;
      for await (const ev of provider.stream({
        model,
        system: input.system,
        messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
        tools: [],
        maxTokens,
        signal: AbortSignal.timeout(input.timeoutMs ?? CONSULT_TIMEOUT_MS),
      })) {
        if (ev.type === "turn") {
          turned = true;
          usage = ev.usage;
          text = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
        }
      }
      if (!turned) throw new ModelError("network", "Stream ended without a turn");
      const cost = await this.settleCall(reservation, {
        agent,
        model,
        userId: input.initiatedBy,
        runId,
        channelId,
        source: input.source,
        usage,
        assignmentId: input.assignmentId ?? null,
      });
      await db
        .update(runs)
        .set({
          status: "done",
          finishedAt: this.deps.now(),
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost,
        })
        .where(eq(runs.id, runId));
      await this.budgetNotices(agent, channelId, input.initiatedBy);
      return { ok: true, text: text.trim(), runId };
    } catch (err) {
      await this.deps.ledger.release(reservation);
      const error = err instanceof Error ? err.message : String(err);
      await db
        .update(runs)
        .set({ status: "failed", finishedAt: this.deps.now(), errorCode: "failed", error })
        .where(eq(runs.id, runId));
      return { ok: false, code: "failed", error };
    }
  }

  /** The workspace's provider (its primary credential or the platform's), to ask before the agent exists. */
  providerForWorkspace(workspaceId: string): Promise<ModelProvider | ProviderUnavailable> {
    return this.opts.providerFor({ workspaceId, credentialId: null });
  }

  isBusy(agentId: string): boolean {
    for (const l of this.live.values()) if (l.agent.id === agentId) return true;
    return false;
  }

  busyAgents(): Set<string> {
    return new Set([...this.live.values()].map((l) => l.agent.id));
  }

  activeRuns(filter: { workspaceId: string; channelId?: string }): ActiveRun[] {
    return [...this.live.values()]
      .filter(
        (l) =>
          l.workspaceId === filter.workspaceId && (!filter.channelId || l.channel.id === filter.channelId),
      )
      .map((l) => ({
        runId: l.runId,
        status: l.status,
        agentId: l.agent.id,
        channelId: l.channel.id,
        threadId: l.threadId,
        startedAt: l.startedAt.toISOString(),
        lastPingAt: l.lastPingAt.toISOString(),
        sourceMessageId: l.trigger.id,
        initiatedBy: requesterOf(l.trigger),
        browser: l.browser,
      }));
  }

  liveRun(runId: string): { workspaceId: string; channelId: string } | null {
    const l = this.live.get(runId);
    return l ? { workspaceId: l.workspaceId, channelId: l.channel.id } : null;
  }

  /** Who may stop: whoever triggered it, the agent's owner (the route decides the rest). */
  liveInfo(runId: string): { triggerAuthorId: string; ownerUserId: string } | null {
    const l = this.live.get(runId);
    return l ? { triggerAuthorId: l.trigger.authorId, ownerUserId: l.agent.ownerUserId } : null;
  }

  // ---- control ----

  /** Whether a run waits on this approval. */
  awaitsApproval(approvalId: string): boolean {
    return this.approvalWaiters.has(approvalId);
  }

  /** The route decided: wakes the waiting run. false = no run waits. */
  resolveApproval(approvalId: string, outcome: ApprovalOutcome): boolean {
    const wake = this.approvalWaiters.get(approvalId);
    if (!wake) return false;
    wake(outcome);
    return true;
  }

  /**
   * The person edited the editable fields before approving: the run validates and returns the new effect
   * (preview and hash). null = no run waits on this approval.
   */
  async reviseApproval(
    approvalId: string,
    edits: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<ApprovalRequest["revise"]>> | null> {
    const revise = this.approvalRevisers.get(approvalId);
    return revise ? revise(edits) : null;
  }

  /**
   * Answers an open question (on the card or with a message in the conversation) and wakes the run.
   * null = the question was no longer open.
   */
  async answerQuestion(questionId: string, answer: string, actorUserId: string): Promise<QuestionRow | null> {
    const [row] = await this.deps.db
      .update(questions)
      .set({ status: "answered", answer, responderUserId: actorUserId, answeredAt: this.deps.now() })
      .where(and(eq(questions.id, questionId), eq(questions.status, "open")))
      .returning();
    if (!row) return null;
    // The run wakes on the saved answer, before the notice: a notice that fails doesn't hold the run.
    this.questionWaiters.get(questionId)?.({ answer, actorUserId });
    await publishQuestion(this.deps, row, "question.closed");
    return row;
  }

  /**
   * Registers a wait for `id` in `map`, settled by whoever calls the entry or by the run's abort. `drop` takes the
   * wait back (the card it waits on never went out): the entry and the abort listener go, and `done` rejects.
   */
  private wait<T>(
    map: Map<string, (v: T) => void>,
    id: string,
    signal: AbortSignal,
  ): { done: Promise<T>; drop: () => void } {
    let drop = () => {};
    const done = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        map.delete(id);
        reject(signal.reason ?? new RunCanceled());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      const entry = (v: T) => {
        signal.removeEventListener("abort", onAbort);
        map.delete(id);
        resolve(v);
      };
      map.set(id, entry);
      drop = () => {
        signal.removeEventListener("abort", onAbort);
        if (map.get(id) === entry) map.delete(id);
        reject(new RunCanceled());
      };
    });
    done.catch(() => {});
    return { done, drop };
  }

  private async setStatus(live: Live, status: RunStatus) {
    live.status = status;
    await this.deps.db.update(runs).set({ status }).where(eq(runs.id, live.runId));
  }

  /**
   * Closes what a run left waiting: pending approvals become `canceled` and open questions `expired`. Without
   * a runId it closes everything (the server just came up and no run is live).
   */
  private async closeWaits(runId: string | null) {
    const { db } = this.deps;
    const at = this.deps.now();
    const entry = trailEntry(at, "canceled", "The work stopped before a decision");
    const canceled = await db
      .update(approvals)
      .set({
        status: "canceled",
        decidedAt: at,
        trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(and(eq(approvals.status, "pending"), runId ? eq(approvals.runId, runId) : undefined))
      .returning();
    for (const row of canceled) await publishApproval(this.deps, row, "approval.resolved");
    const expired = await db
      .update(questions)
      .set({ status: "expired" })
      .where(and(eq(questions.status, "open"), runId ? eq(questions.runId, runId) : undefined))
      .returning();
    for (const row of expired) await publishQuestion(this.deps, row, "question.closed");
    // The assignment command the run waited on. A runner job's (`jobId`) doesn't depend on the run:
    // "allow and retry" resumes the job.
    const commands = await db
      .update(assignmentCommands)
      .set({ state: "expired" })
      .where(
        and(
          eq(assignmentCommands.state, "pending"),
          isNull(assignmentCommands.jobId),
          runId ? eq(assignmentCommands.runId, runId) : isNotNull(assignmentCommands.runId),
        ),
      )
      .returning({ assignmentId: assignmentCommands.assignmentId, messageId: assignmentCommands.messageId });
    const touched = [...new Set(commands.map((c) => c.assignmentId))];
    if (touched.length) {
      for (const row of await db.select().from(assignments).where(inArray(assignments.id, touched))) {
        // The request ended: the command's "waiting for you" notice closes with it.
        for (const c of commands)
          if (c.assignmentId === row.id && c.messageId)
            await closeNotifications(
              this.deps,
              row.workspaceId,
              `assignment:${row.id}:approval:${c.messageId}`,
            );
        publishAssignment(this.deps, row, "command");
      }
    }
  }

  /** Approvals and questions with no answer for 24 h expire; the run that waited goes on without them. */
  private async expireWaits() {
    const { db } = this.deps;
    const at = this.deps.now();
    const due = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.status, "pending"), lte(approvals.expiresAt, at)));
    for (const { id } of due) {
      const entry = trailEntry(at, "expired", "Nobody decided in 24 hours");
      const [row] = await db
        .update(approvals)
        .set({
          status: "expired",
          decidedAt: at,
          trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning();
      if (!row) continue;
      await publishApproval(this.deps, row, "approval.resolved");
      this.resolveApproval(id, { id, decision: "expired", reason: null, byName: null });
    }
    const old = new Date(at.getTime() - DECISION_TTL_MS);
    const stale = await db
      .update(questions)
      .set({ status: "expired" })
      .where(and(eq(questions.status, "open"), lte(questions.createdAt, old)))
      .returning();
    for (const row of stale) {
      this.questionWaiters.get(row.id)?.(null);
      await publishQuestion(this.deps, row, "question.closed");
    }
  }

  /** The agent's active run in that conversation (to stop an assignment). */
  activeRun(agentId: string, channelId: string, threadId: string | null): string | null {
    return this.byKey.get(`${agentId}:${channelId}:${threadId ?? "-"}`) ?? null;
  }

  /** Stops the run. False when it had already ended. */
  dropFences(match: { key: string } | { prefix: string }): void {
    if ("key" in match) {
      this.fences.delete(match.key);
      return;
    }
    for (const key of [...this.fences.keys()]) if (key.startsWith(match.prefix)) this.fences.delete(key);
  }

  cancel(runId: string, actorUserId: string | null, fence?: RunFence): boolean {
    const l = this.live.get(runId);
    if (!l) return false;
    // A fenced stop only stops the run while the last attempt that went into it is still this one.
    if (fence && (l.fence?.key !== fence.key || l.fence.token !== fence.token)) return false;
    l.canceledBy = actorUserId;
    l.controller.abort(new RunCanceled());
    return true;
  }

  // ---- routing ----

  /** Called after a person posts. Doesn't wait for the runs. */
  async onPersonMessage(input: {
    workspaceId: string;
    channel: ChannelRow;
    message: Message;
  }): Promise<void> {
    const { db, hub } = this.deps;
    const { workspaceId, channel, message } = input;
    if (message.author.type !== "person" || message.meta.feedback) return;
    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    // The thread and the agents are picked by this channel: a message of another channel never routes here.
    if (!row || row.channelId !== channel.id || row.workspaceId !== workspaceId) return;
    const routing = await routeMessage(this.deps, channel, row);
    if (!routing) return;
    const { mentioned, threadAgentIds, byId, talker, routed } = routing;

    // No budget left this month also blocks (a run in progress keeps receiving the message).
    const threadId = row.threadId ?? (row.meta.spawnsThread ? row.id : null);
    const blocked: { agent: RouteAgent; reason: BlockReason | "budget" }[] = [...routed.blocked];
    const plan: { agent: AgentRow; key: string; live: Live | undefined }[] = [];
    for (const target of routed.targets) {
      const agent = byId.get(target.id);
      if (!agent) continue;
      const key = `${agent.id}:${channel.id}:${threadId ?? "-"}`;
      const running = this.byKey.get(key);
      const live = running ? this.live.get(running) : undefined;
      if (!live && apiBudgetGates(agent) && (await this.budgetCheck(agent)) === "exhausted") {
        blocked.push({ agent: talker(agent), reason: "budget" });
        continue;
      }
      plan.push({ agent, key, live });
    }
    if (plan.length === 0 && blocked.length === 0) return;
    for (const b of blocked) await this.block(row, channel, b.agent, b.reason);
    if (plan.length) {
      await db
        .insert(messageDispatches)
        .values(plan.map((p) => ({ messageId: row.id, agentId: p.agent.id, state: "routed" as const })))
        .onConflictDoNothing();
    }
    // viewedBy: whom the message reached; claimedBy: who will answer; blocked: who can't.
    hub.toChannel(channel.id, {
      type: "message.routed",
      messageId: row.id,
      viewedBy: [...plan.map((p) => p.agent.id), ...blocked.map((b) => b.agent.id)],
      claimedBy: plan.map((p) => p.agent.id),
      blocked: blocked.map((b) => ({ agentId: b.agent.id, reason: b.reason })),
    });
    // Nobody called (no mention, outside a DM and a thread with the agent): whoever answers joined on its own.
    const volunteered = mentioned.length === 0 && channel.kind !== "dm" && threadAgentIds.length === 0;
    for (const p of plan)
      await this.admit(p.key, async () => {
        // Look again: there was an await between the plan and here, and the run may have ended.
        const live = this.liveOf(p.key);
        if (live) await this.steer(live, row);
        else
          await this.startRun({
            agent: p.agent,
            channel,
            threadId,
            key: p.key,
            trigger: row,
            replyMeta: volunteered ? { joined: true } : undefined,
          });
      });
  }

  /**
   * Runs `work` alone among this conversation key's admissions. Whatever looks up the conversation's live run and
   * then steers a message into it or starts one (a person's message, a routine's, a run's follow-up and the end
   * that takes the run out) goes through here, so two of them can't both find no run and each start one, and a
   * run isn't taken out between a message's look-up and its steer. Nothing here waits for a run to end.
   */
  private admit<T>(key: string, work: () => Promise<T>): Promise<T> {
    const turn = (this.admissions.get(key) ?? Promise.resolve()).then(work);
    const tail = turn.then(
      () => {},
      () => {},
    );
    this.admissions.set(key, tail);
    void tail.then(() => {
      if (this.admissions.get(key) === tail) this.admissions.delete(key);
    });
    return turn;
  }

  private liveOf(key: string): Live | undefined {
    const runId = this.byKey.get(key);
    return runId ? this.live.get(runId) : undefined;
  }

  /**
   * Runs the agent for one given message, without a mention (a scheduled routine). If it is already in a run in
   * that conversation, the message goes into it. Returns the run, to follow its end.
   */
  async runFor(input: {
    agent: AgentRow;
    channel: ChannelRow;
    trigger: MessageRow;
    replyMeta?: MessageMeta;
    /** The run's hard caps. With them, the message doesn't go into a run already live in the conversation (`busy`). */
    limits?: RunLimits;
    fence?: RunFence;
    /**
     * Read once the run took the message: whether the work is still this attempt's (the caller's own records).
     * False stops what this attempt started and answers `fenced`.
     */
    admit?: () => Promise<boolean>;
  }): Promise<
    | { ok: true; runId: string; done: Promise<void> }
    | { ok: false; code: "budget" | "personal_plan" | "busy" | "fenced" }
  > {
    const { agent, channel, trigger } = input;
    // The run's thread is the trigger's, and the tools are picked by thread: the trigger must be of this channel.
    if (trigger.channelId !== channel.id || trigger.workspaceId !== channel.workspaceId)
      throw new Error(`runFor: message ${trigger.id} is not of channel ${channel.id}`);
    // Checked and raised before any await: of two attempts, the older one that arrives late is turned away.
    const { fence } = input;
    // A later attempt went meanwhile: checked again after each await, up to the run taking the message.
    const stale = () => fence !== undefined && fence.token < (this.fences.get(fence.key) ?? fence.token);
    if (fence) {
      if (stale()) return { ok: false, code: "fenced" };
      this.fences.set(fence.key, fence.token);
    }
    // Without routing, the personal plan's lock is here: only whoever paired triggers the agent (not even into a live run).
    const planOwner = (await withPlanOwner(this.deps.db, agent)).planOwnerUserId;
    if (planOwner !== null && planOwner !== personOf(trigger)) return { ok: false, code: "personal_plan" };
    if (stale()) return { ok: false, code: "fenced" };
    const threadId = trigger.threadId ?? (trigger.meta.spawnsThread ? trigger.id : null);
    const key = `${agent.id}:${channel.id}:${threadId ?? "-"}`;
    for (;;) {
      const entry = await this.admit(key, async () => {
        // A later attempt went while this one waited for the admission.
        if (stale()) return { kind: "fenced" as const };
        const running = this.liveOf(key);
        if (!running) {
          if (apiBudgetGates(agent) && (await this.budgetCheck(agent)) === "exhausted")
            return { kind: "budget" as const };
          const runId = await this.startRun({
            agent,
            channel,
            threadId,
            key,
            trigger,
            replyMeta: input.replyMeta,
            limits: input.limits,
          });
          return { kind: "started" as const, runId };
        }
        // The live run doesn't have this request's caps: instead of joining it, the caller tries later.
        if (input.limits) return { kind: "busy" as const };
        // A fenced attempt goes into the run that answers it: a run that would put it off to the next one is
        // waited out first (outside the admission), so the run returned (and the one its fence stops) is that one.
        if (fence && (await this.defers(running, trigger)))
          return { kind: "wait" as const, done: running.done };
        if (fence) running.fence = fence;
        // A fenced attempt the run put off during its write isn't left for the next run: it waits that run out
        // and comes back, as above.
        const steered = await this.steer(running, trigger, !fence);
        if (steered === null && fence) return { kind: "wait" as const, done: running.done };
        const took = steered ?? running.runId;
        const into = this.live.get(took);
        if (fence && into) into.fence = fence;
        return { kind: "joined" as const, took, done: into?.done ?? running.done };
      });
      if (entry.kind === "budget" || entry.kind === "busy" || entry.kind === "fenced")
        return { ok: false, code: entry.kind };
      if (entry.kind === "wait") {
        await entry.done;
        if (stale()) return { ok: false, code: "fenced" };
        continue;
      }
      if (entry.kind === "joined") {
        if (!(await this.admitted(input.admit, entry.took, fence))) {
          // Gone stale while it went in (the work ended, the assignment closed): its turn in the run stops.
          this.cancel(entry.took, null, fence);
          return { ok: false, code: "fenced" };
        }
        return { ok: true, runId: entry.took, done: entry.done };
      }
      return this.started(entry.runId, input.admit, fence, stale);
    }
  }

  /** The end of `runFor` for a run it started: the fence and the caller's `admit` decide whether it stays. */
  private async started(
    runId: string,
    admit: (() => Promise<boolean>) | undefined,
    fence: RunFence | undefined,
    stale: () => boolean,
  ): Promise<{ ok: true; runId: string; done: Promise<void> } | { ok: false; code: "fenced" }> {
    const started = this.live.get(runId);
    if (started && fence) {
      // A later attempt went while this run was starting: the run is this stale attempt's alone, and nobody
      // would stop it, so it stops here. One the later attempt already went into is its and stays.
      if (stale()) {
        if (!started.fence) this.cancel(runId, null);
        return { ok: false, code: "fenced" };
      }
      started.fence = fence;
    }
    if (!(await this.admitted(admit, runId, fence))) {
      // The run is on the air, but the work is no longer this attempt's (it ended, or the assignment closed
      // while the run was starting): it stops here.
      this.cancel(runId, null, fence);
      return { ok: false, code: "fenced" };
    }
    return { ok: true, runId, done: started?.done ?? Promise.resolve() };
  }

  private async block(
    row: MessageRow,
    channel: ChannelRow,
    agent: RouteAgent,
    reason: BlockReason | "budget",
  ) {
    const { db, hub } = this.deps;
    await settleIssueWork(db, channel.workspaceId, [row.id], { state: "blocked", reason, runId: null });
    await db
      .insert(messageDispatches)
      .values({ messageId: row.id, agentId: agent.id, state: "blocked", status: "blocked", reason })
      .onConflictDoUpdate({
        target: [messageDispatches.messageId, messageDispatches.agentId],
        set: { state: "blocked", status: "blocked", reason },
      });
    const names = await agentNames(db, [agent.id]);
    const name = names.get(agent.id)?.name ?? "";
    const text =
      reason === "audience"
        ? `${name} doesn't answer you here.`
        : reason === "personal_plan"
          ? `${name} thinks with the personal plan of whoever paired its runner and only answers that person.`
          : reason === "budget"
            ? `${name} is out of budget this month.`
            : `${name} isn't in this conversation.`;
    hub.toUser(channel.workspaceId, row.authorId, {
      type: "run.agent_unavailable",
      agentId: agent.id,
      channelId: channel.id,
      threadId: row.threadId,
      messageId: row.id,
      reason,
      text,
    });
  }

  /** The caller's `admit` read; one that throws stops the run first (unconfirmed, it doesn't stay on the air). */
  private async admitted(admit: (() => Promise<boolean>) | undefined, runId: string, fence?: RunFence) {
    if (!admit) return true;
    try {
      return await admit();
    } catch (err) {
      this.cancel(runId, null, fence);
      throw err;
    }
  }

  /**
   * Whether the live run puts this message off to the next run instead of taking it: the run is ending, it runs
   * on the plan of whoever paired (not even someone else's "stop" touches it), it is pinned to another person,
   * or the agent has a runner the message's author may not use (the run's tools act with its starter's access).
   */
  private async defers(live: Live, row: MessageRow): Promise<boolean> {
    const who = personOf(row);
    // The one await first, so the checks below read the run as it is now.
    const barred =
      who !== null &&
      live.runner !== null &&
      who !== requesterOf(live.trigger) &&
      !isStopRequest(row.body) &&
      !(await this.mayUseRunner(live.workspaceId, who, live.runner));
    if (ending(live)) return true;
    if (live.plan && !canUsePlan(who, live.plan)) return true;
    if (who !== null && who !== live.person.id && live.person.pinned) return true;
    return barred;
  }

  private async mayUseRunner(workspaceId: string, userId: string, runner: RunnerRow): Promise<boolean> {
    const [member] = await this.deps.db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
    return !!member && canUseRunner({ userId, role: member.role }, runner);
  }

  /**
   * Puts the message into the live run, or off to its next run. Returns the run that took it now (null when it
   * waits for the next run). Called only inside the conversation's admission (`admit`): the run's end takes it out
   * and starts the next run under the same admission, so `live.after` is still read after this.
   */
  private async steer(live: Live, row: MessageRow, keep = true): Promise<string | null> {
    const { db } = this.deps;
    const stop = isStopRequest(row.body);
    if (!(await this.defers(live, row))) {
      await db
        .insert(messageDispatches)
        .values({ messageId: row.id, agentId: live.agent.id, state: "claimed", runId: live.runId })
        .onConflictDoUpdate({
          target: [messageDispatches.messageId, messageDispatches.agentId],
          set: { state: "claimed", runId: live.runId },
        });
      if (!ending(live)) return this.into(live, row, stop);
      // Its last turn looked at the inbox during the write, or it was stopped: a "stop" for it is done with.
      if (stop) await this.markHandled(live, [row.id], "canceled");
    }
    // "stop" for a run that is already ending changes nothing; anything else becomes the next run (unless the
    // caller takes it back: `keep` false).
    if (keep && !(ending(live) && stop)) live.after.push(row);
    return null;
  }

  /** The message joins the live run (its inbox, its answer to a question, or its stop). */
  private async into(live: Live, row: MessageRow, stop: boolean): Promise<string> {
    const who = personOf(row);
    if (who !== null && who !== live.person.id) live.person.id = null;
    this.deps.hub.toChannel(live.channel.id, {
      type: "run.steered",
      runId: live.runId,
      agentId: live.agent.id,
      threadId: live.threadId,
      messageId: row.id,
      ...(stop ? { stop: true } : {}),
    });
    live.handles.push(row.id);
    if (stop) {
      live.canceledBy = row.authorId;
      live.controller.abort(new RunCanceled());
      return live.runId;
    }
    // The agent asked and is waiting: the asked person's message is the answer, not a new request. A message
    // from someone else joins the run as an ordinary message.
    const q = live.waitingQuestion;
    if (q && (q.askedUserId === null || q.askedUserId === row.authorId)) {
      const text = row.body.replace(/@[a-z0-9][a-z0-9_-]{1,31}/gi, "").trim() || row.body;
      if (await this.answerQuestion(q.id, text, row.authorId)) return live.runId;
    }
    live.inbox.push(row);
    return live.runId;
  }

  // ---- execution ----

  private async startRun(input: {
    agent: AgentRow;
    channel: ChannelRow;
    threadId: string | null;
    key: string;
    trigger: MessageRow;
    replyMeta?: MessageMeta;
    limits?: RunLimits;
  }): Promise<string> {
    const { db, hub } = this.deps;
    const { agent, channel, trigger } = input;
    if (this.stopped) throw new RuntimeStopping();
    const runId = newId("run");
    const at = this.deps.now();
    const [runner] = agent.environmentId
      ? await db.select().from(runners).where(eq(runners.id, agent.environmentId))
      : [];
    await db.insert(runs).values({
      id: runId,
      workspaceId: channel.workspaceId,
      agentId: agent.id,
      channelId: channel.id,
      threadId: input.threadId,
      sourceMessageId: trigger.id,
      status: "queued",
      what: whatOf(trigger.body),
      model: agent.model,
      createdAt: at,
    });
    await db
      .insert(messageDispatches)
      .values({ messageId: trigger.id, agentId: agent.id, state: "claimed", runId })
      .onConflictDoUpdate({
        target: [messageDispatches.messageId, messageDispatches.agentId],
        set: { state: "claimed", runId },
      });
    hub.toChannel(channel.id, { type: "message.claimed", messageId: trigger.id, agentId: agent.id, runId });
    const live: Live = {
      runId,
      workspaceId: channel.workspaceId,
      agent,
      channel,
      threadId: input.threadId,
      key: input.key,
      trigger,
      person: { id: requesterOf(trigger), pinned: false },
      inbox: [],
      handles: [trigger.id],
      closing: false,
      after: [],
      controller: new AbortController(),
      canceledBy: null,
      status: "queued",
      startedAt: at,
      lastPingAt: at,
      done: Promise.resolve(),
      waitingQuestion: null,
      risk: new RiskTracker(),
      replyMeta: input.replyMeta,
      plan: null,
      runner: runner ?? null,
      browser: false,
      assignment: null,
      errorCode: null,
      limits: input.limits,
    };
    // The stop began during the writes above and already stopped every run it saw: this one doesn't start (the
    // next boot fails its row as interrupted, as after a fall).
    if (this.stopped) throw new RuntimeStopping();
    this.live.set(runId, live);
    this.byKey.set(input.key, runId);
    live.done = this.execute(live)
      .catch((err) => log.error("runtime.run_crashed", { runId, err }))
      .finally(() => this.ended(live));
    return runId;
  }

  /**
   * Takes the ended run out and starts the next one with what waited for it, inside the conversation's
   * admission: a message steered meanwhile either went in before (into `after`, read here) or finds the next run.
   */
  private ended(live: Live): Promise<void> {
    const { runId, agent, channel } = live;
    return this.admit(live.key, async () => {
      this.live.delete(runId);
      if (this.byKey.get(live.key) === runId) this.byKey.delete(live.key);
      const end: RunEnd = {
        runId,
        workspaceId: live.workspaceId,
        agentId: agent.id,
        channelId: channel.id,
        threadId: live.threadId,
        status: live.status === "done" || live.status === "canceled" ? live.status : "failed",
        errorCode: live.errorCode ?? null,
      };
      for (const listener of this.runEndListeners) {
        try {
          listener(end);
        } catch (err) {
          log.error("runtime.run_end_listener_failed", { runId, err });
        }
      }
      const [next, ...rest] = live.after;
      if (!next) return;
      let taken = 0;
      try {
        await this.startRun({ ...live, trigger: next, replyMeta: undefined, limits: undefined });
        taken = 1;
        const nextLive = this.liveOf(live.key);
        if (!nextLive) return;
        for (const row of rest) {
          await this.steer(nextLive, row);
          taken++;
        }
      } catch (err) {
        if (!(err instanceof RuntimeStopping)) log.error("runtime.followup_failed", { runId, err });
        // What no next run took is left as a fall leaves it: handled with this run as failed, its work blocked.
        const left = live.after.slice(taken).map((m) => m.id);
        await this.markHandled(live, left, "failed");
        await settleIssueWork(this.deps.db, live.workspaceId, left, {
          state: "blocked",
          reason: "interrupted",
          runId: live.runId,
        });
      }
    });
  }

  private emit(live: Live, event: Record<string, unknown> & { type: string }) {
    this.deps.hub.toChannel(live.channel.id, {
      runId: live.runId,
      agentId: live.agent.id,
      channelId: live.channel.id,
      threadId: live.threadId,
      ...event,
    });
  }

  private async execute(live: Live): Promise<void> {
    const { db } = this.deps;
    const at = this.deps.now();
    live.status = "running";
    live.assignment = await assignmentOfRun(this.deps, live.agent.id, live.threadId);
    await db
      .update(runs)
      .set({ status: "running", startedAt: at, lastPingAt: at })
      .where(eq(runs.id, live.runId));
    this.emit(live, {
      type: "run.status_changed",
      status: "running",
      sourceMessageId: live.trigger.id,
      initiatedBy: requesterOf(live.trigger),
      startedAt: at.toISOString(),
    });
    const beat = setInterval(() => {
      live.lastPingAt = this.deps.now();
      void db.update(runs).set({ lastPingAt: live.lastPingAt }).where(eq(runs.id, live.runId));
    }, HEARTBEAT_MS);
    // Time cap: once past, abort whatever is running (the model, a tool or an approval wait).
    const timeoutMs = live.limits?.timeoutMs;
    const deadline = timeoutMs
      ? setTimeout(() => live.controller.abort(new TimeLimit(timeoutMs)), timeoutMs)
      : null;

    let usage = emptyUsage();
    let cost = 0;
    let stepSeq = 0;
    let deltaSeq = 0;
    let partial = "";
    let posted = 0;
    let delegatedTo: string | null = null;
    let usageModel = live.agent.model;
    let toolSteps = 0;
    // Without a key the provider is the test one: the answer says so, so the screen doesn't show the agent's model.
    let testModel = false;
    const step = async (kind: "text" | "tool_call" | "tool_result", data: Record<string, unknown>) => {
      await db.insert(runEvents).values({ runId: live.runId, seq: stepSeq++, kind, data });
      if (kind === "tool_call") toolSteps++;
    };
    const persistUsage = async () => {
      await db
        .update(runs)
        .set({
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost,
        })
        .where(eq(runs.id, live.runId));
    };
    const post = async (body: string, meta: MessageMeta = {}) => {
      const { message } = await postMessage(this.deps, {
        workspaceId: live.workspaceId,
        channel: live.channel,
        author: { type: "agent", id: live.agent.id },
        body,
        clientId: `${live.runId}:${posted++}`,
        threadId: live.threadId,
        meta: {
          ...live.replyMeta,
          ...meta,
          ...(delegatedTo ? { delegation: { agentId: delegatedTo } } : {}),
          ...(toolSteps > 0 ? { toolSteps } : {}),
          ...(testModel ? { testModel: true } : {}),
        },
        runId: live.runId,
        usage: { model: usageModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      });
      // The run's actions so far get their receipt on this message.
      const linked = await db
        .update(reversibleActions)
        .set({ messageId: message.id })
        .where(and(eq(reversibleActions.runId, live.runId), isNull(reversibleActions.messageId)))
        .returning({ id: reversibleActions.id });
      if (linked.length > 0) await publishActions(this.deps, message.id);
      return message;
    };
    let cards = 0;
    let currentCall: { toolUseId: string; tool: string; turn: number } | null = null;
    const postCard = async (body: string, meta: MessageMeta) => {
      const { message } = await postMessage(this.deps, {
        workspaceId: live.workspaceId,
        channel: live.channel,
        author: { type: "agent", id: live.agent.id },
        body,
        clientId: `${live.runId}:card:${cards++}`,
        threadId: live.threadId,
        meta,
      });
      return message;
    };

    try {
      const modelProvider = async (): Promise<ModelProvider> => {
        const p = await this.opts.providerFor(live.agent);
        if ("error" in p) throw new ModelError("auth", p.error);
        return p;
      };
      // Claude Code/Codex on the runner, with the plan of whoever paired; else the model through the API.
      let harness = await runHarnessFor(this.deps, live.agent, personOf(live.trigger));
      // The fallback covers a runner that is down, not another person: the plan's agent only answers whoever paired.
      if (harness.kind === "unavailable" && harness.code !== "personal_plan" && live.agent.harnessFallback)
        harness = { kind: "model" };
      if (harness.kind === "unavailable")
        throw new HarnessError(
          harness.code,
          `${EXECUTOR_NAME[harness.executor]} is not available (${harness.code})`,
          harness.executor,
          harness.runner?.id ?? null,
        );
      let remote = harness.kind === "remote" ? harness : null;
      let provider: ModelProvider | null = remote ? null : await modelProvider();
      testModel = provider?.kind === "fake";
      if (remote) {
        const plan = remote.runner;
        live.plan = plan;
        // What arrived before this decision from someone who can't use the plan waits for its own run.
        const others = live.inbox.filter((m) => !canUsePlan(personOf(m), plan));
        if (others.length) {
          const ids = new Set(others.map((m) => m.id));
          live.inbox = live.inbox.filter((m) => !ids.has(m.id));
          live.handles = live.handles.filter((id) => !ids.has(id));
          live.after.push(...others);
        }
        usageModel = remote.model ? `${remote.executor}:${remote.model}` : remote.executor;
        await db.update(runs).set({ model: usageModel }).where(eq(runs.id, live.runId));
      }
      const system = await this.systemPrompt(live);
      // The thread comes from the trigger, a message of this channel (startRun checks it): the assignment
      // tools are picked by thread, so a thread of another channel never reaches toolsFor.
      const tools = await toolsFor(this.deps, live.agent, { channel: live.channel, threadId: live.threadId });
      // Tools on demand: through the API, only the pinned ones go whole when the definitions are heavy; the
      // rest goes deferred and the API's search finds them. The harness on the runner gets them all.
      const specs =
        !remote && this.deps.config.toolSearch === "auto"
          ? withLoading(toolSpecs(tools), await pinnedTools(db, live.agent.id, this.deps.now()))
          : toolSpecs(tools);
      const history = await this.history(live);
      const toolCtx: ToolContext = {
        deps: this.deps,
        workspaceId: live.workspaceId,
        agent: live.agent,
        channel: live.channel,
        runId: live.runId,
        threadId: live.threadId,
        trigger: {
          id: live.trigger.id,
          authorId: live.trigger.authorId,
          authorName: await this.personName(live),
        },
        personId: requesterOf(live.trigger),
        runRunnerId: live.runner?.id ?? null,
        personStore: () => {
          if (live.person.id) live.person.pinned = true;
          return live.person.id;
        },
        signal: live.controller.signal,
        risk: live.risk,
        ...(live.limits?.effectKey ? { effectKey: live.limits.effectKey } : {}),
        delegate: async (target, question) => {
          delegatedTo = target.id;
          return this.delegate(live, target, question);
        },
        postCard,
        toolOutput: (text) => {
          if (!currentCall) return;
          this.emit(live, {
            type: "run.tool_result",
            toolUseId: currentCall.toolUseId,
            tool: currentCall.tool,
            stream: "stdout",
            text: cut(text),
            isError: false,
            turn: currentCall.turn,
          });
        },
        requestApproval: async (req) => {
          const created = this.deps.now();
          const title = req.card.title ?? req.preview.title;
          const [row] = await db
            .insert(approvals)
            .values({
              id: newId("apv"),
              workspaceId: live.workspaceId,
              agentId: live.agent.id,
              channelId: live.channel.id,
              threadId: live.threadId,
              runId: live.runId,
              tool: req.tool,
              scope: req.card.scope ?? `tool:${req.tool}`,
              title,
              // The effect's whole text, uncut: it is what the person approves.
              detail: req.preview.body ?? "",
              params: req.card.params ?? {},
              why: req.card.why ?? "",
              issue: req.card.issue ?? null,
              connector: req.card.connector ?? null,
              linkedAccount: req.card.linkedAccount ?? null,
              effect: req.effect,
              gateReason: req.gateReason,
              flags: req.reasons.map((r) => ({ flag: r.flag, source: r.source })),
              preview: req.preview,
              input: req.input,
              payloadHash: req.payloadHash,
              editable: req.editable,
              ruleKey: req.rule?.key ?? null,
              ruleLabel: req.rule?.label ?? null,
              requesterUserId: live.trigger.authorId,
              expiresAt: new Date(created.getTime() + DECISION_TTL_MS),
              trail: [
                trailEntry(created, "requested", `${live.agent.name} asked`, { name: live.agent.name }),
                ...(req.reviewed
                  ? [trailEntry(created, "reviewed", "The reviewer model asked for a person")]
                  : []),
              ],
            })
            .returning();
          if (!row) throw new Error("approval insert returned nothing");
          await this.recordDecision(live, {
            tool: req.tool,
            decision: {
              kind: "ask",
              reason: req.gateReason,
              effect: req.effect,
              flags: req.flags,
              preview: req.preview,
              payloadHash: req.payloadHash,
            },
            approvalId: row.id,
            credential: req.credential,
            ...(req.reviewed ? { by: { kind: "reviewer", verdict: "ask" } as const } : {}),
          });
          // Register the wait before the card: a decision on the card may arrive before the next await.
          const waiting = this.wait(this.approvalWaiters, row.id, live.controller.signal);
          this.approvalRevisers.set(row.id, req.revise);
          try {
            const card = await postCard(title, { approvalId: row.id });
            const [withCard] = await db
              .update(approvals)
              .set({ messageId: card.id })
              .where(eq(approvals.id, row.id))
              .returning();
            // The status goes to the database before the notice: whoever fetches the run list after the event
            // already sees the wait, and the list doesn't undo the phase the event put on screen.
            await this.setStatus(live, "paused_for_approval");
            await publishApproval(this.deps, withCard ?? row, "approval.requested");
          } catch (err) {
            // The card or its notice failed: nothing will decide this wait, so it doesn't stay behind.
            waiting.drop();
            this.approvalRevisers.delete(row.id);
            throw err;
          }
          const outcome = await waiting.done.finally(() => this.approvalRevisers.delete(row.id));
          await this.setStatus(live, "running");
          return outcome;
        },
        recordDecision: (d) => this.recordDecision(live, d),
        standingRule: (tool, key) =>
          matchRule(db, {
            workspaceId: live.workspaceId,
            agentId: live.agent.id,
            tool,
            key,
            at: this.deps.now(),
          }),
        review: (req) =>
          this.reviewCall({
            agent: live.agent,
            channelId: live.channel.id,
            threadId: live.threadId,
            requesterId: live.trigger.authorKind === "person" ? live.trigger.authorId : null,
            requestAt: live.trigger.createdAt,
            req,
            // The run's caps pay for its reviewer too.
            scopes: capsOf(live),
            assignmentId: live.assignment?.assignmentId,
          }),
        settleApproval: async (id, result) => {
          const done = this.deps.now();
          const entry = result.ok
            ? trailEntry(done, "executed", "Done")
            : trailEntry(done, "failed", "Failed", { error: result.text.slice(0, 200) });
          const [row] = await db
            .update(approvals)
            .set({
              appliedAt: done,
              result,
              trail: sql`${approvals.trail} || ${JSON.stringify([entry])}::jsonb`,
            })
            .where(eq(approvals.id, id))
            .returning();
          if (row) await publishApproval(this.deps, row, "approval.resolved");
        },
        ask: async (text, choices) => {
          const [row] = await db
            .insert(questions)
            .values({
              id: newId("q"),
              workspaceId: live.workspaceId,
              agentId: live.agent.id,
              channelId: live.channel.id,
              threadId: live.threadId,
              runId: live.runId,
              askedUserId: live.trigger.authorId,
              text,
              choices,
            })
            .returning();
          if (!row) throw new Error("question insert returned nothing");
          // Waiting before the card: an answer on the card may arrive before the next await.
          const waiting = this.wait(this.questionWaiters, row.id, live.controller.signal);
          live.waitingQuestion = { id: row.id, askedUserId: row.askedUserId };
          try {
            const card = await postCard(text, { question: toQuestion(row) });
            const [withCard] = await db
              .update(questions)
              .set({ messageId: card.id })
              .where(eq(questions.id, row.id))
              .returning();
            await this.setStatus(live, "paused_for_input");
            await publishQuestion(this.deps, withCard ?? row, "question.raised");
          } catch (err) {
            // The card or its notice failed: nothing will answer this wait, so it doesn't stay behind.
            waiting.drop();
            live.waitingQuestion = null;
            throw err;
          }
          const answer = await waiting.done.finally(() => {
            live.waitingQuestion = null;
          });
          await this.setStatus(live, "running");
          return answer;
        },
        recordAction: async (action) => {
          const created = this.deps.now();
          await db.insert(reversibleActions).values({
            id: newId("act"),
            workspaceId: live.workspaceId,
            agentId: live.agent.id,
            runId: live.runId,
            requesterUserId: live.trigger.authorId,
            kind: action.kind,
            target: action.target,
            params: action.params ?? {},
            createdAt: created,
            revertibleUntil: action.revertibleUntil ?? new Date(created.getTime() + UNDO_WINDOW_MS),
          });
        },
      };

      let turnNow = 0;
      let turnText = "";
      let typing = false;
      let usedTools = false;
      const callTool = async (
        call: { id: string; name: string; input: unknown },
        turn: number,
        commentary: string | null,
      ) => {
        usedTools = true;
        await step("tool_call", {
          toolUseId: call.id,
          name: call.name,
          input: call.input,
          turn,
          ...(commentary ? { commentary } : {}),
        });
        this.emit(live, {
          type: "run.tool_call",
          toolUseId: call.id,
          tool: call.name,
          input: call.input,
          detail: toolDetail(call.input),
          turn,
        });
        if (call.name.startsWith("browser_") && call.name !== "browser_close") live.browser = true;
        currentCall = { toolUseId: call.id, tool: call.name, turn };
        const out = await runTool(toolCtx, tools, call.name, call.input).finally(() => {
          currentCall = null;
        });
        live.controller.signal.throwIfAborted();
        await step("tool_result", {
          toolUseId: call.id,
          content: out.content,
          isError: out.isError,
          turn,
        });
        this.emit(live, {
          type: "run.tool_result",
          toolUseId: call.id,
          tool: call.name,
          stream: out.isError ? "error" : "result",
          text: cut(out.content),
          isError: out.isError,
          turn,
        });
        if (call.name === "browser_close" && !out.isError) live.browser = false;
        // tool: null closes the call (the line stops showing "running").
        this.emit(live, { type: "run.tool_call", toolUseId: call.id, tool: null, turn });
        return out;
      };
      // A tool Claude Code/Codex asks for mid-turn: the text so far becomes commentary. The CLI may ask for
      // several at once; they run one at a time, as on the model's path (approval, question and live output
      // hold for one call at a time).
      let toolQueue: Promise<unknown> = Promise.resolve();
      const invoke: ToolInvoker = (name, input) => {
        const next = toolQueue.then(async () => {
          live.controller.signal.throwIfAborted();
          const commentary = turnText.trim() || null;
          if (commentary) this.emit(live, { type: "run.commentary", turn: turnNow, text: commentary });
          turnText = "";
          partial = "";
          typing = false;
          const out = await callTool({ id: newId("tu"), name, input }, turnNow, commentary);
          return { content: out.content, isError: out.isError };
        });
        toolQueue = next.catch(() => {});
        return next;
      };
      if (remote)
        provider = remoteProvider(this.deps, {
          runId: live.runId,
          agent: { id: live.agent.id, handle: live.agent.handle },
          harness: remote,
          invoke,
        });

      let finalText = "";
      // The advisor only through the API, and only with a valid pair; fixed for the run (the API rejects dropping
      // the tool while its result is in the history).
      const advisor = remote ? undefined : advisorOf(live.agent);
      const maxTurns = live.limits?.maxTurns ?? MAX_TURNS;
      let finished = false;
      for (let turn = 0; turn < maxTurns; turn++) {
        turnNow = turn;
        for (const m of live.inbox.splice(0)) history.push(await this.asModelMessage(live, m));
        this.emit(live, { type: "run.thinking", turn });
        turnText = "";
        typing = false;
        let result: { content: ModelMessage["content"]; raw: unknown; stop: string; usage: Usage } | null =
          null;
        partial = "";
        // Through the API, reserve this call's worst case before making it (the runner's plan costs nothing here).
        const held = remote
          ? null
          : await this.reserveCall({
              agent: live.agent,
              channelId: live.channel.id,
              scopes: capsOf(live),
              promptBytes:
                utf8Bytes(system) + utf8Bytes(JSON.stringify(history)) + utf8Bytes(JSON.stringify(specs)),
              maxTokens: MAX_TOKENS,
              advisor,
            });
        if (held && !held.ok) {
          // The channel's cap: stop here and tell whoever asked, in the thread.
          if (held.scope.kind === "channel") {
            await this.channelBudgetCheck(live.channel.id, personOf(live.trigger), true);
            throw new BudgetExhausted("channel");
          }
          if (held.scope.kind === "agent") await this.budgetCheck(live.agent, true);
          throw new BudgetExhausted(held.scope.kind);
        }
        const reservation = held?.reservation ?? null;
        try {
          if (!provider) throw new ModelError("network", "No provider for the turn");
          for await (const ev of provider.stream({
            model: live.agent.model,
            system,
            messages: history,
            tools: specs,
            maxTokens: MAX_TOKENS,
            signal: live.controller.signal,
            ...(advisor ? { advisor } : {}),
          })) {
            if (ev.type === "text") {
              if (!typing) {
                typing = true;
                this.emit(live, { type: "agent.typing", turn });
              }
              turnText += ev.text;
              partial = turnText;
              this.emit(live, { type: "run.text_delta", seq: deltaSeq++, text: ev.text, turn });
            } else if (ev.type === "turn") {
              result = ev;
            }
          }
        } catch (err) {
          if (reservation) await this.deps.ledger.release(reservation);
          // The runner failed before doing anything: with the fallback on, answer through the API.
          const untouched = !usedTools && !turnText.trim() && !live.controller.signal.aborted;
          if (err instanceof HarnessError && remote && live.agent.harnessFallback && untouched) {
            remote = null;
            live.plan = null;
            usageModel = live.agent.model;
            provider = await modelProvider();
            testModel = provider.kind === "fake";
            turn--;
            continue;
          }
          throw err;
        }
        if (!result) {
          if (reservation) await this.deps.ledger.release(reservation);
          throw new ModelError("network", "Stream ended without a turn");
        }
        usage = addUsage(usage, result.usage);
        // One ledger line per call. The Claude/ChatGPT plan isn't charged here: the runner run's line has cost 0
        // and doesn't weigh on the cap.
        const source: UsageSource = live.replyMeta?.fromRoutine
          ? "routine"
          : live.assignment
            ? "assignment"
            : "chat";
        const call = {
          agent: live.agent,
          userId: personOf(live.trigger),
          runId: live.runId,
          channelId: live.channel.id,
          source,
          usage: result.usage,
          assignmentId: live.assignment?.assignmentId ?? null,
        };
        cost += reservation
          ? await this.settleCall(reservation, call)
          : await this.recordPlanCall(call, usageModel);
        await persistUsage();
        const text = result.content
          .flatMap((c) => (c.type === "text" ? [c.text] : []))
          .join("")
          .trim();
        const calls = result.content.filter((c) => c.type === "tool_use");

        if (result.stop === "tool_use" && calls.length > 0) {
          if (text) this.emit(live, { type: "run.commentary", turn, text });
          history.push({ role: "assistant", content: result.content, raw: result.raw });
          const outputs: ModelMessage["content"] = [];
          let first = true;
          for (const call of calls) {
            if (call.type !== "tool_use") continue;
            const out = await callTool(call, turn, first && text ? text : null);
            first = false;
            outputs.push({
              type: "tool_result",
              toolUseId: call.id,
              content: out.content,
              isError: out.isError,
              ...(out.searchResults ? { searchResults: out.searchResults } : {}),
            });
          }
          history.push({ role: "user", content: outputs });
          continue;
        }

        // The API paused in the middle of its own tool search: hand the turn back as it came and go on.
        if (result.stop === "pause") {
          history.push({ role: "assistant", content: result.content, raw: result.raw });
          continue;
        }

        if (text) await step("text", { text, turn });
        if (live.inbox.length > 0) {
          // A message arrived during this turn: post what there is and go on with it. What came before is
          // already answered; the run's end only decides where the new messages go.
          const fresh = new Set(live.inbox.map((m) => m.id));
          const answered = live.handles.filter((id) => !fresh.has(id));
          if (text) await post(text);
          // Only what this text answered leaves: a message steered in during the post stays to be answered.
          const done = new Set(answered);
          live.handles = live.handles.filter((id) => !done.has(id));
          await this.markHandled(live, answered, text ? "answered" : "silent");
          await settleIssueWork(this.deps.db, live.workspaceId, answered, {
            state: "idle",
            reason: null,
            runId: live.runId,
          });
          history.push({ role: "assistant", content: result.content, raw: result.raw });
          continue;
        }
        finalText = text;
        finished = true;
        break;
      }
      // From here no turn reads the inbox. What a person steered in on the last allowed turn wasn't heard: it waits
      // for the next run instead of being marked handled with this one (no await in between, so a steer that
      // comes after sees `closing`).
      live.closing = true;
      const unheard = live.inbox.splice(0);
      if (unheard.length) {
        const ids = new Set(unheard.map((m) => m.id));
        live.handles = live.handles.filter((id) => !ids.has(id));
        live.after.unshift(...unheard);
      }
      // A routine: running out of turns while still asking for tools is stopping at the cap, not finishing the work.
      if (!finished && live.limits) throw new StepLimit(maxTurns);

      clearInterval(beat);
      if (deadline) clearTimeout(deadline);
      // The time cap (or a stop) that landed after the model's last answer still counts: not posted as done.
      live.controller.signal.throwIfAborted();
      const message = finalText ? await post(finalText) : null;
      const status = message || posted > 0 ? "answered" : "silent";
      await this.finish(live, { status: "done", handled: status, messageId: message?.id ?? null });
      await this.budgetNotices(live.agent, live.channel.id, personOf(live.trigger));
    } catch (caught) {
      live.closing = true;
      clearInterval(beat);
      if (deadline) clearTimeout(deadline);
      // The time cap aborts through the controller: the error that comes up is the stream's; the cause is the TimeLimit.
      const reason: unknown = live.controller.signal.reason;
      const err = reason instanceof TimeLimit ? reason : caught;
      const canceled =
        !(err instanceof TimeLimit) && (err instanceof RunCanceled || live.controller.signal.aborted);
      if (canceled) {
        if (partial.trim()) await post(partial.trim(), { canceled: true }).catch(() => null);
        await this.finish(live, { status: "canceled", handled: "canceled", messageId: null });
        return;
      }
      if (err instanceof HarnessError) {
        const notice = harnessNotice(live.agent.id, err);
        const message = await post(notice.body, notice.meta).catch(() => null);
        await this.finish(live, {
          status: "failed",
          handled: "failed",
          messageId: message?.id ?? null,
          error: err.message,
          errorCode: `harness.${err.code}`,
        });
        return;
      }
      const budgetOut = err instanceof BudgetExhausted && err.scope !== "routine_run";
      const channelOut = budgetOut && err.scope === "channel";
      const assignmentOut = budgetOut && err.scope === "assignment";
      const code =
        err instanceof BudgetExhausted
          ? err.scope === "assignment"
            ? "assignment_budget_exhausted"
            : err.scope === "routine_run"
              ? "routine_budget"
              : err.scope === "channel"
                ? "channel_budget_exhausted"
                : "budget_exhausted"
          : err instanceof StepLimit
            ? "step_limit"
            : err instanceof TimeLimit
              ? "time_limit"
              : err instanceof ModelError
                ? err.code
                : "internal";
      if (code === "internal") log.error("runtime.run_failed", { runId: live.runId, err });
      await post(
        assignmentOut
          ? "I stopped: this assignment's budget ran out."
          : channelOut
            ? "I stopped: this channel's monthly budget ran out."
            : budgetOut
              ? "I stopped: my monthly budget ran out."
              : `I couldn't finish this (${code}).`,
        {
          bodyTemplate: assignmentOut
            ? "run.assignmentBudgetExhausted"
            : channelOut
              ? "run.channelBudgetExhausted"
              : budgetOut
                ? "run.budgetExhausted"
                : "run.failed",
          templateVars: { code },
        },
      ).catch(() => null);
      await this.finish(live, {
        status: "failed",
        handled: "failed",
        messageId: null,
        error: err instanceof Error ? err.message : String(err),
        errorCode: code,
      });
    }
  }

  private async finish(
    live: Live,
    end: {
      status: "done" | "failed" | "canceled";
      handled: "answered" | "silent" | "failed" | "canceled";
      messageId: string | null;
      error?: string;
      errorCode?: string;
    },
  ) {
    const { db } = this.deps;
    live.status = end.status;
    live.errorCode = end.errorCode ?? null;
    await db
      .update(runs)
      .set({
        status: end.status,
        finishedAt: this.deps.now(),
        error: end.error ?? null,
        errorCode: end.errorCode ?? null,
      })
      .where(eq(runs.id, live.runId));
    if (end.status === "canceled") {
      this.emit(live, { type: "run.stopped", actorUserId: live.canceledBy });
    } else {
      this.emit(live, {
        type: "run.completed",
        status: end.status,
        messageId: end.messageId,
        ...(end.errorCode ? { errorCode: end.errorCode } : {}),
      });
    }
    await this.closeWaits(live.runId);
    await this.markHandled(live, live.handles, end.handled);
    // Canceled by the server's shutdown (nobody asked to stop): the work was left halfway, as with the fall
    // that `start()` handles.
    const interrupted = end.status === "canceled" && this.stopped && !live.canceledBy;
    await settleIssueWork(db, live.workspaceId, live.handles, {
      state: end.status === "failed" || interrupted ? "blocked" : "idle",
      reason: interrupted ? "interrupted" : end.status === "failed" ? (end.errorCode ?? "failed") : null,
      runId: live.runId,
    });
    this.emit(live, { type: "run.idle" });
  }

  private async markHandled(live: Live, messageIds: string[], status: HandledStatus) {
    for (const messageId of messageIds) {
      await this.deps.db
        .update(messageDispatches)
        .set({ state: "handled", status, runId: live.runId })
        .where(and(eq(messageDispatches.messageId, messageId), eq(messageDispatches.agentId, live.agent.id)));
      this.emit(live, { type: "message.handled", messageId, status });
    }
  }

  // ---- context ----

  private async personName(live: Live): Promise<string> {
    const [row] = await this.deps.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, live.trigger.authorId));
    return row?.name ?? "";
  }

  /** A message with outside content (email, webhook) in the prompt: the run now has A. */
  private noteUntrusted(live: Live, row: MessageRow) {
    const source = row.meta.untrusted;
    if (typeof source === "string" && source) live.risk.raise({ flag: "A", source });
  }

  private async asModelMessage(live: Live, row: MessageRow): Promise<ModelMessage> {
    this.noteUntrusted(live, row);
    if (row.authorKind === "agent" && row.authorId === live.agent.id) {
      return { role: "assistant", content: [{ type: "text", text: row.body }] };
    }
    const names = await this.authorNames(live.workspaceId, [row]);
    return {
      role: "user",
      content: [{ type: "text", text: `${names.get(row.authorId) ?? "?"}: ${row.body}` }],
    };
  }

  private async authorNames(workspaceId: string, rows: MessageRow[]): Promise<Map<string, string>> {
    const { db } = this.deps;
    const people = [...new Set(rows.filter((r) => r.authorKind === "person").map((r) => r.authorId))];
    const agentIds = [...new Set(rows.filter((r) => r.authorKind === "agent").map((r) => r.authorId))];
    const out = new Map<string, string>();
    if (people.length) {
      const ps = await db
        .select({ id: users.id, name: users.name, handle: members.handle })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, people)));
      for (const p of ps) out.set(p.id, `${p.name} (@${p.handle})`);
    }
    for (const [id, a] of await agentNames(db, agentIds)) out.set(id, `${a.name} (@${a.handle}, agent)`);
    return out;
  }

  /** The conversation's latest messages up to the trigger, as model turns. */
  private async history(live: Live): Promise<ModelMessage[]> {
    const { db } = this.deps;
    const where = live.threadId
      ? and(
          eq(messages.channelId, live.channel.id),
          or(eq(messages.threadId, live.threadId), eq(messages.id, live.threadId)),
        )
      : and(eq(messages.channelId, live.channel.id), isNull(messages.threadId));
    const rows = (
      await db
        .select()
        .from(messages)
        .where(and(where, lte(messages.createdAt, live.trigger.createdAt)))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(HISTORY_LIMIT)
    ).reverse();
    if (!rows.some((r) => r.id === live.trigger.id)) rows.push(live.trigger);
    const names = await this.authorNames(live.workspaceId, rows);
    const out: ModelMessage[] = [];
    for (const r of rows) {
      this.noteUntrusted(live, r);
      if (r.authorKind === "agent" && r.authorId === live.agent.id) {
        if (out.length === 0) continue; // the first turn has to be the asker's
        out.push({ role: "assistant", content: [{ type: "text", text: r.body || "(no text)" }] });
      } else {
        out.push({
          role: "user",
          content: [{ type: "text", text: `${names.get(r.authorId) ?? "?"}: ${r.body}` }],
        });
      }
    }
    return out;
  }

  /** Runs `work` and releases the reservation if it throws (the call never went out). */
  private async releasing<T>(reservation: Reservation, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      await this.deps.ledger.release(reservation);
      throw err;
    }
  }

  /** The budget notices after a finished call: one that fails is logged, the call's result stands. */
  private async budgetNotices(agent: AgentRow, channelId: string | null, initiatedBy: string | null) {
    try {
      await this.budgetCheck(agent);
      if (channelId) await this.channelBudgetCheck(channelId, initiatedBy);
    } catch (err) {
      log.error("runtime.budget_notice_failed", { agentId: agent.id, err });
    }
  }

  private async systemPrompt(live: Live): Promise<string> {
    const { db } = this.deps;
    const { agent, channel } = live;
    const workspace = await workspaceBudgetDefaults(db, live.workspaceId);
    const memory = await memoryPrompt(db, this.deps.now(), {
      workspaceId: live.workspaceId,
      agentId: agent.id,
      personId: requesterOf(live.trigger),
    });
    const skillRows = await db
      .select({ name: skills.name, description: skills.description })
      .from(skills)
      .innerJoin(skillGrants, and(eq(skillGrants.skillId, skills.id), eq(skillGrants.agentId, agent.id)))
      .where(eq(skillGrants.enabled, true))
      .orderBy(asc(skills.name));
    let where = `the channel #${channel.name}`;
    if (channel.kind === "dm") where = `a direct message with ${await this.personName(live)}`;
    const parts = [
      `You are ${agent.name} (@${agent.handle}), an AI agent on ${PRODUCT.name}, the team chat of ${workspace.name}.`,
      agent.role !== "custom" ? `Your role on the team: ${agent.role}.` : "",
      `# Instructions\n${agent.instructions.trim() || "No specific instructions yet. Be helpful and brief."}`,
      workspace.context.trim() ? `# About the company\n${workspace.context.trim()}` : "",
      memory,
      skillRows.length
        ? `# Skills (load one with use_skill before following it)\n${skillRows.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
        : "",
      `# This conversation\nYou are in ${where}. Messages from people arrive as "Name (@handle): text". ` +
        "Answer in the language of the person, in plain chat style and briefly. " +
        "Use your tools when they help; when there is nothing useful to add, end without text.",
      await assignmentPrompt(this.deps, agent.id, live.threadId),
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  // ---- delegation between agents ----

  private async delegate(live: Live, target: AgentRow, question: string): Promise<string> {
    const { db } = this.deps;
    const id = newId("cons");
    const at = this.deps.now();
    await db.insert(delegations).values({
      id,
      workspaceId: live.workspaceId,
      requesterAgentId: live.agent.id,
      delegateAgentId: target.id,
      runId: live.runId,
      channelId: live.channel.id,
      question,
      createdAt: at,
    });
    this.emit(live, {
      type: "delegation.started",
      delegationId: id,
      delegateAgentId: target.id,
      question,
      startedAt: at.toISOString(),
    });
    const finish = async (status: "answered" | "expired" | "failed", answer: string | null) => {
      await db
        .update(delegations)
        .set({ status, answer, answeredAt: this.deps.now() })
        .where(eq(delegations.id, id));
      this.emit(live, {
        type: "delegation.completed",
        delegationId: id,
        delegateAgentId: target.id,
        status,
        answer,
      });
    };
    // An agent that thinks on someone's runner: the delegation (asked by another agent) doesn't use that
    // person's plan; it goes through the API if the fallback allows, and only when whoever asked for the run paired it.
    const planOwner = (await withPlanOwner(db, target)).planOwnerUserId;
    if (
      target.harnessKind !== "model" &&
      (!target.harnessFallback || (planOwner !== null && planOwner !== personOf(live.trigger)))
    ) {
      await finish("failed", null);
      return `@${target.handle} thinks with ${EXECUTOR_NAME[target.harnessKind]} on a runner and can't take a delegation now.`;
    }
    const system =
      `You are ${target.name} (@${target.handle}), an AI agent on ${PRODUCT.name}. ` +
      `Another agent, ${live.agent.name} (@${live.agent.handle}), is asking you for help. Answer briefly.\n\n` +
      `# Your instructions\n${target.instructions.trim() || "-"}`;
    // The delegation spends from the delegate: without room on its cap, the model isn't even called. The spend
    // is the asking channel's, and the cap of the asking run (a routine's execution) pays too.
    const held = await this.reserveCall({
      agent: target,
      channelId: live.channel.id,
      scopes: capsOf(live),
      promptBytes: utf8Bytes(system) + utf8Bytes(question),
      maxTokens: CONSULT_MAX_TOKENS,
    });
    if (!held.ok) {
      await finish("failed", null);
      if (held.scope.kind === "channel") {
        await this.channelBudgetCheck(live.channel.id, personOf(live.trigger), true);
        return `This channel is out of budget this month: @${target.handle} can't take a delegation.`;
      }
      if (held.scope.kind === "routine_run")
        return `@${target.handle} can't take a delegation: this routine run's spending cap doesn't fit the question.`;
      if (held.scope.kind === "assignment")
        return `@${target.handle} can't take a delegation: this assignment's spending cap doesn't fit the question.`;
      await this.budgetCheck(target, true);
      return `@${target.handle} is out of budget this month and can't take a delegation.`;
    }
    const reserved = held.reservation;
    const provider = await this.releasing(reserved, () => this.opts.providerFor(target));
    if ("error" in provider) {
      await this.deps.ledger.release(reserved);
      await finish("failed", null);
      return `@${target.handle} could not be reached.`;
    }
    const runId = newId("run");
    await this.releasing(reserved, () =>
      db.insert(runs).values({
        id: runId,
        workspaceId: live.workspaceId,
        agentId: target.id,
        // The run isn't a channel's, but the question came from this one: whoever doesn't read the channel doesn't see it.
        sourceChannelId: live.channel.id,
        status: "running",
        what: whatOf(`@${live.agent.handle}: ${question}`),
        model: target.model,
        startedAt: at,
      }),
    );
    const timeout = AbortSignal.timeout(CONSULT_TIMEOUT_MS);
    const signal = AbortSignal.any([live.controller.signal, timeout]);
    let usage = emptyUsage();
    try {
      let answer = "";
      let turned = false;
      for await (const ev of provider.stream({
        model: target.model,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: question }] }],
        tools: [],
        maxTokens: CONSULT_MAX_TOKENS,
        signal,
      })) {
        if (ev.type === "turn") {
          turned = true;
          usage = ev.usage;
          answer = ev.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
        }
      }
      if (!turned) throw new ModelError("network", "Stream ended without a turn");
      const cost = await this.settleCall(reserved, {
        agent: target,
        userId: personOf(live.trigger),
        runId,
        channelId: live.channel.id,
        source: "delegation",
        usage,
        assignmentId: live.assignment?.assignmentId ?? null,
      });
      await db
        .update(runs)
        .set({
          status: "done",
          finishedAt: this.deps.now(),
          inputTokens: usage.inputTokens + usage.cacheWriteTokens,
          cachedTokens: usage.cachedTokens,
          outputTokens: usage.outputTokens,
          costUsd: cost,
        })
        .where(eq(runs.id, runId));
      await finish("answered", answer);
      await this.budgetNotices(target, live.channel.id, personOf(live.trigger));
      return answer || "(no answer)";
    } catch (err) {
      await this.deps.ledger.release(reserved);
      const expired = timeout.aborted && !live.controller.signal.aborted;
      await db
        .update(runs)
        .set({ status: "failed", finishedAt: this.deps.now(), errorCode: expired ? "timeout" : "failed" })
        .where(eq(runs.id, runId));
      await finish(expired ? "expired" : "failed", null);
      if (live.controller.signal.aborted) throw err;
      return `@${target.handle} did not answer.`;
    }
  }

  // ---- cost ----

  /** A model with no row in the price table is charged as the default one. */
  private billed(model: string, at: Date): string {
    return PRICES.at(model, at) ? model : DEFAULT_MODEL;
  }

  /**
   * Reserves the next call's worst case on the agent's monthly cap and the extra scopes, all or none (seam 2).
   * ok: false = some cap doesn't fit: the call doesn't go out.
   */
  private async reserveCall(req: {
    agent: AgentRow;
    /** Without it, the agent's model. */
    model?: string;
    /** The spend's channel: the reservation goes into its scope, capped or only counting. */
    channelId?: string | null;
    scopes?: readonly BudgetScope[];
    promptBytes: number;
    maxTokens: number;
    /** Each advisor call rereads the conversation and writes up to `maxTokens` on the advisor's model. */
    advisor?: AdvisorSpec;
  }): Promise<{ ok: true; reservation: Reservation } | { ok: false; scope: BudgetScope }> {
    const at = this.deps.now();
    const channel = req.channelId ? await channelSpendScope(this.deps.db, req.channelId) : null;
    const scopes = [
      await agentBudgetScope(this.deps.db, req.agent),
      ...(channel ? [channel] : []),
      ...(req.scopes ?? []),
    ];
    let estimate = estimateUsd(PRICES, {
      model: this.billed(req.model ?? req.agent.model, at),
      promptBytes: req.promptBytes,
      maxTokens: req.maxTokens,
      at,
    });
    if (req.advisor)
      estimate +=
        req.advisor.maxUses *
        estimateUsd(PRICES, {
          model: this.billed(req.advisor.model, at),
          // Reads the prompt and what the executor already wrote (at most its whole output).
          promptBytes: req.promptBytes + req.maxTokens,
          maxTokens: req.advisor.maxTokens,
          at,
        });
    const res = await this.deps.ledger.reserve({
      workspaceId: req.agent.workspaceId,
      scopes,
      estimateUsd: estimate,
      at,
    });
    return res.ok ? { ok: true, reservation: res.reservation } : { ok: false, scope: res.scope };
  }

  /** Records the call in the ledger with the real cost and releases the reservation. Returns the cost. */
  private async settleCall(
    reservation: Reservation,
    call: {
      agent: AgentRow;
      /** Without it, the agent's model. */
      model?: string;
      userId: string | null;
      runId: string;
      channelId: string | null;
      source: UsageSource;
      usage: Usage;
      assignmentId?: string | null;
    },
  ): Promise<number> {
    const at = this.deps.now();
    const { costUsd } = await this.deps.ledger.settle(reservation, {
      workspaceId: call.agent.workspaceId,
      agentId: call.agent.id,
      userId: call.userId,
      runId: call.runId,
      channelId: call.channelId,
      assignmentId: call.assignmentId ?? null,
      source: call.source,
      model: this.billed(call.model ?? call.agent.model, at),
      usage: call.usage,
      keySource: call.agent.credentialId ? "workspace" : "platform",
      at,
    });
    return costUsd;
  }

  /** A call through the runner's plan: it goes into the ledger with cost 0 (it doesn't weigh on the cap). */
  private async recordPlanCall(
    call: Parameters<AgentRuntime["settleCall"]>[1],
    model: string,
  ): Promise<number> {
    const { costUsd } = await this.deps.ledger.record(
      {
        workspaceId: call.agent.workspaceId,
        agentId: call.agent.id,
        userId: call.userId,
        runId: call.runId,
        channelId: call.channelId,
        assignmentId: call.assignmentId ?? null,
        source: call.source,
        model,
        usage: call.usage,
        keySource: "plan",
        at: this.deps.now(),
      },
      [],
    );
    return costUsd;
  }

  /** The gate's telemetry: one row per tool call, with the class and the decision. */
  private async recordDecision(
    live: Live,
    d: {
      tool: string;
      decision: GateDecision;
      approvalId: string | null;
      credential?: CredentialRef | null;
      by?: DecisionBy;
    },
  ): Promise<void> {
    const { decision, by } = d;
    // Seam 7: whoever acts is the agent; whoever asked stays as audit only; the asker's credential fails here.
    const who = actionCredential({
      agentId: live.agent.id,
      requesterId: requesterOf(live.trigger),
      credential: d.credential ?? null,
    });
    // A rule or the reviewer settles the gate's "ask": the row keeps the outcome and the gate's reason.
    const outcome = by ? (by.kind === "rule" ? "allow" : by.verdict) : decision.kind;
    await this.deps.db.insert(gateDecisions).values({
      id: newId("tdec"),
      workspaceId: live.workspaceId,
      agentId: live.agent.id,
      runId: live.runId,
      tool: d.tool,
      effect: decision.effect,
      decision: outcome,
      reason: decision.kind === "allow" ? null : decision.reason,
      flags: [...decision.flags].sort(),
      approvalId: d.approvalId,
      initiatedBy: who.actingFor,
      credential: who.credential,
      by: by?.kind ?? null,
      ruleId: by?.kind === "rule" ? by.ruleId : null,
      createdAt: this.deps.now(),
    });
  }

  /**
   * The model reviewer (reviewer.ts). null = no verdict and the person decides: the reviewer is off in the
   * workspace, the breaker is open, whoever asked isn't a person or wrote nothing here, a failure, or no
   * room in the budget.
   */
  async reviewCall(input: {
    agent: AgentRow;
    channelId: string;
    threadId: string | null;
    /** The request's author; null when the run didn't come from a person. */
    requesterId: string | null;
    /** When the message that opened the run arrived: the reviewer only reads what the person wrote near it. */
    requestAt: Date;
    req: ReviewRequest;
    /** The asking run's caps beyond the agent's month (a routine's execution, an assignment). */
    scopes?: readonly BudgetScope[];
    assignmentId?: string;
  }): Promise<"allow" | "ask" | null> {
    const { db } = this.deps;
    const at = this.deps.now();
    const [workspace] = await db
      .select({ on: workspaces.approvalReviewer })
      .from(workspaces)
      .where(eq(workspaces.id, input.agent.workspaceId));
    if (!workspace?.on || !input.requesterId) return null;
    if (breakerOpen(await recentVerdicts(db, input.agent.id, at))) return null;
    const said = await personSaid(db, {
      channelId: input.channelId,
      threadId: input.threadId,
      requesterId: input.requesterId,
      requestAt: input.requestAt,
      upTo: at,
    });
    if (said.length === 0) return null;
    const res = await this.complete({
      agent: input.agent,
      initiatedBy: input.requesterId,
      system: REVIEWER_SYSTEM,
      prompt: reviewPrompt(said, input.req),
      what: `Review ${input.req.tool}`,
      maxTokens: REVIEWER_MAX_TOKENS,
      source: "review",
      model: REVIEWER_MODEL,
      channelId: input.channelId,
      // The prompt quotes the conversation: whoever doesn't read the channel doesn't see the review run.
      sourceChannelId: input.channelId,
      scopes: input.scopes,
      assignmentId: input.assignmentId,
    });
    return res.ok ? verdictOf(res.text) : null;
  }

  /**
   * The agent's spend this month against its cap: tells the owner at 80% and at the end (once a month each).
   * "exhausted" when not even one answer fits in the worst case (the whole `MAX_TOKENS` output), or when a
   * reservation was just rejected (`rejected`).
   */
  private async budgetCheck(agent: AgentRow, rejected = false): Promise<"ok" | "warning" | "exhausted"> {
    const at = this.deps.now();
    const scope = await agentBudgetScope(this.deps.db, agent);
    const spent = await this.deps.ledger.spent(scope, at);
    const floor = estimateUsd(PRICES, {
      model: this.billed(agent.model, at),
      promptBytes: 0,
      maxTokens: MAX_TOKENS,
      at,
    });
    if (rejected || spent + floor > scope.limitUsd) {
      await this.notifyBudget(agent, "exhausted", spent, scope.limitUsd);
      return "exhausted";
    }
    if (spent >= scope.limitUsd * BUDGET_WARNING_RATIO) {
      await this.notifyBudget(agent, "warning", spent, scope.limitUsd);
      return "warning";
    }
    return "ok";
  }

  /** One notice of each kind per month, for the agent's owner. */
  private async notifyBudget(agent: AgentRow, kind: "warning" | "exhausted", spent: number, budget: number) {
    const { db, hub } = this.deps;
    const month = monthKey(this.deps.now());
    const [row] = await db
      .select({ notice: agents.budgetNotice })
      .from(agents)
      .where(eq(agents.id, agent.id));
    const notice = row?.notice ?? "";
    if (notice === `${kind}:${month}` || (kind === "warning" && notice === `exhausted:${month}`)) return;
    await db
      .update(agents)
      .set({ budgetNotice: `${kind}:${month}` })
      .where(eq(agents.id, agent.id));
    hub.toUser(agent.workspaceId, agent.ownerUserId, {
      type: kind === "exhausted" ? "budget.cap_reached" : "budget.threshold_reached",
      agentId: agent.id,
      spentUsd: spent,
      budgetUsd: budget,
    });
  }

  /**
   * The channel's spend this month against its cap: warns at 75% and 90% and when it runs out (or a
   * reservation was just rejected), one of each per month. Whoever asked and whoever configures the workspace
   * (who can raise the cap) receive it. A channel without a cap: nothing.
   */
  private async channelBudgetCheck(channelId: string, requesterId: string | null, rejected = false) {
    const { db, hub } = this.deps;
    const scope = await channelBudgetScope(db, channelId);
    if (!scope) return;
    const at = this.deps.now();
    const spent = await this.deps.ledger.spent(scope, at);
    const crossed = CHANNEL_WARNINGS.filter((r) => spent >= scope.limitUsd * r);
    const level =
      rejected || spent >= scope.limitUsd
        ? "exhausted"
        : crossed.length
          ? String(Math.round((crossed.at(-1) as number) * 100))
          : null;
    if (!level) return;
    const rank = (l: string) => (l === "exhausted" ? 3 : l === "90" ? 2 : l === "75" ? 1 : 0);
    const month = monthKey(at);
    const [row] = await db
      .select({ workspaceId: channels.workspaceId, name: channels.name, notice: channels.budgetNotice })
      .from(channels)
      .where(eq(channels.id, channelId));
    if (!row) return;
    const [lastLevel, lastMonth] = (row.notice ?? "").split(":");
    if (lastMonth === month && rank(lastLevel ?? "") >= rank(level)) return;
    // Whoever writes the notice first tells: two checks at the same time don't send two.
    const claimed = await db
      .update(channels)
      .set({ budgetNotice: `${level}:${month}` })
      .where(
        and(
          eq(channels.id, channelId),
          row.notice === null ? isNull(channels.budgetNotice) : eq(channels.budgetNotice, row.notice),
        ),
      )
      .returning({ id: channels.id });
    if (claimed.length === 0) return;
    const admins = await db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, row.workspaceId), inArray(members.role, ["owner", "admin"])));
    const to = new Set([...admins.map((a) => a.userId), ...(requesterId ? [requesterId] : [])]);
    for (const userId of to)
      hub.toUser(row.workspaceId, userId, {
        type: "channel.budget",
        channelId,
        channelName: row.name,
        level,
        spentUsd: spent,
        budgetUsd: scope.limitUsd,
      });
  }

  // ---- sweep ----

  /**
   * Posts the reminders that came due, then marks each one sent. The post's client id is the reminder's, so a
   * fall between the two posts nothing twice: the next sweep's post finds the message (and finishes what its post
   * left undone) and marks the reminder then.
   */
  async tick(): Promise<number> {
    if (this.ticking || this.stopped) return 0;
    this.ticking = true;
    try {
      const { db } = this.deps;
      await this.expireWaits();
      // The inbox: a settled request closes its notice, snoozed ones and reminders come back, retention, push and email.
      await notificationTick(this.deps);
      await debateDeadlines(this.deps);
      await dueRoutines(this.deps);
      await drainQueues(this.deps);
      await pollEmailRoutines(this.deps);
      await expireRunnerRequests(this.deps);
      await purgeReservations(db, this.deps.now());
      await deliverDue(this.deps);
      const due = await db
        .select()
        .from(reminders)
        .where(and(eq(reminders.status, "scheduled"), lte(reminders.at, this.deps.now())))
        .orderBy(asc(reminders.at))
        .limit(50);
      let sent = 0;
      for (const r of due) {
        const [channel] = await db.select().from(channels).where(eq(channels.id, r.channelId));
        const author =
          r.agentId !== null
            ? ({ type: "agent", id: r.agentId } as const)
            : ({ type: "person", id: r.createdById } as const);
        if (channel && !channel.archivedAt)
          await postMessage(this.deps, {
            workspaceId: r.workspaceId,
            channel,
            author,
            body: r.text,
            clientId: `reminder:${r.id}`,
            threadId: r.threadId,
            meta: { reminder: { reminderId: r.id } },
          });
        const marked = await db
          .update(reminders)
          .set({ status: "sent", sentAt: this.deps.now() })
          .where(and(eq(reminders.id, r.id), eq(reminders.status, "scheduled")))
          .returning({ id: reminders.id });
        if (marked.length === 0 || !channel || channel.archivedAt) continue;
        sent++;
      }
      return sent;
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Who answers a person's post, by the reply rule (runtime/route): the mentioned agents of the channel, else the
 * DM's agent, else the agents that already spoke in the thread, else the channel's agents that answer without a
 * mention; only those the author may talk to. null: the post doesn't route at all (a suggestion from someone who
 * doesn't decide, or a paused assignment, in an assignment thread). The one place that assembles the routing input.
 */
export async function routeMessage(
  deps: AppDeps,
  channel: ChannelRow,
  post: Pick<MessageRow, "authorId" | "body" | "threadId" | "meta">,
) {
  const { db } = deps;
  // An assignment thread: a suggestion from someone who doesn't decide, and a paused assignment, don't reach the agent.
  if (!(await assignmentRouting(deps, post))) return null;

  const handles = parseMentions(post.body);
  const mentioned = handles.length
    ? await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, channel.workspaceId),
            inArray(agents.handle, handles),
            isNull(agents.archivedAt),
          ),
        )
    : [];
  // In the order they appear in the text.
  mentioned.sort((a, b) => handles.indexOf(a.handle) - handles.indexOf(b.handle));
  const inChannel = await db
    .select({ agent: agents, autoAnswer: channelMemberships.autoAnswer })
    .from(channelMemberships)
    .innerJoin(agents, eq(agents.id, channelMemberships.memberId))
    .where(
      and(
        eq(channelMemberships.channelId, channel.id),
        eq(channelMemberships.memberType, "agent"),
        isNull(agents.archivedAt),
      ),
    );
  let threadAgentIds: string[] = [];
  if (post.threadId) {
    const spoke = await db
      .selectDistinct({ id: messages.authorId })
      .from(messages)
      .where(
        and(
          eq(messages.authorKind, "agent"),
          or(eq(messages.threadId, post.threadId), eq(messages.id, post.threadId)),
        ),
      );
    threadAgentIds = spoke.map((s) => s.id);
  }
  const byId = new Map<string, AgentRow>(
    [...mentioned, ...inChannel.map((m) => m.agent)].map((a) => [a.id, a]),
  );
  // Whoever paired the runner of each agent that thinks through a plan: only that person talks to it.
  const talkers = new Map((await withPlanOwners(db, [...byId.values()])).map((a) => [a.id, a]));
  const talker = (a: AgentRow) => talkers.get(a.id) ?? { ...a, planOwnerUserId: null };
  const routed = route({
    authorUserId: post.authorId,
    mentioned: mentioned.map(talker),
    inChannel: inChannel.map((m) => ({ agent: talker(m.agent), autoAnswer: m.autoAnswer })),
    isDm: channel.kind === "dm",
    threadAgentIds,
  });
  return { mentioned, threadAgentIds, byId, talker, routed };
}

/** A short summary of the input for the tool's line: the first text it has. */
export function toolDetail(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) {
      const v = value.trim().replace(/\s+/g, " ");
      return v.length > 80 ? `${v.slice(0, 79)}…` : v;
    }
  }
  return null;
}

function whatOf(body: string): string {
  const clean = body
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}
