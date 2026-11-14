// The live wiki's guards: a connection doesn't outlive the right that opened it (removed, signed out, session
// expired, demoted, page locked), every draft save checks again who is in it, nothing over MAX_BODY is stored
// or relayed, and the socket survives what a client shouldn't send (a malformed message, an unknown type, an
// invalid Yjs update, an update before its authentication or for another document). Then the stop: the
// draft is saved, an automatic publish in progress ends, nothing is written once the database closes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { log } from "../src/logger";
import type { RunningServer } from "../src/server";
import { MAX_BODY, pageBySlug, savePage } from "../src/wiki";
import { COLLAB_PATH, MAX_UPDATE, RIGHT_TTL_MS } from "../src/wiki-collab";
import { wikiMarkdown, YFRAGMENT } from "../src/wiki-md";
import { type Browser, holdNextIndexWrite, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { apiError, wikiApi } from "./wiki-api";
import { connect, unloaded, until } from "./wiki-live";

let server: RunningServer;
/** The injected clock's offset: moving it past RIGHT_TTL_MS makes the next message read the right again. */
let skew = 0;
beforeAll(async () => {
  server = await startTestServer({ wikiDebounceMs: 50, now: () => new Date(Date.now() + skew) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@live-guards.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });

async function team(srv = server) {
  const ana = withApi(await signedIn(srv, "Ana", email("ana")));
  const { workspaceId } = await seedWorkspace(srv, ana, "Guards");
  const beto = withApi(await memberOf(srv, workspaceId, "Beto", email("beto")));
  return { workspaceId, ana, beto };
}

const BODY = "# Plan\n\nOne.\n\nTwo.\n";
const docName = (workspaceId: string, slug: string) => `wiki/${workspaceId}/${slug}`;

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

const demote = (srv: RunningServer, workspaceId: string, userId: string) =>
  srv.deps.db
    .update(schema.members)
    .set({ role: "member" })
    .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, userId)));

const removeMember = (srv: RunningServer, workspaceId: string, userId: string) =>
  srv.deps.db
    .delete(schema.members)
    .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, userId)));

