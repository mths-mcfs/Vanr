// The connection's row lock on a real Postgres, where the server's pool runs two transactions at once. The
// refresh of an expiring OAuth token and the step-up's attempt counter read, decide and write under that lock, and
// so does a save of an agent's access under the agent's row lock.
// The forced tests hold the first transaction right after its locked select until the second one is seen
// waiting on the lock (lock-double.ts); with VANR_TEST_DROP_LOCKS=1 the double leaves FOR UPDATE out and the
// CI postgres job expects them to fail on their outcome. These run only in that job.
import { afterAll, beforeAll, describe, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { type ConnectionRow, grantsOf, replaceGrants } from "../src/integrations/access";
import {
  connectCustom,
  disconnect,
  finishOAuth,
  mcpFor,
  requestScope,
  type Starter,
} from "../src/integrations/connectors";
import { REFRESH_MARGIN_MS } from "../src/integrations/oauth";
import type { RunningServer } from "../src/server";
import { type FakeMcp, startFakeMcp } from "./fake-mcp";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { forcedPair, gate, instrumented, outcome, WAIT_MS } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { seedAgent } from "./route-calls";
import { seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("the connection's row lock on Postgres"), () => {
  let mcp: FakeMcp;
  let clock = new Date("2026-11-14T12:00:00Z");
  let server: RunningServer;
  let admin: postgres.Sql;
  let me: Starter;
  let ana: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    mcp = startFakeMcp({ expiresIn: 90, rotateRefresh: true });
    const url = await testDatabaseUrl("connectors");
    server = await startTestServer({
      env: { DATABASE_URL: url, ALLOW_PRIVATE_NETWORKS: "true" },
      fetchExternal: fetch,
      now: () => clock,
    });
    admin = postgres(url, { max: 1, onnotice: () => {} });
    ana = await signedIn(server, "Ana", "ana@connectors-pg.test");
    const { workspaceId } = await seedWorkspace(server, ana, "Locks");
    me = { workspaceId, userId: ana.user.id, role: "owner", handle: "ana", sessionId: "s" };
  }, SERVER_TEST_MS);
  afterAll(async () => {
    await server?.stop();
    await admin?.end({ timeout: 5 });
    mcp?.stop();
  }, SERVER_TEST_MS);

  /** A custom server connected by OAuth, as the callback leaves it. */
  async function connected(): Promise<ConnectionRow> {
    const start = await connectCustom(server.deps, me, { serverUrl: mcp.url, nextPath: "/back" });
    if (start.status !== "oauth") throw new Error("expected an OAuth start");
    const back = await mcp.authorize(start.consentUrl);
    await finishOAuth(
      server.deps,
      { userId: me.userId, sessionId: me.sessionId },
      { code: back.code, state: back.state, iss: back.iss ?? undefined },
    );
    return row(start.serverId);
  }
  async function row(id: string): Promise<ConnectionRow> {
    const [r] = await server.deps.db.select().from(schema.connections).where(eq(schema.connections.id, id));
    if (!r) throw new Error("no connection");
    return r;
  }
  const refreshes = () => mcp.tokenRequests.filter((f) => f.get("grant_type") === "refresh_token").length;

  test(
    "forced: two refreshes of one expiring token make one exchange and both succeed",
    async () => {
      const stale = await connected();
      clock = new Date(clock.getTime() + 90_000 - REFRESH_MARGIN_MS + 10_000);
      const before = refreshes();
      const run = await forcedPair(admin, "refresh", "select", (_side, hooks) =>
        mcpFor({ ...server.deps, db: instrumented(server.deps.db, hooks) }, stale).then(
          () => "ok",
          () => "failed",
        ),
      );
      outcome(
        "refresh",
        { exchanges: refreshes() - before, results: [run.a, run.b] },
        { exchanges: 1, results: ["ok", "ok"] },
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: two step-ups of one connection count two attempts and post one card",
    async () => {
      const current = await connected();
      const run = await forcedPair(admin, "step-up", "select", (_side, hooks) =>
        requestScope(
          { ...server.deps, db: instrumented(server.deps.db, hooks) },
          current,
          "create_item",
          "x:y",
        ),
      );
      outcome(
        "step-up",
        {
          first: [run.a, run.b].filter((o) => o.kind === "ask" && o.first).length,
          attempts: (await row(current.id)).scopeRequest?.attempts,
        },
        { first: 1, attempts: 2 },
      );
    },
    SERVER_TEST_MS,
  );
  test(
    "forced: a revoke during the callback's write waits for it and the connection ends revoked with no secret",
    async () => {
      const start = await connectCustom(server.deps, me, { serverUrl: mcp.url, nextPath: "/back" });
      if (start.status !== "oauth") throw new Error("expected an OAuth start");
      const back = await mcp.authorize(start.consentUrl);
      const pending = await row(start.serverId);
      const run = await forcedPair(
        admin,
        "revoke",
        "select",
        (side, hooks) => {
          const deps = { ...server.deps, db: instrumented(server.deps.db, hooks) };
          return side === "A"
            ? finishOAuth(
                deps,
                { userId: me.userId, sessionId: me.sessionId },
                { code: back.code, state: back.state, iss: back.iss ?? undefined },
              )
            : disconnect(deps, pending).then(() => "revoked");
        },
        { bKind: "update" },
      );
      const after = await row(start.serverId);
      outcome(
        "revoke",
        { b: run.b, revoked: after.revokedAt !== null, secret: after.secret !== null },
        { b: "revoked", revoked: true, secret: false },
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: two partial saves of one agent's access keep both changes",
    async () => {
      const agent = await seedAgent(server, me.workspaceId, ana, "lia");
      const deny = { connectionId: "", scope: "deny:list_items" };
      const all = { connectionId: "", scope: "*" };
      const held = gate();
      const release = gate();
      const aPids = new Set<number>();
      const bPids = new Set<number>();
      let polling = true;
      // A holds right after it read the agent's grants; B then either waits on the agent's lock or, without it,
      // reads the same grants and ends before A writes.
      const a = replaceGrants(
        instrumented(server.deps.db, {
          pids: aPids,
          after: {
            kind: "select",
            match: '"agent_grants"',
            run: async () => {
              held.open();
              await release.opened;
            },
          },
        }),
        me.workspaceId,
        agent.id,
        (current) => [...current, all],
      );
      let b: Promise<void> | null = null;
      let watcher: Promise<void> | null = null;
      try {
        // A failure of A before its hold point shows as itself, not as a wait.
        const reached = await Promise.race([
          held.opened.then(() => true),
          a.then(() => false),
          Bun.sleep(WAIT_MS).then(() => false),
        ]);
        if (!reached) throw new Error("LOCK_WAIT_TIMEOUT(access): A ended or stalled before its hold point");
        b = replaceGrants(
          instrumented(server.deps.db, { pids: bPids }),
          me.workspaceId,
          agent.id,
          (current) => [...current, deny],
        );
        watcher = (async () => {
          const end = Date.now() + WAIT_MS;
          while (polling && Date.now() < end) {
            const pid = [...bPids][0];
            if (pid !== undefined) {
              const [row] = await admin<{ wait_event_type: string | null }[]>`
                select wait_event_type from pg_stat_activity where pid = ${pid}`;
              if (row?.wait_event_type === "Lock") return;
            }
            await Bun.sleep(25);
          }
          if (polling) throw new Error("LOCK_WAIT_TIMEOUT(access): B neither waited nor ended");
        })();
        await Promise.race([b, watcher]);
        release.open();
        await Promise.all([a, b]);
      } finally {
        polling = false;
        release.open();
        await Promise.allSettled([a, b, watcher]);
      }
      const scopes = (await grantsOf(server.deps.db, agent.id)).map((g) => g.scope).sort();
      outcome("access", scopes, [all.scope, deny.scope].sort());
    },
    SERVER_TEST_MS,
  );
});
