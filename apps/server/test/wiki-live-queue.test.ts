// The live wiki's page queue and its automatic retries: an update that arrives while a discard or a publish
// holds the page waits and is applied after it (acknowledged only then), a publish cleans the draft only if
// nothing came in since its snapshot, the queue has a cap, a deadlock in a write answers wiki.busy, the
// automatic publish and draft save try again and say so when they give up, a slow stop warns on its own
// timer, and every write changes the shared document only after its transaction committed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { log } from "../src/logger";
import type { RunningServer } from "../src/server";
import { pageBySlug } from "../src/wiki";
import { CLOSE_MS, LIVE_LIMITS, RETRY_MS } from "../src/wiki-collab";
import { wikiMarkdown } from "../src/wiki-md";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { apiError, wikiApi } from "./wiki-api";
import {
  authMessage,
  connect,
  paragraphUpdate,
  rawSocket,
  unloaded,
  until,
  updateMessage,
} from "./wiki-live";

/** The idle publish's delay in this file: unique, so a test can find its timer. */
const IDLE_MS = 137_777;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ wikiDebounceMs: 600_000, wikiIdlePublishMs: IDLE_MS });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@live-queue.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });
const docName = (workspaceId: string, slug: string) => `wiki/${workspaceId}/${slug}`;

async function team(srv = server) {
  const ana = withApi(await signedIn(srv, "Ana", email("ana")));
  const { workspaceId } = await seedWorkspace(srv, ana, "Queue");
  const beto = withApi(await memberOf(srv, workspaceId, "Beto", email("beto")));
  return { workspaceId, ana, beto };
}

async function storedDraft(srv: RunningServer, workspaceId: string, slug: string) {
  const page = await pageBySlug(srv.deps.db, workspaceId, slug);
  const [d] = await srv.deps.db
    .select()
    .from(schema.wikiPageDocs)
    .where(eq(schema.wikiPageDocs.pageId, page.id));
  if (!d) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(d.state, "base64")));
  const md = await wikiMarkdown();
  return { ...d, text: md.serialize(md.fromYDoc(doc)) };
}

/**
 * Holds the server's next database transaction until `release`: `before` it starts, or `after` its callback
 * ran (still open, before the commit), or `committed` (after the commit, before the caller goes on).
 */
function holdNextTransaction(srv: RunningServer, when: "before" | "after" | "committed") {
  const { db } = srv.deps;
  const original = db.transaction.bind(db);
  let begun!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => {
    begun = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  db.transaction = (async (fn: Parameters<typeof original>[0], ...rest: unknown[]) => {
    db.transaction = original;
    if (when === "before") {
      begun();
      await gate;
      return original(fn, ...(rest as []));
    }
    if (when === "after")
      return original(
        async (tx) => {
          const result = await fn(tx);
          begun();
          await gate;
          return result;
        },
        ...(rest as []),
      );
    const result = await original(fn, ...(rest as []));
    begun();
    await gate;
    return result;
  }) as typeof original;
  return { started, release, restore: () => (db.transaction = original) };
}

/** The next `count` transactions fail the way Postgres aborts a deadlock (SQLSTATE 40P01). */
function deadlockNext(srv: RunningServer, count: number, code = "40P01") {
  const { db } = srv.deps;
  const original = db.transaction.bind(db);
  let left = count;
  db.transaction = (async (...args: Parameters<typeof original>) => {
    if (left > 0) {
      left--;
      if (left === 0) db.transaction = original;
      throw Object.assign(new Error("injected deadlock"), { code });
    }
    return original(...args);
  }) as typeof original;
  return () => (db.transaction = original);
}

/** Captures the timers with these delays (they don't run on their own): `fire` runs the latest one. */
function captureTimers(delays: readonly number[]) {
  const real = globalThis.setTimeout;
  const caught: { ms: number; run: () => void }[] = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined && delays.includes(ms)) {
      caught.push({ ms, run: () => fn(...args) });
      return real(() => {}, 0);
    }
    return real(fn, ms, ...args);
  }) as typeof setTimeout;
  return {
    caught,
    fire(ms: number) {
      const i = caught.findLastIndex((t) => t.ms === ms);
      const [t] = caught.splice(i, 1);
      if (!t) throw new Error(`no timer of ${ms} ms`);
      t.run();
    },
    restore: () => (globalThis.setTimeout = real),
  };
}

