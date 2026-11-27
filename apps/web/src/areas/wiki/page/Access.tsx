// Who reads a page: the whole workspace, only some people and agents, or whoever reads a channel. Only
// who created the page or an admin is offered this (the server's `accessEditable`). Whoever restricts
// stays among the readers: the server always keeps them in.
import { useApiMutation, useApiQuery } from "@vanr/client/react";
import type { WikiAccessInput, WikiPage } from "@vanr/contract";
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
} from "@vanr/ui";
import { useEffect, useState } from "react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useMessages } from "../../../i18n/react.tsx";

type Kind = "workspace" | "private" | "channel";

export function AccessDialog({
  workspaceId,
  page,
  userId,
  onClose,
  onSaved,
  beforeSave,
  onBusy,
}: {
  workspaceId: string;
  page: WikiPage;
  userId: string | undefined;
  onClose: () => void;
  onSaved: (page: WikiPage) => void;
  /**
   * Waits for the live draft's changes still on their way: restricting moves the page to a new address,
   * which closes this live document. False when they did not all reach the server.
   */
  beforeSave: () => Promise<boolean>;
  /**
   * Whether saving is under way, from the wait for the live draft until the answer: the page keeps its
   * editor read only meanwhile, so no change is made on a live document about to close.
   */
  onBusy: (busy: boolean) => void;
}) {
  const t = useMessages("wiki");
  const common = useMessages("common");
  const describe = useErrorMessage("wiki");
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  const channels = useApiQuery("listChannels", { workspaceId });
  const current = page.access;
  const [kind, setKind] = useState<Kind>(current === null ? "workspace" : current.kind);
  const [people, setPeople] = useState<string[]>(
    current?.kind === "private" ? current.people.map((person) => person.id) : [],
  );
  const [bots, setBots] = useState<string[]>(
    current?.kind === "private" ? current.agents.map((agent) => agent.id) : [],
  );
  const [channelId, setChannelId] = useState(current?.kind === "channel" ? current.channelId : "");
  const save = useApiMutation("setWikiPageAccess", { onSuccess: onSaved });
  const [waiting, setWaiting] = useState(false);
  const [unsent, setUnsent] = useState(false);
  const busy = waiting || save.isPending;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((each) => each !== id);

  const access: WikiAccessInput | undefined =
    kind === "workspace"
      ? null
      : kind === "private"
        ? {
            kind: "private",
            userIds: [...new Set([...people, ...(userId === undefined ? [] : [userId])])],
            agentIds: bots,
          }
        : channelId === ""
          ? undefined
          : { kind: "channel", channelId };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        title={t("access.title", { title: page.title })}
        description={t("access.lead")}
        closeLabel={common("action.close")}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {common("action.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={access === undefined}
              loading={busy}
              onClick={() => {
                if (access === undefined) return;
                setWaiting(true);
                setUnsent(false);
                void beforeSave().then((ready) => {
                  setWaiting(false);
                  if (ready) save.mutate({ workspaceId, pageId: page.slug, body: { access } });
                  else setUnsent(true);
                });
              }}
            >
              {t("access.save")}
            </Button>
          </>
        }
      >
        <div className="wiki-form">
          <RadioGroup
            aria-label={t("access.who")}
            value={kind}
            disabled={busy}
            onValueChange={(value) =>
              setKind(value === "private" ? "private" : value === "channel" ? "channel" : "workspace")
            }
          >
            <Radio value="workspace" label={t("access.workspace")} />
            <Radio value="private" label={t("access.private")} hint={t("access.privateHint")} />
            <Radio value="channel" label={t("access.channel")} />
          </RadioGroup>
          {kind === "private" && (
            <fieldset className="wiki-access__people">
              <legend>{t("access.people")}</legend>
              {(members.data ?? []).map((member) => (
                <Checkbox
                  key={member.userId}
                  label={member.userId === userId ? t("access.you", { name: member.name }) : member.name}
                  checked={member.userId === userId || people.includes(member.userId)}
                  disabled={busy || member.userId === userId}
                  onCheckedChange={(on) => setPeople((list) => toggle(list, member.userId, on === true))}
                />
              ))}
              {(agents.data ?? []).length > 0 && <legend>{t("access.agents")}</legend>}
              {(agents.data ?? []).map((agent) => (
                <Checkbox
                  key={agent.id}
                  label={agent.name}
                  checked={bots.includes(agent.id)}
                  disabled={busy}
                  onCheckedChange={(on) => setBots((list) => toggle(list, agent.id, on === true))}
                />
              ))}
            </fieldset>
          )}
          {kind === "channel" && (
            <Select
              aria-label={t("access.pickChannel")}
              placeholder={t("access.pickChannel")}
              value={channelId}
              disabled={busy}
              onValueChange={setChannelId}
            >
              {(channels.data ?? []).map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  #{channel.name}
                </SelectItem>
              ))}
            </Select>
          )}
          {unsent && (
            <Callout tone="warning" role="alert">
              {t("access.stillSyncing")}
            </Callout>
          )}
          {save.isError && (
            <Callout tone="danger" role="alert" title={t("access.failed")}>
              {describe(save.error)}
            </Callout>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Who reads a restricted page, in a line. */
export function accessSummary(page: WikiPage, t: ReturnType<typeof useMessages<"wiki">>): string | null {
  const access = page.access;
  if (access === null) return page.restricted ? t("access.restricted") : null;
  if (access.kind === "channel")
    return t("access.byChannel", { channel: access.channelName ?? access.channelId });
  const names = [...access.people, ...access.agents].map((each) => each.name ?? "?");
  return t("access.byPeople", { names: names.join(", ") });
}
