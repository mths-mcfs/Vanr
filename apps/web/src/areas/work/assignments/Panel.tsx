// One assignment, as a panel the assignment page shows and the chat can mount beside a conversation: its
// state, the person's role, the plan's progress, the jobs running and what waits on the person, with
// start, pause, resume, stop and close for whoever may act. Below it, the summary, the plan, the trail,
// what waits on the person, the people on it and the files the agent wrote. The assignment's channel is
// followed, so its events refetch what they change.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Assignment } from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  Chip,
  Dialog,
  DialogContent,
  Field,
  Radio,
  RadioGroup,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@vanr/ui";
import { useState } from "react";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useChannelSubscription } from "../../../realtime/react.tsx";
import { type Actors, useActors, useOutcome } from "../issues/shared.tsx";
import { PartError, PartLoading } from "../parts.tsx";
import { Files, People, Plan, Summary, Trail, Waiting } from "./PanelParts.tsx";
import { assignmentKeys, CLOSE_NOTE_MAX, isClosedAssignment } from "./shared.tsx";

export function AssignmentPanel({
  workspaceId,
  assignmentId,
}: {
  workspaceId: string;
  assignmentId: string;
}) {
  const t = useMessages("work");
  const actors = useActors(workspaceId);
  const assignment = useApiQuery("getAssignment", { workspaceId, assignmentId });
  useChannelSubscription(assignment.data?.channelId);
  if (assignment.isPending) return <PartLoading />;
  if (assignment.isError && assignment.data === undefined) {
    return (
      <PartError
        title={t("asg.page.failed")}
        error={assignment.error}
        onRetry={() => void assignment.refetch()}
      />
    );
  }
  return <PanelBody workspaceId={workspaceId} assignment={assignment.data} actors={actors} />;
}

