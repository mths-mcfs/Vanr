// What the web talks to the server with: the shared client for every operation in the server's
// table, and the sign-in service's calls beside it. Both leave through one fetch, and that fetch is
// where the end of a session is noticed.
//
// The client is handed out one session generation at a time. Signing out, a session that ends and
// another person signing in each end the generation: every call still in flight is canceled, the
// old client rejects new calls, and the next client keeps its answers apart in the cache. An answer
// asked for by one person can therefore never reach the next.
import { type CallOptions, type Clock, createClient, type FetchLike, type VanrClient } from "@vanr/client";
import { AUTH_PREFIX, type AuthApi, createAuthApi } from "./auth.ts";
import type { WebTransport } from "./wire.ts";

export type WebApi = {
  /** The client of the open generation. Read it when calling: an earlier one rejects every call. */
  readonly client: VanrClient;
  readonly auth: AuthApi;
  /** Ends the open generation and opens the next (see the top of this file). */
  renew: () => void;
  /** Runs `listener` whenever the generation changes; the returned function stops it. */
  subscribe: (listener: () => void) => () => void;
};

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

/** The client as one generation sees it: the same calls, all canceled together when it ends. */
function openGeneration(base: VanrClient): { client: VanrClient; end: () => void } {
  const ending = new AbortController();
  const within = (options: CallOptions | undefined): CallOptions => ({
    ...options,
    signal: options?.signal === undefined ? ending.signal : AbortSignal.any([options.signal, ending.signal]),
  });
  const call: VanrClient["call"] = (method, args, options) => base.call(method, args, within(options));
  const api = new Proxy(base.api, {
    get(target, name, receiver) {
      const method: unknown = Reflect.get(target, name, receiver);
      if (typeof method !== "function") return method;
      return (args: unknown, options?: CallOptions) => method(args, within(options));
    },
  });
  const transport: VanrClient["transport"] = {
    baseUrl: base.transport.baseUrl,
    url: base.transport.url,
    call: (endpoint, args, options) => base.transport.call(endpoint, args, within(options)),
  };
  return { client: { api, transport, call }, end: () => ending.abort() };
}

export function createWebApi(
  wire: WebTransport,
  options: {
    onUnauthorized: () => void;
    /** A sign-in, sign-up or sign-out call ended without an answer: who is signed in is unknown. */
    onSessionUnknown?: () => void;
    clock?: Clock;
  },
): WebApi {
  const watched: WebTransport = { ...wire, fetch: watchSession(wire.fetch, options.onUnauthorized) };
  const base = createClient({
    baseUrl: watched.baseUrl,
    fetch: watched.fetch,
    headers: watched.headers,
    ...(options.clock !== undefined && { clock: options.clock }),
  });
  let generation = openGeneration(base);
  const listeners = new Set<() => void>();
  return {
    get client() {
      return generation.client;
    },
    auth: createAuthApi(watched, {
      ...(options.clock !== undefined && { clock: options.clock }),
      ...(options.onSessionUnknown !== undefined && { onSessionUnknown: options.onSessionUnknown }),
    }),
    renew() {
      generation.end();
      generation = openGeneration(base);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
