// The live wiki (T6): a draft with autosave and reconciliation by parentVersion (P0-03), co-editing, the
// agent's presence and cursor (P0-04), and the attacks on the collaboration socket.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import type { RunningServer } from "../src/server";
import { pageBySlug, savePage } from "../src/wiki";
import { COLLAB_PATH, MAX_UPDATE } from "../src/wiki-collab";
import { YFRAGMENT } from "../src/wiki-md";
import { type Browser, holdNextIndexWrite, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { apiError, wikiApi } from "./wiki-api";
import { connect, unloaded, until } from "./wiki-live";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ wikiDebounceMs: 50 });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@collab.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });

async function team() {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId } = await seedWorkspace(server, ana, "Live");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  return { workspaceId, ana, beto };
}

const docRow = async (slug: string, workspaceId: string, srv = server) => {
  const page = await pageBySlug(srv.deps.db, { workspaceId, system: true }, slug);
  const [d] = await srv.deps.db
    .select()
    .from(schema.wikiPageDocs)
    .where(eq(schema.wikiPageDocs.pageId, page.id));
  return d;
};

const BODY = "# Plan\n\nOne.\n\nTwo.\n\nThree.\n";

describe("co-editing, presence and draft (P0-03, P0-04)", () => {
  test("two people edit together; the server stamps the presence; publishing becomes a version", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Plan", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const a = connect(server, ana.browser, workspaceId, name);
    const b = connect(server, beto.browser, workspaceId, name);
    await Promise.all([a.synced, b.synced]);
    expect(await b.md(BODY)).toBe(BODY);

    await a.edit((md) => md.replace("One.", "One, edited live."));
    await until(async () => (await b.md()).includes("One, edited live."));

    // Attack: Ana tries to show up as an agent (or as another person) in the presence.
    a.provider.setAwarenessField("user", { id: "agt_fake", name: "Fake Agent", kind: "agent" });
    await until(() =>
      [...(b.provider.awareness?.getStates().values() ?? [])].some((s) => s.user?.id === ana.user.id),
    );
    const anaState = [...(b.provider.awareness?.getStates().values() ?? [])].find(
      (s) => s.user?.id === ana.user.id,
    );
    expect(anaState?.user).toMatchObject({ id: ana.user.id, name: "Ana", kind: "person" });
    expect(
      [...(b.provider.awareness?.getStates().values() ?? [])].some((s) => s.user?.kind === "agent"),
    ).toBe(false);

    // Draft: the published version is still 1; the draft is dirty and saved (autosave).
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    const draft = await beto.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(draft).toMatchObject({ version: 1, body: BODY, draft: { parentVersion: 1, dirty: true } });
    expect(draft.draft?.editors).toEqual([{ type: "person", id: ana.user.id }]);
    const saved = new Y.Doc();
    Y.applyUpdate(
      saved,
      new Uint8Array(Buffer.from((await docRow(page.slug, workspaceId))?.state ?? "", "base64")),
    );
    expect(saved.getXmlFragment(YFRAGMENT).toString()).toContain("One, edited live.");

    const published = await beto.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    expect(published).toMatchObject({
      version: 2,
      body: "# Plan\n\nOne, edited live.\n\nTwo.\n\nThree.\n",
      draft: { parentVersion: 2, dirty: false, editors: [] },
    });
    expect(published.history[0]).toMatchObject({
      note: "publish",
      author: { type: "person", id: beto.user.id },
    });
    await until(() => a.stateless.some((s) => s.type === "published" && s.version === 2));
    // Publishing without a change creates no version.
    expect((await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug)).version).toBe(2);
    a.close();
    b.close();
  });

  test("the end of the session publishes the draft with who edited; without an edit there is no version", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Session", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const only = connect(server, beto.browser, workspaceId, name);
    await only.synced;
    only.close();
    await unloaded(server);
    expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version).toBe(1);

    const b = connect(server, beto.browser, workspaceId, name);
    await b.synced;
    await b.edit((md) => `${md.trimEnd()}\n\nFour.\n`);
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    b.close();
    await until(async () => (await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version === 2);
    const v2 = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(v2.body).toBe(`${BODY}\nFour.\n`);
    expect(v2.history[0]).toMatchObject({ note: "session", author: { type: "person", id: beto.user.id } });
    expect(v2.draft).toMatchObject({ parentVersion: 2, dirty: false });
  });

  test("an API save enters the session: it merges with the draft (parentVersion) or marks a conflict", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Merge", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    await a.edit((md) => md.replace("One.", "One (draft)."));
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);

    // Beto saves through the API (another tab, no session) in another paragraph, over version 1.
    await beto.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: BODY.replace("Three.", "Three (API)."),
      parentVersion: 1,
    });
    await until(async () => (await a.md()).includes("Three (API)."));
    expect(await a.md()).toContain("One (draft).");
    await until(async () => (await docRow(page.slug, workspaceId))?.parentVersion === 2);
    const merged = await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    expect(merged).toMatchObject({ version: 3, body: "# Plan\n\nOne (draft).\n\nTwo.\n\nThree (API).\n" });

    // Now both change the same paragraph: a conflict, the draft stays as it is.
    await a.edit((md) => md.replace("Two.", "Two (draft)."));
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    await beto.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: merged.body.replace("Two.", "Two (API)."),
      parentVersion: 3,
    });
    await until(() => a.stateless.some((s) => s.type === "conflict" && s.version === 4));
    expect(await a.md()).toContain("Two (draft).");
    const conflict = await apiError(ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug));
    expect(conflict).toMatchObject({ status: 409, code: "wiki.stale_draft" });
    const forced = await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug, true);
    expect(forced).toMatchObject({
      version: 5,
      body: "# Plan\n\nOne (draft).\n\nTwo (draft).\n\nThree (API).\n",
    });

    // Discarding brings the document back to the published version.
    await a.edit((md) => md.replace("One (draft).", "Junk."));
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    await ana.api.wiki.deleteWikiPageDraft(workspaceId, page.slug);
    await until(async () => !(await a.md()).includes("Junk."));
    expect((await docRow(page.slug, workspaceId))?.dirty).toBe(false);
    a.close();
  });

  test("the saved draft survives the session: whoever opens later gets the text and the new version", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Saved", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    await a.edit((md) => md.replace("Two.", "Two (draft)."));
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    // A new version in the same paragraph: the end of the session doesn't publish over it (conflict).
    await beto.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: BODY.replace("Two.", "Two (API)."),
      parentVersion: 1,
    });
    await until(() => a.stateless.some((s) => s.type === "conflict"));
    a.close();
    await unloaded(server);
    expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version).toBe(2);
    const b = connect(server, beto.browser, workspaceId, name);
    await b.synced;
    expect(await b.md()).toContain("Two (draft).");
    expect((await docRow(page.slug, workspaceId))?.parentVersion).toBe(1);
    // Without a conflict, the new version that arrives with the session closed goes into the saved draft.
    b.close();
    await unloaded(server);
    await ana.api.wiki.deleteWikiPageDraft(workspaceId, page.slug);
    await beto.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: BODY.replace("One.", "One (offline)."),
      parentVersion: 2,
    });
    await server.deps.wikiLive.settled();
    const c = connect(server, ana.browser, workspaceId, name);
    await c.synced;
    expect(await c.md()).toContain("One (offline).");
    c.close();
  });

  test("the agent's cursor: the agent's change arrives with a blue presence on the changed block", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Agent", body: BODY });
    const a = connect(server, ana.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
    await a.synced;
    const row = await pageBySlug(server.deps.db, { workspaceId, system: true }, page.slug);
    await savePage(server.deps, {
      row,
      author: { type: "agent", id: "agt_writer" },
      canBypassLock: false,
      parentVersion: 1,
      body: BODY.replace("Three.", "Three, revised by the agent."),
    });
    await until(async () => (await a.md()).includes("revised by the agent"));
    await until(() =>
      [...(a.provider.awareness?.getStates().values() ?? [])].some((s) => s.user?.kind === "agent"),
    );
    const agent = [...(a.provider.awareness?.getStates().values() ?? [])].find(
      (s) => s.user?.kind === "agent",
    );
    expect(agent?.user).toMatchObject({ id: "agt_writer", color: "#2f6fed", kind: "agent" });
    // The cursor points to the block the agent changed.
    const rel = Y.createRelativePositionFromJSON(agent?.cursor?.anchor);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, a.doc);
    const block = abs?.type as Y.XmlElement | undefined;
    expect(block?.toString()).toContain("revised by the agent");
    a.close();
  });
});

