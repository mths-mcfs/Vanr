// A new event: its title, when (a time span, or whole days), whether it repeats (every day, every
// weekday, or every week on its first day, in the browser's time zone), where, and notes. It starts at
// 10:00 for an hour on the day it was opened from.
import { useApiMutation } from "@vanr/client/react";
import type { RecurrenceRule } from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectItem,
  Textarea,
} from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useOutcome } from "../issues/shared.tsx";
import {
  addDays,
  browserTimezone,
  dayKey,
  fromLocalInput,
  startOfDay,
  toLocalInput,
  weekdayName,
  weekdayOf,
} from "../time.ts";

export const EVENT_TITLE_MAX = 200;
export const LOCATION_MAX = 300;
export const NOTES_MAX = 10_000;

const REPEATS = ["none", "daily", "weekdays", "weekly"] as const;
type Repeats = (typeof REPEATS)[number];

/** The series rule for a choice, repeating in the browser's time zone; none for a single event. */
export function ruleFor(repeats: Repeats, start: Date, timezone: string): RecurrenceRule | null {
  switch (repeats) {
    case "daily":
      return { freq: "daily", timezone };
    case "weekdays":
      return { freq: "weekly", weekdays: ["MO", "TU", "WE", "TH", "FR"], timezone };
    case "weekly":
      return { freq: "weekly", weekdays: [weekdayOf(start)], timezone };
    default:
      return null;
  }
}

export function NewEventDialog({
  workspaceId,
  day,
  onClose,
}: {
  workspaceId: string;
  day: Date;
  onClose: () => void;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const { locale } = useLocale();
  const describe = useErrorMessage("work");
  const outcome = useOutcome();
  const ten = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10);
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState(toLocalInput(ten));
  const [end, setEnd] = useState(toLocalInput(new Date(ten.getTime() + 3_600_000)));
  const [firstDay, setFirstDay] = useState(dayKey(day));
  const [lastDay, setLastDay] = useState(dayKey(day));
  const [repeats, setRepeats] = useState<Repeats>("none");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const create = useApiMutation("createCalendarEvent", {
    invalidates: () => [{ method: "getCalendar", args: { workspaceId } }],
  });

  // Whole days run from the first day's midnight to the midnight after the last day.
  const from = allDay ? fromLocalInput(firstDay) : fromLocalInput(start);
  const lastMidnight = fromLocalInput(lastDay);
  const to = allDay
    ? lastMidnight === undefined
      ? undefined
      : addDays(startOfDay(lastMidnight), 1)
    : fromLocalInput(end);
  const backwards = from !== undefined && to !== undefined && to <= from;
  const ready =
    title.trim() !== "" && from !== undefined && to !== undefined && !backwards && !create.isPending;

  const submit = () => {
    if (!ready || from === undefined || to === undefined) return;
    const timezone = browserTimezone();
    create.mutate(
      {
        workspaceId,
        body: {
          title: title.trim(),
          start: from.toISOString(),
          end: to.toISOString(),
          allDay,
          timezone,
          rule: ruleFor(repeats, from, timezone),
          location: location.trim() === "" ? null : location.trim(),
          description: notes.trim() === "" ? null : notes.trim(),
        },
      },
      {
        onSuccess: (event) => {
          outcome.done(t("cal.created", { title: event.title }));
          onClose();
        },
      },
    );
  };

  const repeatLabel = (choice: Repeats) =>
    choice === "weekly"
      ? t("cal.repeat.weekly", { day: from === undefined ? "" : weekdayName(weekdayOf(from), locale) })
      : t(`cal.repeat.${choice}`);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="lg"
        title={t("cal.new.title")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="work-new-event"
              disabled={!ready}
              loading={create.isPending}
            >
              {t("cal.create")}
            </Button>
          </>
        }
      >
        <form
          id="work-new-event"
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field label={t("cal.field.title")} required>
            <Input
              value={title}
              maxLength={EVENT_TITLE_MAX}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Checkbox
            label={t("cal.field.allDay")}
            checked={allDay}
            onCheckedChange={(checked) => setAllDay(checked === true)}
          />
          {allDay ? (
            <div className="work-form__row">
              <Field label={t("cal.field.startDay")}>
                <Input type="date" value={firstDay} onChange={(event) => setFirstDay(event.target.value)} />
              </Field>
              <Field label={t("cal.field.endDay")} {...(backwards && { error: t("cal.endBeforeStart") })}>
                <Input type="date" value={lastDay} onChange={(event) => setLastDay(event.target.value)} />
              </Field>
            </div>
          ) : (
            <div className="work-form__row">
              <Field label={t("cal.field.start")}>
                <Input
                  type="datetime-local"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </Field>
              <Field label={t("cal.field.end")} {...(backwards && { error: t("cal.endBeforeStart") })}>
                <Input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
              </Field>
            </div>
          )}
          <Field label={t("cal.field.repeat")}>
            <Select
              value={repeats}
              onValueChange={(value) => setRepeats(REPEATS.find((each) => each === value) ?? "none")}
            >
              {REPEATS.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {repeatLabel(choice)}
                </SelectItem>
              ))}
            </Select>
          </Field>
          <Field label={t("cal.field.location")}>
            <Input
              value={location}
              maxLength={LOCATION_MAX}
              onChange={(event) => setLocation(event.target.value)}
            />
          </Field>
          <Field label={t("cal.field.description")}>
            <Textarea
              rows={4}
              value={notes}
              maxLength={NOTES_MAX}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          {create.isError && (
            <Callout tone="danger" role="alert">
              {describe(create.error)}
            </Callout>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
