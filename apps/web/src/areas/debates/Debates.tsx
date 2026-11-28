// The debates the person sees. In the plain view, the ones that wait on them and the ones being argued
// right now come first, each in its own group, and are not repeated below. A search or another view
// shows one list instead. Each debate shows its question, its state, the round it is in, its table, its
// goal (or why it is stuck) and when it last moved. Starting one opens its page.
import { useApiQuery } from "@vanr/client/react";
import type { Debate } from "@vanr/contract";
import { Button, EmptyState, Field, Input, Tabs, TabsList, TabsTrigger } from "@vanr/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useRelativeTime } from "../../i18n/relative-time.tsx";
import { DebateMetrics } from "./Metrics.tsx";
import { NewDebateDialog } from "./NewDebate.tsx";
import { DebateState, RoundRail, Table, useRoundLabel } from "./parts.tsx";
import {
  type Directory,
  isFinished,
  needsMe,
  QUESTION_MAX,
  seatsOf,
  takesPart,
  useDirectory,
  useMe,
} from "./shared.tsx";

const VIEWS = ["ongoing", "finished", "yours"] as const;
type View = (typeof VIEWS)[number];

export function DebatesScreen() {
  const { workspaceId } = useRouteParams("debates");
  return <DebatesView key={workspaceId} workspaceId={workspaceId} />;
}

function DebatesView({ workspaceId }: { workspaceId: string }) {
  const t = useMessages("debates");
  const shell = useMessages("shell");
  const me = useMe(workspaceId).id;
  const directory = useDirectory(workspaceId);
  const [view, setView] = useState<View>("ongoing");
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  useDocumentTitle(shell("route.debates"));
  const list = useApiQuery("listDebates", { workspaceId });

  const start = (
    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setStarting(true)}>
      {t("list.start")}
    </Button>
  );
  const dialog = starting && (
    <NewDebateDialog workspaceId={workspaceId} directory={directory} onClose={() => setStarting(false)} />
  );

  if (list.isPending) return <ScreenLoading />;
  if (list.isError && list.data === undefined) {
    return (
      <ScreenError
        title={t("list.failed")}
        error={list.error}
        onRetry={() => void list.refetch()}
        namespace="debates"
      />
    );
  }
  const all = list.data;
  const needle = text.trim().toLocaleLowerCase();
  const matches = (debate: Debate) =>
    needle === "" ||
    [debate.title, debate.goal, ...seatsOf(debate).map((seat) => directory.name(seat))]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle);
  const inView = (debate: Debate) =>
    view === "ongoing"
      ? !isFinished(debate)
      : view === "finished"
        ? isFinished(debate)
        : takesPart(debate, me);
  // Only the plain view groups; there a debate shown in a group is not listed again below.
  const grouped = view === "ongoing" && needle === "";
  const mine = grouped ? all.filter((debate) => needsMe(debate, me)) : [];
  const live = grouped
    ? all.filter((debate) => debate.status === "open" && debate.phase === "debating" && !needsMe(debate, me))
    : [];
  const above = new Set([...mine, ...live].map((debate) => debate.id));
  const rest = all.filter((debate) => !above.has(debate.id) && inView(debate) && matches(debate));
  const rows = (debates: Debate[], label: string) => (
    <ul className="debate-list" aria-label={label}>
      {debates.map((debate) => (
        <li key={debate.id}>
          <DebateRow workspaceId={workspaceId} debate={debate} me={me} directory={directory} />
        </li>
      ))}
    </ul>
  );
  const groupTitle = (count: number) => t("list.group.you", { count });
  const liveTitle = t("list.group.live", { count: live.length });

  return (
    <div className="page page--wide debates">
      <header className="debates__head">
        <div className="debates__lead">
          <h1 className="page__title">{shell("route.debates")}</h1>
          <p className="page__muted">{t("list.intro")}</p>
        </div>
        {start}
      </header>
      <DebateMetrics workspaceId={workspaceId} />
      {all.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t("list.empty.title")}
          description={t("list.empty.body")}
          action={start}
        />
      ) : (
        <>
          {mine.length > 0 && (
            <section className="debates__group debates__group--you" aria-label={groupTitle(mine.length)}>
              <h2 className="debates__group-title">{groupTitle(mine.length)}</h2>
              {rows(mine, groupTitle(mine.length))}
            </section>
          )}
          {live.length > 0 && (
            <section className="debates__group" aria-label={liveTitle}>
              <h2 className="debates__group-title">{liveTitle}</h2>
              {rows(live, liveTitle)}
            </section>
          )}
          <div className="debates__tools">
            <Field label={t("list.search")} hint={t("list.search.hint")} className="debates__search">
              <Input
                type="search"
                value={text}
                maxLength={QUESTION_MAX}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <Tabs
              value={view}
              onValueChange={(value) => setView(VIEWS.find((each) => each === value) ?? "ongoing")}
            >
              <TabsList aria-label={t("list.view")}>
                {VIEWS.map((each) => (
                  <TabsTrigger key={each} value={each}>
                    {t(`list.view.${each}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          {rest.length > 0 ? (
            rows(rest, above.size > 0 ? t("list.group.rest") : t("list.all"))
          ) : (
            <p className="debates__note">{above.size > 0 ? t("list.noneLeft") : t("list.noMatch")}</p>
          )}
        </>
      )}
      {dialog}
    </div>
  );
}

function DebateRow({
  workspaceId,
  debate,
  me,
  directory,
}: {
  workspaceId: string;
  debate: Debate;
  me: string;
  directory: Directory;
}) {
  const t = useMessages("debates");
  const when = useRelativeTime();
  const roundLabel = useRoundLabel();
  const stuck = debate.status === "stalled" ? debate.stallInfo : null;
  return (
    <article className="debate-row" data-status={debate.status} aria-label={debate.title}>
      <div className="debate-row__head">
        <AppLink className="debate-row__title" route="debate" params={{ workspaceId, debateId: debate.id }}>
          {debate.title}
        </AppLink>
        <DebateState debate={debate} me={me} />
      </div>
      <div className="debate-row__progress">
        <RoundRail debate={debate} />
        <span>{roundLabel(debate)}</span>
        <Table debate={debate} directory={directory} />
      </div>
      {/* A goal left blank is the question again: shown once. While the debate is blind, which agent
          got stuck would give away its letter, so the row says only that someone is. */}
      {(stuck !== null || debate.goal.trim() !== debate.title.trim()) && (
        <p className="debate-row__goal" data-stuck={stuck !== null || undefined}>
          {stuck === null
            ? debate.goal
            : debate.anonymous
              ? t("row.stuckBlind")
              : t("row.stuck", {
                  who: stuck.agentId
                    ? directory.name({ type: "agent", id: stuck.agentId })
                    : (stuck.pseudonym ?? ""),
                  reason: stuck.reason,
                })}
        </p>
      )}
      <p className="debate-row__when">{t("list.updated", { when: when(debate.updatedAt) })}</p>
    </article>
  );
}
