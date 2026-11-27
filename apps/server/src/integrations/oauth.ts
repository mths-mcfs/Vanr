// OAuth 2.1 with PKCE for connectors: discovery of a remote MCP server's authorization server
// (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591) and the exchange of the code for the token.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { type NetPolicy, parseServerUrl } from "./net";

class OAuthError extends Error {}

const protectedResource = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const serverMetadata = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
});
type AuthServerMetadata = z.infer<typeof serverMetadata>;

/** Authorization server found, with the issuer checked and the initial scope to request. */
export interface AuthServer extends AuthServerMetadata {
  /** Checked issuer (identical to the identifier used to build the `.well-known`, RFC 8414 §3.3). */
  issuer: string;
  /** The server promises to send `iss` on the way back: without it, the response is rejected (RFC 9207). */
  issParameterSupported: boolean;
  /**
   * Initial scope (MCP spec 2026-07-28, "Scope Selection Strategy"): the `scope` of the 401 challenge wins;
   * without it, the resource's `scopes_supported`; without both, none.
   */
  scope: string | null;
}

/** The longest token lifetime a provider may announce: ten years, in seconds. */
export const MAX_EXPIRES_IN_S = 10 * 365 * 24 * 60 * 60;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  refresh_token: z.string().optional(),
  /** Seconds; 0 is expired now (the next call refreshes); absent is "doesn't expire". */
  expires_in: z.number().int().min(0).max(MAX_EXPIRES_IN_S).optional(),
  scope: z.string().optional(),
});

/** What we keep sealed after the exchange: enough to refresh without the person. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO; null when the server doesn't say. */
  expiresAt: string | null;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  /**
   * Issuer that gave the token and the client (the credential is bound to it: MCP spec 2026-07-28,
   * "Authorization Server Binding"). Absent on connections from before this version.
   */
  issuer?: string | null;
  /** Granted scope (the response's) or, without it, the requested one. Base of the union in the step-up. */
  scope?: string | null;
  /** Resource (RFC 8707) requested in the authorization; it also goes in the refresh. */
  resource?: string | null;
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown | null> {
  try {
    const res = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const noSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * Where to look for the resource metadata (RFC 9728 §3.1): the challenge's `resource_metadata` when it came;
 * otherwise the `.well-known` with the MCP server's path and then the root one.
 */
function resourceMetadataUrls(resourceUrl: string, fromChallenge: string | null): string[] {
  if (fromChallenge) return [fromChallenge];
  const url = new URL(resourceUrl);
  const path = noSlash(url.pathname);
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/**
 * Where to look for the authorization server metadata (RFC 8414 §3.1 and OIDC Discovery): with a path in the
 * issuer, the `.well-known` goes between the origin and the path; OIDC also at the end.
 */
function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = noSlash(url.pathname);
  if (!path)
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * Finds the authorization server of a protected resource (remote MCP). The published issuer has to be identical
 * to the one that built the address (RFC 8414 §3.3): otherwise one authorization server passes for another
 * (mix-up attack) and the whole discovery fails.
 */
export async function discoverAuthServer(
  fetchFn: typeof fetch,
  resourceUrl: string,
  resourceMetadataUrl: string | null,
  net: NetPolicy,
  challengeScope: string | null = null,
): Promise<AuthServer> {
  let prm: z.infer<typeof protectedResource> | null = null;
  for (const url of resourceMetadataUrls(resourceUrl, resourceMetadataUrl)) {
    const document = await getJson(fetchFn, safeUrl(url, net));
    if (document === null) continue;
    const parsed = protectedResource.safeParse(document);
    const expected = resourceMetadataUrl
      ? resourceUrl
      : url.replace("/.well-known/oauth-protected-resource", "");
    if (!parsed.success || parsed.data.resource !== expected)
      throw new OAuthError("The protected resource metadata does not match the resource");
    prm = parsed.data;
    break;
  }
  // Old servers don't publish the resource: the domain itself plays the authorization server.
  const issuer = prm?.authorization_servers[0] ?? new URL(resourceUrl).origin;
  safeUrl(issuer, net);
  for (const url of authServerMetadataUrls(issuer)) {
    const meta = serverMetadata.safeParse(await getJson(fetchFn, url));
    if (!meta.success) continue;
    if (meta.data.issuer !== issuer) throw new OAuthError("The authorization server issuer does not match");
    const safe = safeEndpoints(meta.data, net);
    const supported = prm?.scopes_supported?.length ? prm.scopes_supported.join(" ") : null;
    return {
      ...safe,
      issuer,
      issParameterSupported: safe.authorization_response_iss_parameter_supported === true,
      scope: challengeScope?.trim() || supported,
    };
  }
  throw new OAuthError("The server does not publish OAuth metadata");
}

function safeUrl(raw: string, net: NetPolicy): string {
  try {
    return parseServerUrl(raw, net.allowPrivate, net.allowPlaintext).toString();
  } catch {
    throw new OAuthError("The server published an unsafe OAuth address");
  }
}

/**
 * The authorization response (RFC 9207 §2.4), before sending the code to any token endpoint: with `iss`, it has
 * to be identical to the issuer recorded at the start; without `iss`, it only passes if the server didn't
 * promise to send it. Exact comparison, without normalizing.
 */
export function checkIssuer(input: { iss: string | undefined; expected: string; supported: boolean }): void {
  if (input.iss === undefined) {
    if (input.supported) throw new OAuthError("The authorization response has no issuer");
    return;
  }
  if (input.iss !== input.expected)
    throw new OAuthError("The authorization response came from another issuer");
}

/** Union of scopes (RFC 6749 §3.3): each one once, in the order it appeared. */
export function scopeUnion(...scopes: ReadonlyArray<string | null | undefined>): string | null {
  const seen: string[] = [];
  for (const s of scopes)
    for (const token of (s ?? "").split(/\s+/)) if (token && !seen.includes(token)) seen.push(token);
  return seen.length ? seen.join(" ") : null;
}

/** `union` asks for some scope that `current` doesn't have. */
export function widens(union: string | null, current: string | null): boolean {
  const have = new Set((current ?? "").split(/\s+/).filter(Boolean));
  return (union ?? "").split(/\s+/).some((t) => t && !have.has(t));
}

/**
 * Addresses the remote server publishes: the authorization one goes to the person's browser and the others are
 * called by our server. A scheme that isn't http(s) (`javascript:`, `file:`), http outside the allowed local
 * network or a user and password in the URL bring the whole discovery down.
 */
function safeEndpoints(meta: AuthServerMetadata, net: NetPolicy): AuthServerMetadata {
  const urls = [meta.authorization_endpoint, meta.token_endpoint, meta.registration_endpoint];
  try {
    for (const u of urls) if (u !== undefined) parseServerUrl(u, net.allowPrivate, net.allowPlaintext);
  } catch {
    throw new OAuthError("The server published an unsafe OAuth address");
  }
  return meta;
}

/** Dynamic registration: the server returns a client_id that is ours alone. */
export async function registerClient(
  fetchFn: typeof fetch,
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const res = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      // Required in the 2026-07-28 registration: the redirect goes to a server of ours, not localhost.
      application_type: "web",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) throw new OAuthError("Client registration failed");
  const parsed = z
    .object({ client_id: z.string().min(1), client_secret: z.string().optional() })
    .safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new OAuthError("Client registration returned no client_id");
  return { clientId: parsed.data.client_id, clientSecret: parsed.data.client_secret ?? null };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function consentUrl(input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string | null;
  resource?: string | null;
}): string {
  const url = new URL(input.endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.scope) url.searchParams.set("scope", input.scope);
  if (input.resource) url.searchParams.set("resource", input.resource);
  return url.toString();
}

async function tokenRequest(
  fetchFn: typeof fetch,
  endpoint: string,
  form: Record<string, string>,
  now: Date,
  client: { clientId: string; clientSecret: string | null },
  previous: {
    refreshToken: string | null;
    issuer: string | null;
    scope: string | null;
    resource: string | null;
  },
): Promise<OAuthTokens> {
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      ...form,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }),
    // The form holds the code, the verifier and the secrets: a redirect would carry it elsewhere (a 307 or
    // 308 resends the body), so a redirect is a failed exchange.
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) throw new OAuthError("Token exchange failed");
  const parsed = tokenResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new OAuthError("Token response has no access_token");
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? previous.refreshToken,
    expiresAt:
      t.expires_in === undefined ? null : new Date(now.getTime() + t.expires_in * 1000).toISOString(),
    tokenEndpoint: endpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    issuer: previous.issuer,
    scope: t.scope ?? previous.scope,
    resource: previous.resource,
  };
}

