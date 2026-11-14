// What the web talks to the server with: the shared client for every operation in the server's
// table, and the sign-in service's calls beside it. Both leave through one fetch, and that fetch is
// where the end of a session is noticed.
import { type Clock, createClient, type FetchLike, type VanrClient } from "@vanr/client";
import { AUTH_PREFIX, type AuthApi, createAuthApi } from "./auth.ts";
import type { WebTransport } from "./wire.ts";

export type WebApi = { readonly client: VanrClient; readonly auth: AuthApi };

/**
 * Wraps a fetch so that a 401 from the API tells the session it may be over. The sign-in service
 * is left out: a wrong password or a spent email link also answers 401, and neither ends a session.
 * Whether a session was open at all is the session gate's business, not this function's.
 */
export function watchSession(send: FetchLike, onUnauthorized: () => void): FetchLike {
  return async (url, init) => {
    const response = await send(url, init);
    if (response.status === 401 && !new URL(url, "https://vanr.invalid").pathname.startsWith(AUTH_PREFIX)) {
      onUnauthorized();
    }
    return response;
  };
}

export function createWebApi(
  wire: WebTransport,
  options: { onUnauthorized: () => void; clock?: Clock },
): WebApi {
  const watched: WebTransport = { ...wire, fetch: watchSession(wire.fetch, options.onUnauthorized) };
  return {
    client: createClient({
      baseUrl: watched.baseUrl,
      fetch: watched.fetch,
      headers: watched.headers,
      ...(options.clock !== undefined && { clock: options.clock }),
    }),
    auth: createAuthApi(watched),
  };
}
