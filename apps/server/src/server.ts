import { join } from "node:path";
import { diskBlobs, memoryBlobs } from "@vanr/engine/blobs";
import { openDb, schema } from "@vanr/engine/db";
import { PRICES } from "@vanr/engine/models/prices";
import { createSealer } from "@vanr/engine/seal";
import { postgresConnector, type SqlConnector } from "@vanr/engine/sqlconn";
import { count } from "drizzle-orm";
import { createApp } from "./app";
import { createAuth, type SignupDecision } from "./auth";
import type { Config } from "./config";
import { ABSENT, type AppDeps, type RuntimePort } from "./context";
import { HttpError } from "./http";
import { holdInstanceLock } from "./instance-lock";
import { guardedFetch } from "./integrations/net";
import { log } from "./logger";
import { createMailer, type Mailer } from "./mailer";
import { testModelCheck } from "./models";
import { loadVapid, webPushSender } from "./push";
import {
  browserClose,
  browserMessage,
  browserOpen,
  checkBrowserUpgrade,
  REVALIDATE_MS,
  revalidateBrowsers,
} from "./realtime/browser-socket";
import { type BrowserSocket, type BrowserSocketData, Hub } from "./realtime/hub";
import { hasPendingInvite, INVITE_COOKIE } from "./routes/invitations";
import { dropAllLiveViews } from "./runners/browser-live";
import { RunnerHub, type RunnerSocketData } from "./runners/hub";
import { runnerClose, runnerMessage, runnerOpen, runnerSocketData } from "./runners/socket";
import { BackgroundWork } from "./runtime/background";
import { FirstUserPlace, SIGNUP_QUEUE_LIMITS, type SignupQueueLimits, signupDecision } from "./signup-queue";
import { postgresLedger } from "./usage-ledger";

interface StartOptions {
  config: Config;
  /** Tests: emails only in memory. */
  memoryMail?: boolean;
  /** Extra origins Better Auth accepts (e.g. Vite in dev). */
  extraOrigins?: string[];
  now?: () => Date;
  fetchExternal?: typeof fetch;
  /** Tests: the workspaces' databases on a PGlite. */
  sql?: SqlConnector;
  /** Tests: every agent uses the fake provider, even with a credential saved. */
  forceFakeModels?: boolean;
  /** The single-instance lock's connection dropped with the server up (index.ts ends the process). */
  onInstanceLockLost?: () => void;
  /** Tests: shorter limits for the closed sign-up queue (signup-queue.ts). */
  signupQueue?: Partial<SignupQueueLimits>;
  /** Tests: replaces a step of the boot that touches the outside, to break it or hold it. */
  steps?: Partial<BootSteps>;
}

/** The boot's steps that touch the outside: the instance lock, the database and the VAPID keys. */
export interface BootSteps {
  holdInstanceLock: typeof holdInstanceLock;
  openDb: typeof openDb;
  loadVapid: typeof loadVapid;
}

export interface RunningServer {
  url: string;
  port: number;
  deps: AppDeps;
  mailer: Mailer;
  /** Registered routes (method and path), for the coverage script. */
  routes: { method: string; path: string }[];
  stop(): Promise<void>;
}

/** What undoes each resource already acquired at boot, in the order it was acquired. */
type Undo = (() => unknown)[];

/**
 * Undoes in the reverse order of acquisition. Every step runs even if an earlier one fails; the first error
 * is thrown at the end. It is the server's `stop()` and also the undo of a boot that failed halfway.
 */
async function undoAll(undo: Undo): Promise<void> {
  let first: { err: unknown } | null = null;
  for (const step of undo.splice(0).reverse()) {
    try {
      await step();
    } catch (err) {
      first ??= { err };
    }
  }
  if (first) throw first.err;
}

