// Calendar events and proposals.

import type { ActorRef } from "./common.ts";
import type { RecurrenceRule, RoutineTarget } from "./routines.ts";

export interface CalendarEvent {
  id: string;
  allDay: boolean;
  createdBy: ActorRef;
  description: string | null;
  end: string;
  endDate: string | null;
  instanceStart: string | null;
  location: string | null;
  participants: ActorRef[];
  recurrence: string | null;
  rule: RecurrenceRule | null;
  seriesId: string | null;
  start: string;
  startDate: string | null;
  timezone: string;
  title: string;
}

export interface CalendarProposal {
  id: string;
  agentId: string;
  end: string;
  note: string | null;
  participants: ActorRef[];
  start: string;
  title: string;
}

export interface CalendarRange {
  dueItems: { date: string; issueId: string; number: number; title: string }[];
  events: CalendarEvent[];
  proposals: CalendarProposal[];
  routines: { agentId: string; at: string; name: string; routineId: string; target: RoutineTarget }[];
}

/** Body of `createCalendarEvent`. */
export interface CalendarEventInput {
  allDay?: boolean;
  description?: string | null;
  end: string;
  location?: string | null;
  participants?: ActorRef[];
  rule?: RecurrenceRule | null;
  start: string;
  timezone?: string;
  title: string;
}

/** Which part of a series a change or a deletion reaches; `instanceStart` names the occurrence. */
export interface SeriesScope {
  instanceStart?: string;
  scope?: "all" | "following" | "this";
}

/** Body of `updateCalendarEvent`. */
export type CalendarEventPatch = Partial<CalendarEventInput> & SeriesScope;
