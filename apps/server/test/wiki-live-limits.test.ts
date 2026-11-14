// The live wiki's limits against one abusive member: the live document holds only the editor's fragment and
// its encoded state has a cap (a saved state from before them opens trimmed), a message under any key but the
// plain document name closes its socket before the page's queue, and one connection's incoming buffer and
// one person's sockets have caps. Whoever passes one closes alone: the others on the page go on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import type { RunningServer } from "../src/server";
import { pageBySlug } from "../src/wiki";
import { COLLAB_PATH, LIVE_LIMITS } from "../src/wiki-collab";
import { wikiMarkdown, YFRAGMENT } from "../src/wiki-md";
import { type Browser, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { wikiApi } from "./wiki-api";
import {
  authMessage,
  connect,
  holdNextTransaction,
  paragraphUpdate,
  rawSocket,
  startsWith,
  unloaded,
  until,
  updateMessage,
  varString,
} from "./wiki-live";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ wikiDebounceMs: 50 });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@live-limits.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });
const docName = (workspaceId: string, slug: string) => `wiki/${workspaceId}/${slug}`;
const BODY = "# Plan\n\nOne.\n\nTwo.\n";

async function team() {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId } = await seedWorkspace(server, ana, "Limits");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  return { workspaceId, ana, beto };
}

async function storedState(workspaceId: string, slug: string) {
  const page = await pageBySlug(server.deps.db, { workspaceId, system: true }, slug);
  const [d] = await server.deps.db
    .select()
    .from(schema.wikiPageDocs)
    .where(eq(schema.wikiPageDocs.pageId, page.id));
  if (!d) return null;
  const bytes = new Uint8Array(Buffer.from(d.state, "base64"));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const md = await wikiMarkdown();
  return { ...d, bytes, doc, text: md.serialize(md.fromYDoc(doc)) };
}

