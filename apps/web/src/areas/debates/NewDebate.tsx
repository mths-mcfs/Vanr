// Starting a debate: the question and its goal, what should come out of it, how many rounds of
// challenge, an optional deadline, the possible answers and a spending cap, then the table. The agents
// speak first in the order they were picked, then the people. Before starting, the most it can cost.
// It opens on the debate's own page.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { CreateDebateBody, DebateFormat } from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  ErrorState,
  Field,
  Input,
  Select,
  SelectItem,
  Skeleton,
  Textarea,
  useToast,
} from "@vanr/ui";
import { type ReactNode, useState } from "react";
import { useGo } from "../../app/navigation.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useClock } from "../../platform/clock.tsx";
import {
  AGENTS_MAX,
  CAP_MAX,
  CAP_MIN,
  charCount,
  type Directory,
  GOAL_MAX,
  type ListState,
  OPTION_MAX,
  OPTIONS_MAX,
  OPTIONS_MIN,
  QUESTION_MAX,
  ROUND_CHOICES,
  SEATS_MAX,
  useMe,
  useMoney,
  useOnce,
  useSeesSpend,
} from "./shared.tsx";

const FORMATS = ["decision", "plan"] as const satisfies readonly DebateFormat[];
/** The workspace's own number of rounds: one round of challenge at most, so the estimate takes one. */
const DEFAULT_ROUNDS = "default";
const DEFAULT_ESTIMATE_ROUNDS = 1;

/** The answers as typed, one per line: trimmed, blank lines dropped, repeats dropped. */
export function optionsOf(text: string): string[] {
  return [...new Set(text.split("\n").map((line) => line.trim()))].filter((line) => line !== "");
}

/** The answers the server takes: none, or 2 to 8, each within its length. Never cut to fit. */
export const optionsFit = (options: readonly string[]) =>
  options.length === 0 ||
  (options.length >= OPTIONS_MIN &&
    options.length <= OPTIONS_MAX &&
    options.every((option) => charCount(option) <= OPTION_MAX));

/** Toggles an id in a picking order: added at the end, or taken out. */
const toggle = (list: readonly string[], id: string, on: boolean) =>
  on ? (list.includes(id) ? [...list] : [...list, id]) : list.filter((each) => each !== id);

