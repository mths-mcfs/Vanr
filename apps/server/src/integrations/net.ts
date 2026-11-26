// Where integrations may go. In the cloud edition, no internal network (SSRF: the cloud's metadata,
// the server's own database); in selfhost the local network is the common case and stays allowed.
// Without the local network, the name is resolved once, checked, and the connection goes to the checked IP
// (`Host` and SNI keep the name). Resolving again at fetch time would open DNS rebinding:
// the name answers a public IP at the check and the internal one at the connection.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { addressKind } from "@vanr/engine/net-address";
import { HttpError } from "../http";

/**
 * Internal network: everything that is not a public address. The rule is the same as the agent's browser
 * (`packages/engine/src/net-address.ts`); what is not an IP also counts as internal.
 */
export function isPrivateAddress(ip: string): boolean {
  return addressKind(ip) !== "public";
}

/** Resolves a name into all its addresses (tests replace it to simulate DNS). */
export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * The address to connect to: the host itself with the local network allowed; otherwise, the name's first
 * IP, after checking that none of its IPs is internal. 400 `blocked_host` when one is.
 */
export async function resolveHost(
  host: string,
  allowPrivate: boolean,
  code = "blocked_host",
  resolve: Resolver = systemResolver,
): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (allowPrivate) return bare;
  let ips: string[];
  if (isIP(bare)) ips = [bare];
  else {
    try {
      ips = await resolve(bare);
    } catch {
      throw new HttpError(400, "unreachable", "That host does not resolve", { host });
    }
  }
  const first = ips[0];
  if (!first || ips.some(isPrivateAddress))
    throw new HttpError(400, code, "That address is on a private network", { host });
  return first;
}

/** 400 `blocked_host` when the name resolves to the internal network and the installation doesn't allow it. */
export async function assertReachableHost(host: string, allowPrivate: boolean, code = "blocked_host") {
  await resolveHost(host, allowPrivate, code);
}

/**
 * URL that comes from outside (from the user or from a remote server: OAuth metadata, client registration,
 * `Location`): http(s) only, https required unless plain text is allowed (by default, with the local network
 * allowed), no user and password. Doesn't resolve the name (see `checkServerUrl`).
 */
export function parseServerUrl(raw: string, allowPrivate: boolean, allowPlaintext = allowPrivate): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "invalid_url", "That is not a valid address");
  }
  if (url.protocol !== "https:" && !(allowPlaintext && url.protocol === "http:"))
    throw new HttpError(400, "invalid_url", "Use an https:// address");
  if (url.username || url.password)
    throw new HttpError(400, "invalid_url", "Remove the credentials from the address");
  url.hash = "";
  return url;
}

/** `parseServerUrl` and the host outside the internal network. */
export async function checkServerUrl(
  raw: string,
  allowPrivate: boolean,
  resolve: Resolver = systemResolver,
  allowPlaintext = allowPrivate,
): Promise<URL> {
  const url = parseServerUrl(raw, allowPrivate, allowPlaintext);
  await resolveHost(url.hostname, allowPrivate, "blocked_host", resolve);
  return url;
}

const MAX_REDIRECTS = 5;

/** The fetch a guard wraps, kept on the guard so that guarding it again replaces the guard. */
const UNGUARDED = Symbol("unguarded");

/** The request goes to the IP already checked; `Host` and the TLS SNI keep the name. */
function pinned(url: URL, ip: string, init: RequestInit): [string, RequestInit] {
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (bare === ip) return [url.toString(), init];
  const target = new URL(url);
  target.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  const tls = url.protocol === "https:" ? { tls: { serverName: bare } } : {};
  return [target.toString(), { ...init, headers, ...tls } as RequestInit];
}

/**
 * fetch for outside servers. Every address goes through the `checkServerUrl` rule: the request and also each
 * redirect, followed here by hand. Without this, a remote server points ours at the internal network through
 * what it returns (OAuth metadata, client registration, `Location`). `Authorization` and `Cookie` don't follow
 * to another origin. Without the local network allowed, every hop connects to the checked IP.
 *
 * Guarding a guarded fetch wraps the fetch underneath with the new rule: two layers would pin the first hop
 * to its IP, and the inner one would then see a redirect back to the name as another origin and drop the
 * credentials.
 */
export function guardedFetch(
  fetchFn: typeof fetch,
  allowPrivate: boolean,
  resolve: Resolver = systemResolver,
  allowPlaintext = allowPrivate,
): typeof fetch {
  const raw: typeof fetch = (fetchFn as { [UNGUARDED]?: typeof fetch })[UNGUARDED] ?? fetchFn;
  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let url = input instanceof Request ? input.url : String(input);
    let req: RequestInit =
      input instanceof Request
        ? { method: input.method, headers: input.headers, body: input.body, ...init }
        : init;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = parseServerUrl(url, allowPrivate, allowPlaintext);
      const ip = await resolveHost(checked.hostname, allowPrivate, "blocked_host", resolve);
      const [target, sent] = pinned(checked, ip, { ...req, redirect: "manual" });
      const res = await raw(target, sent);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      const next = new URL(location, checked);
      const method = (req.method ?? "GET").toUpperCase();
      // As fetch does: 303, and 301/302 coming from a POST, become a GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST"))
        req = { ...req, method: "GET", body: undefined };
      if (next.origin !== checked.origin) {
        // A 307 or 308 resends the body as it is: a token request's code, verifier and secrets stay with the
        // origin they were meant for.
        if (req.body !== undefined && req.body !== null)
          throw new HttpError(
            400,
            "unreachable",
            "The server redirected a request with a body to another origin",
          );
        const headers = new Headers(req.headers);
        headers.delete("authorization");
        headers.delete("cookie");
        req = { ...req, headers };
      }
      url = next.toString();
    }
    throw new HttpError(400, "unreachable", "Too many redirects");
  };
  return Object.assign(guarded, { preconnect: () => {}, [UNGUARDED]: raw }) as typeof fetch;
}

/**
 * Where an integration may connect: the installation's two switches. `allowPrivate`: the local network
 * (`ALLOW_PRIVATE_NETWORKS`); `allowPlaintext`: a connection without TLS (`ALLOW_PLAINTEXT_INTEGRATIONS`, off
 * by default in production). `resolve` replaces DNS in the tests.
 */
export interface NetPolicy {
  allowPrivate: boolean;
  allowPlaintext: boolean;
  resolve?: Resolver;
}

/** The installation's network rule for the integrations (config `integrations`). */
export const netPolicy = (integrations: {
  allowPrivateNetworks: boolean;
  allowPlaintext: boolean;
}): NetPolicy => ({
  allowPrivate: integrations.allowPrivateNetworks,
  allowPlaintext: integrations.allowPlaintext,
});

/** 400 `tls_required` for a connection without TLS that the installation doesn't allow. */
export function assertTls(secure: boolean, policy: NetPolicy) {
  if (!secure && !policy.allowPlaintext)
    throw new HttpError(400, "tls_required", "This installation only connects to servers over TLS");
}

/**
 * The address a socket integration (IMAP, SMTP) connects to: the TLS rule, then `resolveHost` (the name is
 * resolved once and the socket goes to that IP; `host` stays the TLS name).
 */
export async function socketAddress(host: string, secure: boolean, policy: NetPolicy): Promise<string> {
  assertTls(secure, policy);
  return resolveHost(host, policy.allowPrivate, "blocked_host", policy.resolve ?? systemResolver);
}
