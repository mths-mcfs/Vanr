// Rows the Drive and search tests stand on. The routes that create workspaces (S4), invite members (S2)
// and create channels (S6) come with later slices, so the tests call the functions those routes call where
// they already exist: `createWorkspace` and `joinWorkspace` (members.ts) and `openDm` (channels.ts). A plain
// channel has no such function yet; `seedChannel` writes the same columns the channel route writes (with its
// creator) and nothing else. Every person is a real account (`signedIn`), and roles are `Role`.
import type { Role } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { openDm } from "../src/channels";
import { createWorkspace, joinWorkspace } from "../src/members";
import type { RunningServer } from "../src/server";
import { type Browser, signedIn } from "./harness";

export interface Person {
  browser: Browser;
  user: { id: string; name: string; email: string };
}

/** A new workspace with `owner` as its owner and its #general channel, as the workspace route creates it. */
export async function seedWorkspace(server: RunningServer, owner: Person, name = "Workspace") {
  const { workspaceId, defaultChannelId } = await createWorkspace(server.deps.db, {
    name,
    context: "",
    user: owner.user,
  });
  return { workspaceId, general: defaultChannelId };
}

/** A new account that joins the workspace (a free handle and #general, as accepting an invite does). */
export async function memberOf(
  server: RunningServer,
  workspaceId: string,
  name: string,
  email: string,
  role: Role = "member",
): Promise<Person> {
  const who = await signedIn(server, name, email);
  await joinWorkspace(server.deps.db, { workspaceId, userId: who.user.id, name: who.user.name, role });
  return who;
}

/** A channel created by its first member, with the others in it. */
export async function seedChannel(
  server: RunningServer,
  workspaceId: string,
  opts: { name: string; visibility?: "public" | "private"; members: [Person, ...Person[]] },
): Promise<string> {
  const { db } = server.deps;
  const id = newId("ch");
  const [creator] = opts.members;
  await db.insert(schema.channels).values({
    id,
    workspaceId,
    name: opts.name,
    topic: "",
    visibility: opts.visibility ?? "public",
    createdBy: creator.user.id,
  });
  await db
    .insert(schema.channelMemberships)
    .values(opts.members.map((p) => ({ channelId: id, memberType: "person" as const, memberId: p.user.id })));
  return id;
}

/** The DM between two people, as the DM route opens it. */
export const seedDm = (server: RunningServer, workspaceId: string, a: Person, b: Person) =>
  openDm(server.deps.db, { workspaceId, userId: a.user.id, other: { type: "person", id: b.user.id } });
