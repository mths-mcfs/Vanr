// One message of the conversation: who wrote it and when, what it quotes, its text and files, the
// notes the server adds (stopped, withdrawn, edited), what each agent did with a person's message,
// its reactions, and the cards it carries. A post still on its way says so; a failed one offers a retry.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { HandledStatus, Message, ReactionCount } from "@vanr/contract";
import {
  AgentSigil,
  Avatar,
  Button,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  Tooltip,
} from "@vanr/ui";
import { FileText, Quote, SmilePlus, TriangleAlert } from "lucide-react";
import { memo, useState } from "react";
import { AppLink } from "../../app/navigation.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useLookup, useMessages } from "../../i18n/react.tsx";
import { ActionReceipt, ApprovalCard, ConnectorScopeCard, QuestionCard } from "../control/cards.ts";
import { useOutcome } from "../control/shared.tsx";
import { MessageBody } from "./body.tsx";
import { useConversation } from "./context.tsx";
import { SavedSteps } from "./Steps.tsx";

/** The reason codes the server holds an agent back with, each worded in the catalog. */
export const HELD_REASONS = ["not_in_channel", "audience", "personal_plan", "budget"] as const;

/** A known reason code; any other is worded only as "held back", never looked up. */
export const isHeldReason = (reason: string): reason is (typeof HELD_REASONS)[number] =>
  (HELD_REASONS as readonly string[]).includes(reason);

/** The quick reactions, in the order they are offered. */
export const QUICK_REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"] as const;

export function useAuthorName() {
  const { directory } = useConversation();
  return (author: Message["author"]) =>
    author.type === "agent" ? directory.agentName(author.id) : directory.personName(author.id);
}

function AuthorMark({ author, name }: { author: Message["author"]; name: string }) {
  return author.type === "agent" ? (
    <AgentSigil agentId={author.id} name={name} size="md" />
  ) : (
    <Avatar name={name} size="md" />
  );
}