describe("publishing after a quiet period (P0-03)", () => {
  test(
    "after the configured quiet, the draft becomes a version by itself",
    async () => {
      const quick = await startTestServer({ wikiIdlePublishMs: 300, wikiDebounceMs: 50 });
      try {
        const ana = withApi(await signedIn(quick, "Ana", email("ana")));
        const { workspaceId } = await seedWorkspace(quick, ana, "Quick");
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Quiet", body: BODY });
        const a = connect(quick, ana.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
        await a.synced;
        await a.edit((md) => md.replace("One.", "One, quiet."));
        await until(async () => (await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version === 2);
        const v2 = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
        expect(v2.history[0]).toMatchObject({ note: "idle", author: { type: "person", id: ana.user.id } });
        expect(v2.body).toContain("One, quiet.");
        a.close();
      } finally {
        await quick.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );
});

describe("publishing while someone types (P0-03)", () => {
  test(
    "what someone types while the version is saved stays in the draft and goes into the next version",
    async () => {
      // The search holds the end of the save: it is the window in which the person keeps typing.
      // A clock that moves a millisecond per read: the typing person's right, read at the connection, stays
      // within RIGHT_TTL_MS however slow the host is, so their update is applied while the save is held (a
      // fresh read would wait for the held transaction on PGlite).
      let tick = Date.now();
      const slow = await startTestServer({ wikiDebounceMs: 50, now: () => new Date(tick++) });
      try {
        const ana = withApi(await signedIn(slow, "Ana", email("ana")));
        const { workspaceId } = await seedWorkspace(slow, ana, "Race");
        const page = await ana.api.wiki.createWikiPage(workspaceId, {
          title: "Race",
          body: "One.\n\nTwo.\n",
        });
        const a = connect(slow, ana.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
        await a.synced;
        await a.edit((md) => md.replace("One.", "One edited."));
        await until(
          async () => (await ana.api.wiki.getWikiPage(workspaceId, page.slug)).draft?.dirty === true,
        );

        const hold = holdNextIndexWrite(slow);
        const published = ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
        await hold.begun;
        await a.edit((md) => `${md.trimEnd()}\n\nThree, typed during the publish.\n`);
        // The update waits in the page's queue, which the publish holds through its save: it is applied
        // (and acknowledged) right after the version, on top of it, never inside it.
        expect(a.provider.hasUnsyncedChanges).toBe(true);
        hold.release();
        const v2 = await published;
        expect(v2.body).toBe("One edited.\n\nTwo.\n");
        await until(() => !a.provider.hasUnsyncedChanges);
        await until(
          async () => (await ana.api.wiki.getWikiPage(workspaceId, page.slug)).draft?.dirty === true,
        );

        // A version from outside merges with the draft instead of erasing what was typed.
        await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, {
          body: "One edited.\n\nTwo (API).\n",
          parentVersion: 2,
        });
        await until(async () => (await a.md()).includes("Two (API)."));
        expect(await a.md()).toContain("Three, typed during the publish.");
        a.close();
        await until(async () => (await ana.api.wiki.getWikiPage(workspaceId, page.slug)).version === 4);
        expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).body).toBe(
          "One edited.\n\nTwo (API).\n\nThree, typed during the publish.\n",
        );
      } finally {
        await slow.stop();
      }
    },
    SERVER_TEST_MS * 2,
  );
});

describe("attacks on the collaboration socket", () => {
  test("another site's origin, no session and a non-member of the workspace: rejected before the upgrade", async () => {
    const { workspaceId, ana } = await team();
    const stranger = await signedIn(server, "Zed", email("zed"));
    const cookie = (b: Browser) => [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const url = `${server.url}${COLLAB_PATH}?workspaceId=${workspaceId}`;
    const evil = await fetch(url, {
      headers: { origin: "https://evil.example", cookie: cookie(ana.browser) },
    });
    expect(evil.status).toBe(403);
    expect((await fetch(url, { headers: { origin: server.url } })).status).toBe(401);
    expect(
      (await fetch(url, { headers: { origin: server.url, cookie: cookie(stranger.browser) } })).status,
    ).toBe(404);
    // All good, but without asking for a WebSocket.
    expect((await fetch(url, { headers: { origin: server.url, cookie: cookie(ana.browser) } })).status).toBe(
      426,
    );
  });

  test("another workspace's document, a page in the trash or one that doesn't exist: authentication fails", async () => {
    const one = await team();
    const two = await team();
    const secret = await one.ana.api.wiki.createWikiPage(one.workspaceId, {
      title: "Secret",
      body: "password",
    });
    // Two opens the socket in its own workspace and asks for the other one's document.
    const cross = connect(server, two.ana.browser, two.workspaceId, `wiki/${one.workspaceId}/${secret.slug}`);
    await expect(cross.synced).rejects.toThrow(/auth/);
    expect(cross.doc.getXmlFragment(YFRAGMENT).length).toBe(0);
    cross.close();
    const missing = connect(
      server,
      one.ana.browser,
      one.workspaceId,
      `wiki/${one.workspaceId}/does-not-exist`,
    );
    await expect(missing.synced).rejects.toThrow(/auth/);
    missing.close();
    const weird = connect(
      server,
      one.ana.browser,
      one.workspaceId,
      `other/${one.workspaceId}/${secret.slug}`,
    );
    await expect(weird.synced).rejects.toThrow(/auth/);
    weird.close();
    await one.ana.api.wiki.deleteWikiPage(one.workspaceId, secret.slug);
    const trashed = connect(
      server,
      one.ana.browser,
      one.workspaceId,
      `wiki/${one.workspaceId}/${secret.slug}`,
    );
    await expect(trashed.synced).rejects.toThrow(/auth/);
    trashed.close();
  });

  test("a locked page: a member only reads; their write reaches nobody, not even the draft", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Locked", body: BODY });
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    const name = `wiki/${workspaceId}/${page.slug}`;
    const admin = connect(server, ana.browser, workspaceId, name);
    const member = connect(server, beto.browser, workspaceId, name);
    await Promise.all([admin.synced, member.synced]);
    await member.edit((md) => md.replace("One.", "INTRUSION."));
    // The server answers the rejected update with SyncStatus false (it applied nothing).
    await until(() => member.syncStatus.includes(false));
    await server.deps.wikiLive.settled();
    expect(await admin.md()).not.toContain("INTRUSION");
    expect((await docRow(page.slug, workspaceId))?.dirty).toBe(false);
    expect((await apiError(beto.api.wiki.publishWikiPageDraft(workspaceId, page.slug))).status).toBe(403);
    // Unlocking drops the connections; on reconnecting, the check applies again.
    admin.close();
    member.close();
  });

  test("locking with the session open drops whoever isn't an admin", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Lock later", body: BODY });
    const member = connect(server, beto.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
    await member.synced;
    let closed = false;
    member.provider.on("close", () => {
      closed = true;
    });
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    await until(() => closed);
    member.close();
  });

  test("attack: a restricted page rejects whoever doesn't read it; restricting with the session open drops who lost it", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Restricted live", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const member = connect(server, beto.browser, workspaceId, name);
    await member.synced;
    let closed = false;
    member.provider.on("close", () => {
      closed = true;
    });
    const set = await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, {
      kind: "private",
      userIds: [],
      agentIds: [],
    });
    await until(() => closed);
    member.close();
    // Restricting changed the slug: neither the old address nor the new one opens for Beto.
    const moved = `wiki/${workspaceId}/${set.slug}`;
    for (const doc of [name, moved]) {
      const again = connect(server, beto.browser, workspaceId, doc);
      await expect(again.synced).rejects.toThrow(/auth/);
      expect(again.doc.getXmlFragment(YFRAGMENT).length).toBe(0);
      again.close();
    }
    const owner = connect(server, ana.browser, workspaceId, moved);
    await owner.synced;
    expect(await owner.md()).toContain("One.");
    owner.close();
    // Already restricted, the slug stays: taking Beto off the list drops his open connection by the access.
    await ana.api.wiki.setWikiPageAccess(workspaceId, set.slug, {
      kind: "private",
      userIds: [beto.user.id],
      agentIds: [],
    });
    const listed = connect(server, beto.browser, workspaceId, moved);
    await listed.synced;
    let dropped = false;
    listed.provider.on("close", () => {
      dropped = true;
    });
    const same = await ana.api.wiki.setWikiPageAccess(workspaceId, set.slug, {
      kind: "private",
      userIds: [],
      agentIds: [],
    });
    expect(same.slug).toBe(set.slug);
    await until(() => dropped);
    listed.close();
  });

  test("a giant Yjs message is rejected", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Big", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const a = connect(server, ana.browser, workspaceId, name);
    const b = connect(server, beto.browser, workspaceId, name);
    await Promise.all([a.synced, b.synced]);
    let dropped = false;
    b.provider.on("close", () => {
      dropped = true;
    });
    const huge = "x".repeat(MAX_UPDATE + 1024);
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText(huge)]);
    b.doc.getXmlFragment(YFRAGMENT).push([para]);
    // The server closes the sender's connection instead of applying the update.
    await until(() => dropped);
    await server.deps.wikiLive.settled();
    expect((await a.md()).length).toBeLessThan(1000);
    expect((await docRow(page.slug, workspaceId))?.state.length ?? 0).toBeLessThan(100_000);
    a.close();
    b.close();
  });
});

