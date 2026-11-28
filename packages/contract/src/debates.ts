// Debates: rounds between agents and people, with blind posts, synthesis and verdict.

import type { ActorRef } from "./common.ts";

export type DebateStatus = "canceled" | "done" | "open" | "stalled";

export type DebateFormat = "decision" | "plan";

export interface DebateSpeaker {
  id: string;
  type: "agent" | "person";
}

export interface Debate {
  id: string;
  agentIds: string[];
  /** true while the debate is open: agent posts show only the pseudonym. */
  anonymous: boolean;
  awaitedUserId: string | null;
  channelId: string | null;
  createdAt: string;
  createdBy: ActorRef;
  deadline: string | null;
  endReason: DebateEndReason | null;
  engagedAgentIds: string[];
  format: DebateFormat;
  goal: string;
  leadAgentId: string | null;
  leadUserId: string | null;
  /** Answer options (empty = free text). */
  options: string[];
  origin: {
    agentId?: string;
    channelId?: string;
    issueSeq?: number;
    kind: "issue" | "manual" | "routine" | "suggestion";
  } | null;
  phase: "concluding" | "debating" | "human_turn" | null;
  /** Pseudonym of each agent, only after it is revealed. */
  pseudonyms: Record<string, string> | null;
  requesterUserId: string | null;
  round: number;
  roundLimit: number;
  speakers: DebateSpeaker[];
  spendCapPercent: number | null;
  spendCapUsd: number | null;
  stallInfo: { agentId: string; reason: string; round: number } | null;
  status: DebateStatus;
  title: string;
  updatedAt: string;
  userIds: string[];
  verdictState: DebateVerdict | null;
  /** People who still owe their position in this round (rounds run in parallel). */
  waitingUserIds: string[];
}

/** A participant's position in a round. Confidence is shown, it does not weight the vote. */
export interface DebateClaim {
  answer: string;
  changed: boolean;
  confidence: number | null;
  evidence: string[];
  key: string;
  reason: string;
}

export interface DebatePost {
  id: string;
  /** null while the debate is open and the post is an agent's: only the `pseudonym` shows. */
  author: ActorRef | null;
  body: string;
  claimData: DebateClaim | null;
  createdAt: string;
  kind: "comment" | "free" | "out_of_budget" | "speaker" | "synthesis" | "turn";
  meta: Record<string, unknown>;
  /** The agent's pseudonym in the debate (A, B...). */
  pseudonym: string | null;
  replyTo: string | null;
  round: number;
  runId: string | null;
  wantsExtraRound: boolean;
}

export interface DebateMajorityGroup {
  answer: string;
  count: number;
  key: string;
  meanConfidence: number | null;
  /** Pseudonyms (or ids, once revealed) of who is in the group. */
  members: string[];
}

export interface DebateMajority {
  groups: DebateMajorityGroup[];
  tie: boolean;
  total: number;
  unanimous: boolean;
  winner: string | null;
  winnerKey: string | null;
}

export type DebateEndReason = "budget" | "concluded" | "deadline" | "max_rounds" | "no_change" | "unanimous";

export interface DebateDisagreement {
  point: string;
  sides: { mustProve: string; position: string }[];
}

export interface DebateSynthesis {
  /** Majority in round 0 (baseline) and in the last round. */
  baseline?: DebateMajority | null;
  endReason?: DebateEndReason | null;
  /** `budget`: the cap ran out and the synthesis came from the majority, without a model. */
  fallback?: "budget" | null;
  final?: DebateMajority | null;
  format: DebateFormat;
  revision: number;
  structured: {
    agreements?: string[];
    decision?: string;
    disagreements?: DebateDisagreement[];
    dissent?: string[];
    items?: { owner?: string; step?: string; title: string }[];
    summary: string;
  };
}

export interface DebateRoundView {
  /** Simple majority of the agents in the round (closed rounds only). */
  majority: DebateMajority | null;
  posts: string[];
  round: number;
}

