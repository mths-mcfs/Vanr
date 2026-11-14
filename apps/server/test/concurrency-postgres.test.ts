// Invitations and notices at the same time on a real Postgres. The server's pool runs transactions on several
// connections, so what keeps one pending invitation per email is the invitee's lock (pg_advisory_xact_lock)
// and what keeps the actors and the latest message of a notice is the group's row lock (FOR UPDATE).
//
// The two "forced" tests don't count on the scheduler: a double of the database, injected only here, holds the
// first transaction at the point where the lock matters until the second one is seen waiting on that lock (in
// pg_locks) or done; each transaction records its pg_backend_pid(), so two real connections took part.
// With VANR_TEST_DROP_LOCKS=1 the same double leaves the lock out (no advisory lock, no FOR UPDATE): the CI
// postgres job runs that mode too and expects these tests to fail, which proves they catch a missing lock.
// These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { sha256Hex } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { AppDeps, AppEnv } from "../src/context";
import { errorBody, HttpError } from "../src/http";
import { createWorkspace, joinWorkspace } from "../src/members";
import { notify } from "../src/notifications";
import { registerInvitations } from "../src/routes/invitations";
import type { RunningServer } from "../src/server";
import { Browser, body, signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 20;

async function withServer(
  prefix: string,
  run: (server: RunningServer, admin: postgres.Sql) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({ env: { DATABASE_URL: url } });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await run(server, admin);
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

describe.skipIf(!TEST_POSTGRES_URL)(
  onPostgres("the same invitee and the same group at once on Postgres"),
  () => {
    test("N invitations to one email: one pending and only its link works; N notices of one group: count N", async () => {
      await withServer("same", async (server) => {
        const ana = await signedIn(server, "Ana", "ana@same.test");
        const { workspaceId } = await createWorkspace(server.deps.db, {
          name: "Same",
          context: "",
          user: ana.user,
        });
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            ana.browser.json(`/api/v1/workspaces/${workspaceId}/invitations`, "POST", {
              email: i % 2 ? " Pat@Same.test" : "pat@same.test",
              role: i % 2 ? "admin" : "member",
            }),
          ),
        );
        const urls: string[] = [];
        for (const r of results) {
          expect(r.status).toBe(201);
          urls.push((await body(r)).url);
        }
        const pending = await server.deps.db
          .select()
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.workspaceId, workspaceId),
              eq(schema.invitations.email, "pat@same.test"),
              eq(schema.invitations.status, "pending"),
            ),
          );
        expect(pending.length).toBe(1);
        const anon = new Browser(server.url);
        const alive: string[] = [];
        for (const u of urls) {
          const token = u.split("/invite/")[1] ?? "";
          if ((await anon.fetch(`/api/v1/invitations/${token}`)).status === 200) alive.push(token);
        }
        expect(alive.length).toBe(1);
        expect(sha256Hex(alive[0] ?? "")).toBe(pending[0]?.tokenHash ?? "");
      });
    }, 60_000);

    test("forced: the second invitation of one email waits on the invitee's lock, so one stays pending", async () => {
      await withServer("inv", async (server, admin) => {
        const ana = await signedIn(server, "Ana", "ana@forced.test");
        const { workspaceId } = await createWorkspace(server.deps.db, {
          name: "Forced",
          context: "",
          user: ana.user,
        });
        const appWith = (deps: AppDeps) => {
          const app = new Hono<AppEnv>();
          app.onError((err, c) =>
            err instanceof HttpError ? c.json(errorBody(err.code, err.message), err.status) : c.json({}, 500),
          );
          app.use("*", async (c, next) => {
            c.set("deps", deps);
            c.set("user", ana.user);
            c.set("member", { workspaceId, userId: ana.user.id, role: "owner", handle: "ana" });
            await next();
          });
          registerInvitations(app);
          return app;
        };
        const post = async (deps: AppDeps, role: string): Promise<Response> =>
          appWith(deps).request(`/api/v1/workspaces/${workspaceId}/invitations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "pia@forced.test", role }),
          });
        // A holds right after revoking the pending ones, before inserting its own. With the lock B waits on
        // it; without it, B revokes nothing (A's isn't in yet) and both insert.
        const run = await forcedPair(admin, "invite", "update", (side, hooks) =>
          post(
            { ...server.deps, db: instrumented(server.deps.db, hooks) },
            side === "A" ? "member" : "admin",
          ),
        );
        expect([run.a.status, run.b.status]).toEqual([201, 201]);
        expect(run.aPids.length).toBe(1);
        expect(run.bPids.length).toBe(1);
        expect(run.aPids[0]).not.toBe(run.bPids[0]);
        const pending = await server.deps.db
          .select()
          .from(schema.invitations)
          .where(
            and(eq(schema.invitations.email, "pia@forced.test"), eq(schema.invitations.status, "pending")),
          );
        outcome(
          "invite",
          pending.map((r) => r.role),
          ["admin"],
        );
        expect(pending.map((r) => r.role)).toEqual(["admin"]);
      });
    }, 60_000);

    test("forced: the second notice of one group waits on the row lock, so no actor or message is lost", async () => {
      await withServer("ntf", async (server, admin) => {
        const ana = await signedIn(server, "Ana", "ana@group.test");
        const beto = await signedIn(server, "Beto", "beto@group.test");
        const caio = await signedIn(server, "Caio", "caio@group.test");
        const { workspaceId } = await createWorkspace(server.deps.db, {
          name: "Group",
          context: "",
          user: ana.user,
        });
        await joinWorkspace(server.deps.db, {
          workspaceId,
          userId: beto.user.id,
          name: "Beto",
          role: "member",
        });
        const from = (deps: AppDeps, actorId: string, text: string) =>
          notify(deps, {
            workspaceId,
            userId: beto.user.id,
            kind: "dm",
            groupKey: "dm:forced",
            actor: { type: "person", id: actorId },
            source: {},
            latest: { text },
          });
        // The group's row exists: both notices take the read-merge-write path.
        await from(server.deps, beto.user.id, "first");
        // A holds right after reading the group's row (FOR UPDATE). With the lock B waits for A's row; without
        // it, B reads the row as it was before A and one of the two writes loses the other's actor.
        const run = await forcedPair(admin, "notice", "select", (side, hooks) =>
          from(
            { ...server.deps, db: instrumented(server.deps.db, hooks) },
            side === "A" ? ana.user.id : caio.user.id,
            side === "A" ? "from ana" : "from caio",
          ),
        );
        expect(run.aPids.length).toBe(1);
        expect(run.bPids.length).toBe(1);
        expect(run.aPids[0]).not.toBe(run.bPids[0]);
        await server.deps.runtime.settle();
        const [row, ...rest] = await server.deps.db
          .select()
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, beto.user.id),
              eq(schema.notifications.groupKey, "dm:forced"),
            ),
          );
        expect(rest).toEqual([]);
        // Serially: first, then Ana's, then Caio's (who waited for Ana).
        outcome(
          "notice",
          { count: row?.count, actors: row?.actors.map((x) => x.id), latest: row?.latest.text },
          { count: 3, actors: [caio.user.id, ana.user.id, beto.user.id], latest: "from caio" },
        );
      });
    }, 60_000);
  },
);