describe("a connection doesn't outlive the right that opened it", () => {
  test("removed outside the server's routes: within RIGHT_TTL_MS nothing reads the database; past it, the next message closes the connection before the new text goes out", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Removed", body: BODY });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    const b = connect(server, beto.browser, workspaceId, docName(workspaceId, page.slug));
    await Promise.all([a.synced, b.synced]);
    // Both sides idle (the handshake's last messages handled): what reaches Beto next is only the server's.
    await until(() => !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges);
    await server.deps.wikiLive.settled();
    await removeMember(server, workspaceId, beto.user.id);
    try {
      skew += RIGHT_TTL_MS;
      await a.edit((md) => `${md}\nSECRET after removal.\n`);
      await until(() => b.closeCodes.length > 0);
    } finally {
      skew = 0;
    }
    expect(b.closeCodes[0]).toBe(4403);
    expect(await b.md()).not.toContain("SECRET");
    await b.edit((md) => `${md}\nUNAUTHORIZED.\n`);
    a.close();
    b.close();
    await unloaded(server);
    const now = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(now.body).not.toContain("UNAUTHORIZED");
    expect(now.body).toContain("SECRET");
  });

  test("N messages within RIGHT_TTL_MS read the right at most once per connection; past it, once more", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Reads", body: BODY });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    await until(() => !a.provider.hasUnsyncedChanges);
    await server.deps.wikiLive.settled();
    // A counter over the right's reads: every one starts by reading the session row.
    const { db } = server.deps;
    const select = db.select.bind(db);
    let reads = 0;
    db.select = ((...args: Parameters<typeof select>) => {
      const query = select(...args);
      const from = query.from.bind(query);
      query.from = ((table: unknown) => {
        if (table === schema.sessions) reads++;
        return from(table as never);
      }) as typeof query.from;
      return query;
    }) as typeof db.select;
    try {
      for (let i = 0; i < 20; i++) {
        await a.edit((md) => md.replace(/One[^\n]*/, `One, edit ${i}.`));
        await until(() => !a.provider.hasUnsyncedChanges);
      }
      expect(reads).toBeLessThanOrEqual(1);
      const before = reads;
      skew += RIGHT_TTL_MS + 1;
      await a.edit((md) => md.replace(/One[^\n]*/, "One, past the window."));
      await until(() => !a.provider.hasUnsyncedChanges);
      expect(reads).toBe(before + 1);
    } finally {
      skew = 0;
      db.select = select;
      a.close();
    }
  });

  test("recheckUser (the members routes' call) closes the connection at once, with no message in between", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Recheck user", body: BODY });
    const b = connect(server, beto.browser, workspaceId, docName(workspaceId, page.slug));
    await b.synced;
    await removeMember(server, workspaceId, beto.user.id);
    await server.deps.wikiLive.recheckUser(workspaceId, beto.user.id);
    await until(() => b.closeCodes.length > 0);
    expect(b.closeCodes[0]).toBe(4403);
    b.close();
  });

  test("signing out closes the connection at once (the session's delete hook), with no message in between", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Sign out", body: BODY });
    const b = connect(server, beto.browser, workspaceId, docName(workspaceId, page.slug));
    await b.synced;
    expect((await beto.browser.json("/api/auth/sign-out", "POST")).status).toBe(200);
    await until(() => b.closeCodes.length > 0);
    expect(b.closeCodes[0]).toBe(4401);
    b.close();
  });

  test("a session past its expiry, inside RIGHT_TTL_MS: the clock against the stored expiry closes it on the next message", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Expired", body: BODY });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    const b = connect(server, beto.browser, workspaceId, docName(workspaceId, page.slug));
    await Promise.all([a.synced, b.synced]);
    await until(() => !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges);
    // Beto's session now ends in 2 s; a forced check (the members routes' call) reads it and stores that
    // expiry with a fresh right, so the clock, not the window, is what has to close the connection.
    await server.deps.db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() + 2000) })
      .where(eq(schema.sessions.userId, beto.user.id));
    await server.deps.wikiLive.recheckUser(workspaceId, beto.user.id);
    expect(b.closeCodes).toEqual([]);
    try {
      skew = 3000;
      expect(skew).toBeLessThan(RIGHT_TTL_MS);
      await a.edit((md) => `${md}\nSECRET after expiry.\n`);
      await until(() => b.closeCodes.length > 0);
    } finally {
      skew = 0;
    }
    expect(b.closeCodes[0]).toBe(4401);
    expect(await b.md()).not.toContain("SECRET");
    a.close();
    b.close();
  });

  test("an admin demoted on a locked page is closed and comes back read only", async () => {
    const { workspaceId, ana } = await team();
    const carla = withApi(await memberOf(server, workspaceId, "Carla", email("carla"), "admin"));
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Demoted", body: BODY });
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    const name = docName(workspaceId, page.slug);
    const c = connect(server, carla.browser, workspaceId, name);
    await c.synced;
    await demote(server, workspaceId, carla.user.id);
    await server.deps.wikiLive.recheckUser(workspaceId, carla.user.id);
    await until(() => c.closeCodes.length > 0);
    expect(c.closeCodes[0]).toBe(4409);
    c.close();
    const again = connect(server, carla.browser, workspaceId, name);
    await again.synced;
    await again.edit((md) => md.replace("One.", "DEMOTED EDIT."));
    await until(() => again.syncStatus.includes(false));
    expect((await storedDraft(server, workspaceId, page.slug))?.text).not.toContain("DEMOTED");
    again.close();
  });

  test("locking keeps the admin's connection and closes the member's; unlocking lets the read-only one write again", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Lock both", body: BODY });
    const name = docName(workspaceId, page.slug);
    const a = connect(server, ana.browser, workspaceId, name);
    const b = connect(server, beto.browser, workspaceId, name);
    await Promise.all([a.synced, b.synced]);
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    await until(() => b.closeCodes.length > 0);
    expect(b.closeCodes[0]).toBe(4409);
    expect(a.closeCodes).toEqual([]);
    b.close();
    const ro = connect(server, beto.browser, workspaceId, name);
    await ro.synced;
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, false);
    await until(() => ro.closeCodes.length > 0);
    expect(ro.closeCodes[0]).toBe(4409);
    ro.close();
    a.close();
  });
});

