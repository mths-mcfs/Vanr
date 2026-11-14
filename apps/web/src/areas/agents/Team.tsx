// The worked example of an area's screen: the reserved route, data through the client's hooks, the
// three states (loading, failed, empty), text from the area's own messages and typed links. It has
// no real-time code: the run events refetch `listActiveRuns` through the client's invalidation
// table. Team.test.tsx beside it is the test to copy.

import { useApiQuery } from "@vanr/client/react";
import { AgentSigil, Button, EmptyState } from "@vanr/ui";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";

export function TeamScreen() {
  const t = useMessages("agents");
  const shell = useMessages("shell");
  const go = useGo();
  const { workspaceId } = useRouteParams("agents");
  const agents = useApiQuery("listAgents", { workspaceId });
  const runs = useApiQuery("listActiveRuns", { workspaceId });
  useDocumentTitle(shell("route.agents"));

  if (agents.isPending || runs.isPending) return <ScreenLoading />;
  if (agents.isError || runs.isError) {
    const failed = agents.isError ? agents : runs;
    return (
      <ScreenError
        title={t("team.failed")}
        error={failed.error}
        onRetry={() => void failed.refetch()}
        namespace="agents"
      />
    );
  }
  const active = agents.data.filter((agent) => agent.archivedAt === null);
  const atWork = new Set(runs.data.map((run) => run.agentId));
  return (
    <div className="page">
      <h1 className="page__title">{shell("route.agents")}</h1>
      {active.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t("team.empty.title")}
          description={t("team.empty.body")}
          action={
            <Button variant="primary" onClick={() => void go("agentNew", { workspaceId })}>
              {t("team.empty.action")}
            </Button>
          }
        />
      ) : (
        <>
          <p className="page__muted">{t("team.count", { count: active.length })}</p>
          <ul className="listing" aria-label={t("team.list")}>
            {active.map((agent) => (
              <li key={agent.id} className="listing__row">
                <AgentSigil agentId={agent.id} name="" aria-hidden="true" working={atWork.has(agent.id)} />
                <AppLink
                  className="app-link listing__name"
                  route="agent"
                  params={{ workspaceId, agentId: agent.id }}
                >
                  {agent.name}
                </AppLink>
                <span className="listing__handle">@{agent.handle}</span>
                <span className="listing__state">
                  {t(atWork.has(agent.id) ? "team.working" : "team.idle")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
