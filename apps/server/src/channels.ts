// Channel access. Public channel of the workspace: any member reads it. Private channel and DM: members only.
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { BudgetScope } from "@vanr/engine/usage";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { isUniqueViolation } from "./db-errors";
import { notFound } from "./http";

const { channels, channelMemberships } = schema;

export type ChannelRow = typeof channels.$inferSelect;

/** Limit of a channel without a cap: it never hits, but the reservation goes through it and the spend is counted. */
const UNCAPPED_USD = 1_000_000_000;

/**
 * The channel's scope for every call with a channel: the cap when there is one, otherwise a limit that
 * never hits. The counter always moves, so turning the cap on or raising it mid-month already sees what
 * the channel spent.
 */
export async function channelSpendScope(db: Db, channelId: string): Promise<BudgetScope> {
  return (
    (await channelBudgetScope(db, channelId)) ?? {
      kind: "channel",
      id: channelId,
      limitUsd: UNCAPPED_USD,
      period: "month",
    }
  );
}

export async function channelBudgetScope(db: Db, channelId: string): Promise<BudgetScope | null> {
  const [row] = await db
    .select({ limit: channels.budgetPerMonthUsd })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (row?.limit == null) return null;
  return { kind: "channel", id: channelId, limitUsd: row.limit, period: "month" };
}
export type ActorType = "person" | "agent";

export async function channelInWorkspace(
  db: Db,
  workspaceId: string,
  channelId: string,
): Promise<ChannelRow | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)));
  return row ?? null;
}

export async function isChannelMember(
  db: Db,
  channelId: string,
  member: { type: ActorType; id: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: channelMemberships.memberId })
    .from(channelMemberships)
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.memberType, member.type),
        eq(channelMemberships.memberId, member.id),
      ),
    );
  return !!row;
}

/**
 * The agent may post in the channel: a workspace channel (not a DM), not archived and, if private, with the
 * agent in it. Checked when asked and again when it goes out (undo window).
 */
export async function agentCanPost(db: Db, channel: ChannelRow, agentId: string): Promise<boolean> {
  if (channel.kind !== "channel" || channel.archivedAt) return false;
  return channel.visibility !== "private" || isChannelMember(db, channel.id, { type: "agent", id: agentId });
}

/**
 * Subquery with the channels the person reads (the workspace's public ones and the private ones and DMs they
 * belong to), to filter in SQL before the `limit`: filtering after the cut loses what they see.
 */
export function readableChannelsSql(viewer: { workspaceId: string; userId: string }): SQL {
  return sql`(
    select ${channels.id} from ${channels}
    where ${channels.workspaceId} = ${viewer.workspaceId}
      and ((${channels.kind} = 'channel' and ${channels.visibility} = 'public')
        or ${channels.id} in (
          select ${channelMemberships.channelId} from ${channelMemberships}
          where ${channelMemberships.memberType} = 'person' and ${channelMemberships.memberId} = ${viewer.userId}))
  )`;
}

/** Subquery with the channels the agent belongs to. */
export function agentChannelsSql(agentId: string): SQL {
  return sql`(
    select ${channelMemberships.channelId} from ${channelMemberships}
    where ${channelMemberships.memberType} = 'agent' and ${channelMemberships.memberId} = ${agentId}
  )`;
}

const isOpen = (c: ChannelRow) => c.kind === "channel" && c.visibility === "public";

/** A public channel of the workspace: whoever is in the workspace reads it. */
export async function isPublicChannel(db: Db, workspaceId: string, channelId: string): Promise<boolean> {
  const channel = await channelInWorkspace(db, workspaceId, channelId);
  return channel !== null && isOpen(channel);
}

export async function canReadChannel(
  db: Db,
  input: { workspaceId: string; userId: string; channelId: string },
): Promise<boolean> {
  const channel = await channelInWorkspace(db, input.workspaceId, input.channelId);
  if (!channel) return false;
  if (isOpen(channel)) return true;
  return isChannelMember(db, channel.id, { type: "person", id: input.userId });
}

/**
 * Channel the person can read, with whether they are a member.
 * A private channel they don't belong to answers 404, like a channel that doesn't exist.
 */
export async function readableChannel(
  db: Db,
  input: { workspaceId: string; userId: string; channelId: string },
): Promise<{ channel: ChannelRow; isMember: boolean }> {
  const channel = await channelInWorkspace(db, input.workspaceId, input.channelId);
  if (!channel) throw notFound("Channel not found");
  const isMember = await isChannelMember(db, channel.id, { type: "person", id: input.userId });
  if (!isMember && !isOpen(channel)) throw notFound("Channel not found");
  return { channel, isMember };
}

/** To write: a channel member. In a public channel, someone who hasn't joined yet joins by writing. */
export async function writableChannel(
  db: Db,
  input: { workspaceId: string; userId: string; channelId: string },
): Promise<ChannelRow> {
  const { channel, isMember } = await readableChannel(db, input);
  if (!isMember) {
    await db
      .insert(channelMemberships)
      .values({ channelId: channel.id, memberType: "person", memberId: input.userId })
      .onConflictDoNothing();
  }
  return channel;
}

/** Opens (or finds) the person's DM with another person or with an agent. Two opens at once give the same DM. */
export async function openDm(
  db: Db,
  input: { workspaceId: string; userId: string; other: { type: ActorType; id: string } },
): Promise<string> {
  const { workspaceId, userId, other } = input;
  const dmKey = [`person:${userId}`, `${other.type}:${other.id}`].sort().join("|");
  const find = async () =>
    (
      await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.dmKey, dmKey)))
    )[0];
  const existing = await find();
  if (existing) return existing.id;
  const id = newId("ch");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(channels).values({
        id,
        workspaceId,
        name: "dm",
        visibility: "private",
        kind: "dm",
        dmKey,
        createdBy: userId,
      });
      const rows: (typeof channelMemberships.$inferInsert)[] = [
        { channelId: id, memberType: "person", memberId: userId },
      ];
      // In a DM with an agent it answers without a mention; a DM with oneself has a single row.
      if (other.type === "agent")
        rows.push({ channelId: id, memberType: "agent", memberId: other.id, autoAnswer: true });
      else if (other.id !== userId) rows.push({ channelId: id, memberType: "person", memberId: other.id });
      await tx.insert(channelMemberships).values(rows);
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await find();
    if (raced) return raced.id;
    throw err;
  }
  return id;
}
