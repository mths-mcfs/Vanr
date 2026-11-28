// Making a channel, finding one to join, and starting a direct message with a person. Each opens the
// conversation once it exists; a failure stays in the dialog so nothing typed is lost.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { ChannelVisibility } from "@vanr/contract";
import { channelName } from "@vanr/engine/text";
import {
  Avatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Input,
  Radio,
  RadioGroup,
  Skeleton,
  Textarea,
} from "@vanr/ui";
import { Hash, Lock } from "lucide-react";
import { useState } from "react";
import { useGo } from "../../app/navigation.tsx";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

export const NAME_MAX = 120;
export const TOPIC_MAX = 250;

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
      <Skeleton />
    </div>
  );
}

export function NewChannelDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const go = useGo();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<ChannelVisibility>("public");
  const create = useApiMutation("createChannel", {
    invalidates: () => [{ method: "listChannels", args: { workspaceId } }],
  });
  const slug = channelName(name);
  const ready = slug !== "" && name.length <= NAME_MAX && topic.length <= TOPIC_MAX;
  const submit = () => {
    if (!ready) return;
    create.mutate(
      { workspaceId, body: { name: slug, visibility, ...(topic.trim() !== "" && { topic: topic.trim() }) } },
      {
        onSuccess: (channel) => {
          onClose();
          void go("channel", { workspaceId, channelId: channel.id });
        },
      },
    );
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={common("action.close")}
        title={t("make.title")}
        description={t("make.lead")}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">{common("action.cancel")}</Button>
            </DialogClose>
            <Button variant="primary" loading={create.isPending} disabled={!ready} onClick={submit}>
              {t("make.go")}
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
            label={t("make.name")}
            hint={slug === "" ? t("make.nameHint") : t("make.preview", { name: slug })}
            error={name.length > NAME_MAX ? t("make.nameTooLong", { max: NAME_MAX }) : undefined}
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field
            label={t("make.topic")}
            error={topic.length > TOPIC_MAX ? t("make.topicTooLong", { max: TOPIC_MAX }) : undefined}
          >
            <Textarea value={topic} rows={2} onChange={(event) => setTopic(event.target.value)} />
          </Field>
          <Field label={t("make.who")}>
            <RadioGroup
              value={visibility}
              onValueChange={(value) => setVisibility(value === "private" ? "private" : "public")}
            >
              <Radio value="public" label={t("make.public")} hint={t("make.publicHint")} />
              <Radio value="private" label={t("make.private")} hint={t("make.privateHint")} />
            </RadioGroup>
          </Field>
          {create.isError && (
            <p className="chat-note chat-note--danger" role="alert">
              {describe(create.error)}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BrowseChannelsDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const describe = useErrorMessage("chat");
  const go = useGo();
  // Read again on every opening: a channel made a minute ago is there.
  const channels = useApiQuery("listChannels", { workspaceId }, { refetchOnMount: "always" });
  const dms = useApiQuery("getDms", { workspaceId });
  const join = useApiMutation("joinChannel", {
    invalidates: () => [{ method: "listChannels", args: { workspaceId } }],
  });
  const dmIds = new Set((dms.data ?? []).map((dm) => dm.channelId));
  const rooms = (channels.data ?? []).filter((channel) => !dmIds.has(channel.id));
  const open = (channelId: string) => {
    onClose();
    void go("channel", { workspaceId, channelId });
  };
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent closeLabel={common("action.close")} title={t("find.title")} description={t("find.lead")}>
        {channels.isPending || dms.isPending ? (
          <Waiting />
        ) : channels.isError ? (
          <Failed error={channels.error} onRetry={() => void channels.refetch()} />
        ) : rooms.length === 0 ? (
          <p className="chat-note">{t("find.empty")}</p>
        ) : (
          <ul className="chat-pick" aria-label={t("find.list")}>
            {rooms.map((channel) => (
              <li key={channel.id} className="chat-pick__row">
                <span className="chat-pick__name">
                  {channel.visibility === "private" ? (
                    <Lock aria-hidden="true" size={14} />
                  ) : (
                    <Hash aria-hidden="true" size={14} />
                  )}
                  {channel.name}
                </span>
                {channel.topic !== "" && <span className="chat-pick__topic">{channel.topic}</span>}
                <Button
                  size="sm"
                  variant={channel.isMember ? "ghost" : "secondary"}
                  loading={join.isPending && join.variables?.channelId === channel.id}
                  aria-label={
                    channel.isMember
                      ? t("find.openNamed", { channel: channel.name })
                      : t("find.joinNamed", { channel: channel.name })
                  }
                  onClick={() =>
                    channel.isMember
                      ? open(channel.id)
                      : join.mutate(
                          { workspaceId, channelId: channel.id },
                          { onSuccess: () => open(channel.id) },
                        )
                  }
                >
                  {channel.isMember ? t("find.open") : t("find.join")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {join.isError && (
          <p className="chat-note chat-note--danger" role="alert">
            {describe(join.error)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function NewMessageDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useMessages("chat");
  const common = useMessages("common");
  const go = useGo();
  const { me } = useSession();
  const people = useApiQuery("getPeople", { workspaceId });
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const found = (people.data ?? []).filter(
    (person) => q === "" || person.name.toLowerCase().includes(q) || person.handle.toLowerCase().includes(q),
  );
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent
        closeLabel={common("action.close")}
        title={t("dmNew.title")}
        description={t("dmNew.lead")}
      >
        <Field label={t("dmNew.search")}>
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        {people.isPending ? (
          <Waiting />
        ) : people.isError ? (
          <Failed error={people.error} onRetry={() => void people.refetch()} />
        ) : found.length === 0 ? (
          <p className="chat-note">{t("dmNew.none", { query: query.trim() })}</p>
        ) : (
          <ul className="chat-pick" aria-label={t("dmNew.list")}>
            {found.map((person) => (
              <li key={person.userId} className="chat-pick__row">
                <button
                  type="button"
                  className="chat-pick__person"
                  onClick={() => {
                    onClose();
                    void go("dmPerson", { workspaceId, userId: person.userId });
                  }}
                >
                  <Avatar name={person.name} size="sm" aria-hidden="true" />
                  <span>
                    {person.userId === me?.user.id ? t("side.you", { name: person.name }) : person.name}
                  </span>
                  <span className="chat-mentions__handle">@{person.handle}</span>
                  <span className="vr-visually-hidden">
                    {person.online ? t("side.online") : t("side.away")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
