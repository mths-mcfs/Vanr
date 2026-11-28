// The week: seven days, each with its events, its routines' runs and the issues due that day, all-day
// things first and then by the hour. The agents' proposals wait above the week for an answer. The
// calendar is read on opening, on every saved or removed event, and every minute; a new event starts
// at 10:00 on the day picked (today from the header).
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { CalendarEvent, CalendarRange } from "@vanr/contract";
import { Button } from "@vanr/ui";
import { ChevronLeft, ChevronRight, Plus, Repeat } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { useDocumentTitle } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useClock } from "../../../platform/clock.tsx";
import { type Actors, useActors, useOutcome } from "../issues/shared.tsx";
import { PartError, PartLoading } from "../parts.tsx";
import { addDays, dayKey, startOfWeek, weekDays } from "../time.ts";
import { EventDialog } from "./EventDialog.tsx";
import { NewEventDialog } from "./NewEvent.tsx";

/** How often the week is read again, for the proposals and routine times that have no event of their own. */
const CALENDAR_REFRESH_MS = 60_000;

export function CalendarScreen() {
  const { workspaceId } = useRouteParams("calendar");
  return <CalendarView key={workspaceId} workspaceId={workspaceId} />;
}

type Entry =
  | { kind: "event"; key: string; at: number; allDay: boolean; event: CalendarEvent }
  | { kind: "routine"; key: string; at: number; name: string }
  | { kind: "due"; key: string; number: number; title: string };

/** What each local day of the week holds, in the order it is read. */
export function entriesByDay(range: CalendarRange, days: Date[]): Map<string, Entry[]> {
  const out = new Map(days.map((day) => [dayKey(day), [] as Entry[]]));
  const put = (day: string, entry: Entry) => out.get(day)?.push(entry);
  const keys = days.map(dayKey);
  for (const event of range.events) {
    const key = `event:${event.id}:${event.start}`;
    if (event.allDay && event.startDate !== null) {
      // Only the shown days are walked, however long the event: a year-long one still shows this week.
      const last = event.endDate ?? event.startDate;
      for (const day of keys) {
        if (day >= event.startDate && day <= last)
          put(day, { kind: "event", key, at: 0, allDay: true, event });
      }
    } else {
      // A timed event shows on every shown day it overlaps; its end is exclusive.
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      for (const day of days) {
        const from = day.getTime();
        const to = addDays(day, 1).getTime();
        if (start < to && end > from) {
          put(dayKey(day), { kind: "event", key, at: Math.max(start, from), allDay: false, event });
        }
      }
    }
  }
  for (const run of range.routines) {
    const at = new Date(run.at);
    put(dayKey(at), {
      kind: "routine",
      key: `routine:${run.routineId}:${run.at}`,
      at: at.getTime(),
      name: run.name,
    });
  }
  for (const due of range.dueItems) {
    put(due.date, { kind: "due", key: `due:${due.issueId}`, number: due.number, title: due.title });
  }
  // All-day events, then the issues due, then the rest by the hour.
  const rank = (entry: Entry) => (entry.kind === "event" && entry.allDay ? 0 : entry.kind === "due" ? 1 : 2);
  for (const list of out.values()) {
    list.sort((a, b) => rank(a) - rank(b) || ("at" in a && "at" in b ? a.at - b.at : 0));
  }
  return out;
}

