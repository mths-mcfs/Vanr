// Issues and memory consolidations at the same time on a real Postgres. The server's pool runs transactions on
// several connections, so what keeps the workspace's issue numbers one after another is the workspace's lock
// (pg_advisory_xact_lock), what keeps each change of an issue compared with the one before is the issue's row
// lock, and what keeps a consolidation applied once is its row lock.
//
// The "forced" tests don't count on the scheduler: the database double of lock-double.ts holds the first
// transaction at the point where the lock matters until the second one is seen waiting on a lock or done. With
// VANR_TEST_DROP_LOCKS=1 the same double leaves the locks out: the CI postgres job runs that mode too and expects
// these tests to fail on their outcome (LOCK_OUTCOME_MISMATCH), which proves they catch a missing lock.
// These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { contentSha256 } from "@vanr/engine/memory";
import { and, asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { createMemory } from "../src/agent-memory";
import type { AppDeps } from "../src/context";
import { isUniqueViolation } from "../src/db-errors";
import { HttpError } from "../src/http";
import { columnsOf, createIssue, updateIssue } from "../src/issues";
import { applyConsolidation } from "../src/memory-consolidation";
import type { RunningServer } from "../src/server";
import { signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 20;

async function withServer(
  prefix: string,
  run: (
    server: RunningServer,
    admin: postgres.Sql,
    ctx: { workspaceId: string; userId: string },
  ) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({ env: { DATABASE_URL: url } });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const ana = await signedIn(server, "Ana", `ana@${prefix.replaceAll("_", "-")}.test`);
    const { workspaceId } = await seedWorkspace(server, ana, "Board");
    // The board's columns exist before the race: only the transaction under test runs inside it.
    await columnsOf(server.deps.db, workspaceId);
    await run(server, admin, { workspaceId, userId: ana.user.id });
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

const withDb = (deps: AppDeps, hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
  ...deps,
  db: instrumented(deps.db, hooks),
});

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("issues and consolidations at once on Postgres"), () => {
  test("N issues created at once get the numbers 1 to N", async () => {
    await withServer("iss_n", async (server, _admin, { workspaceId, userId }) => {
      const rows = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          createIssue(server.deps, {
            workspaceId,
            title: `Issue ${i}`,
            author: { type: "person", id: userId },
          }),
        ),
      );
      expect(rows.map((r) => r.number).sort((a, b) => a - b)).toEqual(
        Array.from({ length: N }, (_, i) => i + 1),
      );
      expect(new Set(rows.map((r) => r.boardPosition)).size).toBe(N);
    });
  }, 60_000);

  test("forced: the second creation waits on the workspace's number lock, so the numbers follow each other", async () => {
    await withServer("iss_num", async (server, admin, { workspaceId, userId }) => {
      // A holds right after reading the highest number. With the lock B waits for A; without it, B reads the
      // same number, inserts first, and A's insert hits the unique index.
      const run = await forcedPair(admin, "issue-number", "select", (side, hooks) =>
        createIssue(withDb(server.deps, hooks), {
          workspaceId,
          title: side,
          author: { type: "person", id: userId },
        }).then(
          (row) => `${side}:${row.number}`,
          (err: unknown) => {
            if (isUniqueViolation(err)) return `${side}:duplicate`;
            throw err;
          },
        ),
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      outcome("issue-number", [run.a, run.b], ["A:1", "B:2"]);
      expect([run.a, run.b]).toEqual(["A:1", "B:2"]);
    });
  }, 60_000);

  test("forced: the second change of one issue waits on its row lock, so each move starts where the other ended", async () => {
    await withServer("iss_move", async (server, admin, { workspaceId, userId }) => {
      const cols = await columnsOf(server.deps.db, workspaceId);
      const stage = (s: string) => cols.find((c) => c.stage === s)?.id ?? "";
      const by = { type: "person" as const, id: userId };
      const row = await createIssue(server.deps, { workspaceId, title: "Moved twice", author: by });
      // A holds right after reading the issue under its lock. With the lock B reads it after A's move; without
      // it, B reads it still in "todo" and logs a move from there.
      const run = await forcedPair(admin, "issue-move", "select", (side, hooks) =>
        updateIssue(
          withDb(server.deps, hooks),
          row,
          { columnId: stage(side === "A" ? "in_progress" : "done") },
          by,
        ),
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      const moves = await server.deps.db
        .select()
        .from(schema.issueTimeline)
        .where(and(eq(schema.issueTimeline.issueId, row.id), eq(schema.issueTimeline.event, "status")))
        .orderBy(asc(schema.issueTimeline.seq));
      // Postgres keeps jsonb keys in its own order: the moves are compared as text.
      const got = moves.map((m) => `${m.textVars?.from}->${m.textVars?.to}`);
      const want = ["todo->in_progress", "in_progress->done"];
      outcome("issue-move", got, want);
      expect(got).toEqual(want);
    });
  }, 60_000);

  test("forced: two issues moved to the top of one column at once wait on the board's lock and get different positions", async () => {
    await withServer("iss_place", async (server, admin, { workspaceId, userId }) => {
      const cols = await columnsOf(server.deps.db, workspaceId);
      const done = cols.find((c) => c.stage === "done")?.id ?? "";
      const by = { type: "person" as const, id: userId };
      await createIssue(server.deps, { workspaceId, title: "Already there", columnId: done, author: by });
      const p = await createIssue(server.deps, { workspaceId, title: "P", author: by });
      const q = await createIssue(server.deps, { workspaceId, title: "Q", author: by });
      // A holds right after writing its issue's new position. With the lock B waits for A and goes above it;
      // without it, B reads the column without A's card and takes the same position.
      const run = await forcedPair(admin, "issue-place", "update", (side, hooks) =>
        updateIssue(withDb(server.deps, hooks), side === "A" ? p : q, { columnId: done }, by),
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      const rows = await server.deps.db
        .select({ title: schema.issues.title, position: schema.issues.boardPosition })
        .from(schema.issues)
        .where(eq(schema.issues.columnId, done))
        .orderBy(asc(schema.issues.boardPosition));
      const got = { distinct: new Set(rows.map((r) => r.position)).size, order: rows.map((r) => r.title) };
      const want = { distinct: 3, order: ["Q", "P", "Already there"] };
      outcome("issue-place", got, want);
      expect(got).toEqual(want);
    });
  }, 60_000);

  test("forced: the second apply of one consolidation waits on its lock and finds it applied", async () => {
    await withServer("mcn_apply", async (server, admin, { workspaceId, userId }) => {
      const { db } = server.deps;
      const [agent] = await db
        .insert(schema.agents)
        .values({
          id: newId("agt"),
          workspaceId,
          name: "Lia",
          handle: "lia",
          role: "support",
          instructions: "",
          model: "claude-haiku-5-5",
          ownerUserId: userId,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        })
        .returning();
      if (!agent) throw new Error("no agent");
      const author = { type: "person" as const, id: userId };
      const remember = (text: string) =>
        createMemory(
          db,
          server.deps.now(),
          {
            workspaceId,
            agentId: agent.id,
            scope: "agent",
            text,
            kind: "fact",
            source: "manual",
            origin: { by: author, name: null, channel: null, at: server.deps.now().toISOString() },
          },
          { author },
        );
      const a = await remember("Opens at 9");
      const b = await remember("opens at 9");
      const [row] = await db
        .insert(schema.memoryConsolidations)
        .values({
          id: newId("mcn"),
          workspaceId,
          agentId: agent.id,
          status: "ready",
          items: [
            {
              action: "merge",
              sources: [a.id, b.id],
              path: null,
              text: "Opens at 9.",
              reason: "",
              untrustedSource: false,
            },
          ],
          bases: { [a.id]: contentSha256(a.text), [b.id]: contentSha256(b.text) },
          covered: 2,
          total: 2,
        })
        .returning();
      if (!row) throw new Error("no consolidation");
      const me = { workspaceId, userId, role: "owner" as const, handle: "ana" };
      // A holds right after its first update (the items it read are archived and the merged one is written).
      // With the lock B waits for the consolidation and finds it applied; without it, B reads it still ready,
      // waits only on the items' row locks and merges them a second time.
      const run = await forcedPair(admin, "consolidation-apply", "update", (_side, hooks) =>
        applyConsolidation(withDb(server.deps, hooks), me, agent, row.id).then(
          (r) => r.status,
          (err: unknown) => {
            if (err instanceof HttpError) return err.code;
            throw err;
          },
        ),
      );
      expect(run.aPids[0]).not.toBe(run.bPids[0]);
      const merged = await db
        .select()
        .from(schema.memories)
        .where(and(eq(schema.memories.agentId, agent.id), eq(schema.memories.source, "consolidation")));
      const got = { a: run.a, b: run.b, merged: merged.length };
      const want = { a: "applied", b: "memory_consolidation.closed", merged: 1 };
      outcome("consolidation-apply", got, want);
      expect(got).toEqual(want);
    });
  }, 60_000);
});
