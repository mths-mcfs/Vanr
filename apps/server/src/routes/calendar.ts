// Calendar: a range (the series expanded, the routines' times, the issues' due dates and the proposals), create,
// edit and delete with a series scope, and confirm or dismiss an agent's proposal.
import type {
  ActorRef,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarRange,
  RecurrenceRule,
  RoutineTarget,
} from "@vanr/contract";
import { can } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { isTimezone, occurrences } from "@vanr/engine/recurrence";
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import {
  clockTime,
  type EventRow,
  endAfterMove,
  eventEnd,
  eventFor,
  seriesRule as eventRule,
  eventsInRange,
  expand,
  isPersonIn,
  isSubDaily,
  localDate,
  publishDeleted,
  publishEvent,
  ruleOf,
  timesFit,
  toEvent,
  toProposal,
  wallTimes,
} from "../calendar";
import type { AppDeps, AppEnv, WorkspaceMember } from "../context";
import { forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { columnsOf, visibleIssuesSql } from "../issues";
import { log } from "../logger";
import {
  anchorOf,
  canSeeRoutine,
  checkRule,
  type RoutineRow,
  ruleSchema,
  seriesRule,
  targetOf,
  triggerOf,
} from "../routines";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { calendarEntries, calendarProposals, issues, routines, agents, members, workspaces } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Longest range one request expands. */
export const MAX_RANGE_DAYS = 400;
/** Times of one routine listed in a range at most. */
export const ROUTINE_TIMES_MAX = 200;

/**
 * The time of day and the anchor come from the event: a rule from the client never carries `times` or `start`
 * (see `seriesRule`), so the rule an event returns is the one its occurrences follow.
 */
const clientRule = ruleSchema.transform(({ times: _t, start: _s, ...rule }): RecurrenceRule => rule);
const actor = z.object({ type: z.enum(["person", "agent"]), id: z.string().min(1).max(64) }).strict();
const eventFields = {
  title: z.string().trim().min(1).max(200),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  allDay: z.boolean().optional(),
  timezone: z.string().max(64).optional(),
  rule: clientRule.nullable().optional(),
  participants: z.array(actor).max(50).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
};
const scopeFields = {
  scope: z.enum(["this", "following", "all"]).optional(),
  instanceStart: z.iso.datetime({ offset: true }).optional(),
};
export const createEventBody = z.object(eventFields).strict() satisfies z.ZodType<CalendarEventInput>;
export const updateEventBody = z
  .object({ ...eventFields, ...scopeFields })
  .partial()
  .strict() satisfies z.ZodType<CalendarEventPatch>;

async function checkParticipants(deps: AppDeps, workspaceId: string, list: ActorRef[]) {
  const people = [...new Set(list.filter((p) => p.type === "person").map((p) => p.id))];
  const bots = [...new Set(list.filter((p) => p.type === "agent").map((p) => p.id))];
  if (people.length) {
    const rows = await deps.db
      .select({ id: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, people)));
    if (rows.length !== people.length) throw notFound("Member not found");
  }
  if (bots.length) {
    const rows = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, bots), isNull(agents.archivedAt)));
    if (rows.length !== bots.length) throw notFound("Agent not found");
  }
}

function checkTimes(start: Date, end: Date) {
  if (end <= start)
    throw new HttpError(400, "calendar.end_before_start", "The event must end after it starts");
}

/** An all-day event ends on a later local day than it starts (midnight to midnight in its time zone). */
function checkAllDay(allDay: boolean, start: Date, end: Date, timezone: string) {
  if (allDay && localDate(end, timezone) <= localDate(start, timezone))
    throw new HttpError(400, "calendar.all_day_span", "An all-day event ends on a later day than it starts");
}

function checkSeriesRule(rule: RecurrenceRule | null | undefined, timezone: string) {
  if (rule) checkRule({ ...rule, timezone: rule.timezone || timezone });
}

/** The default time zone: the person's, otherwise the workspace's. */
async function defaultTimezone(deps: AppDeps, me: WorkspaceMember): Promise<string> {
  const [m] = await deps.db
    .select({ tz: members.timezone, workspaceTz: workspaces.timezone })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
  return m?.tz ?? m?.workspaceTz ?? "UTC";
}

