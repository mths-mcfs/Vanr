// Wiki P1 (T6): per-page access with the SQL against JS fuzz, anchored comments, proposals reviewed change by
// change, index.md and the change log, the wiki check and the local graph. The agent tools (an agent reading,
// replying to a comment or proposing through a run) and "act on this comment" come with the agent tools and
// the chat; until then the proposal is created through the domain function those tools call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelProvider } from "@vanr/engine/models/types";
import { and, count, eq, isNull } from "drizzle-orm";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { RunningServer } from "../src/server";
import { createPage, pageBySlug, recordRead } from "../src/wiki";
import {
  agentKey,
  canReadPage,
  readablePagesSql,
  userKey,
  type WikiAccess,
  type WikiViewer,
} from "../src/wiki-access";
import {
  anchorAt,
  createProposal,
  LOCATE_CANDIDATES,
  locate,
  MAX_COMMENTS,
  MAX_HUNKS,
} from "../src/wiki-annotations";
import { summaryLine } from "../src/wiki-changes";
import { CHECK_NOW_GAP_MS, checkWorkspace, parseCheck } from "../src/wiki-checks";
import { Browser, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedDm, seedWorkspace } from "./seed";
import { apiError, wikiApi } from "./wiki-api";
import { connect, until } from "./wiki-live";

let skew = 0;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew), wikiDebounceMs: 50 });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@wiki-p1.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });
const db = () => server.deps.db;

/** An agent of the workspace, with the columns the agent route writes (the agents routes come later). */
async function seedAgent(workspaceId: string, owner: Person, name: string, channelIds: string[] = []) {
  const id = newId("agt");
  await db()
    .insert(schema.agents)
    .values({
      id,
      workspaceId,
      name,
      handle: `${name.toLowerCase()}${++n}`,
      model: "claude-haiku-5-5",
      ownerUserId: owner.user.id,
      appearance: { color: "blue", eyes: "round", adornment: "none" },
    });
  if (channelIds.length)
    await db()
      .insert(schema.channelMemberships)
      .values(channelIds.map((channelId) => ({ channelId, memberType: "agent" as const, memberId: id })));
  return id;
}

/** Ana (owner), Beto (member) and the agent Lia in #general. */
async function team() {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Handbook");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  const lia = await seedAgent(workspaceId, ana, "Lia", [general]);
  return { workspaceId, general, ana, beto, lia };
}

const restrictPrivate = { kind: "private" as const, userIds: [], agentIds: [] };
const rowOf = (workspaceId: string, slug: string) => pageBySlug(db(), { workspaceId, system: true }, slug);