export function NewDebateDialog({
  workspaceId,
  directory,
  onClose,
}: {
  workspaceId: string;
  directory: Directory;
  onClose: () => void;
}) {
  const t = useMessages("debates");
  const common = useMessages("common");
  const describe = useErrorMessage("debates");
  const toast = useToast();
  const go = useGo();
  const clock = useClock();
  const me = useMe(workspaceId);
  const seesSpend = useSeesSpend(workspaceId);
  const money = useMoney();
  const once = useOnce();

  const [question, setQuestion] = useState("");
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState<DebateFormat>("decision");
  const [rounds, setRounds] = useState<string>(DEFAULT_ROUNDS);
  const [deadline, setDeadline] = useState("");
  const [optionText, setOptionText] = useState("");
  const [cap, setCap] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);

  const options = optionsOf(optionText);
  const optionsBad = !optionsFit(options);
  const capValue = cap.trim() === "" ? null : Number(cap.replace(",", "."));
  const capBad = capValue !== null && !(capValue >= CAP_MIN && capValue <= CAP_MAX);
  const deadlineAt = deadline === "" ? null : new Date(deadline);
  const deadlineBad =
    deadlineAt !== null && (Number.isNaN(deadlineAt.getTime()) || deadlineAt.getTime() <= clock.now());
  const roundCount = rounds === DEFAULT_ROUNDS ? null : Number(rounds);
  const seats = agentIds.length + userIds.length;

  const estimate = useApiQuery(
    "estimateDebate",
    {
      workspaceId,
      query: { agentIds, rounds: roundCount ?? DEFAULT_ESTIMATE_ROUNDS, format },
    },
    // No placeholder: a figure for another table never shows as this one's while the new one loads.
    { enabled: agentIds.length > 0 },
  );
  const create = useApiMutation("createDebate", {
    invalidates: () => [{ method: "listDebates", args: { workspaceId } }],
  });
  const ready =
    question.trim() !== "" &&
    agentIds.length > 0 &&
    !optionsBad &&
    !capBad &&
    !deadlineBad &&
    !create.isPending;

  const submit = () => {
    if (!ready) return;
    const title = question.trim();
    const body: CreateDebateBody = {
      title,
      goal: goal.trim() === "" ? title : goal.trim(),
      format,
      agentIds,
      // The order of picking is the order of speaking: the agents first, then the people.
      speakers: [
        ...agentIds.map((id) => ({ type: "agent" as const, id })),
        ...userIds.map((id) => ({ type: "person" as const, id })),
      ],
      ...(userIds.length > 0 && { userIds }),
      ...(roundCount !== null && { rounds: roundCount }),
      ...(deadlineAt !== null && { deadline: deadlineAt.toISOString() }),
      ...(options.length > 0 && { options }),
      ...(capValue !== null && { spendCapPercent: capValue }),
    };
    // Two clicks before the button greys out would open two debates, each spending model calls.
    once((done) =>
      create.mutate(
        { workspaceId, body },
        {
          onSettled: done,
          onSuccess: (debate) => {
            toast.push({ tone: "success", title: t("start.started") });
            onClose();
            void go("debate", { workspaceId, debateId: debate.id });
          },
        },
      ),
    );
  };

  const order = (list: readonly string[], id: string, offset: number) => {
    const at = list.indexOf(id);
    return at < 0 ? null : offset + at + 1;
  };
  const seatName = (name: string, at: number | null) =>
    at === null ? name : t("start.seat", { order: at, name });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="lg"
        title={t("start.title")}
        closeLabel={common("action.close")}
        footer={
          <>
            <EstimateNote
              picked={agentIds.length > 0}
              state={
                estimate.data !== undefined
                  ? "ready"
                  : estimate.isError
                    ? "failed"
                    : estimate.isFetching
                      ? "loading"
                      : "idle"
              }
              text={
                estimate.data === undefined
                  ? null
                  : (() => {
                      const shown = seesSpend ? money(estimate.data.upToUsd) : null;
                      return shown === null
                        ? t("start.estimate.calls", { count: estimate.data.calls })
                        : t("start.estimate.money", { count: estimate.data.calls, money: shown });
                    })()
              }
            />
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="debate-new"
              disabled={!ready}
              loading={create.isPending}
            >
              {t("start.submit")}
            </Button>
          </>
        }
      >
        <form
          id="debate-new"
          className="debate-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field label={t("start.question")} hint={t("start.question.hint")} required>
            <Input
              value={question}
              maxLength={QUESTION_MAX}
              autoFocus
              onChange={(event) => setQuestion(event.target.value)}
            />
          </Field>
          <Field label={t("start.goal")} hint={t("start.goal.hint")}>
            <Textarea
              rows={3}
              value={goal}
              maxLength={GOAL_MAX}
              onChange={(event) => setGoal(event.target.value)}
            />
          </Field>
          <div className="debate-form__row">
            <Field label={t("start.format")}>
              <Select
                value={format}
                onValueChange={(value) => setFormat(FORMATS.find((each) => each === value) ?? "decision")}
              >
                {FORMATS.map((each) => (
                  <SelectItem key={each} value={each}>
                    {t(`start.format.${each}`)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field label={t("start.rounds")}>
              <Select value={rounds} onValueChange={setRounds}>
                <SelectItem value={DEFAULT_ROUNDS}>{t("start.rounds.default")}</SelectItem>
                <SelectItem value="0">{t("start.rounds.vote")}</SelectItem>
                {ROUND_CHOICES.map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {t("start.rounds.count", { count })}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field label={t("start.deadline")} error={deadlineBad ? t("start.deadline.past") : undefined}>
              <Input
                type="datetime-local"
                value={deadline}
                onChange={(event) => setDeadline(event.target.value)}
              />
            </Field>
          </div>
          <div className="debate-form__row">
            <Field
              label={t("start.options")}
              hint={t("start.options.hint")}
              error={optionsBad ? t("start.options.bad") : undefined}
            >
              <Textarea rows={3} value={optionText} onChange={(event) => setOptionText(event.target.value)} />
            </Field>
            <Field
              label={t("start.cap")}
              hint={t("start.cap.hint")}
              error={capBad ? t("start.cap.bad") : undefined}
            >
              <Input
                inputMode="decimal"
                value={cap}
                maxLength={6}
                onChange={(event) => setCap(event.target.value)}
              />
            </Field>
          </div>
          <SeatPicker
            legend={t("start.agents")}
            hint={t("start.agents.hint")}
            state={directory.agentsState}
            failed={t("start.agents.failed")}
            onRetry={directory.retry}
            empty={directory.seatable.length === 0 ? t("start.agents.none") : null}
          >
            {directory.seatable.map((agent) => {
              const picked = agentIds.includes(agent.id);
              return (
                <Checkbox
                  key={agent.id}
                  label={seatName(agent.name, order(agentIds, agent.id, 0))}
                  checked={picked}
                  disabled={!picked && (agentIds.length >= AGENTS_MAX || seats >= SEATS_MAX)}
                  onCheckedChange={(on) => setAgentIds((list) => toggle(list, agent.id, on === true))}
                />
              );
            })}
          </SeatPicker>
          <SeatPicker
            legend={t("start.people")}
            hint={t("start.people.hint")}
            state={directory.peopleState}
            failed={t("start.people.failed")}
            onRetry={directory.retry}
            empty={null}
          >
            {directory.people.map((person) => {
              const picked = userIds.includes(person.id);
              const name = person.id === me.id ? t("start.you", { name: person.name }) : person.name;
              return (
                <Checkbox
                  key={person.id}
                  label={seatName(name, order(userIds, person.id, agentIds.length))}
                  checked={picked}
                  disabled={!picked && seats >= SEATS_MAX}
                  onCheckedChange={(on) => setUserIds((list) => toggle(list, person.id, on === true))}
                />
              );
            })}
          </SeatPicker>
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

function SeatPicker({
  legend,
  hint,
  state,
  failed,
  onRetry,
  empty,
  children,
}: {
  legend: string;
  hint: string;
  state: ListState;
  failed: string;
  onRetry: () => void;
  empty: string | null;
  children: ReactNode;
}) {
  const common = useMessages("common");
  const describe = useErrorMessage("debates");
  return (
    <fieldset className="debate-form__seats">
      <legend>{legend}</legend>
      <p className="debate-form__hint">{hint}</p>
      {state.status === "loading" ? (
        <div aria-busy="true">
          <span className="vr-visually-hidden" role="status">
            {common("state.loading")}
          </span>
          <Skeleton />
        </div>
      ) : state.status === "failed" ? (
        <ErrorState
          title={failed}
          description={describe(state.error)}
          action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
        />
      ) : empty !== null ? (
        <p className="debate-form__hint">{empty}</p>
      ) : (
        <div className="debate-form__choices">{children}</div>
      )}
    </fieldset>
  );
}

function EstimateNote({
  picked,
  state,
  text,
}: {
  picked: boolean;
  state: "idle" | "loading" | "failed" | "ready";
  text: string | null;
}) {
  const t = useMessages("debates");
  const shown = !picked
    ? t("start.estimate.pick")
    : state === "ready" && text !== null
      ? text
      : state === "failed"
        ? t("start.estimate.failed")
        : t("start.estimate.loading");
  return (
    <p className="debate-form__estimate" role="status">
      {shown}
    </p>
  );
}
