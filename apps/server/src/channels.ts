// Channel access. Public channel of the workspace: any member reads it. Private channel and DM: members only.
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { BudgetScope } from "@vanr/engine/usage";
import { and, asc, eq, inArray, isNull, notExists, type SQL, sql } from "drizzle-orm";
import { isUniqueViolation } from "./db-errors";
import { conflict, forbidden, notFound } from "./http";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
  db: Db | Tx,
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

/** The person joins the channel (already in: nothing changes). */
export async function joinChannel(db: Db | Tx, channelId: string, userId: string): Promise<void> {
  await db
    .insert(channelMemberships)
    .values({ channelId, memberType: "person", memberId: userId })
    .onConflictDoNothing();
}

/** To write: a channel member. In a public channel, someone who hasn't joined yet joins by writing. */
export async function writableChannel(
  db: Db,
  input: { workspaceId: string; userId: string; channelId: string },
): Promise<ChannelRow> {
  const { channel, isMember } = await readableChannel(db, input);
  if (!isMember) await joinChannel(db, channel.id, input.userId);
  return channel;
}

/** Whether the agent is a member of the channel; `share` holds its row until the transaction ends. */
export async function agentInChannel(db: Db | Tx, channelId: string, agentId: string, share = false) {
  const q = db
    .select({ id: channelMemberships.memberId })
    .from(channelMemberships)
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.memberType, "agent"),
        eq(channelMemberships.memberId, agentId),
      ),
    );
  return (await (share ? q.for("share") : q)).length > 0;
}

type DmOf = { workspaceId: string; userId: string; other: { type: ActorType; id: string } };

const dmKeyOf = ({ userId, other }: DmOf) =>
  [`person:${userId}`, `${other.type}:${other.id}`].sort().join("|");

/** The person's DM with another person or an agent, if it was ever opened. */
export async function existingDm(db: Db, input: DmOf): Promise<string | null> {
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.workspaceId, input.workspaceId), eq(channels.dmKey, dmKeyOf(input))));
  return row?.id ?? null;
}

/** Opens (or finds) the person's DM with another person or with an agent. Two opens at once give the same DM. */
export async function openDm(db: Db, input: DmOf): Promise<string> {
  const { workspaceId, userId, other } = input;
  const dmKey = dmKeyOf(input);
  const existing = await existingDm(db, input);
  if (existing) return existing;
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
    const raced = await existingDm(db, input);
    if (raced) return raced;
    throw err;
  }
  return id;
}

/**
 * Locks the private channels (DMs aside) among `ids` until the transaction ends, so two people who leave together
 * see each other's leave: the second one to go finds the channel empty and archives it.
 */
export async function lockPrivateChannels(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(inArray(channels.id, [...ids]), eq(channels.kind, "channel"), eq(channels.visibility, "private")),
    )
    .orderBy(asc(channels.id))
    .for("update");
}

/**
 * A private channel nobody is left in is archived, and so lets go of its name: no one could read it anymore, and a
 * new channel may take the name. Its agents stay members and its history stays; the workspace's owner can bring it
 * back (`POST /archived-channels/:id/restore`). Call it under `lockPrivateChannels`, after the leave.
 */
export async function archiveOrphans(tx: Tx, ids: readonly string[], at: Date): Promise<string[]> {
  if (ids.length === 0) return [];
  const archived = await tx
    .update(channels)
    .set({ archivedAt: at })
    .where(
      and(
        inArray(channels.id, [...ids]),
        eq(channels.kind, "channel"),
        eq(channels.visibility, "private"),
        isNull(channels.archivedAt),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(channelMemberships)
            .where(
              and(eq(channelMemberships.channelId, channels.id), eq(channelMemberships.memberType, "person")),
            ),
        ),
      ),
    )
    .returning({ id: channels.id });
  return archived.map((r) => r.id);
}

/**
 * Adds a person or an agent to the channel, by someone in it. Checked under the channel's lock, which the last leave
 * also takes: the add lands before the leave (and the channel isn't empty), or it finds the channel archived (409
 * channel.archived) or the adder gone (403), never an archived channel with someone in it.
 */
export async function addChannelMember(
  db: Db,
  input: { channelId: string; adderId: string; member: { type: "person" | "agent"; id: string } },
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPrivateChannels(tx, [input.channelId]);
    const [fresh] = await tx
      .select({ archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, input.channelId));
    if (!fresh || fresh.archivedAt) throw conflict("channel.archived", "This channel was archived");
    if (!(await isChannelMember(tx, input.channelId, { type: "person", id: input.adderId })))
      throw forbidden("Join the channel to add people");
    await tx
      .insert(channelMemberships)
      .values({ channelId: input.channelId, memberType: input.member.type, memberId: input.member.id })
      .onConflictDoNothing();
  });
}

/**
 * Takes a person or an agent out of the channel; the last person out of a private channel archives it, in the same
 * transaction. False when they weren't in it.
 */
export async function removeChannelMember(
  db: Db,
  input: { channelId: string; member: { type: "person" | "agent"; id: string }; at: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockPrivateChannels(tx, [input.channelId]);
    const gone = await tx
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, input.channelId),
          eq(channelMemberships.memberType, input.member.type),
          eq(channelMemberships.memberId, input.member.id),
        ),
      )
      .returning({ id: channelMemberships.memberId });
    if (gone.length && input.member.type === "person") await archiveOrphans(tx, [input.channelId], input.at);
    return gone.length > 0;
  });
}
