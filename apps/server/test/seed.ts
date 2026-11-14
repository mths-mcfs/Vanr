// Rows the Drive and search tests stand on, written straight to the test server's database: the routes that
// create workspaces (S4), invite members (S2) and create channels and threads (S6) come with later slices.
// Each helper writes what those routes write and nothing else (no double: the routes under test read these
// rows like any other).
import type { Role } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { RunningServer } from "../src/server";
import { type Browser, signedIn } from "./harness";

export interface Person {
  browser: Browser;
  user: { id: string; name: string; email: string };
}

/** A new workspace with `owner` as its owner and a public #general channel. */
export async function seedWorkspace(server: RunningServer, owner: Person, name = "Workspace") {
  const { db } = server.deps;
  const workspaceId = newId("ws");
  await db.insert(schema.workspaces).values({ id: workspaceId, name, createdBy: owner.user.id });
  await addMember(server, workspaceId, owner, "owner");
  const general = await seedChannel(server, workspaceId, { name: "general", members: [owner] });
  return { workspaceId, general };
}

export async function addMember(
  server: RunningServer,
  workspaceId: string,
  who: Person,
  role: Role = "member",
) {
  await server.deps.db
    .insert(schema.members)
    .values({ workspaceId, userId: who.user.id, role, handle: who.user.name.toLowerCase() });
}

/** A new account that is a member of the workspace. */
export async function memberOf(
  server: RunningServer,
  workspaceId: string,
  name: string,
  email: string,
  role: Role = "member",
): Promise<Person> {
  const who = await signedIn(server, name, email);
  await addMember(server, workspaceId, who, role);
  return who;
}

export async function seedChannel(
  server: RunningServer,
  workspaceId: string,
  opts: {
    name: string;
    visibility?: "public" | "private";
    kind?: "channel" | "dm";
    members?: Person[];
    agentIds?: string[];
  },
): Promise<string> {
  const { db } = server.deps;
  const id = newId("ch");
  await db.insert(schema.channels).values({
    id,
    workspaceId,
    name: opts.name,
    visibility: opts.visibility ?? "public",
    kind: opts.kind ?? "channel",
  });
  const rows = [
    ...(opts.members ?? []).map((p) => ({
      channelId: id,
      memberType: "person" as const,
      memberId: p.user.id,
    })),
    ...(opts.agentIds ?? []).map((a) => ({ channelId: id, memberType: "agent" as const, memberId: a })),
  ];
  if (rows.length) await db.insert(schema.channelMemberships).values(rows);
  return id;
}
