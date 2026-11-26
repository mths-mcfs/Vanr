// The send queue on a real Postgres, where the server's pool runs the passes on several connections at once. Each
// guard is one statement, not a lock: the claim of an item is one conditional UPDATE (`pending` -> `sending`), and
// so is the cancel (`pending` -> `canceled`), so the second writer re-reads the row after the first one's commit and
// finds nothing to take. PGlite runs one statement at a time; outbox.test.ts fails there on the same race without
// the condition. These run only in the CI postgres job.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq, inArray } from "drizzle-orm";
import type { AppDeps } from "../src/context";
import { createWorkspace } from "../src/members";
import { cancelQueued, deliverDue } from "../src/outbox";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { DROP_LOCKS, outcome } from "./lock-double";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);
const N = 12;
const ITEMS = 10;

async function withServer(prefix: string, run: (server: RunningServer) => Promise<void>) {
  const server = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl(prefix) } });
  try {
    await run(server);
  } finally {
    await server.stop();
  }
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("the send queue at once on Postgres"), () => {
  test(
    "N passes at once deliver each due post once; N cancels racing a pass: each item is canceled or sent, never both",
    async () => {
      await withServer("outbox", async (server) => {
        const { db } = server.deps;
        const ana = await signedIn(server, "Ana", "ana@outbox-pg.test");
        const { workspaceId, defaultChannelId } = await createWorkspace(db, {
          name: "Outbox",
          context: "",
          user: ana.user,
        });
        const agentId = newId("agt");
        await db.insert(schema.agents).values({
          id: agentId,
          workspaceId,
          name: "Lia",
          handle: "lia",
          model: "claude-haiku-5-5",
          ownerUserId: ana.user.id,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        });
        const queue = async (label: string) => {
          const ids = Array.from({ length: ITEMS }, () => newId("out"));
          await db.insert(schema.outbox).values(
            ids.map((id, i) => ({
              id,
              workspaceId,
              agentId,
              runId: null,
              kind: "post" as const,
              payload: { channelId: defaultChannelId, text: `${label} ${i}`, clientId: `${label}-${i}` },
              sendAt: new Date(Date.now() - 1000),
            })),
          );
          return ids;
        };
        const posted = async (prefix: string) =>
          (await db.select().from(schema.messages).where(eq(schema.messages.channelId, defaultChannelId)))
            .map((m) => m.body)
            .filter((b) => b.startsWith(prefix));

        const first = await queue("pass");
        const counts = await Promise.all(Array.from({ length: N }, () => deliverDue(server.deps)));
        expect(counts.reduce((a, b) => a + b, 0)).toBe(ITEMS);
        const bodies = await posted("pass ");
        expect(bodies).toHaveLength(ITEMS);
        expect(new Set(bodies).size).toBe(ITEMS);
        const rows = await db.select().from(schema.outbox).where(inArray(schema.outbox.id, first));
        expect(rows.every((r) => r.status === "sent")).toBe(true);

        const raced = await queue("race");
        const outcome = await Promise.allSettled([
          ...Array.from({ length: N / 2 }, () => deliverDue(server.deps)),
          ...raced.map((id) => cancelQueued(server.deps, workspaceId, id, ana.user.id)),
        ]);
        const canceled = outcome.slice(N / 2).filter((o) => o.status === "fulfilled").length;
        const after = await db.select().from(schema.outbox).where(inArray(schema.outbox.id, raced));
        const sent = after.filter((r) => r.status === "sent").length;
        expect(after.filter((r) => r.status === "canceled")).toHaveLength(canceled);
        expect(sent + canceled).toBe(ITEMS);
        expect(await posted("race ")).toHaveLength(sent);
      });
    },
    SERVER_TEST_MS * 2,
  );
});

// biome-ignore lint/suspicious/noExplicitAny: the double wraps drizzle's builders, whatever their type
type Any = any;

/** The outbox id an `eq(outbox.id, ...)` inside a drizzle condition binds. */
function outboxIdIn(node: Any): string | null {
  if (!node || typeof node !== "object") return null;
  if (typeof node.value === "string" && node.value.startsWith("out_")) return node.value;
  for (const chunk of node.queryChunks ?? []) {
    const found = outboxIdIn(chunk);
    if (found) return found;
  }
  return null;
}

/**
 * The database as one pass sees it in the forced test: it holds the pass after reading the due list until every
 * pass read it (so they all claim the same items) and, with VANR_TEST_DROP_LOCKS=1, claims an item by its id alone,
 * without `status = 'pending'`, so CI sees the test fail without the condition.
 */
function forcedDb(deps: AppDeps, read: () => Promise<void>): AppDeps["db"] {
  return new Proxy(deps.db, {
    get(target, prop) {
      if (prop === "select")
        return (fields: Any) => {
          const query: Any = target.select(fields);
          return {
            from(table: Any) {
              const q: Any = query.from(table);
              if (table !== schema.outbox) return q;
              return {
                where: (...w: Any[]) => ({
                  orderBy: (...o: Any[]) => ({
                    limit: async (n: number) => {
                      const rows = await q
                        .where(...w)
                        .orderBy(...o)
                        .limit(n);
                      await read();
                      return rows;
                    },
                  }),
                }),
              };
            },
          };
        };
      if (prop === "update" && DROP_LOCKS)
        return (table: Any) => {
          const builder: Any = target.update(table);
          if (table !== schema.outbox) return builder;
          return {
            set(values: Any) {
              const set: Any = builder.set(values);
              if (values.status !== "sending") return set;
              return { where: (cond: Any) => set.where(eq(schema.outbox.id, outboxIdIn(cond) ?? "")) };
            },
          };
        };
      return Reflect.get(target, prop, target);
    },
  });
}

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("forced: the send queue's claim on Postgres"), () => {
  test(
    "forced: passes that all read the same due items claim each one once",
    async () => {
      await withServer("forced_outbox", async (server) => {
        const { db } = server.deps;
        const ana = await signedIn(server, "Ana", "ana@forced-outbox.test");
        const { workspaceId, defaultChannelId } = await createWorkspace(db, {
          name: "Forced",
          context: "",
          user: ana.user,
        });
        const agentId = newId("agt");
        await db.insert(schema.agents).values({
          id: agentId,
          workspaceId,
          name: "Lia",
          handle: "lia",
          model: "claude-haiku-5-5",
          ownerUserId: ana.user.id,
          appearance: { color: "blue", eyes: "dot", adornment: "none" },
        });
        await db.insert(schema.outbox).values(
          Array.from({ length: ITEMS }, (_, i) => ({
            id: newId("out"),
            workspaceId,
            agentId,
            runId: null,
            kind: "post" as const,
            payload: { channelId: defaultChannelId, text: `forced ${i}`, clientId: `forced-${i}` },
            sendAt: new Date(Date.now() - 1000),
          })),
        );
        const passes = 3;
        let reads = 0;
        let allRead!: () => void;
        const barrier = new Promise<void>((r) => {
          allRead = r;
        });
        const read = async () => {
          if (++reads === passes) allRead();
          await barrier;
        };
        const counts = await Promise.all(
          Array.from({ length: passes }, () =>
            deliverDue({ ...server.deps, db: forcedDb(server.deps, read) }),
          ),
        );
        outcome(
          "outbox",
          counts.reduce((a, b) => a + b, 0),
          ITEMS,
        );
      });
    },
    SERVER_TEST_MS * 2,
  );
});
