// The approvals page: what agents asked a person for, waiting or decided, with a search over the
// agent, the request and its text. A request that was waiting while the page is open stays under
// "Waiting" once decided, by this person or anyone else, so the decision and its receipt show where
// it was made. Beside it, the "always allow" rules the person answers for and,
// for people who see usage, the gate's numbers. The approval events refetch the list through the
// client's invalidation table; each card follows its conversation, so people who don't decide see
// the decision land too.
import { useApiQuery } from "@vanr/client/react";
import { can } from "@vanr/contract";
import { EmptyState, Input, Tabs, TabsList, TabsTrigger } from "@vanr/ui";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useLookup, useMessages } from "../../../i18n/react.tsx";
import { approvalTitle } from "../format.ts";
import { useDirectory, useMe } from "../shared.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { RulesPanel, StatsPanel } from "./Rules.tsx";

const SHOWS = ["pending", "decided"] as const;
const Search = z.object({ show: z.enum(SHOWS).optional() });
const NO_SEARCH: z.infer<typeof Search> = {};

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export function ApprovalsScreen() {
  const t = useMessages("control");
  const shell = useMessages("shell");
  const lookup = useLookup("control");
  const go = useGo();
  const { workspaceId } = useRouteParams("approvals");
  const show = useSearch(Search, NO_SEARCH).show ?? "pending";
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query.trim());
  const me = useMe(workspaceId);
  const directory = useDirectory(workspaceId);
  const approvals = useApiQuery("listApprovals", { workspaceId });
  const seenPending = useRef(new Set<string>());
  for (const approval of approvals.data ?? [])
    if (approval.status === "pending") seenPending.current.add(approval.id);
  const channels = useApiQuery("listChannels", { workspaceId });
  useDocumentTitle(shell("route.approvals"));
  const readable = useMemo(
    () => new Set((channels.data ?? []).map((channel) => channel.id)),
    [channels.data],
  );

  const shown = useMemo(() => {
    const words = fold(typed).split(/\s+/).filter(Boolean);
    const inTab = (approvals.data ?? []).filter((approval) =>
      show === "pending" ? seenPending.current.has(approval.id) : approval.status !== "pending",
    );
    if (words.length === 0) return inTab;
    return inTab.filter((approval) => {
      const text = fold(
        [
          approvalTitle(approval, lookup),
          directory.agentName(approval.agentId),
          approval.detail,
          approval.why,
        ].join(" "),
      );
      return words.every((word) => text.includes(word));
    });
  }, [approvals.data, show, typed, lookup, directory]);

  const waiting = (approvals.data ?? []).filter(
    (approval) => approval.status === "pending" && approval.decidable,
  ).length;

  return (
    <div className="page page--wide control">
      <header className="control__head">
        <div>
          <h1 className="page__title">{shell("route.approvals")}</h1>
          <p className="page__lead">{t("approvals.lead")}</p>
          {approvals.isSuccess && (
            <p className="page__muted" role="status">
              {waiting === 0 ? t("approvals.nonePending") : t("approvals.pendingCount", { count: waiting })}
            </p>
          )}
        </div>
      </header>
      <div className="control__layout">
        <div className="control__main">
          <div className="control__tools">
            <Tabs
              value={show}
              onValueChange={(next) => {
                const chosen = SHOWS.find((candidate) => candidate === next);
                if (chosen !== undefined)
                  void go("approvals", { workspaceId }, { search: { show: chosen }, replace: true });
              }}
            >
              <TabsList aria-label={t("approvals.filters")}>
                {SHOWS.map((name) => (
                  <TabsTrigger key={name} value={name}>
                    {t(`filter.${name}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Input
              type="search"
              className="control__search"
              aria-label={t("search.label")}
              placeholder={t("search.placeholder")}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {approvals.isPending ? (
            <ScreenLoading />
          ) : approvals.isError ? (
            <ScreenError
              title={t("approvals.failed")}
              error={approvals.error}
              onRetry={() => void approvals.refetch()}
              namespace="control"
            />
          ) : shown.length === 0 ? (
            typed !== "" ? (
              <EmptyState
                title={t("empty.search.title", { query: typed })}
                description={t("empty.search.body")}
              />
            ) : (
              <EmptyState title={t(`empty.${show}.title`)} description={t(`empty.${show}.body`)} />
            )
          ) : (
            <ul className="control-list" aria-label={t("approvals.list")}>
              {shown.map((approval) => (
                <li key={approval.id}>
                  <ApprovalCard
                    workspaceId={workspaceId}
                    approval={approval}
                    me={me}
                    directory={directory}
                    readableChannels={readable}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside className="control__side">
          <RulesPanel workspaceId={workspaceId} directory={directory} />
          {can(me.role, "view_usage") && <StatsPanel workspaceId={workspaceId} />}
        </aside>
      </div>
    </div>
  );
}
