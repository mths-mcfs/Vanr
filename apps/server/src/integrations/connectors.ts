// The workspace's connections: a catalog connector (key or OAuth) and an own MCP server (address + key or
// OAuth), tools kept with the workspace's decision, and the MCP client of each connection for the runtime.

import {
  type Connection,
  type CustomConnectStart,
  type CustomServer,
  can,
  type MessageMeta,
  type SaveToolsInput,
} from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId, randomId } from "@vanr/engine/ids";
import { createSealer, type Sealer } from "@vanr/engine/seal";
import { PRODUCT } from "@vanr/product";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps, WorkspaceMember } from "../context";
import { HttpError, notFound } from "../http";
import { log } from "../logger";
import type { ConnectionRow } from "./access";
import { catalogEntry, SENSITIVE_TOOL } from "./catalog";
import { McpAuthRequired, McpClient, McpError, type McpTool } from "./mcp";
import { checkServerUrl } from "./net";
import {
  type AuthServer,
  authorizeUrl,
  checkIssuer,
  discoverAuthServer,
  exchangeCode,
  freshTokens,
  needsRefresh,
  type OAuthTokens,
  pkcePair,
  registerClient,
  scopeUnion,
  widens,
} from "./oauth";

const { connections, oauthStates, agentGrants, messages, members } = schema;
type StoredTool = schema.StoredTool;
type ToolAccessLevel = schema.ToolAccessLevel;
type StateRow = typeof oauthStates.$inferSelect;
const STATE_TTL_MS = 10 * 60_000;

const oauthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.string().nullable(),
  tokenEndpoint: z.string(),
  clientId: z.string(),
  clientSecret: z.string().nullable(),
  issuer: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  resource: z.string().nullable().optional(),
}) satisfies z.ZodType<OAuthTokens>;

const connSecret = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), apiKey: z.string() }),
  z.object({ kind: z.literal("oauth"), tokens: oauthTokens }),
  z.object({ kind: z.literal("none") }),
]);
type ConnSecret = z.infer<typeof connSecret>;

/** Every state is bound to the session that started the round trip. */
const stateBinding = z.object({ sessionId: z.string().min(1) });

const stateSecret = stateBinding.extend({
  verifier: z.string(),
  clientId: z.string(),
  clientSecret: z.string().nullable(),
  tokenEndpoint: z.string(),
  redirectUri: z.string(),
  resource: z.string().nullable(),
  /** Issuer checked in the discovery: the response only counts with an equal `iss` (RFC 9207). */
  issuer: z.string().optional(),
  issParameterSupported: z.boolean().optional(),
  scope: z.string().nullable().optional(),
});
type StateSecret = z.infer<typeof stateSecret>;

/** Attempts of the same set of scopes before it stops asking (the spec asks for "a few"). */
export const MAX_SCOPE_ATTEMPTS = 2;

export const integrationSealer = (deps: AppDeps): Sealer =>
  createSealer(deps.config.authSecret, "integrations");
const sealJson = (deps: AppDeps, v: unknown) => integrationSealer(deps).seal(JSON.stringify(v));
/** Opens what this module sealed and checks its shape: a row that doesn't match is not trusted. */
const openJson = <T>(deps: AppDeps, sealed: string, shape: z.ZodType<T>): T =>
  shape.parse(JSON.parse(integrationSealer(deps).open(sealed)));
const openSecret = (deps: AppDeps, sealed: string): ConnSecret => openJson(deps, sealed, connSecret);

const callbackUrl = (deps: AppDeps) => `${deps.config.publicUrl}/api/v1/connectors/oauth/callback`;

/** Only back into the app: an absolute path, without a scheme or a host. */
export function safeReturnTo(raw: string, workspaceId: string): string {
  if (/^\/(?!\/)[^\s\\]*$/.test(raw) && !raw.startsWith("/api/")) return raw;
  return `/workspace/${encodeURIComponent(workspaceId)}/settings/connectors`;
}

/** Who starts an authorization round trip: the member and the session it happens in. */
export type Starter = WorkspaceMember & { sessionId: string };

/** Who comes back from one: the account and the session of the request that carries the callback. */
export interface Viewer {
  userId: string;
  sessionId: string;
}

/**
 * Records the state of a round trip (connector, GitHub App, hosted mail) bound to the workspace, the person and
 * the session; `payload` goes sealed with the session.
 */