describe("the shared draft keeps what was accepted while each editor had the right", () => {
  const cases: [string, "removed" | "signed out" | "demoted"][] = [
    ["removed from the workspace", "removed"],
    ["signed out", "signed out"],
    ["demoted on a locked page", "demoted"],
  ];
  for (const [what, mode] of cases)
    test(
      `B ${what} with unsaved edits of A and B: both stay, what B sends after is dropped, A goes on and the draft is saved and published`,
      async () => {
        // No autosave on the way: every edit below is only in memory until the session ends.
        const slow = await startTestServer({ wikiDebounceMs: 600_000 });
        try {
          const ana = withApi(await signedIn(slow, "Ana", email("ana")));
          const { workspaceId } = await seedWorkspace(slow, ana, "Shared draft");
          const beto = withApi(
            await memberOf(slow, workspaceId, "Beto", email("beto"), mode === "demoted" ? "admin" : "member"),
          );
          const page = await ana.api.wiki.createWikiPage(workspaceId, {
            title: `Shared ${mode}`,
            body: BODY,
          });
          if (mode === "demoted") await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
          const name = docName(workspaceId, page.slug);
          const a = connect(slow, ana.browser, workspaceId, name);
          const b = connect(slow, beto.browser, workspaceId, name);
          await Promise.all([a.synced, b.synced]);
          await a.edit((md) => md.replace("One.", "One, by A before."));
          await until(() => !a.provider.hasUnsyncedChanges);
          await until(async () => (await b.md()).includes("by A before"));
          await b.edit((md) => md.replace("Two.", "Two, by B before."));
          await until(() => !b.provider.hasUnsyncedChanges);
          await until(async () => (await a.md()).includes("by B before"));

          if (mode === "removed") {
            await removeMember(slow, workspaceId, beto.user.id);
            await slow.deps.wikiLive.recheckUser(workspaceId, beto.user.id);
          } else if (mode === "demoted") {
            await demote(slow, workspaceId, beto.user.id);
            await slow.deps.wikiLive.recheckUser(workspaceId, beto.user.id);
          } else expect((await beto.browser.json("/api/auth/sign-out", "POST")).status).toBe(200);
          await until(() => b.closeCodes.length > 0);
          expect(b.closeCodes[0]).toBe(mode === "removed" ? 4403 : mode === "demoted" ? 4409 : 4401);

          await b.edit((md) => `${md.trimEnd()}\n\nB after losing the right.\n`);
          await a.edit((md) => `${md.trimEnd()}\n\nA after.\n`);
          await until(() => !a.provider.hasUnsyncedChanges);
          expect(await a.md()).not.toContain("B after losing");
          a.close();
          b.close();
          await unloaded(slow);

          const published = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
          expect(published.version).toBe(2);
          expect(published.body).toContain("One, by A before.");
          expect(published.body).toContain("Two, by B before.");
          expect(published.body).toContain("A after.");
          expect(published.body).not.toContain("B after losing");
          expect(published.history[0]?.author).toEqual({ type: "person", id: ana.user.id });
          const draft = await storedDraft(slow, workspaceId, page.slug);
          expect(draft?.text).toContain("Two, by B before.");
          expect(draft?.dirty).toBe(false);
        } finally {
          await slow.stop();
        }
      },
      SERVER_TEST_MS * 2,
    );
});

