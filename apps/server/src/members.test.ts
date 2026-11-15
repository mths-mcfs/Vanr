// Workspace membership on a PGlite database: creating a workspace, joining it with a free handle, and the
// member and person views.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type OpenDb, openDb, schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import {
  avatarUrl,
  createWorkspace,
  joinWorkspace,
  logoUrl,
  memberRows,
  toMember,
  toPerson,
} from "./members";

let opened: OpenDb;
beforeAll(async () => {
  opened = await openDb({ kind: "pglite", dataDir: null });
});
afterAll(() => opened.close());

let users = 0;
async function user(name: string) {
  const id = `u${++users}`;
  await opened.db.insert(schema.users).values({ id, name, email: `${id}@example.com` });
  return { id, name };
}

async function membersOf(workspaceId: string) {
  return (await memberRows(opened.db, workspaceId)).map((r) => ({
    userId: r.userId,
    role: r.role,
    handle: r.handle,
  }));
}

async function generalMembers(channelId: string) {
  const rows = await opened.db
    .select({ id: schema.channelMemberships.memberId })
    .from(schema.channelMemberships)
    .where(eq(schema.channelMemberships.channelId, channelId));
  return rows.map((r) => r.id).sort();
}

describe("members", () => {
  test("creating a workspace makes the requester its owner, with #general and a membership in it", async () => {
    const ana = await user("Ana Lima");
    const { workspaceId, defaultChannelId } = await createWorkspace(opened.db, {
      name: "Workshop",
      context: "",
      user: ana,
    });
    expect(await membersOf(workspaceId)).toEqual([{ userId: ana.id, role: "owner", handle: "ana-lima" }]);
    const [general] = await opened.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.id, defaultChannelId));
    expect(general).toMatchObject({ workspaceId, name: "general", visibility: "public" });
    expect(await generalMembers(defaultChannelId)).toEqual([ana.id]);
  });

  test("joining takes a handle no person nor agent holds, and joins #general", async () => {
    const owner = await user("Bia");
    const { workspaceId, defaultChannelId } = await createWorkspace(opened.db, {
      name: "Studio",
      context: "",
      user: owner,
    });
    await opened.db.insert(schema.agents).values({
      id: "ag_lia",
      workspaceId,
      name: "Lia",
      handle: "lia",
      model: "claude-haiku-5-5",
      ownerUserId: owner.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    });
    const lia = await user("Lia");
    const otherLia = await user("Lia");
    expect(
      await joinWorkspace(opened.db, { workspaceId, userId: lia.id, name: lia.name, role: "member" }),
    ).toEqual({
      joined: true,
    });
    await joinWorkspace(opened.db, { workspaceId, userId: otherLia.id, name: otherLia.name, role: "admin" });
    expect(await membersOf(workspaceId)).toEqual([
      { userId: owner.id, role: "owner", handle: "bia" },
      { userId: lia.id, role: "member", handle: "lia-2" },
      { userId: otherLia.id, role: "admin", handle: "lia-3" },
    ]);
    expect(await generalMembers(defaultChannelId)).toEqual([lia.id, otherLia.id, owner.id].sort());
  });

  test("joining again changes nothing: not the role, not the handle", async () => {
    const owner = await user("Caio");
    const { workspaceId } = await createWorkspace(opened.db, { name: "Lab", context: "", user: owner });
    expect(
      await joinWorkspace(opened.db, { workspaceId, userId: owner.id, name: "Someone Else", role: "member" }),
    ).toEqual({ joined: false });
    expect(await membersOf(workspaceId)).toEqual([{ userId: owner.id, role: "owner", handle: "caio" }]);
  });

  test("two people joining at once with the same name both get in, with different handles", async () => {
    const owner = await user("Dani");
    const { workspaceId } = await createWorkspace(opened.db, { name: "Shop", context: "", user: owner });
    const people = await Promise.all([user("Edu"), user("Edu"), user("Edu")]);
    const results = await Promise.all(
      people.map((p) =>
        joinWorkspace(opened.db, { workspaceId, userId: p.id, name: p.name, role: "member" }),
      ),
    );
    expect(results).toEqual([{ joined: true }, { joined: true }, { joined: true }]);
    const handles = (await membersOf(workspaceId)).filter((m) => m.userId !== owner.id).map((m) => m.handle);
    expect(handles.sort()).toEqual(["edu", "edu-2", "edu-3"]);
  });

  test("person view: online with an open socket or a request in the last 2 minutes", async () => {
    const owner = await user("Fabi");
    const { workspaceId } = await createWorkspace(opened.db, { name: "Office", context: "", user: owner });
    const now = new Date("2026-11-14T12:00:00Z");
    const [row] = await memberRows(opened.db, workspaceId, owner.id);
    if (!row) throw new Error("no member row");
    expect(toPerson(workspaceId, { ...row, lastOnlineAt: null }, now).online).toBe(false);
    expect(toPerson(workspaceId, { ...row, lastOnlineAt: null }, now, () => true).online).toBe(true);
    const recent = new Date(now.getTime() - 119_000);
    const old = new Date(now.getTime() - 121_000);
    expect(toPerson(workspaceId, { ...row, lastOnlineAt: recent }, now)).toMatchObject({
      online: true,
      lastOnlineAt: recent.toISOString(),
    });
    expect(toPerson(workspaceId, { ...row, lastOnlineAt: old }, now).online).toBe(false);
    await opened.db
      .update(schema.members)
      .set({ avatarKey: "avatars/abcdefghijklmnop.png" })
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, owner.id)));
    const [withAvatar] = await memberRows(opened.db, workspaceId, owner.id);
    if (!withAvatar) throw new Error("no member row");
    expect(toMember(workspaceId, withAvatar)).toMatchObject({
      userId: owner.id,
      name: "Fabi",
      role: "owner",
      handle: "fabi",
      avatarUrl: `/api/v1/workspaces/${workspaceId}/people/${owner.id}/avatar?v=ijklmnop.png`,
    });
  });

  test("logo and avatar URLs carry the key's tail as the cache buster, and are null without a key", () => {
    expect(logoUrl("w1", null)).toBeNull();
    expect(avatarUrl("w1", "u1", null)).toBeNull();
    expect(logoUrl("w1", "logos/w1/0123456789abcdef")).toBe("/api/v1/workspaces/w1/logo?v=456789abcdef");
  });
});
