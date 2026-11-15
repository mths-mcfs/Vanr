import { useApiQuery } from "@vanr/client/react";
import { can } from "@vanr/contract";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { agentsAtWork } from "../../frame/at-work.ts";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

/**
 * The start of a workspace, in sentences: who works here, who is working now and what waits for
 * you. A workspace that is still just its creator also gets the first steps.
 */
export function HomeScreen() {
  const t = useMessages("shell");
  const { locale } = useLocale();
  const { workspaceId } = useRouteParams("home");
  const { me } = useSession();
  const overview = useApiQuery("getOverview", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  const runs = useApiQuery("listActiveRuns", { workspaceId });
  const workspace = me?.workspaces.find((candidate) => candidate.id === workspaceId);
  useDocumentTitle(t("route.home"));

  if (overview.isPending || agents.isPending || runs.isPending) return <ScreenLoading />;
  if (overview.isError) return <ScreenError error={overview.error} onRetry={() => void overview.refetch()} />;
  if (agents.isError) return <ScreenError error={agents.error} onRetry={() => void agents.refetch()} />;
  if (runs.isError) return <ScreenError error={runs.error} onRetry={() => void runs.refetch()} />;

  const working = agentsAtWork(agents.data, runs.data);
  const names = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    working.map((agent) => agent.name),
  );
  const { people, agents: agentCount, myApprovalQueue, budgetSpentPct } = overview.data;
  const justStarted = people <= 1 || agentCount === 0;
  const seesBudget = workspace !== undefined && can(workspace.role, "view_usage") && budgetSpentPct > 0;

  return (
    <div className="page">
      <h1 className="page__title">{workspace?.name}</h1>
      <p className="page__lead">
        {t("home.census", {
          people: t("home.people", { count: people }),
          agents: t("home.agents", { count: agentCount }),
        })}{" "}
        {working.length === 0 ? t("home.idle") : t("home.working", { count: working.length, names })}
        {myApprovalQueue > 0 && <> {t("home.approvals", { count: myApprovalQueue })}</>}
        {seesBudget && <> {t("home.budget", { percent: Math.round(budgetSpentPct) })}</>}
      </p>
      {justStarted && (
        <section className="page__section" aria-labelledby="home-start">
          <h2 className="page__heading" id="home-start">
            {t("home.start.title")}
          </h2>
          <ul className="page__steps">
            <li>
              <AppLink className="app-link" route="agentNew" params={{ workspaceId }}>
                {t("home.start.agent")}
              </AppLink>
              <span>{t("home.start.agentWhy")}</span>
            </li>
            <li>
              <AppLink className="app-link" route="settings" params={{ workspaceId, section: "members" }}>
                {t("home.start.invite")}
              </AppLink>
              <span>{t("home.start.inviteWhy")}</span>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
