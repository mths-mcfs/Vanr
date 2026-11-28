// Every thread of the workspace this person can read, newest activity first, in tabs (all, at work,
// assignments, closed, archived), with filters for what needs them and what is theirs, and a search.
// The list follows no channel live: it is read again when the screen comes back and once a minute.
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryKey, shouldRetry, useVanrClient } from "@vanr/client/react";
import type { ThreadInfo } from "@vanr/contract";
import { Button, Checkbox, Chip, EmptyState, Icon, Input, Tabs, TabsList, TabsTrigger } from "@vanr/ui";
import { MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useRelativeTime } from "../../i18n/relative-time.tsx";
import { useClock } from "../../platform/clock.tsx";
import { useDirectory } from "../control/cards.ts";

export const TABS = ["all", "working", "assignments", "closed", "archived"] as const;
type Tab = (typeof TABS)[number];

/** Threads per page, as the server sends them. */
const PAGE = 30;
/** The longest search the server takes. */
export const SEARCH_MAX = 200;
/** The search waits this long after the last key. */
export const SEARCH_WAIT_MS = 250;
/** The list is read again this often while it is open. */
const REFRESH_MS = 60_000;

function useSettled(value: string, ms: number): string {
  const clock = useClock();
  const [settled, setSettled] = useState(value);
  useEffect(() => clock.setTimer(() => setSettled(value), ms), [value, ms, clock]);
  return settled;
}

function Row({ thread }: { thread: ThreadInfo }) {
  const t = useMessages("chat");
  const ago = useRelativeTime();
  const { workspaceId } = useRouteParams("threads");
  const directory = useDirectory(workspaceId);
  const title = thread.title !== "" ? thread.title : thread.openingText;
  const where =
    thread.venue === "channel"
      ? `#${thread.channelName}`
      : t("threads.dmWith", {
          name:
            thread.opener.type === "agent"
              ? directory.agentName(thread.opener.id)
              : directory.personName(thread.opener.id),
        });
  const last = thread.lastMessage;
  return (
    <li className="chat-threads__row">
      <AppLink className="chat-threads__link" route="thread" params={{ workspaceId, threadId: thread.id }}>
        <span className="chat-threads__title">{title}</span>
      </AppLink>
      <span className="chat-threads__meta">
        <span>{where}</span>
        <span>
          {thread.replyCount === 0
            ? t("thread.noReplies")
            : t("thread.replies", { count: thread.replyCount })}
        </span>
        <time dateTime={thread.lastTouchedAt}>{ago(thread.lastTouchedAt)}</time>
        {thread.state !== "open" && <Chip>{t(`thread.state.${thread.state}`)}</Chip>}
        {thread.working && <Chip>{t("threads.working")}</Chip>}
        {thread.actionNeeded && <Chip>{t("threads.waitsOnYou")}</Chip>}
        {thread.assignment !== null && <Chip>{t("threads.assignment")}</Chip>}
      </span>
      {last !== null && (
        <span className="chat-threads__last">
          {t("threads.last", {
            name:
              last.author.type === "agent"
                ? directory.agentName(last.author.id)
                : directory.personName(last.author.id),
            text: last.excerpt,
          })}
        </span>
      )}
    </li>
  );
}

export function ThreadsScreen() {
  const t = useMessages("chat");
  const shell = useMessages("shell");
  const describe = useErrorMessage("chat");
  const client = useVanrClient();
  const { workspaceId } = useRouteParams("threads");
  const [tab, setTab] = useState<Tab>("all");
  const [needsMe, setNeedsMe] = useState(false);
  const [mine, setMine] = useState(false);
  const [typed, setTyped] = useState("");
  const q = useSettled(typed.trim(), SEARCH_WAIT_MS);
  useDocumentTitle(shell("route.threads"));
  const filters = tab !== "assignments";
  const query = {
    tab,
    ...(filters && needsMe && { actionNeeded: true as const }),
    ...(filters && mine && { mine: true as const }),
    ...(q !== "" && { q }),
    limit: PAGE,
  };
  const pages = useInfiniteQuery({
    queryKey: [...queryKey(client, "listThreads", { workspaceId, query }), "pages"],
    queryFn: ({ pageParam, signal }) =>
      client.call(
        "listThreads",
        { workspaceId, query: pageParam === undefined ? query : { ...query, cursor: pageParam } },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: shouldRetry,
  });
  const threads = pages.data?.pages.flatMap((page) => page.threads) ?? [];
  // A later page or a refresh that failed keeps the pages already shown, with a note under them.
  const moreFailed = pages.isError && pages.data !== undefined ? pages.error : null;

  return (
    <div className="page chat-threads">
      <h1 className="page__title">{shell("route.threads")}</h1>
      <Tabs value={tab} onValueChange={(value) => setTab(TABS.find((each) => each === value) ?? "all")}>
        <TabsList aria-label={t("threads.tabs")}>
          {TABS.map((each) => (
            <TabsTrigger key={each} value={each}>
              {t(`threads.tab.${each}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="chat-threads__tools">
        <Input
          type="search"
          maxLength={SEARCH_MAX}
          aria-label={t("threads.find")}
          placeholder={t("threads.findHint")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        {filters && (
          <>
            <Checkbox
              label={t("threads.needsMe")}
              checked={needsMe}
              onCheckedChange={(value) => setNeedsMe(value === true)}
            />
            <Checkbox
              label={t("threads.own")}
              checked={mine}
              onCheckedChange={(value) => setMine(value === true)}
            />
          </>
        )}
      </div>
      {pages.isPending ? (
        <ScreenLoading />
      ) : pages.data === undefined ? (
        <ScreenError
          title={t("threads.failed")}
          error={pages.error}
          onRetry={() => void pages.refetch()}
          namespace="chat"
        />
      ) : threads.length === 0 && !pages.hasNextPage ? (
        <EmptyState
          icon={<Icon icon={MessagesSquare} size="lg" />}
          title={q !== "" ? t("threads.noMatch", { query: q }) : t("threads.empty")}
          description={t("threads.emptyHint")}
        />
      ) : (
        <>
          {/* A first page emptied by a lost channel still leads to the pages after it. */}
          {threads.length > 0 && (
            <ul className="chat-threads__list" aria-label={t("threads.rows")}>
              {threads.map((thread) => (
                <Row key={thread.id} thread={thread} />
              ))}
            </ul>
          )}
          {pages.hasNextPage && (
            <Button loading={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {t("threads.next")}
            </Button>
          )}
          {moreFailed !== null && (
            <p className="chat-note chat-note--danger" role="alert">
              {t("threads.nextFailed", { error: describe(moreFailed) })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
