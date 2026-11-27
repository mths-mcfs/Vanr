// Raw HTTP calls and the rows the route tests stand on. `seedAgent` is a minimal fixture: it writes the agent's
// columns and its channel memberships only, not what the agents route also creates (`createdBy`, the first
// instructions version, the `*` grant), so a test that needs those sets them itself. Everything else goes through
// the real routes.
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import type { AgentRow } from "../src/agents";
import type { RunningServer } from "../src/server";
import type { Person } from "./seed";

export interface Called {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
  body: any;
}

/** A JSON request as the person's browser (session cookie and origin); the body parsed when there is one. */
export async function call(who: Person, method: string, path: string, payload?: unknown): Promise<Called> {
  const res = await who.browser.json(path, method, payload);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** The workspace's path prefix. */
export const ws = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

/** An agent of the workspace, owned by `owner`, in the channels given (as a member the agent answers in). */
export async function seedAgent(
  server: RunningServer,
  workspaceId: string,
  owner: Person,
  handle: string,
  channelIds: string[] = [],
): Promise<AgentRow> {
  const { db } = server.deps;
  const [row] = await db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: handle[0]?.toUpperCase() + handle.slice(1),
      handle,
      role: "support",
      instructions: "",
      model: "claude-haiku-5-5",
      ownerUserId: owner.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  if (!row) throw new Error("no agent");
  for (const channelId of channelIds) await addToChannel(server, channelId, { type: "agent", id: row.id });
  return row;
}

/** Puts a person or an agent in a channel. */
export async function addToChannel(
  server: RunningServer,
  channelId: string,
  who: { type: "person" | "agent"; id: string },
) {
  await server.deps.db
    .insert(schema.channelMemberships)
    .values({ channelId, memberType: who.type, memberId: who.id })
    .onConflictDoNothing();
}
