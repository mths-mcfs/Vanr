// How far an agent reaches into each workspace connection, in the server's raw scopes: `*` is
// everything, `connector:*` a whole connection, `<base>:read` and `<base>:write` its two levels
// (`<base>` is the catalog id, or `custom:<connection id>` for an own MCP server), a built-in area is
// `<area>:read` or `<area>:write`, and `tool:` / `deny:` allow or deny one tool by name. The access
// matrix of the settings and the agent's Access tab both change access through these functions, so
// each change starts from the scopes as they are and keeps everything it does not touch.
import type { AgentAccess, ScopeGrant } from "@vanr/contract";

/** The level a person picks for a connection. */
export type ConnLevel = "none" | "read" | "write";
export const CONN_LEVELS = ["none", "read", "write"] as const satisfies readonly ConnLevel[];
type AccessConnector = AgentAccess["connectors"][number];

const baseOf = (connection: Pick<AccessConnector, "connectionId" | "connector" | "custom">) =>
  connection.custom ? `custom:${connection.connectionId}` : connection.connector;

/** The scopes with one connection set to a level; everything else as it was. */
export function withLevel(
  grants: readonly ScopeGrant[],
  connection: Pick<AccessConnector, "connectionId" | "connector" | "custom">,
  level: ConnLevel,
): ScopeGrant[] {
  const rest = grants.filter((grant) => grant.connectionId !== connection.connectionId);
  if (level === "none") return rest;
  const base = baseOf(connection);
  const own = level === "read" ? [`${base}:read`] : [`${base}:read`, `${base}:write`];
  return [...rest, ...own.map((scope) => ({ connectionId: connection.connectionId, scope }))];
}

/** The scopes with one built-in area's scope on or off. */
export function withBuiltin(grants: readonly ScopeGrant[], scope: string, on: boolean): ScopeGrant[] {
  const rest = grants.filter((grant) => !(grant.connectionId === "" && grant.scope === scope));
  return on ? [...rest, { connectionId: "", scope }] : rest;
}

/**
 * The scopes that keep what "everything" gave, once it is turned off: every built-in area, every
 * connection at its highest level and the rules on single tools. Nothing is lost by the switch; the
 * person narrows from there.
 */
export function everythingSpelledOut(access: AgentAccess): ScopeGrant[] {
  let grants: ScopeGrant[] = access.builtins.map((builtin) => ({ connectionId: "", scope: builtin.scope }));
  for (const connection of access.connectors) grants = withLevel(grants, connection, "write");
  const rule = (prefix: string) => (tool: string) => ({ connectionId: "", scope: `${prefix}:${tool}` });
  return [...grants, ...access.tools.allow.map(rule("tool")), ...access.tools.deny.map(rule("deny"))];
}
