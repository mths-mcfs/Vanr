import type { Me } from "@vanr/contract";
import type { SqlConnector } from "@vanr/engine/sqlconn";
import { loadConfig } from "../src/config";
import { type RunningServer, startServer } from "../src/server";

// Later slices add here what they unlock: the real Postgres option (`postgres`, S2), the live wiki timings
// (S3), the assignment engine and the model provider options (S5, S6), the typed API client (`apiFor`,
// `apiError`, `memberOf`, `toolResults`, with the client package), the browser WebSocket (`TestSocket`, S2)
// and `holdNextIndexWrite` (search-index, S2).

export interface TestServerOptions {
  env?: Record<string, string>;
  now?: () => Date;
  fetchExternal?: typeof fetch;
  sql?: SqlConnector;
}

/** Starts the real server on a free port, with an in-memory PGlite and in-memory email. */
export async function startTestServer(opts: TestServerOptions = {}): Promise<RunningServer> {
  const config = loadConfig({
    DATA_DIR: "memory",
    PORT: "0",
    WEB_DIST: "/nonexistent",
    FAKE_MODEL_DELAY_MS: "0",
    // No undo window: email and posts go out at once (the window's test passes another value).
    UNDO_SEND_SECONDS: "0",
    ...opts.env,
  });
  return startServer({
    config,
    memoryMail: true,
    now: opts.now,
    fetchExternal: opts.fetchExternal ?? noNetwork,
    sql: opts.sql,
  });
}

/** Tests don't go out to the network: whoever needs GitHub passes a fake fetch. */
const noNetwork: typeof fetch = Object.assign(
  async () => {
    throw new Error("Network disabled in tests");
  },
  { preconnect: () => {} },
);

/** HTTP client with a cookie jar, like a browser: sends Origin and keeps the session cookie. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("origin", this.base);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(new URL(path, this.base), { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  json(path: string, method: string, body?: unknown): Promise<Response> {
    return this.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body:
        body === undefined
          ? method === "GET" || method === "DELETE"
            ? undefined
            : "{}"
          : JSON.stringify(body),
    });
  }

  async signUp(name: string, email: string, password = "strong-password-123"): Promise<Response> {
    return this.json("/api/auth/sign-up/email", "POST", { name, email, password });
  }

  async signIn(email: string, password = "strong-password-123"): Promise<Response> {
    return this.json("/api/auth/sign-in/email", "POST", { email, password });
  }
}

/** JSON body of a response, for the tests' assertions (the shape is what the test checks). */
// biome-ignore lint/suspicious/noExplicitAny: in tests the body is checked by the assertions
export async function body(res: Response): Promise<any> {
  return res.json();
}

/** Creates the account, signs in and returns the browser already with a session, and the user. */
export async function signedIn(server: RunningServer, name: string, email: string) {
  const browser = new Browser(server.url);
  const res = await browser.signUp(name, email);
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const me = await browser.fetch("/api/v1/me");
  if (!me.ok) throw new Error("no session after sign-up");
  const { user }: Me = await body(me);
  return { browser, user };
}
