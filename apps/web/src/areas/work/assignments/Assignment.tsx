// One assignment's page: its title, a way back to the list, and its panel. One the person can't see (a
// private channel they don't read, or none at all) reads as an assignment that isn't here.
import { isApiError } from "@vanr/client";
import { useApiQuery } from "@vanr/client/react";
import { EmptyState } from "@vanr/ui";
import { ArrowLeft } from "lucide-react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { AssignmentPanel } from "./Panel.tsx";

export function AssignmentScreen() {
  const { workspaceId, assignmentId } = useRouteParams("assignment");
  return (
    <AssignmentView
      key={`${workspaceId}/${assignmentId}`}
      workspaceId={workspaceId}
      assignmentId={assignmentId}
    />
  );
}

function AssignmentView({ workspaceId, assignmentId }: { workspaceId: string; assignmentId: string }) {
  const t = useMessages("work");
  const shell = useMessages("shell");
  const assignment = useApiQuery("getAssignment", { workspaceId, assignmentId });
  useDocumentTitle(assignment.data?.title ?? shell("route.assignment"));
  const back = (
    <AppLink className="app-link work-issue__back" route="assignments" params={{ workspaceId }}>
      <ArrowLeft size={14} aria-hidden="true" />
      {t("asg.page.back")}
    </AppLink>
  );
  if (assignment.isPending) return <ScreenLoading />;
  if (assignment.isError && isApiError(assignment.error) && assignment.error.status === 404) {
    return (
      <div className="page">
        <h1 className="page__title">{shell("route.assignment")}</h1>
        <EmptyState
          className="page__narrow"
          title={t("asg.page.missing.title")}
          description={t("asg.page.missing.body")}
          action={back}
        />
      </div>
    );
  }
  if (assignment.isError && assignment.data === undefined) {
    return (
      <ScreenError
        title={t("asg.page.failed")}
        error={assignment.error}
        onRetry={() => void assignment.refetch()}
        namespace="work"
      />
    );
  }
  return (
    <div className="page page--wide work work-issue">
      {back}
      <header className="work-issue__head">
        <h1 className="page__title">{assignment.data.title}</h1>
        <p className="page__muted">{assignment.data.goal}</p>
      </header>
      <AssignmentPanel workspaceId={workspaceId} assignmentId={assignmentId} />
    </div>
  );
}
