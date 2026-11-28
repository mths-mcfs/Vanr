// What an agent may reach of the workspace: everything, or the built-in areas (memory, drive, tasks,
// calendar…) one by one and each workspace connection at a level. Everyone in the workspace reads it;
// whoever manages agents changes it, and the settings' Access matrix shows the same thing for every
// agent at once.
import { useApiQuery } from "@vanr/client/react";
import type { AgentAccess, AgentDetail } from "@vanr/contract";
import { Checkbox, Select, SelectItem, Switch } from "@vanr/ui";
import { useMessages } from "../../i18n/react.tsx";
import { useAccessChange } from "../control/connections/access-change.ts";
import { CONN_LEVELS } from "../control/connections/levels.ts";
import { type AgentRights, PartError, PartLoading } from "./shared.tsx";

/** The built-in areas, in the order the server lists them. */
const AREAS = [
  "context",
  "drive",
  "issues",
  "calendar",
  "wiki",
  "skills",
  "schedule",
  "debate",
  "bases",
] as const;

export function Reach({
  agent,
  workspaceId,
  rights,
}: {
  agent: AgentDetail;
  workspaceId: string;
  rights: AgentRights;
}) {
  const t = useMessages("agents");
  const access = useApiQuery("getAgentAccess", { workspaceId, agentId: agent.id });
  if (access.isPending) return <PartLoading />;
  if (access.isError)
    return <PartError title={t("reach.failed")} error={access.error} onRetry={() => void access.refetch()} />;
  return <ReachForm agent={agent} workspaceId={workspaceId} rights={rights} access={access.data} />;
}

function ReachForm({
  agent,
  workspaceId,
  rights,
  access,
}: {
  agent: AgentDetail;
  workspaceId: string;
  rights: AgentRights;
  access: AgentAccess;
}) {
  const t = useMessages("agents");
  const change = useAccessChange(workspaceId, agent.id);
  const edit = rights.editAll;
  const locked = !edit || change.pending;
  const enabled = new Map(access.builtins.map((each) => [each.scope, each.enabled]));
  const areas = AREAS.filter((area) => enabled.has(`${area}:read`));
  return (
    <div className="reach">
      <Switch
        checked={access.all}
        disabled={locked}
        label={t("reach.everything")}
        hint={t(access.all ? "reach.everythingOn" : "reach.everythingOff")}
        onCheckedChange={(on) => change.setEverything(access, on)}
      />
      <fieldset className="reach__group" disabled={access.all}>
        <legend className="page__heading">{t("reach.areas")}</legend>
        <ul className="reach__list" aria-label={t("reach.areas")}>
          {areas.map((area) => {
            const write = `${area}:write`;
            return (
              <li key={area} className="reach__row">
                <span className="reach__name">{t(`reach.area.${area}`)}</span>
                <Checkbox
                  checked={enabled.get(`${area}:read`) === true}
                  disabled={locked || access.all}
                  label={t("reach.read")}
                  aria-label={t("reach.readArea", { area: t(`reach.area.${area}`) })}
                  onCheckedChange={(on) => change.setBuiltin(`${area}:read`, on === true)}
                />
                {enabled.has(write) && (
                  <Checkbox
                    checked={enabled.get(write) === true}
                    disabled={locked || access.all}
                    label={t("reach.change")}
                    aria-label={t("reach.changeArea", { area: t(`reach.area.${area}`) })}
                    onCheckedChange={(on) => change.setBuiltin(write, on === true)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
      <fieldset className="reach__group" disabled={access.all}>
        <legend className="page__heading">{t("reach.connections")}</legend>
        {access.connectors.length === 0 ? (
          <p className="page__muted">{t("reach.noConnections")}</p>
        ) : (
          <ul className="reach__list" aria-label={t("reach.connections")}>
            {access.connectors.map((connection) => (
              <li key={connection.connectionId} className="reach__row">
                <span className="reach__name">{connection.label}</span>
                {edit ? (
                  <Select
                    size="sm"
                    value={connection.state}
                    disabled={locked || access.all}
                    aria-label={t("reach.levelOf", { connection: connection.label })}
                    onValueChange={(next) => {
                      const level = CONN_LEVELS.find((each) => each === next);
                      if (level !== undefined && level !== connection.state)
                        change.setLevel(connection, level);
                    }}
                  >
                    {CONN_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(`reach.level.${level}`)}
                      </SelectItem>
                    ))}
                    {connection.state === "custom" && (
                      <SelectItem value="custom" disabled>
                        {t("reach.level.custom")}
                      </SelectItem>
                    )}
                  </Select>
                ) : (
                  <span className="reach__level">{t(`reach.level.${connection.state}`)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {!edit && <p className="page__muted">{t("reach.readOnly")}</p>}
    </div>
  );
}
