// A channel or a direct message: its header, its history with the agents at work below it, who is
// typing, and the composer (or, for someone reading a public channel they have not joined, a way to
// join). A channel this person cannot read looks exactly like one that does not exist.
import { useQueryClient } from "@tanstack/react-query";
import { prefixKey, useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { Channel, Message } from "@vanr/contract";
import { AgentSigil, Avatar, Button, EmptyState, ErrorState, Icon, Spinner } from "@vanr/ui";
import { Hash, Lock, MessagesSquare, WifiOff } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { useGo, useRouteParams, useSearch } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useLookup, useMessages } from "../../i18n/react.tsx";
import { useClock } from "../../platform/clock.tsx";
import { useChannelSubscription, useRealtimeStatus } from "../../realtime/react.tsx";
import { useDirectory } from "../control/cards.ts";
import { Composer } from "./Composer.tsx";
import { ConversationProvider, useConversation } from "./context.tsx";
import {
  useForgetChannel,
  useHistory,
  useLiveRuns,
  useMarkRead,
  useTicker,
  useTypingPeople,
  useTypingSignal,
} from "./hooks.ts";
import { LiveRuns } from "./LiveRuns.tsx";
import { LANDING_MS, type LiveRun, showing } from "./live.ts";
import { MessageItem } from "./Message.tsx";
import { ThreadPanel } from "./Thread.tsx";

const ThreadAddress = z.object({ thread: z.string().min(1).max(64).optional() });
const NO_THREAD: z.infer<typeof ThreadAddress> = {};

/** Two messages of one author closer than this read as one. */
const RUN_OF_MESSAGES_MS = 5 * 60_000;

type Kind =
  | { kind: "channel"; channel: Channel }
  | { kind: "person"; userId: string }
  | { kind: "agent"; agentId: string };

