// The proposals page: changes agents suggest to their instructions and to what the workspace
// remembers, the pending ones first and the newest first within each group, with a filter by agent.
// Creating one sends an event, deciding one does not, so the list is also read again every minute.
// The count under the title is what the person can still decide.
import { useApiQuery } from "@vanr/client/react";
import { EmptyState, Select, SelectItem } from "@vanr/ui";
import { useMemo } from "react";
import { z } from "zod";
import { useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { useDirectory } from "../shared.tsx";
import { ProposalCard } from "./ProposalCard.tsx";

const REFRESH_MS = 60_000;
const ALL = "all";
const Search = z.object({ agent: z.string().min(1).max(64).optional() });
const NO_SEARCH: z.infer<typeof Search> = {};

export function ProposalsScreen() {
  const t = useMessages("control");
  const shell = useMessages("shell");
  const go = useGo();
  const { workspaceId } = useRouteParams("proposals");
  const agent = useSearch(Search, NO_SEARCH).agent;
  const directory = useDirectory(workspaceId);
  const proposals = useApiQuery("listProposals", { workspaceId }, { refetchInterval: REFRESH_MS });
  useDocumentTitle(shell("route.proposals"));

  const sorted = useMemo(
    () =>
      [...(proposals.data ?? [])].sort(
        (a, b) =>
          Number(b.status === "pending") - Number(a.status === "pending") ||
          b.createdAt.localeCompare(a.createdAt),
      ),
    [proposals.data],
  );
  const shown = agent === undefined ? sorted : sorted.filter((proposal) => proposal.agentId === agent);
  const toDecide = (proposals.data ?? []).filter(
    (proposal) => proposal.status === "pending" && proposal.decidable && !proposal.stale,
  ).length;
  const proposers = directory.agents.filter((each) =>
    (proposals.data ?? []).some((p) => p.agentId === each.id),
  );

  return (
    <div className="page page--wide control">
      <header className="control__head">
        <div>
          <h1 className="page__title">{shell("route.proposals")}</h1>
          <p className="page__lead">{t("proposals.lead")}</p>
          {proposals.isSuccess && (
            <p className="page__muted" role="status">
              {toDecide === 0 ? t("proposals.nonePending") : t("proposals.pendingCount", { count: toDecide })}
            </p>
          )}
        </div>
        {proposers.length > 1 && (
          <Select
            aria-label={t("proposals.agentFilter")}
            value={agent ?? ALL}
            onValueChange={(next) =>
              void go(
                "proposals",
                { workspaceId },
                { search: next === ALL ? {} : { agent: next }, replace: true },
              )
            }
          >
            <SelectItem value={ALL}>{t("proposals.allAgents")}</SelectItem>
            {proposers.map((each) => (
              <SelectItem key={each.id} value={each.id}>
                {each.name}
              </SelectItem>
            ))}
          </Select>
        )}
      </header>
      {proposals.isPending ? (
        <ScreenLoading />
      ) : proposals.isError ? (
        <ScreenError
          title={t("proposals.failed")}
          error={proposals.error}
          onRetry={() => void proposals.refetch()}
          namespace="control"
        />
      ) : shown.length === 0 ? (
        agent !== undefined && sorted.length > 0 ? (
          <EmptyState
            title={t("empty.agent.title", { agent: directory.agentName(agent) })}
            description={t("empty.agent.body")}
          />
        ) : (
          <EmptyState title={t("empty.proposals.title")} description={t("empty.proposals.body")} />
        )
      ) : (
        <ul className="control-list control-list--single" aria-label={t("proposals.list")}>
          {shown.map((proposal) => (
            <li key={proposal.id}>
              <ProposalCard workspaceId={workspaceId} proposal={proposal} directory={directory} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
