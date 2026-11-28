// The parts of an assignment's panel. Each loads its own data, with its own loading and failed states,
// so one that fails leaves the rest usable: the summary and its limits, the plan with a retry for a step
// that stalled or didn't pass the check, the trail (read up to its end once seen, older events on request),
// what waits on the person as cards, the people on it and their requests, and the files the agent wrote.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Assignment, AssignmentEvent, AssignmentEventKind, ParticipantRole } from "@vanr/contract";
import { Button, Chip, Select, SelectItem } from "@vanr/ui";
import { useEffect, useState } from "react";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import {
  type CardRights,
  CommandCard,
  DecisionCard,
  ReviewCard,
  SubmissionCard,
} from "../cards/AssignmentCards.tsx";
import { type Actors, useMyId, useOutcome } from "../issues/shared.tsx";
import { PartError, PartLoading } from "../parts.tsx";
import { assignmentKeys, useActorName } from "./shared.tsx";

type Part = { workspaceId: string; assignment: Assignment };
const TRAIL_PAGE = 50;

export function Summary({ workspaceId, assignment }: Part) {
  const t = useMessages("work");
  const { locale } = useLocale();
  const summary = useApiQuery("getAssignmentSummary", { workspaceId, assignmentId: assignment.id });
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  if (summary.isPending) return <PartLoading />;
  if (summary.isError && summary.data === undefined) {
    return (
      <PartError
        title={t("asg.summary.failed")}
        error={summary.error}
        onRetry={() => void summary.refetch()}
      />
    );
  }
  const { plan } = summary.data;
  const { usage, limits } = assignment;
  const meter = (used: string, limit: string | null) =>
    limit === null ? used : t("asg.summary.of", { used, limit });
  return (
    <div className="work-section">
      <p>
        {t("asg.summary.plan", {
          done: plan.done,
          total: plan.total,
          doing: plan.inProgress,
          waiting: plan.waiting,
        })}
      </p>
      <h3 className="work-subhead">{t("asg.summary.usage")}</h3>
      <dl className="work-facts">
        <dt>{t("asg.summary.usd")}</dt>
        <dd>
          {meter(usd.format(usage.dollars), limits.dollars === null ? null : usd.format(limits.dollars))}
        </dd>
        <dt>{t("asg.summary.steps")}</dt>
        <dd>{meter(String(usage.steps), limits.steps === null ? null : String(limits.steps))}</dd>
        <dt>{t("asg.summary.minutes")}</dt>
        <dd>
          {meter(String(Math.round(usage.minutes)), limits.minutes === null ? null : String(limits.minutes))}
        </dd>
      </dl>
      {assignment.findings.length > 0 && (
        <>
          <h3 className="work-subhead">{t("asg.summary.findings")}</h3>
          <ul>
            {assignment.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function Plan({ workspaceId, assignment, actors }: Part & { actors: Actors }) {
  const t = useMessages("work");
  const outcome = useOutcome();
  const who = useActorName(actors);
  const plan = useApiQuery("getAssignmentPlan", { workspaceId, assignmentId: assignment.id });
  const retry = useApiMutation("retryAssignmentItem", {
    invalidates: () => assignmentKeys(workspaceId, assignment.id),
    onError: (error) => outcome.failed(error),
    onSuccess: () => outcome.done(t("asg.plan.retried")),
  });
  if (plan.isPending) return <PartLoading />;
  if (plan.isError && plan.data === undefined) {
    return <PartError title={t("asg.plan.failed")} error={plan.error} onRetry={() => void plan.refetch()} />;
  }
  const current = plan.data.current;
  if (current === null || current.items.length === 0)
    return <p className="page__muted">{t("asg.plan.empty")}</p>;
  return (
    <div className="work-section">
      <p className="page__muted">{t("asg.plan.version", { version: current.version })}</p>
      <ol className="work-plan">
        {current.items.map((item) => {
          const retryable = assignment.actionable && (item.stallReason !== null || item.passes === false);
          return (
            <li key={item.id} className={`work-plan__item work-plan__item--${item.status}`}>
              <div className="work-plan__head">
                <span className="work-plan__title">{item.title}</span>
                <Chip>{t(`asg.item.${item.status}`)}</Chip>
                {item.passes === true && <Chip>{t("asg.plan.passed")}</Chip>}
                {item.passes === false && <Chip>{t("asg.plan.failedCheck")}</Chip>}
              </div>
              {item.criteria !== "" && <p className="page__muted">{item.criteria}</p>}
              {item.summary !== null && <p>{item.summary}</p>}
              <p className="work-plan__by">{who(item.updatedBy)}</p>
              {retryable && (
                <Button
                  size="sm"
                  loading={retry.isPending}
                  onClick={() => retry.mutate({ workspaceId, assignmentId: assignment.id, itemId: item.id })}
                >
                  {t("asg.plan.retry")}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const KNOWN_EVENTS = [
  "started",
  "paused",
  "resumed",
  "closed",
  "plan_edited",
  "item_started",
  "item_done",
  "item_stuck",
  "item_retry",
  "decision_asked",
  "decision_taken",
  "delivered",
  "validation_passed",
  "validation_failed",
  "job_done",
  "proof_added",
] as const satisfies readonly AssignmentEventKind[];

export function Trail({ workspaceId, assignment, actors }: Part & { actors: Actors }) {
  const t = useMessages("work");
  const ago = useRelativeTime();
  const who = useActorName(actors);
  const [before, setBefore] = useState<number | undefined>(undefined);
  const [older, setOlder] = useState<AssignmentEvent[]>([]);
  const latest = useApiQuery("listAssignmentEvents", {
    workspaceId,
    assignmentId: assignment.id,
    query: { limit: TRAIL_PAGE },
  });
  const page = useApiQuery(
    "listAssignmentEvents",
    {
      workspaceId,
      assignmentId: assignment.id,
      query: { limit: TRAIL_PAGE, ...(before !== undefined && { before }) },
    },
    { enabled: before !== undefined },
  );
  const seen = useApiMutation("markAssignmentSeen", {
    invalidates: () => [{ method: "getAssignment", args: { workspaceId, assignmentId: assignment.id } }],
  });
  const lastSeq = latest.data?.lastSeq;
  const seenSeq = latest.data?.seenSeq;
  // Opening the trail reads it up to its end.
  useEffect(() => {
    if (lastSeq === undefined || seenSeq === undefined || lastSeq <= seenSeq) return;
    seen.mutate({ workspaceId, assignmentId: assignment.id, body: { seq: lastSeq } });
    // `seen` is a new object each render; the read point is what matters.
    // biome-ignore lint/correctness/useExhaustiveDependencies: marking once per new end of the trail
  }, [lastSeq, seenSeq, workspaceId, assignment.id]);
  useEffect(() => {
    if (page.data === undefined || before === undefined) return;
    setOlder((current) => [
      ...page.data.events.filter((event) => !current.some((each) => each.seq === event.seq)),
      ...current,
    ]);
  }, [page.data, before]);

  if (latest.isPending) return <PartLoading />;
  if (latest.isError && latest.data === undefined) {
    return (
      <PartError title={t("asg.trail.failed")} error={latest.error} onRetry={() => void latest.refetch()} />
    );
  }
  const events = [
    ...older,
    ...latest.data.events.filter((event) => !older.some((each) => each.seq === event.seq)),
  ].sort((a, b) => b.seq - a.seq);
  if (events.length === 0) return <p className="page__muted">{t("asg.trail.empty")}</p>;
  const first = events[events.length - 1]?.seq ?? 0;
  const what = (kind: AssignmentEventKind) => {
    const known = KNOWN_EVENTS.find((each) => each === kind);
    return known === undefined ? t("asg.ev.other") : t(`asg.ev.${known}`);
  };
  return (
    <div className="work-section">
      <ol className="work-timeline">
        {events.map((event) => (
          <li
            key={event.seq}
            className={event.seq > (seenSeq ?? 0) ? "work-timeline__event is-new" : "work-timeline__event"}
          >
            <span>{t("event.asg", { who: who(event.actor), what: what(event.kind) })}</span>{" "}
            <time className="page__muted" dateTime={event.at}>
              {ago(event.at)}
            </time>
          </li>
        ))}
      </ol>
      {first > 1 && (
        <Button size="sm" variant="ghost" loading={page.isFetching} onClick={() => setBefore(first)}>
          {t("asg.trail.older")}
        </Button>
      )}
    </div>
  );
}

export function Waiting({ workspaceId, assignment, rights }: Part & { rights: CardRights }) {
  const t = useMessages("work");
  const outcome = useOutcome();
  const args = { workspaceId, assignmentId: assignment.id };
  const decisions = useApiQuery("listAssignmentDecisions", args);
  const reviews = useApiQuery("listAssignmentReviews", args);
  const submissions = useApiQuery("listAssignmentSubmissions", args);
  const commands = useApiQuery("listAssignmentCommands", args);
  const approve = useApiMutation("approveAssignmentDecisionProvisional", {
    invalidates: () => assignmentKeys(workspaceId, assignment.id),
    onError: (error) => outcome.failed(error),
  });
  const parts = [decisions, reviews, submissions, commands];
  if (parts.some((part) => part.isPending)) return <PartLoading />;
  const failed = parts.find((part) => part.isError && part.data === undefined);
  if (failed !== undefined) {
    return (
      <PartError title={t("asg.waiting.failed")} error={failed.error} onRetry={() => void failed.refetch()} />
    );
  }
  const base = { workspaceId, assignmentId: assignment.id, rights };
  const cards = [
    ...(decisions.data ?? []).map((decision) => (
      <DecisionCard key={decision.id} decision={decision} {...base} />
    )),
    ...(submissions.data ?? []).map((submission) => (
      <SubmissionCard key={submission.id} submission={submission} {...base} />
    )),
    ...(reviews.data ?? []).map((review) => <ReviewCard key={review.id} review={review} {...base} />),
    ...(commands.data?.commands ?? []).map((command) => (
      <CommandCard key={command.id} command={command} {...base} />
    )),
  ];
  return (
    <div className="work-section">
      {assignment.pending.provisional > 0 && rights.act && (
        <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate(args)}>
          {t("card.decision.approveAll")}
        </Button>
      )}
      {cards.length === 0 ? (
        <p className="page__muted">{t("asg.waiting.none")}</p>
      ) : (
        <div className="work-cards">{cards}</div>
      )}
    </div>
  );
}

const ROLES = ["decide", "comment"] as const satisfies readonly ParticipantRole[];

export function People({ workspaceId, assignment }: Part) {
  const t = useMessages("work");
  const outcome = useOutcome();
  const me = useMyId();
  const args = { workspaceId, assignmentId: assignment.id };
  const people = useApiQuery("listAssignmentParticipants", args);
  const requests = useApiQuery("listAssignmentJoinRequests", args, { enabled: assignment.manageable });
  const refresh = {
    invalidates: () => assignmentKeys(workspaceId, assignment.id),
    onError: (error: unknown) => outcome.failed(error),
  };
  const role = useApiMutation("updateAssignmentParticipant", {
    ...refresh,
    onSuccess: () => outcome.done(t("asg.people.changed")),
  });
  const remove = useApiMutation("deleteAssignmentParticipant", refresh);
  const ask = useApiMutation("createAssignmentJoinRequest", {
    ...refresh,
    onSuccess: () => outcome.done(t("asg.people.asked")),
  });
  const answer = useApiMutation("runActionOnAssignmentJoinRequest", refresh);
  if (people.isPending) return <PartLoading />;
  if (people.isError && people.data === undefined) {
    return (
      <PartError title={t("asg.people.failed")} error={people.error} onRetry={() => void people.refetch()} />
    );
  }
  const pending = (requests.data ?? []).filter((request) => request.status === "pending");
  return (
    <div className="work-section">
      <p>{t("asg.people.owner", { name: people.data.owner.name })}</p>
      <ul className="work-people">
        {people.data.participants.map((person) => (
          <li key={person.userId}>
            <span>{person.name}</span>
            {assignment.manageable ? (
              <Select
                aria-label={t("asg.people.role", { name: person.name })}
                value={person.role}
                onValueChange={(value) => {
                  const next = ROLES.find((each) => each === value);
                  if (next !== undefined)
                    role.mutate({ ...args, participantId: person.userId, body: { role: next } });
                }}
              >
                {ROLES.map((each) => (
                  <SelectItem key={each} value={each}>
                    {t(`asg.role.${each}`)}
                  </SelectItem>
                ))}
              </Select>
            ) : (
              <Chip>{t(`asg.role.${person.role}`)}</Chip>
            )}
            {(assignment.manageable || person.userId === me) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate({ ...args, participantId: person.userId })}
              >
                {person.userId === me ? t("asg.people.leave") : t("asg.people.remove", { name: person.name })}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {assignment.role === "view" &&
        (assignment.pendingJoin ? (
          <p className="page__muted">{t("asg.people.asked")}</p>
        ) : (
          <Button size="sm" loading={ask.isPending} onClick={() => ask.mutate(args)}>
            {t("asg.people.ask")}
          </Button>
        ))}
      {pending.length > 0 && (
        <>
          <h3 className="work-subhead">{t("asg.people.requests")}</h3>
          <ul className="work-people">
            {pending.map((request) => (
              <li key={request.userId}>
                <span>{request.name}</span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    answer.mutate({
                      ...args,
                      joinRequestId: request.userId,
                      action: "accept",
                      body: { role: "comment" },
                    })
                  }
                >
                  {t("asg.people.accept", { name: request.name })}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    answer.mutate({ ...args, joinRequestId: request.userId, action: "decline", body: {} })
                  }
                >
                  {t("asg.people.decline", { name: request.name })}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function Files({ workspaceId, assignment }: Part) {
  const t = useMessages("work");
  const files = useApiQuery("listAssignmentFiles", { workspaceId, assignmentId: assignment.id });
  if (files.isPending) return <PartLoading />;
  if (files.isError && files.data === undefined) {
    return (
      <PartError title={t("asg.files.failed")} error={files.error} onRetry={() => void files.refetch()} />
    );
  }
  const all = [
    ...files.data.files.map((file) => ({ name: file.name, text: file.content })),
    ...files.data.editedOnRunner.map((file) => ({ name: file.name, text: file.diff })),
  ];
  if (all.length === 0) return <p className="page__muted">{t("asg.files.empty")}</p>;
  return (
    <div className="work-section">
      {all.map((file) => (
        <details key={file.name} className="work-file">
          <summary>{file.name}</summary>
          <pre className="work-code">{file.text}</pre>
        </details>
      ))}
    </div>
  );
}
