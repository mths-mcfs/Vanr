// The inbox: what needs the person ("Action needed": open requests, DMs, mentions), what is only
// worth knowing ("FYI") and everything, with filters. Open requests come first, the rest by day.
// Opening a notice marks it read and goes where it came from; "done" takes it out of the inbox,
// "snooze" hides it until a time, and "remind me" keeps it and brings it back to the top then.
// Real time: the notification events refetch the first page and the counts through the client's
// invalidation table; the older pages loaded here are patched from the same events.
import { useApiMutation, useApiQuery, useRealtimeEvent, useVanrClient } from "@vanr/client/react";
import type { AppNotification, NotificationCounts, NotificationFilter } from "@vanr/contract";
import {
  Button,
  Chip,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type WorkStatus,
} from "@vanr/ui";
import { AlarmClock, BellRing, Check, CheckCheck, Pin, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AppLink, useGo, useRouteParams, useSearch } from "../../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { useClock } from "../../../platform/clock.tsx";
import { useOutcome } from "../settings/shared.tsx";
import {
  ALL_FILTERS,
  DAY_GROUPS,
  dayGroupOf,
  destinationOf,
  joinPages,
  laterOptions,
  TABS,
  type Tab,
  tabOf,
} from "./notices.ts";

const PAGE = 50;

const FILTERS = ["action_needed", "fyi", ...ALL_FILTERS] as const;
const Search = z.object({
  filter: z.enum(FILTERS).optional(),
  open: z.string().min(1).max(200).optional(),
});
const NO_SEARCH: z.infer<typeof Search> = {};

const WORK_STATUS: Record<NonNullable<AppNotification["workState"]>, WorkStatus> = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "paused",
  blocked_on_you: "awaiting-reply",
  due: "awaiting-reply",
};

export function InboxScreen() {
  const t = useMessages("inbox");
  const shell = useMessages("shell");
  const go = useGo();
  const { workspaceId } = useRouteParams("notifications");
  const search = useSearch(Search, NO_SEARCH);
  const filter: NotificationFilter = search.filter ?? "action_needed";
  const counts = useApiQuery("listNotificationCounts", { workspaceId });
  useDocumentTitle(shell("route.notifications"));
  useOpenFromLink(workspaceId, search.open, filter);

  const setFilter = (next: NotificationFilter) =>
    void go("notifications", { workspaceId }, { search: { filter: next }, replace: true });
  const tab = tabOf(filter);

  return (
    <div className="page page--wide inbox">
      <header className="inbox__head">
        <div>
          <h1 className="page__title">{shell("route.notifications")}</h1>
          {counts.data !== undefined && (
            <p className="page__muted">
              {counts.data.unread > 0 ? t("unread", { count: counts.data.unread }) : t("allRead")}
            </p>
          )}
        </div>
        <AppLink className="app-link inbox__prefs" route="notificationSettings" params={{ workspaceId }}>
          <SlidersHorizontal aria-hidden="true" size={16} />
          {t("preferences")}
        </AppLink>
      </header>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          const chosen = TABS.find((candidate) => candidate === next);
          if (chosen !== undefined) setFilter(chosen);
        }}
      >
        <TabsList aria-label={t("tabs")}>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              <TabLabel tab={name} counts={counts.data} />
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((name) => (
          <TabsContent key={name} value={name} className="inbox__panel">
            {name === "all" && (
              <fieldset className="inbox__filters">
                <legend className="vr-visually-hidden">{t("filters")}</legend>
                {ALL_FILTERS.map((option) => (
                  <Chip key={option} selected={filter === option} onSelectedChange={() => setFilter(option)}>
                    {option === "all" || counts.data === undefined || counts.data[option] === 0
                      ? t(`filter.${option}`)
                      : t("filter.counted", { label: t(`filter.${option}`), count: counts.data[option] })}
                  </Chip>
                ))}
              </fieldset>
            )}
            {tab === name && <NoticeList key={filter} workspaceId={workspaceId} filter={filter} />}
          </TabsContent>
        ))}
      </Tabs>
      <p className="page__muted inbox__retention">{t("retention")}</p>
    </div>
  );
}

function TabLabel({ tab, counts }: { tab: Tab; counts: NotificationCounts | undefined }) {
  const t = useMessages("inbox");
  const count = tab === "action_needed" ? counts?.actionNeeded : tab === "fyi" ? counts?.fyi : undefined;
  return (
    <>
      {t(`tab.${tab}`)}
      {count !== undefined && count > 0 && (
        <span className="inbox__count">
          <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
          <span className="vr-visually-hidden">{t("tabCount", { count })}</span>
        </span>
      )}
    </>
  );
}

