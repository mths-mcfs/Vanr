// An agent's profile: who it is, then one tab at a time (the open tab is in the address, `?tab=`).
// Everyone in the workspace reads it; the controls of each tab follow what the server lets the person
// change (see useAgentRights).
import { useApiQuery } from "@vanr/client/react";
import type { AgentDetail } from "@vanr/contract";
import { AgentSigil, Button, Callout, Chip, Tabs, TabsContent, TabsList, TabsTrigger } from "@vanr/ui";
import { Send } from "lucide-react";
import { z } from "zod";
import { AppLink, useGo, useRouteParams, useSearch } from "../../app/navigation.tsx";
import { ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { Activity } from "./Activity.tsx";
import { AgentSkills } from "./AgentSkills.tsx";
import { Harness } from "./Harness.tsx";
import { Instructions } from "./Instructions.tsx";
import { Lab } from "./Lab.tsx";
import { Settings } from "./Settings.tsx";
import { PartError, PartLoading, Section, useAgentRights } from "./shared.tsx";

export const TABS = ["overview", "instructions", "lab", "harness", "skills", "activity", "settings"] as const;
export type Tab = (typeof TABS)[number];
const TabSearch = z.object({ tab: z.enum(TABS).optional() });
const NO_TAB: z.infer<typeof TabSearch> = {};

export function ProfileScreen() {
  const { workspaceId, agentId } = useRouteParams("agent");
  // Another agent is another screen: nothing typed or picked for one carries over to the next.
  return <Profile key={`${workspaceId}/${agentId}`} workspaceId={workspaceId} agentId={agentId} />;
}

function Profile({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const t = useMessages("agents");
  const go = useGo();
  const tab: Tab = useSearch(TabSearch, NO_TAB).tab ?? "overview";
  // The client retries only what is worth retrying: an agent that does not exist is not.
  const agent = useApiQuery("getAgent", { workspaceId, agentId });
  const rights = useAgentRights(workspaceId, agent.data);
  useDocumentTitle(agent.data?.name ?? t("profile.title"));

  if (agent.isPending) return <ScreenLoading />;
  if (agent.isError) {
    return (
      <div className="page">
        <h1 className="page__title">{t("profile.title")}</h1>
        <PartError title={t("profile.failed")} error={agent.error} onRetry={() => void agent.refetch()} />
      </div>
    );
  }
  const a = agent.data;
  const archived = a.archivedAt !== null;
  return (
    <div className="page page--wide agent-page">
      <header className="agent-cover">
        <AgentSigil agentId={a.id} name="" aria-hidden="true" size="lg" working={a.busy} />
        <div className="agent-cover__text">
          <h1 className="page__title">{a.name}</h1>
          <p className="agent-cover__meta">
            <span className="agent-cover__handle">@{a.handle}</span>
            <span>{t(`role.${a.role}`)}</span>
            <HarnessLabel agent={a} />
            {a.busy && <Chip>{t("team.working")}</Chip>}
            {a.testModel && <Chip>{t("profile.testModel")}</Chip>}
          </p>
        </div>
        {a.reachable && !archived && (
          <Button
            variant="primary"
            icon={<Send size={16} />}
            onClick={() => void go("dmAgent", { workspaceId, agentId })}
          >
            {t("card.message", { name: a.name })}
          </Button>
        )}
      </header>
      {archived && <Callout tone="warning">{t("profile.archived")}</Callout>}
      <Tabs
        value={tab}
        onValueChange={(next) =>
          void go("agent", { workspaceId, agentId }, { search: { tab: next }, replace: true })
        }
      >
        <TabsList aria-label={t("profile.tabs")}>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`tab.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Overview agent={a} workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="instructions">
          <Instructions agent={a} workspaceId={workspaceId} rights={rights} />
        </TabsContent>
        <TabsContent value="lab">
          <Lab agent={a} workspaceId={workspaceId} rights={rights} />
        </TabsContent>
        <TabsContent value="harness">
          <Harness agent={a} workspaceId={workspaceId} rights={rights} />
        </TabsContent>
        <TabsContent value="skills">
          <AgentSkills agent={a} workspaceId={workspaceId} rights={rights} />
        </TabsContent>
        <TabsContent value="activity">
          <Activity agent={a} workspaceId={workspaceId} rights={rights} />
        </TabsContent>
        <TabsContent value="settings">
          <Settings agent={a} workspaceId={workspaceId} rights={rights} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** "Model · Claude Haiku 5.5", "Claude Code · on Studio Mac": what answers for the agent. */
function HarnessLabel({ agent }: { agent: AgentDetail }) {
  const t = useMessages("agents");
  const models = useApiQuery("listModels", {});
  const label = models.data?.models.find((model) => model.id === agent.harness.model)?.label;
  return (
    <span>
      {t(`harness.kind.${agent.harness.kind}`)}
      {label !== undefined && ` · ${label}`}
    </span>
  );
}

function Overview({ agent, workspaceId }: { agent: AgentDetail; workspaceId: string }) {
  const t = useMessages("agents");
  const channels = useApiQuery("listChannels", { workspaceId });
  const members = useApiQuery("listMembers", { workspaceId });
  const inbox = useApiQuery("getAgentInbox", { workspaceId, agentId: agent.id, query: { limit: 10 } });
  const names = new Map((channels.data ?? []).map((channel) => [channel.id, channel.name]));
  const owner = members.data?.find((member) => member.userId === agent.ownerUserId)?.name;
  return (
    <div className="agent-grid">
      <Section title={t("overview.month")}>
        <dl className="agent-facts">
          <dt>{t("overview.runs")}</dt>
          <dd>{agent.monthRuns}</dd>
          <dt>{t("overview.spent")}</dt>
          <dd>{t("overview.usd", { value: agent.costThisMonthUsd.toFixed(2) })}</dd>
          <dt>{t("overview.budget")}</dt>
          <dd>
            {t("overview.budgetUse", {
              percent: Math.round(agent.budgetSpentPct),
              budget: agent.budgetPerMonthUsd.toFixed(2),
            })}
          </dd>
        </dl>
      </Section>
      <Section title={t("overview.where")}>
        {agent.channels.length === 0 ? (
          <p className="page__muted">{t("overview.noChannels")}</p>
        ) : channels.isError ? (
          <PartError
            title={t("new.channelsFailed")}
            error={channels.error}
            onRetry={() => void channels.refetch()}
          />
        ) : (
          <ul className="agent-plain" aria-label={t("overview.where")}>
            {agent.channels.map((channel) => {
              const name = names.get(channel.id);
              return (
                <li key={channel.id}>
                  {/* A private channel the person is not in has no name or link for them. */}
                  {name !== undefined ? (
                    <AppLink
                      className="app-link"
                      route="channel"
                      params={{ workspaceId, channelId: channel.id }}
                    >
                      #{name}
                    </AppLink>
                  ) : (
                    <span className="page__muted">
                      {channels.isPending ? "…" : t("overview.privateChannel")}
                    </span>
                  )}
                  {channel.autoAnswer && <span className="page__muted"> · {t("overview.autoAnswer")}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <p className="page__muted">{t("overview.owner", { name: owner ?? "…" })}</p>
      </Section>
      <Section title={t("overview.forYou")}>
        {agent.queuedApprovals > 0 && (
          <AppLink className="app-link" route="approvals" params={{ workspaceId }}>
            {t("overview.approvals", { count: agent.queuedApprovals })}
          </AppLink>
        )}
        {inbox.isPending ? (
          <PartLoading />
        ) : inbox.isError ? (
          <PartError
            title={t("overview.forYouFailed")}
            error={inbox.error}
            onRetry={() => void inbox.refetch()}
          />
        ) : inbox.data.waiting.length === 0 && inbox.data.recent.length === 0 ? (
          <p className="page__muted">{t("overview.forYouEmpty")}</p>
        ) : (
          <ul className="agent-plain" aria-label={t("overview.forYou")}>
            {inbox.data.waiting.map((item) => (
              <li key={item.id}>
                <Chip>{t(`waiting.${item.kind}`)}</Chip> {item.title}
              </li>
            ))}
            {inbox.data.recent.map((item) => (
              <li key={item.runId}>
                <Chip>{t(`run.${item.status}`)}</Chip> {item.what}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
