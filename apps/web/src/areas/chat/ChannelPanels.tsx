// What a channel's header opens: its people and agents (add, remove, leave), its settings (name,
// topic, the monthly budget), and its pinned messages. The server decides each action; a control is
// offered only to who it allows. Members and pins send no event, so both are read again each minute.
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { prefixKey, queryKey, useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import { type Channel, can, type MessagePin } from "@vanr/contract";
import {
  AgentSigil,
  Avatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Input,
  Skeleton,
  Textarea,
} from "@vanr/ui";
import { useRef, useState } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useLocale, useMessages } from "../../i18n/react.tsx";
import { forgetChannelQueries } from "../../realtime/react.tsx";
import { ROUTES } from "../../routes.ts";
import { useOutcome } from "../control/shared.tsx";
import { decimalMark, formatLimit, readLimit } from "../work/limits.ts";
import { NAME_MAX, TOPIC_MAX } from "./Channels.tsx";
import { useConversation } from "./context.tsx";
import { useAuthorName } from "./Message.tsx";

/** Members and pins change without an event: they are read again this often while shown. */
export const PANEL_REFRESH_MS = 60_000;

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  return (
    <p className="chat-note chat-note--danger" role="alert">
      {describe(error)}{" "}
      <button type="button" className="app-link-button" onClick={onRetry}>
        {common("action.retry")}
      </button>
    </p>
  );
}

function Waiting() {
  const common = useMessages("common");
  return (
    <div aria-busy="true">
      <span className="vr-visually-hidden" role="status">
        {common("state.loading")}
      </span>
      <Skeleton />
    </div>
  );
}

/** How many people and agents are in the channel, for the header's button. */
export function useMemberCount(): number | undefined {
  const { workspaceId, channelId } = useConversation();
  const members = useApiQuery(
    "listChannelMembers",
    { workspaceId, channelId },
    { refetchInterval: PANEL_REFRESH_MS },
  );
  return members.data?.length;
}

