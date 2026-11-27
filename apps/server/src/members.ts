import { can, type Member, type Person, type Role } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { handleFrom, uniqueHandle } from "@vanr/engine/text";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { isUniqueViolation } from "./db-errors";
import { conflict, forbidden, HttpError, notFound } from "./http";

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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Role changes and removals of one workspace run one at a time: each locks the workspace row first and only then
 * reads the roles it decides on, so two owners demoting each other or leaving at once can't leave it without one.
 */
async function lockedRoles(tx: Tx, workspaceId: string, actorId: string, target: string) {
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  const rows = await tx
    .select({ userId: members.userId, role: members.role })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, [actorId, target])));
  const actor = rows.find((r) => r.userId === actorId)?.role;
  const current = rows.find((r) => r.userId === target)?.role;
  if (!actor) throw new HttpError(404, "not_found", "Workspace not found");
  if (!current) throw notFound("Member not found");
  return { actor, current };
}

/** Makes sure the workspace keeps at least one owner after `userId` stops being one. */
async function assertAnotherOwner(tx: Tx, workspaceId: string, userId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.role, "owner"), ne(members.userId, userId)));
  if ((row?.n ?? 0) === 0) throw conflict("last_owner", "The workspace needs at least one owner");
}

/** Role: nobody changes their own; touching an owner (from or to) needs manage_owners. */
export async function changeRole(
  db: Db,
  input: { workspaceId: string; actorId: string; target: string; role: Role },
) {
  const { workspaceId, actorId, target, role } = input;
  if (target === actorId) throw forbidden("You can't change your own role");
  await db.transaction(async (tx) => {
    const { actor, current } = await lockedRoles(tx, workspaceId, actorId, target);
    if (!can(actor, "manage_members")) throw forbidden();
    if ((current === "owner" || role === "owner") && !can(actor, "manage_owners")) {
      throw forbidden("Only owners can promote or demote owners");
    }
    if (current === "owner" && role !== "owner") await assertAnotherOwner(tx, workspaceId, target);
    await tx
      .update(members)
      .set({ role })
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, target)));
  });
}

/**
 * Remove: manage_members removes others; anyone can leave. An owner leaves only if another owner stays. The
 * person also leaves the workspace's channels.
 */
export async function removeMember(db: Db, input: { workspaceId: string; actorId: string; target: string }) {
  const { workspaceId, actorId, target } = input;
  const self = target === actorId;
  await db.transaction(async (tx) => {
    const { actor, current } = await lockedRoles(tx, workspaceId, actorId, target);
    if (!self && !can(actor, "manage_members")) throw forbidden();
    if (current === "owner") {
      if (!self && !can(actor, "manage_owners")) throw forbidden("Only owners can remove owners");
      await assertAnotherOwner(tx, workspaceId, target);
    }
    await tx.delete(members).where(and(eq(members.workspaceId, workspaceId), eq(members.userId, target)));
    const workspaceChannels = tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId));
    await tx
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.memberType, "person"),
          eq(channelMemberships.memberId, target),
          inArray(channelMemberships.channelId, workspaceChannels),
        ),
      );
  });
}
