// What an agent may call in this run: the built-in tools its scopes allow, the tools of each MCP connection it
// was given (with the workspace's level and decision per tool), mail, the runner, the assignment and databases.
//
// Default class of a connector tool (seam 1): a read is K0 and raises A (what comes back from an outside service
// isn't trusted); a write is K2 for the service the workspace connected; a name that sounds irreversible (delete,
// publish, pay...) is K3; "ask for approval" in the workspace becomes the `ask` rule.

import type { EffectClass } from "@vanr/contract";
import {
  type CredentialRef,
  credentialsFor,
  effectiveLevel,
  serviceKey,
} from "@vanr/engine/action-credential";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentRow } from "../agents";
import { assignmentToolsFor } from "../assignments/tools";
import type { ChannelRow } from "../channels";
import type { AppDeps } from "../context";
import { environmentToolsFor } from "../runners/agent-tools";
import { AGENT_TOOLS } from "../runtime/content-tools";
import { define, type ToolContext, type ToolDef, ToolInputError } from "../runtime/tools";
import {
  activeConnections,
  agentConnections,
  allowance,
  type ConnectionRow,
  channelRulesOf,
  grantsOf,
} from "./access";
import { SENSITIVE_TOOL } from "./catalog";
import { connectionSecrets, markNeedsReconnect, mcpFor, requestScope, secretsSentBy } from "./connectors";
import { DATABASE_TOOLS, hasDatabases } from "./databases";
import { repoRefusal } from "./github-app";
import { mailToolsFor } from "./mail-tools";
import { McpAuthRequired, type McpClient, McpInsufficientScope } from "./mcp";
import { outsideText } from "./outside-text";

const { connections } = schema;
const NAME_MAX = 64;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "mcp";

