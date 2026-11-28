// What the control center's screens and cards share: who the signed-in person is in the workspace,
// the names of the people and agents a card mentions, the toast a decision leaves, and the block a
// card is made of. The server decides every action; the role here only hides controls.
import { useApiQuery } from "@vanr/client/react";
import { can, type Role } from "@vanr/contract";
import { useToast } from "@vanr/ui";
import { type ReactNode, useMemo } from "react";
import { useErrorMessage } from "../../app/screens.tsx";
import { useMessages } from "../../i18n/react.tsx";
import { useSession } from "../../session/react.tsx";

export type Me = { userId: string; role: Role };

/** The signed-in person in this workspace. */
export function useMe(workspaceId: string): Me {
  const { me } = useSession();
  const role = me?.workspaces.find((workspace) => workspace.id === workspaceId)?.role ?? "member";
  return { userId: me?.user.id ?? "", role };
}

export const mayManageAgents = (me: Me) => can(me.role, "manage_agents");

export type Directory = {
  agentName: (agentId: string) => string;
  /** The agent's owner, once the agent list arrived. */
  agentOwner: (agentId: string) => string | undefined;
  personName: (userId: string | null) => string;
  /** Whether the person is a member, once the member list arrived. */
  isMember: (userId: string) => boolean;
  /** Agents by name, for filters. */
  agents: readonly { id: string; name: string }[];
};

/** Names for the ids on a card; a name not known (yet) reads "Someone". */
export function useDirectory(workspaceId: string): Directory {
  const t = useMessages("control");
  const members = useApiQuery("listMembers", { workspaceId });
  const agents = useApiQuery("listAgents", { workspaceId });
  return useMemo(() => {
    const people = new Map((members.data ?? []).map((member) => [member.userId, member.name]));
    const byId = new Map((agents.data ?? []).map((agent) => [agent.id, agent]));
    return {
      agentName: (agentId) => byId.get(agentId)?.name ?? t("someone"),
      agentOwner: (agentId) => byId.get(agentId)?.ownerUserId,
      isMember: (userId) => people.has(userId),
      personName: (userId) => (userId === null ? undefined : people.get(userId)) ?? t("someone"),
      agents: [...byId.values()]
        .map((agent) => ({ id: agent.id, name: agent.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [members.data, agents.data, t]);
}

/** Says a change went through, or why it did not, in a toast. */
export function useOutcome() {
  const toast = useToast();
  const describe = useErrorMessage("control");
  return {
    done: (title: string) => toast.push({ tone: "success", title }),
    failed: (error: unknown) => toast.push({ tone: "danger", title: describe(error) }),
    warn: (title: string) => toast.push({ tone: "warning", title }),
  };
}

/** One labelled part of a card: "To", "Why the agent asks". */
export function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="control-block">
      <h4 className="control-block__label">{label}</h4>
      {children}
    </div>
  );
}