export function exchangeCode(
  fetchFn: typeof fetch,
  input: {
    tokenEndpoint: string;
    code: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string | null;
    resource?: string | null;
    issuer?: string | null;
    scope?: string | null;
  },
  now: Date,
): Promise<OAuthTokens> {
  return tokenRequest(
    fetchFn,
    input.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      ...(input.resource ? { resource: input.resource } : {}),
    },
    now,
    input,
    {
      refreshToken: null,
      issuer: input.issuer ?? null,
      scope: input.scope ?? null,
      resource: input.resource ?? null,
    },
  );
}

/** How long before the expiry a token is refreshed. */
export const REFRESH_MARGIN_MS = 60_000;

/** The token expires within the margin and there is a refresh token to renew it with. */
export function needsRefresh(tokens: OAuthTokens, now: Date): boolean {
  if (!tokens.expiresAt || !tokens.refreshToken) return false;
  const at = Date.parse(tokens.expiresAt);
  // An unreadable expiry is treated as expired: refreshing is the safe side.
  return !Number.isFinite(at) || at - now.getTime() <= REFRESH_MARGIN_MS;
}

/** Refreshes when less than a minute is left; without a refresh token, returns what it has. */
export async function freshTokens(
  fetchFn: typeof fetch,
  tokens: OAuthTokens,
  now: Date,
): Promise<OAuthTokens> {
  if (!needsRefresh(tokens, now) || !tokens.refreshToken) return tokens;
  return tokenRequest(
    fetchFn,
    tokens.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      ...(tokens.resource ? { resource: tokens.resource } : {}),
    },
    now,
    tokens,
    {
      refreshToken: tokens.refreshToken,
      issuer: tokens.issuer ?? null,
      scope: tokens.scope ?? null,
      resource: tokens.resource ?? null,
    },
  );
}
