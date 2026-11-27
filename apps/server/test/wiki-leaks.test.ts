// What a restricted page must never leak, after the adversarial review of the wiki P1 layer:
// - a request whose access check passed before the page was restricted never answers (or writes) what came
//   after: the write re-checks the read on the row it locked, and a read answers from one snapshot;
// - a restricted page's title is never written where someone who doesn't read the page can read it (a
//   rename doesn't rewrite the links of pages outside its audience);
// - a page the reader can't read changes nothing they see: a link is resolved among the pages they read.
// The real snapshot (a read held right after its check while the page changes) needs concurrent transactions
// and is in wiki-annotations-postgres.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { joinWorkspace } from "../src/members";
import { searchAs } from "../src/routes/search";
import type { RunningServer } from "../src/server";
import { createPage, pageBySlug } from "../src/wiki";
import { createProposal } from "../src/wiki-annotations";
import { MAX_LINKS } from "../src/wiki-links";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";
import { apiError, wikiApi } from "./wiki-api";
import { connect, until } from "./wiki-live";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@wiki-leaks.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });
const db = () => server.deps.db;
const onlyMe = { kind: "private" as const, userIds: [], agentIds: [] };

async function team() {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Leaks");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  return { workspaceId, general, ana, beto };
}
const rowOf = (workspaceId: string, slug: string) => pageBySlug(db(), { workspaceId, system: true }, slug);

/**
 * Holds the next transaction of the server's database before it begins: `begun` resolves when it is asked
 * for. A request that answers without one (`settled` first) used no transaction at all.
 */
