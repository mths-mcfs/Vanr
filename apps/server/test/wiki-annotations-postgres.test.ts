// The wiki's annotations and checks on a real Postgres, where transactions do run at once (PGlite runs one
// at a time, so it can't prove a lock): two decisions on the same change of a proposal, a decision that lands
// while the page is saved, comments at once on a page one short of the ceiling, and two checks of the same
// workspace. They run only in the CI `postgres` job (VANR_TEST_POSTGRES_URL). The CI runs the decision test
// a second time with VANR_TEST_WIKI_ANNOTATIONS_UNLOCKED=1, which swaps the row locks for unlocked reads,
// and expects it to fail by its result, so it can't pass without the locks it has.
import { describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { fakeProvider } from "@vanr/engine/models/fake";
import { count, eq, sql } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { pageBySlug, pageLock } from "../src/wiki";
import { annotationLock, createProposal, MAX_COMMENTS } from "../src/wiki-annotations";
import { CHECK_NOW_GAP_MS, checkWorkspace } from "../src/wiki-checks";
import { signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { wikiApi } from "./wiki-api";

const UNLOCKED = process.env.VANR_TEST_WIKI_ANNOTATIONS_UNLOCKED === "1";

let n = 0;
const email = (who: string) => `${who}${++n}@wiki-annotations-pg.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });

type PageRead = typeof pageLock.row;
type AnnotationRead = typeof annotationLock.row;
/** The page read with no row lock (a double of `pageLock.row`). */
const unlockedPage: PageRead = async (tx, id) => {
  const [row] = await tx.select().from(schema.knowledgePages).where(eq(schema.knowledgePages.id, id));
  return row ?? null;
};
/** The annotation read with no row lock (a double of `annotationLock.row`). */
const unlockedAnnotation: AnnotationRead = async (tx, id) => {
  const [row] = await tx.select().from(schema.pageAnnotations).where(eq(schema.pageAnnotations.id, id));
  return row ?? null;
};

/** A read whose first call holds its transaction, right after the read, until `release`. */
function holdFirst<A extends unknown[], R>(read: (...args: A) => Promise<R>) {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  const wrapped = async (...args: A): Promise<R> => {
    const found = await read(...args);
    if (!held) {
      held = true;
      reached();
      await gate;
    }
    return found;
  };
  return { read: wrapped, reached: reachedP, release };
}

/** Resolves once a session of this database waits for a lock; fails with `why` past a short deadline. */
async function waitingForLock(pg: RunningServer, why: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await pg.deps.db.execute(
      sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    );
    if (Array.isArray(rows) && rows.length) return;
    if (Date.now() > deadline) throw new Error(why);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "200",
    (e: { status?: number; code?: string }) => `${e.status} ${e.code}`,
  );

const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("wiki annotations on Postgres"), () => {
  test("two decisions on the same change, interleaved: the second waits for the first's lock and is rejected; the change lands once", async () => {
    const pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("wikidecide") } });
    const [page0, ann0] = [pageLock.row, annotationLock.row];
    try {
      const ana = withApi(await signedIn(pg, "Ana", email("ana")));
      const { workspaceId } = await seedWorkspace(pg, ana, "Decisions");
      const created = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Counter",
        body: "Value: 1.\n",
      });
      const page = await pageBySlug(pg.deps.db, { workspaceId, system: true }, created.slug);
      const { row } = await createProposal(pg.deps, {
        page,
        author: { type: "agent", id: "agt_lia", actingFor: ana.user.id },
        parentVersion: page.version,
        edits: [{ oldStr: "Value: 1.", newStr: "Value: 1. Value: 1." }],
        note: "",
      });
      // VANR_TEST_WIKI_ANNOTATIONS_UNLOCKED=1: both reads without their row lock (the CI expects a failure).
      if (UNLOCKED) pageLock.row = unlockedPage;
      const hold = holdFirst(UNLOCKED ? unlockedAnnotation : ann0);
      annotationLock.row = hold.read;
      const decide = () =>
        ana.api.wiki.decideWikiAnnotation(workspaceId, row.id, [{ hunkId: "h1", accept: true }]);
      const first = outcome(decide());
      await hold.reached;
      const second = outcome(decide());
      // The second waits for the page's lock the first holds (or, unlocked, ends without waiting).
      await Promise.race([second, waitingForLock(pg, "the second decision neither ended nor waited")]);
      hold.release();
      const results = [await first, await second];
      expect({ decide: results.join(",") }).toEqual({ decide: "200,409 wiki.proposal.decided" });
      const final = await ana.api.wiki.getWikiPage(workspaceId, created.slug);
      expect([final.body, final.version]).toEqual(["Value: 1. Value: 1.\n", 2]);
    } finally {
      pageLock.row = page0;
      annotationLock.row = ann0;
      await pg.stop();
    }
  }, 60_000);

  test("a decision that lands while the page is saved decides on the text that save left (both changes stay)", async () => {
    const pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("wikidecidesave") } });
    const page0 = pageLock.row;
    try {
      const ana = withApi(await signedIn(pg, "Ana", email("ana")));
      const { workspaceId } = await seedWorkspace(pg, ana, "Save race");
      const created = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Doc",
        body: "Alpha.\n\nBeta.\n",
      });
      const page = await pageBySlug(pg.deps.db, { workspaceId, system: true }, created.slug);
      const { row } = await createProposal(pg.deps, {
        page,
        author: { type: "agent", id: "agt_lia", actingFor: ana.user.id },
        parentVersion: page.version,
        edits: [{ oldStr: "Beta.", newStr: "Beta, proposed." }],
        note: "",
      });
      const hold = holdFirst(page0);
      pageLock.row = hold.read;
      const saving = outcome(
        ana.api.wiki.replaceWikiPage(workspaceId, created.slug, {
          body: "Alpha, saved.\n\nBeta.\n",
          parentVersion: 1,
        }),
      );
      await hold.reached;
      const deciding = outcome(
        ana.api.wiki.decideWikiAnnotation(workspaceId, row.id, [{ hunkId: "h1", accept: true }]),
      );
      await Promise.race([deciding, waitingForLock(pg, "the decision neither ended nor waited")]);
      hold.release();
      expect([await saving, await deciding]).toEqual(["200", "200"]);
      const final = await ana.api.wiki.getWikiPage(workspaceId, created.slug);
      expect([final.body, final.version]).toEqual(["Alpha, saved.\n\nBeta, proposed.\n", 3]);
    } finally {
      pageLock.row = page0;
      await pg.stop();
    }
  }, 60_000);

  test("comments at once on a page one short of the ceiling: exactly one gets in", async () => {
    const pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("wikicomments") } });
    try {
      const ana = withApi(await signedIn(pg, "Ana", email("ana")));
      const { workspaceId } = await seedWorkspace(pg, ana, "Ceiling");
      const beto = withApi(await memberOf(pg, workspaceId, "Beto", email("beto")));
      const created = await ana.api.wiki.createWikiPage(workspaceId, { title: "Busy", body: "text" });
      const page = await pageBySlug(pg.deps.db, { workspaceId, system: true }, created.slug);
      const now = new Date();
      await pg.deps.db.insert(schema.pageAnnotations).values(
        Array.from({ length: MAX_COMMENTS - 1 }, () => ({
          id: newId("ann"),
          workspaceId,
          pageId: page.id,
          kind: "comment" as const,
          author: { type: "person" as const, id: ana.user.id },
          body: "x",
          status: "open" as const,
          createdAt: now,
          updatedAt: now,
        })),
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          outcome(
            (i % 2 ? ana : beto).api.wiki.createWikiPageComment(workspaceId, created.slug, { body: `c${i}` }),
          ),
        ),
      );
      expect(results.filter((r) => r === "200")).toHaveLength(1);
      expect(results.filter((r) => r === "409 wiki.comment.too_many")).toHaveLength(7);
      const [total] = await pg.deps.db
        .select({ n: count() })
        .from(schema.pageAnnotations)
        .where(eq(schema.pageAnnotations.pageId, page.id));
      expect(total?.n).toBe(MAX_COMMENTS);
    } finally {
      await pg.stop();
    }
  }, 60_000);

  test("checks of the same workspace at once: one claims it", async () => {
    const pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("wikichecks") } });
    try {
      const ana = withApi(await signedIn(pg, "Ana", email("ana")));
      const { workspaceId } = await seedWorkspace(pg, ana, "Checks");
      await ana.api.wiki.createWikiPage(workspaceId, { title: "One", body: "[[Two]] [[reply:NONE]]" });
      await ana.api.wiki.createWikiPage(workspaceId, { title: "Two", body: "y" });
      const provider = fakeProvider();
      const runs = await Promise.all(
        Array.from({ length: 6 }, () =>
          checkWorkspace(pg.deps, workspaceId, { gapMs: CHECK_NOW_GAP_MS, model: async () => provider }),
        ),
      );
      expect(runs.filter(Boolean)).toHaveLength(1);
    } finally {
      await pg.stop();
    }
  }, 60_000);
});
