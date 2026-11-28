// Channels, messages, threads and the channel directory.

import type { AgentAction } from "./agents.ts";
import type { AgentQuestion } from "./approvals.ts";
import type { ThreadAssignmentInfo } from "./assignments.ts";
import type { ActorRef, ActorType } from "./common.ts";
import type { FileRef } from "./files.ts";
import type { NetworkRequest } from "./runners.ts";
import type { SecretRequest } from "./secrets.ts";

export type ChannelVisibility = "private" | "public";

export interface Channel {
  id: string;
  /** Monthly spend cap for agents in the channel; null = no channel cap. */
  budgetPerMonthUsd: number | null;
  createdAt: string;
  /** The workspace's #general: nobody leaves it and its name does not change. */
  isGeneral: boolean;
  isMember: boolean;
  name: string;
  topic: string;
  unreadCount: number;
  visibility: ChannelVisibility;
}

/**
 * A private channel archived when its last member left: its name is free again. Only the workspace's owners list
 * it and bring it back; restoring it makes the owner its member, and a name another channel took since is a 409
 * `channel.name_taken` (rename that one first).
 */
export interface ArchivedChannel {
  archivedAt: string;
  createdAt: string;
  id: string;
  name: string;
  topic: string;
}

export interface DirectMessage {
  channelId: string;
  unread: number;
  with: { id: string; name: string; type: ActorType };
}

export interface ChannelMember {
  id: string;
  type: ActorType;
}

export interface DirectoryMember {
  id: string;
  autoAnswer?: boolean;
  handle: string | null;
  name: string;
  type: ActorType;
}

export interface ReactionCount {
  agentIds: string[];
  count: number;
  reaction: string;
  userIds: string[];
}

export interface MessageMemory {
  id: string;
  agentId: string;
  text: string;
}

export type HandledStatus = "answered" | "blocked" | "canceled" | "failed" | "silent";

export interface MessageReceipts {
  blocked?: { agentId: string; reason: string }[];
  claimedBy: string[];
  handled: { agentId: string; runId: string; status: HandledStatus }[];
  referenced?: string[];
  viewedBy: string[];
}

export interface MessageUsage {
  inputTokens: number;
  model: string;
  outputTokens: number;
}

export interface ReplyRef {
  author: ActorRef;
  authorName: string;
  excerpt: string;
  messageId: string;
  threadId: string | null;
}