function PanelBody({
  workspaceId,
  assignment,
  actors,
}: {
  workspaceId: string;
  assignment: Assignment;
  actors: Actors;
}) {
  const t = useMessages("work");
  const { locale } = useLocale();
  const outcome = useOutcome();
  const [closing, setClosing] = useState(false);
  const act = useApiMutation("runActionOnAssignment", {
    invalidates: () => assignmentKeys(workspaceId, assignment.id),
    onError: (error) => outcome.failed(error),
  });
  const run = (action: "start" | "pause" | "resume" | "stop") =>
    act.mutate(
      { workspaceId, assignmentId: assignment.id, action },
      {
        onSuccess: (answer) => {
          if (action === "stop") outcome.done(t("asg.stopped", { count: answer.canceledJobs ?? 0 }));
          else
            outcome.done(
              t(action === "start" ? "asg.started" : action === "pause" ? "asg.paused" : "asg.resumed"),
            );
        },
      },
    );
  const closed = isClosedAssignment(assignment);
  const waiting = Object.values(assignment.pending).reduce((sum, count) => sum + count, 0);
  const rights = {
    act: assignment.actionable,
    comment: assignment.role !== null && assignment.role !== "view",
  };
  const due = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="work-panel" aria-label={t("asg.panel")}>
      <header className="work-panel__head">
        <div className="work-panel__chips">
          <Chip>{t(`asg.status.${assignment.status}`)}</Chip>
          {assignment.role !== null && <Chip>{t(`asg.role.${assignment.role}`)}</Chip>}
          {assignment.overdue && <Chip>{t("asg.overdue")}</Chip>}
          {assignment.stale && <Chip>{t("asg.stale")}</Chip>}
          {assignment.ceiling !== null && (
            <Chip>{t("asg.ceiling", { limit: t(`asg.limit.${assignment.ceiling}`) })}</Chip>
          )}
        </div>
        <p className="work-panel__facts">
          <span>{actors.name({ type: "agent", id: assignment.agentId })}</span>
          {assignment.plan.total > 0 && (
            <span>{t("asg.progress", { done: assignment.plan.done, total: assignment.plan.total })}</span>
          )}
          {assignment.runningJobs > 0 && <span>{t("asg.jobs", { count: assignment.runningJobs })}</span>}
          {waiting > 0 && <strong>{t("asg.waiting", { count: waiting })}</strong>}
          {assignment.dueAt !== null && (
            <span>{t("asg.due", { when: due.format(new Date(assignment.dueAt)) })}</span>
          )}
        </p>
        {assignment.pendingQuestion !== null && (
          <p className="work-note">{t("asg.question", { question: assignment.pendingQuestion })}</p>
        )}
        {!assignment.actionable && <p className="work-note">{t("asg.readOnly")}</p>}
        {assignment.actionable && !closed && (
          <div className="work-panel__actions">
            {assignment.status === "proposed" && (
              <Button variant="primary" loading={act.isPending} onClick={() => run("start")}>
                {t("asg.start")}
              </Button>
            )}
            {assignment.status === "active" && (
              <Button loading={act.isPending} onClick={() => run("pause")}>
                {t("asg.pause")}
              </Button>
            )}
            {assignment.status === "paused" && (
              <Button variant="primary" loading={act.isPending} onClick={() => run("resume")}>
                {t("asg.resume")}
              </Button>
            )}
            {assignment.runningJobs > 0 && (
              <Button variant="ghost" disabled={act.isPending} onClick={() => run("stop")}>
                {t("asg.stop")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setClosing(true)}>
              {t("asg.close")}
            </Button>
          </div>
        )}
      </header>
      <Tabs defaultValue="summary">
        <TabsList aria-label={t("asg.panel")}>
          <TabsTrigger value="summary">{t("asg.tab.summary")}</TabsTrigger>
          <TabsTrigger value="plan">{t("asg.tab.plan")}</TabsTrigger>
          <TabsTrigger value="trail">
            {t("asg.tab.trail")}
            {assignment.unseen > 0 && (
              <span className="work-badge">{t("asg.trail.new", { count: assignment.unseen })}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="waiting">{t("asg.tab.waiting")}</TabsTrigger>
          <TabsTrigger value="people">{t("asg.tab.people")}</TabsTrigger>
          <TabsTrigger value="files">{t("asg.tab.files")}</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <Summary workspaceId={workspaceId} assignment={assignment} />
        </TabsContent>
        <TabsContent value="plan">
          <Plan workspaceId={workspaceId} assignment={assignment} actors={actors} />
        </TabsContent>
        <TabsContent value="trail">
          <Trail workspaceId={workspaceId} assignment={assignment} actors={actors} />
        </TabsContent>
        <TabsContent value="waiting">
          <Waiting workspaceId={workspaceId} assignment={assignment} rights={rights} />
        </TabsContent>
        <TabsContent value="people">
          <People workspaceId={workspaceId} assignment={assignment} />
        </TabsContent>
        <TabsContent value="files">
          <Files workspaceId={workspaceId} assignment={assignment} />
        </TabsContent>
      </Tabs>
      {closing && (
        <CloseDialog workspaceId={workspaceId} assignment={assignment} onClose={() => setClosing(false)} />
      )}
    </section>
  );
}

function CloseDialog({
  workspaceId,
  assignment,
  onClose,
}: {
  workspaceId: string;
  assignment: Assignment;
  onClose: () => void;
}) {
  const t = useMessages("work");
  const common = useMessages("common");
  const outcome = useOutcome();
  const [ended, setEnded] = useState<"done" | "canceled">("done");
  const [note, setNote] = useState("");
  const [toWiki, setToWiki] = useState(false);
  const close = useApiMutation("closeAssignment", {
    invalidates: () => assignmentKeys(workspaceId, assignment.id),
    onError: (error) => outcome.failed(error),
  });
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t("asg.close.title")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={close.isPending}
              onClick={() =>
                close.mutate(
                  {
                    workspaceId,
                    assignmentId: assignment.id,
                    body: {
                      outcome: ended,
                      copyToWiki: toWiki,
                      ...(note.trim() !== "" && { note: note.trim() }),
                    },
                  },
                  {
                    onSuccess: () => {
                      outcome.done(t("asg.closed"));
                      onClose();
                    },
                  },
                )
              }
            >
              {t("asg.close.submit")}
            </Button>
          </>
        }
      >
        <div className="work-form">
          {assignment.runningJobs > 0 && (
            <Callout tone="warning">{t("asg.close.running", { count: assignment.runningJobs })}</Callout>
          )}
          <RadioGroup
            aria-label={t("asg.close.outcome")}
            value={ended}
            onValueChange={(value) => setEnded(value === "canceled" ? "canceled" : "done")}
          >
            <Radio value="done" label={t("asg.close.done")} />
            <Radio value="canceled" label={t("asg.close.canceled")} />
          </RadioGroup>
          <Field
            label={t("asg.close.note")}
            hint={t("asg.close.noteHint", { count: note.length, max: CLOSE_NOTE_MAX })}
          >
            <Textarea
              rows={3}
              value={note}
              maxLength={CLOSE_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <Checkbox
            label={t("asg.close.wiki")}
            checked={toWiki}
            onCheckedChange={(checked) => setToWiki(checked === true)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
