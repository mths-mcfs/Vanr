// The agent's own identity (seam 7): the agent's accounts on services, revoking all of them at once and the
// per-channel rules that lower the level the workspace granted.
import type {
  AgentIdentity,
  ChannelAccessRule,
  IdentityConnectInput,
  IdentityConnectStart,
} from "@vanr/contract";
import { ALL_CONNECTIONS } from "@vanr/engine/action-credential";
import type { Db } from "@vanr/engine/db";
import { schema } from "@vanr/engine/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type AgentRow, type ChannelViewer, visibleAgentChannel } from "../agents";
import type { AppDeps } from "../context";
import { isUniqueViolation } from "../db-errors";
import { HttpError } from "../http";
import { activeConnections, agentConnections } from "./access";
import { catalogEntry } from "./catalog";
import { connectWithKey, disconnectAll, type Starter, startCatalogOAuth, toConnection } from "./connectors";

const { agentChannelAccess, agents, channels, connections } = schema;

const alreadyConnected = () =>
  new HttpError(409, "identity.exists", "The agent already has its own account on this service");

/** The agent's channel rules on the channels the viewer may see of it (`visibleAgentChannel`). */
function visibleRules(db: Db, agent: AgentRow, viewer: ChannelViewer): Promise<ChannelAccessRule[]> {
  return db
    .select({
      channelId: agentChannelAccess.channelId,
      connectionId: agentChannelAccess.connectionId,
      level: agentChannelAccess.level,
    })
    .from(agentChannelAccess)
    .innerJoin(channels, eq(channels.id, agentChannelAccess.channelId))
    .where(
      and(
        eq(agentChannelAccess.agentId, agent.id),
        eq(agentChannelAccess.workspaceId, agent.workspaceId),
        visibleAgentChannel(db, viewer),
      ),
    );
}

export async function identityOf(
  deps: AppDeps,
  agent: AgentRow,
  viewer: ChannelViewer,
): Promise<AgentIdentity> {
  const own = (await agentConnections(deps.db, agent.id)).filter((c) => c.status !== "pending");
  return { connections: own.map(toConnection), channels: await visibleRules(deps.db, agent, viewer) };
}

/**
 * Connects the agent's account on a catalog service: with a key right away; without one, OAuth (who configures
 * signs in, on the service, with the account made for the agent). One account per service.
 */
export async function connectIdentity(
  deps: AppDeps,
  me: Starter,
  agent: AgentRow,
  input: IdentityConnectInput,
): Promise<IdentityConnectStart> {
  const entry = catalogEntry(input.connector);
  if (!entry) throw new HttpError(400, "connector.unknown", "Unknown connector");
  const existing = (await agentConnections(deps.db, agent.id)).filter(
    (c) => c.connector === entry.id && c.status !== "pending",
  );
  if (existing.length) throw alreadyConnected();
  if (input.apiKey) {
    // Two connects at once both pass the check above; the unique index keeps one account per service.
    const row = await connectWithKey(deps, me, { connector: entry.id, apiKey: input.apiKey }, agent.id).catch(
      (err: unknown) => {
        throw isUniqueViolation(err) ? alreadyConnected() : err;
      },
    );
    return { status: "connected", connection: toConnection(row) };
  }
  const consentUrl = await startCatalogOAuth(deps, me, entry.id, input.nextPath, agent.id);
  return { status: "oauth", consentUrl };
}

/** Revokes every own account of the agent (the sealed credentials go; the tokens are useless here). */
export async function revokeIdentity(deps: AppDeps, agent: AgentRow): Promise<number> {
  const own = await agentConnections(deps.db, agent.id);
  await disconnectAll(deps, own);
  return own.length;
}

/**
 * Replaces the agent's per-channel rules the viewer may see; the rules on channels hidden from them stay as they
 * are. The channel must be one the viewer may see (a hidden one, a DM or another workspace's answers like an
 * unknown one) and the connection `*`, one of the workspace's or an own account of this agent.
 */
export async function setChannelRules(
  deps: AppDeps,
  agent: AgentRow,
  rules: readonly ChannelAccessRule[],
  viewer: ChannelViewer,
): Promise<ChannelAccessRule[]> {
  const unique = new Map(rules.map((r) => [`${r.channelId}|${r.connectionId}`, r]));
  const channelIds = [...new Set([...unique.values()].map((r) => r.channelId))];
  if (channelIds.length) {
    const found = await deps.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, agent.workspaceId),
          inArray(channels.id, channelIds),
          visibleAgentChannel(deps.db, viewer),
        ),
      );
    const known = new Set(found.map((c) => c.id));
    const bad = channelIds.find((id) => !known.has(id));
    if (bad) throw new HttpError(400, "identity.unknown_channel", "Unknown channel", { channelId: bad });
  }
  const valid = new Set([
    ALL_CONNECTIONS,
    ...(await activeConnections(deps.db, agent.workspaceId)).map((c) => c.id),
    ...(await agentConnections(deps.db, agent.id)).map((c) => c.id),
  ]);
  const badConn = [...unique.values()].find((r) => !valid.has(r.connectionId));
  if (badConn)
    throw new HttpError(400, "identity.unknown_connection", "That connection is not active", {
      connectionId: badConn.connectionId,
    });
  await deps.db.transaction(async (tx) => {
    // One writer per agent at a time: two saves of the same agent's rules don't mix.
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("no key update");
    // Read under the lock: what is replaced is what the viewer sees now, and only that.
    const replaced = [...new Set((await visibleRules(tx, agent, viewer)).map((r) => r.channelId))];
    if (replaced.length)
      await tx
        .delete(agentChannelAccess)
        .where(
          and(eq(agentChannelAccess.agentId, agent.id), inArray(agentChannelAccess.channelId, replaced)),
        );
    if (unique.size)
      await tx
        .insert(agentChannelAccess)
        .values(
          [...unique.values()].map((r) => ({ ...r, agentId: agent.id, workspaceId: agent.workspaceId })),
        );
  });
  return visibleRules(deps.db, agent, viewer);
}

/** A connection (the workspace's or an agent's) waiting for the extra scope step. */
export async function scopeTarget(deps: AppDeps, workspaceId: string, id: string) {
  const [row] = await deps.db
    .select()
    .from(connections)
    .where(
      and(eq(connections.workspaceId, workspaceId), eq(connections.id, id), isNull(connections.revokedAt)),
    );
  return row ?? null;
}
