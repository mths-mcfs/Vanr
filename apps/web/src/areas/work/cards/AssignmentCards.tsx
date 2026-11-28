// The cards an assignment puts in front of people: a decision to take, a review of a change, a result to
// accept, a command waiting for leave to run, and the answer to a suggestion. Each card takes the workspace,
// the assignment and what the person may do on it (`act`: the owner and whoever decides; `comment`: whoever
// may weigh in); the server decides, these only hide. The chat mounts them under the messages that carry them.
import { isApiError } from "@vanr/client";
import { useApiMutation } from "@vanr/client/react";
import type {
  AssignmentCommand,
  AssignmentDecision,
  AssignmentReview,
  AssignmentSubmission,
} from "@vanr/contract";
import { Button, Checkbox, Chip, Field, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useMessages } from "../../../i18n/react.tsx";
import { assignmentKeys, REVIEW_NOTE_MAX, useAssignmentRefresh } from "../assignments/shared.tsx";
import { useOutcome } from "../issues/shared.tsx";
import { RichText, safeHref } from "../RichText.tsx";

/** What the person may do on the assignment a card belongs to. */
export type CardRights = { act: boolean; comment: boolean };
type CardBase = { workspaceId: string; assignmentId: string; rights: CardRights };

function useCardMutation<M extends Parameters<typeof useApiMutation>[0]>(method: M, base: CardBase) {
  const outcome = useOutcome();
  const refresh = useAssignmentRefresh(base.workspaceId, base.assignmentId);
  return useApiMutation(method, {
    invalidates: () => assignmentKeys(base.workspaceId, base.assignmentId),
    onError: (error) => {
      outcome.failed(error);
      // Someone else answered first: the card loads again and shows what they chose.
      if (isApiError(error) && error.status === 409) refresh();
    },
  });
}