async function writeState(pageId: string, doc: Y.Doc) {
  await server.deps.db
    .update(schema.wikiPageDocs)
    .set({ state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") })
    .where(eq(schema.wikiPageDocs.pageId, pageId));
}

/** Text in a shared type of its own, outside the editor's fragment (the page's text never shows it). */
function junkUpdate(size: number): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("junk").insert(0, "x".repeat(size));
  return Y.encodeStateAsUpdate(doc);
}

const statusesOf = (received: Uint8Array[], name: string) =>
  received.filter((m) => startsWith(m, [...varString(name), 8])).map((m) => m[varString(name).length + 1]);

/** Opens a socket and says whether the upgrade went through (false: rejected before it opened). */
function opens(browser: Browser, workspaceId: string): Promise<{ opened: boolean; ws: WebSocket }> {
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}${COLLAB_PATH}?workspaceId=${workspaceId}`, {
    headers: { cookie, origin: server.url },
  } as never);
  return new Promise((resolve) => {
    ws.addEventListener("open", () => resolve({ opened: true, ws }));
    ws.addEventListener("close", () => resolve({ opened: false, ws }));
  });
}

/** Lowers one of the live limits for the length of `fn`. */
async function withLimit<K extends keyof typeof LIVE_LIMITS>(key: K, value: number, fn: () => Promise<void>) {
  const before = LIVE_LIMITS[key];
  LIVE_LIMITS[key] = value;
  try {
    await fn();
  } finally {
    LIVE_LIMITS[key] = before;
  }
}

describe("the live document's limits", () => {
  test("an update with 5001 links is rejected before acknowledgement and preserves the other editor's draft", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Live links", body: BODY });
    const name = docName(workspaceId, page.slug);
    const a = connect(server, ana.browser, workspaceId, name);
    const b = connect(server, beto.browser, workspaceId, name);
    try {
      await Promise.all([a.synced, b.synced]);
      const prior = BODY.replace("One.", "One, in the draft.");
      await a.edit(() => prior);
      await until(() => !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges);
      await until(async () => (await storedState(workspaceId, page.slug))?.text === prior);
      const acks = a.syncStatus.length;
      await a.edit(() => Array.from({ length: 5001 }, (_, i) => `[[Target ${i}]]`).join(" "));
      await until(() => a.syncStatus.length > acks || a.closeCodes.length > 0);
      expect(a.syncStatus.slice(acks)).toEqual([false]);
      await until(() => a.closeCodes.length > 0);
      expect(a.closeCodes[0]).toBe(4413);
      await server.deps.wikiLive.settled();
      expect(await b.md()).toBe(prior);
      expect((await storedState(workspaceId, page.slug))?.text).toBe(prior);

      await b.edit((md) => md.replace("Two.", "Two, after rejection."));
      const after = prior.replace("Two.", "Two, after rejection.");
      await until(() => !b.provider.hasUnsyncedChanges);
      await until(async () => (await storedState(workspaceId, page.slug))?.text === after);
      expect((await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug)).body).toBe(after);
      expect(b.closeCodes).toEqual([]);
    } finally {
      a.close();
      b.close();
      await unloaded(server);
    }
  });

  for (const legacy of ["foreign content", "oversized history"] as const) {
    for (const action of ["publish", "discard"] as const) {
      test(`HTTP ${action} normalizes a saved draft with ${legacy} without a WebSocket session`, async () => {
        const { workspaceId, ana } = await team();
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Offline draft", body: BODY });
        await server.deps.wikiLive.settled();
        expect(server.deps.wikiLive.loaded()).toBe(0);
        const row = await pageBySlug(server.deps.db, { workspaceId, system: true }, page.slug);
        const md = await wikiMarkdown();
        let draftBody = "Draft.\n";
        const doc = md.toYDoc(draftBody);
        try {
          if (legacy === "foreign content") doc.getText("junk").insert(0, "legacy data");
          else {
            // Each client adds one letter, leaving a history much larger than the draft's text.
            for (let i = 0; i < 300; i++) {
              const other = new Y.Doc();
              try {
                Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
                const para = other.getXmlFragment(YFRAGMENT).get(0);
                if (!(para instanceof Y.XmlElement)) throw new Error("no paragraph");
                const text = para.get(0);
                if (!(text instanceof Y.XmlText)) throw new Error("no text");
                text.insert(text.length, "a");
                Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
              } finally {
                other.destroy();
              }
            }
            draftBody = `Draft.${"a".repeat(300)}\n`;
          }
          const state = Y.encodeStateAsUpdate(doc);
          const fresh = md.toYDoc(draftBody);
          const cap =
            legacy === "oversized history"
              ? Math.ceil((Y.encodeStateAsUpdate(fresh).byteLength + state.byteLength) / 2)
              : LIVE_LIMITS.stateBytes;
          fresh.destroy();
          await server.deps.db.insert(schema.wikiPageDocs).values({
            pageId: row.id,
            state: Buffer.from(state).toString("base64"),
            parentVersion: 1,
            dirty: true,
            editors: [{ type: "person", id: ana.user.id }],
            editedAt: new Date(),
          });
          await withLimit("stateBytes", cap, async () => {
            const response =
              action === "publish"
                ? await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug)
                : await ana.api.wiki.deleteWikiPageDraft(workspaceId, page.slug);
            const version = action === "publish" ? 2 : 1;
            const body = action === "publish" ? draftBody : BODY;
            const expected = { version, body, draft: { dirty: false, parentVersion: version } };
            expect(response).toMatchObject(expected);
            expect(await ana.api.wiki.getWikiPage(workspaceId, page.slug)).toMatchObject(expected);
            const stored = await storedState(workspaceId, page.slug);
            expect(stored).toMatchObject({ text: body, dirty: false, parentVersion: version });
            expect(stored?.bytes.byteLength ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(cap);
            expect(stored?.doc.getText("junk").length).toBe(0);
            stored?.doc.destroy();
            expect(server.deps.wikiLive.loaded()).toBe(0);
          });
        } finally {
          doc.destroy();
        }
      });
    }
  }

  test("an update with content outside the editor's fragment is rejected and closes its socket (4413); none of it is saved", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Junk type", body: BODY });
    const name = docName(workspaceId, page.slug);
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    raw.ws.send(updateMessage(name, junkUpdate(200_000)));
    expect(await raw.closed).toBe(4413);
    expect(statusesOf(raw.received, name)).toEqual([0]);
    await a.edit((md) => md.replace("One.", "One, still here."));
    await until(() => !a.provider.hasUnsyncedChanges);
    await until(
      async () => (await storedState(workspaceId, page.slug))?.text.includes("One, still here.") ?? false,
    );
    const stored = await storedState(workspaceId, page.slug);
    expect(stored?.doc.share.has("junk")).toBe(false);
    expect(stored?.bytes.byteLength ?? 0).toBeLessThan(10_000);
    expect(a.closeCodes).toEqual([]);
    a.close();
  });

  test("an update that would take the encoded state past its cap is rejected (4413); the page still publishes", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "State cap", body: BODY });
    const name = docName(workspaceId, page.slug);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    raw.ws.send(updateMessage(name, paragraphUpdate("Small.")));
    expect(await raw.synced(name)).toBe(true);
    await server.deps.wikiLive.settled();
    const before = await storedState(workspaceId, page.slug);
    // Room for a short paragraph, not for a long one: the text stays far under MAX_BODY.
    await withLimit("stateBytes", (before?.bytes.byteLength ?? 0) + 200, async () => {
      raw.ws.send(updateMessage(name, paragraphUpdate("y".repeat(5_000))));
      expect(await raw.closed).toBe(4413);
      expect(statusesOf(raw.received, name)).toEqual([1, 0]);
      await server.deps.wikiLive.settled();
      expect((await storedState(workspaceId, page.slug))?.text).not.toContain("yyyy");
      const published = await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
      expect(published.body).toContain("Small.");
    });
  });

  test("a saved state with content outside the fragment opens trimmed: the draft's text stays, the junk goes", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Old junk", body: BODY });
    const name = docName(workspaceId, page.slug);
    const first = connect(server, ana.browser, workspaceId, name);
    await first.synced;
    await first.edit((md) => md.replace("Two.", "Two, in the draft."));
    await until(() => !first.provider.hasUnsyncedChanges);
    first.close();
    await unloaded(server);
    const saved = await storedState(workspaceId, page.slug);
    if (!saved) throw new Error("no saved draft");
    // Saved before the limits: megabytes in a type the page's text doesn't count.
    saved.doc.getText("junk").insert(0, "x".repeat(3_000_000));
    await writeState(saved.pageId, saved.doc);

    const again = connect(server, ana.browser, workspaceId, name);
    await again.synced;
    expect(await again.md()).toContain("Two, in the draft.");
    await again.edit((md) => md.replace("One.", "One, after."));
    await until(() => !again.provider.hasUnsyncedChanges);
    await until(
      async () => (await storedState(workspaceId, page.slug))?.text.includes("One, after.") ?? false,
    );
    const trimmed = await storedState(workspaceId, page.slug);
    expect(trimmed?.text).toContain("Two, in the draft.");
    expect(trimmed?.text).toContain("One, after.");
    expect(trimmed?.doc.getText("junk").length).toBe(0);
    expect(trimmed?.bytes.byteLength ?? 0).toBeLessThan(10_000);
    expect(again.closeCodes).toEqual([]);
    again.close();
  });

  test("a saved state past the cap even without junk opens with the draft's text on a new history", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Old history", body: BODY });
    const name = docName(workspaceId, page.slug);
    const first = connect(server, ana.browser, workspaceId, name);
    await first.synced;
    first.close();
    await unloaded(server);
    const saved = await storedState(workspaceId, page.slug);
    if (!saved) throw new Error("no saved draft");
    // A paragraph typed one letter per client: every letter is its own item, a long history for its text.
    const para = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    para.insert(0, [text]);
    saved.doc.getXmlFragment(YFRAGMENT).push([para]);
    for (let i = 0; i < 300; i++) {
      const other = new Y.Doc();
      Y.applyUpdate(other, Y.encodeStateAsUpdate(saved.doc));
      const t = (
        other.getXmlFragment(YFRAGMENT).get(other.getXmlFragment(YFRAGMENT).length - 1) as Y.XmlElement
      ).get(0) as Y.XmlText;
      t.insert(t.length, "a");
      Y.applyUpdate(saved.doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(saved.doc)));
    }
    await writeState(saved.pageId, saved.doc);
    const fresh = (await wikiMarkdown()).toYDoc(`${BODY}\n${"a".repeat(300)}\n`);
    const cap = Math.ceil(
      (Y.encodeStateAsUpdate(fresh).byteLength + Y.encodeStateAsUpdate(saved.doc).byteLength) / 2,
    );
    expect(Y.encodeStateAsUpdate(saved.doc).byteLength).toBeGreaterThan(cap);

    await withLimit("stateBytes", cap, async () => {
      const again = connect(server, ana.browser, workspaceId, name);
      await again.synced;
      expect(await again.md()).toContain("a".repeat(300));
      await server.deps.wikiLive.settled();
      const rebuilt = await storedState(workspaceId, page.slug);
      expect(rebuilt?.text).toContain("a".repeat(300));
      expect(rebuilt?.bytes.byteLength ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(cap);
      expect(again.closeCodes).toEqual([]);
      again.close();
    });
  });
});

describe("one abusive client", () => {
  test("an update that brings a NUL into the page closes its socket (4400) and is not applied", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Nul live", body: BODY });
    const name = docName(workspaceId, page.slug);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    raw.ws.send(updateMessage(name, paragraphUpdate("bad\u0000text")));
    expect(await raw.closed).toBe(4400);
    await server.deps.wikiLive.settled();
    expect((await storedState(workspaceId, page.slug))?.text).not.toContain("bad");
    expect((await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug)).body).toBe(BODY);
  });

  test("a message under a key with a suffix closes its socket before the page's queue: a publish doesn't wait for it", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Suffix", body: BODY });
    const name = docName(workspaceId, page.slug);
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    await a.edit((md) => md.replace("One.", "One, to publish."));
    await until(() => !a.provider.hasUnsyncedChanges);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    raw.ws.send(updateMessage(`${name}\0hang`, paragraphUpdate("HANG")));
    expect(await raw.closed).toBe(4400);
    const started = Date.now();
    const published = await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(published.body).toContain("One, to publish.");
    expect(published.body).not.toContain("HANG");
    a.close();
  });

  test("a client that floods its buffer while the page's queue is held closes alone; the others' edits go through", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Flood", body: BODY });
    const name = docName(workspaceId, page.slug);
    const b = connect(server, beto.browser, workspaceId, name);
    await b.synced;
    await b.edit((md) => md.replace("One.", "One, by Beto."));
    await until(() => !b.provider.hasUnsyncedChanges);
    const raw = await rawSocket(server, ana.browser, workspaceId);
    raw.ws.send(authMessage(name));
    expect(await raw.authenticated(name)).toBe(true);
    await withLimit("inMessages", 8, async () => {
      // A publish holds the page's queue: the flood's first update waits in it, the rest in the buffer.
      const hold = holdNextTransaction(server, "before");
      const publishing = ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
      await hold.started;
      for (let i = 0; i < 40; i++) raw.ws.send(updateMessage(name, paragraphUpdate(`FLOOD ${i}`)));
      expect(await raw.closed).toBe(4429);
      hold.release();
      expect((await publishing).body).toContain("One, by Beto.");
    });
    await b.edit((md) => md.replace("Two.", "Two, after the flood."));
    await until(() => !b.provider.hasUnsyncedChanges);
    await until(
      async () =>
        (await storedState(workspaceId, page.slug))?.text.includes("Two, after the flood.") ?? false,
    );
    expect(b.closeCodes).toEqual([]);
    b.close();
  });

  test("past one person's sockets in all, the next upgrade is rejected; another person still connects", async () => {
    const { workspaceId, ana, beto } = await team();
    await withLimit("connectionsPerPerson", 2, async () => {
      const one = await rawSocket(server, ana.browser, workspaceId);
      const two = await rawSocket(server, ana.browser, workspaceId);
      const three = await opens(ana.browser, workspaceId);
      expect(three.opened).toBe(false);
      const other = await opens(beto.browser, workspaceId);
      expect(other.opened).toBe(true);
      for (const ws of [one.ws, two.ws, other.ws]) ws.close();
    });
  });

  test("past one person's sockets on one page, the newest closes (4429); the earlier one and the others go on", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Tabs", body: BODY });
    const name = docName(workspaceId, page.slug);
    await withLimit("connectionsPerPage", 2, async () => {
      const b = connect(server, beto.browser, workspaceId, name);
      await b.synced;
      const tabs = [
        await rawSocket(server, ana.browser, workspaceId),
        await rawSocket(server, ana.browser, workspaceId),
      ];
      for (const t of tabs) {
        t.ws.send(authMessage(name));
        expect(await t.authenticated(name)).toBe(true);
      }
      const extra = await rawSocket(server, ana.browser, workspaceId);
      extra.ws.send(authMessage(name));
      expect(await extra.closed).toBe(4429);
      tabs[0]?.ws.send(updateMessage(name, paragraphUpdate("FROM A TAB")));
      expect(await tabs[0]?.synced(name)).toBe(true);
      await b.edit((md) => md.replace("One.", "One, by Beto."));
      await until(() => !b.provider.hasUnsyncedChanges);
      expect(b.closeCodes).toEqual([]);
      for (const t of tabs) t.ws.close();
      b.close();
    });
  });
});
