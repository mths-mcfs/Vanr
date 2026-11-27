// Answering a submission on a real Postgres, where the server's pool runs two people's requests on two
// connections: accepting it (which closes the assignment) and asking for changes (which sends it back to work)
// read the assignment and the submission and write both, in one transaction with the assignment's row locked.
//
// The "forced" test doesn't count on the scheduler: the database double of lock-double.ts holds the first
// transaction right after it locked the row until the second one is seen waiting on that lock. With
// VANR_TEST_DROP_LOCKS=1 the double leaves the lock out: the CI postgres job runs that mode too and expects the
// forced test to fail on its outcome, which proves it catches a missing lock. These run only there.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { type AssignmentRow, assignmentInWorkspace } from "../src/assignments/core";
import { createAssignment } from "../src/assignments/engine";
import { finishAssignment, requestSubmissionChanges } from "../src/assignments/lifecycle";
import type { AppDeps, WorkspaceMember } from "../src/context";
import { HttpError } from "../src/http";
import type { RunningServer } from "../src/server";
import { agentRuntime, passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const { assignments, assignmentSubmissions } = schema;

interface Ctx {
  ana: WorkspaceMember;
  /** A new assignment waiting on its pending submission. */
  waiting: () => Promise<{ row: AssignmentRow; submissionId: string }>;
}

async function withServer(
  prefix: string,
  run: (server: RunningServer, admin: postgres.Sql, ctx: Ctx) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({
    env: { DATABASE_URL: url },
    runtime: agentRuntime().wrap,
    assignmentVerifier: passing().verifier,
  });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tag = prefix.replaceAll("_", "-");
    const person = await signedIn(server, "Ana", `ana@${tag}.test`);
    const { workspaceId, general } = await seedWorkspace(server, person, "Answers");
    const agentId = await seedAgent(server.deps.db, workspaceId, person, null);
    const ana: WorkspaceMember = { workspaceId, userId: person.user.id, role: "owner", handle: "ana" };
    const waiting = async () => {
      const created = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: "lia",
        channelId: general,
        ownerId: ana.userId,
        title: "Ship",
        goal: "Ship it",
        executor: "agent",
        runnerId: null,
        commandPolicy: "always",
      });
      await server.deps.db
        .update(assignments)
        .set({ status: "wrapping_up" })
        .where(eq(assignments.id, created.id));
      const submissionId = newId("asub");
      await server.deps.db
        .insert(assignmentSubmissions)
        .values({ id: submissionId, assignmentId: created.id, note: "Done", checklist: [] });
      return { row: await assignmentInWorkspace(server.deps.db, workspaceId, created.id), submissionId };
    };
    await run(server, admin, { ana, waiting });
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

const withDb = (deps: AppDeps, hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
  ...deps,
  db: instrumented(deps.db, hooks),
});

/** What a call ended in: the assignment's status, or the error's code. */
const settled = (p: Promise<AssignmentRow>) =>
  p.then(
    (row) => `ok:${row.status}`,
    (err) => {
      if (err instanceof HttpError) return `err:${err.code}`;
      throw err;
    },
  );

/** The assignment and its submission as they ended. */
async function finalState(deps: AppDeps, assignmentId: string, submissionId: string) {
  const [row] = await deps.db.select().from(assignments).where(eq(assignments.id, assignmentId));
  const [sub] = await deps.db
    .select()
    .from(assignmentSubmissions)
    .where(eq(assignmentSubmissions.id, submissionId));
  return [row?.status, sub?.status];
}

describe("answering a submission on Postgres", () => {
  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres("accepting and asking for changes at once, N times: each pair ends in one outcome"),
    async () => {
      await withServer("asg_answers", async (server, _admin, ctx) => {
        for (let i = 0; i < 8; i++) {
          const { row, submissionId } = await ctx.waiting();
          const [accept, change] = await Promise.all([
            settled(
              finishAssignment(server.deps, ctx.ana, row, { outcome: "done", wiki: false, submissionId }),
            ),
            settled(requestSubmissionChanges(server.deps, ctx.ana, row, submissionId, "Add the footer")),
          ]);
          const state = await finalState(server.deps, row.id, submissionId);
          if (accept === "ok:done") {
            expect(change).toBe("err:assignment.closed");
            expect(state).toEqual(["done", "accepted"]);
          } else {
            expect([accept, change]).toEqual(["err:assignment.submission_closed", "ok:active"]);
            expect(state).toEqual(["active", "changes_requested"]);
          }
        }
      });
    },
    2 * SERVER_TEST_MS,
  );

  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres(
      "forced: asking for changes while the accept holds the row waits, then finds the assignment closed",
    ),
    async () => {
      await withServer("asg_forced", async (server, admin, ctx) => {
        const { row, submissionId } = await ctx.waiting();
        const { a, b } = await forcedPair(
          admin,
          "submission-answer",
          "select",
          (side, hooks) =>
            side === "A"
              ? settled(
                  finishAssignment(withDb(server.deps, hooks), ctx.ana, row, {
                    outcome: "done",
                    wiki: false,
                    submissionId,
                  }),
                )
              : settled(
                  requestSubmissionChanges(withDb(server.deps, hooks), ctx.ana, row, submissionId, "More"),
                ),
          { match: `from "assignments"` },
        );
        outcome(
          "submission-answer",
          { a, b, state: await finalState(server.deps, row.id, submissionId) },
          { a: "ok:done", b: "err:assignment.closed", state: ["done", "accepted"] },
        );
      });
    },
    2 * SERVER_TEST_MS,
  );
});