/** A link from a push or an email (`?open=<id>`) marks the notice read and goes to its source. */
function useOpenFromLink(workspaceId: string, open: string | undefined, filter: NotificationFilter) {
  const client = useVanrClient();
  const go = useGo();
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (open === undefined || handled.current === open) return;
    handled.current = open;
    void client.api
      .markNotificationRead({ workspaceId, notificationId: open, body: { read: true } })
      .then((notice) => {
        const destination = destinationOf(notice, workspaceId);
        if (destination === undefined) throw new Error("no destination");
        return go(destination.route, destination.params);
      })
      // A notice that is gone (or leads nowhere) leaves the person in the inbox.
      .catch(() => go("notifications", { workspaceId }, { search: { filter }, replace: true }));
  }, [client, go, open, workspaceId, filter]);
}

function NoticeList({ workspaceId, filter }: { workspaceId: string; filter: NotificationFilter }) {
  const t = useMessages("inbox");
  const client = useVanrClient();
  const clock = useClock();
  const outcome = useOutcome("inbox");
  const first = useApiQuery("listNotifications", { workspaceId, query: { filter, limit: PAGE } });
  // The pages after the first: loaded on demand, and loaded again from the first page's cursor every
  // time the first page changes, so the list always reads as one moment of the server. A notice that
  // moved across the page boundary is then neither lost nor shown twice.
  // `version` is the first page (its dataUpdatedAt) the range continues: a range is only ever extended
  // while it still continues the first page on screen, and is otherwise loaded again from it.
  const [extra, setExtra] = useState<{
    items: AppNotification[];
    cursor: string | null;
    version: number;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const wanted = useRef(0);
  const ticket = useRef(0);
  /**
   * Loads `count` notices from `from`, after `base`, for the first page `version`: the next page on a
   * click, or the whole older range again (`rebuild`) from that first page's cursor. A later load
   * started meanwhile wins.
   */
  const loadExtra = async (
    version: number,
    from: string | null,
    count: number,
    base: readonly AppNotification[],
    rebuild: boolean,
  ) => {
    const mine = ++ticket.current;
    const items = [...base];
    let cursor = from;
    try {
      while (cursor !== null && items.length - base.length < count) {
        const page = await client.api.listNotifications({
          workspaceId,
          query: { filter, cursor, limit: PAGE },
        });
        if (mine !== ticket.current) return;
        items.push(...page.items);
        cursor = page.items.length === 0 ? null : page.nextCursor;
      }
    } catch (error) {
      if (mine === ticket.current) {
        if (rebuild) {
          // An older range that could not be loaded again no longer fits the first page: drop it,
          // so "Show older" comes back to try again.
          wanted.current = 0;
          setExtra(null);
        } else {
          // A click that failed keeps what is loaded, and the same click can be tried again.
          wanted.current = base.length;
        }
      }
      throw error;
    }
    if (mine === ticket.current) setExtra({ items, cursor, version });
  };

  // An event that arrives while the first page is on its way may be missing from that answer, which
  // was computed before it: the first page is asked for once more when it lands.
  const askAgain = useRef(false);
  const onEvent = () => {
    if (first.isFetching) askAgain.current = true;
  };
  useRealtimeEvent("notification.hidden", onEvent);
  useRealtimeEvent("notification.shown", onEvent);
  const latest = useRef({ first, loadExtra, outcome });
  latest.current = { first, loadExtra, outcome };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new first page is the trigger; the rest is read fresh.
  useEffect(() => {
    const { first: page, loadExtra: load, outcome: say } = latest.current;
    if (page.isFetching || page.data === undefined) return;
    if (askAgain.current) {
      askAgain.current = false;
      void page.refetch();
      return;
    }
    if (wanted.current > 0) {
      load(page.dataUpdatedAt, page.data.nextCursor, wanted.current, [], true).catch(say.failed);
    }
  }, [first.dataUpdatedAt, first.isFetching]);

  const changed = () => [
    { method: "listNotifications" as const, args: { workspaceId } },
    { method: "listNotificationCounts" as const, args: { workspaceId } },
  ];
  const readAll = useApiMutation("markNotificationAllRead", { invalidates: changed });

  if (first.isPending) return <ScreenLoading />;
  if (first.isError) {
    return (
      <ScreenError
        title={t("failed")}
        error={first.error}
        onRetry={() => void first.refetch()}
        namespace="inbox"
      />
    );
  }

  const items = joinPages(first.data.items, extra?.items ?? []);
  const cursor = extra === null ? first.data.nextCursor : extra.cursor;
  const { counts } = first.data;
  // Whether this filter has something unread. The counts say so exactly for everything and for FYI;
  // for the other filters, the loaded notices do once the list is complete.
  const unreadHere =
    filter === "all" || filter === "unread"
      ? counts.unread > 0
      : filter === "fyi"
        ? counts.fyi > 0
        : items.some((notice) => notice.readAt === null) || (cursor !== null && counts.unread > 0);

  const loadMore = async () => {
    if (cursor === null) return;
    wanted.current = (extra?.items.length ?? 0) + PAGE;
    setLoadingMore(true);
    try {
      // The next page only while the range continues the first page on screen; otherwise (the first
      // page changed and its range is being loaded again, or none is loaded) the whole range, one
      // page longer, from the first page's own cursor. Either load supersedes one still running.
      if (extra !== null && extra.version === first.dataUpdatedAt) {
        await loadExtra(extra.version, cursor, PAGE, extra.items, false);
      } else {
        await loadExtra(first.dataUpdatedAt, first.data.nextCursor, wanted.current, [], true);
      }
    } catch (error) {
      outcome.failed(error);
    } finally {
      setLoadingMore(false);
    }
  };

  const waiting = items.filter((notice) => notice.waiting);
  const rest = items.filter((notice) => !notice.waiting);
  const now = clock.now();

  return (
    <>
      <div className="inbox__tools">
        <Button
          size="sm"
          icon={<CheckCheck aria-hidden="true" />}
          disabled={!unreadHere}
          loading={readAll.isPending}
          onClick={() =>
            readAll.mutate(
              { workspaceId, body: { filter } },
              {
                onSuccess: (result) =>
                  outcome.done(t(result.ids.length === 0 ? "readAllNone" : "readAllDone")),
                onError: outcome.failed,
              },
            )
          }
        >
          {t(filter === "all" ? "readAll" : "readFiltered")}
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          className="page__narrow"
          title={t(`empty.${filter}.title`)}
          description={t(`empty.${filter}.body`)}
        />
      ) : (
        <div className="inbox__groups">
          {waiting.length > 0 && (
            <NoticeGroup label={t("group.waiting")} notices={waiting} workspaceId={workspaceId} />
          )}
          {DAY_GROUPS.map((group) => {
            const list = rest.filter((notice) => dayGroupOf(notice.updatedAt, now) === group);
            return list.length === 0 ? null : (
              <NoticeGroup key={group} label={t(`group.${group}`)} notices={list} workspaceId={workspaceId} />
            );
          })}
          {cursor !== null && (
            <div>
              <Button variant="ghost" loading={loadingMore} onClick={() => void loadMore()}>
                {t("loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function NoticeGroup({
  label,
  notices,
  workspaceId,
}: {
  label: string;
  notices: readonly AppNotification[];
  workspaceId: string;
}) {
  return (
    <section className="inbox__group" aria-label={label}>
      <h2 className="inbox__group-title">{label}</h2>
      <ul className="inbox__list">
        {notices.map((notice) => (
          <NoticeRow key={notice.id} notice={notice} workspaceId={workspaceId} />
        ))}
      </ul>
    </section>
  );
}

/** Names of who did it: people from the workspace, agents from the team. */
function useActorNames(workspaceId: string) {
  const people = useApiQuery("getPeople", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  return (actor: AppNotification["actors"][number]) =>
    actor.type === "agent"
      ? agents.data?.find((agent) => agent.id === actor.id)?.name
      : people.data?.find((person) => person.userId === actor.id)?.name;
}

function NoticeRow({ notice, workspaceId }: { notice: AppNotification; workspaceId: string }) {
  const t = useMessages("inbox");
  const { locale } = useLocale();
  const clock = useClock();
  const go = useGo();
  const outcome = useOutcome("inbox");
  const nameOf = useActorNames(workspaceId);
  const invalidates = () => [
    { method: "listNotifications" as const, args: { workspaceId } },
    { method: "listNotificationCounts" as const, args: { workspaceId } },
  ];
  const read = useApiMutation("markNotificationRead", { invalidates });
  const complete = useApiMutation("completeNotification", { invalidates });
  const save = useApiMutation("saveNotification", { invalidates });
  const snooze = useApiMutation("snoozeNotification", { invalidates });
  const remind = useApiMutation("remindNotification", { invalidates });
  const ids = { workspaceId, notificationId: notice.id };

  const names = notice.actors.map(nameOf).filter((name): name is string => name !== undefined);
  const who =
    names.length === 0
      ? t("someone")
      : names.length > 2
        ? t("whoMany", { name: names[0] ?? "", count: names.length - 1 })
        : new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  const headline = t(
    notice.kind === "mention" && notice.source.label !== undefined ? "kind.mentionIn" : `kind.${notice.kind}`,
    {
      who,
      count: notice.count,
      label: notice.source.label ?? "",
      emojis: (notice.latest.emojis ?? []).join(" "),
    },
  );
  const snippet = notice.latest.text ?? notice.latest.quote ?? notice.latest.title;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(
      new Date(iso),
    );
  const unread = notice.readAt === null;

  const open = async () => {
    if (unread) read.mutate({ ...ids, body: { read: true } });
    const destination = destinationOf(notice, workspaceId);
    if (destination !== undefined) await go(destination.route, destination.params);
  };

  return (
    <li className="notice" data-unread={unread || undefined} data-waiting={notice.waiting || undefined}>
      <button type="button" className="notice__open" onClick={() => void open()}>
        {unread && <span className="vr-visually-hidden">{`${t("unreadMark")} `}</span>}
        <span className="notice__headline">{headline}</span>
      </button>
      {snippet !== undefined && snippet !== "" && <p className="notice__snippet">{snippet}</p>}
      <p className="notice__why">
        <span className="notice__reason">{t(`reason.${notice.reason}`)}</span>
        {notice.ruleId !== null && <span>{t("byRule")}</span>}
        {notice.remindAt !== null && <span>{t("remindAt", { time: time(notice.remindAt) })}</span>}
        <time dateTime={notice.updatedAt} className="notice__time">
          {relativeTime(notice.updatedAt, clock.now(), locale)}
        </time>
      </p>
      {notice.workState !== null && (
        <StatusBadge
          className="notice__state"
          status={WORK_STATUS[notice.workState]}
          label={t(`workState.${notice.workState}`)}
        />
      )}
      <div className="notice__actions">
        {/* An open request leaves the inbox by itself once it is answered: "done" is for the rest. */}
        {!notice.waiting && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Check aria-hidden="true" />}
            loading={complete.isPending}
            onClick={() => complete.mutate({ ...ids, body: { done: true } }, { onError: outcome.failed })}
          >
            {t("done")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Pin aria-hidden="true" />}
          aria-label={t("save")}
          aria-pressed={notice.savedAt !== null}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { ...ids, body: { saved: notice.savedAt === null } },
              {
                onSuccess: (next) => {
                  outcome.done(t(next.savedAt === null ? "unsavedDone" : "savedDone"));
                },
                onError: outcome.failed,
              },
            )
          }
        />
        <Menu>
          <MenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              icon={<AlarmClock aria-hidden="true" />}
              aria-label={t("snooze")}
              loading={snooze.isPending}
            />
          </MenuTrigger>
          <MenuContent>
            {laterOptions(clock.now()).map((option) => (
              <MenuItem
                key={option.key}
                onSelect={() =>
                  snooze.mutate(
                    { ...ids, body: { until: option.at.toISOString() } },
                    {
                      onSuccess: () => {
                        outcome.done(t("snoozedDone", { time: time(option.at.toISOString()) }));
                      },
                      onError: outcome.failed,
                    },
                  )
                }
              >
                {t(`snoozeFor.${option.key}`)}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Menu>
          <MenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              icon={<BellRing aria-hidden="true" />}
              aria-label={t("remind")}
              aria-pressed={notice.remindAt !== null}
              loading={remind.isPending}
            />
          </MenuTrigger>
          <MenuContent>
            {laterOptions(clock.now()).map((option) => (
              <MenuItem
                key={option.key}
                onSelect={() =>
                  remind.mutate(
                    { ...ids, body: { at: option.at.toISOString() } },
                    { onError: outcome.failed },
                  )
                }
              >
                {t(`remindFor.${option.key}`)}
              </MenuItem>
            ))}
            {notice.remindAt !== null && (
              <>
                <MenuSeparator />
                <MenuItem
                  onSelect={() => remind.mutate({ ...ids, body: { at: null } }, { onError: outcome.failed })}
                >
                  {t("remindClear")}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
];

/** "5 minutes ago", "yesterday", "3 weeks ago", in the interface language. */
function relativeTime(iso: string, now: number, locale: string): string {
  const elapsed = Date.parse(iso) - now;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let unit: (typeof UNITS)[number] = ["minute", 60_000];
  for (const candidate of UNITS) if (Math.abs(elapsed) >= candidate[1]) unit = candidate;
  return format.format(Math.round(elapsed / unit[1]), unit[0]);
}