function requireEditor(row: EventRow, me: WorkspaceMember) {
  const mine = row.createdBy.type === "person" && row.createdBy.id === me.userId;
  if (mine || isPersonIn(row.participants, me.userId) || can(me.role, "configure")) return;
  throw forbidden("Only who created the event, its participants or an admin can change it");
}

/**
 * Locks the other parts of the family that `where` selects and requires the right on each: a participant of one
 * part is not an editor of the parts they are not in.
 */
async function requireEditorOfParts(tx: Tx, where: SQL | undefined, me: WorkspaceMember) {
  const parts = await tx.select().from(calendarEntries).where(where).for("update");
  for (const part of parts) requireEditor(part, me);
}

const withoutTimes = ({ times: _t, ...rule }: RecurrenceRule): RecurrenceRule => rule;

/** Is the occurrence in the series (and not taken out of it)? */
function checkOccurrence(row: EventRow, instanceStart: string | undefined): Date {
  if (!instanceStart) throw new HttpError(400, "calendar.occurrence_required", "Say which occurrence");
  const at = new Date(instanceStart);
  const found = expand(row, at, new Date(at.getTime() + 1)).some((e) => e.start === at.toISOString());
  if (!found) throw notFound("Occurrence not found");
  return at;
}

/**
 * Locks every part of the event's family (the root and the rows pointing to it) in id order, before any other
 * lock of the write. Every write to a series takes it first and in that one order, so two writes from different
 * parts never hold one part each and wait for the other, and a split and an edit or delete of the whole family
 * run one after the other.
 */
async function lockFamily(tx: Tx, row: EventRow) {
  const root = row.seriesId ?? row.id;
  await tx
    .select({ id: calendarEntries.id })
    .from(calendarEntries)
    .where(
      and(
        eq(calendarEntries.workspaceId, row.workspaceId),
        or(eq(calendarEntries.id, root), eq(calendarEntries.seriesId, root)),
      ),
    )
    .orderBy(asc(calendarEntries.id))
    .for("update");
}

/**
 * The event read again under its row lock, in the transaction that changes it: two changes of one series at
 * once (two occurrences taken out, a split and an edit) each start from what the other left.
 */
async function lockedEvent(tx: Tx, row: EventRow): Promise<EventRow> {
  const [locked] = await tx
    .select()
    .from(calendarEntries)
    .where(and(eq(calendarEntries.id, row.id), eq(calendarEntries.workspaceId, row.workspaceId)))
    .for("update");
  if (!locked) throw notFound("Event not found");
  return locked;
}

/**
 * The routine's times in the range, as its schedule runs them, and its target. A routine whose saved trigger or
 * target can't be read is left out of the calendar (and logged) instead of failing the whole range.
 */
function routineTimes(r: RoutineRow, from: Date, to: Date): { times: Date[]; target: RoutineTarget } | null {
  let trigger: ReturnType<typeof triggerOf>;
  let target: RoutineTarget;
  try {
    trigger = triggerOf(r);
    target = targetOf(r);
  } catch {
    log.warn("calendar.routine_unreadable", { routineId: r.id });
    return null;
  }
  if (trigger.kind === "schedule") {
    const anchor = anchorOf(r);
    const times = occurrences(seriesRule(trigger.rule, anchor), {
      from,
      to,
      limit: ROUTINE_TIMES_MAX,
      anchor,
    });
    return { times, target };
  }
  if (trigger.kind === "once") {
    const at = new Date(trigger.at);
    return { times: at >= from && at < to ? [at] : [], target };
  }
  return { times: [], target };
}

/**
 * Changes an event or the part of its series `scope` names, in one transaction that takes the family's lock
 * first. `visible` is the event as the person sees it, already checked as theirs to edit.
 */
