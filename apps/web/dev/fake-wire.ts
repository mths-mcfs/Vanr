// Ways for the web to reach the fake server without a network: a fetch function, a transport that
// skips HTTP altogether, and a socket opener. Each "browser" has its own cookie jar.
import { errorFromResponse, unreachable } from "../src/api/error.ts";
import type { FetchLike, Transport } from "../src/api/transport.ts";
import type { SocketOpener } from "../src/realtime/connection.ts";
import { FakeOffline, type FakeResponse, type FakeServer } from "./fake-server.ts";

/** The session cookie of one browser. */
export type CookieJar = { session: string | undefined };

export const newJar = (): CookieJar => ({ session: undefined });

function keepSession(jar: CookieJar, response: FakeResponse): void {
  if (response.setSession === undefined) return;
  jar.session = response.setSession ?? undefined;
}

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `fetch` answered by the fake server: real Request and Response shapes, JSON text on the wire. */
export function fakeFetch(server: FakeServer, jar: CookieJar): FetchLike {
  return async (input, init) => {
    const url = new URL(input, "http://vanr.test");
    const verb = VERBS.find((candidate) => candidate === init.method);
    if (verb === undefined) throw new TypeError(`fake fetch: unsupported method ${init.method}`);
    let body: unknown;
    if (typeof init.body === "string" && init.body !== "") body = JSON.parse(init.body);
    let response: FakeResponse;
    try {
      response = await server.handle({
        verb,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        session: jar.session,
      });
    } catch (cause) {
      // What fetch does when the network is down.
      if (cause instanceof FakeOffline) throw new TypeError("Failed to fetch");
      throw cause;
    }
    keepSession(jar, response);
    const headers = new Headers({ "content-type": "application/json" });
    if (response.retryAfter !== undefined) headers.set("retry-after", String(response.retryAfter));
    const noBody = response.status === 204 || response.body === null;
    return new Response(noBody ? null : JSON.stringify(response.body), { status: response.status, headers });
  };
}

/**
 * A second transport behind the same Api: it hands the request to the server as objects, with no
 * HTTP, no JSON text and no Response. It stands for any wire that is not the web's own fetch.
 */
export function directTransport(server: FakeServer, jar: CookieJar): Transport {
  return {
    async request({ verb, path, query, body }) {
      let response: FakeResponse;
      try {
        response = await server.handle({
          verb,
          path,
          ...(query !== undefined && { query }),
          body,
          session: jar.session,
        });
      } catch (cause) {
        if (cause instanceof FakeOffline) throw unreachable();
        throw cause;
      }
      keepSession(jar, response);
      if (response.status >= 400) {
        throw errorFromResponse({
          status: response.status,
          body: response.body,
          retryAfter: response.retryAfter === undefined ? null : String(response.retryAfter),
        });
      }
      return response.body;
    },
  };
}

/** Sockets answered by the fake server, with the browser's session. */
export function fakeSocketOpener(server: FakeServer, jar: CookieJar): SocketOpener {
  return (workspaceId, handlers) => server.connect(workspaceId, jar.session, handlers);
}