export function MembersDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const outcome = useOutcome();
  const queryClient = useQueryClient();
  const client = useVanrClient();
  const { workspaceId, channelId, me, directory, member } = useConversation();
  const args = { workspaceId, channelId };
  const members = useApiQuery("listChannelMembers", args, { refetchInterval: PANEL_REFRESH_MS });
  const people = useApiQuery("getPeople", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  const [query, setQuery] = useState("");
  const stale = () => [
    { method: "listChannelMembers" as const, args },
    { method: "getChannelDirectory" as const, args },
    { method: "listChannels" as const, args: { workspaceId } },
  ];
  const add = useApiMutation("createChannelMember", { invalidates: stale });
  const removePerson = useApiMutation("deleteChannelMemberPerson", { invalidates: stale });
  // Leaving finishes even when the dialog is gone before the answer (closed, or the channel page lost
  // the channel first, as the server stops sending it): out of a private channel nothing of it may stay,
  // and someone still on the channel's page goes home. Someone who moved on stays where they are.
  const router = useRouter();
  const leftFrom = useRef<string | null>(null);
  const leave = useApiMutation("deleteChannelMemberPerson", {
    onSuccess: () => {
      // At once, before anything is read again: a read that hangs must not keep the channel around.
      outcome.done(t("people.left", { channel: channel.name }));
      if (channel.visibility === "private") forgetChannelQueries(queryClient, client, workspaceId, channelId);
      if (router.state.location.pathname === leftFrom.current)
        void router.navigate({ to: ROUTES.home.path, params: { workspaceId } });
      for (const each of stale()) void queryClient.invalidateQueries({ queryKey: prefixKey(client, each) });
    },
  });
  const removeAgent = useApiMutation("deleteChannelMemberAgent", { invalidates: stale });
  const managesMembers = can(me.role, "manage_members");
  // Rows with a change on the way, each until its own answer: a later change elsewhere frees none.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const track = (
    key: string,
    change: Promise<unknown>,
    failed: (error: unknown) => void = (error) => outcome.failed(error),
  ) => {
    setBusy((now) => new Set(now).add(key));
    void change.catch(failed).finally(() =>
      setBusy((now) => {
        const next = new Set(now);
        next.delete(key);
        return next;
      }),
    );
  };
  const [addFailed, setAddFailed] = useState<unknown>(null);
  const inside = new Set((members.data ?? []).map((entry) => `${entry.type}:${entry.id}`));
  const q = query.trim().toLowerCase();
  const fits = (entry: { name: string; handle: string }) =>
    entry.name.toLowerCase().includes(q) || entry.handle.toLowerCase().includes(q);
  // Who could be added: people and the agents this person can talk to, not already in. Without the
  // channel's own list there is no telling who is in, so nobody is offered.
  const pool =
    members.data === undefined
      ? []
      : [
          ...(agents.data ?? [])
            .filter(
              (agent) => agent.archivedAt === null && agent.reachable && !inside.has(`agent:${agent.id}`),
            )
            .map((agent) => ({
              type: "agent" as const,
              id: agent.id,
              name: agent.name,
              handle: agent.handle,
            })),
          ...(people.data ?? [])
            .filter((person) => !inside.has(`person:${person.userId}`))
            .map((person) => ({
              type: "person" as const,
              id: person.userId,
              name: person.name,
              handle: person.handle,
            })),
        ];
  const candidates = q === "" ? [] : pool.filter(fits);
  // Adding is for who is already in; a direct message keeps its people.
  const mayAdd = member;
  const name = (entry: { type: "agent" | "person"; id: string }) =>
    entry.type === "agent" ? directory.agentName(entry.id) : directory.personName(entry.id);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={common("action.close")}
        title={t("people.title", { channel: channel.name })}
        description={t("people.count", { count: members.data?.length ?? 0 })}
      >
        {members.isPending ? (
          <Waiting />
        ) : members.isError ? (
          <Failed error={members.error} onRetry={() => void members.refetch()} />
        ) : (
          <ul className="chat-pick" aria-label={t("people.list")}>
            {members.data.map((entry) => {
              const self = entry.type === "person" && entry.id === me.userId;
              // Everyone stays in #general; anyone else is removed by whoever manages members.
              const mayRemove = managesMembers && !(channel.isGeneral && entry.type === "person");
              return (
                <li key={`${entry.type}-${entry.id}`} className="chat-pick__row">
                  <span className="chat-pick__name">
                    {entry.type === "agent" ? (
                      <AgentSigil agentId={entry.id} name="" size="sm" aria-hidden="true" />
                    ) : (
                      <Avatar name={name(entry)} size="sm" aria-hidden="true" />
                    )}
                    {self ? t("side.you", { name: name(entry) }) : name(entry)}
                  </span>
                  {mayRemove && !self && (
                    <Button
                      size="sm"
                      variant="ghost"
                      // One removal at a time per row: a second click would only find them gone.
                      loading={busy.has(`remove:${entry.type}:${entry.id}`)}
                      aria-label={t("people.removeNamed", { name: name(entry) })}
                      onClick={() =>
                        track(
                          `remove:${entry.type}:${entry.id}`,
                          entry.type === "agent"
                            ? removeAgent.mutateAsync({ ...args, agentId: entry.id })
                            : removePerson.mutateAsync({ ...args, personId: entry.id }),
                        )
                      }
                    >
                      {t("people.remove")}
                    </Button>
                  )}
                  {self && !channel.isGeneral && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={leave.isPending}
                      onClick={() => {
                        leftFrom.current = router.state.location.pathname;
                        leave.mutate(
                          { ...args, personId: me.userId },
                          { onSuccess: onClose, onError: (error) => outcome.failed(error) },
                        );
                      }}
                    >
                      {t("people.leave")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {mayAdd && (
          <div className="chat-form">
            <Field label={t("people.add")} hint={t("people.addHint")}>
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
            </Field>
            {people.isPending || agents.isPending ? (
              q !== "" && <Waiting />
            ) : people.isError || agents.isError ? (
              <Failed
                error={people.isError ? people.error : agents.error}
                onRetry={() => {
                  void people.refetch();
                  void agents.refetch();
                }}
              />
            ) : pool.length === 0 ? (
              <p className="chat-note">{t("people.none")}</p>
            ) : q === "" ? null : candidates.length === 0 ? (
              <p className="chat-note">{t("people.noMatch", { query: query.trim() })}</p>
            ) : (
              <ul className="chat-pick" aria-label={t("people.candidates")}>
                {candidates.map((entry) => (
                  <li key={`${entry.type}-${entry.id}`} className="chat-pick__row">
                    <span className="chat-pick__name">
                      {entry.name}
                      <span className="chat-mentions__handle">@{entry.handle}</span>
                    </span>
                    <Button
                      size="sm"
                      loading={busy.has(`add:${entry.type}:${entry.id}`)}
                      aria-label={t("people.addNamed", { name: entry.name })}
                      onClick={() => {
                        setAddFailed(null);
                        track(
                          `add:${entry.type}:${entry.id}`,
                          add
                            .mutateAsync({
                              ...args,
                              body: entry.type === "agent" ? { agentId: entry.id } : { userId: entry.id },
                            })
                            .then(() => {
                              outcome.done(t("people.added", { name: entry.name }));
                              setQuery("");
                            }),
                          // Said under the search, where it was asked: each add's own failure.
                          (error) => setAddFailed(error),
                        );
                      }}
                    >
                      {t("people.addOne")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {addFailed !== null && (
              <p className="chat-note chat-note--danger" role="alert">
                {describe(addFailed)}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A channel's monthly budget for agents, in USD. */
const BUDGET = { min: 0, max: 100_000, step: "any" } as const;

export function SettingsDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const outcome = useOutcome();
  const { workspaceId, me } = useConversation();
  const configures = can(me.role, "configure");
  const mark = decimalMark(useLocale().locale);
  // What the channel said when the dialog opened: only the fields the person changed from it are sent,
  // so a change someone else made meanwhile isn't written back over.
  const [opened] = useState(() => ({
    name: channel.name,
    topic: channel.topic,
    budgetPerMonthUsd: channel.budgetPerMonthUsd,
  }));
  const [name, setName] = useState(opened.name);
  const [topic, setTopic] = useState(opened.topic);
  const [budgetAsOpened] = useState(() =>
    opened.budgetPerMonthUsd === null ? "" : formatLimit(opened.budgetPerMonthUsd, mark),
  );
  const [budget, setBudget] = useState(budgetAsOpened);
  const save = useApiMutation("updateChannel", {
    invalidates: () => [{ method: "listChannels", args: { workspaceId } }],
  });
  // An amount as the language writes it ("1.5" in English, "1,5" in Portuguese), or nothing for no
  // limit of its own. A budget left as it was stays what it was, even one this field can't write (set
  // elsewhere with more decimals), and it never stops saving the rest; nor does it for someone who
  // can't change it.
  const budgetValue =
    budget === budgetAsOpened
      ? opened.budgetPerMonthUsd
      : budget.trim() === ""
        ? null
        : (readLimit(budget, BUDGET, mark) ?? Number.NaN);
  const budgetBad = configures && budgetValue !== null && Number.isNaN(budgetValue);
  const nameBad = name.trim() === "" || name.length > NAME_MAX;
  const topicBad = topic.length > TOPIC_MAX;
  const ready = !budgetBad && !nameBad && !topicBad;
  const submit = () => {
    if (!ready) return;
    save.mutate(
      {
        workspaceId,
        channelId: channel.id,
        body: {
          ...(!channel.isGeneral && name !== opened.name && { name }),
          ...(topic !== opened.topic && { topic }),
          ...(configures && budgetValue !== opened.budgetPerMonthUsd && { budgetPerMonthUsd: budgetValue }),
        },
      },
      {
        onSuccess: () => {
          outcome.done(t("setup.saved"));
          onClose();
        },
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={common("action.close")}
        title={t("setup.title", { channel: channel.name })}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">{common("action.cancel")}</Button>
            </DialogClose>
            <Button variant="primary" loading={save.isPending} disabled={!ready} onClick={submit}>
              {t("setup.save")}
            </Button>
          </>
        }
      >
        <form
          className="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            label={t("setup.name")}
            hint={channel.isGeneral ? t("setup.generalName") : undefined}
            error={name.length > NAME_MAX ? t("make.nameTooLong", { max: NAME_MAX }) : undefined}
          >
            <Input
              value={name}
              readOnly={channel.isGeneral}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label={t("setup.topic")}
            error={topicBad ? t("make.topicTooLong", { max: TOPIC_MAX }) : undefined}
          >
            <Textarea value={topic} rows={2} onChange={(event) => setTopic(event.target.value)} />
          </Field>
          {configures ? (
            <Field
              label={t("setup.budget")}
              hint={t("setup.budgetHint")}
              error={budgetBad ? t("setup.budgetBad") : undefined}
            >
              <Input inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />
            </Field>
          ) : (
            channel.budgetPerMonthUsd !== null && (
              <p className="chat-note">{t("setup.budgetRead", { amount: channel.budgetPerMonthUsd })}</p>
            )
          )}
          {save.isError && (
            <p className="chat-note chat-note--danger" role="alert">
              {describe(save.error)}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PinsDialog({ onClose }: { onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const { workspaceId, channelId } = useConversation();
  const authorName = useAuthorName();
  const pins = useApiQuery(
    "listChannelPinnedMessages",
    { workspaceId, channelId },
    { refetchInterval: PANEL_REFRESH_MS },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={common("action.close")} title={t("pins.title")}>
        {pins.isPending ? (
          <Waiting />
        ) : pins.isError ? (
          <Failed error={pins.error} onRetry={() => void pins.refetch()} />
        ) : pins.data.length === 0 ? (
          <p className="chat-note">{t("pins.empty")}</p>
        ) : (
          <ul className="chat-pick" aria-label={t("pins.list")}>
            {pins.data.map((pin) => (
              <li key={pin.messageId} className="chat-pick__row chat-pick__row--stack">
                <span className="chat-pick__name">{authorName(pin.message.author)}</span>
                <span className="chat-pick__topic">
                  {pin.message.meta.retracted !== undefined
                    ? t("pins.withdrawn")
                    : pin.message.body.slice(0, 200)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Pins a message to its channel, or takes the pin off. */
/** Pins of the open channel, where they apply: not in a direct message, nor for someone not in it. */
export function usePinToggle(applies: boolean) {
  const { workspaceId, channelId } = useConversation();
  const outcome = useOutcome();
  const t = useMessages("chat");
  const args = { workspaceId, channelId };
  const pins = useApiQuery("listChannelPinnedMessages", args, {
    refetchInterval: PANEL_REFRESH_MS,
    enabled: applies,
  });
  const stale = () => [{ method: "listChannelPinnedMessages" as const, args }];
  const pin = useApiMutation("updateChannelPinnedMessage", { invalidates: stale });
  const unpin = useApiMutation("deleteChannelPinnedMessage", { invalidates: stale });
  const queryClient = useQueryClient();
  const client = useVanrClient();
  const pinned = new Set((pins.data ?? []).map((each) => each.messageId));
  return {
    // Until the pins are known a toggle can't tell pinning from unpinning, so it waits.
    ready: pins.data !== undefined,
    isPinned: (messageId: string) => pinned.has(messageId),
    toggle: (messageId: string) =>
      (pinned.has(messageId) ? unpin : pin).mutate(
        { ...args, messageId },
        {
          onSuccess: () => outcome.done(pinned.has(messageId) ? t("pins.removed") : t("pins.added")),
          onError: (error) => {
            // Someone else unpinned it first: it is no longer pinned, which is what was asked.
            if (pinned.has(messageId) && error.status === 404) {
              queryClient.setQueryData<MessagePin[]>(
                queryKey(client, "listChannelPinnedMessages", args),
                (now) => now?.filter((each) => each.messageId !== messageId),
              );
              void pins.refetch();
              outcome.done(t("pins.removed"));
            } else outcome.failed(error);
          },
        },
      ),
  };
}