export async function editEvent(
  deps: AppDeps,
  me: WorkspaceMember,
  visible: EventRow,
  input: z.infer<typeof updateEventBody>,
): Promise<{ saved: EventRow[]; reply: EventRow }> {
  const { scope = "all", instanceStart, ...patch } = input;
  if (patch.timezone !== undefined && !isTimezone(patch.timezone))
    throw new HttpError(400, "rule.timezone", "Unknown time zone");
  if (patch.participants) await checkParticipants(deps, me.workspaceId, patch.participants);
  const at = deps.now();
  return deps.db.transaction(async (tx) => {
    await lockFamily(tx, visible);
    const row = await lockedEvent(tx, visible);
    // The right is checked again on the locked row: a participant removed meanwhile no longer edits.
    requireEditor(row, me);
    const timezone = patch.timezone ?? row.timezone;
    if (patch.rule) checkSeriesRule(patch.rule, timezone);
    const allDay = patch.allDay ?? row.allDay;
    const fields = (base: { start: Date; end: Date }) => {
      const start = patch.start ? new Date(patch.start) : base.start;
      const end = patch.end
        ? new Date(patch.end)
        : patch.start
          ? endAfterMove(base, start, allDay, timezone, row.timezone)
          : base.end;
      checkTimes(start, end);
      checkAllDay(allDay, start, end, timezone);
      return {
        title: patch.title ?? row.title,
        start,
        end,
        allDay,
        timezone,
        participants: patch.participants ?? row.participants,
        location: patch.location !== undefined ? patch.location : row.location,
        description: patch.description !== undefined ? patch.description : row.description,
        updatedAt: at,
      };
    };
    const series = ruleOf(row);
    // A new start or time zone gives the series its time of day again: a kept local time no longer applies. A new
    // time zone is the rule's too (the occurrences follow the rule's zone).
    const retimed = patch.start !== undefined || patch.timezone !== undefined;
    const retime = (rule: RecurrenceRule): RecurrenceRule => ({
      ...withoutTimes(rule),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
    });
    // A rule from the client never carries the local time the server keeps (`clientRule` drops it). While the
    // start and the time zone stay (the event's and the rule's), a new rule keeps that time: only the server sets it.
    const keepTimes = (rule: RecurrenceRule | null | undefined, times: string[] | undefined, start: Date) =>
      rule &&
      times?.length &&
      !retimed &&
      rule.timezone === (series?.timezone || row.timezone) &&
      timesFit(rule, times, start, rule.timezone)
        ? { ...rule, times }
        : rule;
    const resent = keepTimes(patch.rule, series?.times, row.start);
    const ruleChange =
      resent !== undefined
        ? { rule: resent }
        : series && (patch.timezone !== undefined || (series.times && retimed))
          ? { rule: retime(series) }
          : {};
    // What is the same across the family follows an edit of "all" or "this and the following" to the other
    // parts it reaches; the times stay with each part.
    const shared = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.participants !== undefined ? { participants: patch.participants } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    };
    const root = row.seriesId ?? row.id;
    const shareWith = async (parts: SQL | undefined) => {
      if (Object.keys(shared).length === 0) return [];
      await requireEditorOfParts(tx, parts, me);
      return tx
        .update(calendarEntries)
        .set({ ...shared, updatedAt: at })
        .where(parts)
        .returning();
    };
    const whole = async () => {
      const [updated] = await tx
        .update(calendarEntries)
        .set({ ...fields(row), ...ruleChange })
        .where(eq(calendarEntries.id, row.id))
        .returning();
      if (!updated) throw notFound("Event not found");
      return { saved: [updated], reply: updated };
    };
    if (!series) return whole();
    if (scope === "all") {
      // "All" is the whole family: the parts "this and the following" made and the occurrences edited on their
      // own point to the root.
      const others = await shareWith(
        and(
          eq(calendarEntries.workspaceId, row.workspaceId),
          or(eq(calendarEntries.seriesId, root), eq(calendarEntries.id, root)),
          ne(calendarEntries.id, row.id),
        ),
      );
      const edited = await whole();
      return { saved: [...edited.saved, ...others], reply: edited.reply };
    }

    const occ = checkOccurrence(row, instanceStart);
    const base = { start: occ, end: eventEnd(row, occ) };
    if (scope === "this") {
      // The occurrence becomes an event of its own and leaves the series. It points to the family's root (not
      // to the part it left), like the parts: so "all" and "this and the following" reach it too.
      const [single] = await tx
        .insert(calendarEntries)
        .values({
          id: newId("evt"),
          workspaceId: row.workspaceId,
          ...fields(base),
          rule: null,
          seriesId: row.seriesId ?? row.id,
          createdBy: row.createdBy,
          createdAt: at,
        })
        .returning();
      const [trimmed] = await tx
        .update(calendarEntries)
        .set({ exdates: [...row.exdates, occ.toISOString()], updatedAt: at })
        .where(eq(calendarEntries.id, row.id))
        .returning();
      if (!single || !trimmed) throw notFound("Event not found");
      return { saved: [trimmed, single], reply: single };
    }

    // "This and the following": the old series ends before the occurrence and another starts from it. The
    // parts already split off after it are in the following too.
    const later = await shareWith(
      and(
        eq(calendarEntries.workspaceId, row.workspaceId),
        or(eq(calendarEntries.seriesId, root), eq(calendarEntries.id, root)),
        gte(calendarEntries.start, occ),
        ne(calendarEntries.id, row.id),
      ),
    );
    if (occ.getTime() === row.start.getTime()) {
      const edited = await whole();
      return { saved: [...edited.saved, ...later], reply: edited.reply };
    }
    const [ended] = await tx
      .update(calendarEntries)
      .set({
        rule: { ...series, until: new Date(occ.getTime() - 1).toISOString() },
        exdates: row.exdates.filter((x) => x < occ.toISOString()),
        updatedAt: at,
      })
      .where(eq(calendarEntries.id, row.id))
      .returning();
    // A series with a count keeps its total: the continuation gets only the occurrences left after the ones
    // before the split (the ones taken out count too, as they did in the series). A new rule is the person's.
    const before = series.count
      ? occurrences(eventRule(row) ?? series, { from: row.start, to: occ, limit: series.count }).length
      : 0;
    // The continuation starts at the occurrence; when that one fell in a daylight saving gap (its clock time
    // differs from the series'), the rule keeps the series' local time so the later ones don't move.
    const times = wallTimes(row);
    const kept = retimed
      ? retime(series)
      : isSubDaily(series) ||
          (times.length === 1 && times[0] === clockTime(occ, series.timezone || row.timezone))
        ? series
        : { ...series, times };
    const nextRule =
      patch.rule !== undefined
        ? keepTimes(patch.rule, kept.times, occ)
        : series.count
          ? { ...kept, count: series.count - before }
          : kept;
    const [following] = await tx
      .insert(calendarEntries)
      .values({
        id: newId("evt"),
        workspaceId: row.workspaceId,
        ...fields(base),
        rule: nextRule,
        exdates: row.exdates.filter((x) => x >= occ.toISOString()),
        seriesId: row.seriesId ?? row.id,
        createdBy: row.createdBy,
        createdAt: at,
      })
      .returning();
    if (!ended || !following) throw notFound("Event not found");
    return { saved: [ended, following, ...later], reply: following };
  });
}

