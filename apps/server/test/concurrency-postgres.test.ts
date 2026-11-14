// Invitations and notices at the same time on a real Postgres: the server's pool runs the requests on several
// connections at once, so the invitee's lock (pg_advisory_xact_lock) and the group's row lock (FOR UPDATE) are
// what keeps one pending invitation per email and every notice counted. These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { sha256Hex } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { createWorkspace, joinWorkspace } from "../src/members";
import { notify } from "../src/notifications";
import { Browser, body, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 20;

describe.skipIf(!TEST_POSTGRES_URL)(
  onPostgres("the same invitee and the same group at once on Postgres"),
  () => {
    test("N invitations to one email: one pending and only its link works; N notices of one group: count N", async () => {
      const server = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("same") } });
      try {
        const ana = await signedIn(server, "Ana", "ana@same.test");
        const { workspaceId } = await createWorkspace(server.deps.db, {
          name: "Same",
          context: "",
          user: ana.user,
        });
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            ana.browser.json(`/api/v1/workspaces/${workspaceId}/invitations`, "POST", {
              email: i % 2 ? " Pat@Same.test" : "pat@same.test",
              role: i % 2 ? "admin" : "member",
            }),
          ),
        );
        const urls: string[] = [];
        for (const r of results) {
          expect(r.status).toBe(201);
          urls.push((await body(r)).url);
        }
        const pending = await server.deps.db
          .select()
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.workspaceId, workspaceId),
              eq(schema.invitations.email, "pat@same.test"),
              eq(schema.invitations.status, "pending"),
            ),
          );
        expect(pending.length).toBe(1);
        const anon = new Browser(server.url);
        const alive: string[] = [];
        for (const u of urls) {
          const token = u.split("/invite/")[1] ?? "";
          if ((await anon.fetch(`/api/v1/invitations/${token}`)).status === 200) alive.push(token);
        }
        expect(alive.length).toBe(1);
        expect(sha256Hex(alive[0] ?? "")).toBe(pending[0]?.tokenHash ?? "");

        const beto = await signedIn(server, "Beto", "beto@same.test");
        await joinWorkspace(server.deps.db, {
          workspaceId,
          userId: beto.user.id,
          name: "Beto",
          role: "member",
        });
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            notify(server.deps, {
              workspaceId,
              userId: beto.user.id,
              kind: "dm",
              groupKey: "dm:same",
              actor: { type: "person", id: ana.user.id },
              source: {},
              latest: { text: `message ${i}` },
            }),
          ),
        );
        await server.deps.runtime.settle();
        const rows = await server.deps.db
          .select()
          .from(schema.notifications)
          .where(
            and(eq(schema.notifications.userId, beto.user.id), eq(schema.notifications.groupKey, "dm:same")),
          );
        expect(rows.length).toBe(1);
        expect(rows[0]?.count).toBe(N);
      } finally {
        await server.stop();
      }
    }, 60_000);
  },
);