/** Meta keys that render as cards. The card reads the state of the entity it points to. */
export interface MessageMeta {
  replyTo?: ReplyRef;
  files?: FileRef[];
  approvalId?: string;
  proposalId?: string;
  /** The whole question; the server rewrites the meta when it is answered. */
  question?: AgentQuestion;
  /** The whole request, like the question's: the card needs the public key and the server updates it. */
  secretRequest?: SecretRequest;
  browserIntervention?: { id: string };
  /** Request for a new domain (the whole request, like the secret's; the server rewrites it on decision). */
  networkRequest?: NetworkRequest;
  /**
   * A connector's service asked for more permission (`insufficient_scope`): the amber card leads someone
   * who can configure it to grant the missing scope. `state` changes when the person grants it.
   */
  connectorScope?: {
    connectionId: string;
    connector: string;
    label: string;
    /** An agent's own account or the workspace's. */
    owner: "agent" | "workspace";
    /** New scopes (the ones not granted before), for display only. */
    scopes: string[];
    state?: "granted" | "pending";
    /** Label of the tool that needed it. */
    tool: string;
  };
  /** Run answer: how many tools the agent called before it (absent when no tool was called). */
  toolSteps?: number;
  /** Written by the test model (no Anthropic key), not by the agent's model. */
  testModel?: boolean;
  memoryEdits?: { itemId: string; kind: string; text: string }[];
  debate?: { debateId: string; title: string };
  debateSuggestion?: {
    agentIds: string[];
    debateId?: string | null;
    goal?: string;
    state?: "accepted" | "dismissed" | "pending";
    title: string;
  };
  assignmentPlan?: {
    assignmentId: string;
    environment: string | null;
    executor: string;
    goal: string;
    title: string;
  };
  assignmentDecision?: { assignmentId: string; decisionId: string };
  assignmentReview?: { assignmentId: string; reviewId: string };
  assignmentSubmission?: { assignmentId: string; submissionId: string };
  assignmentCommand?: { id: string; assignmentId: string; command: string; jobId: string; tool: string };
  assignmentReport?: { assignmentId: string; text: string };
  assignmentSuggestion?: { assignmentId: string; status?: "accepted" | "declined" | "pending"; text: string };
  assignmentLink?: { assignmentId: string };
  assignmentStart?: { assignmentId: string };
  /** Turn sent by the assignment engine (the agent works on an item; "" is the planning turn). */
  assignmentTurn?: { assignmentId: string; itemId: string; n: number };
  job?: { assignmentId?: string; jobId: string };
  delegation?: { agentId: string };
  /** The agent joined the conversation on its own (nobody called it: it came through `autoAnswer`). */
  joined?: boolean;
  workedIssue?: { issueId: string; number: number };
  claimedIssue?: { issueId: string; number: number };
  bodyTemplate?: string;
  templateVars?: Record<string, string | number>;
  /** Notice that the environment's Claude Code/Codex could not answer (`bodyTemplate` `harness.*`). */
  harnessUnavailable?: {
    agentId: string;
    code: string;
    harness: "claude_code" | "codex";
    resetsAt?: string | null;
    runnerId: string | null;
  };
  canceled?: boolean;
  interrupted?: boolean;
  reminder?: { reminderId: string };
  routine?: { name: string; routineId: string };
  /** Outside content pasted into the message (email, routine webhook): the run that reads it raises flag A with this source. */
  untrusted?: string;
  fromRoutine?: { name: string; routineId: string };
  isThreadRoot?: boolean;
  citedAgentIds?: string[];
  spawnsThread?: boolean;
  /** Feedback on an agent's answer (it becomes a lesson for the agent). */
  feedback?: { agentId: string; messageId: string };
  /** Message posted by an agent and undone (action `message_posted`): the body is hidden on screen. */
  retracted?: { actorUserId: string; at: string };
  [key: string]: unknown;
}

export interface Message {
  id: string;
  /** Agent actions that came from this message (undo). */
  actions: AgentAction[];
  agentMentionIds: string[];
  author: ActorRef;
  body: string;
  channelId: string;
  clientId: string | null;
  createdAt: string;
  editedAt: string | null;
  /** Client only: optimistic send. */
  local?: "failed" | "pending";
  memories: MessageMemory[];
  meta: MessageMeta;
  reactions: ReactionCount[];
  receipts: MessageReceipts;
  replyCount: number;
  runId: string | null;
  threadId: string | null;
  usage: MessageUsage | null;
}

export interface MessagesQuery {
  before?: string;
  limit?: number;
  threadId?: string;
}

export interface MessagePin {
  channelId: string;
  message: Message;
  messageId: string;
  pinnedAt: string;
  pinnedBy: string;
}

export type ThreadState = "archived" | "closed" | "open";

export interface ThreadInfo {
  id: string;
  actionNeeded: boolean;
  assignment: ThreadAssignmentInfo | null;
  channelId: string;
  channelName: string;
  context: {
    channelId: string;
    count: number;
    lastMessageId: string | null;
    moved: boolean;
    omittedMessageIds: string[];
    rootMessageId: string | null;
  };
  createdBy: ActorRef;
  firstReplyAt: string | null;
  following: boolean;
  lastMessage: { author: ActorRef; createdAt: string; excerpt: string } | null;
  lastTouchedAt: string;
  manageable: boolean;
  opener: ActorRef;
  openingText: string;
  participants: ActorRef[];
  replyCount: number;
  resolvedSuggestion: boolean;
  state: ThreadState;
  title: string;
  venue: "channel" | "dm";
  working: boolean;
}

export interface WorkingRun {
  agentId: string;
  channelId: string;
  runId: string;
  startedAt: string;
  status: string;
  threadId: string | null;
  what: string;
}
