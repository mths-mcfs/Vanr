// Runner decisions at the same time on a real Postgres: the server's pool runs the requests on several connections
// at once, so the agent's lock (pg_advisory_xact_lock) when a person takes over the browser and the single conditional
// UPDATE of a pairing confirmation and of a delivered secret are what keep one outcome. These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, inArray } from "drizzle-orm";
import { createWorkspace, joinWorkspace } from "../src/members";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
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
