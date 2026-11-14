// Notifications, inbox rules and push and email settings.

import type { WorkStateName } from "./assignments.ts";
import type { ActorRef } from "./common.ts";

export type NotificationKind =
  | "approval"
  | "assignment_finished"
  | "assignment_stopped"
  | "browser_intervention"
  | "debate_synthesis"
  | "debate_turn"
  | "dm"
  | "issue_discussion"
  | "issue_ownership"
  | "issue_progress"
  | "mention"
  | "question_for_you"
  | "reaction"
  | "routine_alert"
  | "routine_report"
  | "runner_connected"
  | "thread_followup";

export type NotificationFilter =
  | "action_needed"
  | "all"
  | "fyi"
  | "mentions"
  | "reactions"
  | "unread"
  | "waiting";

/** Inbox tab: "Action needed" (open request, DM, mention) or "FYI" (everything else). */
export type NotificationTab = "action_needed" | "fyi";

/** Reason for the notice, shown on the row ("asked for approval", "mentioned you", "failed"). */
export type NotificationReason =
  | "agent_failed"
  | "approval_requested"
  | "assigned"
  | "assignment_finished"
  | "assignment_stopped"
  | "browser_intervention"
  | "commented"
  | "dm"
  | "join_requested"
  | "mentioned"
  | "question_raised"
  | "reacted"
  | "reminder"
  | "review_requested"
  | "routine_alert"
  | "routine_report"
  | "runner_connected"
  | "secret_prompt"
  | "status_changed"
  | "synthesis_ready"
  | "thread_followup"
  | "turn_requested";

/** Priority requested by the notifier. `critical` breaks through quiet hours. */
export type NotificationPriority = "action_needed" | "critical" | "fyi";

/**
 * The person's rule: what matches (kind, channel, agent; empty matches everything) goes to the chosen tab.
 * The first match wins. An open request (`waiting`) always stays in "Action needed".
 */
export interface NotificationRule {
  id: string;
  agentId?: string;
  channelId?: string;
  kind?: NotificationKind;
  tab: NotificationTab;
}

/** Turns push and email on or off per kind or per channel (empty: the default applies). */
export interface NotifyToggle {
  email?: boolean;
  push?: boolean;
}

export interface NotificationSettings {
  channels: Record<string, NotifyToggle>;
  /** Do not disturb until this time (ISO), or off. */
  dndUntil: string | null;
  /** "Waiting on you" email (open request the person has not seen). */
  email: boolean;
  /** How long a request waits unseen before the email. */
  emailDelayMinutes: number;
  kinds: Partial<Record<NotificationKind, NotifyToggle>>;
  /** Language of the emails. */
  locale: "en" | "pt-BR";
  /** Push on this and other subscribed devices ("Action needed"). */
  push: boolean;
  /** Daily quiet hours, in the person's time zone for the workspace. `start` == `end` turns it off. */
  quietHours: { enabled: boolean; end: string; start: string };
  rules: NotificationRule[];
}

export interface AppNotification {
  id: string;
  actors: ActorRef[];
  count: number;
  createdAt: string;
  /** Breaks through quiet hours (approval, direct question, agent failure). */
  critical: boolean;
  doneAt: string | null;
  kind: NotificationKind;
  latest: {
    emojis?: string[];
    expiresAt?: string;
    newStatus?: string;
    previousStatus?: string;
    quote?: string;
    round?: number;
    rounds?: number;
    steps?: number;
    suggestions?: string[];
    text?: string;
    title?: string;
  };
  mutedUntil: string | null;
  readAt: string | null;
  reason: NotificationReason;
  /** Reminder: comes back to the top at this time, without disappearing before (unlike snooze). */
  remindAt: string | null;
  /** The person's rule that put the notice in this tab (null: default rule). */
  ruleId: string | null;
  /** Saved by the person: excluded from the 3-month retention. */
  savedAt: string | null;
  source: {
    approvalId?: string;
    assignmentId?: string;
    channelId?: string;
    debateId?: string;
    dmId?: string;
    interventionId?: string;
    issueId?: string;
    issueSeq?: number;
    label?: string;
    messageId?: string;
    /** Hash of the approval's effect: approving from the notification sends this hash (`approveApproval`). */
    payloadHash?: string;
    questionId?: string;
    routineId?: string;
    runnerId?: string;
    threadId?: string;
  };
  /** Tab the notice is in, with the person's rules already applied. */
  tab: NotificationTab;
  updatedAt: string;
  waiting: boolean;
  /** Work state behind the notice, when there is one. */
  workState: WorkStateName | null;
}

export interface NotificationCounts {
  /** "Action needed" tab: open and unread requests (what asks for action). */
  actionNeeded: number;
  all: number;
  /**
   * Sidebar badge: "Action needed" items that are waiting or unread, excluding approvals and assignment
   * requests, which have their own badge.
   */
  badge: number;
  /** "FYI" tab: unread. */
  fyi: number;
  mentions: number;
  reactions: number;
  unread: number;
  waiting: number;
}