function dayKey(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function DayLabel({ iso, now }: { iso: string; now: number }) {
  const t = useMessages("chat");
  const { locale } = useLocale();
  const key = dayKey(iso);
  const label =
    key === dayKey(new Date(now).toISOString())
      ? t("day.today")
      : key === dayKey(new Date(now - 86_400_000).toISOString())
        ? t("day.yesterday")
        : new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(
            new Date(iso),
          );
  return (
    <h2 className="chat-day">
      <span>{label}</span>
    </h2>
  );
}

function TypingLine({ userIds }: { userIds: string[] }) {
  const t = useMessages("chat");
  const { directory } = useConversation();
  const names = userIds.map((id) => directory.personName(id));
  const text =
    names.length === 0
      ? ""
      : names.length === 1
        ? t("typing.one", { name: names[0] ?? "" })
        : names.length === 2
          ? t("typing.two", { first: names[0] ?? "", second: names[1] ?? "" })
          : t("typing.many");
  return (
    <p className="chat-typing" aria-live="polite">
      {text}
    </p>
  );
}

function JoinBar({ channel }: { channel: Channel }) {
  const t = useMessages("chat");
  const describe = useErrorMessage("chat");
  const { workspaceId } = useConversation();
  const join = useApiMutation("joinChannel", {
    invalidates: () => [{ method: "listChannels", args: { workspaceId } }],
  });
  return (
    <div className="chat-join">
      <p>{t("join.text", { channel: channel.name })}</p>
      <Button
        variant="primary"
        loading={join.isPending}
        onClick={() => join.mutate({ workspaceId, channelId: channel.id })}
      >
        {t("join.action")}
      </Button>
      {join.isError && (
        <p className="chat-note chat-note--danger" role="alert">
          {describe(join.error)}
        </p>
      )}
    </div>
  );
}

function Header({ target }: { target: Kind }) {
  const t = useMessages("chat");
  const { directory } = useConversation();
  if (target.kind === "channel") {
    const { channel } = target;
    const priv = channel.visibility === "private";
    return (
      <header className="chat__head">
        <h1 className="chat__title">
          <Icon icon={priv ? Lock : Hash} size="sm" />
          <span>{channel.name}</span>
          <span className="vr-visually-hidden">{priv ? t("room.private") : t("room.public")}</span>
        </h1>
        {channel.topic !== "" && <p className="chat__topic">{channel.topic}</p>}
      </header>
    );
  }
  if (target.kind === "person") {
    const name = directory.personName(target.userId);
    return (
      <header className="chat__head">
        <h1 className="chat__title">
          <Avatar name={name} size="sm" />
          <span>{name}</span>
        </h1>
      </header>
    );
  }
  return <AgentHeader agentId={target.agentId} />;
}

/** A direct message with an agent: who it is, what it does, who looks after it and what it runs on. */
function AgentHeader({ agentId }: { agentId: string }) {
  const t = useMessages("chat");
  const agents = useLookup("agents");
  const { workspaceId, directory } = useConversation();
  const listed = useApiQuery("listAgents", { workspaceId });
  const agent = listed.data?.find((candidate) => candidate.id === agentId);
  const owner = directory.agentOwner(agentId);
  const role = agent === undefined ? undefined : agents(`role.${agent.role}`);
  const harness = agent === undefined ? undefined : agents(`harness.kind.${agent.harness.kind}`);
  return (
    <header className="chat__head">
      <h1 className="chat__title">
        <AgentSigil agentId={agentId} name="" size="sm" aria-hidden="true" />
        <span>{directory.agentName(agentId)}</span>
      </h1>
      <ul className="chat__facts" aria-label={t("dm.agentFacts")}>
        {role !== undefined && <li>{role}</li>}
        {owner !== undefined && <li>{t("dm.agentOwner", { name: directory.personName(owner) })}</li>}
        {harness !== undefined && agent !== undefined && (
          <li>{t("dm.agentHarness", { harness, model: agent.harness.model })}</li>
        )}
      </ul>
    </header>
  );
}

function History({
  target,
  member,
  onOpenThread,
  onLost,
  children,
}: {
  target: Kind;
  member: boolean;
  onOpenThread: (rootId: string) => void;
  /** The person can no longer read the channel. */
  onLost: () => void;
  children?: ReactNode;
}) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const { workspaceId, channelId, me } = useConversation();
  const history = useHistory(workspaceId, channelId, me.userId);
  const { runs, active } = useLiveRuns(workspaceId, channelId);
  const typing = useTypingPeople(channelId, me.userId);
  const signal = useTypingSignal(channelId);
  const status = useRealtimeStatus();
  const [quoting, setQuoting] = useState<Message | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const heightBefore = useRef<{ first: string | undefined; height: number } | null>(null);

  const { messages } = history;
  const lastServer = [...messages].reverse().find((message) => message.local === undefined);
  useMarkRead(workspaceId, channelId, member, lastServer?.id);
  const answers = new Set(messages.map((message) => message.id));
  const { lost } = history;
  useEffect(() => {
    if (lost) onLost();
  }, [lost, onLost]);
  // The clock ticks only while a run is live or has just ended: an idle conversation stays still.
  const clockNow = useClock().now();
  const moving = runs.some((run) => run.endedAt === null || clockNow - run.endedAt < LANDING_MS);
  const now = useTicker(moving, 1000);
  const live = showing(runs, answers, now);
  const jumpTo = useCallback(() => {
    root.current?.querySelector(".chat-live")?.scrollIntoView({ block: "nearest" });
  }, []);
  const streamed = live.reduce((sum, run) => sum + run.text.length + run.steps.length, 0);

  // Follow the newest message while the person is at the bottom; keep the place when older ones load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every change of what is drawn.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const before = heightBefore.current;
    if (before !== null && before.first !== messages[0]?.id) {
      element.scrollTop += element.scrollHeight - before.height;
      heightBefore.current = null;
    } else if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, messages[0]?.id, streamed, live.length]);

  const loadOlder = () => {
    heightBefore.current = { first: messages[0]?.id, height: scroller.current?.scrollHeight ?? 0 };
    void history.loadOlder();
  };

  const onQuote = useCallback((message: Message) => setQuoting(message), []);
  const onRetry = history.retry;

  const placeholder =
    target.kind === "channel"
      ? t("composer.hintChannel", { channel: target.channel.name })
      : t("composer.hintDm");

  if (history.latest.isPending) return <ScreenLoading />;
  if (history.latest.isError)
    return (
      <ScreenError
        title={t("history.failed")}
        error={history.latest.error}
        onRetry={() => void history.latest.refetch()}
        namespace="chat"
      />
    );

  return (
    <div className="chat__body" ref={root}>
      <div
        className="chat__scroll"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {children}
        {history.canLoadOlder && (
          <div className="chat__older">
            <Button size="sm" variant="ghost" loading={history.loadingOlder} onClick={loadOlder}>
              {t("history.older")}
            </Button>
            {history.olderError !== null && (
              <p className="chat-note chat-note--danger" role="alert">
                {t("history.olderFailed", { error: describe(history.olderError) })}
              </p>
            )}
          </div>
        )}
        {messages.length === 0 && live.length === 0 ? (
          <EmptyState
            icon={<Icon icon={MessagesSquare} size="lg" />}
            title={target.kind === "channel" ? t("history.emptyChannel") : t("history.emptyDm")}
            description={t("history.emptyHint")}
          />
        ) : (
          <div className="chat__log" role="log" aria-label={t("history.label")}>
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const newDay =
                previous === undefined || dayKey(previous.createdAt) !== dayKey(message.createdAt);
              const continued =
                !newDay &&
                previous !== undefined &&
                previous.author.id === message.author.id &&
                previous.author.type === message.author.type &&
                previous.meta.retracted === undefined &&
                Date.parse(message.createdAt) - Date.parse(previous.createdAt) < RUN_OF_MESSAGES_MS;
              return (
                <Fragment key={message.id}>
                  {newDay && <DayLabel iso={message.createdAt} now={now} />}
                  <MessageItem
                    message={message}
                    continued={continued}
                    onQuote={onQuote}
                    onRetry={onRetry}
                    onOpenThread={onOpenThread}
                  />
                </Fragment>
              );
            })}
          </div>
        )}
        <LiveRuns runs={live} now={now} onCheck={() => void active.refetch()} scope={root} />
      </div>
      <TypingLine userIds={typing} />
      <WorkingNotice runs={live} onJump={jumpTo} />
      {status === "reconnecting" && (
        <p className="chat-note chat__offline" role="status">
          <Icon icon={WifiOff} size="sm" />
          {t("offline.text")}
        </p>
      )}
      {member || target.kind !== "channel" ? (
        <Composer
          quoting={quoting}
          onClearQuote={() => setQuoting(null)}
          onSend={history.send}
          onTyping={signal}
          placeholder={placeholder}
          draftId={`chat:${channelId}`}
          {...(target.kind === "agent" && { fallbackAnswerers: [target.agentId] })}
        />
      ) : (
        <JoinBar channel={target.channel} />
      )}
      {history.latest.isFetching && (
        <span className="vr-visually-hidden" role="status">
          {common("state.loading")}
        </span>
      )}
    </div>
  );
}

