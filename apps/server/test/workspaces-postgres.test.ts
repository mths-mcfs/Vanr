// A workspace's owners on a real Postgres. The server's pool runs transactions on several connections, so what
// keeps a workspace from losing its last owner, when two owners demote each other or leave at once, is the lock
// on the workspace row that every role change and removal takes before it reads the roles and counts the owners.
//
// The "forced" tests don't count on the scheduler: the database double of lock-double.ts holds the first
// transaction right after it counted the other owners until the second one is seen waiting on a lock or done.
// With VANR_TEST_DROP_LOCKS=1 the same double leaves the lock out: the CI postgres job runs that mode too and
// expects these tests to fail on their outcome (LOCK_OUTCOME_MISMATCH), which proves they catch a missing lock.
// These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { HttpError } from "../src/http";
import { changeRole, createWorkspace, joinWorkspace, removeMember } from "../src/members";
import type { RunningServer } from "../src/server";
import { signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

/** A workspace with two owners, Ana and Bia. */
async function withTwoOwners(
  prefix: string,
  run: (
    server: RunningServer,
    admin: postgres.Sql,
    ids: { workspaceId: string; ana: string; bia: string },
  ) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({ env: { DATABASE_URL: url } });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const domain = `${prefix.replaceAll("_", "-")}.test`;
    const ana = await signedIn(server, "Ana", `ana@${domain}`);
    const bia = await signedIn(server, "Bia", `bia@${domain}`);
    const { workspaceId } = await createWorkspace(server.deps.db, {
      name: "Owners",
      context: "",
      user: ana.user,
    });
    await joinWorkspace(server.deps.db, { workspaceId, userId: bia.user.id, name: "Bia", role: "owner" });
    await run(server, admin, { workspaceId, ana: ana.user.id, bia: bia.user.id });
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

/** `A:ok`, or the side and the HTTP status and code it got. */
const result = (side: string, p: Promise<void>) =>
  p.then(
    () => `${side}:ok`,
    (err: unknown) => {
      if (err instanceof HttpError) return `${side}:${err.status} ${err.code}`;
      throw err;
    },
  );

async function owners(server: RunningServer, workspaceId: string) {
  const rows = await server.deps.db
    .select({ userId: schema.members.userId })
    .from(schema.members)
    .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.role, "owner")));
  return rows.length;
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("a workspace's last owner on Postgres"), () => {
  test("N owners demoting each other at once: one owner always stays", async () => {
    await withTwoOwners("own_many", async (server, _admin, { workspaceId, ana, bia }) => {
      const { db } = server.deps;
      const outs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          result(
            String(i),
            i % 2
              ? changeRole(db, { workspaceId, actorId: ana, target: bia, role: "member" })
              : changeRole(db, { workspaceId, actorId: bia, target: ana, role: "member" }),
          ),
        ),
      );
      expect(outs.some((o) => o.endsWith(":ok"))).toBe(true);
      expect(await owners(server, workspaceId)).toBe(1);
    });
  }, 60_000);

  test("forced: the second of two owners demoting each other waits on the workspace's lock and no longer can", async () => {
    await withTwoOwners("own_demote", async (server, admin, { workspaceId, ana, bia }) => {
      // A holds right after counting the other owners. With the lock B waits for A and then is no owner anymore;
      // without it, B counts Ana as the other owner too and both demotions go through.
      const run = await forcedPair(
        admin,
        "owner-demote",
        "select",
        (side, hooks) => {
          const db = instrumented(server.deps.db, hooks);
          return side === "A"
            ? result(side, changeRole(db, { workspaceId, actorId: ana, target: bia, role: "admin" }))
            : result(side, changeRole(db, { workspaceId, actorId: bia, target: ana, role: "admin" }));
        },
        { match: "count(" },
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      outcome("owner-demote", [run.a, run.b], ["A:ok", "B:403 forbidden"]);
      expect(await owners(server, workspaceId)).toBe(1);
    });
  }, 60_000);

  test("forced: the second of two owners leaving at once waits on the workspace's lock and is the last owner", async () => {
    await withTwoOwners("own_leave", async (server, admin, { workspaceId, ana, bia }) => {
      const run = await forcedPair(
        admin,
        "owner-leave",
        "select",
        (side, hooks) => {
          const db = instrumented(server.deps.db, hooks);
          const me = side === "A" ? ana : bia;
          return result(side, removeMember(db, { workspaceId, actorId: me, target: me }));
        },
        { match: "count(" },
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      outcome("owner-leave", [run.a, run.b], ["A:ok", "B:409 last_owner"]);
      expect(await owners(server, workspaceId)).toBe(1);
    });
  }, 60_000);
});
