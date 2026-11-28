// The agent's name, role, owner, appearance and audience, and archiving it. Whoever manages agents
// changes all of it; the owner changes only the appearance and the audience (the server's rule, so the
// save sends nothing else for them). An archived agent is read-only.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { AgentAppearance, AgentAudience, AgentDetail, AgentRole } from "@vanr/contract";
import { Button, ConfirmDialog, Field, Input, Select, SelectItem } from "@vanr/ui";
import { useState } from "react";
import { useGo } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { AppearanceFields, AudienceFields } from "./fields.tsx";
import { type AgentRights, NAME_MAX, PartError, ROLES, Section, useOutcome } from "./shared.tsx";

type Props = { agent: AgentDetail; workspaceId: string; rights: AgentRights };

export function Settings(props: Props) {
  const { agent } = props;
  return (
    <>
      <Form
        key={JSON.stringify([agent.name, agent.role, agent.ownerUserId, agent.appearance, agent.audience])}
        {...props}
      />
      {props.rights.manage && agent.archivedAt === null && <Archive {...props} />}
    </>
  );
}

function Form({ agent, workspaceId, rights }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const members = useApiQuery("listMembers", { workspaceId });
  const save = useApiMutation("updateAgent", {
    invalidates: () => [
      { method: "getAgent" as const, args: { workspaceId, agentId: agent.id } },
      { method: "getTeam" as const, args: { workspaceId } },
      { method: "listAgents" as const, args: { workspaceId } },
    ],
  });
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [owner, setOwner] = useState(agent.ownerUserId);
  const [appearance, setAppearance] = useState<AgentAppearance>(agent.appearance);
  const [audience, setAudience] = useState<AgentAudience>(agent.audience);
  const missingPeople = audience.mode === "people" && audience.userIds.length === 0;
  const valid = name.trim() !== "" && !missingPeople;

  return (
    <Section title={t("settings.title")} help={rights.editAll ? undefined : t("settings.ownerOnly")}>
      <form
        className="section-form"
        aria-label={t("settings.title")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          save.mutate(
            {
              workspaceId,
              agentId: agent.id,
              body: rights.editAll
                ? { name: name.trim(), role, ownerUserId: owner, appearance, audience }
                : { appearance, audience },
            },
            { onSuccess: () => outcome.done(t("settings.saved")), onError: outcome.failed },
          );
        }}
      >
        <Field label={t("field.name")}>
          <Input
            value={name}
            maxLength={NAME_MAX}
            readOnly={!rights.editAll || save.isPending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t("card.role")}>
          <Select
            value={role}
            disabled={!rights.editAll || save.isPending}
            onValueChange={(next) => setRole(ROLES.find((option) => option === next) ?? role)}
          >
            {ROLES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`role.${option}`)}
              </SelectItem>
            ))}
          </Select>
        </Field>
        {members.isError ? (
          <PartError
            title={t("new.membersFailed")}
            error={members.error}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <>
            <Field label={t("field.owner")}>
              <Select
                value={owner}
                disabled={!rights.editAll || members.isPending || save.isPending}
                onValueChange={setOwner}
              >
                {(members.data ?? []).map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.name}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <AudienceFields
              value={audience}
              onChange={setAudience}
              people={members.data ?? []}
              disabled={!rights.editLook || save.isPending}
            />
          </>
        )}
        <AppearanceFields
          value={appearance}
          onChange={setAppearance}
          disabled={!rights.editLook || save.isPending}
        />
        {rights.editLook && (
          <div className="section-form__actions">
            <Button type="submit" variant="primary" disabled={!valid} loading={save.isPending}>
              {t("settings.save")}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}

function Archive({ agent, workspaceId }: Props) {
  const t = useMessages("agents");
  const outcome = useOutcome();
  const go = useGo();
  const [asking, setAsking] = useState(false);
  const archive = useApiMutation("deleteAgent", {
    invalidates: () => [
      { method: "getTeam" as const, args: { workspaceId } },
      { method: "listAgents" as const, args: { workspaceId } },
    ],
  });
  return (
    <Section title={t("settings.archive")} help={t("settings.archiveHelp")}>
      <div>
        <Button variant="danger" onClick={() => setAsking(true)}>
          {t("settings.archiveAction", { name: agent.name })}
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        tone="danger"
        title={t("settings.archiveTitle", { name: agent.name })}
        description={t("settings.archiveBody", { handle: agent.handle })}
        confirmLabel={t("settings.archiveAction", { name: agent.name })}
        cancelLabel={t("instructions.discard")}
        confirming={archive.isPending}
        onConfirm={() =>
          archive.mutate(
            { workspaceId, agentId: agent.id },
            {
              onSuccess: () => {
                outcome.done(t("settings.archived", { name: agent.name }));
                void go("agents", { workspaceId });
              },
              onError: (error) => {
                setAsking(false);
                outcome.failed(error);
              },
            },
          )
        }
      />
    </Section>
  );
}