/** Deletes an event or the part of its series `scope` names, under the family's lock like `editEvent`. */
export async function deleteEvent(
  deps: AppDeps,
  me: WorkspaceMember,
  visible: EventRow,
  { scope = "all", instanceStart }: { scope?: "this" | "following" | "all"; instanceStart?: string },
): Promise<{ row: EventRow; scope: string; occurrence: string | null; gone: EventRow[] }> {
  const at = deps.now();
  return deps.db.transaction(async (tx) => {
    await lockFamily(tx, visible);
    const row = await lockedEvent(tx, visible);
    // The right is checked again on the locked row: a participant removed meanwhile no longer edits.
    requireEditor(row, me);
    const series = ruleOf(row);
    // The parts "this and the following" made point to the original in seriesId: the family is the root and
    // everything pointing to it, from whichever part is asked.
    const root = row.seriesId ?? row.id;
    // Without a rule it is a single event or an occurrence edited on its own: only it goes.
    if (!series) {
      await tx.delete(calendarEntries).where(eq(calendarEntries.id, row.id));
      return { row, scope: "all", occurrence: null, gone: [] };
    }
    if (scope === "all") {
      const family = and(
        eq(calendarEntries.workspaceId, row.workspaceId),
        or(eq(calendarEntries.seriesId, root), eq(calendarEntries.id, root)),
      );
      await requireEditorOfParts(tx, family, me);
      const gone = await tx.delete(calendarEntries).where(family).returning();
      return { row, scope: "all", occurrence: null, gone };
    }
    const occ = checkOccurrence(row, instanceStart);
    // The rest of the family from the occurrence on, by time: the root too, when a part moved before it.
    const later = and(
      eq(calendarEntries.workspaceId, row.workspaceId),
      or(eq(calendarEntries.seriesId, root), eq(calendarEntries.id, root)),
      gte(calendarEntries.start, occ),
      ne(calendarEntries.id, row.id),
    );
    if (scope === "following") await requireEditorOfParts(tx, later, me);
    let gone: EventRow[] = [];
    if (scope === "this") {
      await tx
        .update(calendarEntries)
        .set({ exdates: [...row.exdates, occ.toISOString()], updatedAt: at })
        .where(eq(calendarEntries.id, row.id));
    } else if (occ.getTime() === row.start.getTime()) {
      await tx.delete(calendarEntries).where(eq(calendarEntries.id, row.id));
      gone = await tx.delete(calendarEntries).where(later).returning();
    } else {
      await tx
        .update(calendarEntries)
        .set({ rule: { ...series, until: new Date(occ.getTime() - 1).toISOString() }, updatedAt: at })
        .where(eq(calendarEntries.id, row.id));
      gone = await tx.delete(calendarEntries).where(later).returning();
    }
    return { row, scope, occurrence: occ.toISOString(), gone };
  });
}