describe("the shared draft credits who edited, even someone who left", () => {
  test(
    "B edits last and is removed; the session ends: the version is published with B's edit, credited to B",
    async () => {
      const slow = await startTestServer({ wikiDebounceMs: 600_000 });
      try {
        const ana = withApi(await signedIn(slow, "Ana", email("ana")));
        const { workspaceId } = await seedWorkspace(slow, ana, "Credit");
        const beto = withApi(await memberOf(slow, workspaceId, "Beto", email("beto")));
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Credit", body: BODY });
        const name = docName(workspaceId, page.slug);
        const a = connect(slow, ana.browser, workspaceId, name);
        const b = connect(slow, beto.browser, workspaceId, name);
        await Promise.all([a.synced, b.synced]);
        await b.edit((md) => md.replace("Two.", "Two, by B last."));
        await until(() => !b.provider.hasUnsyncedChanges);
        await removeMember(slow, workspaceId, beto.user.id);
        await slow.deps.wikiLive.recheckUser(workspaceId, beto.user.id);
        await until(() => b.closeCodes.length > 0);
        a.close();
        b.close();
        await unloaded(slow);
        const published = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
        expect(published.version).toBe(2);
        expect(published.body).toContain("Two, by B last.");
        expect(published.history[0]?.author).toEqual({ type: "person", id: beto.user.id });
      } finally {
        await slow.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );
});

describe("the live draft's limits", () => {
  test(
    "an update past MAX_BODY gets SyncStatus false and is neither applied, relayed nor stored",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Too long", body: "Short.\n" });
      const name = docName(workspaceId, page.slug);
      const a = connect(server, ana.browser, workspaceId, name);
      const b = connect(server, beto.browser, workspaceId, name);
      await Promise.all([a.synced, b.synced]);
      await a.edit(() => "x".repeat(MAX_BODY + 1));
      await until(() => a.syncStatus.includes(false));
      // Then a small edit goes through, and arrives alone.
      await b.edit((md) => md.replace("Short.", "Short, still."));
      await until(
        async () =>
          (await storedDraft(server, workspaceId, page.slug))?.text.includes("Short, still.") ?? false,
      );
      expect((await b.md()).length).toBeLessThan(100);
      await server.deps.wikiLive.settled();
      expect((await storedDraft(server, workspaceId, page.slug))?.text.length).toBeLessThan(100);
      expect(a.closeCodes).toEqual([]);
      a.close();
      b.close();
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "an edit right at MAX_BODY is accepted",
    async () => {
      const { workspaceId, ana } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "At the limit",
        body: "Short.\n",
      });
      const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
      await a.synced;
      await a.edit(() => "x".repeat(MAX_BODY - 1));
      await until(() => !a.provider.hasUnsyncedChanges);
      expect(a.syncStatus).not.toContain(false);
      a.close();
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "a message past MAX_UPDATE closes the sender even when the page text stays small",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Heavy", body: BODY });
      const name = docName(workspaceId, page.slug);
      const a = connect(server, ana.browser, workspaceId, name);
      const b = connect(server, beto.browser, workspaceId, name);
      await Promise.all([a.synced, b.synced]);
      // An attribute the markdown doesn't keep: a big message, a tiny page.
      const para = new Y.XmlElement("paragraph");
      para.setAttribute("junk", "y".repeat(MAX_UPDATE + 1024));
      para.insert(0, [new Y.XmlText("tiny")]);
      b.doc.getXmlFragment(YFRAGMENT).push([para]);
      await until(() => b.closeCodes.length > 0);
      expect(b.closeCodes[0]).toBe(4413);
      await server.deps.wikiLive.settled();
      expect(await a.md()).not.toContain("tiny");
      a.close();
      b.close();
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "a merge that would pass MAX_BODY is a conflict: the draft keeps its text and stays within the limit",
    async () => {
      const { workspaceId, ana } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Big merge", body: BODY });
      const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
      await a.synced;
      const half = Math.floor(MAX_BODY * 0.6);
      await a.edit((md) => md.replace("One.", `One ${"d".repeat(half)}.`));
      await until(async () => (await storedDraft(server, workspaceId, page.slug))?.dirty === true);
      await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, {
        body: BODY.replace("Two.", `Two ${"p".repeat(half)}.`),
        parentVersion: 1,
      });
      await until(() => a.stateless.some((s) => s.type === "conflict"));
      await server.deps.wikiLive.settled();
      const stored = await storedDraft(server, workspaceId, page.slug);
      expect(stored?.text.length).toBeLessThanOrEqual(MAX_BODY);
      expect(stored?.text).toContain("ddd");
      expect((await a.md()).length).toBeLessThanOrEqual(MAX_BODY);
      a.close();
    },
    SERVER_TEST_MS * 2,
  );

  test("a saved draft past MAX_BODY (stored before the limit) is not published", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Legacy", body: BODY });
    const row = await pageBySlug(server.deps.db, workspaceId, page.slug);
    const md = await wikiMarkdown();
    const big = md.toYDoc(`${BODY}\n${"z".repeat(MAX_BODY + 10)}\n`);
    await server.deps.db.insert(schema.wikiPageDocs).values({
      pageId: row.id,
      state: Buffer.from(Y.encodeStateAsUpdate(big)).toString("base64"),
      parentVersion: 1,
      dirty: true,
      editors: [{ type: "person", id: ana.user.id }],
    });
    const err = await apiError(ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug));
    expect([err.status, err.code]).toEqual([400, "wiki.too_large"]);
    expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version).toBe(1);
  });
});

