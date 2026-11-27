// An agent's access: raw scopes (agent_grants) and the per-resource view the screen uses.
// `*` grants everything; `tool:x` grants and `deny:x` denies a tool by name; on a connection,
// `connector:*` is the whole connection and `<base>:read|write` a level.
import type { AccessInput, AccessLevel, AgentAccess, ScopeGrant } from "@vanr/contract";
import type { ChannelRule } from "@vanr/engine/action-credential";
import { type Db, schema } from "@vanr/engine/db";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError } from "../http";
import { BUILTIN_SCOPES, builtinScopeOf, connectionScopes } from "./catalog";

const { agentGrants, agentChannelAccess, connections } = schema;
export type ConnectionRow = typeof connections.$inferSelect;

const SPECIAL = (scope: string) =>
  scope === "*" || scope === "connector:*" || scope.startsWith("tool:") || scope.startsWith("deny:");

export async function grantsOf(db: Db, agentId: string): Promise<ScopeGrant[]> {
  const rows = await db
    .select({ connectionId: agentGrants.connectionId, scope: agentGrants.scope })
    .from(agentGrants)
    .where(eq(agentGrants.agentId, agentId));
  return rows.sort((a, b) => (a.connectionId + a.scope).localeCompare(b.connectionId + b.scope));
}

/** The workspace's connections (without agents' own accounts, which only their owner uses). */
export async function activeConnections(db: Db, workspaceId: string): Promise<ConnectionRow[]> {
  return db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        isNull(connections.revokedAt),
        isNull(connections.agentId),
      ),
    )
    .orderBy(connections.createdAt);
}

/** An agent's own accounts. */
export async function agentConnections(db: Db, agentId: string): Promise<ConnectionRow[]> {
  return db
    .select()
    .from(connections)
    .where(and(eq(connections.agentId, agentId), isNull(connections.revokedAt)))
    .orderBy(connections.createdAt);
}

/**
 * The agent's channel rules in its workspace (seam 7): each one only lowers, in its channel, what the workspace
 * granted on a connection, a mailbox or a database (`*` = all of them).
 */
export async function channelRulesOf(db: Db, workspaceId: string, agentId: string): Promise<ChannelRule[]> {
  return db
    .select({
      channelId: agentChannelAccess.channelId,
      connectionId: agentChannelAccess.connectionId,
      level: agentChannelAccess.level,
    })
    .from(agentChannelAccess)
    .where(and(eq(agentChannelAccess.agentId, agentId), eq(agentChannelAccess.workspaceId, workspaceId)));
}

/** Writes the whole list (replaces what was there). */
export async function replaceGrants(
  db: Db,
  workspaceId: string,
  agentId: string,
  grants: readonly ScopeGrant[],
) {
  const unique = new Map(grants.map((g) => [`${g.connectionId}|${g.scope}`, g]));
  await db.transaction(async (tx) => {
    await tx.delete(agentGrants).where(eq(agentGrants.agentId, agentId));
    if (unique.size)
      await tx.insert(agentGrants).values(
        [...unique.values()].map((g) => ({
          agentId,
          workspaceId,
          connectionId: g.connectionId,
          scope: g.scope,
        })),
      );
  });
}

/** Scope valid for the workspace: a known built-in, a special one, or one of its active connections. */
export function validateGrants(
  grants: readonly ScopeGrant[],
  active: readonly ConnectionRow[],
): ScopeGrant[] {
  const builtin = new Set(BUILTIN_SCOPES.map((s) => s.id));
  const byId = new Map(active.map((c) => [c.id, c]));
  return grants.map((g) => {
    if (g.connectionId === "") {
      if (g.scope === "*" || builtin.has(g.scope) || /^(tool|deny):[\w.-]{1,96}$/.test(g.scope)) return g;
      throw new HttpError(400, "access.unknown_scope", "Unknown scope", { scope: g.scope });
    }
    const conn = byId.get(g.connectionId);
    if (!conn)
      throw new HttpError(400, "access.unknown_connection", "That connection is not active", { ...g });
    const own = connectionScopes(conn);
    if (g.scope === "connector:*" || g.scope === own.read || g.scope === own.write) return g;
    throw new HttpError(400, "access.unknown_scope", "Unknown scope", { scope: g.scope });
  });
}

function levelOf(granted: readonly string[], scopes: { read: string; write: string }): AccessLevel {
  if (granted.includes("connector:*")) return "write";
  const r = granted.includes(scopes.read);
  const w = granted.includes(scopes.write);
  if (r && w) return "write";
  if (r) return "read";
  if (w) return "custom";
  return "none";
}

