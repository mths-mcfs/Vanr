// The agent's question in the middle of a run, as the conversation shows it: the agent, the question
// and its choices. Only the person who was asked answers (anyone, for a question no person asked),
// by a choice here or by replying in the conversation. While a choice is on its way the others wait
// and the chosen one shows its progress. `question.closed` refetches the conversation, which closes
// the card.
import { useApiMutation } from "@vanr/client/react";
import type { AgentQuestion } from "@vanr/contract";
import { AgentSigil, Button, StatusBadge } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { type Directory, type Me, useOutcome } from "../shared.tsx";

export function QuestionCard({
  workspaceId,
  question,
  me,
  directory,
}: {
  workspaceId: string;
  question: AgentQuestion;
  me: Me;
  directory: Directory;
}) {
  const t = useMessages("control");
  const describe = useErrorMessage("control");
  const outcome = useOutcome();
  const [sending, setSending] = useState<string | null>(null);
  const answer = useApiMutation("answerQuestion", {
    invalidates: () => [
      { method: "listChannelMessages", args: { workspaceId, channelId: question.channelId } },
    ],
  });
  const open = question.status === "open";
  const mine = question.askedUserId === null || question.askedUserId === me.userId;
  const title = t("question.label", { agent: directory.agentName(question.agentId) });

  const choose = (choice: string) => {
    setSending(choice);
    answer.mutate(
      { workspaceId, questionId: question.id, body: { choice } },
      {
        onError: (error) => outcome.warn(t("question.failed", { error: describe(error) })),
        onSettled: () => setSending(null),
      },
    );
  };

  return (
    <section className="control-card" data-open={open || undefined} aria-label={title}>
      <header className="approval__head">
        <AgentSigil agentId={question.agentId} name="" aria-hidden="true" size="sm" />
        <span className="approval__asks">{title}</span>
        {open && <StatusBadge status="awaiting-reply" label={t("question.waiting")} />}
      </header>
      <p className="control-card__text">{question.text}</p>
      {question.choices.length > 0 && (
        <fieldset className="control-choices">
          <legend className="vr-visually-hidden">{t("question.choices")}</legend>
          {question.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={question.answer === choice ? "primary" : "secondary"}
              aria-pressed={question.answer === choice}
              disabled={!open || !mine || (sending !== null && sending !== choice)}
              loading={sending === choice}
              onClick={() => choose(choice)}
            >
              {choice}
            </Button>
          ))}
        </fieldset>
      )}
      <p className="control-note">
        {question.status === "answered"
          ? t("question.answered", {
              name: directory.personName(question.responderUserId),
              answer: question.answer ?? "",
            })
          : question.status === "expired"
            ? t("question.expired")
            : mine
              ? t("question.orReply")
              : t("question.waitingFor", { name: directory.personName(question.askedUserId) })}
      </p>
    </section>
  );
}