export function clockTime(iso: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function Reactions({ message }: { message: Message }) {
  const t = useMessages("chat");
  const { workspaceId, me, directory, member } = useConversation();
  const describe = useErrorMessage("chat");
  const [failed, setFailed] = useState<string | null>(null);
  const add = useApiMutation("createMessageReaction", {
    invalidates: () => [
      { method: "listChannelMessages", args: { workspaceId, channelId: message.channelId } },
    ],
  });
  const clear = useApiMutation("clearMessageReactions", {
    invalidates: () => [
      { method: "listChannelMessages", args: { workspaceId, channelId: message.channelId } },
    ],
  });
  if (message.reactions.length === 0 && failed === null) return null;
  const toggle = (reaction: ReactionCount) => {
    const mine = reaction.userIds.includes(me.userId);
    const args = { workspaceId, messageId: message.id };
    const done = {
      onError: (error: unknown) => setFailed(describe(error)),
      onSuccess: () => setFailed(null),
    };
    if (mine) clear.mutate({ ...args, query: { reaction: reaction.reaction } }, done);
    else add.mutate({ ...args, body: { reaction: reaction.reaction } }, done);
  };
  const who = (reaction: ReactionCount) =>
    [
      ...reaction.userIds.map((id) => (id === me.userId ? t("reaction.you") : directory.personName(id))),
      ...reaction.agentIds.map((id) => directory.agentName(id)),
    ].join(", ");
  return (
    <div className="chat-reactions">
      {message.reactions.map((reaction) => {
        const mine = reaction.userIds.includes(me.userId);
        const label = t("reaction.label", { reaction: reaction.reaction, names: who(reaction) });
        return (
          <Tooltip key={reaction.reaction} content={label}>
            <button
              type="button"
              className="chat-reaction"
              aria-pressed={mine}
              aria-label={label}
              disabled={!member || add.isPending || clear.isPending}
              onClick={() => toggle(reaction)}
            >
              <span aria-hidden="true">{reaction.reaction}</span>
              <span aria-hidden="true">{reaction.count}</span>
            </button>
          </Tooltip>
        );
      })}
      {failed !== null && (
        <span className="chat-note chat-note--danger" role="alert">
          {t("reaction.failed", { error: failed })}
        </span>
      )}
    </div>
  );
}

const HANDLED: Record<HandledStatus, string> = {
  answered: "receipt.answered",
  silent: "receipt.silent",
  failed: "receipt.failed",
  canceled: "receipt.canceled",
  blocked: "receipt.blocked",
};

/** What each agent did with a person's message. */
function Receipts({ message }: { message: Message }) {
  const lookup = useLookup("chat");
  const t = useMessages("chat");
  const { directory, me } = useConversation();
  const { receipts } = message;
  const handled = new Set(receipts.handled.map((entry) => entry.agentId));
  const blocked = receipts.blocked ?? [];
  const lines = [
    ...receipts.claimedBy
      .filter((agentId) => !handled.has(agentId) && !blocked.some((entry) => entry.agentId === agentId))
      .map((agentId) => ({
        key: `claimed-${agentId}`,
        text: t("receipt.working", { agent: directory.agentName(agentId) }),
      })),
    ...receipts.handled.map((entry) => ({
      key: `handled-${entry.agentId}-${entry.runId}`,
      text: lookup(HANDLED[entry.status], { agent: directory.agentName(entry.agentId) }) ?? "",
      tone: entry.status === "failed" ? "danger" : undefined,
    })),
    ...blocked.map((entry) => ({
      key: `blocked-${entry.agentId}`,
      // The reason is a code: it reads in words, for who reads it. The author is told "you"; anyone else
      // reads the author's name. A code the web doesn't know yet says only that the agent was held back.
      text:
        (message.author.id === me.userId
          ? undefined
          : !isHeldReason(entry.reason)
            ? undefined
            : lookup(`receipt.held.${entry.reason}`, {
                agent: directory.agentName(entry.agentId),
                name: directory.personName(message.author.id),
              })) ??
        (isHeldReason(entry.reason)
          ? lookup(`blocked.${entry.reason}`, { agent: directory.agentName(entry.agentId) })
          : undefined) ??
        t("receipt.blocked", { agent: directory.agentName(entry.agentId) }),
      tone: "danger" as const,
    })),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="chat-receipts" aria-label={t("receipt.label")}>
      {lines.map((line) => (
        <li key={line.key} data-tone={"tone" in line ? line.tone : undefined}>
          {line.text}
        </li>
      ))}
    </ul>
  );
}

function ChatApproval({ approvalId }: { approvalId: string }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const { workspaceId, me, directory, readableChannels } = useConversation();
  const approval = useApiQuery("getApproval", { workspaceId, approvalId });
  if (approval.isPending) return <Skeleton shape="block" />;
  if (approval.isError)
    return (
      <p className="chat-note chat-note--danger">
        {t("card.approvalFailed")}{" "}
        <button type="button" className="app-link-button" onClick={() => void approval.refetch()}>
          {common("action.retry")}
        </button>
      </p>
    );
  return (
    <ApprovalCard
      workspaceId={workspaceId}
      approval={approval.data}
      me={me}
      directory={directory}
      readableChannels={readableChannels}
    />
  );
}

/** The cards a message carries, each from the area that owns it. */
function Cards({ message }: { message: Message }) {
  const t = useMessages("chat");
  const { workspaceId, me, directory } = useConversation();
  const { meta } = message;
  return (
    <>
      {meta.approvalId !== undefined && <ChatApproval approvalId={meta.approvalId} />}
      {meta.question !== undefined && (
        <QuestionCard workspaceId={workspaceId} question={meta.question} me={me} directory={directory} />
      )}
      {meta.connectorScope !== undefined && message.author.type === "agent" && (
        <ConnectorScopeCard
          workspaceId={workspaceId}
          card={meta.connectorScope}
          agentId={message.author.id}
          me={me}
          directory={directory}
        />
      )}
      {meta.proposalId !== undefined && (
        <p className="chat-note">
          {t("card.proposal")}{" "}
          <AppLink route="proposals" params={{ workspaceId }}>
            {t("card.proposalOpen")}
          </AppLink>
        </p>
      )}
      {message.actions.length > 0 && (
        <ActionReceipt workspaceId={workspaceId} message={message} me={me} directory={directory} />
      )}
    </>
  );
}

function Files({ message }: { message: Message }) {
  const t = useMessages("chat");
  const { workspaceId } = useConversation();
  const files = message.meta.files ?? [];
  if (files.length === 0) return null;
  return (
    <ul className="chat-files" aria-label={t("files.label")}>
      {files.map((file) => (
        <li key={file.id}>
          <Icon icon={FileText} size="sm" />
          {file.deleted ? (
            <span className="chat-files__gone">{t("files.deleted", { title: file.title })}</span>
          ) : (
            <AppLink route="files" params={{ workspaceId }} search={{ file: file.id }}>
              {file.title}
            </AppLink>
          )}
        </li>
      ))}
    </ul>
  );
}

function Actions({ message, onQuote }: { message: Message; onQuote: (message: Message) => void }) {
  const t = useMessages("chat");
  const describe = useErrorMessage("chat");
  const outcome = useOutcome();
  const { workspaceId, member } = useConversation();
  const react = useApiMutation("createMessageReaction", {
    invalidates: () => [
      { method: "listChannelMessages", args: { workspaceId, channelId: message.channelId } },
    ],
  });
  if (!member) return null;
  return (
    <div className="chat-message__actions" role="toolbar" aria-label={t("tools.label")}>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="chat-icon-button" aria-label={t("tools.react")}>
            <Icon icon={SmilePlus} size="sm" />
          </button>
        </MenuTrigger>
        <MenuContent className="chat-quick-reactions">
          {QUICK_REACTIONS.map((reaction) => (
            <MenuItem
              key={reaction}
              aria-label={t("tools.reactWith", { reaction })}
              onSelect={() =>
                react.mutate(
                  { workspaceId, messageId: message.id, body: { reaction } },
                  { onError: (error) => outcome.warn(t("reaction.failed", { error: describe(error) })) },
                )
              }
            >
              {reaction}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <button
        type="button"
        className="chat-icon-button"
        aria-label={t("tools.quote")}
        onClick={() => onQuote(message)}
      >
        <Icon icon={Quote} size="sm" />
      </button>
    </div>
  );
}

export type MessageItemProps = {
  message: Message;
  /** The author wrote the message just before too: the name and the mark are left out. */
  continued: boolean;
  onQuote: (message: Message) => void;
  onRetry: (message: Message) => void;
};

function MessageItemView({ message, continued, onQuote, onRetry }: MessageItemProps) {
  const t = useMessages("chat");
  const lookup = useLookup("chat");
  const { locale } = useLocale();
  const { mention, directory } = useConversation();
  const authorName = useAuthorName();
  const name = authorName(message.author);
  const { meta } = message;
  const retracted = meta.retracted;
  const when = clockTime(message.createdAt, locale);
  const templated =
    meta.bodyTemplate === undefined ? undefined : lookup(`template.${meta.bodyTemplate}`, meta.templateVars);
  const sending = message.local === "pending";
  const failed = message.local === "failed";

  return (
    <article
      className="chat-message"
      data-continued={continued || undefined}
      data-author={message.author.type}
      data-local={message.local}
      data-retracted={retracted !== undefined || undefined}
      aria-label={t("post.label", { name, time: when })}
    >
      <div className="chat-message__mark">
        {!continued && <AuthorMark author={message.author} name={name} />}
      </div>
      <div className="chat-message__main">
        {!continued && (
          <header className="chat-message__head">
            <span className="chat-message__author">{name}</span>
            <time
              className="chat-message__time"
              dateTime={message.createdAt}
              title={new Date(message.createdAt).toLocaleString(locale)}
            >
              {when}
            </time>
            {message.editedAt !== null && <span className="chat-message__flag">{t("post.edited")}</span>}
          </header>
        )}
        {retracted !== undefined ? (
          <p className="chat-retracted">
            {t("post.withdrawn", { name: directory.personName(retracted.actorUserId) })}
          </p>
        ) : (
          <>
            {meta.replyTo !== undefined && (
              <blockquote className="chat-quote">
                <span className="chat-quote__author">{meta.replyTo.authorName}</span>
                <span className="chat-quote__text">{meta.replyTo.excerpt}</span>
              </blockquote>
            )}
            {(templated ?? message.body) !== "" && (
              <MessageBody text={templated ?? message.body} mention={mention} />
            )}
            <Files message={message} />
            {meta.canceled === true && <p className="chat-note">{t("post.stopped")}</p>}
            {meta.interrupted === true && <p className="chat-note">{t("post.interrupted")}</p>}
            {message.memories.length > 0 && (
              <ul className="chat-memories" aria-label={t("recall.label")}>
                {message.memories.map((memory) => (
                  <li key={memory.id}>
                    {t("recall.saved", { agent: directory.agentName(memory.agentId), text: memory.text })}
                  </li>
                ))}
              </ul>
            )}
            <Cards message={message} />
            {message.author.type === "agent" && message.runId !== null && (meta.toolSteps ?? 0) > 0 && (
              <SavedSteps runId={message.runId} count={meta.toolSteps ?? 0} />
            )}
            {message.author.type === "person" && <Receipts message={message} />}
            <Reactions message={message} />
          </>
        )}
        {sending && (
          <p className="chat-note" role="status">
            {t("post.sending")}
          </p>
        )}
        {failed && (
          <p className="chat-note chat-note--danger" role="alert">
            <Icon icon={TriangleAlert} size="sm" />
            {t("post.failed")}{" "}
            <Button size="sm" variant="ghost" onClick={() => onRetry(message)}>
              {t("post.retry")}
            </Button>
          </p>
        )}
      </div>
      {message.local === undefined && retracted === undefined && (
        <Actions message={message} onQuote={onQuote} />
      )}
    </article>
  );
}

export const MessageItem = memo(MessageItemView);
