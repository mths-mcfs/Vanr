// The assignments the person can see: the open ones, the ones waiting on them and the closed ones, each
// with its agent, where it lives, how far its plan went, the jobs running and what waits on the person.
// The search waits for the typing to pause and runs on the server. A new assignment opens on its page.
import { useApiQuery } from "@vanr/client/react";
import type { Assignment } from "@vanr/contract";
import { Button, Chip, EmptyState, Field, Input, Tabs, TabsList, TabsTrigger } from "@vanr/ui";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { type Actors, useActors } from "../issues/shared.tsx";
import { NewAssignmentDialog } from "./NewAssignment.tsx";
import { pendingOf } from "./shared.tsx";

const SEARCH_PAUSE_MS = 250;
const TABS = ["open", "blocked_on_you", "closed"] as const;
type Tab = (typeof TABS)[number];

export function AssignmentsScreen() {
  const { workspaceId } = useRouteParams("assignments");
  return <AssignmentsView key={workspaceId} workspaceId={workspaceId} />;
}

function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function AssignmentsView({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("work");
  const shell = useMessages("shell");
  const actors = useActors(workspaceId);
  const [tab, setTab] = useState<Tab>("open");
  const [text, setText] = useState("");
  const q = useSettled(text.trim(), SEARCH_PAUSE_MS);
  const [creating, setCreating] = useState(false);
  useDocumentTitle(shell("route.assignments"));
  const list = useApiQuery(
    "listAssignments",
    { workspaceId, query: { status: tab, ...(q !== "" && { q }) } },
    { placeholderData: (previous) => previous },
  );
  const channels = useApiQuery("listChannels", { workspaceId });

  if (list.isPending) return <ScreenLoading />;
  if (list.isError && list.data === undefined) {
    return (
      <ScreenError
        title={t("asg.failed")}
        error={list.error}
        onRetry={() => void list.refetch()}
        namespace="work"
      />
    );
  }
  const { counts, assignments } = list.data;
  const nothingYet = counts.active + counts.closed === 0 && q === "";
  const channelName = (id: string) => channels.data?.find((channel) => channel.id === id)?.name;
  const add = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
      {t("asg.new")}
    </Button>
  );

  return (
    <div className="page page--wide work">
      <header className="work__head">
        <div>
          <h1 className="page__title">{shell("route.assignments")}</h1>
          <p className="page__muted">{t("asg.lead")}</p>
        </div>
        {add}
      </header>
      {nothingYet ? (
        <EmptyState
          className="page__narrow"
          title={t("asg.empty.title")}
          description={t("asg.empty.body")}
          action={add}
        />
      ) : (
        <>
          <div className="work__tools">
            <Field label={t("asg.search")} className="work__search">
              <Input
                type="search"
                value={text}
                maxLength={200}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(TABS.find((each) => each === value) ?? "open")}
            >
              <TabsList aria-label={t("asg.tabs")}>
                <TabsTrigger value="open">{t("asg.tab.open", { count: counts.active })}</TabsTrigger>
                <TabsTrigger value="blocked_on_you">
                  {t("asg.tab.mine", { count: counts.blockedOnYou })}
                </TabsTrigger>
                <TabsTrigger value="closed">{t("asg.tab.closed", { count: counts.closed })}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {assignments.length === 0 ? (
            <p className="work-note">{t("asg.none")}</p>
          ) : (
            <ul className="work-assignments" aria-label={t("asg.list")}>
              {assignments.map((assignment) => (
                <li key={assignment.id}>
                  <AssignmentRow
                    workspaceId={workspaceId}
                    assignment={assignment}
                    actors={actors}
                    channelName={channelName}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {creating && (
        <NewAssignmentDialog workspaceId={workspaceId} actors={actors} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function AssignmentRow({
  workspaceId,
  assignment,
  actors,
  channelName,
}: {
  workspaceId: string;
  assignment: Assignment;
  actors: Actors;
  channelName: (id: string) => string | undefined;
}) {
  const t = useMessages("work");
  const channel = channelName(assignment.channelId);
  const { open, waiting } = pendingOf(assignment);
  return (
    <article
      className={`work-assignment work-assignment--${assignment.status}`}
      aria-label={assignment.title}
    >
      <div className="work-assignment__head">
        <AppLink
          className="work-assignment__title"
          route="assignment"
          params={{ workspaceId, assignmentId: assignment.id }}
        >
          {assignment.title}
        </AppLink>
        <Chip>{t(`asg.status.${assignment.status}`)}</Chip>
      </div>
      <p className="work-assignment__meta">
        <span>{actors.name({ type: "agent", id: assignment.agentId })}</span>
        <span>{channel === undefined ? t("asg.where.hidden") : t("asg.where.channel", { channel })}</span>
        {assignment.plan.total > 0 && (
          <span>{t("asg.progress", { done: assignment.plan.done, count: assignment.plan.total })}</span>
        )}
        {assignment.runningJobs > 0 && <span>{t("asg.jobs", { count: assignment.runningJobs })}</span>}
        {/* Only someone who may act is waited on; anyone else just sees how much is open. */}
        {waiting > 0 ? (
          <strong className="work-assignment__waiting">{t("asg.waiting", { count: waiting })}</strong>
        ) : (
          open > 0 && <span>{t("asg.open", { count: open })}</span>
        )}
      </p>
    </article>
  );
}