export function registerCalendar(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/calendar`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const q = readQuery(
      c,
      z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }),
    );
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000)
      throw new HttpError(400, "calendar.range", `Ask for up to ${MAX_RANGE_DAYS} days`);

    const events = (await eventsInRange(deps.db, me, from, to)).flatMap((row) => expand(row, from, to));
    events.sort((a, b) => a.start.localeCompare(b.start));

    const range: CalendarRange["routines"] = [];
    const active = await deps.db
      .select()
      .from(routines)
      .where(and(eq(routines.workspaceId, me.workspaceId), eq(routines.active, true)));
    for (const r of active) {
      const found = routineTimes(r, from, to);
      if (!found || !(await canSeeRoutine(deps, me, r))) continue;
      for (const at of found.times)
        range.push({
          routineId: r.id,
          name: r.name,
          at: at.toISOString(),
          agentId: r.agentId,
          target: found.target,
        });
    }

    const cols = await columnsOf(deps.db, me.workspaceId);
    const closed = cols
      .filter((col) => col.stage === "done" || col.stage === "canceled")
      .map((col) => col.id);
    const due = await deps.db
      .select({ id: issues.id, number: issues.number, title: issues.title, date: issues.dueDate })
      .from(issues)
      .where(
        and(
          eq(issues.workspaceId, me.workspaceId),
          visibleIssuesSql(me),
          gte(issues.dueDate, q.from.slice(0, 10)),
          lte(issues.dueDate, q.to.slice(0, 10)),
          closed.length ? notInArray(issues.columnId, closed) : undefined,
        ),
      );

    const proposals = await deps.db
      .select()
      .from(calendarProposals)
      .where(
        and(
          eq(calendarProposals.workspaceId, me.workspaceId),
          eq(calendarProposals.status, "pending"),
          gte(calendarProposals.end, from),
          lt(calendarProposals.start, to),
        ),
      );
    const body: CalendarRange = {
      events,
      routines: range.sort((a, b) => a.at.localeCompare(b.at)),
      dueItems: due.map((d) => ({ issueId: d.id, number: d.number, title: d.title, date: d.date ?? "" })),
      proposals: proposals.filter((p) => isPersonIn(p.participants, me.userId)).map(toProposal),
    };
    return c.json(body, 200, { "cache-control": "private, no-store" });
  });

  app.post(`${WORKSPACE}/calendar/events`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const input = await readJson(c, createEventBody);
    const timezone = input.timezone ?? (await defaultTimezone(deps, me));
    if (!isTimezone(timezone)) throw new HttpError(400, "rule.timezone", "Unknown time zone");
    const start = new Date(input.start);
    const end = new Date(input.end);
    checkTimes(start, end);
    checkAllDay(input.allDay ?? false, start, end, timezone);
    checkSeriesRule(input.rule, timezone);
    await checkParticipants(deps, me.workspaceId, input.participants ?? []);
    const at = deps.now();
    const [row] = await deps.db
      .insert(calendarEntries)
      .values({
        id: newId("evt"),
        workspaceId: me.workspaceId,
        title: input.title,
        start,
        end,
        allDay: input.allDay ?? false,
        timezone,
        rule: input.rule ? { ...input.rule, timezone: input.rule.timezone || timezone } : null,
        participants: input.participants ?? [],
        createdBy: { type: "person", id: me.userId },
        location: input.location ?? null,
        description: input.description ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!row) throw new Error("event insert returned nothing");
    publishEvent(deps, row);
    return c.json(toEvent(row), 201);
  });

  app.patch(`${WORKSPACE}/calendar/events/:eventId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const visible = await eventFor(deps.db, me, param(c, "eventId"));
    requireEditor(visible, me);
    const { saved, reply } = await editEvent(deps, me, visible, await readJson(c, updateEventBody));
    for (const row of saved) publishEvent(deps, row);
    return c.json(toEvent(reply));
  });

  app.delete(`${WORKSPACE}/calendar/events/:eventId`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const visible = await eventFor(deps.db, me, param(c, "eventId"));
    requireEditor(visible, me);
    const removed = await deleteEvent(deps, me, visible, readQuery(c, z.object(scopeFields)));
    publishDeleted(deps, removed.row, removed.scope, removed.occurrence, removed.gone);
    return c.body(null, 204);
  });

  app.post(`${WORKSPACE}/calendar/proposals/:proposalId/confirm`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const proposal = await proposalFor(deps, me, param(c, "proposalId"));
    const timezone = await defaultTimezone(deps, me);
    const at = deps.now();
    // Claiming the proposal and creating its event are one transaction: two confirmations at once make one event.
    const event = await deps.db.transaction(async (tx) => {
      const id = newId("evt");
      const [claimed] = await tx
        .update(calendarProposals)
        .set({ status: "confirmed", eventId: id })
        .where(and(eq(calendarProposals.id, proposal.id), eq(calendarProposals.status, "pending")))
        .returning();
      if (!claimed) throw proposalClosed();
      const [row] = await tx
        .insert(calendarEntries)
        .values({
          id,
          workspaceId: me.workspaceId,
          title: claimed.title,
          start: claimed.start,
          end: claimed.end,
          timezone,
          participants: claimed.participants,
          createdBy: { type: "agent", id: claimed.agentId },
          description: claimed.note,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error("event insert returned nothing");
      return row;
    });
    publishEvent(deps, event);
    return c.json(toEvent(event), 201);
  });

  app.post(`${WORKSPACE}/calendar/proposals/:proposalId/dismiss`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const proposal = await proposalFor(deps, me, param(c, "proposalId"));
    const [dismissed] = await deps.db
      .update(calendarProposals)
      .set({ status: "dismissed" })
      .where(and(eq(calendarProposals.id, proposal.id), eq(calendarProposals.status, "pending")))
      .returning({ id: calendarProposals.id });
    if (!dismissed) throw proposalClosed();
    return c.body(null, 204);
  });
}

const proposalClosed = () =>
  new HttpError(409, "calendar.proposal_closed", "This proposal was already answered");

/** A proposal the person may answer: one of its participants, or an admin. Anyone else gets 404. */
async function proposalFor(deps: AppDeps, me: WorkspaceMember, id: string) {
  const [row] = await deps.db
    .select()
    .from(calendarProposals)
    .where(and(eq(calendarProposals.id, id), eq(calendarProposals.workspaceId, me.workspaceId)));
  if (!row || !(isPersonIn(row.participants, me.userId) || can(me.role, "configure")))
    throw notFound("Proposal not found");
  if (row.status !== "pending") throw proposalClosed();
  return row;
}
