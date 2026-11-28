// The workspace's skills this agent may use, each one turned on or off. Whoever edits the agent changes
// them; everyone else sees which are on. The catalog itself is the skills page.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentDetail } from "@vanr/contract";
import { EmptyState, Switch } from "@vanr/ui";
import type { ReactNode } from "react";
import { AppLink } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { type AgentRights, PartError, PartLoading, Section, useOutcome } from "./shared.tsx";

export function AgentSkills({
  agent,
  workspaceId,
  rights,
}: {
  agent: AgentDetail;
  workspaceId: string;
  rights: AgentRights;
}) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const args = { workspaceId, agentId: agent.id };
  const skills = useApiQuery("listAgentSkills", args);
  const set = useApiMutation("setAgentSkills", {
    invalidates: () => [{ method: "listAgentSkills" as const, args }],
  });
  const link = (
    <AppLink className="app-link" route="skills" params={{ workspaceId }}>
      {t("skills.open")}
    </AppLink>
  );
  let body: ReactNode;
  if (skills.isPending) body = <PartLoading />;
  else if (skills.isError)
    body = (
      <PartError title={t("agentSkills.failed")} error={skills.error} onRetry={() => void skills.refetch()} />
    );
  else if (skills.data.length === 0)
    body = (
      <EmptyState title={t("agentSkills.empty")} description={t("agentSkills.emptyBody")} action={link} />
    );
  else
    body = (
      <>
        <ul className="agent-picks" aria-label={t("agentSkills.title")}>
          {skills.data.map((skill) => (
            <li key={skill.id}>
              <Switch
                label={skill.name}
                hint={skill.description}
                checked={skill.enabled}
                disabled={!rights.editLook || set.isPending}
                onCheckedChange={(enabled) =>
                  set.mutate(
                    { ...args, body: { skills: [{ id: skill.id, enabled }] } },
                    {
                      onSuccess: () =>
                        outcome.done(t(enabled ? "agentSkills.on" : "agentSkills.off", { name: skill.name })),
                      onError: outcome.failed,
                    },
                  )
                }
              />
            </li>
          ))}
        </ul>
        {link}
      </>
    );
  return (
    <Section title={t("agentSkills.title")} help={t("agentSkills.help")}>
      {body}
    </Section>
  );
}
