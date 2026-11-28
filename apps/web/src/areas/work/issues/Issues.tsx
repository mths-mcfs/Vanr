// The workspace's issues, as a board by column (the first view) or as a list. The search runs on the
// server; who the issue is with and the canceled ones are filtered here. A card moved on the board
// shows in its new place at once and stays there if the server agrees; if not, it goes back and a
// toast says so. The columns refetch on their own event; the issues every minute and on every change.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Issue, IssueColumn } from "@vanr/contract";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@vanr/ui";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppLink, useRouteParams } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";
import { Board, type Move } from "./Board.tsx";
import { NewIssueDialog } from "./NewIssue.tsx";
import {
  type Actors,
  CriteriaMark,
  ISSUES_REFRESH_MS,
  PriorityMark,
  SEARCH_MAX,
  StageDot,
  useActors,
  useColumnName,
  useMyId,
  useOutcome,
} from "./shared.tsx";

const OWNERS = ["all", "agents", "people", "mine", "unassigned"] as const;
type Owner = (typeof OWNERS)[number];
/** The search waits for the typing to pause before it asks the server. */
const SEARCH_PAUSE_MS = 250;

export function IssuesScreen() {
  const { workspaceId } = useRouteParams("issues");
  return <IssuesView key={workspaceId} workspaceId={workspaceId} />;
}

function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function keeps(owner: Owner, issue: Issue, me: string): boolean {
  switch (owner) {
    case "agents":
      return issue.assignee?.type === "agent";
    case "people":
      return issue.assignee?.type === "person";
    case "mine":
      return issue.assignee?.type === "person" && issue.assignee.id === me;
    case "unassigned":
      return issue.assignee === null;
    default:
      return true;
  }
}

