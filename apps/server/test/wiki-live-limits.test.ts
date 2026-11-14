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
  const page = await pageBySlug(server.deps.db, workspaceId, slug);
  const [d] = await server.deps.db
    .select()
    .from(schema.wikiPageDocs)
    .where(eq(schema.wikiPageDocs.pageId, page.id));
  if (!d) return null;
  const bytes = new Uint8Array(Buffer.from(d.state, "base64"));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const md = await wikiMarkdown();
  return { bytes, doc, text: md.serialize(md.fromYDoc(doc)), pageId: page.id };
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
