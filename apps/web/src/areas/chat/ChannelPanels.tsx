// What a channel's header opens: its people and agents (add, remove, leave), its settings (name,
// topic, the monthly budget), and its pinned messages. The server decides each action; a control is
// offered only to who it allows. Members and pins send no event, so both are read again each minute.
import { useQueryClient } from "@tanstack/react-query";
import { useApiMutation, useApiQuery, useVanrClient } from "@vanr/client/react";
import { type Channel, can } from "@vanr/contract";
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
import { useState } from "react";
import { useGo } from "../../app/navigation.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { forgetChannelQueries } from "../../realtime/react.tsx";
import { useOutcome } from "../control/shared.tsx";
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
  const go = useGo();
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
  const removeAgent = useApiMutation("deleteChannelMemberAgent", { invalidates: stale });
  const managesMembers = can(me.role, "manage_members");
  const inside = new Set((members.data ?? []).map((entry) => `${entry.type}:${entry.id}`));
  const q = query.trim().toLowerCase();
  const fits = (name: string, handle: string) =>
    q !== "" && (name.toLowerCase().includes(q) || handle.toLowerCase().includes(q));
  const candidates = [
    ...(agents.data ?? [])
      .filter(
        (agent) =>
          agent.archivedAt === null && !inside.has(`agent:${agent.id}`) && fits(agent.name, agent.handle),
      )
      .map((agent) => ({ type: "agent" as const, id: agent.id, name: agent.name, handle: agent.handle })),
    ...(people.data ?? [])
      .filter((person) => !inside.has(`person:${person.userId}`) && fits(person.name, person.handle))
      .map((person) => ({
        type: "person" as const,
        id: person.userId,
        name: person.name,
        handle: person.handle,
      })),
  ];
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
                      aria-label={t("people.removeNamed", { name: name(entry) })}
                      onClick={() =>
                        entry.type === "agent"
                          ? removeAgent.mutate(
                              { ...args, agentId: entry.id },
                              { onError: (error) => outcome.failed(error) },
                            )
                          : removePerson.mutate(
                              { ...args, personId: entry.id },
                              { onError: (error) => outcome.failed(error) },
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
                      loading={removePerson.isPending}
                      onClick={() =>
                        removePerson.mutate(
                          { ...args, personId: me.userId },
                          {
                            onSuccess: () => {
                              outcome.done(t("people.left", { channel: channel.name }));
                              onClose();
                              void go("home", { workspaceId });
                              // Out of a private channel nothing of it may stay: the server says no more.
                              if (channel.visibility === "private")
                                forgetChannelQueries(queryClient, client, workspaceId, channelId);
                            },
                            onError: (error) => outcome.failed(error),
                          },
                        )
                      }
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
                      loading={add.isPending && add.variables?.body !== undefined}
                      aria-label={t("people.addNamed", { name: entry.name })}
                      onClick={() =>
                        add.mutate(
                          {
                            ...args,
                            body: entry.type === "agent" ? { agentId: entry.id } : { userId: entry.id },
                          },
                          {
                            onSuccess: () => {
                              outcome.done(t("people.added", { name: entry.name }));
                              setQuery("");
                            },
                          },
                        )
                      }
                    >
                      {t("people.addOne")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {add.isError && (
              <p className="chat-note chat-note--danger" role="alert">
                {describe(add.error)}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SettingsDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const outcome = useOutcome();
  const { workspaceId, me } = useConversation();
  const configures = can(me.role, "configure");
  // What the channel said when the dialog opened: only the fields the person changed from it are sent,
  // so a change someone else made meanwhile isn't written back over.
  const [opened] = useState(() => ({
    name: channel.name,
    topic: channel.topic,
    budgetPerMonthUsd: channel.budgetPerMonthUsd,
  }));
  const [name, setName] = useState(opened.name);
  const [topic, setTopic] = useState(opened.topic);
  const [budget, setBudget] = useState(
    opened.budgetPerMonthUsd === null ? "" : String(opened.budgetPerMonthUsd),
  );
  const save = useApiMutation("updateChannel", {
    invalidates: () => [{ method: "listChannels", args: { workspaceId } }],
  });
  const budgetValue = budget.trim() === "" ? null : Number(budget);
  const budgetBad =
    budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue < 0 || budgetValue > 100_000);
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
export function usePinToggle() {
  const { workspaceId, channelId } = useConversation();
  const outcome = useOutcome();
  const t = useMessages("chat");
  const args = { workspaceId, channelId };
  const pins = useApiQuery("listChannelPinnedMessages", args, { refetchInterval: PANEL_REFRESH_MS });
  const stale = () => [{ method: "listChannelPinnedMessages" as const, args }];
  const pin = useApiMutation("updateChannelPinnedMessage", { invalidates: stale });
  const unpin = useApiMutation("deleteChannelPinnedMessage", { invalidates: stale });
  const pinned = new Set((pins.data ?? []).map((each) => each.messageId));
  return {
    isPinned: (messageId: string) => pinned.has(messageId),
    toggle: (messageId: string) =>
      (pinned.has(messageId) ? unpin : pin).mutate(
        { ...args, messageId },
        {
          onSuccess: () => outcome.done(pinned.has(messageId) ? t("pins.removed") : t("pins.added")),
          onError: (error) => outcome.failed(error),
        },
      ),
  };
}
