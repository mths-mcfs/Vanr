// Debates and routines at the same time on a real Postgres. The server's pool runs transactions on several
// connections, so what keeps a round's queue right when people answer at once, or when an answer meets the stop,
// is the debate's row lock (FOR NO KEY UPDATE); what keeps one execution per fire, per scheduled time and per
// queued run is a conditional UPDATE or a unique index (one statement each, no lock to take out).
//
// The "forced" tests don't count on the scheduler: the database double of lock-double.ts holds the first
// transaction right after its first UPDATE (its row lock is held then) until the second one is seen waiting on a
// lock or done. With VANR_TEST_DROP_LOCKS=1 the same double leaves the FOR NO KEY UPDATE out, so the second one reads
// the state from before the first and writes over it: the CI postgres job runs that mode too and expects these tests
// to fail on their outcome (LOCK_OUTCOME_MISMATCH), which proves they catch a missing lock.
// These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import type { ActorRef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { AppDeps } from "../src/context";
import { answerRound, openDebate, stopDebate } from "../src/debates";
import { drainQueues, dueRoutines, registerFire } from "../src/routines";
import type { RunningServer } from "../src/server";
import { signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { memberOf, seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 12;

interface Ctx {
  workspaceId: string;
  people: ActorRef[];
  agentId: string;
}

async function withServer(
  prefix: string,
  run: (server: RunningServer, admin: postgres.Sql, ctx: Ctx) => Promise<void>,
) {
  const url = await testDatabaseUrl(prefix);
  const server = await startTestServer({ env: { DATABASE_URL: url } });
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const host = prefix.replaceAll("_", "-");
    const ana = await signedIn(server, "Ana", `ana@${host}.test`);
    const { workspaceId } = await seedWorkspace(server, ana, "Debates");
    const people: ActorRef[] = [{ type: "person", id: ana.user.id }];
    for (let i = 0; i < N - 1; i++)
      people.push({
        type: "person",
        id: (await memberOf(server, workspaceId, `P${i}`, `p${i}@${host}.test`)).user.id,
      });
    const [agent] = await server.deps.db
      .insert(schema.agents)
      .values({
        id: newId("agt"),
        workspaceId,
        name: "Rita",
        handle: "rita",
        role: "support",
        instructions: "",
        model: "claude-haiku-5-5",
        ownerUserId: ana.user.id,
        appearance: { color: "blue", eyes: "dot", adornment: "none" },
      })
      .returning();
    if (!agent) throw new Error("no agent");
    await run(server, admin, { workspaceId, people, agentId: agent.id });
  } finally {
    await server.stop();
    await admin.end({ timeout: 5 });
  }
}

const withDb = (deps: AppDeps, hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
  ...deps,
  db: instrumented(deps.db, hooks),
});

/** A debate between people only (nothing reaches the runtime), waiting on every one of them. */
async function peopleDebate(server: RunningServer, ctx: Ctx, speakers: ActorRef[]) {
  const row = await openDebate(server.deps, {
    workspaceId: ctx.workspaceId,
    title: "Race",
    goal: "At once",
    agentIds: [],
    speakers,
    createdBy: speakers[0] ?? { type: "person", id: "" },
    requesterUserId: speakers[0]?.id ?? null,
    origin: { kind: "manual" },
  });
  await server.deps.runtime.settle();
  const [fresh] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, row.id));
  if (!fresh) throw new Error("no debate");
  return fresh;
}

