// The search's vector leg as the boot turns it on: `ensureVector` runs before the app takes requests when an
// embedder is configured. On a real Postgres with pgvector (the CI `postgres` job) the vector column exists
// right after the boot, the tick embeds only what may go to an outside service (workspace and public channel
// chunks) and the ledger records it as `search`. On PGlite there is no pgvector: the server boots and the
// search stays lexical and by name.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq, sql } from "drizzle-orm";
import { body, signedIn, startTestServer, waitFor } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { type Person, seedChannel, seedWorkspace } from "./seed";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

async function document(who: Person, workspaceId: string, markdown: string, channelId?: string) {
  const res = await who.browser.json(`${W(workspaceId)}/files`, "POST", {
    title: "Notes",
    content: { kind: "document", markdown },
    ...(channelId ? { channelId } : {}),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return body(res);
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("vector search on Postgres"), () => {
  test("the boot turns the vector on; the tick embeds only workspace and public chunks and records them in the ledger", async () => {
    const url = await testDatabaseUrl("vec");
    const server = await startTestServer({
      env: { DATABASE_URL: url, SEARCH_EMBEDDER: "fake" },
      fileServicesMs: 20,
    });
    try {
      const column = await server.deps.db.execute(
        sql`select 1 from information_schema.columns where table_name = 'search_chunks' and column_name = 'embedding'`,
      );
      expect(Array.isArray(column) ? column.length : 0).toBe(1);
      const ana = await signedIn(server, "Ana", "ana@search-postgres.test");
      const { workspaceId } = await seedWorkspace(server, ana, "Vectors");
      const board = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const open = await document(ana, workspaceId, "harbor expansion roadmap for the spring");
      const secret = await document(ana, workspaceId, "board salary negotiation notes", board);
      const state = async (id: string) =>
        (
          await server.deps.db
            .select({ s: schema.searchChunks.embedState })
            .from(schema.searchChunks)
            .where(eq(schema.searchChunks.sourceId, id))
        ).map((r) => r.s);
      await waitFor(async () => (await state(open.id)).join() === "done");
      expect(await state(secret.id)).toEqual(["none"]);
      const lines = await server.deps.db
        .select()
        .from(schema.usageLines)
        .where(eq(schema.usageLines.workspaceId, workspaceId));
      expect(lines.map((l) => l.source)).toContain("search");
      const hits = await body(await ana.browser.fetch(`${W(workspaceId)}/search?q=harbor`));
      expect(hits.hits[0]).toMatchObject({ kind: "file", sourceId: open.id });
    } finally {
      await server.stop();
    }
  }, 30_000);
});

describe("vector search without pgvector", () => {
  test("PGlite with the fake embedder boots without the vector leg and the search still finds by word", async () => {
    const server = await startTestServer({ env: { SEARCH_EMBEDDER: "fake" } });
    try {
      expect(await server.deps.search.ensureVector()).toBe(false);
      const ana = await signedIn(server, "Ana", "ana@search-pglite.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Lexical");
      const doc = await document(ana, workspaceId, "lighthouse maintenance schedule", general);
      await server.deps.db.execute(sql`select 1`);
      const hits = await body(await ana.browser.fetch(`${W(workspaceId)}/search?q=lighthouse`));
      expect(hits.hits.map((h: { sourceId: string }) => h.sourceId)).toEqual([doc.id]);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
