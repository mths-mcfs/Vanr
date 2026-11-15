// The workspace calendar: events (single or in a series), time proposals the agents make and the
// expansion of the series over the requested range. A split series ("this and the following") becomes two
// rows; an occurrence changed on its own becomes a separate event and leaves the series through `exdates`.
import type { ActorRef, CalendarEvent, CalendarProposal, RecurrenceRule } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { localParts, occurrences, zonedTime } from "@vanr/engine/recurrence";
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { AppDeps, WorkspaceMember } from "./context";
import { notFound } from "./http";

const { calendarEntries, calendarProposals } = schema;
export type EventRow = typeof calendarEntries.$inferSelect;
export type ProposalRow = typeof calendarProposals.$inferSelect;

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (at: Date, tz: string) => {
  const p = localParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};

export const ruleOf = (row: EventRow) => (row.rule as RecurrenceRule | null) ?? null;

/** The series rule anchored at the event's start (the time comes from the event itself). */
function seriesRule(row: EventRow): RecurrenceRule | null {
  const rule = ruleOf(row);
  if (!rule) return null;
  const { times: _t, ...rest } = rule;
  return { ...rest, timezone: rule.timezone || row.timezone, start: row.start.toISOString() };
}

const daySpan = (row: EventRow) =>
  (Date.parse(localDate(row.end, row.timezone)) - Date.parse(localDate(row.start, row.timezone))) /
  86_400_000;
const shiftDays = (at: Date, days: number, tz: string) => {
  const p = localParts(at, tz);
  return zonedTime({ y: p.y, m: p.m, d: p.d + days }, 0, 0, tz);
};
const eventEnd = (row: EventRow, start: Date) =>
  row.allDay
    ? shiftDays(start, daySpan(row), row.timezone)
    : new Date(start.getTime() + row.end.getTime() - row.start.getTime());

export function toEvent(row: EventRow, occurrence?: Date): CalendarEvent {
  const start = occurrence ?? row.start;
  const end = eventEnd(row, start);
  const rule = ruleOf(row);
  return {
    id: row.id,
    title: row.title,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: row.allDay,
    startDate: row.allDay ? localDate(start, row.timezone) : null,
    // All day: the end is inclusive (the event's last day).
    endDate: row.allDay ? localDate(new Date(end.getTime() - 1), row.timezone) : null,
    timezone: row.timezone,
    rule,
    recurrence: rule ? rule.freq : null,
    seriesId: rule ? row.id : row.seriesId,
    instanceStart: rule ? start.toISOString() : null,
    participants: row.participants,
    createdBy: row.createdBy,
    location: row.location,
    description: row.description,
  };
}

/** Occurrences of the event that touch the range [from, to). */
export function expand(row: EventRow, from: Date, to: Date): CalendarEvent[] {
  const duration = row.end.getTime() - row.start.getTime();
  const rule = seriesRule(row);
  if (!rule) return row.end > from && row.start < to ? [toEvent(row)] : [];
  const skip = new Set(row.exdates);
  const since = row.allDay
    ? shiftDays(from, -daySpan(row), row.timezone)
    : new Date(from.getTime() - duration);
  return occurrences(rule, { from: since, to, limit: 500 })
    .filter((at) => !skip.has(at.toISOString()) && eventEnd(row, at) > from)
    .map((at) => toEvent(row, at));
}

/** Who sees it: the creator and the participants; an event without participants belongs to the whole workspace. */
function canSeeEvent(row: EventRow, me: WorkspaceMember): boolean {
  if (row.createdBy.type === "person" && row.createdBy.id === me.userId) return true;
  const people = row.participants.filter((p) => p.type === "person");
  return people.length === 0 || people.some((p) => p.id === me.userId);
}

function visibleEventsSql(me: WorkspaceMember) {
  const mine = JSON.stringify([{ type: "person", id: me.userId }]);
  return or(
    sql`${calendarEntries.createdBy} @> ${JSON.stringify({ type: "person", id: me.userId })}::jsonb`,
    sql`${calendarEntries.participants} @> ${mine}::jsonb`,
    sql`not (${calendarEntries.participants} @> '[{"type":"person"}]'::jsonb)`,
  );
}

/** Events that may fall in the range: the single ones that touch it and every series already started. */
export async function eventsInRange(db: Db, me: WorkspaceMember, from: Date, to: Date): Promise<EventRow[]> {
  return db
    .select()
    .from(calendarEntries)
    .where(
      and(
        eq(calendarEntries.workspaceId, me.workspaceId),
        visibleEventsSql(me),
        lt(calendarEntries.start, to),
        or(sql`${calendarEntries.rule} is not null`, gte(calendarEntries.end, from)),
      ),
    );
}

export async function eventFor(db: Db, me: WorkspaceMember, id: string): Promise<EventRow> {
  const [row] = await db
    .select()
    .from(calendarEntries)
    .where(and(eq(calendarEntries.id, id), eq(calendarEntries.workspaceId, me.workspaceId)));
  if (!row || !canSeeEvent(row, me)) throw notFound("Event not found");
  return row;
}

export function toProposal(row: ProposalRow): CalendarProposal {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    start: row.start.toISOString(),
    end: row.end.toISOString(),
    participants: row.participants,
    note: row.note,
  };
}

/** Who the event changes for: creator and participants (people); without participants, the whole workspace. */
function audience(row: EventRow): string[] | null {
  const people = row.participants.filter((p) => p.type === "person").map((p) => p.id);
  if (people.length === 0) return null;
  if (row.createdBy.type === "person") people.push(row.createdBy.id);
  return [...new Set(people)];
}

export function publishEvent(deps: AppDeps, row: EventRow) {
  const event = { type: "calendar_event.saved", eventId: row.id, event: toEvent(row) };
  const users = audience(row);
  if (!users) deps.hub.toWorkspace(row.workspaceId, event);
  else for (const u of users) deps.hub.toUser(row.workspaceId, u, event);
}

export function publishDeleted(deps: AppDeps, row: EventRow, scope: string, instanceStart: string | null) {
  const event = { type: "calendar_event.removed", eventId: row.id, scope, instanceStart };
  const users = audience(row);
  if (!users) deps.hub.toWorkspace(row.workspaceId, event);
  else for (const u of users) deps.hub.toUser(row.workspaceId, u, event);
}

export const isPersonIn = (list: ActorRef[], userId: string) =>
  list.some((p) => p.type === "person" && p.id === userId);