/**
 * Starts the server. If a step fails halfway (port in use, migration, VAPID keys), what already came up is
 * undone (instance lock, database, listener) and the original error is the one thrown.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const undo: Undo = [];
  try {
    return await boot(opts, undo);
  } catch (err) {
    await undoAll(undo).catch((cleanupErr: unknown) =>
      log.error("server.boot_cleanup_failed", { err: cleanupErr }),
    );
    throw err;
  }
}

async function boot(opts: StartOptions, undo: Undo): Promise<RunningServer> {
  const { config } = opts;
  const steps: BootSteps = { holdInstanceLock, openDb, loadVapid, ...opts.steps };
  // Single instance on Postgres: the lock comes before the migration and before runtime.start(), which
  // marks every active run in the database as failed. On PGlite the database belongs to the process.
  const lock =
    config.db.kind === "postgres"
      ? await steps.holdInstanceLock(
          config.db.url,
          opts.onInstanceLockLost ?? (() => log.error("server.instance_lock_lost")),
        )
      : null;
  if (lock) undo.push(() => lock.release());
  const opened = await steps.openDb(config.db);
  undo.push(() => opened.close());
  const mailer = createMailer(config.mail, opts.memoryMail);
  const hub = new Hub();
  let handler: (req: Request) => Response | Promise<Response> = () =>
    new Response("starting", { status: 503 });

  const runnersHub = new RunnerHub();
  // Slice S3 (wiki-collab) adds here the wiki editor (wikiMarkdown) and the live wiki sessions.
  // The sockets answer only once the deps exist; until then an upgrade gets the 503 of `handler`.
  let depsRef: AppDeps | null = null;
  let origins: string[] = [];
  // Slice S3 (wiki-collab) adds CollabSocketData to the union and its upgrade and handlers below.
  type SocketData = BrowserSocketData | RunnerSocketData;
  const isRunner = (ws: Bun.ServerWebSocket<SocketData>): ws is Bun.ServerWebSocket<RunnerSocketData> =>
    ws.data.kind === "runner";
  const isBrowser = (ws: Bun.ServerWebSocket<SocketData>): ws is BrowserSocket => ws.data.kind === "browser";
  const upgradeRequired = () =>
    Response.json({ error: { code: "upgrade_required", message: "Use WebSocket" } }, { status: 426 });

  const server = Bun.serve<SocketData>({
    port: config.port,
    async fetch(req, srv) {
      const path = new URL(req.url).pathname;
      // The browser's real time: the session cookie and the origin are checked before the upgrade.
      if (depsRef && path === "/api/v1/realtime") {
        const check = await checkBrowserUpgrade(depsRef, req, origins);
        if (!check.ok) return check.response;
        if (srv.upgrade(req, { data: check.data })) return undefined;
        return upgradeRequired();
      }
      // The paired runners: the authentication is the `hello` with the session, inside the socket.
      if (depsRef && path === "/api/v1/runners/connect") {
        if (srv.upgrade(req, { data: runnerSocketData() })) return undefined;
        return upgradeRequired();
      }
      return handler(req);
    },
    websocket: {
      // The biggest frame either side may send (a runner's live view frame); each handler has its own limit.
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
        if (!depsRef) return;
        if (isRunner(ws)) runnerOpen(depsRef, ws);
        else if (isBrowser(ws)) browserOpen(depsRef, ws);
      },
      async message(ws, raw) {
        if (!depsRef) return;
        try {
          if (isRunner(ws)) await runnerMessage(depsRef, ws, raw);
          else if (isBrowser(ws)) await browserMessage(depsRef, ws, raw);
        } catch (err) {
          log.error("ws.message_failed", { err });
          if (isBrowser(ws)) ws.send(JSON.stringify({ type: "error", code: "internal" }));
        }
      },
      close(ws) {
        if (!depsRef) return;
        if (isRunner(ws)) {
          const deps = depsRef;
          void runnerClose(deps, ws).catch((err) => log.error("runner.close_failed", { err }));
        } else if (isBrowser(ws)) browserClose(depsRef, ws);
      },
    },
  });
  // After the listener in the undo (it runs before the database closes): the browsers' close handlers ran in
  // server.stop and left the live views' stop timers; they go away here.
  undo.push(() => dropAllLiveViews());
  undo.push(() => server.stop(true));
  // Before the listener in the undo (as in stop): closes the runners' connections. Before the listener is
  // up there is no connection to close. Slice S3 (wiki-collab) also saves here what the wiki held in memory.
  undo.push(() => runnersHub.closeAll());
  const port = server.port ?? config.port;
  const publicUrl = config.port === 0 ? `http://localhost:${port}` : config.publicUrl;
  const effective: Config = { ...config, port, publicUrl };

  const db = opened.db;
  const localBlobs = config.dataDir === "memory" ? memoryBlobs() : diskBlobs(join(config.dataDir, "blobs"));
  // Slice S2 (integrations/storage) wraps this in routedBlobs (Drive files go to the workspace's S3).
  const blobs = localBlobs;
  const now = opts.now ?? (() => new Date());
  // Closed sign-up still accepts the installation's first user and whoever has a pending invite. The first
  // user's place (signup-queue.ts) lets one sign-up section at a time become it; an invite doesn't need it.
  const signupLimits: SignupQueueLimits = { ...SIGNUP_QUEUE_LIMITS, ...opts.signupQueue };
  const firstUser = new FirstUserPlace(() => now().getTime());
  const signupAllowed = async (email: string, headers: Headers | null): Promise<SignupDecision> => {
    if (effective.signupOpen) return "allow";
    return signupDecision(firstUser, {
      users: async () => (await db.select({ n: count() }).from(schema.users))[0]?.n ?? 0,
      invited: () => hasPendingInvite(deps, email, readInviteCookie(headers)),
    });
  };
  // An INSERT of the first user that the database never answers holds the place: the server doesn't make
  // a way out, but it says so, once per period, and the health check reports it.
  const stopWatch = signupLimits.every(signupLimits.stuckInsertMs, () => {
    const ms = firstUser.insertingForMs();
    if (ms !== null && ms > signupLimits.stuckInsertMs)
      log.error("signup.first_user_insert_waiting", {
        waitingSeconds: Math.floor(ms / 1000),
        message:
          "The first user's account is waiting for the database to answer its INSERT; sign-up stays closed " +
          "until it does. Restarting the server releases the place.",
      });
  });
  undo.push(() => stopWatch());
  origins = [publicUrl, ...(opts.extraOrigins ?? [])];
  const auth = createAuth({
    db,
    config: effective,
    mailer,
    trustedOrigins: origins,
    signupAllowed,
    // A signed-out or revoked session closes the sockets it opened at once.
    onSessionEnded: (sessionId) => hub.dropSession(sessionId),
  });
  // Background work (the notification queue today); stopping waits for what is running. Slice S6
  // (runtime/runtime) creates the AgentRuntime here instead, which takes this work over.
  const background = new BackgroundWork();
  undo.push(() => background.stop());
  const ledger = postgresLedger(db, PRICES);
  const deps: AppDeps = {
    config: effective,
    db,
    auth,
    mailer,
    blobs,
    localBlobs,
    now,
    hub,
    ledger,
    // Slice S2 (search-index) adds `search` (createSearchIndex).
    sealer: createSealer(effective.authSecret, "credentials"),
    // Every integration fetch checks the destination (and each redirect) against the internal network.
    fetchExternal: guardedFetch(opts.fetchExternal ?? fetch, effective.integrations.allowPrivateNetworks),
    sql: opts.sql ?? postgresConnector,
    runners: runnersHub,
    // Push goes only to known push service hosts (push.ts), without redirects: it doesn't go through
    // guardedFetch, which would resolve DNS to check for a private network.
    push: webPushSender(await steps.loadVapid(effective), opts.fetchExternal ?? fetch),
    runtime: runtimePort(background),
    testModelFor: (workspaceId) => testModelCheck(deps, workspaceId, opts.forceFakeModels === true),
    // S3 (wiki-collab) adds `wikiLive` and S5 (assignments/motor, assignments/verify) adds
    // `assignmentEngine` and `assignmentVerifier`.
  };
  // Here, in this order: the undo of stopRecalcs (S2, bases/write) and of the assignment engine's stop
  // (S5); the provider lookup (S6); search.ensureVector (S2, search-index); runtime.start (S6), the
  // engine's start (S5) and resumeRecalcs (S2), all before the app takes requests.
  const app = createApp(deps, { firstUser, signupQueue: signupLimits });
  handler = (req) => app.fetch(req);
  depsRef = deps;
  // A session that expires, or a membership or channel lost outside this server's routes, is caught here.
  const sweep = setInterval(() => {
    void revalidateBrowsers(deps).catch((err) => log.warn("ws.revalidate_failed", { err }));
  }, REVALIDATE_MS);
  sweep.unref?.();
  undo.push(() => clearInterval(sweep));
  log.info("server.started", { url: publicUrl, db: opened.kind });

  // Every stop, at once or later, gets the same shutdown: it ends (or fails) once for all of them.
  let stopping: Promise<void> | null = null;
  return {
    url: publicUrl,
    port,
    deps,
    mailer,
    routes: app.routes.map((r) => ({ method: r.method, path: r.path })),
    stop: () => {
      stopping ??= undoAll(undo);
      return stopping;
    },
  };
}

/** An invitation token as the server makes them (base64url), with room to spare; anything else is not one. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The invitation token the invite page leaves in a cookie, or null. The cookie comes from outside: a value
 * that doesn't decode, is too long or isn't a token counts as absent (and is never logged).
 */
