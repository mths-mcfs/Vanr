// The conversations in the sidebar, in three groups that fold: channels, agents and people. Only
// what the server lists is drawn, so a private channel someone is not in never shows, not even its
// count. A conversation with something unread stands out and says how much.
import { useApiQuery } from "@vanr/client/react";
import { AgentSigil, Avatar, Icon, Skeleton } from "@vanr/ui";
import { ChevronDown, Hash, Lock } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { AppLink, useRouteParams } from "../../app/navigation.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

const shown = (count: number) => (count > 99 ? "99+" : String(count));

function Group({
  title,
  label,
  count,
  children,
}: {
  title: string;
  /** What the fold button says to a screen reader; it holds the visible title. */
  label: string;
  /** Unread messages in the whole group, said on the folded heading. */
  count: number;
  children: ReactNode;
}) {
  const t = useMessages("chat");
  const [open, setOpen] = useState(true);
  const body = useId();
  return (
    <div className="chat-side__group">
      <button
        type="button"
        className="chat-side__fold"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={ChevronDown} size="sm" className="chat-side__chevron" />
        <span aria-hidden="true">{title}</span>
        <span className="vr-visually-hidden">{label}</span>
        {!open && count > 0 && <Unread count={count} label={t("side.unread", { count })} />}
      </button>
      {open && (
        <div id={body} className="chat-side__items">
          {children}
        </div>
      )}
    </div>
  );
}

function Unread({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return (
    <>
      <span className="side__count" aria-hidden="true">
        {shown(count)}
      </span>
      <span className="vr-visually-hidden">{label}</span>
    </>
  );
}

function Failed({ what, onRetry }: { what: string; onRetry: () => void }) {
  const common = useMessages("common");
  return (
    <p className="side__quiet" role="alert">
      {what}{" "}
      <button type="button" className="app-link-button" onClick={onRetry}>
        {common("action.retry")}
      </button>
    </p>
  );
}

function Loading() {
  return (
    <div className="side__quiet" aria-busy="true">
      <Skeleton />
    </div>
  );
}

export function ChannelList() {
  const t = useMessages("chat");
  const { workspaceId } = useRouteParams("home");
  const { me } = useSession();
  const scope = { workspaceId };
  const channels = useApiQuery("listChannels", scope);
  const dms = useApiQuery("getDms", scope);
  const agents = useApiQuery("listAgents", scope);
  const members = useApiQuery("getPeople", scope);

  const dmChannels = new Set((dms.data ?? []).map((dm) => dm.channelId));
  const rooms = (channels.data ?? []).filter((channel) => !dmChannels.has(channel.id));
  const visible = rooms.filter((channel) => channel.isMember);
  const agentUnread = new Map(
    (dms.data ?? []).filter((dm) => dm.with.type === "agent").map((dm) => [dm.with.id, dm.unread]),
  );
  const people = (dms.data ?? []).filter((dm) => dm.with.type === "person");
  const online = new Set(
    (members.data ?? []).filter((member) => member.online).map((member) => member.userId),
  );
  const teammates = (agents.data ?? []).filter((agent) => agent.archivedAt === null);

  return (
    <div className="chat-side">
      <Group
        title={t("side.channels")}
        label={t("side.channelsGroup")}
        count={visible.reduce((sum, channel) => sum + channel.unreadCount, 0)}
      >
        {channels.isPending ? (
          <Loading />
        ) : channels.isError ? (
          <Failed what={t("side.channelsFailed")} onRetry={() => void channels.refetch()} />
        ) : visible.length === 0 ? (
          <p className="side__quiet">{t("side.noChannels")}</p>
        ) : (
          <ul className="chat-side__list">
            {visible.map((channel) => {
              const priv = channel.visibility === "private";
              return (
                <li key={channel.id}>
                  <AppLink
                    className="side__link chat-side__link"
                    route="channel"
                    params={{ workspaceId, channelId: channel.id }}
                    data-unread={channel.unreadCount > 0 || undefined}
                  >
                    <Icon icon={priv ? Lock : Hash} size="sm" />
                    <span className="chat-side__name">{channel.name}</span>
                    {priv && <span className="vr-visually-hidden">{t("room.private")}</span>}
                    <Unread
                      count={channel.unreadCount}
                      label={t("side.unread", { count: channel.unreadCount })}
                    />
                  </AppLink>
                </li>
              );
            })}
          </ul>
        )}
      </Group>
      <Group
        title={t("side.agents")}
        label={t("side.agentsGroup")}
        count={[...agentUnread.values()].reduce((sum, count) => sum + count, 0)}
      >
        {agents.isPending ? (
          <Loading />
        ) : agents.isError ? (
          <Failed what={t("side.agentsFailed")} onRetry={() => void agents.refetch()} />
        ) : teammates.length === 0 ? (
          <p className="side__quiet">{t("side.noAgents")}</p>
        ) : (
          <ul className="chat-side__list">
            {teammates.map((agent) => {
              const unread = agentUnread.get(agent.id) ?? 0;
              return (
                <li key={agent.id}>
                  <AppLink
                    className="side__link chat-side__link"
                    route="dmAgent"
                    params={{ workspaceId, agentId: agent.id }}
                    data-unread={unread > 0 || undefined}
                  >
                    <AgentSigil
                      agentId={agent.id}
                      name=""
                      size="sm"
                      aria-hidden="true"
                      working={agent.busy}
                    />
                    <span className="chat-side__name">{agent.name}</span>
                    <Unread count={unread} label={t("side.unread", { count: unread })} />
                  </AppLink>
                </li>
              );
            })}
          </ul>
        )}
      </Group>
      <Group
        title={t("side.people")}
        label={t("side.peopleGroup")}
        count={people.reduce((sum, dm) => sum + dm.unread, 0)}
      >
        {dms.isPending ? (
          <Loading />
        ) : dms.isError ? (
          <Failed what={t("side.peopleFailed")} onRetry={() => void dms.refetch()} />
        ) : people.length === 0 ? (
          <p className="side__quiet">{t("side.noPeople")}</p>
        ) : (
          <ul className="chat-side__list">
            {people.map((dm) => {
              const self = dm.with.id === me?.user.id;
              const name = self ? t("side.you", { name: dm.with.name }) : dm.with.name;
              return (
                <li key={dm.channelId}>
                  <AppLink
                    className="side__link chat-side__link"
                    route="dmPerson"
                    params={{ workspaceId, userId: dm.with.id }}
                    data-unread={dm.unread > 0 || undefined}
                  >
                    <span className="chat-side__person" data-online={online.has(dm.with.id) || undefined}>
                      <Avatar name={dm.with.name} size="sm" aria-hidden="true" />
                    </span>
                    <span className="chat-side__name">{name}</span>
                    <span className="vr-visually-hidden">
                      {online.has(dm.with.id) ? t("side.online") : t("side.away")}
                    </span>
                    <Unread count={dm.unread} label={t("side.unread", { count: dm.unread })} />
                  </AppLink>
                </li>
              );
            })}
          </ul>
        )}
      </Group>
    </div>
  );
}