function IssuesView({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("work");
  const shell = useMessages("shell");
  const me = useMyId();
  const actors = useActors(workspaceId);
  const outcome = useOutcome();
  const [text, setText] = useState("");
  const q = useSettled(text.trim(), SEARCH_PAUSE_MS);
  const [view, setView] = useState<"board" | "list">("board");
  const [owner, setOwner] = useState<Owner>("all");
  const [showCanceled, setShowCanceled] = useState(false);
  const [creating, setCreating] = useState(false);
  // Moves the server has not answered yet, drawn over what it last said.
  const [moves, setMoves] = useState<ReadonlyMap<string, Move>>(new Map());
  useDocumentTitle(shell("route.issues"));

  const issues = useApiQuery(
    "listIssues",
    { workspaceId, ...(q !== "" && { query: { q } }) },
    { refetchInterval: ISSUES_REFRESH_MS, placeholderData: (previous) => previous },
  );
  const columns = useApiQuery("listIssueColumns", { workspaceId });
  const update = useApiMutation("updateIssue", {
    invalidates: () => [{ method: "listIssues", args: { workspaceId } }],
  });

  const placed = useMemo(
    () =>
      (issues.data ?? []).map((issue) => {
        const move = moves.get(issue.id);
        return move === undefined ? issue : { ...issue, ...move };
      }),
    [issues.data, moves],
  );

  if (issues.isPending || columns.isPending) return <ScreenLoading />;
  const failed = [issues, columns].find((query) => query.isError && query.data === undefined);
  if (failed !== undefined) {
    return (
      <ScreenError
        title={t("issues.failed")}
        error={failed.error}
        onRetry={() => void failed.refetch()}
        namespace="work"
      />
    );
  }
  const allColumns = columns.data ?? [];
  const stageOf = new Map(allColumns.map((column) => [column.id, column.stage]));
  const shownColumns = allColumns.filter((column) => showCanceled || column.stage !== "canceled");
  const shown = placed.filter(
    (issue) => (showCanceled || stageOf.get(issue.columnId) !== "canceled") && keeps(owner, issue, me),
  );
  const nothingYet = placed.length === 0 && q === "";

  const move = (issue: Issue, to: Move) => {
    if (to.columnId === issue.columnId && to.boardPosition === issue.boardPosition) return;
    setMoves((current) => new Map(current).set(issue.id, to));
    const settle = () =>
      setMoves((current) => {
        const next = new Map(current);
        next.delete(issue.id);
        return next;
      });
    update.mutate(
      { workspaceId, issueId: issue.id, body: to },
      {
        onSettled: settle,
        onError: (error) => outcome.failed(error, t("board.moveFailed", { number: issue.number })),
      },
    );
  };

  const add = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
      {t("issues.new")}
    </Button>
  );

  return (
    <div className="page page--wide work">
      <header className="work__head">
        <div>
          <h1 className="page__title">{shell("route.issues")}</h1>
          {!nothingYet && <p className="page__muted">{t("issues.count", { count: placed.length })}</p>}
        </div>
        {add}
      </header>
      {nothingYet ? (
        <EmptyState
          className="page__narrow"
          title={t("issues.empty.title")}
          description={t("issues.empty.body")}
          action={add}
        />
      ) : (
        <Tabs value={view} onValueChange={(value) => setView(value === "list" ? "list" : "board")}>
          <div className="work__tools">
            <Field label={t("issues.search")} className="work__search">
              <Input
                type="search"
                value={text}
                maxLength={SEARCH_MAX}
                placeholder={t("issues.searchHint")}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <TabsList aria-label={t("issues.views")}>
              <TabsTrigger value="board">{t("issues.view.board")}</TabsTrigger>
              <TabsTrigger value="list">{t("issues.view.list")}</TabsTrigger>
            </TabsList>
          </div>
          <div className="work__filters">
            <fieldset className="work__chips">
              <legend className="vr-visually-hidden">{t("issues.owner")}</legend>
              {OWNERS.map((each) => (
                <Chip key={each} selected={owner === each} onSelectedChange={() => setOwner(each)}>
                  {t(`issues.owner.${each}`)}
                </Chip>
              ))}
            </fieldset>
            <Switch
              label={t("issues.showCanceled")}
              checked={showCanceled}
              onCheckedChange={setShowCanceled}
            />
          </div>
          <TabsContent value="board">
            <Board
              workspaceId={workspaceId}
              columns={shownColumns}
              issues={shown}
              actors={actors}
              onMove={move}
            />
          </TabsContent>
          <TabsContent value="list">
            {shown.length === 0 ? (
              <EmptyState title={t("issues.none.title")} description={t("issues.none.body")} />
            ) : (
              <IssueTable workspaceId={workspaceId} issues={shown} columns={allColumns} actors={actors} />
            )}
          </TabsContent>
        </Tabs>
      )}
      {creating && (
        <NewIssueDialog
          workspaceId={workspaceId}
          columns={allColumns}
          actors={actors}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function IssueTable({
  workspaceId,
  issues,
  columns,
  actors,
}: {
  workspaceId: string;
  issues: Issue[];
  columns: IssueColumn[];
  actors: Actors;
}) {
  const t = useMessages("work");
  const columnName = useColumnName();
  const byId = new Map(columns.map((column) => [column.id, column]));
  const sorted = [...issues].sort((a, b) => b.number - a.number);
  return (
    <div className="work-table">
      <table aria-label={t("issues.list.label")}>
        <thead>
          <tr>
            <th scope="col">{t("issues.list.number")}</th>
            <th scope="col">{t("issues.list.title")}</th>
            <th scope="col">{t("issues.list.stage")}</th>
            <th scope="col">{t("issues.list.assignee")}</th>
            <th scope="col">{t("issues.list.priority")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((issue) => {
            const column = byId.get(issue.columnId);
            return (
              <tr key={issue.id}>
                <td className="work-table__number">#{issue.number}</td>
                <td>
                  <AppLink
                    className="work-table__title"
                    route="issue"
                    params={{ workspaceId, issueSeq: String(issue.number) }}
                  >
                    {issue.title}
                  </AppLink>
                  <span className="work-table__marks">
                    <CriteriaMark criteria={issue.criteria} />
                    {issue.work?.state === "working" && <Chip>{t("issues.agentWorking")}</Chip>}
                  </span>
                </td>
                <td>
                  <span className="work-table__stage">
                    <StageDot stage={issue.status} />
                    {column === undefined ? t(`stage.${issue.status}`) : columnName(column)}
                  </span>
                </td>
                <td>{issue.assignee === null ? t("nobody") : actors.name(issue.assignee)}</td>
                <td>
                  <span className="work-table__priority">
                    <PriorityMark priority={issue.priority} />
                    {t(`priority.${issue.priority}`)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
