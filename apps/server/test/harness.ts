import type { Me } from "@vanr/contract";
import type { SqlConnector } from "@vanr/engine/sqlconn";
import { loadConfig } from "../src/config";
import { type BootSteps, type RunningServer, startServer } from "../src/server";
import type { SignupQueueLimits } from "../src/signup-queue";

// Later slices add here what they unlock: the real Postgres option (`postgres`, S2), the assignment engine
// and the model provider options (S5, S6), the typed API client (`apiFor`, `apiError`, `memberOf`,
// `toolResults`, with the client package) and the browser WebSocket (`TestSocket`, S2).

export interface TestServerOptions {
  /** Shorter limits for the closed sign-up queue. */
  signupQueue?: Partial<SignupQueueLimits>;
  fileServicesMs?: number;
  /** Replaces a boot step that touches the outside (see `BootSteps`). */
  steps?: Partial<BootSteps>;
  env?: Record<string, string>;
  now?: () => Date;
  fetchExternal?: typeof fetch;
  sql?: SqlConnector;
  /** No forcing of the fake provider: the production rule of the lookup applies (production tests). */
  realModels?: boolean;
  /** The live wiki: the quiet before the draft publishes itself and the autosave debounce. */
  wikiIdlePublishMs?: number;
  wikiDebounceMs?: number;
  /** The inactivity limit of every request, in seconds (Bun's default is 10). */
  idleTimeoutSeconds?: number;
}

/**
 * Timeout of every test that starts or stops a server: the boot opens and migrates a PGlite (seconds on a
 * busy CI host), more than bun's 5 s default allows.
 */
export const SERVER_TEST_MS = 30_000;

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
    forceFakeModels: opts.realModels !== true,
    steps: opts.steps,
    signupQueue: opts.signupQueue,
    wikiIdlePublishMs: opts.wikiIdlePublishMs,
    wikiDebounceMs: opts.wikiDebounceMs,
    idleTimeoutSeconds: opts.idleTimeoutSeconds,
    fileServicesMs: opts.fileServicesMs,
  });
}

/**
 * Holds the next write to the search index until `release`: `begun` resolves once it started. It is the
 * window of a slow save, to race it against another write (the trash, a person typing).
 */
export function holdNextIndexWrite(server: RunningServer): { begun: Promise<void>; release: () => void } {
  const index = server.deps.search;
  const withDb = index.withDb.bind(index);
  let started!: () => void;
  let release!: () => void;
  const begun = new Promise<void>((r) => {
    started = r;
  });
  const until = new Promise<void>((r) => {
    release = r;
  });
  index.withDb = (db) => {
    const inner = withDb(db);
    const upsert = inner.upsert.bind(inner);
    inner.upsert = async (source, chunks) => {
      index.withDb = withDb;
      started();
      await until;
      return upsert(source, chunks);
    };
    return inner;
  };
  return { begun, release };
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

/** Waits until the server's background work ended (the notification queue and, later, runs and routines). */
export function settle(server: RunningServer): Promise<void> {
  return server.deps.runtime.settle();
}

/** Waits for an observable effect of the server's periodic work. */
export async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("server work did not finish");
    await Bun.sleep(20);
  }
}
