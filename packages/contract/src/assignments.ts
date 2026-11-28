// Assignments: goals handed to an executor agent, with plan, decisions, submissions and reviews.

export interface ThreadAssignmentInfo {
  agentId: string;
  assignmentId: string;
  blockedOnYou: boolean;
  role: string | null;
  status: string;
  stepsDone: number;
  stepsTotal: number;
}

export type AssignmentStatus = "active" | "canceled" | "done" | "paused" | "proposed" | "wrapping_up";

export type AssignmentExecutor = "agent" | "claude_code" | "codex";

/** always: always ask; when_safe: allow what is low risk; never: never ask. */
export type CommandPolicy = "always" | "never" | "when_safe";

/** Role of whoever is viewing the assignment: owner, participant who decides or comments, or read-only. */
export type AssignmentRole = "comment" | "decide" | "owner" | "view";

export type ParticipantRole = "comment" | "decide";

export type PlanItemStatus = "blocked_on_you" | "doing" | "done" | "dropped" | "todo";

export interface Assignment {
  id: string;
  actionable: boolean;
  agentId: string;
  /** Limit that paused the assignment. */
  ceiling: AssignmentLimitKind | null;
  channelId: string;
  checkoutPath: string | null;
  closedAt: string | null;
  commandPolicy: CommandPolicy;
  createdAt: string;
  dueAt: string | null;
  executor: AssignmentExecutor;
  findings: string[];
  goal: string;
  lastTouchedAt: string | null;
  limits: AssignmentLimits;
  manageable: boolean;
  needsEnvironment: boolean;
  outcome: "canceled" | "done" | null;
  overdue: boolean;
  ownerId: string;
  pausedAt: string | null;
  pending: {
    commands: number;
    decisions: number;
    joinRequests: number;
    provisional: number;
    reviews: number;
    submissions: number;
  };
  pendingJoin: boolean;
  pendingQuestion: string | null;
  plan: {
    done: number;
    items: AssignmentPlanItem[];
    /** Items the verifier approved. */
    passed: number;
    total: number;
    version: number;
    waiting: number;
  };
  resumeJobs: boolean;
  role: AssignmentRole | null;
  runner: { id: string; executors: AssignmentExecutor[]; name: string; online: boolean } | null;
  runningJobs: number;
  /** Active, not waiting on anyone, and no news for more than 30 min. */
  stale: boolean;
  startedAt: string | null;
  /** Work state, from the server: waiting on you, stopped, with a deadline... */
  state: AssignmentWorkState;
  status: AssignmentStatus;
  threadId: string;
  title: string;
  /** Trail events the person has not seen yet. */
  unseen: number;
  usage: AssignmentUsage;
  waitReason: AssignmentWaitReason | null;
  /** The engine looks again at this time (the agent asked, or a decision's deadline). */
  wakeAt: string | null;
}

export interface AssignmentEligibleAgent {
  agentId: string;
  executors: AssignmentExecutor[];
  manageable: boolean;
  qualifies: boolean;
  reason: string | null;
  runner: { id: string; name: string; online: boolean } | null;
}

export interface AssignmentJoinRequest {
  createdAt: string;
  name: string;
  role: ParticipantRole | null;
  status: "accepted" | "declined" | "pending";
  userId: string;
}

export interface AssignmentParticipants {
  owner: { name: string; userId: string };
  participants: { name: string; role: ParticipantRole; userId: string }[];
}

export interface AssignmentCommandRule {
  id: string;
  by: string;
  createdAt: string;
  rule: string;
}

export interface AssignmentSettings {
  agentBaseline: { adjustable: boolean; commandPolicy: CommandPolicy };
  rules: AssignmentCommandRule[];
  stats: { asked: number; auto: number; blocked: number };
}

export interface AssignmentHarness {
  effectiveHarness: AssignmentExecutor;
  modelAdjustable: boolean;
  options: { kind: AssignmentExecutor; models: { label: string; recommended?: boolean; value: string }[] }[];
  resolvedModel: string;
}

export interface AssignmentDecision {
  id: string;
  blocking: boolean;
  chosen: string | null;
  impact: string | null;
  messageId: string | null;
  opinions: { at: string; option: string; userId: string }[];
  options: string[];
  question: string;
  recommendation: string | null;
  selectedAt: string | null;
  selectedBy: string | null;
  status: "pending" | "provisional" | "taken";
  why: string | null;
}

export interface AssignmentCommand {
  id: string;
  always: boolean;
  command: string;
  createdAt: string;
  jobId: string;
  rules: string[];
  state: "allowed" | "denied" | "expired" | "pending";
  tool: string;
}

export interface AssignmentSubmission {
  id: string;
  auto: boolean;
  changesNote: string | null;
  checklist: { id: string; text: string; verifiedBy: string | null }[];
  createdAt: string;
  fileIds: string[];
  note: string;
  status: "accepted" | "changes_requested" | "pending" | "superseded";
}

export interface AssignmentReview {
  id: string;
  decidedAt: string | null;
  decidedBy: string | null;
  fileIds: string[];
  note: string | null;
  prUrl: string | null;
  status: "approved" | "changes_requested" | "pending";
  summary: string;
  title: string;
}