export async function saveState(
  deps: AppDeps,
  me: Starter,
  input: { kind: StateRow["kind"]; targetId: string | null; nextPath: string; ttlMs: number },
  payload: Record<string, unknown> = {},
): Promise<string> {
  const state = randomId(32);
  await deps.db.insert(oauthStates).values({
    state,
    workspaceId: me.workspaceId,
    userId: me.userId,
    kind: input.kind,
    targetId: input.targetId,
    secret: sealJson(deps, { ...payload, sessionId: me.sessionId }),
    nextPath: safeReturnTo(input.nextPath, me.workspaceId),
    expiresAt: new Date(deps.now().getTime() + input.ttlMs),
  });
  return state;
}

export type TakenState =
  /** No state of this kind: nowhere in the app to go back to. */
  | { ok: false; row: null }
  /** The state existed (and is now spent) but doesn't count for this request. */
  | { ok: false; row: StateRow }
  | { ok: true; row: StateRow; payload: unknown };

/**
 * Takes the state of a callback. It is spent on the first use (the delete returns it once, whatever comes
 * next) and only counts for the same person in the same session, before it expires and while that person can
 * still configure the workspace that started it: a removed member, a lowered role or another session gets the
 * state error.
 */
export async function takeState(
  deps: AppDeps,
  kind: StateRow["kind"],
  raw: string | undefined,
  viewer: Viewer,
): Promise<TakenState> {
  const [st] = raw ? await deps.db.delete(oauthStates).where(eq(oauthStates.state, raw)).returning() : [];
  if (st?.kind !== kind) return { ok: false, row: null };
  if (st.userId !== viewer.userId || st.expiresAt <= deps.now() || !st.secret) return { ok: false, row: st };
  let payload: unknown;
  try {
    payload = JSON.parse(integrationSealer(deps).open(st.secret));
  } catch {
    return { ok: false, row: st };
  }
  const binding = stateBinding.safeParse(payload);
  if (!binding.success || binding.data.sessionId !== viewer.sessionId) return { ok: false, row: st };
  const [m] = await deps.db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.workspaceId, st.workspaceId), eq(members.userId, viewer.userId)));
  if (!m || !can(m.role, "configure")) return { ok: false, row: st };
  return { ok: true, row: st, payload };
}

/** The app path of a state with the result in its query. */
export const backTo = (st: StateRow, params: string) =>
  `${st.nextPath}${st.nextPath.includes("?") ? "&" : "?"}${params}`;

export const toConnection = (row: ConnectionRow): Connection => ({
  id: row.id,
  connector: row.connector,
  label: row.label,
  accountDisplayName: row.accountDisplayName,
  status: row.status === "reauth_required" ? "reauth_required" : "active",
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
  scopeRequest: row.scopeRequest ? { scope: row.scopeRequest.scope, tool: row.scopeRequest.tool } : null,
});

export const toCustomServer = (row: ConnectionRow): CustomServer => ({
  id: row.id,
  label: row.label,
  serverUrl: row.serverUrl ?? "",
  createdAt: row.createdAt.toISOString(),
  vettedAt: row.vettedAt?.toISOString() ?? null,
  tools: row.tools.map((t) => ({
    name: t.name,
    description: t.description,
    label: t.label,
    access: t.access,
    proposedAccess: t.proposedAccess,
    readOnlyHint: t.readOnlyHint,
    confirmed: t.confirmed,
  })),
});

/** Proposal: read-only when the server says so; a sensitive action always asks for approval. */
function proposeAccess(tool: McpTool): ToolAccessLevel {
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "approval";
}

/**
 * Merges the new list with the decisions there already were. A catalog connector comes out decided (read for
 * what is read-only, approval for the sensitive, write for the rest). On an own MCP server, a new tool waits for
 * the workspace's review.
 */
