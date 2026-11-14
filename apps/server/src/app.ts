import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./context";
import { errorBody, HttpError } from "./http";
import { log } from "./logger";
import { registerAccount } from "./routes/account";
import { registerWaitlist } from "./routes/waitlist";
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

export function createApp(deps: AppDeps) {
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
    c.set("member", null);
    await next();
  });

  // Better Auth answers at /api/auth/* in its own format. With closed sign-up, deciding whether a new
  // user may enter (the first user of the installation) and creating it are one step: the requests that
  // may create a user go one at a time. The server is a single instance per database (the boot's lock),
  // so a queue in the process is enough. With open sign-up nothing waits.
  const oneAtATime = queueOfOne();
  app.on(["GET", "POST"], "/api/auth/*", (c) =>
    !deps.config.signupOpen && CREATES_USER.test(c.req.path)
      ? oneAtATime(() => deps.auth.handler(c.req.raw))
      : deps.auth.handler(c.req.raw),
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
      const u = session.user;
      c.set("user", { id: u.id, name: u.name, email: u.email, image: u.image ?? null });
    }
    await next();
  });

  registerWorkspaceScope(app);
  registerWaitlist(app);
  registerAccount(app);
  // The remaining registrars enter here, in this order, each with the slice that ports it (S2 to S6 of the
  // server port): workspaces S4, chat S6, threads S3, agents S5, agent lab S5, skills S4, memories S3,
  // control S5, invitations S2, notifications S2, push S2, drive uploads S3, drive S2, wiki S4, bases S3,
  // issues S4, debates S4, routines S4, calendar S4, search S2, connectors S6, integrations S5, runners S2,
  // runner pairings S3, assignments S5.

  app.all("/api/*", (c) =>
    c.json(errorBody("route_not_found", `No route for ${c.req.method} ${c.req.path}`), 404),
  );
  app.get("*", (c) => serveStatic(c.req.path));

  return app;
}

/** Runs the tasks one after the other, in arrival order; a task that fails doesn't stop the next. */
function queueOfOne() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
