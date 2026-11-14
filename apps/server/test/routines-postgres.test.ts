// A routine's fire and an edit of the routine at the same time on a real Postgres. The fire reads the routine's
// definition under the routine's row lock (FOR NO KEY UPDATE) in the transaction that claims it: an edit or a pause
// that commits while the fire starts is seen by the fire, never run over with the definition from before.
//
// The "forced" test doesn't count on the scheduler: the database double of lock-double.ts holds the edit's
// transaction right after its UPDATE (its row lock is held then) until the fire is seen waiting on that lock or
// done. With VANR_TEST_DROP_LOCKS=1 the same double leaves the FOR NO KEY UPDATE out, so the fire reads the routine
// as it was before the pause and runs: the CI postgres job runs that mode too and expects this test to fail on its
// outcome (LOCK_OUTCOME_MISMATCH), which proves it catches a missing lock.
// These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { AppDeps } from "../src/context";
import { registerFire, startRoutineRun } from "../src/routines";
import type { RunningServer } from "../src/server";
import { signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { call, seedAgent, ws } from "./route-calls";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 12;

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

const withDb = (deps: AppDeps, hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
  ...deps,
  db: instrumented(deps.db, hooks),
});

/** A routine that opens a debate (no runtime needed), on, fired by webhook, created through the route. */
async function webhookRoutine(server: RunningServer, prefix: string) {
  const host = prefix.replaceAll("_", "-");
  const ana = await signedIn(server, "Ana", `ana@${host}.test`);
  const { workspaceId } = await seedWorkspace(server, ana, "Routines");
  const lia = await seedAgent(server, workspaceId, ana, "lia");
  const res = await call(ana, "POST", `${ws(workspaceId)}/routines`, {
    active: true,
    agentId: lia.id,
    prompt: "Debate it",
    target: { kind: "debate", agentIds: [lia.id], roundLimit: 1 },
    trigger: { kind: "webhook" },
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return { ana, workspaceId, routineId: String(res.body.id) };
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("routine fires and edits at once on Postgres"), () => {
  test("N 'run now' with one key and N edits at once: one execution, and the routine ends as the last edit left it", async () => {
    await withServer("rtn_n", async (server) => {
      const { ana, workspaceId, routineId } = await webhookRoutine(server, "rtn_n");
      const path = `${ws(workspaceId)}/routines/${routineId}`;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          i % 2
            ? call(ana, "POST", `${path}/run`, { key: "same" })
            : call(ana, "PATCH", path, { prompt: `Edit ${i}` }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      await server.deps.runtime.settle();
      const runs = await server.deps.db
        .select()
        .from(schema.routineExecutions)
        .where(eq(schema.routineExecutions.routineId, routineId));
      expect(runs).toHaveLength(1);
      const [row] = await server.deps.db
        .select()
        .from(schema.routines)
        .where(eq(schema.routines.id, routineId));
      expect(row?.prompt).toMatch(/^Edit \d+$/);
    });
  }, 120_000);

  test("forced: a fire waits on the routine's lock and sees the pause that committed while it started", async () => {
    await withServer("rtn_fire", async (server, admin) => {
      const { routineId } = await webhookRoutine(server, "rtn_fire");
      const reg = await registerFire(server.deps, routineId, { trigger: "webhook", key: "webhook:forced" });
      if (reg.duplicate) throw new Error("duplicate fire");
      const fired = reg.run;
      const run = await forcedPair(
        admin,
        "routine-fire",
        "update",
        (side, hooks) => {
          const deps = withDb(server.deps, hooks);
          // A: the pause, held after its UPDATE. B: the fire that was recorded before it.
          return side === "A"
            ? deps.db
                .transaction(async (tx) => {
                  await tx
                    .update(schema.routines)
                    .set({ active: false, nextFireAt: null })
                    .where(eq(schema.routines.id, routineId));
                })
                .then(() => "paused")
            : startRoutineRun(deps, fired).then((r) => r.status);
        },
        "select",
      );
      expect(run.aPids).not.toEqual(run.bPids);
      await server.deps.runtime.settle();
      const [execution] = await server.deps.db
        .select()
        .from(schema.routineExecutions)
        .where(eq(schema.routineExecutions.id, fired.id));
      const debates = await server.deps.db.select({ id: schema.debates.id }).from(schema.debates);
      outcome(
        "routine-fire",
        { status: execution?.status, reason: execution?.reason, debates: debates.length },
        { status: "skipped", reason: "paused", debates: 0 },
      );
    });
  }, 120_000);
});
