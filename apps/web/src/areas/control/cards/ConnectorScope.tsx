// "The agent needs more access": a connected service turned a call down for a missing permission,
// and whoever may grant it does so from the conversation. For a workspace account that is whoever
// configures connectors; for the agent's own account, its owner or someone who manages agents (the
// server checks the same). Granting goes to the service's consent page and comes back here. The raw
// permissions are listed for whoever wants to check them.
import { useApiMutation } from "@vanr/client/react";
import { can, type MessageMeta } from "@vanr/contract";
import { AgentSigil, Button, StatusBadge } from "@vanr/ui";
import { useMessages } from "../../../i18n/react.tsx";
import { type Directory, type Me, mayManageAgents, useOutcome } from "../shared.tsx";

export type ScopeCard = NonNullable<MessageMeta["connectorScope"]>;

export function ConnectorScopeCard({
  workspaceId,
  card,
  agentId,
  me,
  directory,
}: {
  workspaceId: string;
  card: ScopeCard;
  agentId: string;
  me: Me;
  directory: Directory;
}) {
  const t = useMessages("control");
  const outcome = useOutcome();
  const grant = useApiMutation("createConnectorScope");
  const pending = card.state !== "granted";
  const mayGrant =
    card.owner === "workspace"
      ? can(me.role, "configure")
      : mayManageAgents(me) || directory.agentOwner(agentId) === me.userId;
  const agent = directory.agentName(agentId);
  const title = t(card.owner === "agent" ? "scope.titleOwn" : "scope.title", { agent, service: card.label });

  const onGrant = () =>
    grant.mutate(
      {
        workspaceId,
        connectorId: card.connectionId,
        body: { nextPath: `${window.location.pathname}${window.location.search}` },
      },
      {
        onSuccess: ({ consentUrl }) => window.location.assign(consentUrl),
        onError: (error) => outcome.failed(error),
      },
    );

  return (
    <section className="control-card" data-open={pending || undefined} aria-label={title}>
      <header className="approval__head">
        <AgentSigil agentId={agentId} name="" aria-hidden="true" size="sm" />
        <span className="approval__asks">{title}</span>
        <StatusBadge
          status={pending ? "awaiting-approval" : "done"}
          label={pending ? t("scope.pending") : t("scope.granted")}
        />
      </header>
      <p className="control-card__text">{t("scope.body", { tool: card.tool })}</p>
      {card.scopes.length > 0 && (
        <p className="control-note">
          {t("scope.scopes")}: <code>{card.scopes.join(" ")}</code>
        </p>
      )}
      {pending &&
        (mayGrant ? (
          <div className="approval__actions">
            <Button variant="primary" loading={grant.isPending} onClick={onGrant}>
              {t("scope.grant")}
            </Button>
          </div>
        ) : (
          <p className="control-note">
            {t(card.owner === "workspace" ? "scope.askAdmin" : "scope.askOwner")}
          </p>
        ))}
    </section>
  );
}