function readInviteCookie(headers: Headers | null): string | null {
  const raw = headers?.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq).trim() !== INVITE_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    return INVITE_TOKEN.test(value) ? value : null;
  }
  return null;
}

/** A runtime method the server doesn't have yet (slice S6 brings the agent runtime). */
export class NotAvailable extends HttpError {
  constructor(readonly method: keyof RuntimePort) {
    super(503, "not_available", `The agent runtime is not available yet (${method})`, { method });
    this.name = "NotAvailable";
  }
}

/**
 * The runtime port until slice S6: `track` and `settle` are the background work, and every other method is
 * declared absent (it throws `NotAvailable`, with no behavior of its own). No route of this slice reaches
 * one of them; a later route that can is rejected at its entry, before any write.
 */
function runtimePort(background: BackgroundWork): RuntimePort {
  const absent = (method: keyof RuntimePort) => {
    const fail = () => {
      throw new NotAvailable(method);
    };
    // The mark lets an entry reject before any write (requireRuntime in context.ts).
    return Object.assign(fail, { [ABSENT]: fail });
  };
  return {
    track: (work, what) => background.track(work, what),
    settle: () => background.settle(),
    complete: absent("complete"),
    runFor: absent("runFor"),
    activeRun: absent("activeRun"),
    activeRuns: absent("activeRuns"),
    liveRun: absent("liveRun"),
    liveInfo: absent("liveInfo"),
    cancel: absent("cancel"),
    onRunEnd: absent("onRunEnd"),
    onPersonMessage: absent("onPersonMessage"),
    providerForWorkspace: absent("providerForWorkspace"),
    isBusy: absent("isBusy"),
    busyAgents: absent("busyAgents"),
    awaitsApproval: absent("awaitsApproval"),
    resolveApproval: absent("resolveApproval"),
    reviseApproval: absent("reviseApproval"),
    answerQuestion: absent("answerQuestion"),
    wakeAt: absent("wakeAt"),
  };
}
