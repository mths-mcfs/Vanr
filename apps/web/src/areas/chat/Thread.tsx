// A thread: the message that opened it, its replies, the agents at work in it, and a composer that
// answers inside it. It opens beside the channel or as a page of its own. Following it is anyone's
// choice; closing, reopening and taking it out of the archive belong to whoever may manage it. A
// thread nobody answered or followed yet has no record on the server: the panel still opens.

import { useQueryClient } from "@tanstack/react-query";
import { prefixKey, useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import type { Message, ThreadInfo, ThreadState } from "@vanr/contract";
import { Button, Chip, Icon, Skeleton } from "@vanr/ui";
import { ArrowLeft, Bell, BellOff, Maximize2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { ScreenLoading, useDocumentTitle, useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useChannelSubscription } from "../../realtime/react.tsx";
import { useOutcome } from "../control/shared.tsx";
import { Composer } from "./Composer.tsx";
import { ConversationProvider, useConversation } from "./context.tsx";
import { PAGE, useForgetChannel, useHistory, useLiveRuns, useTicker, useTypingSignal } from "./hooks.ts";
import { LiveRuns } from "./LiveRuns.tsx";
import { showing } from "./live.ts";
import { MessageItem } from "./Message.tsx";
import { AgentNotices } from "./Notices.tsx";

const NEXT_STATE: Record<ThreadState, "close" | "reopen" | "unarchive"> = {
  open: "close",
  closed: "reopen",
  archived: "unarchive",
};

const EXCERPT = 80;
/** Two replies of one author closer than this read as one, as in the channel. */
const RUN_OF_MESSAGES_MS = 5 * 60_000;

function Controls({ rootId, info }: { rootId: string; info: ThreadInfo | undefined }) {
  const t = useMessages("chat");
  const { workspaceId } = useConversation();
  const outcome = useOutcome();
  const stale = () => [
    { method: "getThread" as const, args: { workspaceId, threadId: rootId } },
    { method: "listThreads" as const, args: { workspaceId } },
  ];
  const follow = useApiMutation("followThread", { invalidates: stale });
  const unfollow = useApiMutation("unfollowThread", { invalidates: stale });
  const act = useApiMutation("runActionOnThread", { invalidates: stale });
  const following = info?.following ?? false;
  const toggle = following ? unfollow : follow;
  const next = info === undefined ? undefined : NEXT_STATE[info.state];
  return (
    <div className="chat-thread__controls">
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={following}
        loading={toggle.isPending}
        onClick={() =>
          toggle.mutate({ workspaceId, threadId: rootId }, { onError: (error) => outcome.failed(error) })
        }
      >
        <Icon icon={following ? BellOff : Bell} size="sm" />
        {following ? t("thread.following") : t("thread.follow")}
      </Button>
      {info?.manageable === true && next !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          loading={act.isPending}
          onClick={() =>
            act.mutate(
              { workspaceId, threadId: rootId, action: next },
              {
                onSuccess: () => outcome.done(t(`thread.${next}Done`)),
                onError: (error) => outcome.failed(error),
              },
            )
          }
        >
          {t(`thread.${next}`)}
        </Button>
      )}
    </div>
  );
}

export function ThreadPanel({
  rootId,
  member,
  onClose,
  onLost,
}: {
  rootId: string;
  member: boolean;
  /** Beside the channel: closes the panel. Left out on the thread's own page. */
  onClose?: () => void;
  /** The person can no longer read the thread's channel. */
  onLost?: () => void;
}) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const { workspaceId, channelId, me, readableChannels } = useConversation();
  const info = useApiQuery("getThread", { workspaceId, threadId: rootId });
  const history = useHistory(workspaceId, channelId, me.userId, rootId);
  const { runs, active } = useLiveRuns(workspaceId, channelId);
  const signal = useTypingSignal(channelId);
  const scope = useRef<HTMLElement>(null);
  const now = useTicker(runs.length > 0, 1000);
  const [quoting, setQuoting] = useState<Message | null>(null);

  const { messages, lost } = history;
  useEffect(() => {
    if (lost) onLost?.();
  }, [lost, onLost]);
  const root = messages.find((message) => message.id === rootId);
  // The panel holds the latest page of replies; live ones push the oldest out (no paging up yet).
  const replies = messages.filter((message) => message.id !== rootId).slice(-PAGE);
  const live = showing(
    runs.filter((run) => run.threadId === rootId),
    new Set(messages.map((message) => message.id)),
    now,
  );
  const spoke = [
    ...new Set(replies.flatMap((message) => (message.author.type === "agent" ? [message.author.id] : []))),
  ];
  const data = info.data;
  const title =
    data !== undefined && data.title !== ""
      ? data.title
      : root !== undefined
        ? root.body.slice(0, EXCERPT)
        : t("thread.untitled");
  const state = data?.state ?? "open";
  // The record counts every reply; the panel draws only the latest page of them.
  const replyCount = Math.max(data?.replyCount ?? 0, replies.length);
  const counted = replyCount === 0 ? t("thread.noReplies") : t("thread.replies", { count: replyCount });

  return (
    <section
      className="chat-thread"
      aria-label={t("thread.label")}
      ref={scope}
      data-page={onClose === undefined || undefined}
    >
      <header className="chat-thread__head">
        <div className="chat-thread__titles">
          <h2 className="chat-thread__title">{title}</h2>
          <p className="chat-thread__where">
            {data !== undefined && readableChannels.has(data.channelId) && data.venue === "channel" && (
              <AppLink route="channel" params={{ workspaceId, channelId: data.channelId }}>
                #{data.channelName}
              </AppLink>
            )}
            {state !== "open" && <Chip>{t(`thread.state.${state}`)}</Chip>}
            {replyCount > 0 && <span>{counted}</span>}
          </p>
        </div>
        <Controls rootId={rootId} info={data} />
        {onClose !== undefined && (
          <div className="chat-thread__window">
            {/* A thread with no record yet has no page of its own: it lives beside its channel. */}
            {data !== undefined && (
              <AppLink
                className="chat-icon-button"
                route="thread"
                params={{ workspaceId, threadId: rootId }}
                aria-label={t("thread.page")}
              >
                <Icon icon={Maximize2} size="sm" />
              </AppLink>
            )}
            <button
              type="button"
              className="chat-icon-button"
              aria-label={t("thread.hide")}
              onClick={onClose}
            >
              <Icon icon={X} size="sm" />
            </button>
          </div>
        )}
      </header>
      {info.isError && info.error.status !== 404 && (
        <p className="chat-note chat-note--danger chat-thread__problem" role="alert">
          {t("thread.infoFailed")}{" "}
          <button type="button" className="app-link-button" onClick={() => void info.refetch()}>
            {common("action.retry")}
          </button>
        </p>
      )}
      <div className="chat-thread__scroll">
        {history.latest.isPending ? (
          <div aria-busy="true">
            <span className="vr-visually-hidden" role="status">
              {common("state.loading")}
            </span>
            <Skeleton shape="block" />
            <Skeleton />
          </div>
        ) : history.latest.isError ? (
          <p className="chat-note chat-note--danger" role="alert">
            {t("thread.failed", { error: describe(history.latest.error) })}{" "}
            <button type="button" className="app-link-button" onClick={() => void history.latest.refetch()}>
              {common("action.retry")}
            </button>
          </p>
        ) : root === undefined ? (
          <p className="chat-note">{t("thread.missing")}</p>
        ) : (
          <div className="chat__log" role="log" aria-label={t("thread.log")}>
            <MessageItem message={root} continued={false} onQuote={setQuoting} onRetry={history.retry} />
            <p className="chat-thread__count">{counted}</p>
            {replies.map((message, index) => {
              const previous = replies[index - 1];
              // Grouped as in the channel: same author, same day, within a few minutes.
              const continued =
                previous !== undefined &&
                previous.author.id === message.author.id &&
                previous.author.type === message.author.type &&
                previous.meta.retracted === undefined &&
                new Date(previous.createdAt).toDateString() === new Date(message.createdAt).toDateString() &&
                Date.parse(message.createdAt) - Date.parse(previous.createdAt) < RUN_OF_MESSAGES_MS;
              return (
                <Fragment key={message.id}>
                  <MessageItem
                    message={message}
                    continued={continued}
                    onQuote={setQuoting}
                    onRetry={history.retry}
                  />
                </Fragment>
              );
            })}
          </div>
        )}
        <LiveRuns runs={live} now={now} onCheck={() => void active.refetch()} scope={scope} thread={rootId} />
      </div>
      <AgentNotices thread={rootId} />
      {root !== undefined && member && state !== "archived" && (
        <Composer
          quoting={quoting}
          onClearQuote={() => setQuoting(null)}
          onSend={history.send}
          onTyping={signal}
          draftId={`chat:${channelId}:${rootId}`}
          fallbackAnswerers={spoke}
          placeholder={t("thread.hint")}
        />
      )}
    </section>
  );
}

