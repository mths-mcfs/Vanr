// One issue: its description and acceptance criteria (checked here), what happened on it and the
// comments, and beside them its column, assignee, priority and due date, the agent's work, the pull
// requests, debates and sub-issues. It can be handed to an agent while it is open and no agent has it.
// A number that isn't one, or an issue the person can't see, reads as an issue that isn't here.
import { isApiError } from "@vanr/client";
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Issue, IssueActivity, IssueColumn, IssuePatch, IssuePriority } from "@vanr/contract";
import { Button, Checkbox, EmptyState, Field, Input, Select, SelectItem, Textarea } from "@vanr/ui";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useRelativeTime } from "../../../i18n/relative-time.tsx";
import { useDraft } from "../../../session/react.tsx";
import { PartError, PartLoading } from "../parts.tsx";
import { RichText, safeHref } from "../RichText.tsx";
import {
  type Actors,
  actorFromValue,
  actorValue,
  COMMENT_MAX,
  ISSUES_REFRESH_MS,
  isClosed,
  NOBODY,
  PRIORITIES,
  STAGES,
  StageDot,
  useActors,
  useColumnName,
  useOutcome,
} from "./shared.tsx";

const NUMBER = /^[1-9][0-9]{0,9}$/;

export function IssueScreen() {
  const { workspaceId, issueSeq } = useRouteParams("issue");
  return <IssueView key={`${workspaceId}/${issueSeq}`} workspaceId={workspaceId} issueSeq={issueSeq} />;
}

