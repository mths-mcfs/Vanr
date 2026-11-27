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
import { addOpinion, addRules, answerSuggestion, checkSubmissionItem } from "../src/assignments/answers";
import { type AssignmentRow, assignmentInWorkspace } from "../src/assignments/core";
import { createAssignment } from "../src/assignments/engine";
import {
  finishAssignment,
  patchAssignment,
  requestSubmissionChanges,
  transferOnLockedRow,
} from "../src/assignments/lifecycle";
import type { AppDeps, WorkspaceMember } from "../src/context";
import { HttpError } from "../src/http";
import type { RunningServer } from "../src/server";
import { agentRuntime, passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { memberOf, seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const { assignments, assignmentSubmissions, assignmentDecisions, assignmentCommandRules, messages } = schema;

interface Ctx {
  ana: WorkspaceMember;
  workspaceId: string;
  general: string;
  betoId: string;
  caioId: string;
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
    const beto = await memberOf(server, workspaceId, "Beto", `beto@${tag}.test`);
    const caio = await memberOf(server, workspaceId, "Caio", `caio@${tag}.test`);
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
    await run(server, admin, {
      ana,
      workspaceId,
      general,
      betoId: beto.user.id,
      caioId: caio.user.id,
      waiting,
    });
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

  /** Whether a call ended well or with which error code, for a call that returns something else. */
  const ended = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (err) => {
        if (err instanceof HttpError) return `err:${err.code}`;
        throw err;
      },
    );

  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres("forced: two opinions on a decision at once both count"),
    async () => {
      await withServer("asg_opinion", async (server, admin, ctx) => {
        const { row } = await ctx.waiting();
        const decisionId = newId("adec");
        await server.deps.db.insert(assignmentDecisions).values({
          id: decisionId,
          assignmentId: row.id,
          question: "Host?",
          options: ["a", "b"],
          status: "pending",
        });
        const { a, b } = await forcedPair(
          admin,
          "decision-opinion",
          "select",
          (side, hooks) =>
            ended(
              addOpinion(withDb(server.deps, hooks), {
                assignmentId: row.id,
                decisionId,
                userId: side === "A" ? ctx.betoId : ctx.caioId,
                option: side === "A" ? "a" : "b",
              }),
            ),
          { match: `from "assignment_decisions"` },
        );
        const [d] = await server.deps.db
          .select()
          .from(assignmentDecisions)
          .where(eq(assignmentDecisions.id, decisionId));
        outcome(
          "decision-opinion",
          { a, b, options: d?.opinions.map((o) => o.option).sort() },
          {
            a: "ok",
            b: "ok",
            options: ["a", "b"],
          },
        );
      });
    },
    2 * SERVER_TEST_MS,
  );

  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres("forced: two ticks on a checklist at once both stay"),
    async () => {
      await withServer("asg_checklist", async (server, admin, ctx) => {
        const { row, submissionId } = await ctx.waiting();
        await server.deps.db
          .update(assignmentSubmissions)
          .set({
            checklist: [
              { id: "c1", text: "One", verifiedBy: null },
              { id: "c2", text: "Two", verifiedBy: null },
            ],
          })
          .where(eq(assignmentSubmissions.id, submissionId));
        const { a, b } = await forcedPair(
          admin,
          "submission-checklist",
          "select",
          (side, hooks) =>
            ended(
              checkSubmissionItem(withDb(server.deps, hooks), {
                assignmentId: row.id,
                submissionId,
                itemId: side === "A" ? "c1" : "c2",
                verifiedBy: side === "A" ? ctx.betoId : ctx.caioId,
              }),
            ),
          { match: `from "assignment_submissions"` },
        );
        const [s] = await server.deps.db
          .select()
          .from(assignmentSubmissions)
          .where(eq(assignmentSubmissions.id, submissionId));
        outcome(
          "submission-checklist",
          { a, b, checked: s?.checklist.map((i) => i.verifiedBy) },
          {
            a: "ok",
            b: "ok",
            checked: [ctx.betoId, ctx.caioId],
          },
        );
      });
    },
    2 * SERVER_TEST_MS,
  );

  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres("forced: two answers to a suggestion at once: the second finds it answered"),
    async () => {
      await withServer("asg_suggestion", async (server, admin, ctx) => {
        const { row } = await ctx.waiting();
        const messageId = newId("msg");
        await server.deps.db.insert(messages).values({
          id: messageId,
          workspaceId: ctx.workspaceId,
          channelId: ctx.general,
          threadId: row.threadId,
          authorKind: "person",
          authorId: ctx.betoId,
          body: "Dark theme",
          meta: { assignmentSuggestion: { assignmentId: row.id, text: "Dark theme" } },
        });
        const { a, b } = await forcedPair(
          admin,
          "suggestion-answer",
          "select",
          (side, hooks) =>
            ended(
              answerSuggestion(withDb(server.deps, hooks), {
                workspaceId: ctx.workspaceId,
                assignmentId: row.id,
                threadId: row.threadId,
                messageId,
                status: side === "A" ? "accepted" : "declined",
              }),
            ),
          { match: `from "messages"` },
        );
        outcome("suggestion-answer", { a, b }, { a: "ok", b: "err:assignment.suggestion_closed" });
      });
    },
    2 * SERVER_TEST_MS,
  );

  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres("forced: the same command rule saved twice at once is saved once"),
    async () => {
      await withServer("asg_rules", async (server, admin, ctx) => {
        const { row } = await ctx.waiting();
        const { a, b } = await forcedPair(
          admin,
          "command-rules",
          "select",
          (_side, hooks) =>
            ended(
              addRules(withDb(server.deps, hooks), {
                assignmentId: row.id,
                wanted: ["npm test *"],
                by: ctx.ana.userId,
              }),
            ),
          { match: `from "assignment_command_rules"` },
        );
        const rules = await server.deps.db
          .select()
          .from(assignmentCommandRules)
          .where(eq(assignmentCommandRules.assignmentId, row.id));
        outcome(
          "command-rules",
          { a, b, rules: rules.map((r) => r.rule) },
          { a: "ok", b: "ok", rules: ["npm test *"] },
        );
      });
    },
    2 * SERVER_TEST_MS,
  );

  test.skipIf(!TEST_POSTGRES_URL)(
    // The route also queues the hand-over behind the assignment's job starts (in memory, one process); the
    // forced pair drives the write under the row lock that holds across connections.
    onPostgres("forced: two hand-overs at once: the second finds the assignment changed"),
    async () => {
      await withServer("asg_transfer", async (server, admin, ctx) => {
        const { row } = await ctx.waiting();
        const { a, b } = await forcedPair(
          admin,
          "assignment-transfer",
          "select",
          (side, hooks) =>
            ended(
              transferOnLockedRow(withDb(server.deps, hooks), ctx.ana, row, {
                userId: side === "A" ? ctx.betoId : ctx.caioId,
                runnerId: null,
              }),
            ),
          { match: `from "assignments"` },
        );
        const [after] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
        outcome(
          "assignment-transfer",
          { a, b, owner: after?.ownerId },
          {
            a: "ok",
            b: "err:assignment.changed",
            owner: ctx.betoId,
          },
        );
      });
    },
    2 * SERVER_TEST_MS,
  );

  test.skipIf(!TEST_POSTGRES_URL)(
    onPostgres("forced: two managers changing different limits at once keep both"),
    async () => {
      await withServer("asg_limits", async (server, admin, ctx) => {
        const { row } = await ctx.waiting();
        const { a, b } = await forcedPair(
          admin,
          "assignment-limits",
          "select",
          (side, hooks) =>
            ended(
              patchAssignment(withDb(server.deps, hooks), ctx.ana, row, {
                limits: side === "A" ? { dollars: 1 } : { steps: 3 },
              }),
            ),
          { match: `from "assignments"` },
        );
        const [after] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
        // jsonb keeps its own key order: the limits are compared as values.
        const l = after?.limits;
        outcome(
          "assignment-limits",
          { a, b, limits: [l?.dollars, l?.minutes, l?.steps] },
          { a: "ok", b: "ok", limits: [1, 480, 3] },
        );
      });
    },
    2 * SERVER_TEST_MS,
  );
});