function holdNextTransaction() {
  const conn = db();
  const original = conn.transaction.bind(conn);
  let reached!: () => void;
  let release!: () => void;
  const begun = new Promise<void>((r) => {
    reached = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  conn.transaction = (async (...args: Parameters<typeof original>) => {
    conn.transaction = original;
    reached();
    await gate;
    return original(...args);
  }) as typeof original;
  return { begun, release, restore: () => (conn.transaction = original) };
}

/** A value for a mismatch's message: a key only one side has shows as missing. */
const shown = (v: unknown) => (v === undefined ? "(missing)" : JSON.stringify(v).slice(0, 160));

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );

describe("a request across the restriction", () => {
  test(
    "a write or read whose check passed before the restriction answers 404, and nothing written after leaks",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const calls: [
        string,
        (slug: string, ids: { proposal: string; comment: string }) => Promise<unknown>,
      ][] = [
        ["pin", (slug) => beto.api.wiki.pinWikiPage(workspaceId, slug, true)],
        [
          "edit",
          (slug) => beto.api.wiki.replaceWikiPage(workspaceId, slug, { body: "BETO", parentVersion: 1 }),
        ],
        ["move", (slug) => beto.api.wiki.moveWikiPage(workspaceId, slug, "Elsewhere")],
        [
          "meta",
          (slug) =>
            beto.api.wiki.updateWikiPageMeta(workspaceId, slug, { parentVersion: 1, agentEdits: "propose" }),
        ],
        ["comment", (slug) => beto.api.wiki.createWikiPageComment(workspaceId, slug, { body: "hi" })],
        [
          "decide",
          (_slug, ids) =>
            beto.api.wiki.decideWikiAnnotation(workspaceId, ids.proposal, [{ hunkId: "h1", accept: true }]),
        ],
        ["resolve", (_slug, ids) => beto.api.wiki.setWikiAnnotationResolution(workspaceId, ids.comment)],
        ["uncomment", (_slug, ids) => beto.api.wiki.deleteWikiAnnotation(workspaceId, ids.comment)],
        ["discard draft", (slug) => beto.api.wiki.deleteWikiPageDraft(workspaceId, slug)],
        ["trash", (slug) => beto.api.wiki.deleteWikiPage(workspaceId, slug)],
        ["read", (slug) => beto.api.wiki.getWikiPage(workspaceId, slug)],
        ["version", (slug) => beto.api.wiki.getWikiPageDiff(workspaceId, slug)],
        ["panel", (slug) => beto.api.wiki.getWikiPagePanel(workspaceId, slug)],
        ["annotations", (slug) => beto.api.wiki.listWikiPageAnnotations(workspaceId, slug)],
      ];
      const outcomes: string[] = [];
      for (const [what, call] of calls) {
        // Beto created it: only the restriction can stop him.
        const page = await beto.api.wiki.createWikiPage(workspaceId, {
          title: `Race ${what}`,
          body: "public",
        });
        const row = await rowOf(workspaceId, page.slug);
        const { row: proposal } = await createProposal(server.deps, {
          page: row,
          author: { type: "agent", id: "agt_lia", actingFor: beto.user.id },
          parentVersion: 1,
          edits: [{ oldStr: "public", newStr: "public, proposed" }],
          note: "",
        });
        const comment = await beto.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: "mine" });
        const hold = holdNextTransaction();
        try {
          const pending = status(call(page.slug, { proposal: proposal.id, comment: comment.id }));
          const first = await Promise.race([hold.begun.then(() => "held"), pending.then(() => "answered")]);
          expect({ what, first }).toEqual({ what, first: "held" });
          // Meanwhile an admin restricts it and writes a secret.
          await db()
            .update(schema.knowledgePages)
            .set({ access: { kind: "private", principals: [`user:${ana.user.id}`] }, body: "SECRET AFTER" })
            .where(eq(schema.knowledgePages.id, row.id));
          hold.release();
          outcomes.push(`${what} ${await pending}`);
        } finally {
          // A transaction still paused (the fixture failed first) is let go: releasing twice changes nothing.
          hold.release();
          hold.restore();
        }
        const after = await rowOf(workspaceId, page.slug);
        const annotations = await db()
          .select({ id: schema.pageAnnotations.id, status: schema.pageAnnotations.status })
          .from(schema.pageAnnotations)
          .where(eq(schema.pageAnnotations.pageId, row.id));
        const [kept] = await db()
          .select({ status: schema.pageAnnotations.status })
          .from(schema.pageAnnotations)
          .where(eq(schema.pageAnnotations.id, comment.id));
        expect({ what, comment: kept?.status }).toEqual({ what, comment: "open" });
        // Beto's write never landed on the page he lost.
        expect({
          what,
          body: after.body,
          pinned: after.pinned,
          folder: after.folder,
          gone: !!after.deletedAt,
          agentEdits: after.agentEdits,
          // Only the proposal and Beto's comment from before: no new comment, the proposal still pending.
          annotations: annotations.map((a) => a.status).sort(),
        }).toEqual({
          what,
          body: "SECRET AFTER",
          pinned: false,
          folder: "",
          gone: false,
          agentEdits: row.agentEdits,
          annotations: ["open", "pending"],
        });
      }
      expect(outcomes).toEqual(calls.map(([what]) => `${what} 404`));
    },
    SERVER_TEST_MS * 2,
  );

  test(
    "discarding the live draft checks the read in its own transaction, past the route's check",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const page = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Race discard",
        body: "Original.\n",
      });
      const a = connect(server, ana.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
      try {
        await a.synced;
        await a.edit(() => "Original.\n\nAna's unsaved draft.\n");
        await until(() => !a.provider.hasUnsyncedChanges);
        // The route read the page before the restriction; the discard runs after it.
        const row = await rowOf(workspaceId, page.slug);
        await db()
          .update(schema.knowledgePages)
          .set({ access: { kind: "private", principals: [`user:${ana.user.id}`] } })
          .where(eq(schema.knowledgePages.id, row.id));
        const status = await server.deps.wikiLive
          .discard(row, { type: "person", id: beto.user.id }, false)
          .then(
            () => 200,
            (e: { status?: number }) => e.status ?? 0,
          );
        expect(status).toBe(404);
        expect(await a.md()).toContain("Ana's unsaved draft.");
      } finally {
        a.close();
      }
    },
    SERVER_TEST_MS,
  );
});

