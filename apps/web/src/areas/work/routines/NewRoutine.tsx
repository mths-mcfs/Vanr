// A new routine: its name, the agent (only one the person may set to work), the instruction, what makes
// it run (a schedule in plain words, read back by the server with its next run; an event; an email in
// one of the agent's inboxes; a call to its web address), where it answers, its limits, and whether it
// starts on. Created off unless the person turns it on here.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Channel, RoutinePolicy, RoutineTarget, RoutineTrigger } from "@vanr/contract";
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
import { useEffect, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { type Actors, useOutcome } from "../issues/shared.tsx";
import { browserTimezone } from "../time.ts";
import { ROUTINE_EVENTS, useTriggerText } from "./words.ts";

export const ROUTINE_NAME_MAX = 120;
export const INSTRUCTION_MAX = 10_000;
const PHRASE_MAX = 300;
const PHRASE_PAUSE_MS = 400;

const KINDS = ["schedule", "event", "email", "webhook"] as const;
type Kind = (typeof KINDS)[number];
const TARGETS = ["dm", "channel", "file"] as const;
type TargetKind = (typeof TARGETS)[number];

/** The server's defaults, shown so the person sees what they change. */
const DEFAULT_POLICY: RoutinePolicy = {
  missed: "once",
  missedWindowMin: 60,
  overlap: "skip",
  maxCostUsd: 2,
  maxSteps: 12,
  maxMinutes: 30,
  retries: 2,
  pauseAfterFailures: 3,
};
const NUMBERS = [
  // Any amount: a step of 0.01 from 0.01 trips the browser's own check on round sums.
  { key: "maxCostUsd", min: 0.01, max: 100, step: "any" },
  { key: "maxSteps", min: 1, max: 50, step: 1 },
  { key: "maxMinutes", min: 1, max: 240, step: 1 },
  { key: "retries", min: 0, max: 5, step: 1 },
  { key: "pauseAfterFailures", min: 0, max: 20, step: 1 },
] as const;
type NumberKey = (typeof NUMBERS)[number]["key"];

/** A limit as typed: a number inside its bounds (a whole one unless it is money), or undefined. */
export function readLimit(text: string, limit: (typeof NUMBERS)[number]): number | undefined {
  // A count is digits only. An amount is dollars with up to two decimals after "." or ",", so
  // "1,000" is no amount at all rather than one dollar; neither is "0x10" or "1e3".
  const typed = text.trim();
  if (!(limit.step === 1 ? /^\d+$/ : /^\d+([.,]\d{1,2})?$/).test(typed)) return undefined;
  const value = Number(typed.replace(",", "."));
  if (value < limit.min || value > limit.max) return undefined;
  if (limit.step === 1 && !Number.isInteger(value)) return undefined;
  return value;
}
const NUMBER_LABEL = {
  maxCostUsd: "recur.form.maxCost",
  maxSteps: "recur.form.maxSteps",
  maxMinutes: "recur.form.maxMinutes",
  retries: "recur.form.retries",
  pauseAfterFailures: "recur.form.pauseAfter",
} as const;

function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function NewRoutineDialog({
  workspaceId,
  actors,
  channels,
  onClose,
}: {
  workspaceId: string;
  actors: Actors;
  channels: Channel[];
  onClose: () => void;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const { locale } = useLocale();
  const describe = useErrorMessage("work");
  const outcome = useOutcome();
  const triggerText = useTriggerText();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(actors.reachable[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<Kind>("schedule");
  const [phrase, setPhrase] = useState("");
  const [event, setEvent] = useState<string>(ROUTINE_EVENTS[0]);
  const [accountId, setAccountId] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [from, setFrom] = useState("");
  const [targetKind, setTargetKind] = useState<TargetKind>("dm");
  const [channelId, setChannelId] = useState(channels.find((channel) => channel.isMember)?.id ?? "");
  const [policy, setPolicy] = useState<RoutinePolicy>(DEFAULT_POLICY);
  // The limits stay as typed until the routine is sent: a half-typed "1." is not 1 yet.
  const [limitText, setLimitText] = useState<Record<NumberKey, string>>(() => ({
    maxCostUsd: String(DEFAULT_POLICY.maxCostUsd),
    maxSteps: String(DEFAULT_POLICY.maxSteps),
    maxMinutes: String(DEFAULT_POLICY.maxMinutes),
    retries: String(DEFAULT_POLICY.retries),
    pauseAfterFailures: String(DEFAULT_POLICY.pauseAfterFailures),
  }));
  const limits = Object.fromEntries(
    NUMBERS.map((each) => [each.key, readLimit(limitText[each.key], each)]),
  ) as Record<NumberKey, number | undefined>;
  const limitsValid = NUMBERS.every((each) => limits[each.key] !== undefined);
  const [active, setActive] = useState(false);
  const timezone = browserTimezone();
  const settled = useSettled(phrase.trim(), PHRASE_PAUSE_MS);
  const parsed = useApiQuery(
    "parseRoutineSchedule",
    { workspaceId, body: { phrase: settled, timezone } },
    { enabled: kind === "schedule" && settled !== "" },
  );
  const mailboxes = useApiQuery(
    "getAgentMail",
    { workspaceId, agentId },
    { enabled: kind === "email" && agentId !== "", retry: false },
  );
  const readable = (mailboxes.data ?? []).filter((box) => box.level !== "none");
  const create = useApiMutation("createRoutine", {
    invalidates: () => [{ method: "listRoutines", args: { workspaceId } }],
  });
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  const trigger = ((): RoutineTrigger | undefined => {
    switch (kind) {
      case "schedule":
        return settled !== "" && settled === phrase.trim() && parsed.data?.ok === true
          ? (parsed.data.trigger ?? undefined)
          : undefined;
      case "event":
        return { kind: "event", event };
      case "email": {
        const senders = from
          .split(",")
          .map((each) => each.trim())
          .filter((each) => each !== "");
        // A box picked for another agent doesn't count for this one.
        return !readable.some((box) => box.accountId === accountId) || folder.trim() === ""
          ? undefined
          : {
              kind: "email",
              accountId,
              folder: folder.trim(),
              ...(senders.length > 0 && { filter: { from: senders } }),
            };
      }
      default:
        return { kind: "webhook" };
    }
  })();
  const target: RoutineTarget | undefined =
    targetKind === "channel"
      ? channelId === ""
        ? undefined
        : { kind: "channel", channelId }
      : { kind: targetKind };
  const ready =
    name.trim() !== "" &&
    agentId !== "" &&
    prompt.trim() !== "" &&
    trigger !== undefined &&
    target !== undefined &&
    limitsValid &&
    !create.isPending;

  const submit = () => {
    if (!ready || trigger === undefined || target === undefined) return;
    create.mutate(
      {
        workspaceId,
        body: {
          name: name.trim(),
          agentId,
          prompt: prompt.trim(),
          trigger,
          target,
          policy: { ...policy, ...(limits as Record<NumberKey, number>) },
          active,
        },
      },
      {
        onSuccess: (routine) => {
          outcome.done(t("recur.form.created", { name: routine.name }));
          onClose();
        },
      },
    );
  };

  const scheduleHint =
    kind !== "schedule" || settled === "" || parsed.isPending || parsed.data === undefined
      ? t("recur.form.scheduleHint")
      : parsed.data.ok && parsed.data.trigger !== null
        ? t("recur.form.scheduleNext", {
            text: triggerText(parsed.data.trigger),
            when:
              parsed.data.upcomingFireTimes[0] === undefined
                ? ""
                : when.format(new Date(parsed.data.upcomingFireTimes[0])),
          })
        : undefined;
  const scheduleWrong =
    kind === "schedule" && parsed.data !== undefined && !parsed.data.ok && settled === phrase.trim();
  const scheduleFailed = kind === "schedule" && settled !== "" && parsed.isError && parsed.data === undefined;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="lg"
        title={t("recur.new")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="work-new-routine"
              disabled={!ready}
              loading={create.isPending}
            >
              {t("recur.form.create")}
            </Button>
          </>
        }
      >
        <form
          id="work-new-routine"
          className="work-form"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            submit();
          }}
        >
          <div className="work-form__row">
            <Field label={t("recur.form.name")} required>
              <Input
                value={name}
                maxLength={ROUTINE_NAME_MAX}
                autoFocus
                onChange={(change) => setName(change.target.value)}
              />
            </Field>
            <Field label={t("recur.form.agent")}>
              <Select
                value={agentId}
                onValueChange={(value) => {
                  setAgentId(value);
                  setAccountId("");
                }}
              >
                {actors.reachable.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("recur.form.instruction")} hint={t("recur.form.instructionHint")} required>
            <Textarea
              rows={4}
              value={prompt}
              maxLength={INSTRUCTION_MAX}
              onChange={(change) => setPrompt(change.target.value)}
            />
          </Field>
          <Field label={t("recur.form.trigger")}>
            <Select
              value={kind}
              onValueChange={(value) => setKind(KINDS.find((each) => each === value) ?? "schedule")}
            >
              {KINDS.map((each) => (
                <SelectItem key={each} value={each}>
                  {t(`recur.form.trigger.${each}`)}
                </SelectItem>
              ))}
            </Select>
          </Field>
          {kind === "schedule" && (
            <Field
              label={t("recur.form.schedule")}
              {...(scheduleHint !== undefined && { hint: scheduleHint })}
              {...(scheduleWrong && { error: t("recur.form.scheduleWrong") })}
            >
              <Input
                value={phrase}
                maxLength={PHRASE_MAX}
                onChange={(change) => setPhrase(change.target.value)}
              />
            </Field>
          )}
          {scheduleFailed && (
            <Callout tone="danger" role="alert">
              {t("recur.form.scheduleFailed")}{" "}
              <Button size="sm" variant="ghost" onClick={() => void parsed.refetch()}>
                {common("action.retry")}
              </Button>
            </Callout>
          )}
          {kind === "event" && (
            <Field label={t("recur.form.event")}>
              <Select value={event} onValueChange={setEvent}>
                {ROUTINE_EVENTS.map((each) => (
                  <SelectItem key={each} value={each}>
                    {t(`recur.event.${each}`)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          )}
          {kind === "email" &&
            (readable.length === 0 ? (
              <p className="work-note">{t("recur.form.noMailbox")}</p>
            ) : (
              <>
                <div className="work-form__row">
                  <Field label={t("recur.form.mailbox")}>
                    <Select value={accountId} onValueChange={setAccountId}>
                      {readable.map((box) => (
                        <SelectItem key={box.accountId} value={box.accountId}>
                          {box.accountId}
                        </SelectItem>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("recur.form.folder")}>
                    <Input value={folder} onChange={(change) => setFolder(change.target.value)} />
                  </Field>
                </div>
                <Field label={t("recur.form.from")} hint={t("recur.form.fromHint")}>
                  <Input value={from} onChange={(change) => setFrom(change.target.value)} />
                </Field>
              </>
            ))}
          <div className="work-form__row">
            <Field label={t("recur.form.target")}>
              <Select
                value={targetKind}
                onValueChange={(value) => setTargetKind(TARGETS.find((each) => each === value) ?? "dm")}
              >
                {TARGETS.map((each) => (
                  <SelectItem key={each} value={each}>
                    {each === "channel" ? t("recur.form.channel") : t(`recur.where.${each}`)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            {targetKind === "channel" && (
              <Field label={t("recur.form.channel")}>
                <Select value={channelId} onValueChange={setChannelId}>
                  {channels.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <details className="work-limits">
            <summary>{t("recur.form.limits")}</summary>
            <div className="work-form__row">
              {NUMBERS.map((each) => (
                <Field
                  key={each.key}
                  label={t(NUMBER_LABEL[each.key])}
                  {...(each.step !== 1 && { hint: t("recur.form.amountHint") })}
                  {...(limits[each.key] === undefined && {
                    error: t("recur.form.limitRange", { min: each.min, max: each.max }),
                  })}
                >
                  <Input
                    inputMode={each.step === 1 ? "numeric" : "decimal"}
                    value={limitText[each.key]}
                    onChange={(change) => setLimitText({ ...limitText, [each.key]: change.target.value })}
                  />
                </Field>
              ))}
              <Field label={t("recur.form.missed")}>
                <Select
                  value={policy.missed}
                  onValueChange={(value) =>
                    setPolicy({ ...policy, missed: value === "skip" ? "skip" : "once" })
                  }
                >
                  <SelectItem value="once">{t("recur.form.missed.once")}</SelectItem>
                  <SelectItem value="skip">{t("recur.form.missed.skip")}</SelectItem>
                </Select>
              </Field>
              <Field label={t("recur.form.overlap")}>
                <Select
                  value={policy.overlap}
                  onValueChange={(value) =>
                    setPolicy({ ...policy, overlap: value === "queue" ? "queue" : "skip" })
                  }
                >
                  <SelectItem value="skip">{t("recur.form.overlap.skip")}</SelectItem>
                  <SelectItem value="queue">{t("recur.form.overlap.queue")}</SelectItem>
                </Select>
              </Field>
            </div>
          </details>
          <Checkbox
            label={t("recur.form.startActive")}
            hint={t("recur.form.startActiveHint")}
            checked={active}
            onCheckedChange={(checked) => setActive(checked === true)}
          />
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
