import { join } from "node:path";
import { diskBlobs, memoryBlobs } from "@vanr/engine/blobs";
import { openDb, schema } from "@vanr/engine/db";
import { PRICES } from "@vanr/engine/models/prices";
import { createSealer } from "@vanr/engine/seal";
import { postgresConnector, type SqlConnector } from "@vanr/engine/sqlconn";
import { count } from "drizzle-orm";
import { createApp } from "./app";
import { createAuth } from "./auth";
import type { Config } from "./config";
import type { AppDeps } from "./context";
import { holdInstanceLock } from "./instance-lock";
import { guardedFetch } from "./integrations/net";
import { log } from "./logger";
import { createMailer, type Mailer } from "./mailer";
import { loadVapid, webPushSender } from "./push";
import { Hub } from "./realtime/hub";
import { RunnerHub } from "./runners/hub";
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
  /** The single-instance lock's connection dropped with the server up (index.ts ends the process). */
  onInstanceLockLost?: () => void;
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
  // Single instance on Postgres: the lock comes before the migration and before runtime.start(), which
  // marks every active run in the database as failed. On PGlite the database belongs to the process.
  const lock =
    config.db.kind === "postgres"
      ? await holdInstanceLock(
          config.db.url,
          opts.onInstanceLockLost ?? (() => log.error("server.instance_lock_lost")),
        )
      : null;
  if (lock) undo.push(() => lock.release());
  const opened = await openDb(config.db);
  undo.push(() => opened.close());
  const mailer = createMailer(config.mail, opts.memoryMail);
  const hub = new Hub();
  let handler: (req: Request) => Response | Promise<Response> = () =>
    new Response("starting", { status: 503 });

  const runnersHub = new RunnerHub();
  // Slice S3 (wiki-collab) adds here the wiki editor (wikiMarkdown) and the live wiki sessions.

  const server = Bun.serve({
    port: config.port,
    fetch(req) {
      // Slice S2 (realtime/browser-socket, runners/socket) and S3 (wiki-collab) add here the WebSocket
      // upgrades of /api/v1/realtime, /api/v1/runners/connect and /api/v1/wiki/collab, and their handlers.
      return handler(req);
    },
  });
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
  // Closed sign-up still accepts the installation's first user and whoever has a pending invite.
  const signupAllowed = async (email: string, headers: Headers | null) => {
    if (effective.signupOpen) return true;
    const [row] = await db.select({ n: count() }).from(schema.users);
    if ((row?.n ?? 0) === 0) return true;
    return hasPendingInvite(email, headers);
  };
  const origins = [publicUrl, ...(opts.extraOrigins ?? [])];
  const auth = createAuth({ db, config: effective, mailer, trustedOrigins: origins, signupAllowed });
  // Slice S6 (runtime/runtime) creates the AgentRuntime here (it reads the deps when used).
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
    push: webPushSender(await loadVapid(effective), opts.fetchExternal ?? fetch),
    // Slice S6 (runtime/runtime) adds `runtime` and `testModelFor`, S3 (wiki-collab) adds `wikiLive` and
    // S5 (assignments/motor, assignments/verify) adds `assignmentEngine` and `assignmentVerifier`.
  };
  // Here, in this order: the undo of stopRecalcs (S2, bases/write), runtime.stop (S6) and the assignment
  // engine's stop (S5); the provider lookup (S6); search.ensureVector (S2, search-index); runtime.start (S6),
  // the engine's start (S5) and resumeRecalcs (S2), all before the app takes requests.
  const app = createApp(deps);
  handler = (req) => app.fetch(req);
  log.info("server.started", { url: publicUrl, db: opened.kind });

  return {
    url: publicUrl,
    port,
    deps,
    mailer,
    routes: app.routes.map((r) => ({ method: r.method, path: r.path })),
    stop: () => undoAll(undo),
  };
}

/**
 * Pending invite by email or by the cookie the invite page leaves. The invitations slice replaces this with
 * `hasPendingInvite` from routes/invitations; until then nobody has an invite.
 */
async function hasPendingInvite(_email: string, _headers: Headers | null): Promise<boolean> {
  return false;
}