describe("a restricted page's title stays inside its audience", () => {
  test(
    "renaming a restricted page doesn't write its new title into a page someone else reads; whoever reads it keeps the link",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const caio = withApi(await memberOf(server, workspaceId, "Caio", email("caio")));
      const secret = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Old salary table",
        body: "private",
      });
      const pub = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Public reference",
        body: "See [[Old salary table]].",
      });
      const board = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana, caio],
      });
      const channelPage = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Board notes",
        body: "[[Old salary table]]",
      });
      const inner = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Ana only",
        body: "[[Old salary table]]",
      });
      const { slug } = await ana.api.wiki.setWikiPageAccess(workspaceId, secret.slug, {
        kind: "private",
        userIds: [caio.user.id],
        agentIds: [],
      });
      await ana.api.wiki.setWikiPageAccess(workspaceId, channelPage.slug, {
        kind: "channel",
        channelId: board,
      });
      const innerSet = await ana.api.wiki.setWikiPageAccess(workspaceId, inner.slug, onlyMe);
      const renamed = await ana.api.wiki.renameWikiPage(workspaceId, slug, "Confidential acquisition 2030");
      // Only the page whose readers all read the secret one (Ana's own list) gets the new title.
      expect(renamed.relinked?.rewritten.map((p) => p.slug)).toEqual([innerSet.slug]);
      const bodies = async () => ({
        pub: (await rowOf(workspaceId, pub.slug)).body,
        channel: (
          await rowOf(
            workspaceId,
            (await ana.api.wiki.listWikiPages(workspaceId)).find((p) => p.title === "Board notes")?.slug ??
              "",
          )
        ).body,
        inner: (await rowOf(workspaceId, innerSet.slug)).body,
      });
      expect(await bodies()).toEqual({
        pub: "See [[Old salary table]].",
        channel: "[[Old salary table]]",
        inner: "[[Confidential acquisition 2030]]",
      });
      expect(renamed.altTitles).toContain("Old salary table");
      // Beto sees the public page's link as a page that doesn't exist; Ana and Caio, as the renamed page.
      const target = async (who: typeof ana) =>
        (await who.api.wiki.getWikiPagePanel(workspaceId, pub.slug)).outgoing.map((o) => [
          o.state,
          o.page?.title ?? null,
        ]);
      expect(await target(beto)).toEqual([["missing", null]]);
      expect(await target(ana)).toEqual([["ok", "Confidential acquisition 2030"]]);
      expect(await target(caio)).toEqual([["ok", "Confidential acquisition 2030"]]);
      // Nothing Beto reads carries the new title: bodies, versions, the change log, the index, the search.
      const leaks: string[] = [];
      for (const p of await beto.api.wiki.listWikiPages(workspaceId)) {
        const full = await beto.api.wiki.getWikiPage(workspaceId, p.slug);
        if (JSON.stringify(full).includes("Confidential")) leaks.push(`page ${p.slug}`);
        for (const v of full.history) {
          const res = await beto.browser.fetch(
            `/api/v1/workspaces/${workspaceId}/wiki/pages/${p.slug}/versions/${v.version}`,
          );
          if ((await res.text()).includes("Confidential")) leaks.push(`version ${p.slug}@${v.version}`);
        }
      }
      if (JSON.stringify(await beto.api.wiki.listWikiChanges(workspaceId)).includes("Confidential"))
        leaks.push("changes");
      if ((await beto.api.wiki.getWikiIndex(workspaceId)).markdown.includes("Confidential"))
        leaks.push("index");
      if ((await beto.api.wiki.getWikiSearch(workspaceId, "Confidential")).length) leaks.push("search");
      const hits = await server.deps.search.search(
        { workspaceId, userId: beto.user.id },
        "Confidential acquisition",
      );
      if (hits.length) leaks.push("search index");
      expect(leaks).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test("a public page that becomes restricted with links pointing to it: nothing is rewritten, the links go missing for others", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Plans", body: "x" });
    const linker = await beto.api.wiki.createWikiPage(workspaceId, {
      title: "Linker",
      body: "[[Plans]] and [[Plans|the plans]]",
    });
    const { slug } = await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, onlyMe);
    expect((await rowOf(workspaceId, linker.slug)).body).toBe("[[Plans]] and [[Plans|the plans]]");
    expect((await rowOf(workspaceId, linker.slug)).version).toBe(1);
    const states = async (who: typeof ana) =>
      (await who.api.wiki.getWikiPagePanel(workspaceId, linker.slug)).outgoing.map(
        (o) => o.page?.slug ?? o.state,
      );
    expect(await states(beto)).toEqual(["missing", "missing"]);
    expect(await states(ana)).toEqual([slug, slug]);
    // Beto renames his own page linked from nowhere he can't read; his rename never writes Ana's page either.
    const back = await ana.api.wiki.createWikiPage(workspaceId, { title: "Ana back", body: "[[Linker]]" });
    await ana.api.wiki.setWikiPageAccess(workspaceId, back.slug, onlyMe);
    await beto.api.wiki.renameWikiPage(workspaceId, linker.slug, "Linker two");
    const anaBack = (await ana.api.wiki.listWikiPages(workspaceId)).find((p) => p.title === "Ana back");
    expect((await rowOf(workspaceId, String(anaBack?.slug))).body).toBe("[[Linker]]");
    expect(
      (await ana.api.wiki.getWikiPagePanel(workspaceId, String(anaBack?.slug))).outgoing[0]?.page?.slug,
    ).toBe(linker.slug);
  });
});