// ---- A bare socket speaking the wire format, to send what the provider never would.

const enc = new TextEncoder();
function varUintBytes(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
    if (!n) return out;
  }
}
const varString = (s: string) => {
  const b = enc.encode(s);
  return [...varUintBytes(b.length), ...b];
};
const varBytes = (b: Uint8Array) => [...varUintBytes(b.length), ...b];
const authMessage = (doc: string) => new Uint8Array([...varString(doc), 2, 0, ...varString("cookie")]);
const updateMessage = (doc: string, update: Uint8Array) =>
  new Uint8Array([...varString(doc), 0, 2, ...varBytes(update)]);

interface Raw {
  ws: WebSocket;
  received: Uint8Array[];
  closed: Promise<number>;
  /** Waits for the server's answer to an authentication: true when authenticated. */
  authenticated(doc: string): Promise<boolean>;
  /** Waits for a SyncStatus on `doc` (the answer to an update). */
  synced(doc: string): Promise<boolean>;
}

function rawSocket(srv: RunningServer, browser: Browser, workspaceId: string): Promise<Raw> {
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const ws = new WebSocket(`${srv.url.replace(/^http/, "ws")}${COLLAB_PATH}?workspaceId=${workspaceId}`, {
    headers: { cookie, origin: srv.url },
  } as never);
  ws.binaryType = "arraybuffer";
  const received: Uint8Array[] = [];
  const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
  ws.addEventListener("message", (e) => received.push(new Uint8Array(e.data as ArrayBuffer)));
  const answer = (doc: string, type: number) =>
    until(() => received.some((m) => startsWith(m, [...varString(doc), type]))).then(
      () => received.find((m) => startsWith(m, [...varString(doc), type])) as Uint8Array,
    );
  const prefix = (doc: string) => varString(doc).length;
  return new Promise((resolve) =>
    ws.addEventListener("open", () =>
      resolve({
        ws,
        received,
        closed,
        authenticated: async (doc) => (await answer(doc, 2))[prefix(doc) + 1] === 2,
        synced: async (doc) => (await answer(doc, 8))[prefix(doc) + 1] === 1,
      }),
    ),
  );
}
const startsWith = (m: Uint8Array, head: number[]) => head.every((b, i) => m[i] === b);

function paragraphUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  const para = new Y.XmlElement("paragraph");
  para.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(YFRAGMENT).push([para]);
  return Y.encodeStateAsUpdate(doc);
}

