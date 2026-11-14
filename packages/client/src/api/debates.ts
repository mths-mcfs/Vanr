// Debates: rounds between agents and people that end in a synthesis and a verdict.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e } from "../endpoint.ts";
import * as s from "../schema.ts";
import { DebateBlindReview } from "./shapes.ts";

export interface CreateDebateBody {
  title: string;
  goal: string;
  agentIds: string[];
  userIds?: string[];
  rounds?: number;
  format?: T.DebateFormat;
  deadline?: string;
  speakers?: T.DebateSpeaker[];
  options?: string[];
  /** Share of the workspace budget the debate may spend, in percent. */
  spendCapPercent?: number;
  sourceIssueId?: string;
  channelId?: string;
}

export const debates = {
  listDebates: e("GET", "/api/v1/workspaces/:workspaceId/debates", s.field("debates", s.array(C.Debate))),
  getDebate: e("GET", "/api/v1/workspaces/:workspaceId/debates/:debateId", C.DebateDetail),
  createDebate: e("POST", "/api/v1/workspaces/:workspaceId/debates", C.DebateDetail).body<CreateDebateBody>(),
  /** The most opening a debate with these agents and rounds can cost. */
  estimateDebate: e("GET", "/api/v1/workspaces/:workspaceId/debates/estimate", C.DebateEstimate).query<{
    agentIds: readonly string[];
    rounds: number;
    format?: T.DebateFormat;
  }>(),
  listDebateMetrics: e("GET", "/api/v1/workspaces/:workspaceId/debates/metrics", C.DebateMetrics).query<{
    days?: number;
  }>(),
  createDebatePost: e("POST", "/api/v1/workspaces/:workspaceId/debates/:debateId/posts", C.DebatePost).body<{
    body: string;
    answer?: string;
    confidence?: number;
    wantsExtraRound?: boolean;
    replyTo?: string;
  }>(),
  concludeDebate: e("POST", "/api/v1/workspaces/:workspaceId/debates/:debateId/conclude", C.DebateDetail),
  cancelDebate: e("POST", "/api/v1/workspaces/:workspaceId/debates/:debateId/cancel", C.DebateDetail),
  skipDebate: e("POST", "/api/v1/workspaces/:workspaceId/debates/:debateId/skip", C.DebateDetail),
  resumeDebate: e("POST", "/api/v1/workspaces/:workspaceId/debates/:debateId/resume", C.DebateDetail),
  setDebateParticipants: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/debates/:debateId/participants",
    C.DebateDetail,
  ).body<{
    agentsToAdd?: string[];
    agentsToRemove?: string[];
    peopleToAdd?: string[];
    peopleToRemove?: string[];
    addSpeakerUserIds?: string[];
    removeSpeakerUserIds?: string[];
  }>(),
  setDebateVerdict: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/debates/:debateId/verdict",
    C.DebateDetail,
  ).body<{
    action: "accept" | "revert";
  }>(),
  createDebateIssue: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/debates/:debateId/issues",
    s.object({
      numbers: s.array(s.number),
      issues: s.array(s.object({ id: s.string, number: s.number, title: s.string })),
    }),
  ).body<{ items: { title: string; owner?: string; step?: string; description?: string }[] }>(),
  reviewDebate: e("GET", "/api/v1/workspaces/:workspaceId/debates/:debateId/review", DebateBlindReview),
  reviewDebatePickReview: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/debates/:debateId/review",
    DebateBlindReview,
  ).body<{ pick: "a" | "b" | "tie" }>(),
  acceptDebateSuggestion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/debate-suggestions/:messageId/accept",
    s.object({ debate: C.DebateDetail, suggestion: C.DebateSuggestion }),
  ).body<{ title?: string; goal?: string; agentIds?: string[]; rounds?: number }>(),
  dismissDebateSuggestion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/debate-suggestions/:messageId/dismiss",
    s.field("suggestion", C.DebateSuggestion),
  ),
};