export interface DebateVerdict {
  acceptedAt: string;
  endorsedBy: string;
  revertedAt?: string;
  revertedBy?: string;
  state: "accepted" | "reverted";
}

export interface DebateDetail extends Debate {
  issues: { id: string; number: number; title: string }[];
  posts: DebatePost[];
  /** Posts already submitted in the current round (hidden until everyone answers). */
  sealedCount: number;
  /** Debate spend so far (USD); null without view_usage. */
  spentUsd: number | null;
  synthesis: DebateSynthesis | null;
  track: { roundLimit: DebateRoundView[]; synthesis: string | null };
}

export interface DebateMetrics {
  /** Debates with a verdict accepted / reverted within 30 days of acceptance. */
  accepted: number;
  blindReviews: { debate: number; single: number; tie: number };
  challenged: number;
  /** Share of debates with a challenge round in which some position changed (theater alarm if low). */
  changedDebates: number;
  days: number;
  endReasons: Partial<Record<DebateEndReason, number>>;
  /** Mean cost per concluded debate (USD); null without view_usage. */
  meanCostUsd: number | null;
  reverted30: number;
  settled: number;
  /** Few position changes across many debates: cut down to round 0 + synthesis. */
  theater: boolean;
}

export interface DebateSuggestion {
  agentIds: string[];
  debateId: string | null;
  goal: string;
  messageId: string;
  proposerAgentId: string;
  state: "accepted" | "dismissed" | "pending";
  title: string;
}

/**
 * Cost of opening a debate: `upToUsd` is the cap, the sum of what each call can reserve (every agent turn
 * and the synthesis, with the conversation at its maximum size). The real cost never exceeds it.
 */
export interface DebateEstimate {
  calls: number;
  upToUsd: number;
}

/** Body of opening a debate. `rounds`: challenge rounds after round 0 (0 = a vote). */
export interface CreateDebateBody {
  agentIds: string[];
  channelId?: string;
  deadline?: string;
  format?: DebateFormat;
  goal: string;
  options?: string[];
  rounds?: number;
  sourceIssueId?: string;
  speakers?: DebateSpeaker[];
  /** The debate's cap in % of the monthly budget of the cheapest agent at the table. */
  spendCapPercent?: number;
  title: string;
  userIds?: string[];
}

/** A post: the position of a person at the table on their turn, otherwise a comment. */
export interface DebatePostBody {
  /** The person's answer in the round (when they hold a speaker slot). */
  answer?: string;
  body: string;
  confidence?: number;
  replyTo?: string;
  wantsExtraRound?: boolean;
}

export interface DebateParticipantsBody {
  addSpeakerUserIds?: string[];
  agentsToAdd?: string[];
  agentsToRemove?: string[];
  peopleToAdd?: string[];
  peopleToRemove?: string[];
  removeSpeakerUserIds?: string[];
}

/** An item of the synthesis that becomes an issue. */
export interface DebateIssueItem {
  description?: string;
  owner?: string;
  step?: string;
  title: string;
}

export interface DebateIssuesBody {
  items: DebateIssueItem[];
}

export interface DebateIssuesResult {
  issues: { id: string; number: number; title: string }[];
  numbers: number[];
}

export interface DebateVerdictBody {
  action: "accept" | "revert";
}

/** Blind read: the synthesis against a single agent's answer, in an order drawn once per person. */
export interface DebateBlindReview {
  a: string;
  b: string;
  pick: "a" | "b" | "tie" | null;
}

export interface DebateReviewPickBody {
  pick: "a" | "b" | "tie";
}

/** What the person changes in a suggestion before opening it. */
export interface DebateSuggestionOverrides {
  agentIds?: string[];
  goal?: string;
  rounds?: number;
  title?: string;
}

export interface AcceptedDebateSuggestion {
  debate: DebateDetail;
  suggestion: DebateSuggestion;
}
