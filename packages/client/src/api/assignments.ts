// Assignments: a goal handed to an executor agent, with its plan, decisions, commands, submissions,
// reviews, participants and the jobs it sends to runners.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import {
  AssignmentEventPage,
  AssignmentFiles,
  AssignmentList,
  AssignmentPlan,
  AssignmentPlanVersion,
  AssignmentSummary,
} from "./shapes.ts";

export type AssignmentAction = "pause" | "resume" | "start" | "stop";

export interface CreateAssignmentBody {
  agentId: string;
  goal: string;
  title?: string;
  channelId: string;
  threadId?: string;
  commandPolicy?: T.CommandPolicy;
  executor?: T.AssignmentExecutor;
  runnerId?: string;
}

export interface PlanItemInput {
  /** Absent for a new item. */
  id?: string;
  title: string;
  criteria: string;
  milestone?: string | null;
}

const Policy = s.object({ commandPolicy: C.CommandPolicy });

export const assignments = {
  listAssignments: e("GET", "/api/v1/workspaces/:workspaceId/assignments", AssignmentList).query<{
    status?: "blocked_on_you" | "closed" | "open";
    channelId?: string;
    agentId?: string;
    q?: string;
    limit?: number;
  }>(),
  listAssignmentEligibleAgents: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/eligible-agents",
    s.field("agents", s.array(C.AssignmentEligibleAgent)),
  ),
  createAssignment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments",
    C.Assignment,
  ).body<CreateAssignmentBody>(),
  getAssignment: e("GET", "/api/v1/workspaces/:workspaceId/assignments/:assignmentId", C.Assignment),
  updateAssignment: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId",
    C.Assignment,
  ).body<{
    resumeJobs?: boolean;
    limits?: Partial<T.AssignmentLimits>;
    dueAt?: string | null;
  }>(),
  setAssignmentResumeJobs: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId",
    C.Assignment,
  ).body<{ resumeJobs: boolean }>(),
  /** null when the thread has no assignment. */
  getThreadAssignment: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/threads/:threadId/assignment",
    C.Assignment,
  ).orNullOn(404),
  listThreadJobs: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/threads/:threadId/jobs",
    s.field("jobs", s.array(C.Job)),
  ),
  getJobOutput: e("GET", "/api/v1/workspaces/:workspaceId/jobs/:jobId/output", C.JobOutput).query<{
    /** Only the last lines. */
    tail?: number;
  }>(),
  /** `action` is an AssignmentAction; stopping also reports how many jobs it canceled. */
  runActionOnAssignment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/:action",
    s.merge(C.Assignment, s.object({ canceledJobs: s.optional(s.number) })),
  ),
  closeAssignment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/close",
    C.Assignment,
  ).body<{ outcome: "canceled" | "done"; copyToWiki?: boolean; note?: string }>(),
  transferAssignment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/transfer",
    s.merge(C.Assignment, s.object({ code: s.optional(s.string) })),
  ).body<{ userId: string; lendRunner?: boolean }>(),
  createAssignmentMessage: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/messages",
    s.object({ delivered: s.boolean, jobId: s.optional(s.string) }),
  ).body<{ text: string }>(),
  setAssignmentRunner: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/runner",
    C.Assignment,
  ).body<{
    runnerId: string;
    /** "" clears the folder; leaving it out keeps the current one. */
    checkoutPath?: string;
  }>(),
  setAssignmentExecutor: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/executor",
    C.Assignment,
  ).body<{ executor: T.AssignmentExecutor }>(),
  setAssignmentCommandApproval: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/command-approval",
    Policy,
  ).body<{ commandPolicy: T.CommandPolicy }>(),
  setAgentAssignmentCommandApproval: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/assignment-command-approval",
    Policy,
  ).body<{ commandPolicy: T.CommandPolicy }>(),
  getAssignmentSettings: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/settings",
    C.AssignmentSettings,
  ),
  getAssignmentRuntime: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/runtime",
    C.AssignmentHarness,
  ),
  setAssignmentRuntime: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/runtime",
    C.AssignmentHarness,
  ).body<{ harness: T.AssignmentExecutor; model?: string }>(),

  listAssignmentParticipants: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/participants",
    C.AssignmentParticipants,
  ),
  updateAssignmentParticipant: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/participants/:participantId",
    C.AssignmentParticipants,
  ).body<{ role: T.ParticipantRole }>(),
  deleteAssignmentParticipant: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/participants/:participantId",
    NOTHING,
  ),
  listAssignmentJoinRequests: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/join-requests",
    s.field("requests", s.array(C.AssignmentJoinRequest)),
  ),
  createAssignmentJoinRequest: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/join-requests",
    C.AssignmentJoinRequest,
  ),
  /** `action` is accept or decline; accepting takes the participant's role. */
  runActionOnAssignmentJoinRequest: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/join-requests/:joinRequestId/:action",
    C.AssignmentJoinRequest,
  ).body<{ role?: T.ParticipantRole }>(),

  listAssignmentDecisions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/decisions",
    s.field("decisions", s.array(C.AssignmentDecision)),
  ),
  chooseAssignmentDecision: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/decisions/:decisionId/choose",
    C.AssignmentDecision,
  ).body<{ option: string }>(),
  opinionAssignmentDecision: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/decisions/:decisionId/opinion",
    C.AssignmentDecision,
  ).body<{ option: string }>(),
  approveAssignmentDecisionProvisional: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/decisions/approve-provisional",
    s.field("decisions", s.array(C.AssignmentDecision)),
  ),
  listAssignmentCommands: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/commands",
    s.object({ commands: s.array(C.AssignmentCommand), rules: s.array(s.string) }),
  ),
  decideAssignmentCommand: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/commands/:commandId/decide",
    C.AssignmentCommand,
  ).body<{ decision: "allow" | "always" | "deny" }>(),
  retryAssignmentCommand: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/commands/retry",
    s.object({ rules: s.array(s.string), delivered: s.boolean }),
  ).body<{ jobId: string; commands: string[] }>(),
  deleteAssignmentCommandRule: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/command-rules/:commandRuleId",
    s.field("rules", s.array(C.AssignmentCommandRule)),
  ),

  listAssignmentSubmissions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/submissions",
    s.array(C.AssignmentSubmission),
  ),
  replaceAssignmentSubmissionChecklist: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/submissions/:submissionId/checklist/:itemId",
    C.AssignmentSubmission,
  ).body<{ checked: boolean }>(),
  acceptAssignmentSubmission: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/submissions/:submissionId/accept",
    C.Assignment,
  ).body<{ copyToWiki: boolean }>(),
  requestAssignmentSubmissionChanges: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/submissions/:submissionId/request-changes",
    C.Assignment,
  ).body<{ note: string }>(),
  listAssignmentReviews: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/reviews",
    s.field("reviews", s.array(C.AssignmentReview)),
  ),
  /** `action` is approve or changes. */
  runActionOnAssignmentReview: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/reviews/:reviewId/:action",
    C.AssignmentReview,
  ).body<{ note?: string }>(),
  /** `action` is accept or decline. */
  runActionOnAssignmentSuggestion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/suggestions/:suggestionId/:action",
    s.object({ messageId: s.string, status: s.literal("accepted", "declined") }),
  ),

  listAssignmentFiles: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/files",
    AssignmentFiles,
  ),
  getAssignmentSummary: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/summary",
    AssignmentSummary,
  ),
  getAssignmentPlan: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/plan",
    AssignmentPlan,
  ),
  setAssignmentPlan: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/plan",
    AssignmentPlan,
  ).body<{ parentVersion: number; items: PlanItemInput[]; note?: string }>(),
  listAssignmentPlanVersions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/plan/versions",
    s.field("versions", s.array(AssignmentPlanVersion)),
  ),
  retryAssignmentItem: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/items/:itemId/retry",
    C.AssignmentPlanItem,
  ),
  listAssignmentProofs: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/proofs",
    s.field("proofs", s.array(C.AssignmentProof)),
  ),
  /** Without `after`: the latest events (or the ones before `before`); with it, what came since. */
  listAssignmentEvents: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/events",
    AssignmentEventPage,
  ).query<{ after?: number; before?: number; limit?: number }>(),
  markAssignmentSeen: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/assignments/:assignmentId/seen",
    s.object({ seenSeq: s.number }),
  ).body<{ seq: number }>(),
};
