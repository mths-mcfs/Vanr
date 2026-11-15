// Runner decisions at the same time on a real Postgres: the server's pool runs the requests on several connections
// at once, so the agent's lock (pg_advisory_xact_lock) when a person takes over the browser and the single conditional
// UPDATE of a pairing confirmation and of a delivered secret are what keep one outcome. These run only in the CI postgres job.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { AppDeps, AppEnv } from "../src/context";
import { errorBody, HttpError } from "../src/http";
import { createWorkspace, joinWorkspace } from "../src/members";
import { registerRunnerRequests } from "../src/routes/runner-requests";
import { registerRunners } from "../src/routes/runners";
import { applyJobEvent, finishJob } from "../src/runners/jobs";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { forcedPair, instrumented, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { connectProtocolRunner, mintSession } from "./protocol-runner";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 20;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("runner decisions at once on Postgres"), () => {
  test(
    "N confirmations of one code make one runner; N people taking over leave one intervention; N secrets delivered count once",
    async () => {
      const server = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("runners") } });
      const closers: (() => Promise<void>)[] = [];
      try {
        const ana = await signedIn(server, "Ana", "ana@runners-pg.test");
        const { workspaceId } = await createWorkspace(server.deps.db, {
          name: "Pg",
          context: "",
          user: ana.user,
        });
        const beto = await signedIn(server, "Beto", "beto@runners-pg.test");
        await joinWorkspace(server.deps.db, {
          workspaceId,
          userId: beto.user.id,
          name: "Beto",
          role: "member",
        });
        const ws = `/api/v1/workspaces/${workspaceId}`;
        const post = (path: string, payload: unknown) =>
          fetch(`${server.url}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });

        const start = await body(
          await post("/api/v1/runner-pairings", {
            os: "linux",
            arch: "x64",
            hostname: "pg",
            version: "0.2.0",
          }),
        );
        const confirms = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            (i % 2 ? beto : ana).browser.json(`${ws}/runner-pairings/${start.userCode}/confirm`, "POST", {}),
          ),
        );
        expect(confirms.filter((r) => r.status === 200)).toHaveLength(1);
        expect(
          await server.deps.db
            .select()
            .from(schema.runners)
            .where(eq(schema.runners.workspaceId, workspaceId)),
        ).toHaveLength(1);
        const token = await body(
          await post("/api/v1/runner-pairings/token", { deviceCode: start.deviceCode }),
        );
        const minted = await mintSession(server.url, token.token);
        const runner = await connectProtocolRunner(server.url, minted.body.session, { browser: true });
        closers.push(() => runner.close());

        const agentId = newId("agt");
        await server.deps.db.insert(schema.agents).values({
          id: agentId,
          workspaceId,
          name: "Ivy",
          handle: "ivy",
          model: "claude-haiku-5-5",
          ownerUserId: ana.user.id,
          environmentId: runner.runnerId,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        });
        const takingOver = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            (i % 2 ? beto : ana).browser.json(
              `${ws}/agents/${agentId}/browser/interventions/start`,
              "POST",
              {},
            ),
          ),
        );
        const won = await Promise.all(takingOver.filter((r) => r.status === 200).map((r) => body(r)));
        expect(new Set(won.map((w) => w.id)).size).toBe(1);
        const open = await server.deps.db
          .select()
          .from(schema.browserInterventions)
          .where(
            and(
              eq(schema.browserInterventions.agentId, agentId),
              inArray(schema.browserInterventions.status, ["pending", "active"]),
            ),
          );
        expect(open).toHaveLength(1);

        const requestId = newId("sr");
        await server.deps.db.insert(schema.secretPrompts).values({
          id: requestId,
          workspaceId,
          agentId,
          runnerId: runner.runnerId,
          name: "API_TOKEN",
          target: "env",
          targetUserId: beto.user.id,
          publicKey: "pk",
          expiresAt: new Date(Date.now() + 30 * 60_000),
        });
        const deliveries = await Promise.all(
          Array.from({ length: N }, () =>
            beto.browser.json(`${ws}/secret-requests/${requestId}/deliver`, "POST", {
              box: { v: 1, epk: "e", iv: "i", ct: "c" },
            }),
          ),
        );
        expect(deliveries.filter((r) => r.status === 200)).toHaveLength(1);
        expect(deliveries.filter((r) => r.status === 409)).toHaveLength(N - 1);
        expect(
          await server.deps.db
            .select()
            .from(schema.runnerSecrets)
            .where(eq(schema.runnerSecrets.agentId, agentId)),
        ).toHaveLength(1);
        const stores = () =>
          runner.frames.filter((f) => f.type === "request" && f.op === "secret.store").length;
        expect(stores()).toBe(1);

        // Attempts to deliver and to decline at once: one answer wins, and only a delivered secret reaches the runner.
        for (let round = 0; round < 3; round++) {
          const id = newId("sr");
          await server.deps.db.insert(schema.secretPrompts).values({
            id,
            workspaceId,
            agentId,
            runnerId: runner.runnerId,
            name: `KEY_${round}`,
            target: "env",
            targetUserId: beto.user.id,
            publicKey: "pk",
            expiresAt: new Date(Date.now() + 30 * 60_000),
          });
          const before = stores();
          const answers = await Promise.all(
            Array.from({ length: N }, (_, i) =>
              i % 2
                ? beto.browser.json(`${ws}/secret-requests/${id}/decline`, "POST", {})
                : beto.browser.json(`${ws}/secret-requests/${id}/deliver`, "POST", {
                    box: { v: 1, epk: "e", iv: "i", ct: `c${i}` },
                  }),
            ),
          );
          expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
          const [row] = await server.deps.db
            .select()
            .from(schema.secretPrompts)
            .where(eq(schema.secretPrompts.id, id));
          const named = await server.deps.db
            .select()
            .from(schema.runnerSecrets)
            .where(
              and(eq(schema.runnerSecrets.agentId, agentId), eq(schema.runnerSecrets.name, `KEY_${round}`)),
            );
          const delivered = row?.status === "delivered" ? 1 : 0;
          expect(stores() - before).toBe(delivered);
          expect(named).toHaveLength(delivered);
        }
      } finally {
        for (const close of closers) await close();
        await server.stop();
      }
    },
    3 * SERVER_TEST_MS,
  );
});

// The forced tests: a double of the database (lock-double.ts) holds the first transaction where the lock matters
// until the second is seen waiting on it in pg_stat_activity, each with its own pg_backend_pid(). With
// VANR_TEST_DROP_LOCKS=1 the double leaves the locks out and the CI postgres job expects each of these to fail on
// its outcome (LOCK_OUTCOME_MISMATCH(<label>)).
describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("forced: runner locks on Postgres"), () => {
  // One server and one runner for the five forced tests; each test makes its own job, agent state or row.
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let admin: postgres.Sql;
  let runner: Awaited<ReturnType<typeof connectProtocolRunner>>;
  let workspaceId = "";
  let ws = "";
  let agentId = "";
  let ana: Awaited<ReturnType<typeof signedIn>>;
  let beto: Awaited<ReturnType<typeof signedIn>>;
  beforeAll(async () => {
    const url = await testDatabaseUrl("forced_runners");
    server = await startTestServer({ env: { DATABASE_URL: url } });
    admin = postgres(url, { max: 1, onnotice: () => {} });
    ana = await signedIn(server, "Ana", "ana@forced-runners.test");
    ({ workspaceId } = await createWorkspace(server.deps.db, {
      name: "Forced",
      context: "",
      user: ana.user,
    }));
    beto = await signedIn(server, "Beto", "beto@forced-runners.test");
    await joinWorkspace(server.deps.db, { workspaceId, userId: beto.user.id, name: "Beto", role: "admin" });
    ws = `/api/v1/workspaces/${workspaceId}`;
    const post = (path: string, payload: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    const start = await body(
      await post("/api/v1/runner-pairings", { os: "linux", arch: "x64", hostname: "pg", version: "0.2.0" }),
    );
    await ana.browser.json(`${ws}/runner-pairings/${start.userCode}/confirm`, "POST", {});
    const token = await body(await post("/api/v1/runner-pairings/token", { deviceCode: start.deviceCode }));
    const minted = await mintSession(server.url, token.token);
    runner = await connectProtocolRunner(server.url, minted.body.session, { browser: true });
    agentId = newId("agt");
    await server.deps.db.insert(schema.agents).values({
      id: agentId,
      workspaceId,
      name: "Ivy",
      handle: "ivy",
      model: "claude-haiku-5-5",
      ownerUserId: ana.user.id,
      environmentId: runner.runnerId,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    });
  }, 2 * SERVER_TEST_MS);
  afterAll(async () => {
    await runner?.close();
    await server?.stop();
    await admin?.end({ timeout: 5 });
  }, SERVER_TEST_MS);

  const withDb = (hooks: Parameters<typeof instrumented>[1]): AppDeps => ({
    ...server.deps,
    db: instrumented(server.deps.db, hooks),
  });
  const appAs = (deps: AppDeps, who: { id: string }) => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) =>
      err instanceof HttpError ? c.json(errorBody(err.code, err.message), err.status) : c.json({}, 500),
    );
    app.use("*", async (c, next) => {
      c.set("deps", deps);
      c.set("user", { id: who.id, name: "x", email: "x@x.test", image: null });
      const [session] = await server.deps.db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, who.id))
        .limit(1);
      c.set("sessionId", session?.id ?? null);
      c.set("member", { workspaceId, userId: who.id, role: "owner", handle: "x" });
      await next();
    });
    registerRunners(app);
    registerRunnerRequests(app);
    return app;
  };
  const call = async (
    deps: AppDeps,
    who: { id: string },
    method: string,
    path: string,
    payload: unknown,
  ): Promise<Response> =>
    appAs(deps, who).request(`${ws}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const job = async () => {
    const id = newId("job");
    await server.deps.db.insert(schema.runnerJobs).values({
      id,
      workspaceId,
      runnerId: runner.runnerId,
      agentId,
      title: "Build",
      executor: "shell",
      prompt: "make",
    });
    return id;
  };
  const jobRow = async (id: string) =>
    (await server.deps.db.select().from(schema.runnerJobs).where(eq(schema.runnerJobs.id, id)))[0];

  test(
    "forced: a job's end waits on the row lock of an event in flight, so the end is final",
    async () => {
      // A line holds after reading the queued job; the job's end waits on the row lock, so it is final.
      const ended = await job();
      await forcedPair(admin, "job-done", "select", (side, hooks) =>
        side === "A"
          ? applyJobEvent(withDb(hooks), runner.runnerId, { jobId: ended, kind: "line", line: "first" })
          : finishJob(withDb(hooks), runner.runnerId, {
              jobId: ended,
              status: "done",
              exitCode: 0,
              result: "ok",
              session: null,
              files: [],
              denied: [],
              blocked: [],
              startedAt: null,
              endedAt: null,
            }),
      );
      outcome("job-done", (await jobRow(ended))?.status, "done");
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a second line waits on the row lock, so both lines stay on the tail",
    async () => {
      // Two lines: the second waits on the row lock, so both stay on the tail.
      const lines = await job();
      await forcedPair(admin, "job-tail", "select", (side, hooks) =>
        applyJobEvent(withDb(hooks), runner.runnerId, { jobId: lines, kind: "line", line: side }),
      );
      outcome("job-tail", (await jobRow(lines))?.outputTail, ["A", "B"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a second person taking over waits on the agent's lock, so one intervention opens",
    async () => {
      // Two people take over the browser: the second waits on the agent's lock, so one intervention opens.
      const starts = await forcedPair(
        admin,
        "intervention-start",
        "select",
        (side, hooks) =>
          call(
            withDb(hooks),
            side === "A" ? ana.user : beto.user,
            "POST",
            `/agents/${agentId}/browser/interventions/start`,
            {},
          ),
        'from "browser_interventions"',
      );
      const open = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(
          and(
            eq(schema.browserInterventions.agentId, agentId),
            inArray(schema.browserInterventions.status, ["pending", "active"]),
          ),
        );
      outcome("intervention-start", open.length, 1);
      expect([starts.a.status, starts.b.status].sort()).toEqual([200, 409]);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a second partial sandbox change waits on the workspace's lock, so both stay",
    async () => {
      // Two partial sandbox changes: the second waits on the workspace's lock, so both stay.
      await forcedPair(admin, "sandbox", "select", (side, hooks) =>
        call(
          withDb(hooks),
          ana.user,
          "PUT",
          "/sandbox-settings",
          side === "A" ? { minutesPerDay: 10 } : { commandTimeoutSec: 30 },
        ),
      );
      const [sandbox] = await server.deps.db
        .select()
        .from(schema.sandboxPolicies)
        .where(eq(schema.sandboxPolicies.workspaceId, workspaceId));
      outcome("sandbox", [sandbox?.minutesPerDay, sandbox?.commandTimeoutSec], [10, 30]);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a second site list waits on the agent's policy lock, so no site stays on the read list",
    async () => {
      // Two site lists: the second waits on the agent's policy lock, so neither site stays on the read list.
      await server.deps.db.insert(schema.browserPolicies).values({
        agentId,
        workspaceId,
        permittedDomains: [],
        readDomains: ["a.example.com", "b.example.com"],
      });
      await forcedPair(admin, "browser-policy", "select", (side, hooks) =>
        call(withDb(hooks), ana.user, "PUT", `/agents/${agentId}/browser`, {
          permittedDomains: [side === "A" ? "a.example.com" : "b.example.com"],
        }),
      );
      const [policy] = await server.deps.db
        .select()
        .from(schema.browserPolicies)
        .where(eq(schema.browserPolicies.agentId, agentId));
      outcome("browser-policy", policy?.readDomains, []);
    },
    SERVER_TEST_MS,
  );
});