function Missing({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("work");
  return (
    <div className="page">
      <EmptyState
        className="page__narrow"
        title={t("issue.missing.title")}
        description={t("issue.missing.body")}
        action={
          <AppLink className="app-link" route="issues" params={{ workspaceId }}>
            {t("issue.back")}
          </AppLink>
        }
      />
    </div>
  );
}

function IssueView({ workspaceId, issueSeq }: { workspaceId: string; issueSeq: string }) {
  const t = useMessages("work");
  const valid = NUMBER.test(issueSeq);
  const issue = useApiQuery(
    "getIssueBySeq",
    { workspaceId, issueSeq },
    { enabled: valid, refetchInterval: ISSUES_REFRESH_MS },
  );
  useDocumentTitle(issue.data === undefined ? undefined : `#${issue.data.number} ${issue.data.title}`);
  if (!valid) return <Missing workspaceId={workspaceId} />;
  if (issue.isPending) return <ScreenLoading />;
  if (issue.isError && issue.data === undefined) {
    if (isApiError(issue.error) && issue.error.status === 404) return <Missing workspaceId={workspaceId} />;
    return (
      <ScreenError
        title={t("issue.failed")}
        error={issue.error}
        onRetry={() => void issue.refetch()}
        namespace="work"
      />
    );
  }
  return <IssuePage workspaceId={workspaceId} issue={issue.data} />;
}

function IssuePage({ workspaceId, issue }: { workspaceId: string; issue: Issue }) {
  const t = useMessages("work");
  const actors = useActors(workspaceId);
  const columns = useApiQuery("listIssueColumns", { workspaceId });
  const outcome = useOutcome();
  const refreshes = () => [
    { method: "getIssueBySeq" as const, args: { workspaceId, issueSeq: String(issue.number) } },
    { method: "getIssueActivity" as const, args: { workspaceId, issueId: issue.id } },
    { method: "listIssues" as const, args: { workspaceId } },
  ];
  const update = useApiMutation("updateIssue", {
    invalidates: refreshes,
    onError: (error) => outcome.failed(error),
  });
  const check = useApiMutation("replaceIssueCriterion", {
    invalidates: refreshes,
    onError: (error) => outcome.failed(error),
  });
  const patch = (body: IssuePatch) =>
    update.mutate(
      { workspaceId, issueId: issue.id, body },
      { onSuccess: () => outcome.done(t("issue.saved")) },
    );
  const open = !isClosed(issue.status);
  const column = columns.data?.find((each) => each.id === issue.columnId);
  const columnName = useColumnName();

  return (
    <div className="page page--wide work work-issue">
      <AppLink className="app-link work-issue__back" route="issues" params={{ workspaceId }}>
        <ArrowLeft size={14} aria-hidden="true" />
        {t("issue.back")}
      </AppLink>
      <header className="work-issue__head">
        <h1 className="page__title">
          <span className="work-issue__number">#{issue.number}</span> {issue.title}
        </h1>
        <p className="work-issue__state">
          <StageDot stage={issue.status} />
          {column === undefined ? t(`stage.${issue.status}`) : columnName(column)}
          <span className="page__muted">{t("issue.createdBy", { name: actors.name(issue.createdBy) })}</span>
        </p>
      </header>
      <div className="work-issue__layout">
        <div className="work-issue__main">
          {issue.description.trim() === "" ? (
            <p className="page__muted">{t("issue.noDescription")}</p>
          ) : (
            <RichText text={issue.description} />
          )}
          <section className="work-section" aria-label={t("issue.criteria")}>
            <h2 className="page__heading">{t("issue.criteria")}</h2>
            {issue.criteria.length === 0 ? (
              <p className="page__muted">{t("issue.noCriteria")}</p>
            ) : (
              <ul className="work-checklist">
                {issue.criteria.map((criterion) => (
                  <li key={criterion.id}>
                    <Checkbox
                      label={criterion.text}
                      checked={criterion.done}
                      disabled={check.isPending && check.variables?.criterionId === criterion.id}
                      onCheckedChange={(done) =>
                        check.mutate({
                          workspaceId,
                          issueId: issue.id,
                          criterionId: criterion.id,
                          body: { done: done === true },
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Activity workspaceId={workspaceId} issue={issue} actors={actors} />
        </div>
        <aside className="work-issue__side" aria-label={t("issue.details")}>
          {columns.isError && columns.data === undefined ? (
            <PartError
              title={t("issue.columnsFailed")}
              error={columns.error}
              onRetry={() => void columns.refetch()}
            />
          ) : (
            <Field label={t("issue.column")}>
              <Select
                value={issue.columnId}
                disabled={columns.data === undefined}
                onValueChange={(columnId) => patch({ columnId })}
              >
                {(columns.data ?? []).map((each: IssueColumn) => (
                  <SelectItem key={each.id} value={each.id}>
                    {columnName(each)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("issue.assignee")}>
            <Select
              value={actorValue(issue.assignee)}
              onValueChange={(value) => patch({ assignee: actorFromValue(value) })}
            >
              <SelectItem value={NOBODY}>{t("nobody")}</SelectItem>
              {issue.assignee !== null &&
                !actors.agents.some((agent) => actorValue(issue.assignee) === `agent:${agent.id}`) &&
                !actors.people.some((person) => actorValue(issue.assignee) === `person:${person.id}`) && (
                  <SelectItem value={actorValue(issue.assignee)}>{actors.name(issue.assignee)}</SelectItem>
                )}
              {actors.agents.map((agent) => (
                <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                  {`${agent.name} (@${agent.handle})`}
                </SelectItem>
              ))}
              {actors.people.map((person) => (
                <SelectItem key={person.id} value={`person:${person.id}`}>
                  {`${person.name} (@${person.handle})`}
                </SelectItem>
              ))}
            </Select>
          </Field>
          <Field label={t("issue.priority")}>
            <Select
              value={issue.priority}
              onValueChange={(value) => {
                const priority: IssuePriority | undefined = PRIORITIES.find((level) => level === value);
                if (priority !== undefined) patch({ priority });
              }}
            >
              {PRIORITIES.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`priority.${level}`)}
                </SelectItem>
              ))}
            </Select>
          </Field>
          <Field label={t("issue.due")}>
            <Input
              type="date"
              value={issue.dueDate ?? ""}
              onChange={(event) => patch({ dueDate: event.target.value === "" ? null : event.target.value })}
            />
          </Field>
          <Work issue={issue} actors={actors} />
          {open && issue.assignee?.type !== "agent" && actors.reachable.length > 0 && (
            <AskAgent workspaceId={workspaceId} issue={issue} actors={actors} />
          )}
          <Links workspaceId={workspaceId} issue={issue} />
        </aside>
      </div>
    </div>
  );
}

const REASONS = ["interrupted", "budget", "audience", "not_in_channel", "personal_plan"] as const;

function Work({ issue, actors }: { issue: Issue; actors: Actors }) {
  const t = useMessages("work");
  const work = issue.work;
  if (work === null || work.state === "idle") return null;
  const name = issue.assignee?.type === "agent" ? actors.name(issue.assignee) : t("someone");
  if (work.state === "working") {
    return (
      <p className="work-issue__work is-working" role="status">
        {t("issue.work.working", { name })}
      </p>
    );
  }
  // An unknown reason is a code meant for the server's logs: it is never shown as it came.
  const known = REASONS.find((reason) => reason === work.reason);
  return (
    <p className="work-issue__work is-blocked" role="status">
      {t("issue.work.blocked", {
        name,
        reason: t(known === undefined ? "reason.unknown" : `reason.${known}`),
      })}
    </p>
  );
}

function AskAgent({ workspaceId, issue, actors }: { workspaceId: string; issue: Issue; actors: Actors }) {
  const t = useMessages("work");
  const outcome = useOutcome();
  const [agentId, setAgentId] = useState("");
  const ask = useApiMutation("askIssueAgent", {
    invalidates: () => [
      { method: "getIssueBySeq", args: { workspaceId, issueSeq: String(issue.number) } },
      { method: "getIssueActivity", args: { workspaceId, issueId: issue.id } },
      { method: "listIssues", args: { workspaceId } },
    ],
    onError: (error) => outcome.failed(error),
  });
  return (
    <section className="work-issue__ask" aria-label={t("issue.ask")}>
      <h2 className="page__heading">{t("issue.ask")}</h2>
      <p className="page__muted">{t("issue.askHint")}</p>
      <Field label={t("issue.askPick")}>
        <Select value={agentId} onValueChange={setAgentId} placeholder={t("issue.askPick")}>
          {actors.reachable.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
        </Select>
      </Field>
      <Button
        disabled={agentId === ""}
        loading={ask.isPending}
        onClick={() =>
          ask.mutate(
            { workspaceId, issueId: issue.id, body: { agentId } },
            {
              onSuccess: () =>
                outcome.done(t("issue.asked", { name: actors.name({ type: "agent", id: agentId }) })),
            },
          )
        }
      >
        {t("issue.askSend")}
      </Button>
    </section>
  );
}

function Links({ workspaceId, issue }: { workspaceId: string; issue: Issue }) {
  const t = useMessages("work");
  return (
    <>
      {issue.pullRequests.length > 0 && (
        <section className="work-issue__links" aria-label={t("issue.pullRequests")}>
          <h2 className="page__heading">{t("issue.pullRequests")}</h2>
          <ul>
            {issue.pullRequests.map((address) => {
              const href = safeHref(address);
              return (
                <li key={address}>
                  {href === undefined ? (
                    <span>{address}</span>
                  ) : (
                    <a className="app-link" href={href} target="_blank" rel="noopener noreferrer">
                      {address}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {issue.debates.length > 0 && (
        <section className="work-issue__links" aria-label={t("issue.debates")}>
          <h2 className="page__heading">{t("issue.debates")}</h2>
          <ul>
            {issue.debates.map((debate) => (
              <li key={debate.id}>
                <AppLink className="app-link" route="debate" params={{ workspaceId, debateId: debate.id }}>
                  {debate.title}
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )}
      {issue.subIssues.length > 0 && (
        <section className="work-issue__links" aria-label={t("issue.subIssues")}>
          <h2 className="page__heading">{t("issue.subIssues")}</h2>
          <ul>
            {issue.subIssues.map((sub) => (
              <li key={sub.id}>
                <StageDot stage={sub.status} />
                <AppLink
                  className="app-link"
                  route="issue"
                  params={{ workspaceId, issueSeq: String(sub.number) }}
                >
                  #{sub.number} {sub.title}
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Activity({ workspaceId, issue, actors }: { workspaceId: string; issue: Issue; actors: Actors }) {
  const t = useMessages("work");
  const ago = useRelativeTime();
  const outcome = useOutcome();
  const activity = useApiQuery(
    "getIssueActivity",
    { workspaceId, issueId: issue.id },
    { refetchInterval: ISSUES_REFRESH_MS },
  );
  const [text, setText, discard] = useDraft(`work.issue-comment.${issue.id}`);
  const comment = useApiMutation("createIssueComment", {
    invalidates: () => [{ method: "getIssueActivity", args: { workspaceId, issueId: issue.id } }],
    onError: (error) => outcome.failed(error),
  });
  const line = useActivityLine(actors);
  const send = () => {
    const body = text.trim();
    if (body === "" || comment.isPending) return;
    comment.mutate(
      { workspaceId, issueId: issue.id, body: { text: body } },
      {
        onSuccess: () => {
          setText("");
          discard();
          outcome.done(t("issue.commented"));
        },
      },
    );
  };

  return (
    <section className="work-section" aria-label={t("issue.activity")}>
      <h2 className="page__heading">{t("issue.activity")}</h2>
      {activity.isPending ? (
        <PartLoading />
      ) : activity.isError && activity.data === undefined ? (
        <PartError
          title={t("issue.activityFailed")}
          error={activity.error}
          onRetry={() => void activity.refetch()}
        />
      ) : activity.data.length === 0 ? (
        <p className="page__muted">{t("issue.noActivity")}</p>
      ) : (
        <ol className="work-timeline">
          {activity.data.map((entry) =>
            entry.kind === "comment" ? (
              <li key={entry.id} className="work-timeline__comment">
                <p className="work-timeline__who">
                  <strong>{actors.name(entry.author)}</strong>{" "}
                  <time className="page__muted" dateTime={entry.createdAt}>
                    {ago(entry.createdAt)}
                  </time>
                </p>
                <RichText text={entry.text} />
              </li>
            ) : (
              <li key={entry.id} className="work-timeline__event">
                <span>{line(entry)}</span>{" "}
                <time className="page__muted" dateTime={entry.createdAt}>
                  {ago(entry.createdAt)}
                </time>
              </li>
            ),
          )}
        </ol>
      )}
      <form
        className="work-comment"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Field label={t("issue.comment")}>
          <Textarea
            rows={3}
            value={text}
            maxLength={COMMENT_MAX}
            placeholder={t("issue.commentPlaceholder")}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <div className="work-comment__send">
          <Button variant="primary" type="submit" disabled={text.trim() === ""} loading={comment.isPending}>
            {t("issue.commentSend")}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** A timeline event in the reader's language: the stages, priorities and people named, not coded. */
function useActivityLine(actors: Actors) {
  const t = useMessages("work");
  const stage = (value: unknown) => {
    const known = STAGES.find((each) => each === value);
    return known === undefined ? String(value ?? "") : t(`stage.${known}`);
  };
  const priority = (value: unknown) => {
    const known = PRIORITIES.find((each) => each === value);
    return known === undefined ? String(value ?? "") : t(`priority.${known}`);
  };
  return (entry: IssueActivity): string => {
    const who = actors.name(entry.author);
    const vars = entry.textVars ?? {};
    const text = (name: string) => String(vars[name] ?? "");
    switch (entry.event) {
      case "created":
        return t("event.created", { who });
      case "title":
        return t("event.title", { who, to: text("to") });
      case "description":
        return t("event.description", { who });
      case "status":
        return t("event.status", { who, from: stage(vars.from), to: stage(vars.to) });
      case "column":
        // A column with no name of its own is saved under its stage.
        return t("event.column", { who, column: stage(vars.column) });
      case "assigned": {
        const type = vars.type === "agent" ? "agent" : "person";
        return t("event.assigned", { who, to: actors.name({ type, id: text("id") }) });
      }
      case "unassigned":
        return t("event.unassigned", { who });
      case "priority":
        return t("event.priority", { who, from: priority(vars.from), to: priority(vars.to) });
      case "due":
        return text("date") === ""
          ? t("event.dueCleared", { who })
          : t("event.due", { who, date: text("date") });
      case "labels":
        return t("event.labels", { who });
      case "criterion_done":
        return t("event.criterion_done", { who, text: text("text") });
      case "criterion_undone":
        return t("event.criterion_undone", { who, text: text("text") });
      default:
        return t("event.other", { who, text: entry.text });
    }
  };
}