const claim = { answer: "yes", key: "yes", confidence: null, reason: "", evidence: [], changed: false };
const stateOf = async (server: RunningServer, id: string) => {
  const [row] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, id));
  const posts = await server.deps.db
    .select()
    .from(schema.debatePosts)
    .where(eq(schema.debatePosts.debateId, id));
  const answers = posts.filter((p) => p.kind === "speaker").length;
  return {
    pending: row?.pendingSpeakers.map((s) => s.id) ?? null,
    phase: row?.phase ?? null,
    posts: answers,
  };
};

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("debates and routines at once on Postgres"), () => {
  test("N people answering at once: the queue ends empty and every answer is kept once", async () => {
    await withServer("deb_n", async (server, _admin, ctx) => {
      const row = await peopleDebate(server, ctx, ctx.people);
      const results = await Promise.all(
        [...ctx.people, ...ctx.people].map((who) =>
          answerRound(server.deps, row, who, { kind: "speaker", body: "here", claimData: claim }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(N);
      expect(await stateOf(server, row.id)).toMatchObject({ pending: [], posts: N });
    });
  }, 120_000);

  test("forced: the second answer waits on the debate's lock and takes itself out of the queue the first left", async () => {
    await withServer("deb_ans", async (server, admin, ctx) => {
      const [a, b] = ctx.people;
      if (!a || !b) throw new Error("no people");
      const row = await peopleDebate(server, ctx, [a, b]);
      const run = await forcedPair(admin, "debate-answer", "update", (side, hooks) =>
        answerRound(withDb(server.deps, hooks), row, side === "A" ? a : b, {
          kind: "speaker",
          body: side,
          claimData: claim,
        }).then((r) => !!r),
      );
      expect(run.aPids).not.toEqual(run.bPids);
      outcome(
        "debate-answer",
        { ...(await stateOf(server, row.id)), a: run.a, b: run.b },
        {
          pending: [],
          phase: "human_turn",
          posts: 2,
          a: true,
          b: true,
        },
      );
    });
  }, 120_000);

  test("forced: an answer that meets the stop waits on the debate's lock and finds the queue closed", async () => {
    await withServer("deb_stop", async (server, admin, ctx) => {
      const [a, b] = ctx.people;
      if (!a || !b) throw new Error("no people");
      const row = await peopleDebate(server, ctx, [a, b]);
      const run = await forcedPair(admin, "debate-stop", "update", (side, hooks) => {
        const deps = withDb(server.deps, hooks);
        return side === "A"
          ? stopDebate(deps, row, "concluded").then((r) => !!r)
          : answerRound(deps, row, a, { kind: "speaker", body: "late", claimData: claim }).then((r) => !!r);
      });
      expect(run.aPids).not.toEqual(run.bPids);
      // Read before the stop's advance (the synthesis) runs: its outcome isn't what the lock is for.
      const state = await stateOf(server, row.id);
      await server.deps.runtime.settle();
      outcome(
        "debate-stop",
        { pending: state.pending, a: run.a, b: run.b, answers: state.posts },
        {
          pending: [],
          a: true,
          b: false,
          answers: 0,
        },
      );
    });
  }, 120_000);

  test("one execution per fire, per scheduled time and per queued run, with N callers at once", async () => {
    await withServer("rtn_n", async (server, _admin, ctx) => {
      const insertRoutine = async (values: Partial<typeof schema.routines.$inferInsert>) => {
        const [r] = await server.deps.db
          .insert(schema.routines)
          .values({
            id: newId("rtn"),
            workspaceId: ctx.workspaceId,
            name: "Race",
            prompt: "Go",
            agentId: ctx.agentId,
            target: { kind: "debate", agentIds: [ctx.agentId], roundLimit: 1 },
            trigger: { kind: "webhook" },
            createdBy: ctx.people[0]?.id ?? "",
            ...values,
          })
          .returning();
        if (!r) throw new Error("no routine");
        return r;
      };
      const hook = await insertRoutine({});
      const fires = await Promise.all(
        Array.from({ length: N }, () =>
          registerFire(server.deps, hook.id, { trigger: "webhook", key: "webhook:same" }),
        ),
      );
      expect(fires.filter((f) => !f.duplicate)).toHaveLength(1);

      const slot = new Date(Date.now() - 60_000);
      const scheduled = await insertRoutine({
        trigger: { kind: "schedule", rule: { freq: "hourly", timezone: "UTC" } },
        nextFireAt: slot,
        createdAt: new Date(slot.getTime() - 3_600_000),
      });
      const started = await Promise.all(Array.from({ length: N }, () => dueRoutines(server.deps)));
      expect(started.reduce((x, y) => x + y, 0)).toBe(1);

      const queued = await insertRoutine({});
      const reg = await registerFire(server.deps, queued.id, { trigger: "webhook", key: "webhook:q" });
      if (reg.duplicate) throw new Error("duplicate");
      await server.deps.db
        .update(schema.routineExecutions)
        .set({ status: "queued", notBefore: new Date(Date.now() - 1000) })
        .where(eq(schema.routineExecutions.id, reg.run.id));
      await Promise.all(Array.from({ length: N }, () => drainQueues(server.deps)));
      await server.deps.runtime.settle();
      for (const r of [scheduled, queued]) {
        const rows = await server.deps.db
          .select()
          .from(schema.routineExecutions)
          .where(eq(schema.routineExecutions.routineId, r.id));
        expect(rows.map((x) => x.status)).toEqual(["ok"]);
        const opened = (await server.deps.db.select().from(schema.debates)).filter(
          (d) => (d.origin as { routineId?: string } | null)?.routineId === r.id,
        );
        expect(opened).toHaveLength(1);
      }
    });
  }, 120_000);
});