/** A thread on a page of its own, with the way back to the list and into its channel. */
export function ThreadScreen() {
  const { workspaceId, threadId } = useRouteParams("thread");
  // Each thread is its own page: what one learned (it is gone) never carries to the next.
  return <ThreadPage key={`${workspaceId}/${threadId}`} workspaceId={workspaceId} threadId={threadId} />;
}

function ThreadPage({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const info = useApiQuery("getThread", { workspaceId, threadId });
  const channels = useApiQuery("listChannels", { workspaceId });
  const [lostHere, setLostHere] = useState(false);
  const onLost = useCallback(() => setLostHere(true), []);
  // Gone: the server says so, the panel lost its channel, or the channel is no longer listed. A
  // cached copy of the thread never draws once the person may not read it.
  const refused = info.isError && (info.error.status === 404 || info.error.status === 403);
  const unlisted =
    info.data !== undefined &&
    channels.data !== undefined &&
    !channels.data.some((c) => c.id === info.data.channelId);
  // A channel left out of the list stays gone while each new list still leaves it out, even once the
  // forgotten copy of the thread can't be read again. A list that has it back (the person was added
  // again) lets the thread load.
  const unlistedIn = useRef<string | null>(null);
  if (unlisted) unlistedIn.current = info.data.channelId;
  const stillUnlisted =
    unlistedIn.current !== null &&
    channels.data !== undefined &&
    !channels.data.some((c) => c.id === unlistedIn.current);
  // A refusal answered while the channel was out of the list holds only until the list has it back,
  // and the thread is read again then (below). Any other refusal, or a loss, stays gone for this
  // thread: forgetting the cache must not bring a loading state back.
  const excusedAt = useRef<number | null>(null);
  if (refused && stillUnlisted) excusedAt.current = info.errorUpdatedAt;
  const excused = refused && excusedAt.current === info.errorUpdatedAt;
  const goneFor = useRef<string | null>(null);
  if ((refused && !excused) || lostHere) goneFor.current = threadId;
  const missing = goneFor.current === threadId || stillUnlisted || excused;
  // The channel whose cache the gone page clears, fixed once: the forgotten thread read again must not
  // remount the clearing, which would forget it again, and loop.
  const forgotten = useRef<string | undefined>(undefined);
  if (missing) forgotten.current ??= unlistedIn.current ?? info.data?.channelId;
  // A list that has the channel back reads the thread again, once, if its last read failed or was
  // refused while gone; a read that fails again stays on the error with its retry.
  const listedAgain = unlistedIn.current !== null && !stillUnlisted;
  const readOnce = useRef(false);
  if (!listedAgain) readOnce.current = false;
  const readAgain = info.refetch;
  useEffect(() => {
    if (!listedAgain || !info.isError || readOnce.current) return;
    readOnce.current = true;
    void readAgain();
  }, [listedAgain, info.isError, readAgain]);
  const channelId = missing ? undefined : info.data?.channelId;
  useChannelSubscription(channelId);
  useDocumentTitle(
    missing
      ? t("thread.gone")
      : info.data !== undefined
        ? info.data.title || t("thread.untitled")
        : info.isError
          ? t("thread.pageFailed")
          : undefined,
  );
  const back = (
    <AppLink className="chat-thread__back" route="threads" params={{ workspaceId }}>
      <Icon icon={ArrowLeft} size="sm" />
      {t("thread.back")}
    </AppLink>
  );
  if (missing)
    return (
      <div className="page">
        {back}
        <ForgetThread workspaceId={workspaceId} threadId={threadId} channelId={forgotten.current} />
        <h1 className="page__title">{t("thread.gone")}</h1>
        <p className="page__lead">{t("thread.goneText")}</p>
      </div>
    );
  if (info.isPending || channels.isPending) return <ScreenLoading />;
  if (info.isError || channels.isError)
    return (
      <div className="page">
        {back}
        <h1 className="page__title">{t("thread.pageFailed")}</h1>
        {
          <p className="page__lead">
            {describe(info.isError ? info.error : channels.error)}{" "}
            <Button
              onClick={() => {
                void info.refetch();
                void channels.refetch();
              }}
            >
              {common("action.retry")}
            </Button>
          </p>
        }
      </div>
    );
  const thread = info.data;
  const member = channels.data.find((channel) => channel.id === thread.channelId)?.isMember ?? true;
  return (
    <ConversationProvider workspaceId={workspaceId} channelId={thread.channelId} member={member}>
      <div className="chat chat--thread">
        <header className="chat__head">
          {back}
          <h1 className="vr-visually-hidden">{thread.title || t("thread.untitled")}</h1>
          {thread.venue === "channel" && (
            <AppLink
              route="channel"
              params={{ workspaceId, channelId: thread.channelId }}
              search={{ thread: thread.id }}
            >
              {t("thread.inChannel", { channel: thread.channelName })}
            </AppLink>
          )}
        </header>
        <ThreadPanel rootId={thread.id} member={member} onLost={onLost} />
      </div>
    </ConversationProvider>
  );
}

/** Drops the thread, and its channel when known, from the cache: the person can't read them now. */
function ForgetThread({
  workspaceId,
  threadId,
  channelId,
}: {
  workspaceId: string;
  threadId: string;
  channelId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const client = useVanrClient();
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: prefixKey(client, { method: "getThread", args: { workspaceId, threadId } }),
    });
  }, [queryClient, client, workspaceId, threadId]);
  return channelId === undefined ? null : <ForgetChannel workspaceId={workspaceId} channelId={channelId} />;
}

function ForgetChannel({ workspaceId, channelId }: { workspaceId: string; channelId: string }) {
  useForgetChannel(workspaceId, channelId);
  return null;
}