/** A small pseudo-random generator, so a failing case can be replayed by its seed. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every key whose value differs from one workspace to another for the same content. */
const VOLATILE = new Set(["at", "updatedAt", "createdAt", "id", "last", "ranAt", "editedAt"]);
function normalize(v: unknown, ws: string): unknown {
  if (typeof v === "string") return v.split(ws).join("<ws>");
  if (Array.isArray(v)) return v.map((x) => normalize(x, ws));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, x]) => [k, normalize(x, ws)]),
    );
  return v;
}

describe("a page the reader can't read changes nothing they see", () => {
  test(
    "generated cases: every read path answers the same with and without a restricted page (created, renamed, re-restricted)",
    async () => {
      const POOL = ["Oracle", "Budget", "Plan B", "Roadmap"];
      const mismatches: string[] = [];
      for (let seed = 1; seed <= 6; seed++) {
        const rand = rng(seed * 7919);
        const pick = () => POOL[Math.floor(rand() * POOL.length)] ?? "Oracle";
        const ana = withApi(await signedIn(server, "Ana", email("ana")));
        const beto = withApi(await signedIn(server, "Beto", email("beto")));
        const specs = Array.from({ length: 4 }, (_, i) => ({
          title: i === 0 ? pick() : `${pick()} ${i}`,
          altTitles: rand() < 0.6 ? [pick()] : [],
          body: `See [[${pick()}]], [[${pick()}]] and [[${pick().toLowerCase().replace(" ", "-")}]].`,
        }));
        const hidden = { title: pick(), altTitles: [pick()], body: `[[${pick()}]] secret` };
        const answers: unknown[] = [];
        for (const withHidden of [false, true]) {
          const { workspaceId } = await seedWorkspace(server, ana, `Case ${seed}`);
          await joinWorkspace(db(), { workspaceId, userId: beto.user.id, name: "Beto", role: "member" });
          for (const s of specs) await ana.api.wiki.createWikiPage(workspaceId, s);
          if (withHidden) {
            const h = await ana.api.wiki.createWikiPage(workspaceId, hidden);
            const set = await ana.api.wiki.setWikiPageAccess(workspaceId, h.slug, onlyMe);
            if (rand() < 0.5) await ana.api.wiki.renameWikiPage(workspaceId, set.slug, pick());
            const board = await seedChannel(server, workspaceId, {
              name: "b",
              visibility: "private",
              members: [ana],
            });
            if (rand() < 0.5)
              await ana.api.wiki.setWikiPageAccess(workspaceId, set.slug, {
                kind: "channel",
                channelId: board,
              });
          }
          const w = beto.api.wiki;
          const pages = await w.listWikiPages(workspaceId);
          const out: Record<string, unknown> = { pages };
          for (const p of pages) {
            out[`page ${p.slug}`] = await w.getWikiPage(workspaceId, p.slug);
            out[`panel ${p.slug}`] = await w.getWikiPagePanel(workspaceId, p.slug);
            out[`local ${p.slug}`] = await w.getWikiGraph(workspaceId, { pageId: p.slug, depth: 2 });
          }
          out.graph = await w.getWikiGraph(workspaceId);
          out.index = await w.getWikiIndex(workspaceId);
          out.changes = (await w.listWikiChanges(workspaceId)).map((c) => [
            c.action,
            c.title,
            c.slug,
            c.detail,
          ]);
          out.checks = await w.getWikiChecks(workspaceId);
          for (const q of POOL) out[`search ${q}`] = await w.getWikiSearch(workspaceId, q);
          out.trash = await w.getWikiTrash(workspaceId);
          // A page Beto creates now with each title: the same address either way.
          for (const t of POOL)
            out[`create ${t}`] = (await w.createWikiPage(workspaceId, { title: t, body: "b" })).slug;
          out.missing = (await apiError(w.getWikiPage(workspaceId, "oracle-xyzxyzxy"))).status;
          answers.push(normalize(out, workspaceId));
        }
        if (JSON.stringify(answers[0]) !== JSON.stringify(answers[1])) {
          const [a, b] = answers as Record<string, unknown>[];
          for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]))
            if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]))
              mismatches.push(`seed ${seed} ${k}: ${shown(a?.[k])} != ${shown(b?.[k])}`);
        }
      }
      expect(mismatches).toEqual([]);
    },
    SERVER_TEST_MS * 6,
  );
});