function ConversationView({
  channelId,
  target,
  member,
}: {
  channelId: string;
  target: Kind;
  member: boolean;
}) {
  const { workspaceId } = useRouteParams("home");
  useChannelSubscription(channelId);
  const { thread } = useSearch(ThreadAddress, NO_THREAD);
  const go = useGo();
  // The open thread lives in the address, so a link or a reload brings it back.
  const showThread = useCallback(
    (rootId: string | undefined) => {
      const search = rootId === undefined ? {} : { thread: rootId };
      if (target.kind === "channel") void go("channel", { workspaceId, channelId }, { search });
      else if (target.kind === "person")
        void go("dmPerson", { workspaceId, userId: target.userId }, { search });
      else void go("dmAgent", { workspaceId, agentId: target.agentId }, { search });
    },
    [go, target, workspaceId, channelId],
  );
  const openThread = useCallback((rootId: string) => showThread(rootId), [showThread]);
  // Once the person lost the channel nothing of it stays on screen, its name included.
  const [lost, setLost] = useState(false);
  const onLost = useCallback(() => setLost(true), []);
  if (lost) return <Forgotten workspaceId={workspaceId} channelId={channelId} />;
  return (
    <ConversationProvider workspaceId={workspaceId} channelId={channelId} member={member}>
      <div className="chat" data-thread={thread !== undefined || undefined}>
        <div className="chat__main">
          <Header target={target} />
          <History target={target} member={member} onOpenThread={openThread} onLost={onLost} />
        </div>
        {thread !== undefined && (
          <ThreadPanel key={thread} rootId={thread} member={member} onClose={() => showThread(undefined)} />
        )}
      </div>
    </ConversationProvider>
  );
}

/** A channel the person lost: the not-found screen, with everything of the channel cleared. */
function Forgotten({ workspaceId, channelId }: { workspaceId: string; channelId: string }) {
  useForgetChannel(workspaceId, channelId);
  return <NotFound />;
}

