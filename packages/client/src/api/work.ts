// Routines, the calendar, issues, notifications and Web Push.
import type * as T from "@vanr/contract";
import * as C from "../contract-schemas.ts";
import { endpoint as e, NOTHING } from "../endpoint.ts";
import * as s from "../schema.ts";
import { NotificationPage, RoutineWebhookSecret } from "./shapes.ts";

export interface CalendarEventBody {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  timezone?: string;
  rule?: T.RecurrenceRule | null;
  participants?: T.ActorRef[];
  location?: string | null;
  description?: string | null;
}

/** Which part of a recurring series a change applies to. */
export interface SeriesScope {
  scope?: "all" | "following" | "this";
  /** The occurrence the change starts at (for `this` and `following`). */
  instanceStart?: string;
}

export interface CreateIssueBody {
  title: string;
  description?: string;
  criteria?: string[];
  assignee?: T.ActorRef | null;
  priority?: T.IssuePriority;
  dueDate?: string | null;
  labels?: string[];
  columnId?: string;
  channelId?: string;
}

const Columns = s.field("columns", s.array(C.IssueColumn));

export const work = {
  listRoutines: e("GET", "/api/v1/workspaces/:workspaceId/routines", s.field("routines", s.array(C.Routine))),
  createRoutine: e("POST", "/api/v1/workspaces/:workspaceId/routines", C.Routine).body<T.RoutineInput>(),
  updateRoutine: e("PATCH", "/api/v1/workspaces/:workspaceId/routines/:routineId", C.Routine).body<
    Partial<T.RoutineInput>
  >(),
  setRoutineEnabled: e("PATCH", "/api/v1/workspaces/:workspaceId/routines/:routineId", C.Routine).body<{
    active: boolean;
  }>(),
  deleteRoutine: e("DELETE", "/api/v1/workspaces/:workspaceId/routines/:routineId", NOTHING),
  duplicateRoutine: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/routines/:routineId/duplicate",
    C.Routine,
  ).body<{
    name?: string;
  }>(),
  /** `key` is chosen by the client: the same click sent twice runs once. */
  runRoutine: e("POST", "/api/v1/workspaces/:workspaceId/routines/:routineId/run", C.Routine).body<{
    key?: string;
  }>(),
  estimateRoutine: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/routines/:routineId/estimate",
    C.RoutineEstimate,
  ),
  listRoutineRuns: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/routines/:routineId/runs",
    s.field("runs", s.array(C.RoutineRun)),
  ),
  /** Makes (or replaces) the webhook secret; it is only ever shown in this answer. */
  createRoutineWebhookSecret: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/routines/:routineId/webhook-secret",
    RoutineWebhookSecret,
  ),
  parseRoutineSchedule: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/routines/parse-schedule",
    C.ScheduleParse,
  ).body<{ phrase: string; timezone: string }>(),
  parseRoutineRule: e("POST", "/api/v1/workspaces/:workspaceId/routines/parse-rule", C.RuleInfo).body<{
    phrase: string;
    timezone?: string;
  }>(),
  describeRoutineRule: e("POST", "/api/v1/workspaces/:workspaceId/routines/describe-rule", C.RuleInfo).body<{
    rule: T.RecurrenceRule;
  }>(),

  getCalendar: e("GET", "/api/v1/workspaces/:workspaceId/calendar", C.CalendarRange).query<{
    from: string;
    to: string;
  }>(),
  createCalendarEvent: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/calendar/events",
    C.CalendarEvent,
  ).body<CalendarEventBody>(),
  updateCalendarEvent: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/calendar/events/:eventId",
    C.CalendarEvent,
  ).body<Partial<CalendarEventBody> & SeriesScope>(),
  deleteCalendarEvent: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/calendar/events/:eventId",
    NOTHING,
  ).query<SeriesScope>(),
  confirmCalendarProposal: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/calendar/proposals/:proposalId/confirm",
    C.CalendarEvent,
  ),
  dismissCalendarProposal: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/calendar/proposals/:proposalId/dismiss",
    NOTHING,
  ),

  listIssues: e("GET", "/api/v1/workspaces/:workspaceId/issues", s.field("issues", s.array(C.Issue))).query<{
    q?: string;
  }>(),
  getIssueBySeq: e("GET", "/api/v1/workspaces/:workspaceId/issues/seq/:issueSeq", C.Issue),
  createIssue: e("POST", "/api/v1/workspaces/:workspaceId/issues", C.Issue).body<CreateIssueBody>(),
  updateIssue: e("PATCH", "/api/v1/workspaces/:workspaceId/issues/:issueId", C.Issue).body<
    Partial<Omit<CreateIssueBody, "channelId" | "criteria">> & { boardPosition?: number }
  >(),
  replaceIssueCriterion: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/issues/:issueId/criteria/:criterionId",
    C.Issue,
  ).body<{ done: boolean }>(),
  getIssueActivity: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/issues/:issueId/activity",
    s.field("activity", s.array(C.IssueActivity)),
  ),
  createIssueComment: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/issues/:issueId/comments",
    C.IssueActivity,
  ).body<{ text: string; attachedFileIds?: string[] }>(),
  askIssueAgent: e("POST", "/api/v1/workspaces/:workspaceId/issues/:issueId/ask-agent", C.Issue).body<{
    agentId: string;
  }>(),
  listIssueColumns: e("GET", "/api/v1/workspaces/:workspaceId/issue-columns", Columns),
  createIssueColumn: e("POST", "/api/v1/workspaces/:workspaceId/issue-columns", Columns).body<{
    name: string;
    stage: T.IssueStage;
    afterId?: string;
  }>(),
  updateIssueColumn: e(
    "PATCH",
    "/api/v1/workspaces/:workspaceId/issue-columns/:issueColumnId",
    Columns,
  ).body<{
    name?: string;
    index?: number;
  }>(),
  /** The column's issues move to `moveTo`. */
  deleteIssueColumn: e(
    "DELETE",
    "/api/v1/workspaces/:workspaceId/issue-columns/:issueColumnId",
    Columns,
  ).query<{ moveTo: string }>(),

  listNotifications: e("GET", "/api/v1/workspaces/:workspaceId/notifications", NotificationPage).query<{
    filter?: T.NotificationFilter;
    cursor?: string;
    limit?: number;
  }>(),
  listNotificationCounts: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/notifications/counts",
    C.NotificationCounts,
  ),
  markNotificationRead: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/read",
    C.AppNotification,
  ).body<{ read: boolean }>(),
  completeNotification: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/complete",
    C.AppNotification,
  ).body<{ done: boolean }>(),
  snoozeNotification: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/snooze",
    C.AppNotification,
  ).body<{ until: string | null }>(),
  saveNotification: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/save",
    C.AppNotification,
  ).body<{ saved: boolean }>(),
  /** The notification stays and comes back to the top at `at` (null clears it). */
  remindNotification: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/remind",
    C.AppNotification,
  ).body<{ at: string | null }>(),
  markNotificationAllRead: e(
    "POST",
    "/api/v1/workspaces/:workspaceId/notifications/read-all",
    s.object({ ids: s.array(s.string) }),
  ).body<{ filter?: T.NotificationFilter }>(),
  getNotificationSettings: e(
    "GET",
    "/api/v1/workspaces/:workspaceId/notifications/settings",
    C.NotificationSettings,
  ),
  setNotificationSettings: e(
    "PUT",
    "/api/v1/workspaces/:workspaceId/notifications/settings",
    C.NotificationSettings,
  ).body<T.NotificationSettings>(),

  getPushKey: e("GET", "/api/v1/push/key", s.object({ publicKey: s.string })),
  createPushSubscription: e("POST", "/api/v1/push/subscriptions", s.object({ id: s.string })).body<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }>(),
  clearPushSubscriptions: e("DELETE", "/api/v1/push/subscriptions", s.object({ removed: s.number })).query<{
    endpoint: string;
  }>(),
};
