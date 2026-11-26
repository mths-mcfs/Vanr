// Messages and threads at the same time on a real Postgres, where the server's pool runs requests on several
// connections. Each guard here is one statement, not a lock: the unique index on (channel, author, clientId)
// keeps one message per resend, `reply_count + 1` counts every reply, and a thread's state action is one
// conditional UPDATE (the second click re-reads the row after the first one's commit and finds nothing to
// change). PGlite runs one statement at a time, so only this file shows them under real concurrency.
// These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { createWorkspace } from "../src/members";
import { postMessage } from "../src/messages";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 20;

async function withServer(prefix: string, run: (server: RunningServer) => Promise<void>) {
  const server = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl(prefix) } });
  try {
    await run(server);
  } finally {
    await server.stop();
  }
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("messages and threads at once on Postgres"), () => {
  test(
    "N sends of one clientId: one message; N replies: the root counts N; N closes: one wins",
    async () => {
      await withServer("msgs", async (server) => {
        const ana = await signedIn(server, "Ana", "ana@msgs.test");
        const { workspaceId, defaultChannelId } = await createWorkspace(server.deps.db, {
          name: "Msgs",
          context: "",
          user: ana.user,
        });
        const channel = await channelInWorkspace(server.deps.db, workspaceId, defaultChannelId);
        if (!channel) throw new Error("no channel");
        const post = (text: string, opts: { clientId?: string; threadId?: string } = {}) =>
          postMessage(server.deps, {
            workspaceId,
            channel,
            author: { type: "person", id: ana.user.id },
            body: text,
            clientId: opts.clientId ?? null,
            threadId: opts.threadId ?? null,
          });

        const resent = await Promise.all(Array.from({ length: N }, () => post("once", { clientId: "same" })));
        expect(new Set(resent.map((r) => r.message.id)).size).toBe(1);
        expect(resent.filter((r) => r.created)).toHaveLength(1);

        const { message: root } = await post("root");
        await Promise.all(Array.from({ length: N }, (_, i) => post(`reply ${i}`, { threadId: root.id })));
        const [counted] = await server.deps.db
          .select({ replyCount: schema.messages.replyCount })
          .from(schema.messages)
          .where(eq(schema.messages.id, root.id));
        expect(counted?.replyCount).toBe(N);

        const act = (action: string) =>
          ana.browser.json(`/api/v1/workspaces/${workspaceId}/threads/${root.id}/${action}`, "POST");
        const closes = await Promise.all(Array.from({ length: N }, () => act("close")));
        expect(closes.filter((r) => r.status === 200)).toHaveLength(1);
        expect(closes.filter((r) => r.status === 409)).toHaveLength(N - 1);
        expect((await act("reopen")).status).toBe(200);
        const asked = Array.from({ length: N }, (_, i) => (i % 2 ? "archive" : "close"));
        const mixed = await Promise.all(asked.map(act));
        // Counted by the action asked: the body is read after the write and may show the other one's state.
        const won = asked.filter((_, i) => mixed[i]?.status === 200);
        // close then archive is a valid order; once an archive went through nothing closes the thread again.
        expect(won.filter((s) => s === "archive").length).toBeLessThanOrEqual(1);
        expect(won.filter((s) => s === "close").length).toBeLessThanOrEqual(1);
        const [state] = await server.deps.db
          .select({ state: schema.threads.state })
          .from(schema.threads)
          .where(eq(schema.threads.id, root.id));
        expect(state?.state).toBe(won.includes("archive") ? "archived" : "closed");
      });
    },
    SERVER_TEST_MS * 2,
  );
});
