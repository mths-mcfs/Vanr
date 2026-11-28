// The inbox's rules that need no screen: where a notice leads, how the list is grouped by day, and
// the times "snooze" and "remind me" offer. Kept apart so they are tested without rendering.
import type { AppNotification, NotificationFilter } from "@vanr/contract";
import type { ParamsOf, RouteId } from "../../../routes.ts";

/** The address a notice opens, or undefined when it has none (it then stays in the inbox). */
export type Destination = { [Id in RouteId]: { route: Id; params: ParamsOf<Id> } }[RouteId];

export function destinationOf(notice: AppNotification, workspaceId: string): Destination | undefined {
  const source = notice.source;
  const actor = notice.actors[0];
  if (notice.kind === "approval" || source.approvalId !== undefined) {
    return { route: "approvals", params: { workspaceId } };
  }
  if (source.debateId !== undefined)
    return { route: "debate", params: { workspaceId, debateId: source.debateId } };
  if (source.issueSeq !== undefined) {
    return { route: "issue", params: { workspaceId, issueSeq: String(source.issueSeq) } };
  }
  if (source.assignmentId !== undefined) {
    return { route: "assignment", params: { workspaceId, assignmentId: source.assignmentId } };
  }
  if (source.routineId !== undefined) return { route: "routines", params: { workspaceId } };
  if (notice.kind === "dm" && actor !== undefined) {
    return actor.type === "agent"
      ? { route: "dmAgent", params: { workspaceId, agentId: actor.id } }
      : { route: "dmPerson", params: { workspaceId, userId: actor.id } };
  }
  if (source.threadId !== undefined)
    return { route: "thread", params: { workspaceId, threadId: source.threadId } };
  if (source.channelId !== undefined) {
    return { route: "channel", params: { workspaceId, channelId: source.channelId } };
  }
  // Without a conversation, what an agent asked for is on its page.
  if (actor?.type === "agent") return { route: "agent", params: { workspaceId, agentId: actor.id } };
  return undefined;
}

/**
 * The list's day sections, newest first. `daysBack` is how many calendar days before today a section starts,
 * at local midnight: "last7" starts six days back, so together with today and yesterday it spans seven days.
 * "earlier" takes everything older.
 */
export const NOTICE_DAYS = [
  { day: "today", daysBack: 0 },
  { day: "yesterday", daysBack: 1 },
  { day: "last7", daysBack: 6 },
  { day: "earlier", daysBack: null },
] as const;
export type NoticeDay = (typeof NOTICE_DAYS)[number]["day"];

/** Local midnight of the day `at` falls on. */
function startOfDay(at: number): Date {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** Local midnight `days` calendar days from the day `at` falls on (a 23- or 25-hour day counts as one). */
function dayStart(at: number, days: number): number {
  const day = startOfDay(at);
  day.setDate(day.getDate() + days);
  return day.getTime();
}

/** The day section a notice falls in, by when it last changed, in the browser's time zone. */
export function noticeDayOf(iso: string, now: number): NoticeDay {
  const at = Date.parse(iso);
  const section = NOTICE_DAYS.find(({ daysBack }) => daysBack === null || at >= dayStart(now, -daysBack));
  return section?.day ?? "earlier";
}

export type LaterOption = "hour" | "tomorrow" | "monday";

/** The three times offered: in an hour, tomorrow at 9:00 and next Monday at 9:00, local time. */
export function laterOptions(now: number): readonly { key: LaterOption; at: Date }[] {
  const tomorrow = startOfDay(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9);
  const monday = startOfDay(now);
  const today = monday.getDay();
  monday.setDate(monday.getDate() + ((8 - today) % 7 || 7));
  monday.setHours(9);
  return [
    { key: "hour", at: new Date(now + 3_600_000) },
    { key: "tomorrow", at: tomorrow },
    { key: "monday", at: monday },
  ];
}

/** The tabs. */
export const TABS = ["action_needed", "fyi", "all"] as const;
export type Tab = (typeof TABS)[number];

/** What the "All" tab can narrow to, in the order its chips show. */
export const ALL_TAB_FILTERS = [
  "all",
  "unread",
  "waiting",
  "mentions",
  "reactions",
] as const satisfies readonly NotificationFilter[];

export const tabOf = (filter: NotificationFilter): Tab =>
  filter === "action_needed" || filter === "fyi" ? filter : "all";

/** Pages joined in order; a notice that moved between pages, or came twice, appears once. */
export function joinPages(...pages: readonly (readonly AppNotification[])[]): AppNotification[] {
  const seen = new Set<string>();
  return pages.flat().filter((notice) => {
    if (seen.has(notice.id)) return false;
    seen.add(notice.id);
    return true;
  });
}