export function accessView(grants: readonly ScopeGrant[], active: readonly ConnectionRow[]): AgentAccess {
  const all = grants.some((g) => g.connectionId === "" && g.scope === "*");
  const builtinGranted = new Set(grants.filter((g) => g.connectionId === "").map((g) => g.scope));
  return {
    all,
    connectors: active.map((c) => {
      const granted = grants.filter((g) => g.connectionId === c.id).map((g) => g.scope);
      const state = all ? "write" : levelOf(granted, connectionScopes(c));
      return {
        connectionId: c.id,
        connector: c.connector,
        label: c.label,
        custom: c.custom,
        state,
        scopes: granted.filter((s) => s !== "connector:*"),
      };
    }),
    builtins: BUILTIN_SCOPES.map((s) => ({ scope: s.id, enabled: all || builtinGranted.has(s.id) })),
    tools: {
      allow: [...builtinGranted].filter((s) => s.startsWith("tool:")).map((s) => s.slice(5)),
      deny: [...builtinGranted].filter((s) => s.startsWith("deny:")).map((s) => s.slice(5)),
    },
  };
}

/** Applies the access PUT over the current scopes and returns the new list. */
export function applyAccessInput(
  current: readonly ScopeGrant[],
  input: AccessInput,
  active: readonly ConnectionRow[],
): ScopeGrant[] {
  let next = [...current];
  const drop = (pred: (g: ScopeGrant) => boolean) => {
    next = next.filter((g) => !pred(g));
  };
  if (input.scopes) {
    drop((g) => !SPECIAL(g.scope));
    next.push(...validateGrants(input.scopes, active).filter((g) => !SPECIAL(g.scope)));
  }
  if (input.connectors) {
    const ids = new Set(active.map((c) => c.id));
    for (const [connectionId, on] of Object.entries(input.connectors)) {
      if (!ids.has(connectionId))
        throw new HttpError(400, "access.unknown_connection", "That connection is not active", {
          connectionId,
        });
      if (on) next.push({ connectionId, scope: "connector:*" });
      else drop((g) => g.connectionId === connectionId);
    }
  }
  if (input.tools) {
    drop((g) => g.connectionId === "" && (g.scope.startsWith("tool:") || g.scope.startsWith("deny:")));
    const name = /^[\w.-]{1,96}$/;
    for (const t of input.tools.allow) {
      if (!name.test(t)) throw new HttpError(400, "access.unknown_scope", "Bad tool name", { tool: t });
      next.push({ connectionId: "", scope: `tool:${t}` });
    }
    for (const t of input.tools.deny) {
      if (!name.test(t)) throw new HttpError(400, "access.unknown_scope", "Bad tool name", { tool: t });
      next.push({ connectionId: "", scope: `deny:${t}` });
    }
  }
  if (input.all !== undefined) {
    drop((g) => g.connectionId === "" && g.scope === "*");
    if (input.all) next.push({ connectionId: "", scope: "*" });
  }
  return next;
}

/** What the agent may use, already resolved for the runtime. */
interface Allowance {
  /** Built-in tool granted? */
  builtin(tool: string): boolean;
  /** Level granted on a connection (null = nothing). */
  connection(conn: ConnectionRow): "read" | "write" | null;
  denied(tool: string): boolean;
}

/** Renamed tools: `tool:` and `deny:` saved with the old name apply to the new one. The message search
 * (`search_context`) became `search`; a denied `search_wiki` takes only the wiki out of the search. */
const OLD_NAMES: Record<string, string[]> = { search: ["search_context"] };

export function allowance(grants: readonly ScopeGrant[]): Allowance {
  const all = grants.some((g) => g.connectionId === "" && g.scope === "*");
  const own = new Set(grants.filter((g) => g.connectionId === "").map((g) => g.scope));
  const named = (prefix: string, tool: string) =>
    [tool, ...(OLD_NAMES[tool] ?? [])].some((n) => own.has(`${prefix}:${n}`));
  return {
    builtin(tool) {
      if (named("deny", tool)) return false;
      const scope = builtinScopeOf(tool);
      if (scope === null) return true;
      const area = scope.slice(0, scope.indexOf(":"));
      // Writing in an area includes reading in it.
      return (
        all || own.has(scope) || named("tool", tool) || (scope.endsWith(":read") && own.has(`${area}:write`))
      );
    },
    connection(conn) {
      if (all) return "write";
      const granted = grants.filter((g) => g.connectionId === conn.id).map((g) => g.scope);
      const level = levelOf(granted, connectionScopes(conn));
      return level === "none" ? null : level === "read" ? "read" : "write";
    },
    denied: (tool) => named("deny", tool),
  };
}
