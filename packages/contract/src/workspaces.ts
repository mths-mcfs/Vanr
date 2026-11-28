// Workspace, people and invitations. Dates are ISO 8601.

export type Role = "admin" | "member" | "owner";

export interface User {
  id: string;
  email: string;
  image: string | null;
  name: string;
}

export interface WorkspaceSummary {
  id: string;
  logo: string | null;
  name: string;
  role: Role;
}

export interface Me {
  user: User;
  workspaces: WorkspaceSummary[];
}

export interface Workspace {
  id: string;
  context: string;
  logo: string | null;
  name: string;
}

export interface WorkspaceSettings {
  agentBudgetDefaultUsd: number;
  /**
   * Model reviewer for approvals: decides risk-flagged requests between K1 and K2 reading only what the
   * person wrote; K3 and workspace rules stay with the person. Off by default.
   */
  approvalReviewer: boolean;
  context: string;
  name: string;
  primaryCredentialId: string | null;
  timezone: string;
}

export interface WorkspaceOverview {
  agents: number;
  /** The month's spend against the budget, in percent: null for whoever can't `view_usage`. */
  budgetSpentPct: number | null;
  myApprovalQueue: number;
  people: number;
}

export interface Member {
  avatarUrl: string | null;
  email: string;
  handle: string;
  image: string | null;
  name: string;
  role: Role;
  timezone: string | null;
  userId: string;
}

export interface Person {
  avatarUrl: string | null;
  email: string;
  handle: string;
  image: string | null;
  lastOnlineAt: string | null;
  memberSince: string;
  name: string;
  online: boolean;
  role: Role;
  timezone: string | null;
  userId: string;
}

export interface Invitation {
  id: string;
  createdAt: string;
  /** null for invitations by link. */
  email: string | null;
  expiresAt: string;
  invitedBy: string | null;
  role: Role;
}

export type InvitationStatus = "accepted" | "expired" | "pending" | "revoked";

export interface InvitationWithStatus extends Invitation {
  status: InvitationStatus;
}

export interface InvitationPreview {
  email: string | null;
  expiresAt: string;
  invitedByName: string | null;
  role: Role;
  workspaceId: string;
  workspaceName: string;
}

export type BatchInviteStatus = "already_invited" | "already_member" | "bad_email" | "invited";

export interface BatchInviteResult {
  email: string;
  status: BatchInviteStatus;
  url?: string;
}

export interface UsageReport {
  agents: {
    agentId: string;
    budgetInherited: boolean;
    budgetPerMonthUsd: number;
    budgetSpentPct: number;
    costUsd: number;
    name: string;
  }[];
  /**
   * The month's budget as the cap counts it, whatever `since` asks: its limit, the spend it counts (an anonymous
   * debate's runs in, the platform's embeddings out) and whether the next call would be refused.
   */
  budget: { capUsd: number; countedUsd: number; exhausted: boolean };
  perKind: { calls: number; costUsd: number; kind: string }[];
  since: string;
  spendUsd: number;
}
