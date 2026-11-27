// The assignment engine on a real Postgres: the loop as a DBOS workflow takes an assignment on the runner to its
// submission, and two steps on the same work send one turn. PGlite runs one transaction at a time, so only here
// does the work row's lock show: a double of the database (lock-double.ts) holds the first step right after it
// read the row until the second is seen waiting on it, and with VANR_TEST_DROP_LOCKS=1 (the lock left out) the
// CI postgres job expects the forced test to fail on its outcome (LOCK_OUTCOME_MISMATCH(work-claim)).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { moveAssignment } from "../src/assignments/core";
import { createAssignment } from "../src/assignments/engine";
import { jobIdOf, workIdOf } from "../src/assignments/keys";
import { act, workflowIdOf } from "../src/assignments/motor";
import type { Verifier } from "../src/assignments/verify";
import type { AppDeps } from "../src/context";
import type { RunningServer } from "../src/server";
import { agentRuntime, pairRunner, passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import type { ProtocolRunner } from "./protocol-runner";
import { type Person, seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const { assignments, assignmentWork, assignmentPlanItems, assignmentSubmissions } = schema;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("the assignment engine on Postgres"), () => {
  let server: RunningServer;
  let admin: postgres.Sql;
  let runner: ProtocolRunner;
  let ana: Person;
  let workspaceId = "";
  let general = "";
  const runtime = agentRuntime();
  const starts = new Map<string, number>();
  beforeAll(async () => {
    const url = await testDatabaseUrl("assignment_engine");
    server = await startTestServer({
      env: { DATABASE_URL: url },
      engine: "dbos",
      runtime: runtime.wrap,
      assignmentVerifier: passing().verifier,
    });
    admin = postgres(url, { max: 1, onnotice: () => {} });
    ana = await signedIn(server, "Ana", "ana@engine-postgres.test");
    ({ workspaceId, general } = await seedWorkspace(server, ana, "Engine"));
    runner = await pairRunner(server, ana, workspaceId, (id) => starts.set(id, (starts.get(id) ?? 0) + 1));
  }, 2 * SERVER_TEST_MS);
  afterAll(async () => {
    await runner?.close();
    await server?.stop();
    await admin?.end({ timeout: 5 });
  }, SERVER_TEST_MS);

  test(
    "the loop is a DBOS workflow: an assignment on the runner reaches its submission, each job sent once",
    async () => {
      expect(server.deps.assignmentEngine.kind).toBe("dbos");
      const agentId = await seedAgent(server.deps.db, workspaceId, ana, runner.runnerId);
      const proposed = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: "lia",
        channelId: general,
        ownerId: ana.user.id,
        title: "Ship the site",
        goal: "The site is live",
        executor: "claude_code",
        runnerId: runner.runnerId,
        commandPolicy: "always",
        plan: ["Build"],
      });
      const row = await moveAssignment(
        server.deps,
        proposed,
        ["proposed"],
        { status: "active", startedAt: server.deps.now() },
        "status",
      );
      if (!row) throw new Error("not started");
      server.deps.assignmentEngine.wake(row.id);
      const jobId = jobIdOf(workIdOf(row.id, "p1", 1));
      await runner.next(
        (f) => f.type === "request" && f.op === "job.start" && f.args.jobId === jobId,
        30_000,
      );
      runner.send({
        type: "job.done",
        job: {
          jobId,
          status: "done",
          exitCode: 0,
          result: "Built",
          files: ["src/site.ts"],
          session: null,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          denied: [],
          blocked: [],
        },
      });
      await runner.next((f) => f.type === "job.ack" && f.jobId === jobId, 15_000);
      // The workflow moves on through its own steps: the submission is where it waits for a person.
      const deadline = Date.now() + 30_000;
      let after = row;
      while (Date.now() < deadline) {
        await server.deps.assignmentEngine.idle();
        const [fresh] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
        if (fresh) after = fresh;
        if (after.waitReason === "submission") break;
      }
      expect([after.status, after.waitReason, after.workflowId]).toEqual([
        "wrapping_up",
        "submission",
        workflowIdOf(row.id),
      ]);
      const [submission] = await server.deps.db
        .select()
        .from(assignmentSubmissions)
        .where(eq(assignmentSubmissions.assignmentId, row.id));
      expect(submission?.status).toBe("pending");
      expect(starts.get(jobId)).toBe(1);
    },
    // Room for the three waits inside (30 s, 15 s and 30 s) and the setup.
    3 * SERVER_TEST_MS,
  );

  const withDb = (hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
    ...server.deps,
    db: instrumented(server.deps.db, hooks),
  });

  test(
    "forced: a second step on the same work waits on the work row's lock, so one turn goes out",
    async () => {
      const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
      const row = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: "lia",
        channelId: general,
        ownerId: ana.user.id,
        title: "Paint",
        goal: "Paint",
        executor: "agent",
        runnerId: null,
        commandPolicy: "always",
        plan: ["Walls"],
      });
      // Active straight in the database, with nothing waking it: no workflow runs it; the test runs the two steps by hand.
      await server.deps.db
        .update(assignments)
        .set({ status: "active", startedAt: server.deps.now() })
        .where(eq(assignments.id, row.id));
      const before = runtime.turns.length;
      const step = { type: "work" as const, itemId: "p1", n: 1 };
      await forcedPair(admin, "work-claim", "select", (_side, hooks) => act(withDb(hooks), row.id, step), {
        match: "assignment_work",
      });
      const [p1] = await server.deps.db
        .select()
        .from(assignmentPlanItems)
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
      const [work] = await server.deps.db
        .select()
        .from(assignmentWork)
        .where(eq(assignmentWork.id, workIdOf(row.id, "p1", 1)));
      outcome(
        "work-claim",
        { turns: runtime.turns.length - before, itemTurns: p1?.turns },
        { turns: 1, itemTurns: 1 },
      );
      expect(work?.refId).toBe(runtime.turns.at(-1)?.runId ?? "");
      for (const t of runtime.turns.slice(before)) runtime.finish(t.runId);
      await server.deps.runtime.settle();
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a second step on the same validation round waits on the assignment's lock, so the verifier is called once",
    async () => {
      const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
      const row = await createAssignment(server.deps, {
        workspaceId,
        agentId,
        agentHandle: "lia",
        channelId: general,
        ownerId: ana.user.id,
        title: "Check",
        goal: "Check",
        executor: "agent",
        runnerId: null,
        commandPolicy: "always",
        plan: ["Docs"],
      });
      await server.deps.db
        .update(assignments)
        .set({ status: "active", startedAt: server.deps.now() })
        .where(eq(assignments.id, row.id));
      await server.deps.db
        .update(assignmentPlanItems)
        .set({ status: "done", summary: "wrote them" })
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
      // The first call waits for the other step: until that one also calls (no lock) or ends (it found the claim
      // held), so without the lock both steps are past the claim before either writes a verdict.
      let calls = 0;
      let other!: () => void;
      const otherMoved = new Promise<void>((r) => {
        other = r;
      });
      const counting: Verifier = async (_deps, _row, items) => {
        calls++;
        if (calls === 1) await otherMoved;
        else other();
        return {
          ok: true,
          runId: null,
          verdicts: items.map((i) => ({ id: i.item.id, passes: true, reason: "ok" })),
        };
      };
      const step = { type: "validate" as const, itemIds: ["p1"], round: 1 };
      try {
        await forcedPair(
          admin,
          "validate-claim",
          "select",
          (_side, hooks) =>
            act({ ...withDb(hooks), assignmentVerifier: counting }, row.id, step).finally(() => other()),
          { match: "effect_keys" },
        );
      } finally {
        other();
      }
      const [p1] = await server.deps.db
        .select()
        .from(assignmentPlanItems)
        .where(and(eq(assignmentPlanItems.assignmentId, row.id), eq(assignmentPlanItems.id, "p1")));
      outcome("validate-claim", { calls, checks: p1?.checks }, { calls: 1, checks: 1 });
      await server.deps.db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, row.id));
    },
    SERVER_TEST_MS,
  );
});