function mergeTools(
  fresh: readonly McpTool[],
  previous: readonly StoredTool[],
  custom: boolean,
): StoredTool[] {
  const before = new Map(previous.map((t) => [t.name, t]));
  return fresh.map((t) => {
    const readOnly = t.annotations?.readOnlyHint === true;
    const proposed = proposeAccess(t);
    const old = before.get(t.name);
    const catalogAccess: ToolAccessLevel = readOnly
      ? "read"
      : SENSITIVE_TOOL.test(t.name)
        ? "approval"
        : "write";
    return {
      name: t.name,
      description: (t.description ?? t.annotations?.title ?? "").slice(0, 2000),
      label: old?.label ?? "",
      access: old?.access ?? (custom ? proposed : catalogAccess),
      proposedAccess: proposed,
      readOnlyHint: readOnly,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      confirmed: old?.confirmed ?? !custom,
    };
  });
}

function headersFor(secret: ConnSecret): Record<string, string> {
  if (secret.kind === "api_key") return { authorization: `Bearer ${secret.apiKey}` };
  if (secret.kind === "oauth") return { authorization: `Bearer ${secret.tokens.accessToken}` };
  return {};
}

/**
 * The connection's credential, refreshed when its OAuth token is about to expire. The refresh reads, decides
 * and writes under the connection's row lock: two runs that need it at once make one exchange (a rotated
 * refresh token can only be used once) and the second reads the first one's result. The lock is the row's id,
 * never the server address, so two servers whose paths differ only in case never share a credential.
 */
async function liveSecret(deps: AppDeps, row: ConnectionRow): Promise<ConnSecret> {
  if (!row.secret) return { kind: "none" };
  const seen = openSecret(deps, row.secret);
  if (seen.kind !== "oauth" || !needsRefresh(seen.tokens, deps.now())) return seen;
  return deps.db.transaction(async (tx): Promise<ConnSecret> => {
    const [locked] = await tx
      .select({ secret: connections.secret })
      .from(connections)
      .where(eq(connections.id, row.id))
      .for("update");
    if (!locked?.secret) throw new McpAuthRequired(null);
    const current = openSecret(deps, locked.secret);
    if (current.kind !== "oauth" || !needsRefresh(current.tokens, deps.now())) return current;
    const tokens = await freshTokens(deps.fetchExternal, current.tokens, deps.now()).catch(() => null);
    if (!tokens) throw new McpAuthRequired(null);
    const next: ConnSecret = { kind: "oauth", tokens };
    await tx
      .update(connections)
      .set({ secret: sealJson(deps, next), updatedAt: deps.now() })
      .where(eq(connections.id, row.id));
    return next;
  });
}

/** The connection's MCP client; refreshes the OAuth token when it is about to expire. */
export async function mcpFor(deps: AppDeps, row: ConnectionRow): Promise<McpClient> {
  if (!row.serverUrl) throw new McpError("Connection has no server address");
  const secret = await liveSecret(deps, row);
  return new McpClient({ url: row.serverUrl, fetch: deps.fetchExternal, headers: headersFor(secret) });
}

/** The service rejected the kept credential: the connection shows as "Reconnect". */
export async function markNeedsReconnect(deps: AppDeps, connectionId: string): Promise<void> {
  await deps.db
    .update(connections)
    .set({ status: "reauth_required" })
    .where(eq(connections.id, connectionId));
}

/** Lists the tools; a rejected credential marks the connection to reconnect. */
async function listToolsOf(deps: AppDeps, row: ConnectionRow): Promise<McpTool[]> {
  try {
    return await (await mcpFor(deps, row)).listTools();
  } catch (err) {
    if (err instanceof McpAuthRequired) {
      await markNeedsReconnect(deps, row.id);
      throw new HttpError(400, "connector.auth", "The server rejected the credential");
    }
    throw new HttpError(
      400,
      "connector.unreachable",
      err instanceof Error ? err.message : "Server unreachable",
    );
  }
}

export async function connectionById(deps: AppDeps, workspaceId: string, id: string): Promise<ConnectionRow> {
  const [row] = await deps.db
    .select()
    .from(connections)
    .where(
      and(eq(connections.workspaceId, workspaceId), eq(connections.id, id), isNull(connections.revokedAt)),
    );
  if (!row) throw notFound("Connection not found");
  return row;
}

async function probe(deps: AppDeps, url: string, secret: ConnSecret): Promise<McpTool[]> {
  const client = new McpClient({ url, fetch: deps.fetchExternal, headers: headersFor(secret) });
  return client.listTools();
}

/**
 * Connects with a key. With `agentId`, the connection is that agent's own account (seam 7): only it uses it,
 * instead of the workspace's connection to the same service.
 */