/** The name the model sees: `<connector>__<tool>`, only [a-zA-Z0-9_-], up to 64. */
export function exposedName(
  conn: Pick<ConnectionRow, "connector" | "custom" | "label">,
  tool: string,
): string {
  const prefix = conn.custom ? `mcp_${slug(conn.label)}` : slug(conn.connector);
  return `${prefix}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, NAME_MAX);
}

const anyArgs = z.record(z.string(), z.unknown());

/** The fallback when the server's schema doesn't convert: an object, the required keys present, extras only if it allows them. */
function shallowArgs(schema: Record<string, unknown>) {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  const known =
    schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  // A key a `patternProperties` pattern matches isn't an extra either (a pattern JS can't read counts as matching).
  const patterns =
    schema.patternProperties && typeof schema.patternProperties === "object"
      ? Object.keys(schema.patternProperties)
      : [];
  const byPattern = (key: string) =>
    patterns.some((p) => {
      try {
        return new RegExp(p, "u").test(key);
      } catch {
        return true;
      }
    });
  return anyArgs.superRefine((args, ctx) => {
    for (const key of required)
      if (!Object.hasOwn(args, key))
        ctx.addIssue({ code: "custom", message: `Missing required argument "${key}"` });
    if (schema.additionalProperties === false)
      for (const key of Object.keys(args))
        if (!known.includes(key) && !byPattern(key))
          ctx.addIssue({ code: "custom", message: `Unknown argument "${key}"` });
  });
}

/**
 * The call's arguments are checked against the `inputSchema` the MCP server published, before asking for an
 * approval or calling the server: the model makes mistakes (or is led into them) and the server on the other side
 * has no duty to reject. The schema becomes zod (`z.fromJSONSchema`), as an object, which is what the model sees.
 */
export function argsValidator(inputSchema: unknown): z.ZodType<Record<string, unknown>> {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return anyArgs;
  const schema = { type: "object", ...(normalizeSchema(inputSchema) as Record<string, unknown>) };
  // Required keys and extras are always checked (zod doesn't enforce `required` without `properties`).
  const shallow = shallowArgs(schema);
  try {
    const parsed = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    return shallow.pipe(parsed as z.ZodType<Record<string, unknown>, Record<string, unknown>>);
  } catch {
    return shallow;
  }
}

// Keys whose value maps a name to a schema (the name isn't a keyword), and the ones that hold data.
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
const DATA_KEYS = new Set(["enum", "const", "default", "examples"]);

/** A pattern that a JS regex without the `u` flag reads the same as JSON Schema does (which is Unicode). */
function plainPattern(p: string): boolean {
  if (/\\[pPu]\{/.test(p)) return false;
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fits the published schema to what zod reads, without refusing a valid call:
 * `definitions` (draft-07) becomes `$defs` with the `$ref`s rewritten (otherwise the `$ref` checks nothing);
 * `format` goes (in JSON Schema it is an annotation, and zod would reject a relative `uri-reference`);
 * a pattern with a Unicode class goes (a regex without `u` would reject valid text).
 */
export function normalizeSchema(node: unknown, map = false): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizeSchema(n));
  if (!node || typeof node !== "object") return node;
  const entries = Object.entries(node as Record<string, unknown>);
  if (map) return Object.fromEntries(entries.map(([k, v]) => [k, normalizeSchema(v)]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (k === "format") continue;
    if (k === "pattern" && typeof v === "string" && !plainPattern(v)) continue;
    if (DATA_KEYS.has(k)) out[k] = v;
    else if (k === "$ref" && typeof v === "string") out[k] = v.replace(/^#\/definitions\//, "#/$defs/");
    else if (k === "definitions")
      out.$defs = { ...(normalizeSchema(v, true) as object), ...((out.$defs as object) ?? {}) };
    else out[k] = normalizeSchema(v, SCHEMA_MAPS.has(k));
  }
  return out;
}

/** The connection's credential as the audit and the card show it (seam 7). */
export function connectionCredential(conn: ConnectionRow, agent: Pick<AgentRow, "name">): CredentialRef {
  const own = conn.agentId !== null;
  return {
    kind: "connection",
    id: conn.id,
    owner: own ? "agent" : "workspace",
    label: own ? `${conn.label} (${agent.name})` : conn.label,
  };
}

export function connectionTools(
  deps: AppDeps,
  agent: AgentRow,
  conn: ConnectionRow,
  level: "read" | "write",
  taken: Set<string>,
  clients: Map<string, McpSession>,
  denied: (tool: string) => boolean,
  channelAsk = false,
): ToolDef<unknown>[] {
  const out: ToolDef<unknown>[] = [];
  const credential = connectionCredential(conn, agent);
  for (const tool of conn.tools) {
    if (!tool.confirmed || tool.access === "off") continue;
    if (level === "read" && tool.access !== "read") continue;
    let name = exposedName(conn, tool.name);
    if (taken.has(name)) name = `${name.slice(0, NAME_MAX - 7)}_${conn.id.slice(-6)}`;
    if (taken.has(name) || denied(name) || denied(tool.name)) continue;
    taken.add(name);
    const label = tool.label || tool.name;
    const asks = tool.access === "approval" || channelAsk;
    // The class comes from our rule, not from the MCP server's annotation: in the catalog `readOnlyHint` becomes
    // read access by itself, and a `delete_page` marked read-only must not run without a person.
    const effect: EffectClass = SENSITIVE_TOOL.test(tool.name) ? "K3" : tool.access === "read" ? "K0" : "K2";
    // The catalog's GitHub connector: only the repositories allowed for the agent (Access › Repositories).
    const repoCheck = (input: Record<string, unknown>) => {
      if (conn.custom || conn.connector !== "github") return;
      const refusal = repoRefusal(agent.repositories, tool.name, input);
      if (refusal) throw new ToolInputError(refusal);
    };
    out.push(
      define<Record<string, unknown>>({
        name,
        description: `[${conn.label}] ${tool.description || label}`.slice(0, 1024),
        effect,
        input: argsValidator(tool.inputSchema),
        jsonSchema: tool.inputSchema,
        async plan(_ctx, input) {
          repoCheck(input);
          const card = {
            scope: `connector:${conn.id}:${tool.name}`,
            title: `${conn.label}: ${label}`,
            connector: conn.connector,
            linkedAccount: credential.label,
            params: { connectionId: conn.id, tool: tool.name, input, credentialOwner: credential.owner },
          };
          if (effect === "K0")
            return { raises: [{ flag: "A" as const, source: `${conn.label}: ${label}` }], card, credential };
          return {
            destination: { kind: "external" as const, allowed: true, target: conn.label },
            // Asking for approval comes from the workspace (the tool's access) or from the channel (an `approval` rule).
            ...(asks ? { policy: "ask" as const } : {}),
            preview: { title: `${conn.label}: ${label}`, body: JSON.stringify(input, null, 2) },
            card,
            credential,
          };
        },
        async run(ctx, input) {
          repoCheck(input);
          // Stricter than the source: an approval can come long after the plan, so the call runs only while the
          // connection is still active, the tool still on, and the agent's level in this channel still covers it.
          const now = await stillAllowed(deps, agent, ctx.channel.id, conn.id, tool.name, name);
          // The call was planned under this access: one that now changed its class, or now asks a person this
          // call didn't ask, goes back to the model to be planned again.
          if (now.access !== tool.access || (now.ask && !asks))
            throw new ToolInputError(`${conn.label}: "${label}" changed its access. Call it again.`);
          // A refusal of the credential or of its scope means the service ran nothing, at the session or at the call.
          const rejected = async (err: unknown) => {
            clients.delete(conn.id);
            if (err instanceof McpInsufficientScope) return askScope(ctx, conn, label, err.scope);
            // The service's own words, without the credential it was sent (it may echo it back).
            const secrets = [...(await connectionSecrets(deps, now.row)), ...secretsSentBy(client)];
            const said = err instanceof Error ? outsideText(err, secrets) : "";
            const why = `${conn.label} failed: ${said || "the server did not answer"}`;
            // A credential rejected in use: the connectors screen must say "Reconnect".
            if (err instanceof McpAuthRequired) await markNeedsReconnect(deps, conn.id);
            return why;
          };
          let client: McpClient | undefined;
          try {
            client = await sessionFor(deps, clients, now.row);
            // The session opens before the call: a failure here sent nothing, so the effect key is released.
            await client.init();
          } catch (err) {
            const out = await rejected(err);
            if (typeof out !== "string") return out;
            throw new ToolInputError(out);
          }
          try {
            const res = await client.callTool(tool.name, input);
            return { content: res.text || "(empty result)", isError: res.isError };
          } catch (err) {
            const out = await rejected(err);
            if (typeof out !== "string") return out;
            if (err instanceof McpAuthRequired) throw new ToolInputError(out);
            // Anything else may have reached the service: not an input error, so runTool keeps the effect key and a
            // retry doesn't repeat a write blindly.
            throw new Error(out);
          }
        },
      }),
    );
  }
  return out;
}

/**
 * The service asked for more scope: records the request (with a cap on attempts) and posts the amber card for
 * whoever can authorize it. The model is told what happened, so it doesn't insist or make things up.
 */
async function askScope(
  ctx: ToolContext,
  conn: ConnectionRow,
  label: string,
  challenge: string | null,
): Promise<{ content: string; isError: true }> {
  const [fresh] = await ctx.deps.db.select().from(connections).where(eq(connections.id, conn.id));
  const outcome = await requestScope(ctx.deps, fresh ?? conn, label, challenge);
  if (outcome.kind === "key")
    return {
      content: `${conn.label} rejected: the key it was connected with lacks permission for "${label}". Ask an admin to connect it with a key that has it.`,
      isError: true,
    };
  if (outcome.kind === "exhausted")
    return {
      content: `${conn.label} still rejects "${label}" for lack of permission, and asking again would not change it. Do not retry; tell the person what is missing.`,
      isError: true,
    };
  if (!outcome.first)
    return {
      content: `${conn.label} still needs more permission for "${label}" (${outcome.missing.join(", ")}). The card asking an admin is already in the conversation. Nothing was done; do not retry until they grant it.`,
      isError: true,
    };
  await ctx.postCard(`${conn.label}: ${label}`, {
    connectorScope: {
      connectionId: conn.id,
      connector: conn.connector,
      label: conn.label,
      tool: label,
      scopes: outcome.missing,
      owner: conn.agentId ? "agent" : "workspace",
      state: "pending",
    },
  });
  return {
    content: `${conn.label} needs more permission for "${label}" (${outcome.missing.join(", ")}). A card was posted for an admin to grant it. Nothing was done; try again only after they do.`,
    isError: true,
  };
}

/** A connection's MCP client in the run, with the stored credential it was made with. */
interface McpSession {
  secret: string | null;
  client: Promise<McpClient>;
}

/** The run's client for the connection, made again when its stored credential changed (a refreshed token). */
async function sessionFor(deps: AppDeps, clients: Map<string, McpSession>, row: ConnectionRow) {
  const kept = clients.get(row.id);
  if (kept && kept.secret === row.secret) return kept.client;
  const client = mcpFor(deps, row);
  clients.set(row.id, { secret: row.secret, client });
  client.catch(() => clients.delete(row.id));
  return client;
}

/** The connections that apply to the agent (OAuth that hasn't come back isn't an account yet), with their service. */
async function candidatesOf(deps: AppDeps, agent: AgentRow) {
  return [
    ...(await activeConnections(deps.db, agent.workspaceId)),
    ...(await agentConnections(deps.db, agent.id)),
  ]
    .filter((c) => c.status !== "pending" && c.workspaceId === agent.workspaceId)
    .map((c) => ({ ...c, key: serviceKey(c) }));
}

type Candidate = Awaited<ReturnType<typeof candidatesOf>>[number];

/**
 * The agent's level on a connection in a channel: the workspace's grant (an own account writes), lowered by the
 * channel's rules on that service. null when the connection is out, or replaced by the agent's own account.
 */
function levelIn(
  agent: AgentRow,
  conn: Candidate,
  candidates: readonly Candidate[],
  allow: ReturnType<typeof allowance>,
  rules: Awaited<ReturnType<typeof channelRulesOf>>,
  channelId: string,
) {
  if (conn.status !== "active") return null;
  const granted = conn.agentId === agent.id ? "write" : allow.connection(conn);
  const sameService = candidates.filter((c) => c.key === conn.key).map((c) => c.id);
  return effectiveLevel(granted, rules, channelId, sameService);
}

/**
 * The connection as it is now, if the call may still go out: active and still the agent's account for the
 * service, the tool on and not denied, and the agent's current level in the channel enough for the tool.
 */
async function stillAllowed(
  deps: AppDeps,
  agent: AgentRow,
  channelId: string,
  connectionId: string,
  tool: string,
  exposed: string,
): Promise<{ row: ConnectionRow; access: schema.ToolAccessLevel; ask: boolean }> {
  const allow = allowance(await grantsOf(deps.db, agent.id));
  const rules = await channelRulesOf(deps.db, agent.workspaceId, agent.id);
  const candidates = await candidatesOf(deps, agent);
  const conn = credentialsFor(candidates, agent.id).find((c) => c.id === connectionId);
  const now = conn?.tools.find((t) => t.name === tool);
  const eff = conn ? levelIn(agent, conn, candidates, allow, rules, channelId) : null;
  const level = eff?.level;
  const on =
    now?.confirmed &&
    now.access !== "off" &&
    !allow.denied(exposed) &&
    !allow.denied(tool) &&
    (level === "write" || (level === "read" && now.access === "read"));
  if (!conn || !now || !eff || !on)
    throw new ToolInputError("This connection or tool is no longer available to the agent.");
  const { key: _, ...row } = conn;
  return { row, access: now.access, ask: eff.ask };
}

/**
 * The run's tools, already filtered by the agent's access. Connections: the workspace's and the agent's own
 * accounts (its own replaces the workspace's for the same service); the level comes from the workspace (an own
 * account writes) and the run's channel only lowers it.
 */
export async function toolsFor(
  deps: AppDeps,
  agent: AgentRow,
  where: { channel: ChannelRow; threadId: string | null },
): Promise<ToolDef<unknown>[]> {
  const { workspaceId } = agent;
  const grants = await grantsOf(deps.db, agent.id);
  const allow = allowance(grants);
  const tools = AGENT_TOOLS.filter((t) => allow.builtin(t.name));
  const taken = new Set(tools.map((t) => t.name));
  const clients = new Map<string, McpSession>();
  const rules = await channelRulesOf(deps.db, workspaceId, agent.id);
  const candidates = await candidatesOf(deps, agent);
  for (const conn of credentialsFor(candidates, agent.id)) {
    const eff = levelIn(agent, conn, candidates, allow, rules, where.channel.id);
    if (eff)
      tools.push(...connectionTools(deps, agent, conn, eff.level, taken, clients, allow.denied, eff.ask));
  }
  const run = { deps, agent, workspaceId, channel: where.channel };
  for (const t of await mailToolsFor(run)) if (!allow.denied(t.name)) tools.push(t);
  // The runner lent to the agent is its own permission; `deny:<tool>` still takes one away.
  for (const t of await environmentToolsFor(run)) if (!allow.denied(t.name)) tools.push(t);
  for (const t of await assignmentToolsFor(deps, agent, where.threadId))
    if (!allow.denied(t.name)) tools.push(t);
  if (await hasDatabases(run)) tools.push(...DATABASE_TOOLS.filter((t) => !allow.denied(t.name)));
  return tools;
}