describe("per-page access", () => {
  test(
    "attack: Beto doesn't read, find, list or see it in the graph, index, changes, panel, search, export or trash",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const secret = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Salaries",
        folder: "HR",
        body: "Salary table zebrafish. See [[Public]].",
      });
      const open = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Public",
        body: "See [[Salaries]].",
      });
      const set = await ana.api.wiki.setWikiPageAccess(workspaceId, secret.slug, restrictPrivate);
      expect(set.access).toMatchObject({ kind: "private", people: [{ name: "Ana" }], agents: [] });
      expect(set.restricted).toBe(true);
      // Restricting draws the slug's end: the old address is gone even for Ana.
      const slug = set.slug;
      expect(slug).toMatch(/^salaries-[a-z]{8}$/);
      expect((await apiError(ana.api.wiki.getWikiPage(workspaceId, secret.slug))).status).toBe(404);
      expect((await ana.api.wiki.listWikiPages(workspaceId)).find((p) => p.slug === slug)?.restricted).toBe(
        true,
      );

      // Every read path of one page answers 404, like a page that doesn't exist.
      const reads: [string, () => Promise<unknown>][] = [
        ["page", () => beto.api.wiki.getWikiPage(workspaceId, slug)],
        [
          "history",
          () => beto.browser.fetch(`/api/v1/workspaces/${workspaceId}/wiki/pages/${slug}/history`).then(fail),
        ],
        [
          "version",
          () =>
            beto.browser.fetch(`/api/v1/workspaces/${workspaceId}/wiki/pages/${slug}/versions/1`).then(fail),
        ],
        ["diff", () => beto.api.wiki.getWikiPageDiff(workspaceId, slug)],
        ["panel", () => beto.api.wiki.getWikiPagePanel(workspaceId, slug)],
        ["annotations", () => beto.api.wiki.listWikiPageAnnotations(workspaceId, slug)],
        ["comment", () => beto.api.wiki.createWikiPageComment(workspaceId, slug, { body: "hi" })],
        ["local graph", () => beto.api.wiki.getWikiGraph(workspaceId, { pageId: slug })],
        ["edit", () => beto.api.wiki.replaceWikiPage(workspaceId, slug, { body: "x", parentVersion: 1 })],
        ["access", () => beto.api.wiki.setWikiPageAccess(workspaceId, slug, null)],
        ["publish draft", () => beto.api.wiki.publishWikiPageDraft(workspaceId, slug)],
      ];
      const statuses: [string, number][] = [];
      for (const [what, call] of reads) statuses.push([what, (await apiError(call())).status]);
      expect(statuses).toEqual(reads.map(([what]) => [what, 404]));

      expect((await beto.api.wiki.listWikiPages(workspaceId)).map((p) => p.slug)).toEqual([open.slug]);
      expect(await beto.api.wiki.getWikiSearch(workspaceId, "zebrafish")).toEqual([]);
      expect((await ana.api.wiki.getWikiSearch(workspaceId, "zebrafish")).map((p) => p.slug)).toEqual([slug]);
      // The search index (seam 5): the chunks carry the page's audience.
      const hits = (who: Person) =>
        server.deps.search.search({ workspaceId, userId: who.user.id }, "zebrafish");
      expect(await hits(beto)).toEqual([]);
      expect((await hits(ana)).length).toBeGreaterThan(0);
      const graph = await beto.api.wiki.getWikiGraph(workspaceId);
      expect(graph.nodes.map((x) => x.slug)).toEqual([open.slug]);
      expect(graph.edges).toEqual([]);
      // The open page's panel: the link to the restricted one shows as a page that doesn't exist.
      const panel = await beto.api.wiki.getWikiPagePanel(workspaceId, open.slug);
      expect(panel.outgoing.map((o) => [o.state, o.page])).toEqual([["missing", null]]);
      expect(panel.inboundLinks).toEqual([]);
      expect((await beto.api.wiki.getWikiPage(workspaceId, open.slug)).inboundLinks).toEqual([]);
      expect(
        (await ana.api.wiki.getWikiPage(workspaceId, open.slug)).inboundLinks.map((b) => b.slug),
      ).toEqual([slug]);
      const index = await beto.api.wiki.getWikiIndex(workspaceId);
      expect(index.markdown).not.toContain("[[Salaries]]");
      expect(index.pages).toBe(1);
      expect((await beto.api.wiki.listWikiChanges(workspaceId)).map((e) => e.title)).not.toContain(
        "Salaries",
      );
      const zip = unzipSync(
        new Uint8Array(await (await beto.api.wiki.exportWiki(workspaceId)).arrayBuffer()),
      );
      expect(Object.keys(zip).some((k) => k.includes("Salaries"))).toBe(false);
      expect(Object.values(zip).some((v) => strFromU8(v).includes("zebrafish"))).toBe(false);
      // The trash: gone for whoever doesn't read it, to restore and to purge too.
      await ana.api.wiki.deleteWikiPage(workspaceId, slug);
      expect((await beto.api.wiki.getWikiTrash(workspaceId)).map((p) => p.slug)).toEqual([]);
      expect((await apiError(beto.api.wiki.restoreWikiTrash(workspaceId, slug))).status).toBe(404);
      expect((await apiError(beto.api.wiki.deleteWikiTrash(workspaceId, slug))).status).toBe(404);
      await ana.api.wiki.restoreWikiTrash(workspaceId, slug);
      // Back to the workspace: Beto reads it again, in the search too.
      await ana.api.wiki.setWikiPageAccess(workspaceId, slug, null);
      expect((await beto.api.wiki.getWikiPage(workspaceId, slug)).title).toBe("Salaries");
      expect((await beto.api.wiki.getWikiSearch(workspaceId, "zebrafish")).map((p) => p.slug)).toEqual([
        slug,
      ]);
      expect((await hits(beto)).length).toBeGreaterThan(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "by channel: whoever reads the channel; joining and leaving it; a channel they don't read is rejected",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const board = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Agenda", body: "Board agenda." });
      const set = await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, {
        kind: "channel",
        channelId: board,
      });
      expect(set.access).toEqual({ kind: "channel", channelId: board, channelName: "board" });
      expect((await apiError(beto.api.wiki.getWikiPage(workspaceId, set.slug))).status).toBe(404);
      // Beto doesn't restrict to a channel he doesn't read (nor learns it exists).
      const other = await beto.api.wiki.createWikiPage(workspaceId, { title: "Mine", body: "x" });
      const rejected = await apiError(
        beto.api.wiki.setWikiPageAccess(workspaceId, other.slug, { kind: "channel", channelId: board }),
      );
      expect([rejected.status, rejected.code]).toEqual([400, "wiki.access.channel"]);
      // A DM is not a channel to restrict to.
      const dmId = await seedDm(server, workspaceId, ana, beto);
      const dm = await apiError(
        ana.api.wiki.setWikiPageAccess(workspaceId, set.slug, { kind: "channel", channelId: dmId }),
      );
      expect([dm.status, dm.code]).toEqual([400, "wiki.access.channel"]);
      const membership = { channelId: board, memberType: "person" as const, memberId: beto.user.id };
      await db().insert(schema.channelMemberships).values(membership);
      expect((await beto.api.wiki.getWikiPage(workspaceId, set.slug)).title).toBe("Agenda");
      await db()
        .delete(schema.channelMemberships)
        .where(
          and(
            eq(schema.channelMemberships.channelId, board),
            eq(schema.channelMemberships.memberType, "person"),
            eq(schema.channelMemberships.memberId, beto.user.id),
          ),
        );
      expect((await apiError(beto.api.wiki.getWikiPage(workspaceId, set.slug))).status).toBe(404);
      // A channel deleted under the page leaves it to nobody, the admin included (the access names it).
      await db().delete(schema.channels).where(eq(schema.channels.id, board));
      expect((await apiError(ana.api.wiki.getWikiPage(workspaceId, set.slug))).status).toBe(404);
      expect((await rowOf(workspaceId, set.slug)).access).toEqual({ kind: "channel", channelId: board });
    },
    SERVER_TEST_MS,
  );

  test("attack: a person or agent of another workspace (or an archived agent) on the list is rejected; whoever restricts is always in", async () => {
    const { workspaceId, ana, beto } = await team();
    const other = await team();
    const archived = await seedAgent(workspaceId, ana, "Old");
    await db().update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived));
    const page = await beto.api.wiki.createWikiPage(workspaceId, { title: "Notes", body: "x" });
    for (const input of [
      { kind: "private" as const, userIds: [other.ana.user.id], agentIds: [] },
      { kind: "private" as const, userIds: [], agentIds: [other.lia] },
      { kind: "private" as const, userIds: [], agentIds: [archived] },
      { kind: "channel" as const, channelId: other.general },
    ]) {
      const err = await apiError(beto.api.wiki.setWikiPageAccess(workspaceId, page.slug, input));
      expect([err.status, err.code]).toEqual(
        input.kind === "channel" ? [400, "wiki.access.channel"] : [400, "wiki.access.principal"],
      );
    }
    expect((await rowOf(workspaceId, page.slug)).access).toBeNull();
    const set = await beto.api.wiki.setWikiPageAccess(workspaceId, page.slug, {
      kind: "private",
      userIds: [ana.user.id],
      agentIds: [],
    });
    expect(set.access?.kind === "private" && set.access.people.map((p) => p.name).sort()).toEqual([
      "Ana",
      "Beto",
    ]);
    // A body that isn't the contract is a 400 before anything is read.
    const bad = await beto.browser.json(
      `/api/v1/workspaces/${workspaceId}/wiki/pages/${set.slug}/access`,
      "PUT",
      { access: { kind: "private", principals: ["user:x"] } },
    );
    expect(bad.status).toBe(400);
  });

  test(
    "attack: the restricted title doesn't leak through the slug, the check, a link or the vault import",
    async () => {
      const { workspaceId, ana, beto } = await team();
      const hidden = await ana.api.wiki.createWikiPage(workspaceId, {
        title: "Firing Carl",
        folder: "HR",
        body: "Confidential. See [[Target]].",
      });
      await ana.api.wiki.setWikiPageAccess(workspaceId, hidden.slug, restrictPrivate);
      await beto.api.wiki.createWikiPage(workspaceId, { title: "Target", body: "x" });
      await beto.api.wiki.createWikiPage(workspaceId, {
        title: "Probe",
        body: "[[Firing Carl]] [[Firing Mary]]",
      });
      // The check: a link to the restricted page is like a link to nothing, and the link out of the restricted
      // page doesn't take "Target" off the orphans of whoever doesn't read it.
      const kinds = (report: Awaited<ReturnType<typeof beto.api.wiki.getWikiChecks>>) => ({
        broken: report.findings
          .flatMap((f) => (f.kind === "broken_link" ? [`${f.target}:${f.state}`] : []))
          .sort(),
        orphans: report.findings.flatMap((f) => (f.kind === "orphan" ? [f.page.title] : [])).sort(),
      });
      expect(kinds(await beto.api.wiki.getWikiChecks(workspaceId))).toEqual({
        broken: ["Firing Carl:missing", "Firing Mary:missing"],
        orphans: ["Probe", "Target"],
      });
      expect(kinds(await ana.api.wiki.getWikiChecks(workspaceId))).toEqual({
        broken: ["Firing Mary:missing"],
        orphans: ["Probe"],
      });
      // The vault import: the note with the restricted page's title and folder goes in (skipping it would
      // confirm the page).
      // (A second note at the root keeps "HR" from being taken for the vault's outer folder.)
      const zip = zipSync({ "HR/Firing Carl.md": strToU8("my version"), "Readme.md": strToU8("hi") });
      const imported = await beto.api.wiki.importWikiVault(workspaceId, {
        file: new Blob([zip]),
        fileName: "hr.zip",
      });
      expect([imported.created, imported.skipped]).toEqual([2, 0]);
      // The slug: Beto's note gets the title's, like a title nobody used.
      const other = await beto.api.wiki.createWikiPage(workspaceId, {
        title: "Firing Mary",
        folder: "HR",
        body: "x",
      });
      const twin = (await beto.api.wiki.listWikiPages(workspaceId)).find((p) => p.title === "Firing Carl");
      expect([twin?.slug, other.slug]).toEqual(["firing-carl", "firing-mary"]);
      // A link: in a title tie, the workspace's page wins over the restricted one (for Beto and for Ana).
      const probe = (who: typeof ana) => who.api.wiki.getWikiPagePanel(workspaceId, "probe");
      expect((await probe(beto)).outgoing.map((o) => o.page?.slug ?? o.state)).toEqual([
        "firing-carl",
        "firing-mary",
      ]);
      expect((await probe(ana)).outgoing[0]?.page?.slug).toBe("firing-carl");
      // The tie on the title is won by the workspace's page even when the restricted one has the shorter folder
      // (a title with a space, so the link's text isn't a slug: the slug step comes first).
      const budget = await ana.api.wiki.createWikiPage(workspaceId, { title: "Team Budget", body: "secret" });
      await ana.api.wiki.setWikiPageAccess(workspaceId, budget.slug, restrictPrivate);
      const open = await beto.api.wiki.createWikiPage(workspaceId, {
        title: "Team Budget",
        folder: "Finance/Deep",
        body: "o",
      });
      const linker = await beto.api.wiki.createWikiPage(workspaceId, {
        title: "Linker",
        body: "[[Team Budget]]",
      });
      for (const who of [ana, beto])
        expect((await who.api.wiki.getWikiPagePanel(workspaceId, linker.slug)).outgoing[0]?.page?.slug).toBe(
          open.slug,
        );
    },
    SERVER_TEST_MS,
  );

  test("attack: only who created the page or an admin changes who reads it, with the role read when it writes", async () => {
    const { workspaceId, ana, beto } = await team();
    const anas = await ana.api.wiki.createWikiPage(workspaceId, { title: "Policy", body: "rule" });
    expect((await beto.api.wiki.getWikiPage(workspaceId, anas.slug)).accessEditable).toBe(false);
    // Beto edits Ana's page, but doesn't lock it away for himself (it would vanish even for her).
    const err = await apiError(beto.api.wiki.setWikiPageAccess(workspaceId, anas.slug, restrictPrivate));
    expect([err.status, err.code]).toEqual([403, "wiki.access.owner"]);
    expect((await ana.api.wiki.getWikiPage(workspaceId, anas.slug)).access).toBeNull();
    // Beto's page (and the one an agent created for him), he restricts.
    const betos = await beto.api.wiki.createWikiPage(workspaceId, { title: "Beto's draft", body: "x" });
    expect((await beto.api.wiki.getWikiPage(workspaceId, betos.slug)).accessEditable).toBe(true);
    const forBeto = await createPage(server.deps, {
      workspaceId,
      title: "Made by Lia",
      body: "y",
      author: { type: "agent", id: "agt_lia", actingFor: beto.user.id },
    });
    expect((await beto.api.wiki.getWikiPage(workspaceId, forBeto.slug)).accessEditable).toBe(true);
    expect((await ana.api.wiki.getWikiPage(workspaceId, forBeto.slug)).accessEditable).toBe(true);
    const mine = await beto.api.wiki.setWikiPageAccess(workspaceId, betos.slug, {
      kind: "private",
      userIds: [ana.user.id],
      agentIds: [],
    });
    // An admin (Ana owns the workspace) changes the access of any page she reads.
    expect((await ana.api.wiki.setWikiPageAccess(workspaceId, mine.slug, null)).access).toBeNull();
    // A locked page: only an admin, even for its creator.
    await ana.api.wiki.lockWikiPage(workspaceId, mine.slug, true);
    expect(
      (await apiError(beto.api.wiki.setWikiPageAccess(workspaceId, mine.slug, restrictPrivate))).code,
    ).toBe("wiki.page_locked");
    // An admin who didn't create the page and is demoted to member loses it; the creator keeps it.
    const caio = withApi(await memberOf(server, workspaceId, "Caio", email("caio"), "admin"));
    const p = await beto.api.wiki.createWikiPage(workspaceId, { title: "Caio test", body: "z" });
    expect((await caio.api.wiki.getWikiPage(workspaceId, p.slug)).accessEditable).toBe(true);
    await db()
      .update(schema.members)
      .set({ role: "member" })
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, caio.user.id)));
    expect((await apiError(caio.api.wiki.setWikiPageAccess(workspaceId, p.slug, restrictPrivate))).code).toBe(
      "wiki.access.owner",
    );
  });

  test("a person taken off the workspace stays on the list but reads nothing; an id of another workspace is 404", async () => {
    const { workspaceId, ana, beto } = await team();
    const other = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Shared", body: "x" });
    const set = await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, {
      kind: "private",
      userIds: [beto.user.id],
      agentIds: [],
    });
    expect((await beto.api.wiki.getWikiPage(workspaceId, set.slug)).title).toBe("Shared");
    await db()
      .delete(schema.members)
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, beto.user.id)));
    expect((await apiError(beto.api.wiki.getWikiPage(workspaceId, set.slug))).status).toBe(404);
    expect((await apiError(beto.api.wiki.getWikiChecks(workspaceId))).status).toBe(404);
    // Someone of another workspace, with the page's address in their own workspace's path.
    expect((await apiError(other.ana.api.wiki.getWikiPage(other.workspaceId, set.slug))).status).toBe(404);
    // Signed out: 401 on every new route.
    const anon = wikiApi(new Browser(server.url));
    for (const call of [
      () => anon.setWikiPageAccess(workspaceId, set.slug, null),
      () => anon.listWikiPageAnnotations(workspaceId, set.slug),
      () => anon.createWikiPageComment(workspaceId, set.slug, { body: "x" }),
      () => anon.setWikiAnnotationResolution(workspaceId, "ann_x"),
      () => anon.deleteWikiAnnotationResolution(workspaceId, "ann_x"),
      () => anon.deleteWikiAnnotation(workspaceId, "ann_x"),
      () => anon.decideWikiAnnotation(workspaceId, "ann_x", [{ hunkId: "h1", accept: true }]),
      () => anon.getWikiIndex(workspaceId),
      () => anon.listWikiChanges(workspaceId),
      () => anon.getWikiChecks(workspaceId),
      () => anon.createWikiCheck(workspaceId),
    ])
      expect((await apiError(call())).status).toBe(401);
  });

  test("attack: the most read pages and a rename's relinking name no restricted page", async () => {
    const { workspaceId, ana, beto, lia } = await team();
    const target = await beto.api.wiki.createWikiPage(workspaceId, { title: "Handbook", body: "x" });
    const hidden = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Hidden",
      body: "See [[Handbook]].",
    });
    const open = await ana.api.wiki.createWikiPage(workspaceId, { title: "Open", body: "See [[Handbook]]." });
    const { slug } = await ana.api.wiki.setWikiPageAccess(workspaceId, hidden.slug, restrictPrivate);
    for (const s of [slug, open.slug])
      await recordRead(server.deps, (await rowOf(workspaceId, s)).id, { type: "agent", id: lia });
    expect((await beto.api.wiki.getWikiReads(workspaceId)).map((r) => r.slug)).toEqual([open.slug]);
    expect((await ana.api.wiki.getWikiReads(workspaceId)).map((r) => r.slug).sort()).toEqual(
      [open.slug, slug].sort(),
    );
    // Beto renames: the link in the restricted page is rewritten too, but the answer only names what he reads.
    const renamed = await beto.api.wiki.renameWikiPage(workspaceId, target.slug, "Guidebook");
    expect(renamed.relinked?.rewritten.map((p) => p.slug)).toEqual([open.slug]);
    expect((await rowOf(workspaceId, slug)).body).toBe("See [[Guidebook]].");
  });

  test("a page in a restricted page's folder, or moved into it, doesn't inherit the restriction", async () => {
    const { workspaceId, ana, beto } = await team();
    const parent = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Plans",
      folder: "Board",
      body: "x",
    });
    await ana.api.wiki.setWikiPageAccess(workspaceId, parent.slug, restrictPrivate);
    const sibling = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Minutes",
      folder: "Board",
      body: "y",
    });
    const moved = await ana.api.wiki.createWikiPage(workspaceId, { title: "Loose", body: "z" });
    await ana.api.wiki.moveWikiPage(workspaceId, moved.slug, "Board");
    const seen = (await beto.api.wiki.listWikiPages(workspaceId)).map((p) => [
      p.slug,
      p.folder,
      p.restricted,
    ]);
    expect(seen.sort()).toEqual([
      [moved.slug, "Board", false],
      [sibling.slug, "Board", false],
    ]);
  });

  test("an agent reading for a person: what both read (the intersection)", async () => {
    const { workspaceId, ana, beto, lia } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Plans", body: "Secret plan." });
    const { slug } = await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, restrictPrivate);
    const row = await rowOf(workspaceId, slug);
    const reads = (v: Omit<WikiViewer, "workspaceId">) => canReadPage(db(), { workspaceId, ...v }, row);
    // Ana reads it, but Lia isn't on the list: Lia doesn't read it, not even for Ana.
    expect([
      await reads({ userId: ana.user.id }),
      await reads({ userId: ana.user.id, agentId: lia }),
    ]).toEqual([true, false]);
    // Already restricted: changing the list doesn't change the slug.
    const again = await ana.api.wiki.setWikiPageAccess(workspaceId, slug, {
      kind: "private",
      userIds: [],
      agentIds: [lia],
    });
    expect(again.slug).toBe(slug);
    const updated = await rowOf(workspaceId, slug);
    const after = (v: Omit<WikiViewer, "workspaceId">) => canReadPage(db(), { workspaceId, ...v }, updated);
    expect([
      await after({ userId: ana.user.id, agentId: lia }),
      await after({ agentId: lia }),
      // Beto asks the same Lia: he doesn't read it, so she doesn't read it for him.
      await after({ userId: beto.user.id, agentId: lia }),
      await after({}),
    ]).toEqual([true, true, false, false]);
  });

  test(
    "fuzz: the rule in SQL (readablePagesSql) and in JS (canReadPage) give the same answer",
    async () => {
      let seed = 0x5eed;
      const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = <T>(xs: readonly T[]): T => {
        const x = xs[Math.floor(rand() * xs.length)];
        if (x === undefined) throw new Error("empty");
        return x;
      };
      const some = <T>(xs: readonly T[]): T[] => xs.filter(() => rand() < 0.4);

      const { workspaceId, ana, beto, lia, general } = await team();
      const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
      const people = [ana, beto, caio];
      const channels = [general];
      for (const [i, visibility] of (["public", "public", "private", "private"] as const).entries()) {
        const members = some([beto, caio]);
        channels.push(
          await seedChannel(server, workspaceId, { name: `c${i}`, visibility, members: [ana, ...members] }),
        );
      }
      const agents = [lia];
      for (const name of ["Rui", "Sol"]) agents.push(await seedAgent(workspaceId, ana, name, some(channels)));
      // Keys of people who left or never existed also show up on real pages.
      const keys = [
        ...people.map((p) => userKey(p.user.id)),
        ...agents.map(agentKey),
        userKey("usr_ghost"),
        agentKey("agt_ghost"),
      ];
      for (let i = 0; i < 40; i++) {
        const p = await ana.api.wiki.createWikiPage(workspaceId, { title: `P${i}`, body: "x" });
        const r = rand();
        const access: WikiAccess | null =
          r < 0.25
            ? null
            : r < 0.6
              ? { kind: "channel", channelId: rand() < 0.1 ? "ch_ghost" : pick(channels) }
              : { kind: "private", principals: some(keys) };
        await db()
          .update(schema.knowledgePages)
          .set({ access })
          .where(
            and(eq(schema.knowledgePages.workspaceId, workspaceId), eq(schema.knowledgePages.slug, p.slug)),
          );
      }
      const rows = await db()
        .select()
        .from(schema.knowledgePages)
        .where(
          and(eq(schema.knowledgePages.workspaceId, workspaceId), isNull(schema.knowledgePages.deletedAt)),
        );
      const viewers: WikiViewer[] = [{ workspaceId }];
      for (const p of people) viewers.push({ workspaceId, userId: p.user.id });
      for (const a of agents) viewers.push({ workspaceId, agentId: a });
      for (const p of people)
        for (const a of agents) viewers.push({ workspaceId, userId: p.user.id, agentId: a });
      let readable = 0;
      for (const viewer of viewers) {
        const bySql = (
          await db()
            .select({ id: schema.knowledgePages.id })
            .from(schema.knowledgePages)
            .where(
              and(
                eq(schema.knowledgePages.workspaceId, workspaceId),
                isNull(schema.knowledgePages.deletedAt),
                readablePagesSql(viewer),
              ),
            )
        )
          .map((r) => r.id)
          .sort();
        const byJs: string[] = [];
        for (const row of rows) if (await canReadPage(db(), viewer, row)) byJs.push(row.id);
        expect({ viewer, ids: bySql }).toEqual({ viewer, ids: byJs.sort() });
        readable += bySql.length;
      }
      // The fuzz exercised both sides: not everything readable, nor nothing.
      expect(readable).toBeGreaterThan(viewers.length);
      expect(readable).toBeLessThan(viewers.length * rows.length);
    },
    SERVER_TEST_MS * 2,
  );
});