export async function connectWithKey(
  deps: AppDeps,
  me: WorkspaceMember,
  input: { connector: string; apiKey: string; label?: string },
  agentId: string | null = null,
): Promise<ConnectionRow> {
  const entry = catalogEntry(input.connector);
  if (!entry) throw new HttpError(400, "connector.unknown", "Unknown connector");
  if (!entry.auth.includes("api_key"))
    throw new HttpError(400, "connector.key_unsupported", "This connector connects with OAuth");
  const url = (
    await checkServerUrl(entry.serverUrl, deps.config.integrations.allowPrivateNetworks)
  ).toString();
  const secret: ConnSecret = { kind: "api_key", apiKey: input.apiKey };
  let tools: McpTool[];
  try {
    tools = await probe(deps, url, secret);
  } catch (err) {
    if (err instanceof McpAuthRequired)
      throw new HttpError(400, "connector.invalid_key", "The key was rejected");
    throw new HttpError(
      400,
      "connector.unreachable",
      err instanceof Error ? err.message : "Server unreachable",
    );
  }
  const at = deps.now();
  const [row] = await deps.db
    .insert(connections)
    .values({
      id: newId("con"),
      workspaceId: me.workspaceId,
      connector: entry.id,
      custom: false,
      label: input.label?.trim() || entry.label,
      serverUrl: url,
      authKind: "api_key",
      secret: sealJson(deps, secret),
      tools: mergeTools(tools, [], false),
      status: "active",
      createdBy: me.userId,
      agentId,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!row) throw new Error("connection insert failed");
  return row;
}

/** What the server's challenge said: where the metadata is and the scope it wants. */
interface Challenge {
  resourceMetadata: string | null;
  scope: string | null;
}

/**
 * Discovers the server's OAuth, registers the client (or reuses the one of the same issuer) and keeps the
 * state with the checked issuer; returns the authorization URL.
 */
async function beginOAuth(
  deps: AppDeps,
  me: Starter,
  row: ConnectionRow,
  nextPath: string,
  challenge: Challenge,
  reuse: { issuer: string; clientId: string; clientSecret: string | null } | null = null,
): Promise<string> {
  const url = row.serverUrl ?? "";
  const server: AuthServer | null = await discoverAuthServer(
    deps.fetchExternal,
    url,
    challenge.resourceMetadata,
    deps.config.integrations.allowPrivateNetworks,
    challenge.scope,
  ).catch(() => null);
  if (!server)
    throw new HttpError(400, "connector.oauth_unavailable", "This server does not offer OAuth sign-in");
  const redirectUri = callbackUrl(deps);
  // The credential is bound to the issuer: a client registered with another issuer doesn't serve here.
  let client: { clientId: string; clientSecret: string | null } | null =
    reuse && reuse.issuer === server.issuer ? reuse : null;
  if (!client) {
    if (!server.registration_endpoint)
      throw new HttpError(400, "connector.oauth_unavailable", "This server does not offer OAuth sign-in");
    client = await registerClient(
      deps.fetchExternal,
      server.registration_endpoint,
      redirectUri,
      PRODUCT.name,
    ).catch(() => null);
  }
  if (!client)
    throw new HttpError(400, "connector.oauth_unavailable", "The server rejected the client registration");
  const { verifier, challenge: pkce } = pkcePair();
  const secret: Omit<StateSecret, "sessionId"> = {
    verifier,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenEndpoint: server.token_endpoint,
    redirectUri,
    resource: url,
    issuer: server.issuer,
    issParameterSupported: server.issParameterSupported,
    scope: server.scope,
  };
  const state = await saveState(
    deps,
    me,
    { kind: "connector", targetId: row.id, nextPath, ttlMs: STATE_TTL_MS },
    secret,
  );
  return authorizeUrl({
    endpoint: server.authorization_endpoint,
    clientId: client.clientId,
    redirectUri,
    state,
    challenge: pkce,
    scope: server.scope,
    resource: url,
  });
}

async function pendingConnection(
  deps: AppDeps,
  me: WorkspaceMember,
  values: { connector: string; custom: boolean; label: string; serverUrl: string; agentId?: string | null },
): Promise<ConnectionRow> {
  const at = deps.now();
  const [row] = await deps.db
    .insert(connections)
    .values({
      id: newId("con"),
      workspaceId: me.workspaceId,
      ...values,
      authKind: "oauth",
      secret: null,
      tools: [],
      status: "pending",
      createdBy: me.userId,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!row) throw new Error("connection insert failed");
  return row;
}

export async function startCatalogOAuth(
  deps: AppDeps,
  me: Starter,
  connector: string,
  nextPath: string,
  agentId: string | null = null,
): Promise<string> {
  const entry = catalogEntry(connector);
  if (!entry) throw new HttpError(400, "connector.unknown", "Unknown connector");
  if (!entry.auth.includes("oauth"))
    throw new HttpError(400, "connector.oauth_unavailable", "This connector connects with a key");
  const url = (
    await checkServerUrl(entry.serverUrl, deps.config.integrations.allowPrivateNetworks)
  ).toString();
  const row = await pendingConnection(deps, me, {
    connector: entry.id,
    custom: false,
    label: entry.label,
    serverUrl: url,
    agentId,
  });
  try {
    return await beginOAuth(deps, me, row, nextPath, { resourceMetadata: null, scope: null });
  } catch (err) {
    await deps.db.delete(connections).where(eq(connections.id, row.id));
    throw err;
  }
}

export async function connectCustom(
  deps: AppDeps,
  me: Starter,
  input: { serverUrl: string; apiKey?: string; label?: string; nextPath: string },
): Promise<CustomConnectStart> {
  const url = (
    await checkServerUrl(input.serverUrl, deps.config.integrations.allowPrivateNetworks)
  ).toString();
  const label = input.label?.trim() || new URL(url).hostname;
  const secret: ConnSecret = input.apiKey ? { kind: "api_key", apiKey: input.apiKey } : { kind: "none" };
  let tools: McpTool[];
  try {
    tools = await probe(deps, url, secret);
  } catch (err) {
    if (!(err instanceof McpAuthRequired))
      throw new HttpError(
        400,
        "connector.unreachable",
        err instanceof Error ? err.message : "Server unreachable",
      );
    // With a rejected key, or without OAuth on the server, the person needs (another) key.
    if (input.apiKey) return { status: "key_missing", serverId: null };
    const row = await pendingConnection(deps, me, {
      connector: "custom",
      custom: true,
      label,
      serverUrl: url,
    });
    try {
      const authorize = await beginOAuth(deps, me, row, input.nextPath, {
        resourceMetadata: err.resourceMetadata,
        scope: err.scope,
      });
      return { status: "oauth", consentUrl: authorize, serverId: row.id };
    } catch {
      await deps.db.delete(connections).where(eq(connections.id, row.id));
      return { status: "key_missing", serverId: null };
    }
  }
  const at = deps.now();
  const [row] = await deps.db
    .insert(connections)
    .values({
      id: newId("con"),
      workspaceId: me.workspaceId,
      connector: "custom",
      custom: true,
      label,
      serverUrl: url,
      authKind: secret.kind,
      secret: secret.kind === "none" ? null : sealJson(deps, secret),
      tools: mergeTools(tools, [], true),
      status: "active",
      createdBy: me.userId,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!row) throw new Error("connection insert failed");
  return { status: "server", server: toCustomServer(row) };
}

/**
 * The OAuth callback: checks the issuer, exchanges the code, turns the connection on and lists the tools.
 * Returns where to go. The `iss` is checked before everything, including showing the `error` (RFC 9207 §2.4):
 * a response from another issuer neither exchanges a code nor becomes a message on the screen.
 */
export async function finishOAuth(
  deps: AppDeps,
  viewer: Viewer,
  query: { code?: string; state?: string; error?: string; iss?: string },
): Promise<string> {
  const taken = await takeState(deps, "connector", query.state, viewer);
  if (!taken.row?.targetId) return "/?connector_error=state";
  const st = taken.row;
  const back = (params: string) => backTo(st, params);
  if (!taken.ok) return back("connector_error=state");
  const parsed = stateSecret.safeParse(taken.payload);
  if (!parsed.success) return back("connector_error=state");
  const s = parsed.data;
  const [row] = await deps.db
    .select()
    .from(connections)
    .where(and(eq(connections.id, st.targetId ?? ""), eq(connections.workspaceId, st.workspaceId)));
  if (!row || row.revokedAt) return back("connector_error=state");
  const dropPending = async () => {
    if (row.status === "pending") await deps.db.delete(connections).where(eq(connections.id, row.id));
  };
  if (s.issuer !== undefined) {
    try {
      checkIssuer({ iss: query.iss, expected: s.issuer, supported: s.issParameterSupported === true });
    } catch (err) {
      log.warn("connector.oauth_issuer", { connectionId: row.id, err });
      await dropPending();
      return back("connector_error=issuer");
    }
  }
  if (query.error || !query.code) {
    await dropPending();
    return back(`connector_error=${encodeURIComponent(query.error ?? "denied")}`);
  }
  try {
    const tokens = await exchangeCode(
      deps.fetchExternal,
      {
        tokenEndpoint: s.tokenEndpoint,
        code: query.code,
        verifier: s.verifier,
        redirectUri: s.redirectUri,
        clientId: s.clientId,
        clientSecret: s.clientSecret,
        resource: s.resource,
        issuer: s.issuer ?? null,
        scope: s.scope ?? null,
      },
      deps.now(),
    );
    const secret: ConnSecret = { kind: "oauth", tokens };
    // The scope request is only settled if the service gave what was asked. A partial consent keeps the
    // request and the counter (the card keeps waiting and no other one is born on each return).
    const granted = row.scopeRequest !== null && !widens(row.scopeRequest.scope, tokens.scope ?? null);
    const [active] = await deps.db
      .update(connections)
      .set({
        secret: sealJson(deps, secret),
        status: "active",
        ...(granted ? { scopeRequest: null } : {}),
        updatedAt: deps.now(),
      })
      .where(eq(connections.id, row.id))
      .returning();
    if (active) {
      const tools = await listToolsOf(deps, active).catch(() => [] as McpTool[]);
      await deps.db
        .update(connections)
        .set({ tools: mergeTools(tools, active.tools, active.custom) })
        .where(eq(connections.id, row.id));
      if (granted) await settleScopeCards(deps, row.id);
    }
  } catch (err) {
    log.warn("connector.oauth_failed", { err, connectionId: row.id });
    await dropPending();
    return back("connector_error=token");
  }
  return back(`connected=${encodeURIComponent(row.custom ? `custom:${row.id}` : row.connector)}`);
}

const scopeCard = z.object({
  connectionId: z.string(),
  connector: z.string(),
  label: z.string(),
  owner: z.enum(["agent", "workspace"]),
  scopes: z.array(z.string()),
  state: z.enum(["granted", "pending"]).optional(),
  tool: z.string(),
}) satisfies z.ZodType<NonNullable<MessageMeta["connectorScope"]>>;

/** This connection's "needs permission" cards turn "granted" in the conversation. */
async function settleScopeCards(deps: AppDeps, connectionId: string): Promise<void> {
  const rows = await deps.db
    .select({ id: messages.id, meta: messages.meta, channelId: messages.channelId })
    .from(messages)
    .where(sql`${messages.meta} -> 'connectorScope' ->> 'connectionId' = ${connectionId}`);
  for (const m of rows) {
    const parsed = scopeCard.safeParse(m.meta.connectorScope);
    if (!parsed.success || parsed.data.state === "granted") continue;
    const card = parsed.data;
    const meta = { ...m.meta, connectorScope: { ...card, state: "granted" as const } };
    await deps.db.update(messages).set({ meta }).where(eq(messages.id, m.id));
    deps.hub.toChannel(m.channelId, {
      type: "connector.scope",
      messageId: m.id,
      connectorScope: meta.connectorScope,
    });
  }
}

/** What the run does when the service asks for more scope. */
type ScopeOutcome =
  /** Asked (new, with a card in the conversation; or repeated, with the earlier card still standing). */
  | { kind: "ask"; scope: string; missing: string[]; first: boolean }
  /** It asked for this set enough times, or the service asks for what was already given: it doesn't ask again. */
  | { kind: "exhausted" }
  /** API key (no OAuth): only by changing the key. */
  | { kind: "key" };

/**
 * Step-up on `insufficient_scope` (MCP spec 2026-07-28, "Step-Up Authorization Flow"): the scope to request is
 * the union of what was already requested and the challenge's. It asks for the same set a few times only and
 * never asks again for what doesn't widen what was already given (or the run enters an authorization loop).
 */
export async function requestScope(
  deps: AppDeps,
  row: ConnectionRow,
  tool: string,
  challenge: string | null,
): Promise<ScopeOutcome> {
  if (row.authKind !== "oauth") return { kind: "key" };
  // Reads and writes in the same transaction, with the row locked: two runs that hit the 403 at the same time
  // count two attempts and only one posts the card.
  return deps.db.transaction(async (tx): Promise<ScopeOutcome> => {
    const [fresh] = await tx.select().from(connections).where(eq(connections.id, row.id)).for("update");
    if (!fresh?.secret) return { kind: "key" };
    const secret = openSecret(deps, fresh.secret);
    if (secret.kind !== "oauth") return { kind: "key" };
    const current = secret.tokens.scope ?? null;
    const union = scopeUnion(current, fresh.scopeRequest?.scope, challenge);
    if (!union || !widens(union, current)) return { kind: "exhausted" };
    const before = fresh.scopeRequest;
    const attempts = before && before.scope === union ? before.attempts + 1 : 1;
    if (attempts > MAX_SCOPE_ATTEMPTS) return { kind: "exhausted" };
    await tx
      .update(connections)
      .set({ scopeRequest: { scope: union, attempts, tool, at: deps.now().toISOString() } })
      .where(eq(connections.id, row.id));
    const have = new Set((current ?? "").split(/\s+/));
    return {
      kind: "ask",
      scope: union,
      missing: union.split(" ").filter((t) => !have.has(t)),
      first: attempts === 1,
    };
  });
}

/**
 * The person authorizes the requested scope: a new authorization with the union (the client of the same issuer
 * is reused; with another issuer, it registers again). The connection stays active until the return.
 */
export async function startScopeStepUp(
  deps: AppDeps,
  me: Starter,
  row: ConnectionRow,
  nextPath: string,
): Promise<string> {
  if (row.authKind !== "oauth" || !row.scopeRequest)
    throw new HttpError(400, "connector.no_scope_request", "This connection is not waiting for permission");
  const secret = row.secret ? openSecret(deps, row.secret) : null;
  const tokens = secret?.kind === "oauth" ? secret.tokens : null;
  const reuse =
    tokens?.issuer != null
      ? { issuer: tokens.issuer, clientId: tokens.clientId, clientSecret: tokens.clientSecret }
      : null;
  return beginOAuth(
    deps,
    me,
    row,
    nextPath,
    { resourceMetadata: null, scope: row.scopeRequest.scope },
    reuse,
  );
}

export async function refreshCustom(deps: AppDeps, row: ConnectionRow): Promise<ConnectionRow> {
  const tools = await listToolsOf(deps, row);
  const [updated] = await deps.db
    .update(connections)
    .set({ tools: mergeTools(tools, row.tools, true), status: "active", updatedAt: deps.now() })
    .where(eq(connections.id, row.id))
    .returning();
  return updated ?? row;
}

export async function saveCustomTools(
  deps: AppDeps,
  row: ConnectionRow,
  input: SaveToolsInput,
): Promise<ConnectionRow> {
  const decided = new Map(input.tools.map((t) => [t.name, t]));
  for (const name of decided.keys())
    if (!row.tools.some((t) => t.name === name))
      throw new HttpError(400, "connector.unknown_tool", "That tool is not on this server", { name });
  const tools = row.tools.map((t) => {
    const d = decided.get(t.name);
    if (!d) return t;
    // A sensitive one can only ask for approval or be off.
    const access: ToolAccessLevel =
      SENSITIVE_TOOL.test(t.name) && (d.access === "read" || d.access === "write") ? "approval" : d.access;
    return { ...t, access, label: d.label.trim().slice(0, 120), confirmed: d.confirmed ?? true };
  });
  const [updated] = await deps.db
    .update(connections)
    .set({ tools, label: input.label.trim() || row.label, vettedAt: deps.now(), updatedAt: deps.now() })
    .where(eq(connections.id, row.id))
    .returning();
  return updated ?? row;
}

/** Revokes and takes it away from the agents. */
export async function disconnect(deps: AppDeps, row: ConnectionRow) {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({ revokedAt: deps.now(), secret: null, updatedAt: deps.now() })
      .where(eq(connections.id, row.id));
    await tx.delete(agentGrants).where(eq(agentGrants.connectionId, row.id));
  });
}
