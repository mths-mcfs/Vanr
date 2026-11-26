import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./context";
import { errorBody, HttpError } from "./http";
import { log } from "./logger";
import { registerAccount } from "./routes/account";
import { registerBases } from "./routes/bases";
import { registerDrive } from "./routes/drive";
import { registerDriveUploads } from "./routes/drive-upload";
import { registerInvitations } from "./routes/invitations";
import { registerMemories } from "./routes/memories";
import { registerNotifications } from "./routes/notifications";
import { registerPush } from "./routes/push";
import { registerRunnerRequests } from "./routes/runner-requests";
import { registerRunners } from "./routes/runners";
import { registerSearch } from "./routes/search";
import { registerThreads } from "./routes/threads";
import { registerWaitlist } from "./routes/waitlist";
import { registerWiki } from "./routes/wiki";
import { type FirstUserPlace, type SignupQueueLimits, signupGate } from "./signup-queue";
import { createStatic } from "./static";
import { registerWorkspaceScope } from "./workspace-scope";

/** Paths that accept multipart (a file upload to the Drive). Every other write is JSON only. */
const MULTIPART = [/\/files\/files$/, /\/files\/[^/]+\/files$/, /\/wiki\/import\/vault$/];
/**
 * Auth paths whose request may create a user: email sign-up, social sign-in with an ID token and the OAuth
 * callbacks (the first social login creates the user).
 */
const CREATES_USER = /^\/api\/auth\/(sign-up\/|sign-in\/social$|callback\/|oauth2\/callback\/)/;
/** A part of a chunked upload: raw bytes. A form from another site doesn't send that type without a preflight. */
const RAW_PART = /\/files\/uploads\/[^/]+$/;

export function createApp(
  deps: AppDeps,
  opts: { firstUser: FirstUserPlace; signupQueue: SignupQueueLimits },
) {
  const app = new Hono<AppEnv>();
  const serveStatic = createStatic(deps.config.webDist);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message, err.params), err.status);
    log.error("request.failed", { path: c.req.path, method: c.req.method, err });
    return c.json(errorBody("internal", "Internal error"), 500);
  });

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("user", null);
    c.set("sessionId", null);
    c.set("member", null);
    await next();
  });

  // Better Auth answers at /api/auth/* in its own format. With closed sign-up, the requests that may
  // create a user pass the sign-up gate (signup-queue.ts): on a new installation, deciding that a person is
  // the first user and creating them is one step. With open sign-up, and for a sign-in, nothing waits.
  const gate = signupGate(deps, opts.signupQueue, opts.firstUser);
  app.on(["GET", "POST"], "/api/auth/*", (c) =>
    !deps.config.signupOpen && CREATES_USER.test(c.req.path) ? gate(c.req.raw) : deps.auth.handler(c.req.raw),
  );

  app.get("/api/v1/health", async (c) => {
    let database = "ok";
    try {
      await deps.db.execute(sql`select 1`);
    } catch {
      database = "error";
    }
    return c.json({
      status: "ok",
      version: deps.config.version,
      edition: deps.config.edition,
      database,
      modules: [],
      // A first user's INSERT that the database hasn't answered for too long holds sign-up closed.
      signup: opts.firstUser.health(opts.signupQueue.stuckInsertMs),
    });
  });

  // Writes are JSON only: a form from another site cannot send application/json (CSRF).
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const type = c.req.header("content-type") ?? "";
      const multipartOk =
        MULTIPART.some((re) => re.test(c.req.path)) && type.startsWith("multipart/form-data");
      const rawOk =
        method === "PUT" && RAW_PART.test(c.req.path) && type.startsWith("application/octet-stream");
      if (
        !type.startsWith("application/json") &&
        !multipartOk &&
        !rawOk &&
        !c.req.path.startsWith("/api/auth/")
      ) {
        return c.json(errorBody("unsupported_media_type", "Send JSON (application/json)"), 415);
      }
    }
    await next();
  });

  // Better Auth's session (cookie). App routes that require a login call requireUser.
  app.use("/api/v1/*", async (c, next) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      c.set("sessionId", session.session.id);
      const u = session.user;
      c.set("user", { id: u.id, name: u.name, email: u.email, image: u.image ?? null });
    }
    await next();
  });

  registerWorkspaceScope(app);
  registerWaitlist(app);
  registerAccount(app);
  // The remaining registrars enter here, in this order, each with the slice that ports it (S2 to S6 of the
  // server port): workspaces S4, chat S6, then the threads and memories below; agents S5, agent lab S5,
  // skills S4, control S5, then invitations, notifications and push below, then the Drive, the wiki and the
  // bases below; issues S4, debates S4, routines S4, calendar S4, then the search below; connectors S6,
  // integrations S5, then the runners and their requests below; assignments S5.
  registerThreads(app);
  registerMemories(app);
  registerInvitations(app);
  registerNotifications(app);
  registerPush(app);
  registerDriveUploads(app);
  registerDrive(app);
  registerWiki(app);
  registerBases(app);
  registerSearch(app);
  registerRunners(app);
  registerRunnerRequests(app);

  app.all("/api/*", (c) =>
    c.json(errorBody("route_not_found", `No route for ${c.req.method} ${c.req.path}`), 404),
  );
  app.get("*", (c) => serveStatic(c.req.path));

  return app;
}
