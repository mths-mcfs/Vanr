// What every piece of an open conversation reads: the workspace and the channel, who is looking, the
// names of the people and agents in it, the channels this person can read (a card links only to
// those), and whether they are a member. The server decides every action; these only hide controls.
import { useApiQuery } from "@vanr/client/react";
import { can, type DirectoryMember } from "@vanr/contract";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useDirectory, useMe } from "../control/cards.ts";
import type { Directory, Me } from "../control/shared.tsx";
import type { MentionLookup } from "./body.tsx";

export type Conversation = {
  workspaceId: string;
  channelId: string;
  me: Me;
  directory: Directory;
  /** The people and agents of this conversation, for mentions and who answers. */
  people: readonly DirectoryMember[];
  readableChannels: ReadonlySet<string>;
  member: boolean;
  mention: MentionLookup;
  /** May stop this agent's run: whoever manages agents, its owner, or whoever asked for the run. */
  mayStop: (agentId: string, initiatedBy: string | null) => boolean;
};

const ConversationContext = createContext<Conversation | null>(null);

export function useConversation(): Conversation {
  const value = useContext(ConversationContext);
  if (value === null) throw new Error("useConversation must be used inside <ConversationProvider>");
  return value;
}

export function ConversationProvider({
  workspaceId,
  channelId,
  member,
  children,
}: {
  workspaceId: string;
  channelId: string;
  member: boolean;
  children: ReactNode;
}) {
  const signedIn = useMe(workspaceId);
  const me = useMemo(
    () => ({ userId: signedIn.userId, role: signedIn.role }),
    [signedIn.userId, signedIn.role],
  );
  const directory = useDirectory(workspaceId);
  const listed = useApiQuery("getChannelDirectory", { workspaceId, channelId });
  const channels = useApiQuery("listChannels", { workspaceId });
  const people = listed.data;
  const channelList = channels.data;
  const value = useMemo((): Conversation => {
    const byHandle = new Map(
      (people ?? []).flatMap((entry) =>
        entry.handle === null ? [] : [[entry.handle.toLowerCase(), entry] as const],
      ),
    );
    return {
      workspaceId,
      channelId,
      me,
      directory,
      people: people ?? [],
      readableChannels: new Set((channelList ?? []).map((channel) => channel.id)),
      member,
      mention: (handle) => {
        const found = byHandle.get(handle.toLowerCase());
        return found === undefined ? undefined : { name: found.name, kind: found.type };
      },
      mayStop: (agentId, initiatedBy) =>
        can(me.role, "manage_agents") ||
        directory.agentOwner(agentId) === me.userId ||
        (initiatedBy !== null && initiatedBy === me.userId),
    };
  }, [workspaceId, channelId, me, directory, people, channelList, member]);
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}
