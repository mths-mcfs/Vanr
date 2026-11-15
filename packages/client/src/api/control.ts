// Human in the loop: approvals, proposals, questions, secret requests and the agent's browser.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { DOWNLOAD, endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { ApprovalStats } from "./shapes.ts";

export interface ApproveBody {
  /** Hash of the effect shown to the person; approving an effect that has one requires it. */
  payloadHash?: string;
  reason?: string;
  /** Turns the decision into an "always allow" rule. */
  remember?: boolean;
}

export const control = {
  listApprovals: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/approvals",
    s.field("approvals", s.array(C.Approval)),
  ).query<{ status?: "decided" | "pending" }>(),
  getApproval: e("GET", "/api/v1/workspaces/:workspaceId/approvals/:approvalId", C.Approval),
  approveApproval: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/approvals/:approvalId/approve",
    C.Approval,
  ).body<ApproveBody>(),
  editApproval: e("POST", "/api/v1/workspaces/:workspaceId/approvals/:approvalId/edit", C.Approval).body<{
    input: Record<string, unknown>;
    payloadHash: string;
    reason?: string;
    remember?: boolean;
  }>(),
  rejectApproval: e("POST", "/api/v1/workspaces/:workspaceId/approvals/:approvalId/reject", C.Approval).body<{
    reason?: string;
  }>(),
  listApprovalStats: e("GET", "/api/v1/workspaces/:workspaceId/approvals/stats", ApprovalStats).query<{
    days?: number;
  }>(),
  listApprovalRules: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/approval-rules",
    s.field("rules", s.array(C.ApprovalRule)),
  ).query<{ agentId?: string }>(),
  deleteApprovalRule: e("DELETE", "/api/v1/workspaces/:workspaceId/approval-rules/:approvalRuleId", NOTHING),

  listProposals: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/proposals",
    s.field("proposals", s.array(C.Proposal)),
  ),
  acceptProposal: e("POST", "/api/v1/workspaces/:workspaceId/proposals/:proposalId/accept", C.Proposal).body<{
    /** The text as the person edited it before accepting. */
    text?: string;
  }>(),
  rejectProposal: e("POST", "/api/v1/workspaces/:workspaceId/proposals/:proposalId/reject", C.Proposal),
  answerQuestion: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/questions/:questionId/answer",
    C.AgentQuestion,
  ).body<{ choice: string } | { text: string }>(),

  deliverSecretRequest: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/secret-requests/:secretRequestId/deliver",
    C.SecretRequest,
  ).body<{ box: T.SecretBox }>(),
  declineSecretRequest: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/secret-requests/:secretRequestId/decline",
    C.SecretRequest,
  ),
  listAgentSecrets: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/secrets",
    s.field("secrets", s.array(C.AgentSecret)),
  ),
  deleteAgentSecret: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/secrets/:secretId",
    NOTHING,
  ).query<{ runnerId: string }>(),

  getAgentBrowser: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser",
    C.AgentBrowserSettings,
  ),
  setAgentBrowser: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser",
    C.AgentBrowserSettings,
  ).body<{ permittedDomains: string[] }>(),
  setAgentBrowserPolicy: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser/policy",
    C.AgentBrowserSettings,
  ).body<{ level: T.BrowserLevel; sites: T.SiteRule[]; privateRanges?: string[] }>(),
  stopAgentBrowser: e("POST", "/api/v1/workspaces/:workspaceId/agents/:agentId/browser/stop", NOTHING),
  listAgentBrowserLog: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser/log",
    s.field("entries", s.array(C.BrowserLogEntry)),
  ).query<{ runId?: string; before?: string; limit?: number }>(),
  getAgentBrowserLogEntryShot: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser/log/:entryId/shot",
    DOWNLOAD,
  ),
  /** The agent's open intervention, if any. */
  listAgentBrowserInterventions: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser/interventions",
    s.field("intervention", s.nullable(C.BrowserIntervention)),
  ),
  /** A person takes over the agent's browser (in the middle of `runId`, when given). */
  startAgentBrowserIntervention: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/agents/:agentId/browser/interventions/start",
    C.BrowserIntervention,
  ).body<{ runId?: string }>(),
  getBrowserIntervention: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/browser-interventions/:interventionId",
    C.BrowserIntervention,
  ),
  controlBrowserIntervention: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/browser-interventions/:interventionId/control",
    C.BrowserIntervention,
  ),
  completeBrowserIntervention: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/browser-interventions/:interventionId/complete",
    C.BrowserIntervention,
  ),
  failBrowserIntervention: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/browser-interventions/:interventionId/fail",
    C.BrowserIntervention,
  ).body<{ note?: string }>(),
  cancelBrowserIntervention: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/browser-interventions/:interventionId/cancel",
    C.BrowserIntervention,
  ),
};
