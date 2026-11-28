// One occurrence of an event: when, how it repeats, where, the notes, who it is for and who added it.
// Whoever added it, its participants and whoever sets the workspace up may delete it; in a series they
// pick this occurrence, it and the ones after it, or every one.
import { useApiMutation } from "@vanr/client/react";
import type { CalendarEvent } from "@vanr/contract";
import { Button, Dialog, DialogContent, Radio, RadioGroup } from "@vanr/ui";
import { useState } from "react";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { type Actors, useConfigures, useMyId, useOutcome } from "../issues/shared.tsx";
import { RichText } from "../RichText.tsx";
import { describeRule, type RuleWords } from "../time.ts";

const SCOPES = ["this", "following", "all"] as const;
type Scope = (typeof SCOPES)[number];

/** A repeating rule in the reader's words. */
export function useRuleWords(): RuleWords {
  const t = useMessages("work");
  return {
    daily: (count) => t("rule.daily", { count }),
    weekdays: () => t("rule.weekdays"),
    weekly: (count, days) => t("rule.weekly", { count, days }),
    hourly: (count) => t("rule.hourly", { count }),
    minutely: (count) => t("rule.minutely", { count }),
    monthly: (count, days) => t("rule.monthly", { count, days }),
    yearly: () => t("rule.yearly"),
    at: (rule, times) => t("rule.at", { rule, times }),
  };
}

export function EventDialog({
  workspaceId,
  event,
  actors,
  onClose,
}: {
  workspaceId: string;
  event: CalendarEvent;
  actors: Actors;
  onClose: () => void;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const { locale } = useLocale();
  const me = useMyId();
  const configures = useConfigures(workspaceId);
  const outcome = useOutcome();
  const words = useRuleWords();
  const [scope, setScope] = useState<Scope>("this");
  const remove = useApiMutation("deleteCalendarEvent", {
    invalidates: () => [{ method: "getCalendar", args: { workspaceId } }],
    onError: (error) => outcome.failed(error),
  });
  const mayDelete =
    (event.createdBy.type === "person" && event.createdBy.id === me) ||
    event.participants.some((each) => each.type === "person" && each.id === me) ||
    configures;
  const series = event.rule !== null && event.instanceStart !== null;
  const when = event.allDay
    ? new Intl.DateTimeFormat(locale, { dateStyle: "full" }).formatRange(
        new Date(`${event.startDate}T12:00:00`),
        new Date(`${event.endDate ?? event.startDate}T12:00:00`),
      )
    : new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).formatRange(
        new Date(event.start),
        new Date(event.end),
      );

  const confirm = () =>
    remove.mutate(
      {
        workspaceId,
        eventId: event.id,
        ...(series && {
          query: { scope, ...(event.instanceStart !== null && { instanceStart: event.instanceStart }) },
        }),
      },
      {
        onSuccess: () => {
          outcome.done(t("cal.deleted"));
          onClose();
        },
      },
    );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={event.title}
        closeLabel={common("action.close")}
        footer={
          mayDelete ? (
            <Button variant="danger" loading={remove.isPending} onClick={confirm}>
              {t("cal.delete")}
            </Button>
          ) : undefined
        }
      >
        <dl className="work-facts">
          <dt>{t("cal.when")}</dt>
          <dd>{when}</dd>
          {event.rule !== null && (
            <>
              <dt>{t("cal.field.repeat")}</dt>
              <dd>{describeRule(event.rule, words, locale)}</dd>
            </>
          )}
          {event.location !== null && event.location !== "" && (
            <>
              <dt>{t("cal.field.location")}</dt>
              <dd>{event.location}</dd>
            </>
          )}
          <dt>{t("cal.participants")}</dt>
          <dd>
            {event.participants.length === 0
              ? t("cal.everyone")
              : new Intl.ListFormat(locale).format(event.participants.map((each) => actors.name(each)))}
          </dd>
        </dl>
        {event.description !== null && event.description !== "" && <RichText text={event.description} />}
        <p className="page__muted">{t("cal.createdBy", { name: actors.name(event.createdBy) })}</p>
        {mayDelete && series && (
          <RadioGroup
            className="work-scope"
            aria-label={t("cal.deleteWhich")}
            value={scope}
            onValueChange={(value) => setScope(SCOPES.find((each) => each === value) ?? "this")}
          >
            {SCOPES.map((each) => (
              <Radio key={each} value={each} label={t(`cal.scope.${each}`)} />
            ))}
          </RadioGroup>
        )}
      </DialogContent>
    </Dialog>
  );
}