/** Above the composer: which agents are at work here, with a way to the run. */
function WorkingNotice({ runs, onJump }: { runs: readonly LiveRun[]; onJump: () => void }) {
  const t = useMessages("chat");
  const { directory } = useConversation();
  const working = runs.filter((run) => run.endedAt === null && run.threadId === null);
  if (working.length === 0) return null;
  const agents = [...new Set(working.map((run) => directory.agentName(run.agentId)))].join(", ");
  return (
    <p className="chat-note chat__working">
      <span>{t("run.notice", { count: working.length, agents })}</span>
      <button type="button" className="app-link-button" onClick={onJump}>
        {t("run.jump")}
      </button>
    </p>
  );
}

function NotFound() {
  const t = useMessages("chat");
  return (
    <div className="page">
      <h1 className="page__title">{t("missing.title")}</h1>
      <p className="page__lead">{t("missing.text")}</p>
    </div>
  );
}

/** A conversation that could not be opened: what failed, why, and a retry. */
function Failed({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  return (
    <div className="page">
      <h1 className="page__title">{title}</h1>
      <ErrorState
        title={describe(error)}
        action={<Button onClick={onRetry}>{common("action.retry")}</Button>}
      />
    </div>
  );
}

export function ChannelScreen() {
  const t = useMessages("chat");
  const { workspaceId, channelId } = useRouteParams("channel");
  const channels = useApiQuery("listChannels", { workspaceId });
  const dms = useApiQuery("getDms", { workspaceId });
  const channel = channels.data?.find((candidate) => candidate.id === channelId);
  const dm = dms.data?.find((candidate) => candidate.channelId === channelId);
  const failedToLoad = channels.isError || dms.isError;
  const loaded = channels.data !== undefined && dms.data !== undefined;
  useDocumentTitle(
    dm !== undefined
      ? dm.with.name
      : channel !== undefined
        ? `#${channel.name}`
        : failedToLoad
          ? t("room.failed")
          : loaded
            ? t("missing.title")
            : undefined,
  );
  if (channels.isPending || dms.isPending) return <ScreenLoading />;
  if (channels.isError || dms.isError) {
    const failed = channels.isError ? channels : dms;
    return <Failed title={t("room.failed")} error={failed.error} onRetry={() => void failed.refetch()} />;
  }
  if (dm !== undefined) {
    const target: Kind =
      dm.with.type === "agent"
        ? { kind: "agent", agentId: dm.with.id }
        : { kind: "person", userId: dm.with.id };
    return <ConversationView key={channelId} channelId={channelId} target={target} member />;
  }
  // Not listed: it never existed, or the person lost it; either way nothing of it stays cached.
  if (channel === undefined) return <Forgotten workspaceId={workspaceId} channelId={channelId} />;
  return (
    <ConversationView
      key={channelId}
      channelId={channelId}
      target={{ kind: "channel", channel }}
      member={channel.isMember}
    />
  );
}

/** A direct message, opened (or found) on the way in. */
function DirectScreen({ target }: { target: Extract<Kind, { kind: "person" | "agent" }> }) {
  const t = useMessages("chat");
  const { workspaceId } = useRouteParams("home");
  const directory = useDirectory(workspaceId);
  const body = target.kind === "agent" ? { agentId: target.agentId } : { userId: target.userId };
  const opened = useApiQuery("createDm", { workspaceId, body }, { staleTime: Number.POSITIVE_INFINITY });
  // A direct message opened for the first time has no message yet: nothing else would list it.
  const queryClient = useQueryClient();
  const client = useVanrClient();
  const openedId = opened.data?.channelId;
  useEffect(() => {
    if (openedId === undefined) return;
    void queryClient.invalidateQueries({
      queryKey: prefixKey(client, { method: "getDms", args: { workspaceId } }),
    });
  }, [openedId, queryClient, client, workspaceId]);
  useDocumentTitle(
    opened.isError
      ? t("dm.failed")
      : target.kind === "agent"
        ? directory.agentName(target.agentId)
        : directory.personName(target.userId),
  );
  if (opened.isPending)
    return (
      <div className="page" aria-busy="true">
        <Spinner label={t("dm.opening")} />
      </div>
    );
  if (opened.isError)
    return <Failed title={t("dm.failed")} error={opened.error} onRetry={() => void opened.refetch()} />;
  return (
    <ConversationView key={opened.data.channelId} channelId={opened.data.channelId} target={target} member />
  );
}

export function DmPersonScreen() {
  const { userId } = useRouteParams("dmPerson");
  return <DirectScreen key={userId} target={{ kind: "person", userId }} />;
}

export function DmAgentScreen() {
  const { agentId } = useRouteParams("dmAgent");
  return <DirectScreen key={agentId} target={{ kind: "agent", agentId }} />;
}
