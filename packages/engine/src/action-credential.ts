// Action credential. Whoever acts outside Vanr is always the agent, with a credential that is its own or
// the workspace's. The requester's credential never gets in, except the environment plan, which belongs to
// the person who paired the runner and only serves them (the server's runner plans). The requester is
// kept only in the audit trail.
//
// Permission in two levels: the workspace gives the agent a level for each connection (`agent_grants`:
// read or write); a channel only restricts that level for what the agent does in that channel (off, read
// only, or ask for approval on every write). A channel never widens it.
//
// Used by integrations (connectors, email), the harness (gate audit) and anything else that acts outside
// with a stored credential. No database or Bun dependency: the web app imports the types.
import type { ChannelAccessLevel, ChannelAccessRule } from "@vanr/contract";

/** Whose credential the action uses. */
type CredentialOwner = "agent" | "workspace" | "requester";

/** The concrete credential of the action, as recorded in the audit trail. */
export interface CredentialRef {
  kind: "connection" | "mailbox" | "database" | "environment_plan";
  /** Id of the connection, mail account, database or environment. */
  id: string;
  owner: CredentialOwner;
  /** Display name ("Acme's Linear", "Lia's Linear"). */
  label: string;
}

/** Who acts, on whose behalf and with what. Goes into `gate_decisions` and onto the approval card. */
interface ActionCredential {
  actorAgentId: string;
  /** Person who started the run; null for a routine. Audit only: it never picks the credential. */
  actingFor: string | null;
  credential: CredentialRef | null;
}

/** A channel's restriction: `off` removes, `read` leaves read only, `approval` asks a person on every write. */
type ChannelLevel = ChannelAccessLevel;
type WorkspaceLevel = "read" | "write";

/** Channel rule: one connection, or `*` for all of the agent's. */
export type ChannelRule = ChannelAccessRule;

export const ALL_CONNECTIONS = "*";

const RANK: Record<ChannelLevel, number> = { off: 0, read: 1, approval: 2 };

/**
 * Effective level of a connection in a channel: the workspace's, restricted by the channel's strictest rule
 * (the `*` rule and the rule of any connection of the same service: a rule set on the workspace account
 * still applies once the agent gets its own account, and vice versa). null when the connection is out;
 * `ask` when every write needs a person.
 */
export function effectiveLevel(
  workspace: WorkspaceLevel | null,
  rules: readonly ChannelRule[],
  channelId: string,
  serviceConnectionIds: readonly string[],
): { level: WorkspaceLevel; ask: boolean } | null {
  if (!workspace) return null;
  let strictest: ChannelLevel | null = null;
  for (const r of rules) {
    if (r.channelId !== channelId) continue;
    if (r.connectionId !== ALL_CONNECTIONS && !serviceConnectionIds.includes(r.connectionId)) continue;
    if (strictest === null || RANK[r.level] < RANK[strictest]) strictest = r.level;
  }
  if (strictest === "off") return null;
  if (strictest === "read") return { level: "read", ask: false };
  return { level: workspace, ask: strictest === "approval" };
}

/** Candidate connection: `key` identifies the service (catalog connector or custom MCP address). */
interface CredentialCandidate {
  id: string;
  key: string;
  /** Owner when it is an agent's own account; null when it belongs to the workspace. */
  agentId: string | null;
}

/**
 * The connections that apply to an agent: its own and the workspace's, without other agents'. When the
 * agent has its own account on a service, the workspace's account for that service drops out for it: the
 * action goes out under the agent's identity.
 */
export function credentialsFor<C extends CredentialCandidate>(
  candidates: readonly C[],
  agentId: string,
): C[] {
  const own = new Set(candidates.filter((c) => c.agentId === agentId).map((c) => c.key));
  return candidates.filter((c) => (c.agentId === null ? !own.has(c.key) : c.agentId === agentId));
}

/**
 * Builds the action credential. Rejects the requester's credential outside the environment plan: if a new
 * tool tries to act with the requester's account, it fails here instead of slipping through.
 */
export function actionCredential(input: {
  agentId: string;
  requesterId: string | null;
  credential: CredentialRef | null;
}): ActionCredential {
  const c = input.credential;
  if (c?.owner === "requester" && c.kind !== "environment_plan")
    throw new Error(`An agent action can't use the requester's credential (${c.kind})`);
  return { actorAgentId: input.agentId, actingFor: input.requesterId, credential: c };
}

/** Service key of a connection: the catalog connector, or the custom MCP address without trailing slash. */
export function serviceKey(conn: { connector: string; custom: boolean; serverUrl: string | null }): string {
  if (!conn.custom) return conn.connector;
  return `custom:${(conn.serverUrl ?? "").replace(/\/+$/, "").toLowerCase()}`;
}