describe("what a client shouldn't send", () => {
  test("a malformed message closes that socket; the page and the other editors go on", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Malformed", body: BODY });
    const a = connect(server, ana.browser, workspaceId, docName(workspaceId, page.slug));
    await a.synced;
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(await raw.closed).toBe(4400);
    await a.edit((md) => md.replace("One.", "One, still editing."));
    await until(() => !a.provider.hasUnsyncedChanges);
    expect(a.closeCodes).toEqual([]);
    a.close();
  });

  test("an unknown message type after the authentication is ignored: nothing changes and the socket goes on", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Unknown type", body: BODY });
    const name = docName(workspaceId, page.slug);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    const before = (await storedDraft(server, workspaceId, page.slug))?.text;
    raw.ws.send(new Uint8Array([...varString(name), 99, 1, 2, 3]));
    // The next update is answered: the unknown message was handled (dropped) before it.
    raw.ws.send(updateMessage(name, paragraphUpdate("NEXT")));
    expect(await raw.synced(name)).toBe(true);
    await until(
      async () => (await storedDraft(server, workspaceId, page.slug))?.text.includes("NEXT") ?? false,
    );
    const after = (await storedDraft(server, workspaceId, page.slug))?.text ?? "";
    expect(after.replace(/\n*NEXT\n*/, "\n").trim()).toBe((before ?? "").trim());
    raw.ws.close();
  });

  test("an invalid Yjs update closes that socket and is not applied", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Invalid update", body: BODY });
    const name = docName(workspaceId, page.slug);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    const before = (await storedDraft(server, workspaceId, page.slug))?.text;
    raw.ws.send(updateMessage(name, new Uint8Array([9, 9, 9, 9, 9, 9, 200, 1, 0, 255])));
    expect(await raw.closed).toBe(4400);
    await server.deps.wikiLive.settled();
    expect((await storedDraft(server, workspaceId, page.slug))?.text).toBe(before);
  });

  test("an update sent before the authentication is dropped, even once the socket authenticates", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Before auth", body: BODY });
    const name = docName(workspaceId, page.slug);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(updateMessage(name, paragraphUpdate(`EARLY ${"e".repeat(MAX_BODY)}`)));
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    // An update after the authentication is answered: everything sent before it was handled.
    raw.ws.send(updateMessage(name, paragraphUpdate("LATER")));
    expect(await raw.synced(name)).toBe(true);
    await server.deps.wikiLive.settled();
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    expect(await a.md()).not.toContain("EARLY");
    expect(await a.md()).toContain("LATER");
    a.close();
    raw.ws.close();
  });

  test("authenticated to one page, an update for another page lands nowhere", async () => {
    const { workspaceId, ana } = await team();
    const one = await ana.api.wiki.createWikiPage(workspaceId, { title: "One page", body: BODY });
    const other = await ana.api.wiki.createWikiPage(workspaceId, { title: "Other page", body: BODY });
    const b = connect(server, ana.browser, workspaceId, docName(workspaceId, other.slug));
    await b.synced;
    const raw = await rawSocket(server, ana.browser, workspaceId);
    const name = docName(workspaceId, one.slug);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    raw.ws.send(updateMessage(docName(workspaceId, other.slug), paragraphUpdate("CROSS")));
    raw.ws.send(updateMessage(name, paragraphUpdate("OWN")));
    expect(await raw.synced(name)).toBe(true);
    await server.deps.wikiLive.settled();
    expect(await b.md()).not.toContain("CROSS");
    b.close();
    raw.ws.close();
  });

  test("authentication to another workspace's page after an early update: nothing lands there", async () => {
    const one = await team();
    const two = await team();
    const secret = await one.ana.api.wiki.createWikiPage(one.workspaceId, {
      title: "Their page",
      body: BODY,
    });
    const name = docName(one.workspaceId, secret.slug);
    const raw = await rawSocket(server, two.ana.browser, two.workspaceId);
    raw.ws.send(updateMessage(name, paragraphUpdate("INTRUDER")));
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(false);
    const owner = connect(server, one.ana.browser, one.workspaceId, name);
    await owner.synced;
    expect(await owner.md()).not.toContain("INTRUDER");
    owner.close();
    raw.ws.close();
  });
});

