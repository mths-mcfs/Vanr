// The worked example of an area's screen: the reserved route, data through the API layer, the
// three states (loading, failed, empty), text from the area's own messages, a real-time refresh
// and typed links. Team.test.tsx beside it is the test to copy.
import { AgentSigil, Button, EmptyState } from "@vanr/ui";
import { useApiQuery } from "../../api/index.ts";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useInvalidateOn } from "../../realtime/react.tsx";

export function TeamScreen() {
  const t = useMessages("agents");
  const shell = useMessages("shell");
  const go = useGo();
  const { workspaceId } = useRouteParams("agents");
  const agents = useApiQuery("listAgents", { workspaceId });
  // An agent starting or finishing a run changes who is working.
  useInvalidateOn(["run.status_changed", "run.completed"], "listAgents", { workspaceId });
  useDocumentTitle(shell("route.agents"));

  if (agents.isPending) return <ScreenLoading />;
  if (agents.isError) {
    return (
      <ScreenError
        title={t("team.failed")}
        error={agents.error}
        onRetry={() => void agents.refetch()}
        namespace="agents"
      />
    );
  }
  const active = agents.data.agents.filter((agent) => agent.archivedAt === null);
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
                <AgentSigil agentId={agent.id} name="" aria-hidden="true" working={agent.busy} />
                <AppLink
                  className="app-link listing__name"
                  route="agent"
                  params={{ workspaceId, agentId: agent.id }}
                >
                  {agent.name}
                </AppLink>
                <span className="listing__handle">@{agent.handle}</span>
                <span className="listing__state">{t(agent.busy ? "team.working" : "team.idle")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
