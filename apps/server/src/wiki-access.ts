// Who reads a wiki page: the whole workspace, whoever reads one channel, or a list of people and agents. The
// same rule exists in SQL (`readablePagesSql`, to filter before a `limit`) and in JS (`canReadPage`, for one
// page already read); a fuzz test checks that both give the same answer. A page the reader doesn't read
// answers 404, like one that doesn't exist.
//
// An agent reading for a person (a run, a DM): both must read it (the intersection), as in the search.
import type { ActorRef, WikiAccessInput, WikiAccess as WikiAccessView } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import type { ChunkScope } from "@vanr/engine/search";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import {
  agentChannelsSql,
  canReadChannel,
  channelInWorkspace,
  isChannelMember,
  readableChannelsSql,
} from "./channels";
import { HttpError } from "./http";

const { knowledgePages, members, agents, users, channels } = schema;

/** A restricted page's access, as stored (`knowledge_pages.access`). */
export type WikiAccess = NonNullable<(typeof knowledgePages.$inferSelect)["access"]>;

/** Who reads: a person, an agent or an agent for a person. With neither, only the workspace's pages. */
export interface WikiViewer {
  workspaceId: string;
  userId?: string;
  agentId?: string;
}

/** The viewer a write's actor reads as: the person, or the agent alone. */
export const viewerOfActor = (workspaceId: string, actor: ActorRef): WikiViewer =>
  actor.type === "person" ? { workspaceId, userId: actor.id } : { workspaceId, agentId: actor.id };

export const userKey = (id: string) => `user:${id}`;
export const agentKey = (id: string) => `agent:${id}`;

/** The SQL condition on `knowledge_pages`: the page is the workspace's, or the reader is in its access. */
export function readablePagesSql(viewer: WikiViewer): SQL {
  const open = sql`${knowledgePages.access} is null`;
  const parts: SQL[] = [];
  if (viewer.userId)
    parts.push(sql`(${open}
      or (${knowledgePages.access}->>'kind' = 'private'
        and ${knowledgePages.access}->'principals' @> jsonb_build_array(${userKey(viewer.userId)}::text))
      or (${knowledgePages.access}->>'kind' = 'channel'
        and ${knowledgePages.access}->>'channelId' in ${readableChannelsSql({ workspaceId: viewer.workspaceId, userId: viewer.userId })}))`);
  if (viewer.agentId)
    parts.push(sql`(${open}
      or (${knowledgePages.access}->>'kind' = 'private'
        and ${knowledgePages.access}->'principals' @> jsonb_build_array(${agentKey(viewer.agentId)}::text))
      or (${knowledgePages.access}->>'kind' = 'channel'
        and ${knowledgePages.access}->>'channelId' in ${agentChannelsSql(viewer.agentId)}))`);
  const [first, ...rest] = parts;
  if (!first) return open;
  return rest.reduce<SQL>((acc, p) => sql`(${acc} and ${p})`, first);
}

/** The same rule as `readablePagesSql`, for one page already read. */
export async function canReadPage(
  db: Db,
  viewer: WikiViewer,
  row: { workspaceId: string; access: WikiAccess | null },
): Promise<boolean> {
  if (row.workspaceId !== viewer.workspaceId) return false;
  const access = row.access;
  if (!access) return true;
  if (!viewer.userId && !viewer.agentId) return false;
  if (access.kind === "private") {
    if (viewer.userId && !access.principals.includes(userKey(viewer.userId))) return false;
    if (viewer.agentId && !access.principals.includes(agentKey(viewer.agentId))) return false;
    return true;
  }
  if (
    viewer.userId &&
    !(await canReadChannel(db, {
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      channelId: access.channelId,
    }))
  )
    return false;
  if (viewer.agentId && !(await isChannelMember(db, access.channelId, { type: "agent", id: viewer.agentId })))
    return false;
  return true;
}

/**
 * Whether everyone who reads `inner` also reads `outer`, decided on the access alone: the whole workspace
 * contains everything; the same channel contains itself; a list contains a list of some of its principals.
 * Anything else (a list against a channel) is "not contained", the safe answer.
 */
export function audienceWithin(inner: WikiAccess | null, outer: WikiAccess | null): boolean {
  if (!outer) return true;
  if (!inner) return false;
  if (outer.kind === "channel") return inner.kind === "channel" && inner.channelId === outer.channelId;
  return inner.kind === "private" && inner.principals.every((p) => outer.principals.includes(p));
}

/** The scope of the page's chunks in the search (seam 5): the page's own audience. */
export function accessScope(access: WikiAccess | null): ChunkScope {
  if (!access) return { kind: "workspace" };
  if (access.kind === "channel") return { kind: "channel", channelId: access.channelId };
  return { kind: "private", principals: [...access.principals] };
}

/**
 * The new access a person asks for. Whoever restricts keeps reading: in `private` they are always in it, in
 * `channel` they must read the channel. People and agents must be the workspace's.
 */
export async function parseAccess(
  db: Db,
  me: { workspaceId: string; userId: string },
  input: WikiAccessInput,
): Promise<WikiAccess | null> {
  if (input === null) return null;
  if (input.kind === "channel") {
    const channel = await channelInWorkspace(db, me.workspaceId, input.channelId);
    if (channel?.kind !== "channel" || !(await canReadChannel(db, { ...me, channelId: channel.id })))
      throw new HttpError(400, "wiki.access.channel", "Pick a channel you can read");
    return { kind: "channel", channelId: channel.id };
  }
  const userIds = [...new Set([me.userId, ...input.userIds])];
  const agentIds = [...new Set(input.agentIds)];
  const okUsers = await db
    .select({ id: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, me.workspaceId), inArray(members.userId, userIds)));
  const okAgents = agentIds.length
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, me.workspaceId),
            inArray(agents.id, agentIds),
            isNull(agents.archivedAt),
          ),
        )
    : [];
  if (okUsers.length !== userIds.length || okAgents.length !== agentIds.length)
    throw new HttpError(400, "wiki.access.principal", "Everyone on the list must be in this workspace");
  return {
    kind: "private",
    principals: [...userIds.map(userKey), ...agentIds.map(agentKey)].sort(),
  };
}

/** The access as the screen shows it: the names of the channel, the people and the agents. */
export async function accessView(db: Db, access: WikiAccess | null): Promise<WikiAccessView | null> {
  if (!access) return null;
  if (access.kind === "channel") {
    const [ch] = await db
      .select({ name: channels.name })
      .from(channels)
      .where(eq(channels.id, access.channelId));
    return { kind: "channel", channelId: access.channelId, channelName: ch?.name ?? null };
  }
  const userIds = access.principals.filter((p) => p.startsWith("user:")).map((p) => p.slice(5));
  const agentIds = access.principals.filter((p) => p.startsWith("agent:")).map((p) => p.slice(6));
  const [people, bots] = await Promise.all([
    userIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : [],
    agentIds.length
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [],
  ]);
  return {
    kind: "private",
    people: userIds.map((id) => ({ id, name: people.find((p) => p.id === id)?.name ?? null })),
    agents: agentIds.map((id) => ({ id, name: bots.find((a) => a.id === id)?.name ?? null })),
  };
}