describe("stopping the server", () => {
  test(
    "with a draft that can't be published (conflict) and a save pending, the draft is saved; a second stop is a no-op",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vanr-wiki-stop-"));
      try {
        const first = await startTestServer({ env: { DATA_DIR: dir }, wikiDebounceMs: 600_000 });
        const { workspaceId, ana, beto } = await team(first);
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Pending stop", body: BODY });
        const a = connect(first, ana.browser, workspaceId, docName(workspaceId, page.slug));
        await a.synced;
        await a.edit((md) => md.replace("Two.", "Two (draft)."));
        await until(() => !a.provider.hasUnsyncedChanges);
        await beto.api.wiki.replaceWikiPage(workspaceId, page.slug, {
          body: BODY.replace("Two.", "Two (API)."),
          parentVersion: 1,
        });
        await until(() => a.stateless.some((s) => s.type === "conflict"));
        await a.edit((md) => md.replace("One.", "One, typed before the stop."));
        await until(() => !a.provider.hasUnsyncedChanges);
        await Promise.all([first.stop(), first.stop()]);
        await first.stop();
        a.close();
        const second = await startTestServer({ env: { DATA_DIR: dir } });
        try {
          const draft = await storedDraft(second, workspaceId, page.slug);
          expect(draft?.text).toContain("One, typed before the stop.");
          expect(draft?.text).toContain("Two (draft).");
          expect(draft?.dirty).toBe(true);
          expect((await pageBySlug(second.deps.db, workspaceId, page.slug)).version).toBe(2);
        } finally {
          await second.stop();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "during an automatic publish: the stop waits for it, and nothing is written once the database closed",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vanr-wiki-stop-"));
      const problems: string[] = [];
      const { warn, error } = log;
      log.warn = (msg, fields) => {
        problems.push(msg);
        warn(msg, fields);
      };
      log.error = (msg, fields) => {
        problems.push(msg);
        error(msg, fields);
      };
      try {
        const first = await startTestServer({
          env: { DATA_DIR: dir },
          wikiIdlePublishMs: 100,
          wikiDebounceMs: 50,
        });
        const { workspaceId, ana } = await team(first);
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Publishing stop", body: BODY });
        const a = connect(first, ana.browser, workspaceId, docName(workspaceId, page.slug));
        await a.synced;
        // The quiet publish's index write is held: the stop starts while the publish is in progress.
        const hold = holdNextIndexWrite(first);
        await a.edit((md) => md.replace("One.", "One, published while stopping."));
        await hold.begun;
        const stopping = first.stop();
        hold.release();
        await stopping;
        a.close();
        const second = await startTestServer({ env: { DATA_DIR: dir } });
        try {
          const row = await pageBySlug(second.deps.db, workspaceId, page.slug);
          expect(row.version).toBe(2);
          expect(row.body).toContain("One, published while stopping.");
          expect((await storedDraft(second, workspaceId, page.slug))?.dirty).toBe(false);
        } finally {
          await second.stop();
        }
        expect(problems).toEqual([]);
      } finally {
        log.warn = warn;
        log.error = error;
        await rm(dir, { recursive: true, force: true });
      }
    },
    SERVER_TEST_MS * 2,
  );
});

describe("the draft's writer must still be allowed when the save commits", () => {
  test("a version saved by an agent reaches the session and the session publishes nothing in its name", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Agent save", body: BODY });
    const row = await pageBySlug(server.deps.db, workspaceId, page.slug);
    const saved = await savePage(server.deps, {
      row,
      author: { type: "agent", id: "agt_x" },
      canBypassLock: true,
      parentVersion: 1,
      body: BODY.replace("Two.", "Two (agent)."),
    });
    expect(saved.version).toBe(2);
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    // An agent never passes a lock, whatever its caller allows.
    const locked = await pageBySlug(server.deps.db, workspaceId, page.slug);
    const err = await savePage(server.deps, {
      row: locked,
      author: { type: "agent", id: "agt_x" },
      canBypassLock: true,
      body: "agent past the lock",
    }).catch((e: { code?: string }) => e.code);
    expect(err).toBe("wiki.page_locked");
  });
});
