// Agents: profile, harness, models, credentials, teams, actions, inbox and reminders.

import type { ActorRef } from "./common.ts";
import type { RunStatus } from "./runs.ts";

export type AgentRole =
  | "assistant"
  | "content"
  | "custom"
  | "data"
  | "dev"
  | "finance"
  | "marketing"
  | "ops"
  | "people"
  | "pm"
  | "qa"
  | "research"
  | "sales"
  | "support";

export interface AgentAppearance {
  adornment: string;
  color: string;
  eyes: string;
}

export interface AgentAudience {
  mode: "everyone" | "owner" | "people";
  userIds: string[];
}

export type HarnessKind = "claude_code" | "codex" | "model";

export interface AgentHarnessRef {
  environment: string | null;
  kind: HarnessKind;
  model: string;
}

/** Advisor: the agent's model asks a more capable one in the middle of an answer. */
export interface AgentAdvisor {
  /** Advisor calls per model call (1 to 5). */
  maxUses: number;
  model: string;
}

export interface Agent {
  id: string;
  advisor: AgentAdvisor | null;
  appearance: AgentAppearance;
  archivedAt: string | null;
  audience: AgentAudience;
  busy: boolean;
  createdAt: string;
  handle: string;
  harness: AgentHarnessRef;
  instructions: string;
  model: string;
  name: string;
  ownerUserId: string;
  reachable: boolean;
  role: AgentRole;
  /** No Anthropic key (workspace or platform): the test model is answering for the agent right now. */
  testModel: boolean;
}

export interface AgentChannel {
  id: string;
  autoAnswer: boolean;
}

export interface AgentDetail extends Agent {
  budgetInherited: boolean;
  budgetPerMonthUsd: number;
  budgetSpentPct: number;
  channels: AgentChannel[];
  costThisMonthUsd: number;
  credentialId: string | null;
  inheritedBudgetUsd: number;
  monthRuns: number;
  monthTokens: number;
  queuedApprovals: number;
}

export type HarnessUnavailableReason =
  | "exec_off"
  | "no_environment"
  | "not_installed"
  | "not_logged_in"
  | "outdated"
  | "personal_plan"
  | "runner_old"
  | "tool_off";

export interface HarnessOption {
  available: boolean;
  defaultModel: string;
  kind: HarnessKind;
  models: { label: string; recommended?: boolean; value: string }[];
  reason: HarnessUnavailableReason | null;
}

export interface AgentHarness {
  environment: string | null;
  fallback: boolean;
  harness: HarnessKind;
  options: HarnessOption[];
  resolvedModel: string;
  runners: { name: string; online: boolean; options: HarnessOption[]; runnerId: string }[];
}

export interface Model {
  id: string;
  /** Advisors this model accepts (empty: no advisor). */
  advisors: string[];
  available: boolean;
  inputPricePerMillion: number;
  label: string;
  outputPricePerMillion: number;
  provider: "anthropic" | "fake";
}

export interface TeamAgent {
  id: string;
  appearance: AgentAppearance;
  busy: boolean;
  capabilities: string[];
  handle: string;
  name: string;
  ownerUserId: string;
  reachable: boolean;
  role: AgentRole;
  useWhen: string;
}

export interface Team {
  agents: TeamAgent[];
  delegations: {
    at: string;
    delegateAgentId: string;
    requesterAgentId: string;
    status: "answered" | "expired" | "failed" | "open";
  }[];
  people: { handle: string; image: string | null; name: string; userId: string }[];
}

export interface Credential {
  id: string;
  createdAt: string;
  keyPreview: string;
  label: string;
  provider: "anthropic" | "openai";
  revokedAt: string | null;
}

/** One version of the instructions: author, reason and where it came from. */
export interface InstructionVersion {
  id: string;
  agentId: string;
  author: { id: string | null; type: "agent" | "person" | "system" };
  createdAt: string;
  proposalId: string | null;
  reason: string;
  restoredFromSeq: number | null;
  seq: number;
  source: "builder" | "create" | "edit" | "initial" | "proposal" | "redo" | "restore" | "undo";
  text: string;
}

export type AgentActionKind =
  | "base_rows_upserted"
  | "calendar_event_created"
  | "channel_created"
  | "file_created"
  | "file_updated"
  | "issue_commented"
  | "issue_edited"
  | "issue_opened"
  | "mail_sent"
  | "memory_recorded"
  | "message_posted"
  | "proposal_applied"
  | "reminder_created"
  | "routine_scheduled"
  | "wiki_updated"
  | "wiki_written";

export interface AgentAction {
  id: string;
  agentId: string;
  createdAt: string;
  kind: AgentActionKind;
  messageId: string | null;
  params: Record<string, unknown>;
  requesterUserId: string | null;
  revertedAt: string | null;
  reverterUserId: string | null;
  revertibleUntil: string | null;
  target: { id: string; number?: number; slug?: string; title?: string; type: string };
}

export interface AgentInbox {
  recent: {
    at: string;
    channelId: string | null;
    runId: string;
    status: RunStatus;
    threadId: string | null;
    what: string;
  }[];
  waiting: {
    id: string;
    at: string;
    kind: "approval" | "memory_review" | "proposal" | "question" | "secret";
    title: string;
  }[];
}

export interface Reminder {
  id: string;
  agentId: string | null;
  at: string;
  channelId: string;
  createdAt: string;
  createdBy: ActorRef;
  status: "canceled" | "scheduled" | "sent";
  text: string;
  threadId: string | null;
}