/** Same as the engine's work state (the contract does not depend on the engine). */
export type AssignmentWorkState = "blocked_on_you" | "done" | "due" | "failed" | "running" | "stopped";

export type AssignmentLimitKind = "minutes" | "steps" | "usd";

export type AssignmentWaitReason =
  | "ceiling"
  | "closed"
  | "idle"
  | "paused"
  | "person"
  | "proposed"
  | "stuck"
  | "submission"
  | "timer"
  | "working";

/** Who acted: a person, the assignment's agent, the verifier (clean context) or the engine. */
export interface AssignmentActorRef {
  id: string | null;
  type: "agent" | "person" | "system" | "verifier";
}

export interface AssignmentPlanItem {
  id: string;
  createdBy: AssignmentActorRef;
  /** Definition of done: what the verifier checks. */
  criteria: string;
  /** Fix item: which item it fixes. */
  fixes: string | null;
  kind: "change" | "fix" | "work";
  milestone: string | null;
  /** null: not verified. Only the verifier writes it. */
  passes: boolean | null;
  /** Stuck: the attempts (`turns`) or the validation rounds (`rounds`) ran out; waits for the person. */
  stallReason: "rounds" | "turns" | null;
  state: AssignmentWorkState;
  status: PlanItemStatus;
  summary: string | null;
  title: string;
  updatedAt: string;
  updatedBy: AssignmentActorRef;
  verdict: string | null;
  verifiedAt: string | null;
}

export interface AssignmentLimits {
  dollars: number | null;
  minutes: number | null;
  steps: number | null;
}

export interface AssignmentUsage {
  /** USD spent by the harness through the API (ledger). */
  dollars: number;
  /** Tokens reported by Claude Code/Codex (the pairing person's plan: no USD). */
  jobTokens: number;
  /** Job minutes on the environment. */
  minutes: number;
  /** Agent turns and jobs the engine sent. */
  steps: number;
  /** Jobs that finished without reporting usage ("cost not measured"). */
  unmeasuredJobs: number;
}

export type AssignmentEventKind =
  | "ceiling_hit"
  | "ceiling_warning"
  | "closed"
  | "decision_asked"
  | "decision_deadline"
  | "decision_taken"
  | "delivered"
  | "engine_forked"
  | "fix_created"
  | "item_done"
  | "item_retry"
  | "item_started"
  | "item_stuck"
  | "job_done"
  | "overdue"
  | "paused"
  | "plan_edited"
  | "proof_added"
  | "resumed"
  | "stale"
  | "started"
  | "validation_failed"
  | "validation_passed"
  | "verifier_unavailable"
  | "waiting_until"
  | "work_ended";

export interface AssignmentEvent {
  actor: AssignmentActorRef;
  at: string;
  data: Record<string, unknown>;
  itemId: string | null;
  kind: AssignmentEventKind;
  seq: number;
}

export interface AssignmentProof {
  id: string;
  body: string | null;
  by: AssignmentActorRef;
  createdAt: string;
  fileId: string | null;
  itemId: string | null;
  jobId: string | null;
  kind: "diff" | "files" | "preview" | "screenshot" | "test_log";
  title: string;
  url: string | null;
}

/** The six work states. */
export type WorkStateName = "blocked_on_you" | "done" | "due" | "failed" | "running" | "stopped";

/** Body of `createAssignment`. */
export interface AssignmentInput {
  agentId: string;
  channelId: string;
  commandPolicy?: CommandPolicy;
  executor?: AssignmentExecutor;
  goal: string;
  runnerId?: string;
  /** A root message of the channel that becomes the assignment's thread. */
  threadId?: string;
  title?: string;
}

/** Body of `updateAssignment`. A limit set to null has no cap; one left out keeps its value. */
export interface AssignmentPatch {
  dueAt?: string | null;
  limits?: { dollars?: number | null; minutes?: number | null; steps?: number | null };
  resumeJobs?: boolean;
}

/** Body of `closeAssignment`. */
export interface AssignmentCloseInput {
  copyToWiki?: boolean;
  note?: string;
  outcome: "canceled" | "done";
}

/** Body of `transferAssignment`. Lending keeps the current runner on the assignment for the new owner. */
export interface AssignmentTransferInput {
  lendRunner?: boolean;
  userId: string;
}

/** Body of `setAssignmentRunner`. "" clears the folder; leaving it out keeps the current one. */
export interface AssignmentRunnerInput {
  checkoutPath?: string;
  runnerId: string;
}

/** Body of `setAssignmentRuntime`. */
export interface AssignmentHarnessInput {
  harness: AssignmentExecutor;
  model?: string;
}

/** One item of a person's plan edit; without `id` it is a new item. */
export interface AssignmentPlanItemInput {
  criteria?: string;
  id?: string;
  milestone?: string | null;
  status?: "dropped" | "todo";
  title: string;
}

/** Body of `setAssignmentPlan`: the whole plan, against the version it was read at. */
export interface AssignmentPlanInput {
  items: AssignmentPlanItemInput[];
  note?: string;
  parentVersion: number;
}

/** Body of `retryAssignmentCommand`: commands of a job to allow from now on, and the job to resume. */
export interface AssignmentCommandRetryInput {
  commands: string[];
  jobId: string;
}
