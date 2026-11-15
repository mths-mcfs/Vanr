import type { Member, Person, Role } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { handleFrom, uniqueHandle } from "@vanr/engine/text";
import { and, eq } from "drizzle-orm";
import { isUniqueViolation } from "./db-errors";

const { members, users, workspaces, channels, channelMemberships } = schema;

/** Handles already taken in the workspace. People and agents share the same @ namespace. */
export async function takenHandles(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ handle: members.handle })
    .from(members)
    .where(eq(members.workspaceId, workspaceId));
  const agentRows = await db
    .select({ handle: schema.agents.handle })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId));
  return new Set([...rows.map((r) => r.handle), ...agentRows.map((r) => r.handle)]);
}

/**
 * Adds the person to the workspace with a free handle and to #general. Idempotent: an existing member keeps
 * their role. Two accepts at once can race for the same handle; the unique index decides and we try the next.
 */
export async function joinWorkspace(
  db: Db,
  input: { workspaceId: string; userId: string; name: string; role: Role },
): Promise<{ joined: boolean }> {
  const [existing] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.workspaceId, input.workspaceId), eq(members.userId, input.userId)));
  if (existing) return { joined: false };
  const base = handleFrom(input.name);
  for (let attempt = 0; attempt < 8; attempt++) {
    const handle = uniqueHandle(base, await takenHandles(db, input.workspaceId));
    try {
      await db
        .insert(members)
        .values({ workspaceId: input.workspaceId, userId: input.userId, role: input.role, handle });
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [again] = await db
        .select({ role: members.role })
        .from(members)
        .where(and(eq(members.workspaceId, input.workspaceId), eq(members.userId, input.userId)));
      if (again) return { joined: false };
    }
  }
  const [workspace] = await db
    .select({ general: workspaces.defaultChannelId })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId));
  if (workspace?.general) {
    await db
      .insert(channelMemberships)
      .values({ channelId: workspace.general, memberType: "person", memberId: input.userId })
      .onConflictDoNothing();
  }
  return { joined: true };
}

/** Creates the workspace with the requester as owner and the #general channel. */
export async function createWorkspace(
  db: Db,
  input: { name: string; context: string; timezone?: string; user: { id: string; name: string } },
) {
  const workspaceId = newId("workspace");
  const generalId = newId("ch");
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      name: input.name,
      context: input.context,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      createdBy: input.user.id,
    });
    await tx.insert(channels).values({
      id: generalId,
      workspaceId,
      name: "general",
      topic: "",
      visibility: "public",
      createdBy: input.user.id,
    });
    await tx.update(workspaces).set({ defaultChannelId: generalId }).where(eq(workspaces.id, workspaceId));
    await joinWorkspace(tx, { workspaceId, userId: input.user.id, name: input.user.name, role: "owner" });
  });
  return { workspaceId, defaultChannelId: generalId };
}

export const logoUrl = (workspaceId: string, key: string | null) =>
  key ? `/api/v1/workspaces/${workspaceId}/logo?v=${encodeURIComponent(key.slice(-12))}` : null;

export const avatarUrl = (workspaceId: string, userId: string, key: string | null) =>
  key
    ? `/api/v1/workspaces/${workspaceId}/people/${userId}/avatar?v=${encodeURIComponent(key.slice(-12))}`
    : null;

/** Online: seen in the last 2 min (the WebSocket and the workspace middleware update lastOnlineAt). */
const ONLINE_MS = 2 * 60_000;

export async function memberRows(db: Db, workspaceId: string, userId?: string) {
  return db
    .select({
      userId: members.userId,
      role: members.role,
      handle: members.handle,
      timezone: members.timezone,
      avatarKey: members.avatarKey,
      memberSince: members.memberSince,
      lastOnlineAt: members.lastOnlineAt,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      userId
        ? and(eq(members.workspaceId, workspaceId), eq(members.userId, userId))
        : eq(members.workspaceId, workspaceId),
    )
    .orderBy(members.memberSince);
}

type MemberRow = Awaited<ReturnType<typeof memberRows>>[number];

export function toMember(workspaceId: string, r: MemberRow): Member {
  return {
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: r.role,
    handle: r.handle,
    timezone: r.timezone,
    image: r.image,
    avatarUrl: avatarUrl(workspaceId, r.userId, r.avatarKey),
  };
}

export function toPerson(
  workspaceId: string,
  r: MemberRow,
  now: Date,
  online?: (userId: string) => boolean,
): Person {
  const seen = r.lastOnlineAt;
  return {
    ...toMember(workspaceId, r),
    // Active now: a WebSocket open in this workspace or some request in the last 2 min.
    online: (online?.(r.userId) ?? false) || (seen ? now.getTime() - seen.getTime() < ONLINE_MS : false),
    lastOnlineAt: seen?.toISOString() ?? null,
    memberSince: r.memberSince.toISOString(),
  };
}