describe("the page's queue", () => {
  test.each([
    ["before", "append"],
    ["committed", "append"],
    ["before", "removed paragraph"],
    ["committed", "removed paragraph"],
  ] as const)(
    "a concurrent edit waits for discard (%s its commit, %s), then is applied or explicitly refused",
    async (when, edit) => {
      const { workspaceId, ana, beto } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, {
        title: `Discard ${when}`,
        body: "Original.\n",
      });
      const name = docName(workspaceId, page.slug);
      const a = connect(server, ana.browser, workspaceId, name);
      const b = connect(server, beto.browser, workspaceId, name);
      await Promise.all([a.synced, b.synced]);
      await a.edit(() => "Original.\n\nOld shared draft.\n");
      await until(() => !a.provider.hasUnsyncedChanges);
      await until(async () => (await b.md()).includes("Old shared"));
      const hold = holdNextTransaction(server, when);
      const discarding = ana.api.wiki.deleteWikiPageDraft(workspaceId, page.slug);
      await hold.started;
      const acks = b.syncStatus.length;
      await b.edit((md) =>
        edit === "append"
          ? `${md.trimEnd()}\n\nNEW EDIT DURING THE DISCARD.\n`
          : md.replace("Old shared draft.", "NEW EDIT DURING THE DISCARD."),
      );
      // Not acknowledged while the discard holds the page: it isn't applied yet.
      expect(b.syncStatus.length).toBe(acks);
      hold.release();
      await discarding;
      await until(() => b.syncStatus.length > acks);
      expect(b.syncStatus.at(-1)).toBe(edit === "append");
      if (edit === "append") await until(async () => (await a.md()).includes("NEW EDIT DURING THE DISCARD."));
      else {
        await until(() => b.closeCodes.includes(4412));
        expect(await a.md()).not.toContain("NEW EDIT DURING THE DISCARD.");
      }
      expect(await a.md()).not.toContain("Old shared draft.");
      a.close();
      b.close();
    },
  );

  test("a discard queued behind a publish restores the version that publish committed", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Queued discard",
      body: "Original.\n",
    });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    await a.edit(() => "Published edit.\n");
    await until(() => !a.provider.hasUnsyncedChanges);
    const row = await pageBySlug(server.deps.db, workspaceId, page.slug);
    const hold = holdNextTransaction(server, "before");
    const publishing = ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    await hold.started;
    const discarding = server.deps.wikiLive.discard(row, { type: "person", id: ana.user.id }, true);
    hold.release();
    await publishing;
    await discarding;
    expect(await a.md()).toBe("Published edit.\n");
    expect(await storedDraft(server, workspaceId, page.slug)).toMatchObject({
      parentVersion: 2,
      dirty: false,
      text: "Published edit.\n",
    });
    a.close();
  });

  test("a removed member cannot discard an unlocked page's shared draft", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Removed discard",
      body: "Original.\n",
    });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    await a.edit(() => "Shared work.\n");
    await until(() => !a.provider.hasUnsyncedChanges);
    const hold = holdNextTransaction(server, "before");
    const discarding = apiError(beto.api.wiki.deleteWikiPageDraft(workspaceId, page.slug));
    await hold.started;
    await server.deps.db
      .delete(schema.members)
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, beto.user.id)));
    hold.release();
    expect((await discarding).status).toBe(403);
    expect(await a.md()).toBe("Shared work.\n");
    a.close();
  });

  test("a publish cleans the draft only if nothing came in since its snapshot: a later edit stays dirty and is published next", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Clean race", body: "Original.\n" });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    // A draft equal to the page: the publish only saves it clean.
    await a.edit(() => "Temporary.\n");
    await until(() => !a.provider.hasUnsyncedChanges);
    await a.edit(() => "Original.\n");
    await until(() => !a.provider.hasUnsyncedChanges);
    await server.deps.wikiLive.settled();
    const hold = holdNextTransaction(server, "committed");
    const publishing = ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    await hold.started;
    await a.edit(() => "NEW EDIT DURING THE PUBLISH.\n");
    hold.release();
    await publishing;
    await until(() => !a.provider.hasUnsyncedChanges);
    const again = await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    expect(again).toMatchObject({ version: 2, body: "NEW EDIT DURING THE PUBLISH.\n" });
    a.close();
  });

  test("past LIVE_LIMITS.pendingUpdates waiting operations, an update is rejected and its socket closes (4412)", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Full queue", body: "Original.\n" });
    const name = docName(workspaceId, page.slug);
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    const saved = LIVE_LIMITS.pendingUpdates;
    const first = await rawSocket(server, ana.browser, workspaceId);
    const second = await rawSocket(server, ana.browser, workspaceId);
    first.ws.send(authMessage(name));
    second.ws.send(authMessage(name));
    expect(await first.authenticated(name)).toBe(true);
    expect(await second.authenticated(name)).toBe(true);
    const hold = holdNextTransaction(server, "before");
    try {
      LIVE_LIMITS.pendingUpdates = 2;
      // The discard holds the queue (1); the first update waits behind it (2); the second finds it full.
      const discarding = ana.api.wiki.deleteWikiPageDraft(workspaceId, page.slug);
      await hold.started;
      first.ws.send(updateMessage(name, paragraphUpdate("FIRST")));
      await until(() => first.received.length > 0 && true);
      second.ws.send(updateMessage(name, paragraphUpdate("SECOND")));
      expect(await second.closed).toBe(4412);
      hold.release();
      await discarding;
      expect(await first.synced(name)).toBe(true);
    } finally {
      LIVE_LIMITS.pendingUpdates = saved;
      hold.release();
      hold.restore();
    }
    first.ws.close();
    a.close();
  });
});

