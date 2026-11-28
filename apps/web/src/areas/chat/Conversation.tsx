// A channel or a direct message: its header, its history with the agents at work below it, who is
// typing, and the composer (or, for someone reading a public channel they have not joined, a way to
// join). A channel this person cannot read looks exactly like one that does not exist.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { Channel, Message } from "@vanr/contract";
import { AgentSigil, Avatar, Button, EmptyState, ErrorState, Icon, Spinner } from "@vanr/ui";
import { Hash, Lock, MessagesSquare, WifiOff } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useRouteParams } from "../../app/navigation.tsx";
import { ScreenError, ScreenLoading, useDocumentTitle, useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { useChannelSubscription, useRealtimeStatus } from "../../realtime/react.tsx";
import { useDirectory } from "../control/cards.ts";
import { Composer } from "./Composer.tsx";
import { ConversationProvider, useConversation } from "./context.tsx";
import {
  useHistory,
  useLiveRuns,
  useMarkRead,
  useTicker,
  useTypingPeople,
  useTypingSignal,
} from "./hooks.ts";
import { LiveRuns } from "./LiveRuns.tsx";
import { showing } from "./live.ts";
import { MessageItem } from "./Message.tsx";

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
  const name = directory.agentName(target.agentId);
  const owner = directory.agentOwner(target.agentId);
  return (
    <header className="chat__head">
      <h1 className="chat__title">
        <AgentSigil agentId={target.agentId} name="" size="sm" aria-hidden="true" />
        <span>{name}</span>
      </h1>
      {owner !== undefined && (
        <p className="chat__topic">{t("dm.agentOwner", { name: directory.personName(owner) })}</p>
      )}
    </header>
  );
}

function History({ target, member, children }: { target: Kind; member: boolean; children?: ReactNode }) {
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
  const now = useTicker(runs.length > 0, 1000);
  const live = showing(runs, answers, now);
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
                  <MessageItem message={message} continued={continued} onQuote={onQuote} onRetry={onRetry} />
                </Fragment>
              );
            })}
          </div>
        )}
        <LiveRuns runs={live} now={now} onCheck={() => void active.refetch()} scope={root} />
      </div>
      <TypingLine userIds={typing} />
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
          {...(target.kind === "agent" && { dmAgentId: target.agentId })}
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
  return (
    <ConversationProvider workspaceId={workspaceId} channelId={channelId} member={member}>
      <div className="chat">
        <Header target={target} />
        <History target={target} member={member} />
      </div>
    </ConversationProvider>
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
  if (channel === undefined) return <NotFound />;
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