export function DecisionCard({ decision, ...base }: CardBase & { decision: AssignmentDecision }) {
  const t = useMessages("work");
  const choose = useCardMutation("chooseAssignmentDecision", base);
  const lean = useCardMutation("opinionAssignmentDecision", base);
  const open = decision.status !== "taken";
  const args = { workspaceId: base.workspaceId, assignmentId: base.assignmentId, decisionId: decision.id };
  return (
    <article className="work-card-box work-card-box--decision" aria-label={t("card.decision")}>
      <header className="work-card-box__head">
        <span className="work-card-box__kind">{t("card.decision")}</span>
        {decision.status === "taken" && decision.chosen !== null && (
          <Chip>{t("card.decision.chosen", { option: decision.chosen })}</Chip>
        )}
        {decision.status === "provisional" && decision.chosen !== null && (
          <Chip>{t("card.decision.provisional", { option: decision.chosen })}</Chip>
        )}
      </header>
      <p className="work-card-box__title">{decision.question}</p>
      {decision.why !== null && (
        <p>
          <strong>{t("card.decision.why")}:</strong> {decision.why}
        </p>
      )}
      {decision.impact !== null && (
        <p>
          <strong>{t("card.decision.impact")}:</strong> {decision.impact}
        </p>
      )}
      <ul className="work-card-box__options">
        {decision.options.map((option) => (
          <li key={option}>
            <span className={option === decision.chosen ? "work-option is-chosen" : "work-option"}>
              {option}
            </span>
            {option === decision.recommendation && <Chip>{t("card.decision.recommended")}</Chip>}
            {open && base.rights.act && (
              <Button
                size="sm"
                loading={choose.isPending && choose.variables?.body.option === option}
                disabled={choose.isPending}
                onClick={() => choose.mutate({ ...args, body: { option } })}
              >
                {t("card.decision.choose", { option })}
              </Button>
            )}
            {open && !base.rights.act && base.rights.comment && (
              <Button
                size="sm"
                variant="ghost"
                disabled={lean.isPending}
                onClick={() => lean.mutate({ ...args, body: { option } })}
              >
                {t("card.decision.lean", { option })}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function ReviewCard({ review, ...base }: CardBase & { review: AssignmentReview }) {
  const t = useMessages("work");
  const [note, setNote] = useState("");
  const decide = useCardMutation("runActionOnAssignmentReview", base);
  const href = review.prUrl === null ? undefined : safeHref(review.prUrl);
  const send = (action: "approve" | "changes") =>
    decide.mutate({
      workspaceId: base.workspaceId,
      assignmentId: base.assignmentId,
      reviewId: review.id,
      action,
      body: note.trim() === "" ? {} : { note: note.trim() },
    });
  return (
    <article
      className="work-card-box work-card-box--review"
      aria-label={`${t("card.review")}: ${review.title}`}
    >
      <header className="work-card-box__head">
        <span className="work-card-box__kind">{t("card.review")}</span>
        {review.status === "approved" && <Chip>{t("card.review.approved")}</Chip>}
        {review.status === "changes_requested" && <Chip>{t("card.review.changesAsked")}</Chip>}
      </header>
      <p className="work-card-box__title">{review.title}</p>
      <RichText text={review.summary} />
      {href !== undefined && (
        <a className="app-link" href={href} target="_blank" rel="noopener noreferrer">
          {t("card.review.pr")}
        </a>
      )}
      {review.note !== null && review.status !== "pending" && <p className="page__muted">{review.note}</p>}
      {review.status === "pending" && base.rights.act && (
        <>
          <Field label={t("card.review.note")}>
            <Textarea
              rows={2}
              value={note}
              maxLength={REVIEW_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="work-card-box__actions">
            <Button variant="primary" size="sm" loading={decide.isPending} onClick={() => send("approve")}>
              {t("card.review.approve")}
            </Button>
            {/* Asking for changes says what to change: the server refuses it without a note. */}
            <Button
              size="sm"
              disabled={decide.isPending || note.trim() === ""}
              onClick={() => send("changes")}
            >
              {t("card.review.changes")}
            </Button>
          </div>
        </>
      )}
    </article>
  );
}

export function SubmissionCard({ submission, ...base }: CardBase & { submission: AssignmentSubmission }) {
  const t = useMessages("work");
  const [toWiki, setToWiki] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const tick = useCardMutation("replaceAssignmentSubmissionChecklist", base);
  const accept = useCardMutation("acceptAssignmentSubmission", base);
  const change = useCardMutation("requestAssignmentSubmissionChanges", base);
  const args = {
    workspaceId: base.workspaceId,
    assignmentId: base.assignmentId,
    submissionId: submission.id,
  };
  const pending = submission.status === "pending";
  return (
    <article className="work-card-box work-card-box--submission" aria-label={t("card.submission")}>
      <header className="work-card-box__head">
        <span className="work-card-box__kind">{t("card.submission")}</span>
        {submission.status === "accepted" && <Chip>{t("card.submission.accepted")}</Chip>}
        {submission.status === "superseded" && <Chip>{t("card.submission.superseded")}</Chip>}
      </header>
      <RichText text={submission.note} />
      {submission.status === "changes_requested" && submission.changesNote !== null && (
        <p className="page__muted">{t("card.submission.changesAsked", { note: submission.changesNote })}</p>
      )}
      <ul className="work-checklist">
        {submission.checklist.map((item) => (
          <li key={item.id}>
            <Checkbox
              label={item.text}
              checked={item.verifiedBy !== null}
              disabled={!pending || !base.rights.act || tick.isPending}
              onCheckedChange={(checked) =>
                tick.mutate({ ...args, itemId: item.id, body: { checked: checked === true } })
              }
            />
          </li>
        ))}
      </ul>
      {pending && base.rights.act && (
        <>
          <Checkbox
            label={t("card.submission.wiki")}
            checked={toWiki}
            onCheckedChange={(checked) => setToWiki(checked === true)}
          />
          {asking && (
            <Field label={t("card.submission.changesNote")} required>
              <Textarea
                rows={2}
                value={note}
                maxLength={REVIEW_NOTE_MAX}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          )}
          <div className="work-card-box__actions">
            <Button
              variant="primary"
              size="sm"
              loading={accept.isPending}
              onClick={() => accept.mutate({ ...args, body: { copyToWiki: toWiki } })}
            >
              {t("card.submission.accept")}
            </Button>
            <Button
              size="sm"
              disabled={change.isPending || (asking && note.trim() === "")}
              onClick={() =>
                asking ? change.mutate({ ...args, body: { note: note.trim() } }) : setAsking(true)
              }
            >
              {t("card.submission.changes")}
            </Button>
          </div>
        </>
      )}
    </article>
  );
}

export function CommandCard({ command, ...base }: CardBase & { command: AssignmentCommand }) {
  const t = useMessages("work");
  const decide = useCardMutation("decideAssignmentCommand", base);
  const retry = useCardMutation("retryAssignmentCommand", base);
  const args = { workspaceId: base.workspaceId, assignmentId: base.assignmentId, commandId: command.id };
  return (
    <article className="work-card-box work-card-box--command" aria-label={t("card.command")}>
      <header className="work-card-box__head">
        <span className="work-card-box__kind">{t("card.command")}</span>
        {command.state !== "pending" && <Chip>{t(`card.command.${command.state}`)}</Chip>}
      </header>
      <code className="work-code">{command.command}</code>
      {command.state === "pending" && base.rights.act && (
        <div className="work-card-box__actions">
          <Button
            variant="primary"
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ ...args, body: { decision: "allow" } })}
          >
            {t("card.command.allow")}
          </Button>
          <Button
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ ...args, body: { decision: "always" } })}
          >
            {t("card.command.always")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ ...args, body: { decision: "deny" } })}
          >
            {t("card.command.deny")}
          </Button>
        </div>
      )}
      {command.state === "denied" && base.rights.act && (
        <Button
          size="sm"
          loading={retry.isPending}
          onClick={() =>
            retry.mutate({
              workspaceId: base.workspaceId,
              assignmentId: base.assignmentId,
              body: { jobId: command.jobId, commands: [command.command] },
            })
          }
        >
          {t("card.command.retry")}
        </Button>
      )}
    </article>
  );
}

/** The answer to a change an agent suggested in the conversation (the chat draws the suggestion itself). */
export function SuggestionActions(props: CardBase & { suggestionId: string }) {
  // One per suggestion: an answer given to one never shows on another the chat mounts in its place.
  return (
    <SuggestionAnswer key={`${props.workspaceId}/${props.assignmentId}/${props.suggestionId}`} {...props} />
  );
}

function SuggestionAnswer({ suggestionId, ...base }: CardBase & { suggestionId: string }) {
  const t = useMessages("work");
  const answer = useCardMutation("runActionOnAssignmentSuggestion", base);
  if (answer.data !== undefined) return <Chip>{t(`card.suggestion.${answer.data.status}`)}</Chip>;
  if (!base.rights.act) return null;
  const send = (action: "accept" | "decline") =>
    answer.mutate({ workspaceId: base.workspaceId, assignmentId: base.assignmentId, suggestionId, action });
  return (
    <div className="work-card-box__actions">
      <Button size="sm" variant="primary" disabled={answer.isPending} onClick={() => send("accept")}>
        {t("card.suggestion.accept")}
      </Button>
      <Button size="sm" variant="ghost" disabled={answer.isPending} onClick={() => send("decline")}>
        {t("card.suggestion.decline")}
      </Button>
    </div>
  );
}
