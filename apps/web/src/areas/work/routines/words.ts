// How a routine's trigger and target read: "Every weekday at 09:00", "When an issue is opened",
// "In #ops". A channel the person can't open is named as such, never by its id.
import type { RoutineTarget, RoutineTrigger } from "@vanr/contract";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useRuleWords } from "../calendar/EventDialog.tsx";
import { describeRule } from "../time.ts";

export const ROUTINE_EVENTS = ["issue.created", "debate.concluded"] as const;

export function useTriggerText(): (trigger: RoutineTrigger) => string {
  const t = useMessages("work");
  const { locale } = useLocale();
  const words = useRuleWords();
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return (trigger) => {
    switch (trigger.kind) {
      case "schedule":
        return describeRule(trigger.rule, words, locale);
      case "once":
        return t("recur.when.once", { when: when.format(new Date(trigger.at)) });
      case "event": {
        const known = ROUTINE_EVENTS.find((event) => event === trigger.event);
        return t("recur.when.event", {
          event: known === undefined ? trigger.event : t(`recur.event.${known}`),
        });
      }
      case "email":
        return t(
          trigger.status === undefined || trigger.status === "active"
            ? "recur.when.email"
            : "recur.when.emailDown",
          {
            folder: trigger.folder,
          },
        );
      default:
        return t("recur.when.webhook");
    }
  };
}

export function useTargetText(): (
  target: RoutineTarget,
  channelName: (id: string) => string | undefined,
) => string {
  const t = useMessages("work");
  return (target, channelName) => {
    if (target.kind === "channel") {
      const name = channelName(target.channelId);
      return name === undefined
        ? t("recur.where.channelHidden")
        : t("recur.where.channel", { channel: name });
    }
    return t(`recur.where.${target.kind}`);
  };
}
