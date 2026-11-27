// The chat route on a real Postgres, where the server's pool runs the requests on several connections: a whole
// sign-up, workspace and message, and N sends of one clientId at once through the route give one message that the
// runtime gets once (the unique index on (channel, author, clientId) picks it; the losers answer it with 200).
// PGlite runs one statement at a time, so only this file shows it under real concurrency. CI postgres job only.
import { describe, expect, test } from "bun:test";
import { type ChatRuntime, chatRuntime } from "./chat-runtime";
import { SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { call, ws } from "./route-calls";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 20;

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("the chat route on Postgres"), () => {
  test(
    "a sign-up, a workspace and a message; N sends of one clientId at once route one message once",
    async () => {
      const runtime: ChatRuntime = chatRuntime();
      const server = await startTestServer({
        env: { DATABASE_URL: await testDatabaseUrl("chat") },
        runtime: (port) => runtime.port(port),
      });
      try {
        const ana = await signedIn(server, "Ana", "ana@chat-pg.test");
        const created = await call(ana, "POST", "/api/v1/workspaces", { name: "PG" });
        const w = ws(created.body.workspace.id);
        const general: string = created.body.defaultChannelId;
        const path = `${w}/channels/${general}/messages`;
        expect((await call(ana, "POST", path, { body: "hello from postgres", clientId: "c1" })).status).toBe(
          201,
        );
        const page = await call(ana, "GET", path);
        expect(page.body.messages.map((m: { body: string }) => m.body)).toContain("hello from postgres");

        const burst = await Promise.all(
          Array.from({ length: N }, () => call(ana, "POST", path, { body: "once", clientId: "same" })),
        );
        const ids = new Set(burst.map((r) => r.body.id));
        expect(ids.size).toBe(1);
        expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
        expect(burst.filter((r) => r.status === 200)).toHaveLength(N - 1);
        await settle(server);
        expect(runtime.routed.filter((id) => ids.has(id))).toHaveLength(1);
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );
});