describe("the live session without a test in the origin", () => {
  test("the page leaves memory once everyone left", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Memory", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const a = connect(server, ana.browser, workspaceId, name);
    const b = connect(server, beto.browser, workspaceId, name);
    await Promise.all([a.synced, b.synced]);
    expect(server.deps.wikiLive.loaded()).toBeGreaterThanOrEqual(1);
    a.close();
    await b.edit((md) => md.replace("One.", "One, last one out."));
    await until(() => !b.provider.hasUnsyncedChanges);
    b.close();
    await unloaded(server);
    // The last one out published on the way out: nothing was held back in memory.
    const now = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(now).toMatchObject({ version: 2, draft: { dirty: false } });
    expect(now.body).toContain("One, last one out.");
  });

  test("restoring a version while someone edits: the draft merges with the restored version", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Restore live", body: BODY });
    await beto.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: BODY.replace("Three.", "Three (v2)."),
      parentVersion: 1,
    });
    const a = connect(server, ana.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
    await a.synced;
    await a.edit((md) => md.replace("One.", "One (draft)."));
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    const restored = await beto.api.wiki.restoreWikiPageVersion(workspaceId, page.slug, 1, 2);
    expect(restored).toMatchObject({ version: 3, body: BODY });
    await until(async () => !(await a.md()).includes("Three (v2)."));
    expect(await a.md()).toContain("One (draft).");
    expect(await a.md()).toContain("Three.");
    await until(async () => (await docRow(page.slug, workspaceId))?.parentVersion === 3);
    const published = await ana.api.wiki.publishWikiPageDraft(workspaceId, page.slug);
    expect(published).toMatchObject({ version: 4, body: BODY.replace("One.", "One (draft).") });
    a.close();
  });

  test("deleting a page with people inside closes their session without publishing the draft", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Delete live", body: BODY });
    const name = `wiki/${workspaceId}/${page.slug}`;
    const a = connect(server, ana.browser, workspaceId, name);
    await a.synced;
    let closed = false;
    a.provider.on("close", () => {
      closed = true;
    });
    await a.edit((md) => md.replace("One.", "One, never published."));
    await until(async () => (await docRow(page.slug, workspaceId))?.dirty === true);
    await ana.api.wiki.deleteWikiPage(workspaceId, page.slug);
    await until(() => closed);
    a.close();
    await unloaded(server);
    const [trashed] = await ana.api.wiki.getWikiTrash(workspaceId);
    expect(trashed?.slug).toBe(page.slug);
    const back = await ana.api.wiki.restoreWikiTrash(workspaceId, page.slug);
    expect(back).toMatchObject({ version: 1, body: BODY });
    // The draft is still saved: whoever reopens the page finds the text that wasn't published.
    const c = connect(server, ana.browser, workspaceId, name);
    await c.synced;
    expect(await c.md()).toContain("One, never published.");
    c.close();
  });

  test(
    "stopping the server with an edit not yet saved loses no text",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "vanr-wiki-"));
      try {
        // No autosave before the stop: the edit lives only in the server's memory.
        const first = await startTestServer({ env: { DATA_DIR: dir }, wikiDebounceMs: 600_000 });
        const ana = withApi(await signedIn(first, "Ana", email("ana")));
        const { workspaceId } = await seedWorkspace(first, ana, "Shutdown");
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Shutdown", body: BODY });
        const a = connect(first, ana.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
        await a.synced;
        await a.edit((md) => md.replace("Two.", "Two, typed just before the stop."));
        await until(() => !a.provider.hasUnsyncedChanges);
        expect((await docRow(page.slug, workspaceId, first))?.dirty).toBe(false);
        await first.stop();
        a.close();

        const second = await startTestServer({ env: { DATA_DIR: dir } });
        try {
          const row = await pageBySlug(second.deps.db, { workspaceId, system: true }, page.slug);
          expect(row.version).toBe(2);
          expect(row.body).toBe(BODY.replace("Two.", "Two, typed just before the stop."));
          expect((await docRow(page.slug, workspaceId, second))?.dirty).toBe(false);
        } finally {
          await second.stop();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    SERVER_TEST_MS * 2,
  );
});
