// The Access section of the settings: every active agent in a row, every workspace connection in a
// column, and in each cell how far that agent reaches into it (nothing, reading, or reading and
// changing). "Everything" gives an agent all there is, present and future; turning it off spells out
// what it gave, so nothing changes until the person narrows a cell. Each agent's channel rules and its
// mailboxes and databases are on its own Access tab. Only someone who manages agents opens this section.
import { useApiQuery } from "@vanr/client/react";
import type { Agent, AgentAccess } from "@vanr/contract";
import { EmptyState, Select, SelectItem, Switch } from "@vanr/ui";
import type { ReactNode } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useAccessChange } from "./access-change.ts";
import { CONN_LEVELS } from "./levels.ts";
import { Block, PartError, PartLoading, useForgetReadOnLoss } from "./shared.tsx";

const READS = ["listAgents", "getAgentAccess"] as const;

export function AccessSection() {
  const t = useMessages("control");
  const { workspaceId } = useRouteParams("settings");
  const agents = useApiQuery("listAgents", { workspaceId });
  const live = (agents.data ?? []).filter((agent) => agent.archivedAt === null);
  // Every agent sees the same connections: the first agent's access gives the columns.
  const first = live[0];
  const columns = useApiQuery(
    "getAgentAccess",
    { workspaceId, agentId: first?.id ?? "" },
    { enabled: first !== undefined },
  );
  useForgetReadOnLoss(workspaceId, READS, agents.error ?? columns.error);

  let body: ReactNode;
  if (agents.isPending || (first !== undefined && columns.isPending)) body = <PartLoading />;
  else if (agents.isError)
    body = <PartError title={t("grid.failed")} error={agents.error} onRetry={() => void agents.refetch()} />;
  else if (first === undefined)
    body = <EmptyState title={t("grid.noAgents")} description={t("grid.noAgentsBody")} />;
  else if (columns.isError)
    body = (
      <PartError title={t("grid.failed")} error={columns.error} onRetry={() => void columns.refetch()} />
    );
  else {
    const connections = columns.data?.connectors ?? [];
    body = (
      <>
        {connections.length === 0 && (
          <EmptyState title={t("grid.noConnections")} description={t("grid.noConnectionsBody")} />
        )}
        <div className="grid-wrap">
          <table className="grid" aria-label={t("grid.title")}>
            <thead>
              <tr>
                <th scope="col">{t("grid.agent")}</th>
                <th scope="col">{t("grid.everything")}</th>
                {connections.map((connection) => (
                  <th key={connection.connectionId} scope="col">
                    {connection.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {live.map((agent) => (
                <AgentRow
                  key={`${workspaceId}/${agent.id}`}
                  workspaceId={workspaceId}
                  agent={agent}
                  columns={connections}
                />
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return (
    <Block title={t("grid.title")} lead={t("grid.lead")}>
      {body}
    </Block>
  );
}

function AgentRow({
  workspaceId,
  agent,
  columns,
}: {
  workspaceId: string;
  agent: Agent;
  /** The header's connections: each cell sits under its own column, whatever order this row's answer has. */
  columns: AgentAccess["connectors"];
}) {
  const t = useMessages("control");
  const access = useApiQuery("getAgentAccess", { workspaceId, agentId: agent.id });
  const change = useAccessChange(workspaceId, agent.id);
  const name = (
    <th scope="row">
      <AppLink
        className="app-link"
        route="agent"
        params={{ workspaceId, agentId: agent.id }}
        search={{ tab: "access" }}
      >
        {agent.name}
      </AppLink>
    </th>
  );
  if (access.isPending || access.isError)
    return (
      <tr>
        {name}
        <td colSpan={columns.length + 1}>
          {access.isPending ? (
            <span className="page__muted">{t("grid.loadingRow")}</span>
          ) : (
            <PartError
              title={t("grid.rowFailed", { agent: agent.name })}
              error={access.error}
              onRetry={() => void access.refetch()}
            />
          )}
        </td>
      </tr>
    );
  const current: AgentAccess = access.data;
  return (
    <tr data-everything={current.all} aria-busy={change.pending} onFocusCapture={change.onFocusCapture}>
      {name}
      <td>
        <Switch
          checked={current.all}
          disabled={change.pending}
          label={<span className="vr-visually-hidden">{t("grid.everythingFor", { agent: agent.name })}</span>}
          onCheckedChange={(on) => change.setEverything(on)}
        />
      </td>
      {columns.map((column) => {
        const connection = current.connectors.find((each) => each.connectionId === column.connectionId);
        // A connection this row's answer no longer has (removed meanwhile) gets no control.
        if (connection === undefined)
          return (
            <td key={column.connectionId} data-level="gone">
              <span className="page__muted">{t("grid.gone")}</span>
            </td>
          );
        return (
          <td key={column.connectionId} data-level={connection.state}>
            <Select
              size="sm"
              value={connection.state}
              disabled={current.all || change.pending}
              aria-label={t("grid.levelFor", { agent: agent.name, connection: column.label })}
              onValueChange={(next) => {
                const level = CONN_LEVELS.find((each) => each === next);
                if (level !== undefined && level !== connection.state) change.setLevel(connection, level);
              }}
            >
              {CONN_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`grid.level.${level}`)}
                </SelectItem>
              ))}
              {connection.state === "custom" && (
                <SelectItem value="custom" disabled>
                  {t("grid.level.custom")}
                </SelectItem>
              )}
            </Select>
          </td>
        );
      })}
    </tr>
  );
}