describe("mentions and the search with an answer", () => {
  test("a person mentioned on a restricted page gets no notice of it", async () => {
    const { workspaceId, ana, beto } = await team();
    const [m] = await db()
      .select({ handle: schema.members.handle })
      .from(schema.members)
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, beto.user.id)));
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Review of Beto", body: "draft" });
    const { slug } = await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, onlyMe);
    await ana.api.wiki.replaceWikiPage(workspaceId, slug, {
      body: `Notes on @${m?.handle} (Beto): not ready.`,
      parentVersion: 1,
    });
    await server.deps.runtime.settle();
    const notices = await db()
      .select()
      .from(schema.notifications)
      .where(
        and(eq(schema.notifications.workspaceId, workspaceId), eq(schema.notifications.userId, beto.user.id)),
      );
    expect(notices).toEqual([]);
  });

  test("the search the answer is built from never hands a restricted page's text to someone who doesn't read it", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Merger",
      body: "The merger with quokkacorp closes in May.",
    });
    await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, onlyMe);
    const as = async (who: Person) => {
      const [m] = await db()
        .select()
        .from(schema.members)
        .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, who.user.id)));
      if (!m) throw new Error("not a member");
      return searchAs(
        server.deps,
        { workspaceId, userId: who.user.id, role: m.role, handle: m.handle },
        "quokkacorp merger",
        { limit: 8, match: "any", withText: true, perSource: false },
      );
    };
    expect(await as(beto)).toEqual([]);
    expect((await as(ana)).some((h) => (h.text ?? "").includes("quokkacorp"))).toBe(true);
    // The answer is built from those same results: Beto's has no source and no text of the page.
    const res = await beto.browser.json(`/api/v1/workspaces/${workspaceId}/search/ask`, "POST", {
      q: "quokkacorp",
    });
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer.sources).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain("merger");
  });

  test("a restricted page created through the domain function is still filtered (no route bypass)", async () => {
    const { workspaceId, ana, beto } = await team();
    const row = await createPage(server.deps, {
      workspaceId,
      title: "Direct",
      body: "direct secret",
      author: { type: "person", id: ana.user.id },
    });
    await db()
      .update(schema.knowledgePages)
      .set({ access: { kind: "private", principals: [`user:${ana.user.id}`] } })
      .where(eq(schema.knowledgePages.id, row.id));
    expect((await apiError(beto.api.wiki.getWikiPage(workspaceId, row.slug))).status).toBe(404);
  });
});