describe("deadlocks and the automatic retries", () => {
  for (const code of ["40P01", "40001"])
    test(`a wiki write the database aborts (${code}) answers 409 wiki.busy, never a 500`, async () => {
      const { workspaceId, ana } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: `Busy ${code}`, body: "x" });
      const restore = deadlockNext(server, 1, code);
      try {
        const err = await apiError(
          ana.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: "y", parentVersion: 1 }),
        );
        expect([err.status, err.code]).toEqual([409, "wiki.busy"]);
      } finally {
        restore();
      }
      expect(
        (await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: "y", parentVersion: 1 })).version,
      ).toBe(2);
    });

  test("an idle publish the database aborts tries again after RETRY_MS and publishes", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Retry publish",
      body: "Original.\n",
    });
    const timers = captureTimers([IDLE_MS, ...RETRY_MS]);
    try {
      const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
      await a.synced;
      await a.edit(() => "Edited, to publish.\n");
      await until(() => !a.provider.hasUnsyncedChanges);
      await until(() => timers.caught.some((t) => t.ms === IDLE_MS));
      const restore = deadlockNext(server, 1);
      timers.fire(IDLE_MS);
      await until(() => timers.caught.some((t) => t.ms === RETRY_MS[0]));
      restore();
      expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version).toBe(1);
      timers.fire(RETRY_MS[0]);
      await until(async () => (await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version === 2);
      expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).body).toBe("Edited, to publish.\n");
      a.close();
    } finally {
      timers.restore();
    }
  });

  test("out of tries, the draft stays dirty and the editors hear that the page wasn't published", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Give up", body: "Original.\n" });
    const timers = captureTimers([IDLE_MS, ...RETRY_MS]);
    try {
      const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
      await a.synced;
      await a.edit(() => "Never published.\n");
      await until(() => !a.provider.hasUnsyncedChanges);
      await until(() => timers.caught.some((t) => t.ms === IDLE_MS));
      // Every try fails: the first and one per RETRY_MS step.
      const restore = deadlockNext(server, RETRY_MS.length + 1);
      try {
        timers.fire(IDLE_MS);
        for (const ms of RETRY_MS) {
          await until(() => timers.caught.some((t) => t.ms === ms));
          timers.fire(ms);
        }
        await until(() => a.stateless.some((m) => m.type === "publish_failed"));
      } finally {
        restore();
      }
      await server.deps.wikiLive.settled();
      expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version).toBe(1);
      expect(a.stateless.some((m) => m.type === "published")).toBe(false);
      a.close();
    } finally {
      timers.restore();
    }
  });

  test(
    "a draft save the database aborts tries again after RETRY_MS and saves",
    async () => {
      const quick = await startTestServer({ wikiDebounceMs: 20, wikiIdlePublishMs: IDLE_MS });
      const timers = captureTimers([...RETRY_MS]);
      try {
        const { workspaceId, ana } = await team(quick);
        const page = await ana.api.wiki.createWikiPage(workspaceId, {
          title: "Retry save",
          body: "Original.\n",
        });
        const a = connect(quick, ana.browser, workspaceId, docName(workspaceId, page.slug));
        await a.synced;
        await quick.deps.wikiLive.settled();
        const restore = deadlockNext(quick, 1);
        await a.edit(() => "Saved on the second try.\n");
        await until(() => timers.caught.some((t) => t.ms === RETRY_MS[0]));
        restore();
        expect((await storedDraft(quick, workspaceId, page.slug))?.text).not.toContain("second try");
        timers.fire(RETRY_MS[0]);
        await until(
          async () =>
            (await storedDraft(quick, workspaceId, page.slug))?.text.includes("second try") ?? false,
        );
        deadlockNext(quick, 1);
        await a.edit(() => "Discarded edit.\n");
        await until(() => timers.caught.some((t) => t.ms === RETRY_MS[0]));
        await ana.api.wiki.deleteWikiPageDraft(workspaceId, page.slug);
        a.close();
        await unloaded(quick);
        timers.fire(RETRY_MS[0]);
        await quick.deps.wikiLive.settled();
        expect(await storedDraft(quick, workspaceId, page.slug)).toMatchObject({
          dirty: false,
          editors: [],
          text: "Original.\n",
        });
      } finally {
        timers.restore();
        await quick.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "a stop held by an operation warns on its own timer while it keeps waiting",
    async () => {
      const srv = await startTestServer();
      const timers = captureTimers([CLOSE_MS]);
      const { db } = srv.deps;
      const select = db.select.bind(db);
      const errors: string[] = [];
      const logError = log.error;
      log.error = (msg, fields) => {
        errors.push(msg);
        logError(msg, fields);
      };
      let release = () => {};
      try {
        const { workspaceId, ana } = await team(srv);
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Slow stop", body: "x" });
        const raw = await rawSocket(srv, ana.browser, workspaceId);
        let begun!: () => void;
        const started = new Promise<void>((r) => {
          begun = r;
        });
        const gate = new Promise<void>((r) => {
          release = r;
        });
        // The socket's first right read is held after it ran, before its rows come back.
        db.select = ((...args: Parameters<typeof select>) => {
          const query = select(...args);
          const from = query.from.bind(query);
          query.from = ((table: unknown) => {
            const built = from(table as never);
            if (table === schema.sessions) {
              const where = built.where.bind(built);
              built.where = ((...params: Parameters<typeof where>) => {
                const result = where(...params);
                const then = result.then.bind(result);
                // biome-ignore lint/suspicious/noThenProperty: the query is a thenable; this holds its rows until released
                result.then = ((ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
                  then(async (rows: unknown) => {
                    begun();
                    await gate;
                    return rows;
                  }).then(ok, ko)) as typeof result.then;
                return result;
              }) as typeof built.where;
            }
            return built;
          }) as typeof query.from;
          return query;
        }) as typeof db.select;
        raw.ws.send(authMessage(docName(workspaceId, page.slug)));
        await started;
        let returned = false;
        const stopping = srv.stop().then(() => {
          returned = true;
        });
        await until(() => timers.caught.some((t) => t.ms === CLOSE_MS));
        timers.fire(CLOSE_MS);
        expect(errors).toContain("wiki.close_slow");
        expect(returned).toBe(false);
        release();
        await stopping;
        raw.ws.close();
      } finally {
        release();
        db.select = select;
        log.error = logError;
        timers.restore();
        await srv.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );
});

describe("a write changes the shared document only after its transaction committed", () => {
  test("a version saved by the route reaches the open document only once it committed", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "After commit",
      body: "Original.\n",
    });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    const hold = holdNextTransaction(server, "after");
    const saving = ana.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: "Saved.\n",
      parentVersion: 1,
    });
    await hold.started;
    // Given time to (a bounded wait for something that must not happen), the open document didn't change.
    await until(async () => (await a.md()).includes("Saved."), 2000).catch(() => undefined);
    expect(await a.md()).not.toContain("Saved.");
    hold.release();
    await saving;
    await until(async () => (await a.md()).includes("Saved."));
    a.close();
  });

  test("a trash the route rejects (not the creator) leaves the open sessions alone", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Not yours", body: "x" });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    expect((await apiError(beto.api.wiki.deleteWikiPage(workspaceId, page.slug))).status).toBe(403);
    await until(() => a.closeCodes.length > 0, 2000).catch(() => undefined);
    expect(a.closeCodes).toEqual([]);
    a.close();
  });

  test(
    "a clean publish the lock rejects in its transaction leaves the session dirty: the end-of-session publish, by the admin who typed, saves it clean",
    async () => {
      // A quick autosave: the dirty draft is in the database before the publish.
      const quick = await startTestServer({ wikiDebounceMs: 20, wikiIdlePublishMs: IDLE_MS });
      try {
        const { workspaceId, ana, beto } = await team(quick);
        const page = await ana.api.wiki.createWikiPage(workspaceId, {
          title: "Clean reject",
          body: "Original.\n",
        });
        const a = connect(quick, ana.browser, workspaceId, docName(workspaceId, page.slug));
        await a.synced;
        await a.edit(() => "Temporary.\n");
        await until(() => !a.provider.hasUnsyncedChanges);
        await a.edit(() => "Original.\n");
        await until(() => !a.provider.hasUnsyncedChanges);
        await until(async () => (await storedDraft(quick, workspaceId, page.slug))?.dirty === true);
        await quick.deps.wikiLive.settled();
        const hold = holdNextTransaction(quick, "before");
        const publishing = apiError(beto.api.wiki.publishWikiPageDraft(workspaceId, page.slug));
        await hold.started;
        await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
        hold.release();
        expect((await publishing).code).toBe("wiki.page_locked");
        expect((await storedDraft(quick, workspaceId, page.slug))?.dirty).toBe(true);
        // Still dirty in memory: closing the session publishes on behalf of the admin who typed, which saves
        // the draft clean. A session wrongly marked clean would skip that publish and leave it dirty.
        a.close();
        await until(async () => (await storedDraft(quick, workspaceId, page.slug))?.dirty === false);
      } finally {
        await quick.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );

  test("a publish by the button the lock rejects in its transaction leaves the draft to publish: the admin's publish does", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Button reject",
      body: "Original.\n",
    });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    await a.edit(() => "To publish.\n");
    await until(() => !a.provider.hasUnsyncedChanges);
    const hold = holdNextTransaction(server, "before");
    const publishing = apiError(beto.api.wiki.publishWikiPageDraft(workspaceId, page.slug));
    await hold.started;
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    hold.release();
    expect((await publishing).code).toBe("wiki.page_locked");
    expect(await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug)).toMatchObject({
      version: 2,
      body: "To publish.\n",
    });
    a.close();
  });

  test("an idle publish the lock rejects leaves the draft to publish: the admin's publish does", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Idle reject",
      body: "Original.\n",
    });
    const name = docName(workspaceId, page.slug);
    const timers = captureTimers([IDLE_MS]);
    try {
      const a = connect(server, ana.browser, workspaceId, name);
      const b = connect(server, beto.browser, workspaceId, name);
      await Promise.all([a.synced, b.synced]);
      // Only the member edits: the idle publish's lock is decided by him.
      await b.edit(() => "By the member.\n");
      await until(() => !b.provider.hasUnsyncedChanges);
      await until(() => timers.caught.some((t) => t.ms === IDLE_MS));
      await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
      timers.fire(IDLE_MS);
      await server.deps.wikiLive.settled();
      expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version).toBe(1);
      expect(await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug)).toMatchObject({
        version: 2,
        body: "By the member.\n",
      });
      a.close();
      b.close();
      await unloaded(server);
    } finally {
      timers.restore();
    }
  });
});
