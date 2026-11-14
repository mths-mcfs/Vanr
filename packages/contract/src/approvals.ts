// Approvals, proposals and questions: the human-in-the-loop gate.

export type ApprovalStatus = "approved" | "canceled" | "expired" | "pending" | "rejected";

/** Effect class: K0 reads, K1 writes inside and can be undone, K2 acts outside, K3 is irreversible. */
export type EffectClass = "K0" | "K1" | "K2" | "K3";

/** Why the gate asked for a person. */
export type GateReason =
  | "destination_not_allowed"
  | "irreversible"
  | "policy"
  | "rule_of_two"
  | "untrusted_public"
  | "untrusted_to_external";

/** Run risk flag with what raised it: A read outside content, B holds a secret or a login, C acts outside. */
export interface RiskReason {
  flag: "A" | "B" | "C";
  source: string;
}

/** The exact effect the person approves. */
export interface EffectPreview {
  /** The whole outgoing text (email body, message, command). */
  body?: string;
  /** Diff of what changes, when the proposal edits something that already exists. */
  diff?: string;
  /** Links in the text with their real destination. */
  links?: string[];
  /** Final recipients, already resolved. */
  recipients?: string[];
  title: string;
}

export interface Approval {
  id: string;
  agentId: string;
  appliedAt: string | null;
  channelId: string | null;
  connector: string | null;
  createdAt: string;
  decidable: boolean;
  decidedAt: string | null;
  deciderUserId: string | null;
  detail: string;
  /** Input fields that can be edited before approving. */
  editable: string[];
  /** The person edited before approving. */
  edited: boolean;
  /** Effect class; null for approvals older than the gate. */
  effect: EffectClass | null;
  expiresAt: string;
  /** Flags raised in the run, each with its reason. */
  flags: RiskReason[];
  gateReason: GateReason | null;
  /** Input that runs if approved (the editable fields come from here). */
  input: Record<string, unknown> | null;
  issue: { number: number; title: string } | null;
  linkedAccount: string | null;
  messageId: string | null;
  ownerUserId: string;
  params: Record<string, unknown>;
  /** Hash of the exact effect: approve and edit send the hash of the version the person saw. */
  payloadHash: string | null;
  preview: EffectPreview | null;
  reason: string | null;
  /**
   * What "Approve and remember" would cover (channel, account and recipients, exact command), for 30 days;
   * null = cannot be remembered (K3, risk-flagged request, run that read outside content).
   */
  rememberLabel: string | null;
  result: { ok: boolean; text: string } | null;
  runId: string | null;
  scope: string;
  status: ApprovalStatus;
  threadId: string | null;
  title: string;
  tool: string;
  /** `code` and `params` let the frontend render the step in the person's language; `text` is the fallback. */
  trail: ApprovalTrailEntry[];
  why: string;
}

/** Live "always allow" rule: agent + tool + predicate, for 30 days. */
export interface ApprovalRule {
  id: string;
  agentId: string;
  createdAt: string;
  createdByUserId: string | null;
  expiresAt: string;
  /** The predicate as text (channel, account and recipients, command). */
  label: string;
  lastUsedAt: string | null;
  tool: string;
  uses: number;
}

export interface ApprovalTrailEntry {
  at: string;
  code?:
    | "approved"
    | "canceled"
    | "edited"
    | "executed"
    | "expired"
    | "failed"
    | "rejected"
    | "remembered"
    | "requested"
    | "reviewed";
  params?: Record<string, string>;
  text: string;
}

export type ProposalTarget =
  | { agentId: string; kind: "agent_prompt" }
  | { kind: "workspace_context" }
  /** Workspace memory file (empty `before` = new file). */
  | { kind: "workspace_memory"; path: string };

export interface Proposal {
  id: string;
  /** Undo action for the accepted proposal (`undoAction`); null before acceptance. */
  actionId: string | null;
  after: string;
  agentId: string;
  before: string;
  /** The person can undo (or redo) now: whoever accepted, the lead or an admin, within the time limit. */
  canUndo: boolean;
  createdAt: string;
  decidable: boolean;
  decidedAt: string | null;
  decidedBy: string | null;
  evidence: string;
  stale: boolean;
  status: "accepted" | "pending" | "rejected";
  target: ProposalTarget;
  title: string;
  /** Created, accepted, rejected, undone, redone: each step with who and when. */
  trail: ProposalTrailEntry[];
  /** The accepted change was undone. */
  undone: boolean;
  why: string;
}

export interface ProposalTrailEntry {
  at: string;
  code?: "accepted" | "proposed" | "redone" | "rejected" | "undone";
  params?: Record<string, string>;
  text: string;
}

export interface AgentQuestion {
  id: string;
  agentId: string;
  answer: string | null;
  /** Only this person answers; null for a question with no person (routine). */
  askedUserId: string | null;
  channelId: string;
  choices: string[];
  createdAt: string;
  responderUserId: string | null;
  status: "answered" | "expired" | "open";
  text: string;
  threadId: string | null;
}

export type BlockedReason = "not_allowed" | "private_network" | "scheme" | "sensitive";
