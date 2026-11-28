// A new issue: its title, a description whose list lines become acceptance criteria, the column it
// starts in (never a finished one), who it goes to and its priority. Only agents the person may set
// to work are offered, because the server starts one as soon as the issue is created.
import { useApiMutation } from "@vanr/client/react";
import type { IssueColumn, IssuePriority } from "@vanr/contract";
import { Button, Callout, Dialog, DialogContent, Field, Input, Select, SelectItem, Textarea } from "@vanr/ui";
import { useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import {
  type Actors,
  actorFromValue,
  CRITERIA_MAX,
  CRITERION_MAX,
  DESCRIPTION_MAX,
  isClosed,
  NOBODY,
  PRIORITIES,
  splitCriteria,
  TITLE_MAX,
  useColumnName,
  useOutcome,
} from "./shared.tsx";

export function NewIssueDialog({
  workspaceId,
  columns,
  actors,
  onClose,
}: {
  workspaceId: string;
  columns: IssueColumn[];
  actors: Actors;
  onClose: () => void;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const describe = useErrorMessage("work");
  const outcome = useOutcome();
  const columnName = useColumnName();
  const open = columns.filter((column) => !isClosed(column.stage));
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [columnId, setColumnId] = useState(
    open.find((column) => column.stage === "todo")?.id ?? open[0]?.id ?? "",
  );
  const [assignee, setAssignee] = useState(NOBODY);
  const [priority, setPriority] = useState<IssuePriority>("none");
  const create = useApiMutation("createIssue", {
    invalidates: () => [{ method: "listIssues", args: { workspaceId } }],
  });

  const split = splitCriteria(text);
  const problem =
    split.criteria.length > CRITERIA_MAX
      ? t("new.tooManyCriteria", { max: CRITERIA_MAX })
      : split.criteria.some((criterion) => criterion.length > CRITERION_MAX)
        ? t("new.criterionTooLong", { max: CRITERION_MAX })
        : split.description.length > DESCRIPTION_MAX
          ? t("new.chars", { count: split.description.length, max: DESCRIPTION_MAX })
          : undefined;
  const ready = title.trim() !== "" && problem === undefined && !create.isPending;

  const submit = () => {
    if (!ready) return;
    create.mutate(
      {
        workspaceId,
        body: {
          title: title.trim(),
          ...(split.description !== "" && { description: split.description }),
          ...(split.criteria.length > 0 && { criteria: split.criteria }),
          ...(columnId !== "" && { columnId }),
          ...(priority !== "none" && { priority }),
          assignee: actorFromValue(assignee),
        },
      },
      {
        onSuccess: (issue) => {
          outcome.done(t("new.created", { number: issue.number }));
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="lg"
        title={t("new.title")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="work-new-issue"
              disabled={!ready}
              loading={create.isPending}
            >
              {t("new.submit")}
            </Button>
          </>
        }
      >
        <form
          id="work-new-issue"
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            label={t("new.issueTitle")}
            required
            hint={t("new.chars", { count: title.length, max: TITLE_MAX })}
          >
            <Input
              value={title}
              maxLength={TITLE_MAX}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field
            label={t("new.description")}
            hint={
              split.criteria.length > 0
                ? `${t("new.descriptionHint")} ${t("new.criteriaFound", { count: split.criteria.length })}`
                : t("new.descriptionHint")
            }
            {...(problem !== undefined && { error: problem })}
          >
            <Textarea rows={7} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
          <div className="work-form__row">
            <Field label={t("new.column")}>
              <Select value={columnId} onValueChange={setColumnId}>
                {open.map((column) => (
                  <SelectItem key={column.id} value={column.id}>
                    {columnName(column)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field label={t("new.priority")}>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(PRIORITIES.find((level) => level === value) ?? "none")}
              >
                {PRIORITIES.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`priority.${level}`)}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t("new.assignee")} hint={t("new.assigneeHint")}>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectItem value={NOBODY}>{t("nobody")}</SelectItem>
              {actors.reachable.map((agent) => (
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