function CalendarView({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("work");
  const shell = useMessages("shell");
  const { locale } = useLocale();
  const clock = useClock();
  const actors = useActors(workspaceId);
  const [monday, setMonday] = useState(() => startOfWeek(new Date(clock.now())));
  const [creatingOn, setCreatingOn] = useState<Date | null>(null);
  // The button that opened the new-event form gets the focus back when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const create = (day: Date) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCreatingOn(day);
  };
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  useDocumentTitle(shell("route.calendar"));
  const days = weekDays(monday);
  const range = useApiQuery(
    "getCalendar",
    { workspaceId, query: { from: monday.toISOString(), to: addDays(monday, 7).toISOString() } },
    { refetchInterval: CALENDAR_REFRESH_MS, placeholderData: (previous) => previous },
  );

  const dayName = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" });
  const short = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const shortWithYear = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  const today = dayKey(new Date(clock.now()));

  const header = (
    <header className="work__head work-cal__head">
      <div>
        <h1 className="page__title">{shell("route.calendar")}</h1>
        <p className="page__muted" aria-live="polite">
          {t("week.range", {
            from: short.format(monday),
            to: shortWithYear.format(addDays(monday, 6)),
          })}
        </p>
      </div>
      <div className="work-cal__nav">
        <Button
          variant="ghost"
          icon={<ChevronLeft size={16} />}
          aria-label={t("week.previous")}
          onClick={() => setMonday(addDays(monday, -7))}
        />
        <Button onClick={() => setMonday(startOfWeek(new Date(clock.now())))}>{t("week.today")}</Button>
        <Button
          variant="ghost"
          icon={<ChevronRight size={16} />}
          aria-label={t("week.next")}
          onClick={() => setMonday(addDays(monday, 7))}
        />
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => create(new Date(clock.now()))}>
          {t("week.new")}
        </Button>
      </div>
    </header>
  );

  let body: ReactNode;
  if (range.isPending) body = <PartLoading />;
  else if (range.isError && range.data === undefined) {
    body = <PartError title={t("week.failed")} error={range.error} onRetry={() => void range.refetch()} />;
  } else {
    const byDay = entriesByDay(range.data, days);
    const nothing = [...byDay.values()].every((list) => list.length === 0);
    body = (
      <>
        <Proposals workspaceId={workspaceId} range={range.data} actors={actors} />
        {nothing && <p className="work-cal__empty">{t("week.empty")}</p>}
        <div className="work-week">
          {days.map((day) => {
            const key = dayKey(day);
            const label = dayName.format(day);
            const entries = byDay.get(key) ?? [];
            return (
              <section
                key={key}
                className={key === today ? "work-day is-today" : "work-day"}
                aria-label={label}
                aria-current={key === today ? "date" : undefined}
              >
                <header className="work-day__head">
                  <h2 className="work-day__name">
                    <span className="work-day__weekday">
                      {new Intl.DateTimeFormat(locale, { weekday: "short" }).format(day)}
                    </span>
                    <span className="work-day__date">{day.getDate()}</span>
                  </h2>
                  {key === today && <span className="work-day__today">{t("week.todayMark")}</span>}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Plus size={14} />}
                    aria-label={t("week.addOn", { day: label })}
                    onClick={() => create(day)}
                  />
                </header>
                {entries.length > 0 && (
                  <ul className="work-day__entries">
                    {entries.map((entry) => (
                      <li key={entry.key}>
                        <DayEntry entry={entry} workspaceId={workspaceId} onOpen={setOpen} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className="page page--wide work">
      {header}
      {body}
      {creatingOn !== null && (
        <NewEventDialog
          workspaceId={workspaceId}
          day={creatingOn}
          onClose={() => setCreatingOn(null)}
          returnFocus={() => opener.current?.focus()}
        />
      )}
      {open !== null && (
        <EventDialog workspaceId={workspaceId} event={open} actors={actors} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

function DayEntry({
  entry,
  workspaceId,
  onOpen,
}: {
  entry: Entry;
  workspaceId: string;
  onOpen: (event: CalendarEvent) => void;
}) {
  const t = useMessages("work");
  const { locale } = useLocale();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  if (entry.kind === "due") {
    return (
      <AppLink
        className="work-entry work-entry--due"
        route="issue"
        params={{ workspaceId, issueSeq: String(entry.number) }}
      >
        {t("week.dueOn", { number: entry.number, title: entry.title })}
      </AppLink>
    );
  }
  if (entry.kind === "routine") {
    return (
      <AppLink className="work-entry work-entry--routine" route="routines" params={{ workspaceId }}>
        <span className="work-entry__time">{time.format(entry.at)}</span>
        <span>{t("week.routineAt", { name: entry.name })}</span>
      </AppLink>
    );
  }
  return (
    <button
      type="button"
      className={entry.allDay ? "work-entry work-entry--event is-all-day" : "work-entry work-entry--event"}
      onClick={() => onOpen(entry.event)}
    >
      <span className="work-entry__time">{entry.allDay ? t("week.allDay") : time.format(entry.at)}</span>
      <span className="work-entry__title">{entry.event.title}</span>
      {entry.event.rule !== null && <Repeat size={12} aria-hidden="true" className="work-entry__repeat" />}
    </button>
  );
}

function Proposals({
  workspaceId,
  range,
  actors,
}: {
  workspaceId: string;
  range: CalendarRange;
  actors: Actors;
}) {
  const t = useMessages("work");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const refresh = () => [{ method: "getCalendar" as const, args: { workspaceId } }];
  // Pending by proposal: a mutation's own state follows only its latest call, so answering B
  // would free A's buttons while A is still on its way.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (id: string, on: boolean) =>
    setPending((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // Kept from the click: once answered, the proposal leaves the range before the toast shows.
  const titles = useRef(new Map<string, string>());
  const titleOf = (id: string) => titles.current.get(id) ?? "";
  const confirm = useApiMutation("confirmCalendarProposal", {
    invalidates: refresh,
    onSuccess: (_result, args) => outcome.done(t("week.confirmed", { title: titleOf(args.proposalId) })),
    onError: (error) => outcome.failed(error),
    onSettled: (_result, _error, args) => mark(args.proposalId, false),
  });
  const dismiss = useApiMutation("dismissCalendarProposal", {
    invalidates: refresh,
    onSuccess: () => outcome.done(t("week.dismissed")),
    onError: (error) => outcome.failed(error),
    onSettled: (_result, _error, args) => mark(args.proposalId, false),
  });
  const answer = (proposal: { id: string; title: string }, how: typeof confirm | typeof dismiss) => {
    titles.current.set(proposal.id, proposal.title);
    mark(proposal.id, true);
    how.mutate({ workspaceId, proposalId: proposal.id });
  };
  if (range.proposals.length === 0) return null;
  const when = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <section className="work-proposals" aria-label={t("week.proposals")}>
      <h2 className="page__heading">{t("week.proposals")}</h2>
      <ul>
        {range.proposals.map((proposal) => {
          const busy = pending.has(proposal.id);
          return (
            <li key={proposal.id} className="work-proposal" aria-label={proposal.title}>
              <p className="work-proposal__by">
                {t("week.proposalBy", { name: actors.name({ type: "agent", id: proposal.agentId }) })}
              </p>
              <p className="work-proposal__title">{proposal.title}</p>
              <p className="page__muted">
                {when.formatRange(new Date(proposal.start), new Date(proposal.end))}
              </p>
              {proposal.note !== null && proposal.note !== "" && <p>{proposal.note}</p>}
              <div className="work-proposal__actions">
                <Button variant="primary" size="sm" disabled={busy} onClick={() => answer(proposal, confirm)}>
                  {t("week.confirm")}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => answer(proposal, dismiss)}>
                  {t("week.dismiss")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