describe("the base's limits on this layer's paths", () => {
  test("the routes of this layer go through the wiki's border check: a NUL character is a 400 before anything is written", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Border", body: "text" });
    for (const call of [
      () => ana.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: "bad \u0000 text" }),
      () =>
        ana.api.wiki.createWikiPageComment(workspaceId, page.slug, {
          body: "ok",
          anchor: { quote: "te\u0000xt", prefix: "", suffix: "" },
        }),
      () =>
        ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, {
          kind: "private",
          userIds: ["u\u0000"],
          agentIds: [],
        }),
      () => ana.api.wiki.decideWikiAnnotation(workspaceId, "ann_\u0000", [{ hunkId: "h1", accept: true }]),
    ]) {
      const err = await apiError(call());
      expect([err.status, err.code]).toEqual([400, "wiki.invalid_text"]);
    }
    const row = await rowOf(workspaceId, page.slug);
    expect(
      await db().select().from(schema.pageAnnotations).where(eq(schema.pageAnnotations.pageId, row.id)),
    ).toEqual([]);
    expect(row.access).toBeNull();
    // The domain function the agent tool will call checks it too.
    expect(
      createProposal(server.deps, {
        page: row,
        author: { type: "agent", id: "agt_lia" },
        parentVersion: 1,
        edits: [{ oldStr: "text", newStr: "te\u0000xt" }],
        note: "",
      }),
    ).rejects.toMatchObject({ code: "wiki.invalid_text" });
  });

  test("the all-or-nothing vault import skips only notes over pages the importer reads", async () => {
    const { workspaceId, ana, beto } = await team();
    const hidden = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Payroll",
      folder: "HR",
      body: "secret",
    });
    await ana.api.wiki.setWikiPageAccess(workspaceId, hidden.slug, onlyMe);
    const zip = zipSync({ "HR/Payroll.md": strToU8("someone's note"), "Readme.md": strToU8("hi") });
    // Beto doesn't read the restricted page: his note goes in, as for a title nobody used.
    const asBeto = await beto.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([zip]),
      fileName: "v.zip",
    });
    expect([asBeto.created, asBeto.skipped]).toEqual([2, 0]);
    // Ana reads it: her note with the same title and folder is skipped (and so is Beto's, now there).
    const asAna = await ana.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([zip]),
      fileName: "v.zip",
    });
    expect([asAna.created, asAna.skipped]).toEqual([0, 2]);
    // The restricted page itself is untouched.
    const restricted = (await ana.api.wiki.listWikiPages(workspaceId)).find((p) => p.restricted);
    expect((await rowOf(workspaceId, String(restricted?.slug))).body).toBe("secret");
  });

  test("accepting a proposal is held to the links ceiling: rejected whole, the proposal stays pending", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Links", body: "anchor" });
    const row = await rowOf(workspaceId, page.slug);
    const many = Array.from({ length: MAX_LINKS + 1 }, (_, i) => `[[p${i}]]`).join(" ");
    const { row: proposal } = await createProposal(server.deps, {
      page: row,
      author: { type: "agent", id: "agt_lia", actingFor: ana.user.id },
      parentVersion: 1,
      edits: [{ oldStr: "anchor", newStr: many }],
      note: "",
    });
    const err = await apiError(
      ana.api.wiki.decideWikiAnnotation(workspaceId, proposal.id, [{ hunkId: "h1", accept: true }]),
    );
    expect([err.status, err.code]).toEqual([400, "wiki.too_many_links"]);
    const [after] = (await ana.api.wiki.listWikiPageAnnotations(workspaceId, page.slug)).proposals;
    expect([after?.status, after?.hunks[0]?.status]).toEqual(["pending", "pending"]);
    expect((await rowOf(workspaceId, page.slug)).body).toBe("anchor");
  });
});