/** Throws the error of a fetch that must fail (for the routes the test client has no method for). */
async function fail(res: Response): Promise<never> {
  const { ApiError } = await import("./wiki-api");
  throw new ApiError(res.status, `http_${res.status}`, await res.text());
}

describe("anchored comments", () => {
  test("the anchor finds the right occurrence by its context; a deleted passage becomes an orphan", () => {
    const text = "The deadline is Friday. Then: the deadline is Friday, again.";
    const at = text.lastIndexOf("deadline is Friday");
    const anchor = anchorAt(text, at, "deadline is Friday".length);
    expect(locate(text, anchor)).toBe(at);
    expect(locate(`New start. ${text}`, anchor)).toBe(at + "New start. ".length);
    expect(locate("Nothing like it here.", anchor)).toBeNull();
  });

  test("attack: a short quote in a long page doesn't stall the read; special characters, MiBs and blocks", () => {
    const text = "e ".repeat(100_000);
    const hostile = { quote: "e", prefix: `x${" e".repeat(31)} `, suffix: ` ${"e ".repeat(31)}y` };
    // 100 thousand occurrences of "e": the count stops at the ceiling (proven by the count, not the clock).
    const stats = { checked: 0 };
    expect(locate(text, hostile, stats)).not.toBeNull();
    expect(stats.checked).toBe(LOCATE_CANDIDATES);
    // With the whole context in the text, the position is exact even among thousands of occurrences.
    const body = `${"e ".repeat(50_000)}target e right${" e".repeat(50_000)}`;
    const at = body.indexOf("e right");
    expect(locate(body, anchorAt(body, at, 1))).toBe(at);
    // A quote made of regular expression characters is literal.
    const regex = "Costs (.*) [a-z]+ $1 \\d? ^end";
    const page = `Intro.\n\n${regex}\n\nOutro.`;
    expect(locate(page, anchorAt(page, page.indexOf(regex), regex.length))).toBe(page.indexOf(regex));
    expect(locate("Costs anything", { quote: "(.*)", prefix: "", suffix: "" })).toBeNull();
    // A page of a few MiB, with the quote near the end.
    const big = `${"lorem ipsum ".repeat(300_000)}needle here`;
    expect(big.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(locate(big, anchorAt(big, big.indexOf("needle"), 6))).toBe(big.indexOf("needle"));
    // A quote that crosses Markdown blocks (a heading and a list).
    const md = "# Title\n\n- one\n- two\n\nEnd.";
    const cross = "Title\n\n- one";
    expect(locate(md, anchorAt(md, md.indexOf(cross), cross.length))).toBe(md.indexOf(cross));
  });

  test("the ceiling of comments per page", async () => {
    const { workspaceId, ana } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Long", body: "text" });
    const row = await rowOf(workspaceId, page.slug);
    const now = new Date();
    await db()
      .insert(schema.pageAnnotations)
      .values(
        Array.from({ length: MAX_COMMENTS - 1 }, (_, i) => ({
          id: `ann_cap${i}_${workspaceId}`,
          workspaceId,
          pageId: row.id,
          kind: "comment" as const,
          author: { type: "person" as const, id: ana.user.id },
          body: "x",
          status: "open" as const,
          createdAt: now,
          updatedAt: now,
        })),
      );
    await ana.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: "the last one that fits" });
    const err = await apiError(
      ana.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: "one more" }),
    );
    expect([err.status, err.code, err.params?.max]).toEqual([409, "wiki.comment.too_many", MAX_COMMENTS]);
    // Comments at once on a page one short of the ceiling: exactly one gets in.
    await db()
      .delete(schema.pageAnnotations)
      .where(eq(schema.pageAnnotations.id, `ann_cap0_${workspaceId}`));
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        ana.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: `race ${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [total] = await db()
      .select({ n: count() })
      .from(schema.pageAnnotations)
      .where(eq(schema.pageAnnotations.pageId, row.id));
    expect(total?.n).toBe(MAX_COMMENTS);
  });

  test("comment, reply, resolve and reopen; an orphan when the passage goes; only the author or an admin deletes", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Deadlines",
      body: "The deadline is Friday.\n\nAnother paragraph.",
    });
    const anchor = { quote: "deadline is Friday", prefix: "The ", suffix: ".\n\nAnother" };
    const root = await beto.api.wiki.createWikiPageComment(workspaceId, page.slug, {
      body: "Not Thursday?",
      anchor,
    });
    expect(root).toMatchObject({
      anchorState: "ok",
      status: "open",
      author: { type: "person", id: beto.user.id },
    });
    const reply = await ana.api.wiki.createWikiPageComment(workspaceId, page.slug, {
      body: "Friday.",
      parentId: root.id,
    });
    // A reply to a reply hangs on the thread's first comment, and keeps no anchor of its own.
    const deep = await beto.api.wiki.createWikiPageComment(workspaceId, page.slug, {
      body: "Ok.",
      parentId: reply.id,
      anchor,
    });
    expect([reply.parentId, deep.parentId, deep.anchor]).toEqual([root.id, root.id, null]);
    expect((await ana.api.wiki.setWikiAnnotationResolution(workspaceId, root.id)).status).toBe("resolved");
    // Only the thread's first comment is resolved; a reply is not a thread.
    expect((await apiError(ana.api.wiki.setWikiAnnotationResolution(workspaceId, reply.id))).status).toBe(
      404,
    );
    // Replying on a resolved thread opens it again.
    await beto.api.wiki.createWikiPageComment(workspaceId, page.slug, {
      body: "Changed.",
      parentId: root.id,
    });
    let notes = await ana.api.wiki.listWikiPageAnnotations(workspaceId, page.slug);
    expect(notes.comments.find((c) => c.id === root.id)?.status).toBe("open");
    expect((await ana.api.wiki.setWikiAnnotationResolution(workspaceId, root.id)).status).toBe("resolved");
    expect((await beto.api.wiki.deleteWikiAnnotationResolution(workspaceId, root.id)).status).toBe("open");
    const current = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: "The deadline is Thursday.\n\nAnother paragraph.",
      parentVersion: current.version,
    });
    notes = await ana.api.wiki.listWikiPageAnnotations(workspaceId, page.slug);
    expect(notes.comments.find((c) => c.id === root.id)?.anchorState).toBe("orphan");
    // Beto doesn't delete Ana's comment; Ana (admin) deletes Beto's, with its replies.
    expect((await apiError(beto.api.wiki.deleteWikiAnnotation(workspaceId, reply.id))).status).toBe(403);
    await ana.api.wiki.deleteWikiAnnotation(workspaceId, root.id);
    expect((await ana.api.wiki.listWikiPageAnnotations(workspaceId, page.slug)).comments).toEqual([]);
    // A quote over the limit is a 400.
    const long = await apiError(
      ana.api.wiki.createWikiPageComment(workspaceId, page.slug, {
        body: "x",
        anchor: { quote: "q".repeat(2001), prefix: "", suffix: "" },
      }),
    );
    expect(long.status).toBe(400);
  });

  test("asking an agent to act on a comment is rejected at the entry, with nothing written (until the chat and the runtime)", async () => {
    const { workspaceId, ana, lia } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Onboarding",
      body: "Day one: badge.",
    });
    const err = await apiError(
      ana.api.wiki.createWikiPageComment(workspaceId, page.slug, {
        body: "Add the laptop.",
        anchor: { quote: "badge", prefix: "one: ", suffix: "." },
        agentId: lia,
      }),
    );
    expect([err.status, err.code]).toEqual([503, "not_available"]);
    const row = await rowOf(workspaceId, page.slug);
    expect(
      await db().select().from(schema.pageAnnotations).where(eq(schema.pageAnnotations.pageId, row.id)),
    ).toEqual([]);
    expect((await ana.api.wiki.listWikiChanges(workspaceId)).map((c) => c.action)).toEqual(["create"]);
  });

  test("attack: a restricted page's annotations are 404 to whoever doesn't read it, and so is another workspace's id", async () => {
    const { workspaceId, ana, beto } = await team();
    const other = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Private notes", body: "x" });
    const root = await ana.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: "mine" });
    await ana.api.wiki.setWikiPageAccess(workspaceId, page.slug, restrictPrivate);
    for (const call of [
      () => beto.api.wiki.setWikiAnnotationResolution(workspaceId, root.id),
      () => beto.api.wiki.deleteWikiAnnotationResolution(workspaceId, root.id),
      () => beto.api.wiki.deleteWikiAnnotation(workspaceId, root.id),
      () => beto.api.wiki.createWikiPageComment(workspaceId, page.slug, { body: "x", parentId: root.id }),
      // Another workspace's admin with this workspace's annotation id in their path.
      () => other.ana.api.wiki.setWikiAnnotationResolution(other.workspaceId, root.id),
      () => other.ana.api.wiki.deleteWikiAnnotation(other.workspaceId, root.id),
      () =>
        other.ana.api.wiki.decideWikiAnnotation(other.workspaceId, root.id, [{ hunkId: "h1", accept: true }]),
    ])
      expect((await apiError(call())).status).toBe(404);
    // A reply that names another page's thread is a 404 too (the parent is looked up on this page).
    const otherPage = await beto.api.wiki.createWikiPage(workspaceId, { title: "Other", body: "y" });
    const elsewhere = await beto.api.wiki.createWikiPageComment(workspaceId, otherPage.slug, {
      body: "first",
    });
    const restricted = (await ana.api.wiki.listWikiPages(workspaceId)).find((p) => p.restricted);
    expect(
      (
        await apiError(
          ana.api.wiki.createWikiPageComment(workspaceId, String(restricted?.slug), {
            body: "x",
            parentId: elsewhere.id,
          }),
        )
      ).status,
    ).toBe(404);
  });
});

/** A proposal by Lia acting for `who`, as the agent tool will create it. */
async function propose(
  workspaceId: string,
  slug: string,
  lia: string,
  who: Person,
  edits: [string, string][],
  note = "",
) {
  const page = await rowOf(workspaceId, slug);
  return createProposal(server.deps, {
    page,
    author: { type: "agent", id: lia, actingFor: who.user.id },
    parentVersion: page.version,
    edits: edits.map(([oldStr, newStr]) => ({ oldStr, newStr })),
    note,
  });
}

describe("proposals", () => {
  test("Lia proposes, Ana accepts one change and rejects another; the third goes stale", async () => {
    const { workspaceId, ana, beto, lia } = await team();
    const body = "# Rules\n\nVacation: 20 days.\n\nHome office: 2 days.\n\nRefund: 30 days.\n";
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Rules", body });
    await ana.api.wiki.updateWikiPageMeta(workspaceId, page.slug, {
      parentVersion: 1,
      agentEdits: "propose",
    });
    const tree = await ana.api.wiki.listWikiPages(workspaceId);
    expect(tree.find((p) => p.slug === page.slug)?.agentEdits).toBe("propose");
    // A passage that isn't there rejects the whole proposal; so does a proposal of too many changes.
    expect(propose(workspaceId, page.slug, lia, beto, [["Leave: 5 days", "x"]])).rejects.toMatchObject({
      status: 400,
      code: "wiki.proposal.invalid",
    });
    const many = Array.from({ length: MAX_HUNKS + 1 }, (): [string, string] => ["Vacation", "Holiday"]);
    expect(propose(workspaceId, page.slug, lia, beto, many)).rejects.toMatchObject({
      code: "wiki.proposal.invalid",
    });
    await propose(
      workspaceId,
      page.slug,
      lia,
      beto,
      [
        ["Vacation: 20 days.", "Vacation: 30 days."],
        ["Home office: 2 days.", "Home office: 3 days."],
        ["Refund: 30 days.", "Refund: 15 days."],
      ],
      "New policy",
    );
    expect((await ana.api.wiki.getWikiPage(workspaceId, page.slug)).body).toBe(body);
    const [proposal] = (await ana.api.wiki.listWikiPageAnnotations(workspaceId, page.slug)).proposals;
    expect(proposal).toMatchObject({
      note: "New policy",
      status: "pending",
      parentVersion: 1,
      author: { type: "agent", id: lia, actingFor: beto.user.id },
    });
    expect(proposal?.hunks.map((h) => [h.id, h.status])).toEqual([
      ["h1", "pending"],
      ["h2", "pending"],
      ["h3", "pending"],
    ]);
    const id = String(proposal?.id);
    // The same change twice in one request is rejected.
    const twice = await apiError(
      ana.api.wiki.decideWikiAnnotation(workspaceId, id, [
        { hunkId: "h1", accept: true },
        { hunkId: "h1", accept: true },
      ]),
    );
    expect(twice.status).toBe(400);
    const first = await ana.api.wiki.decideWikiAnnotation(workspaceId, id, [
      { hunkId: "h1", accept: true },
      { hunkId: "h2", accept: false },
    ]);
    expect(first.page.body).toContain("Vacation: 30 days.");
    expect(first.page.body).toContain("Home office: 2 days.");
    expect(first.page.version).toBe(2);
    expect(first.proposal.status).toBe("pending");
    const history = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(history.history[0]?.author).toMatchObject({ type: "agent", id: lia, actingFor: ana.user.id });
    // Deciding again what was decided: 409.
    expect(
      (await apiError(ana.api.wiki.decideWikiAnnotation(workspaceId, id, [{ hunkId: "h1", accept: true }])))
        .status,
    ).toBe(409);
    // Someone changes the third change's passage before the decision: it goes stale and the page doesn't change.
    await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, {
      body: first.page.body.replace("Refund: 30 days.", "Refund: 45 days."),
      parentVersion: 2,
    });
    const last = await ana.api.wiki.decideWikiAnnotation(workspaceId, id, [{ hunkId: "h3", accept: true }]);
    expect(last.proposal.status).toBe("done");
    expect(last.proposal.hunks.map((h) => h.status)).toEqual(["accepted", "rejected", "stale"]);
    expect(last.page.version).toBe(3);
    expect(last.page.body).toContain("Refund: 45 days.");
    // Rejecting alone writes no version.
    const { row } = await propose(workspaceId, page.slug, lia, beto, [
      ["Refund: 45 days.", "Refund: 60 days."],
    ]);
    const rejected = await ana.api.wiki.decideWikiAnnotation(workspaceId, row.id, [
      { hunkId: "h1", accept: false },
    ]);
    expect([rejected.page.version, rejected.proposal.status]).toEqual([3, "done"]);
  });

  test("attack: two clicks at once apply the change once; on a locked page only an admin decides", async () => {
    const { workspaceId, ana, beto, lia } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Counter", body: "Value: 1.\n" });
    const { row } = await propose(workspaceId, page.slug, lia, beto, [["Value: 1.", "Value: 1. Value: 1."]]);
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    expect(
      (
        await apiError(
          beto.api.wiki.decideWikiAnnotation(workspaceId, row.id, [{ hunkId: "h1", accept: true }]),
        )
      ).status,
    ).toBe(403);
    const results = await Promise.allSettled([
      ana.api.wiki.decideWikiAnnotation(workspaceId, row.id, [{ hunkId: "h1", accept: true }]),
      ana.api.wiki.decideWikiAnnotation(workspaceId, row.id, [{ hunkId: "h1", accept: true }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(final.body).toBe("Value: 1. Value: 1.\n");
    expect(final.version).toBe(2);
    // Who may edit the page decides how agents change it; a member on a locked page doesn't.
    const locked = await apiError(
      beto.api.wiki.updateWikiPageMeta(workspaceId, page.slug, { parentVersion: 2, agentEdits: "propose" }),
    );
    expect([locked.status, locked.code]).toEqual([403, "wiki.page_locked"]);
    const set = await ana.api.wiki.updateWikiPageMeta(workspaceId, page.slug, {
      parentVersion: 2,
      agentEdits: "propose",
    });
    expect([set.agentEdits, set.version]).toEqual(["propose", 2]);
  });

  test(
    "a person typing in the live editor and a proposal accepted at the same time: both stay",
    async () => {
      const { workspaceId, ana, beto, lia } = await team();
      const body = "# Plan\n\nOne.\n\nTwo.\n\nThree.\n";
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Live plan", body });
      const typing = connect(server, beto.browser, workspaceId, `wiki/${workspaceId}/${page.slug}`);
      await typing.synced;
      await typing.edit((md) => md.replace("One.", "One, typed live."));
      // The draft reached the server before the decision (the autosave).
      await until(async () => {
        const [d] = await db()
          .select({ dirty: schema.wikiPageDocs.dirty })
          .from(schema.wikiPageDocs)
          .innerJoin(schema.knowledgePages, eq(schema.knowledgePages.id, schema.wikiPageDocs.pageId))
          .where(eq(schema.knowledgePages.slug, page.slug));
        return d?.dirty === true;
      });
      const { row } = await propose(workspaceId, page.slug, lia, beto, [["Three.", "Three, proposed."]]);
      const decided = await ana.api.wiki.decideWikiAnnotation(workspaceId, row.id, [
        { hunkId: "h1", accept: true },
      ]);
      expect(decided.page.body).toContain("Three, proposed.");
      await until(async () => (await typing.md()).includes("Three, proposed."));
      const live = await typing.md();
      expect([live.includes("One, typed live."), live.includes("Three, proposed.")]).toEqual([true, true]);
      typing.close();
    },
    SERVER_TEST_MS,
  );
});

describe("index.md and the change log", () => {
  test("the log has create, update, rename, move, trash, restore, comment and proposal, newest first", async () => {
    const { workspaceId, ana, beto, lia } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Guide", body: "First line." });
    await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: "Second.", parentVersion: 1 });
    const renamed = await ana.api.wiki.renameWikiPage(workspaceId, page.slug, "New guide");
    await ana.api.wiki.moveWikiPage(workspaceId, renamed.slug, "Docs");
    await ana.api.wiki.deleteWikiPage(workspaceId, renamed.slug);
    expect((await ana.api.wiki.listWikiChanges(workspaceId))[0]).toMatchObject({
      action: "trash",
      slug: null,
    });
    await ana.api.wiki.restoreWikiTrash(workspaceId, renamed.slug);
    await beto.api.wiki.createWikiPageComment(workspaceId, renamed.slug, { body: "ok" });
    await propose(workspaceId, renamed.slug, lia, beto, [["Second.", "Third."]]);
    const log = await ana.api.wiki.listWikiChanges(workspaceId);
    expect(log.map((e) => e.action)).toEqual([
      "proposal",
      "comment",
      "restore",
      "trash",
      "move",
      "rename",
      "update",
      "create",
    ]);
    expect(log.find((e) => e.action === "rename")?.detail).toBe("Guide");
    expect(log.find((e) => e.action === "move")?.detail).toBe("Docs");
    expect(log.find((e) => e.action === "update")?.detail).toBe("2");
    expect(log[0]).toMatchObject({
      detail: "1 changes",
      author: { type: "agent", id: lia, actingFor: beto.user.id },
    });
    // Paging by `before`.
    const older = await ana.api.wiki.listWikiChanges(workspaceId, { before: log[3]?.at, limit: 2 });
    expect(older.map((e) => e.action)).toEqual(["move", "rename"]);
    // Restricting hides the page's lines from whoever doesn't read it.
    await ana.api.wiki.setWikiPageAccess(workspaceId, renamed.slug, restrictPrivate);
    expect(await beto.api.wiki.listWikiChanges(workspaceId)).toEqual([]);
    expect((await apiError(ana.api.wiki.listWikiChanges(workspaceId, { limit: 300 }))).status).toBe(400);
  });

  test("index.md: by folder, with a summary line", async () => {
    const { workspaceId, ana } = await team();
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Database",
      folder: "Architecture",
      body: "# Database\n\nPostgres with **Drizzle** and [[Queues|queues]].\n",
    });
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Welcome",
      body: "---\nowner: Ana\n---\nRead this first.",
    });
    const index = await ana.api.wiki.getWikiIndex(workspaceId);
    expect(index.markdown).toBe(
      "# Index\n\n## /\n\n- [[Welcome]] — Read this first.\n## Architecture\n\n- [[Database]] — Postgres with Drizzle and queues.\n",
    );
    expect(index.pages).toBe(2);
    expect(summaryLine("a".repeat(300))).toHaveLength(140);
  });
});

/** A provider that answers like the fake one, and records the calls. */
function countingFake(): { provider: ModelProvider; calls: () => number } {
  const inner = fakeProvider();
  let calls = 0;
  return {
    provider: {
      ...inner,
      stream(req) {
        calls++;
        return inner.stream(req);
      },
    },
    calls: () => calls,
  };
}

describe("the wiki check", () => {
  test("orphans, broken links and a contradiction checked by the model, once per version of the pair", async () => {
    const { workspaceId, ana, beto } = await team();
    const specs: [string, string][] = [
      ["Start", "See [[Deadline A]], [[Nothing]] and [[Old]]."],
      ["Deadline A", "The deadline is Friday. [[Deadline B]]"],
      ["Deadline B", "The deadline is Thursday. [[reply:Deadline A says Friday; Deadline B says Thursday]]"],
      ["Loose", "nobody links here"],
      ["Old", "goes to the trash"],
    ];
    for (const [title, body] of specs) await ana.api.wiki.createWikiPage(workspaceId, { title, body });
    await ana.api.wiki.pinWikiPage(workspaceId, "start", true);
    await ana.api.wiki.deleteWikiPage(workspaceId, "old");
    // "Run now" needs the model lookup of the runtime slice: until then 503, and nothing is written.
    const absent = await apiError(ana.api.wiki.createWikiCheck(workspaceId));
    expect([absent.status, absent.code]).toEqual([503, "not_available"]);
    expect((await ana.api.wiki.getWikiChecks(workspaceId)).ranAt).toBeNull();
    const fake = countingFake();
    const run = () =>
      checkWorkspace(server.deps, workspaceId, { gapMs: 0, model: async () => fake.provider });
    expect(await run()).toBe(true);
    const report = await ana.api.wiki.getWikiChecks(workspaceId);
    expect(report.testModel).toBe(true);
    const of = (kind: string) => report.findings.filter((f) => f.kind === kind);
    expect(of("orphan").map((f) => f.kind === "orphan" && f.page.title)).toEqual(["Loose"]);
    expect(
      of("broken_link")
        .map((f) => f.kind === "broken_link" && `${f.page.title}→${f.target}:${f.state}`)
        .sort(),
    ).toEqual([
      "Deadline B→reply:Deadline A says Friday; Deadline B says Thursday:missing",
      "Start→Nothing:missing",
      "Start→Old:trashed",
    ]);
    expect(of("contradiction")).toEqual([
      {
        kind: "contradiction",
        pages: [
          expect.objectContaining({ title: expect.any(String) }),
          expect.objectContaining({ title: expect.any(String) }),
        ],
        summary: "Deadline A says Friday; Deadline B says Thursday",
      },
    ]);
    expect(fake.calls()).toBe(1);
    // "Run now" twice within the minute: the second doesn't run.
    const once = () =>
      checkWorkspace(server.deps, workspaceId, { gapMs: CHECK_NOW_GAP_MS, model: async () => fake.provider });
    expect(await once()).toBe(false);
    // The cache: a text changed without a new version isn't asked again; a new version is.
    const b = await rowOf(workspaceId, "deadline-b");
    await db()
      .update(schema.knowledgePages)
      .set({ body: "The deadline is Thursday. [[reply:OTHER]]" })
      .where(eq(schema.knowledgePages.id, b.id));
    await run();
    expect(fake.calls()).toBe(1);
    const summary = async () =>
      (await ana.api.wiki.getWikiChecks(workspaceId)).findings.flatMap((f) =>
        f.kind === "contradiction" ? [f.summary] : [],
      );
    expect(await summary()).toEqual(["Deadline A says Friday; Deadline B says Thursday"]);
    await ana.api.wiki.replaceWikiPage(workspaceId, "deadline-b", {
      body: "The deadline is Friday. [[reply:NONE]]",
      parentVersion: 1,
    });
    await run();
    expect(fake.calls()).toBe(2);
    expect(await summary()).toEqual([]);
    // A finding of a restricted page is gone for whoever doesn't read it.
    await ana.api.wiki.setWikiPageAccess(workspaceId, "loose", restrictPrivate);
    const orphan = (r: Awaited<ReturnType<typeof ana.api.wiki.getWikiChecks>>) =>
      r.findings.some((f) => f.kind === "orphan" && f.page.title === "Loose");
    expect([
      orphan(await ana.api.wiki.getWikiChecks(workspaceId)),
      orphan(await beto.api.wiki.getWikiChecks(workspaceId)),
    ]).toEqual([true, false]);
  });

  test("two runs at once on the same workspace: one claims it, the model is asked once", async () => {
    const { workspaceId, ana } = await team();
    await ana.api.wiki.createWikiPage(workspaceId, { title: "One", body: "[[Two]] [[reply:NONE]]" });
    await ana.api.wiki.createWikiPage(workspaceId, { title: "Two", body: "y" });
    const fake = countingFake();
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        checkWorkspace(server.deps, workspaceId, {
          gapMs: CHECK_NOW_GAP_MS,
          model: async () => fake.provider,
        }),
      ),
    );
    expect(runs.filter(Boolean)).toHaveLength(1);
    expect(fake.calls()).toBe(1);
    // A day later the turn is free again.
    skew += 25 * 3600_000;
    try {
      expect(
        await checkWorkspace(server.deps, workspaceId, {
          gapMs: CHECK_NOW_GAP_MS,
          model: async () => fake.provider,
        }),
      ).toBe(true);
    } finally {
      skew = 0;
    }
  });

  test(
    "stopping the server waits for a running check: its write lands before the database closes",
    async () => {
      const own = await startTestServer();
      const ana = withApi(await signedIn(own, "Ana", email("ana")));
      const { workspaceId } = await seedWorkspace(own, ana, "Stop");
      await ana.api.wiki.createWikiPage(workspaceId, { title: "One", body: "[[Two]] [[reply:Two says no]]" });
      await ana.api.wiki.createWikiPage(workspaceId, { title: "Two", body: "y" });
      const inner = fakeProvider();
      let entered!: () => void;
      const asked = new Promise<void>((r) => {
        entered = r;
      });
      let open!: () => void;
      const gate = new Promise<void>((r) => {
        open = r;
      });
      const held: ModelProvider = {
        ...inner,
        async *stream(req) {
          entered();
          await gate;
          yield* inner.stream(req);
        },
      };
      const checking = checkWorkspace(own.deps, workspaceId, { gapMs: 0, model: async () => held });
      await asked;
      let stopped = false;
      const stopping = own.stop().then(() => {
        stopped = true;
      });
      // The stop waits for the check (the server's background work): the database is still open while the
      // check is held, and the check's write lands (a write after the close would reject the check).
      const [stillOpen] = await own.deps.db.select({ n: count() }).from(schema.knowledgePages);
      expect([stillOpen?.n, stopped]).toEqual([2, false]);
      open();
      expect(await checking).toBe(true);
      await stopping;
      expect(stopped).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test("parseCheck: NONE is no contradiction; at most 3 lines", () => {
    expect(parseCheck("NONE")).toBeNull();
    expect(parseCheck("  none.")).toBeNull();
    expect(parseCheck("a\nb\nc\nd")).toBe("a\nb\nc");
  });
});

describe("the local graph", () => {
  test("neighbors up to the depth asked; a restricted page stays out", async () => {
    const { workspaceId, ana, beto } = await team();
    await ana.api.wiki.createWikiPage(workspaceId, { title: "A", body: "[[B]]" });
    await ana.api.wiki.createWikiPage(workspaceId, { title: "B", body: "[[C]]" });
    await ana.api.wiki.createWikiPage(workspaceId, { title: "C", body: "[[D]]" });
    await ana.api.wiki.createWikiPage(workspaceId, { title: "D", body: "end" });
    await ana.api.wiki.createWikiPage(workspaceId, { title: "E", body: "alone" });
    const near = await ana.api.wiki.getWikiGraph(workspaceId, { pageId: "b", depth: 1 });
    expect(near.center).toBe("b");
    expect(near.nodes.map((x) => x.slug).sort()).toEqual(["a", "b", "c"]);
    expect(
      (await ana.api.wiki.getWikiGraph(workspaceId, { pageId: "b", depth: 2 })).nodes
        .map((x) => x.slug)
        .sort(),
    ).toEqual(["a", "b", "c", "d"]);
    expect((await ana.api.wiki.getWikiGraph(workspaceId)).center).toBeNull();
    await ana.api.wiki.setWikiPageAccess(workspaceId, "c", restrictPrivate);
    const hidden = await beto.api.wiki.getWikiGraph(workspaceId, { pageId: "b", depth: 3 });
    expect(hidden.nodes.map((x) => x.slug).sort()).toEqual(["a", "b"]);
    expect(hidden.edges).toEqual([{ from: "a", to: "b" }]);
    expect((await apiError(ana.api.wiki.getWikiGraph(workspaceId, { pageId: "b", depth: 4 }))).status).toBe(
      400,
    );
  });
});
