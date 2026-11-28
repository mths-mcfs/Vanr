// The team: every agent of the workspace, grouped by the person who answers for it, at work or idle,
// with the delegations of the last day. Picking an agent opens its card beside the list (below it on a
// narrow screen); Escape closes it. Who is at work comes from the active runs, which the run events
// refetch; a delegation refetches the team, and one that arrives after the first load is marked new.
import { useApiQuery } from "@vanr/client/react";
import type { Team, TeamAgent } from "@vanr/contract";
import { AgentSigil, Button, Chip, EmptyState, Surface } from "@vanr/ui";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppLink, useGo, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useRelativeTime } from "../../i18n/relative-time.tsx";
import { useAgentRights } from "./shared.tsx";

type Group = { key: string; name: string | null; agents: TeamAgent[] };

/** The agents by owner, in the team's order of people; agents whose owner is not a member go last. */
export function groupByOwner(team: Team): Group[] {
  const groups: Group[] = [];
  for (const person of team.people) {
    const agents = team.agents.filter((agent) => agent.ownerUserId === person.userId);
    if (agents.length > 0) groups.push({ key: person.userId, name: person.name, agents });
  }
  const people = new Set(team.people.map((person) => person.userId));
  const orphans = team.agents.filter((agent) => !people.has(agent.ownerUserId));
  if (orphans.length > 0) groups.push({ key: "", name: null, agents: orphans });
  return groups;
}

const delegationKey = (delegation: Team["delegations"][number]) =>
  `${delegation.requesterAgentId}:${delegation.delegateAgentId}:${delegation.at}`;

export function TeamScreen() {
  const { workspaceId } = useRouteParams("agents");
  // Another workspace starts over: its delegations are not new, and no card stays open.
  return <TeamView key={workspaceId} workspaceId={workspaceId} />;
}

function TeamView({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("agents");
  const shell = useMessages("shell");
  const go = useGo();
  const rights = useAgentRights(workspaceId);
  const ago = useRelativeTime();
  const team = useApiQuery("getTeam", { workspaceId });
  const runs = useApiQuery("listActiveRuns", { workspaceId });
  const [selected, setSelected] = useState<string | null>(null);
  // The delegations known at the first answer; any other one is new to this visit.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null && team.data !== undefined) {
    seen.current = new Set(team.data.delegations.map(delegationKey));
  }
  useDocumentTitle(shell("route.agents"));

  useEffect(() => {
    if (selected === null) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  if (team.isPending || runs.isPending) return <ScreenLoading />;
  if (team.isError || runs.isError) {
    const failed = team.isError ? team : runs;
    return (
      <ScreenError
        title={t("team.failed")}
        error={failed.error}
        onRetry={() => void failed.refetch()}
        namespace="agents"
      />
    );
  }
  const atWork = new Set(runs.data.map((run) => run.agentId));
  const names = new Map(team.data.agents.map((agent) => [agent.id, agent.name]));
  const people = new Map(team.data.people.map((person) => [person.userId, person.name]));
  const card = team.data.agents.find((agent) => agent.id === selected);
  const add = rights.manage && (
    <Button variant="primary" onClick={() => void go("agentNew", { workspaceId })}>
      {t("team.add")}
    </Button>
  );

  return (
    <div className="page page--wide">
      <header className="agents-head">
        <h1 className="page__title">{shell("route.agents")}</h1>
        {team.data.agents.length > 0 && add}
      </header>
      {team.data.agents.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t("team.empty.title")}
          description={t(rights.manage ? "team.empty.body" : "team.empty.ask")}
          action={add || undefined}
        />
      ) : (
        <div className={card === undefined ? "team" : "team team--open"}>
          <div className="team__groups">
            <p className="page__muted">{t("team.count", { count: team.data.agents.length })}</p>
            {groupByOwner(team.data).map((group) => {
              const heading = group.name === null ? t("team.noOwner") : t("team.owner", { name: group.name });
              return (
                <section key={group.key} className="page__section" aria-label={heading}>
                  <h2 className="page__heading">{heading}</h2>
                  <ul className="listing listing--wide" aria-label={heading}>
                    {group.agents.map((agent) => (
                      <li key={agent.id} className="listing__row">
                        <AgentSigil
                          agentId={agent.id}
                          name=""
                          aria-hidden="true"
                          working={atWork.has(agent.id)}
                        />
                        <button
                          type="button"
                          className="app-link-button listing__name"
                          aria-pressed={selected === agent.id}
                          onClick={() => setSelected(selected === agent.id ? null : agent.id)}
                        >
                          {agent.name}
                        </button>
                        <span className="listing__handle">@{agent.handle}</span>
                        <span className="listing__state">
                          {t(atWork.has(agent.id) ? "team.working" : "team.idle")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <section className="page__section" aria-label={t("team.delegations")}>
              <h2 className="page__heading">{t("team.delegations")}</h2>
              {team.data.delegations.length === 0 ? (
                <p className="page__muted">{t("team.delegations.empty")}</p>
              ) : (
                <ul className="team__delegations" aria-label={t("team.delegations")}>
                  {team.data.delegations.map((delegation) => {
                    const fresh = seen.current !== null && !seen.current.has(delegationKey(delegation));
                    return (
                      <li
                        key={delegationKey(delegation)}
                        className={fresh ? "team__delegation--new" : undefined}
                      >
                        {t("team.delegation", {
                          from: names.get(delegation.requesterAgentId) ?? t("team.someAgent"),
                          to: names.get(delegation.delegateAgentId) ?? t("team.someAgent"),
                        })}{" "}
                        <span className="page__muted">
                          {t(`team.delegation.${delegation.status}`)} · {ago(delegation.at)}
                        </span>
                        {fresh && <Chip>{t("team.delegation.new")}</Chip>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
          {card !== undefined && (
            <AgentCard
              agent={card}
              owner={people.get(card.ownerUserId) ?? null}
              working={atWork.has(card.id)}
              workspaceId={workspaceId}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  owner,
  working,
  workspaceId,
  onClose,
}: {
  agent: TeamAgent;
  owner: string | null;
  working: boolean;
  workspaceId: string;
  onClose: () => void;
}) {
  const t = useMessages("agents");
  const common = useMessages("common");
  return (
    <Surface variant="card" className="team__card" role="region" aria-label={agent.name}>
      <header className="team__card-head">
        <AgentSigil agentId={agent.id} name="" aria-hidden="true" size="lg" working={working} />
        <div className="team__card-name">
          <h2 className="page__heading">{agent.name}</h2>
          <span className="listing__handle">@{agent.handle}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<X size={16} />}
          aria-label={common("action.close")}
          onClick={onClose}
        />
      </header>
      <dl className="agent-facts">
        <dt>{t("card.role")}</dt>
        <dd>{t(`role.${agent.role}`)}</dd>
        <dt>{t("card.owner")}</dt>
        <dd>{owner ?? t("team.noOwner")}</dd>
        <dt>{t("card.availability")}</dt>
        <dd>{t(working ? "team.working" : "team.idle")}</dd>
        {agent.useWhen !== "" && (
          <>
            <dt>{t("card.useWhen")}</dt>
            <dd>{agent.useWhen}</dd>
          </>
        )}
      </dl>
      <div className="section-form__actions">
        <AppLink className="app-link" route="agent" params={{ workspaceId, agentId: agent.id }}>
          {t("card.profile")}
        </AppLink>
        {agent.reachable && (
          <AppLink className="app-link" route="dmAgent" params={{ workspaceId, agentId: agent.id }}>
            {t("card.message", { name: agent.name })}
          </AppLink>
        )}
      </div>
    </Surface>
  );
}
