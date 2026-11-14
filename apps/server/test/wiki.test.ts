// Wiki (T6): links and rename (P0-05), panel (P0-06), properties (P0-07), diff, authorship, restore and
// trash (P0-09), the zip vault (P0-10) and the search through seam 5.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WikiPropDef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import type { Viewer } from "@vanr/engine/search";
import { VAULT_ATTACHMENTS, VAULT_NOTES } from "@vanr/engine/wiki/vault-fixture";
import { and, eq, sql } from "drizzle-orm";
import { strToU8, unzipSync, zipSync } from "fflate";
import * as Y from "yjs";
import type { RunningServer } from "../src/server";
import { MAX_BODY, pageLock, purgeWikiTrash, savePage } from "../src/wiki";
import { wikiMarkdown } from "../src/wiki-md";
import { VAULT_LIMITS } from "../src/wiki-vault";
import { Browser, holdNextIndexWrite, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { NO_POSTGRES, TEST_POSTGRES_URL, testDatabaseUrl } from "./postgres";
import { memberOf, type Person, seedWorkspace } from "./seed";
import { apiError, wikiApi } from "./wiki-api";

/** The real search index (T8, Postgres), with the permission in the WHERE. */
const search = { search: (viewer: Viewer, q: string) => server.deps.search.search(viewer, q) };
let skew = 0;
const DAY = 86_400_000;
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => new Date(Date.now() + skew) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@wiki.test`;
const withApi = (p: Person) => ({ ...p, api: { wiki: wikiApi(p.browser) } });

async function team() {
  const ana = withApi(await signedIn(server, "Ana", email("ana")));
  const { workspaceId } = await seedWorkspace(server, ana, "Handbook");
  const beto = withApi(await memberOf(server, workspaceId, "Beto", email("beto")));
  return { workspaceId, ana, beto };
}

function vaultZip(extra: Record<string, Uint8Array> = {}) {
  const files: Record<string, Uint8Array> = {};
  for (const f of VAULT_NOTES) files[`Handbook/${f.path}`] = strToU8(f.text);
  for (const a of VAULT_ATTACHMENTS)
    files[`Handbook/${a.path}`] = new Uint8Array(Buffer.from(a.base64, "base64"));
  files["Handbook/.obsidian/workspace.json"] = strToU8("{}");
  return zipSync({ ...files, ...extra });
}

describe("links and rename (P0-05)", () => {
  test("[[a|b]], [[a#heading]], [[a#^block]], embed; a target created later starts to count", async () => {
    const { workspaceId, ana } = await team();
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Values",
      body: "# Values\n\n## Clarity\n\nAsk for help early. ^ask-for-help\n",
    });
    const home = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Start",
      body: [
        "Read [[Values|our values]], the [[Values#Clarity]] and the block [[Values#^ask-for-help]].",
        "Wrong anchor: [[Values#Does not exist]]. Embed: ![[Values]].",
        "Doesn't exist yet: [[Roadmap]].",
        "In code it doesn't count: `[[Values]]`",
        "```\n[[Glossary]]\n```",
      ].join("\n\n"),
    });
    let panel = await ana.api.wiki.getWikiPagePanel(workspaceId, home.slug);
    expect(panel.outgoing.map((o) => [o.target, o.anchor, o.label, o.embed, o.state])).toEqual([
      ["Values", null, "our values", false, "ok"],
      ["Values", "Clarity", null, false, "ok"],
      ["Values", "^ask-for-help", null, false, "ok"],
      ["Values", "Does not exist", null, false, "broken_anchor"],
      ["Values", null, null, true, "ok"],
      ["Roadmap", null, null, false, "missing"],
    ]);
    await ana.api.wiki.createWikiPage(workspaceId, { title: "Roadmap", body: "Q4" });
    panel = await ana.api.wiki.getWikiPagePanel(workspaceId, home.slug);
    expect(panel.outgoing.at(-1)).toMatchObject({
      target: "Roadmap",
      state: "ok",
      page: { slug: "roadmap" },
    });
    const roadmap = await ana.api.wiki.getWikiPage(workspaceId, "roadmap");
    expect(roadmap.inboundLinks).toEqual([{ slug: home.slug, title: "Start" }]);
  });

  test("rename rewrites the links (label and anchor stay); a locked page becomes an alternate title", async () => {
    const { workspaceId, ana, beto } = await team();
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Database",
      folder: "Architecture",
      body: "# Database\n\n## Indexes\n",
    });
    const a = await beto.api.wiki.createWikiPage(workspaceId, {
      title: "Bruno",
      body: "Looks after the [[Database|database]], the [[Architecture/Database#Indexes]] and the ![[Database]].\n\n`[[Database]]` stays.",
    });
    const locked = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Minutes",
      body: "See [[Database]].",
    });
    await ana.api.wiki.lockWikiPage(workspaceId, locked.slug, true);
    const self = await ana.api.wiki.getWikiPage(workspaceId, "database");

    // Beto (member) renames: the locked page isn't his to rewrite.
    const renamed = await beto.api.wiki.renameWikiPage(workspaceId, self.slug, "Postgres");
    expect(renamed).toMatchObject({ slug: "database", title: "Postgres", altTitles: ["Database"] });
    expect(renamed.relinked).toEqual({
      rewritten: [{ slug: a.slug, title: "Bruno" }],
      skipped: [{ slug: locked.slug, title: "Minutes" }],
    });
    const bruno = await ana.api.wiki.getWikiPage(workspaceId, a.slug);
    expect(bruno.body).toBe(
      "Looks after the [[Postgres|database]], the [[Architecture/Postgres#Indexes]] and the ![[Postgres]].\n\n`[[Database]]` stays.",
    );
    expect(bruno.history[0]).toMatchObject({ author: { type: "person", id: beto.user.id } });
    // The locked page's link still reaches the page (through the alternate title).
    const panel = await ana.api.wiki.getWikiPagePanel(workspaceId, locked.slug);
    expect(panel.outgoing[0]).toMatchObject({ target: "Database", state: "ok", page: { title: "Postgres" } });
    const back = await ana.api.wiki.getWikiPagePanel(workspaceId, "database");
    expect(back.inboundLinks.map((b) => b.title).sort()).toEqual(["Bruno", "Minutes"]);
  });

  test("rename: a page that would pass the limit stays as it was and the old title becomes an alternate title", async () => {
    const { workspaceId, ana } = await team();
    const target = await ana.api.wiki.createWikiPage(workspaceId, { title: "Sun", body: "x" });
    const links = "[[Sun]] ".repeat(1000);
    const big = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Full",
      body: `${links}${"a".repeat(500_000 - links.length)}`,
    });
    const renamed = await ana.api.wiki.renameWikiPage(workspaceId, target.slug, "Sunrise over the hills");
    expect(renamed.relinked).toEqual({ rewritten: [], skipped: [{ slug: big.slug, title: "Full" }] });
    expect(renamed.altTitles).toEqual(["Sun"]);
    expect((await ana.api.wiki.getWikiPage(workspaceId, big.slug)).version).toBe(big.version);
    const panel = await ana.api.wiki.getWikiPagePanel(workspaceId, big.slug);
    expect(panel.outgoing[0]).toMatchObject({
      target: "Sun",
      state: "ok",
      page: { title: "Sunrise over the hills" },
    });
  });
});

describe("rename with repeated names (P0-05)", () => {
  test("only rewrites the link that led to the page; a title already in use becomes folder/title or slug", async () => {
    const { workspaceId, ana } = await team();
    const root = await ana.api.wiki.createWikiPage(workspaceId, { title: "Foo", body: "root" });
    const inFolder = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Foo",
      folder: "b",
      body: "folder b",
    });
    const source = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Source",
      body: "[[Foo]] and [[b/Foo]]\n",
    });
    const to = async (slug: string) =>
      (await ana.api.wiki.getWikiPagePanel(workspaceId, slug)).outgoing.map(
        (o) => `${o.target}->${o.page?.slug}`,
      );
    expect(await to(source.slug)).toEqual([`Foo->${root.slug}`, `b/Foo->${inFolder.slug}`]);
    await ana.api.wiki.renameWikiPage(workspaceId, inFolder.slug, "Bar");
    expect((await ana.api.wiki.getWikiPage(workspaceId, source.slug)).body).toBe("[[Foo]] and [[b/Bar]]\n");
    expect(await to(source.slug)).toEqual([`Foo->${root.slug}`, `b/Bar->${inFolder.slug}`]);

    // "Baz" is already another page's slug: the link goes through the folder.
    const baz = await ana.api.wiki.createWikiPage(workspaceId, { title: "Baz", body: "the other one" });
    const x = await ana.api.wiki.createWikiPage(workspaceId, { title: "Qux", folder: "x", body: "x" });
    const fx = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Fx",
      body: "[[Qux]] [[Qux|nickname]]\n",
    });
    await ana.api.wiki.renameWikiPage(workspaceId, x.slug, "Baz");
    expect((await ana.api.wiki.getWikiPage(workspaceId, fx.slug)).body).toBe(
      "[[x/Baz]] [[x/Baz|nickname]]\n",
    );
    expect(await to(fx.slug)).toEqual([`x/Baz->${x.slug}`, `x/Baz->${x.slug}`]);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, baz.slug)).inboundLinks).toEqual([]);

    // Title and folder/title already lead to another page: the link goes by the slug, with the title as label.
    const other = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Zed",
      folder: "y",
      body: "other",
    });
    // (on a folder tie the smaller slug wins: "zed" before "zz")
    const y = await ana.api.wiki.createWikiPage(workspaceId, { title: "Zz", folder: "y", body: "y" });
    const fy = await ana.api.wiki.createWikiPage(workspaceId, { title: "Fy", body: "[[Zz]]\n" });
    await ana.api.wiki.renameWikiPage(workspaceId, y.slug, "Zed");
    expect((await ana.api.wiki.getWikiPage(workspaceId, fy.slug)).body).toBe(`[[${y.slug}|Zed]]\n`);
    expect(await to(fy.slug)).toEqual([`${y.slug}->${y.slug}`]);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, other.slug)).inboundLinks).toEqual([]);
  });

  test("trash and a new page with the same name: the link goes to the one outside the trash", async () => {
    const { workspaceId, ana } = await team();
    const old = await ana.api.wiki.createWikiPage(workspaceId, { title: "Target", body: "old" });
    const source = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Source",
      body: "see [[Target]]\n",
    });
    await ana.api.wiki.deleteWikiPage(workspaceId, old.slug);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, source.slug)).outgoing[0]?.state).toBe(
      "trashed",
    );
    const fresh = await ana.api.wiki.createWikiPage(workspaceId, { title: "Target", body: "new" });
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, source.slug)).outgoing[0]).toMatchObject({
      state: "ok",
      page: { slug: fresh.slug },
    });
    expect(
      (await ana.api.wiki.getWikiPagePanel(workspaceId, fresh.slug)).inboundLinks.map((b) => b.slug),
    ).toEqual([source.slug]);
    await ana.api.wiki.renameWikiPage(workspaceId, fresh.slug, "New target");
    expect((await ana.api.wiki.getWikiPage(workspaceId, source.slug)).body).toBe("see [[New target]]\n");

    // Two with the same title: the root one wins; once it goes to the trash, the link moves to the folder's.
    const root = await ana.api.wiki.createWikiPage(workspaceId, { title: "Meeting", body: "root" });
    const folder = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Meeting",
      folder: "minutes",
      body: "folder",
    });
    const f2 = await ana.api.wiki.createWikiPage(workspaceId, { title: "F2", body: "[[Meeting]]\n" });
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, f2.slug)).outgoing[0]?.page?.slug).toBe(
      root.slug,
    );
    await ana.api.wiki.deleteWikiPage(workspaceId, root.slug);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, f2.slug)).outgoing[0]).toMatchObject({
      state: "ok",
      page: { slug: folder.slug },
    });
    await ana.api.wiki.restoreWikiTrash(workspaceId, root.slug);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, f2.slug)).outgoing[0]?.page?.slug).toBe(
      root.slug,
    );
  });
});

describe("names only the slug finds and titles that break a link (P0-05)", () => {
  test("a created page gets the link that only finds it by the text's slug; a title with / is still found", async () => {
    const { workspaceId, ana } = await team();
    const source = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Source",
      body: "[[Foo_Bar]] and [[Plan]]\n",
    });
    const fresh = await ana.api.wiki.createWikiPage(workspaceId, { title: "Foo Bar", body: "x" });
    expect(fresh.slug).toBe("foo-bar");
    const out = async () =>
      (await ana.api.wiki.getWikiPagePanel(workspaceId, source.slug)).outgoing.map(
        (o) => `${o.target}->${o.page?.slug}`,
      );
    expect(await out()).toEqual(["Foo_Bar->foo-bar", "Plan->undefined"]);

    const plan = await ana.api.wiki.createWikiPage(workspaceId, { title: "Plan", body: "y" });
    await ana.api.wiki.renameWikiPage(workspaceId, plan.slug, "Q3/Plan");
    expect((await ana.api.wiki.getWikiPage(workspaceId, source.slug)).body).toBe(
      "[[Foo_Bar]] and [[Q3/Plan]]\n",
    );
    expect(await out()).toEqual(["Foo_Bar->foo-bar", `Q3/Plan->${plan.slug}`]);
  });

  test("attack: a title with [ ] | # ^ is rejected on create and rename (the vault strips those characters)", async () => {
    const { workspaceId, ana } = await team();
    for (const title of ["C# Guide", "A|B", "x]]y", "[[z", "note ^1"]) {
      const err = await apiError(ana.api.wiki.createWikiPage(workspaceId, { title, body: "x" }));
      expect([err.status, err.code]).toEqual([400, "wiki.title_chars"]);
    }
    const p = await ana.api.wiki.createWikiPage(workspaceId, { title: "Guide", body: "x" });
    const err = await apiError(ana.api.wiki.renameWikiPage(workspaceId, p.slug, "C# Guide"));
    expect([err.status, err.code]).toEqual([400, "wiki.title_chars"]);
    expect((await ana.api.wiki.getWikiPage(workspaceId, p.slug)).title).toBe("Guide");
    const zip = zipSync({ "C# Guide.md": strToU8("text") });
    const r = await ana.api.wiki.importWikiVault(workspaceId, { file: new Blob([zip]), fileName: "c.zip" });
    expect(r).toMatchObject({ created: 1, failed: [] });
    expect((await ana.api.wiki.listWikiPages(workspaceId)).map((x) => x.title).sort()).toEqual([
      "C Guide",
      "Guide",
    ]);
  });
});

describe("panel (P0-06)", () => {
  test("inbound links with count and snippet, mentions without a link, outline", async () => {
    const { workspaceId, ana } = await team();
    const wiki = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Wiki Project",
      altTitles: ["New wiki"],
      body: "# Wiki Project\n\n## Goal\n\nText.\n\n## Deadline\nSetext\n---\n",
    });
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Plan",
      body: "First [[Wiki Project]].\n\nThen [[New wiki|it]] again.",
    });
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Minutes",
      body: "We talked about the wiki project yesterday.",
    });
    await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Other",
      body: "Wiki Projection is not a mention.",
    });
    const panel = await ana.api.wiki.getWikiPagePanel(workspaceId, wiki.slug);
    expect(panel.inboundLinks).toEqual([
      { slug: "plan", title: "Plan", count: 2, snippet: "First [[Wiki Project]]." },
    ]);
    expect(panel.mentions).toEqual([
      { slug: "minutes", title: "Minutes", snippet: "We talked about the wiki project yesterday." },
    ]);
    expect(panel.outline.map((h) => [h.level, h.text])).toEqual([
      [1, "Wiki Project"],
      [2, "Goal"],
      [2, "Deadline"],
      [2, "Setext"],
    ]);
  });
});

describe("properties (P0-07)", () => {
  test("workspace definitions with a version; a validated partial write; 409 on a stale parent", async () => {
    const { workspaceId, ana, beto } = await team();
    const defs: WikiPropDef[] = [
      {
        id: "prop_status",
        name: "Status",
        type: "status",
        options: [
          { id: "opt_a", name: "Draft" },
          { id: "opt_b", name: "Published" },
        ],
      },
      { id: "prop_due", name: "Due", type: "date" },
      { id: "prop_created", name: "Created at", type: "created_time" },
    ];
    const saved = await ana.api.wiki.setWikiProps(workspaceId, defs, 0);
    expect(saved.version).toBe(1);
    expect((await apiError(beto.api.wiki.setWikiProps(workspaceId, [], 0))).status).toBe(409);
    expect(await beto.api.wiki.listWikiProps(workspaceId)).toEqual({ defs, version: 1 });
    const dup = await apiError(
      ana.api.wiki.setWikiProps(workspaceId, [...defs, { ...defs[1], id: "prop_x" } as WikiPropDef], 1),
    );
    expect(dup.code).toBe("wiki.props.duplicate");

    const page = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Doc",
      body: "x",
      props: { prop_status: "opt_a" },
    });
    expect(page.props).toEqual({ prop_status: "opt_a" });
    const v2 = await beto.api.wiki.updateWikiPageMeta(workspaceId, page.slug, {
      parentVersion: 1,
      props: { prop_status: "opt_b", prop_due: { start: "2026-11-01" } },
      altTitles: ["Document"],
      tags: ["#Guide"],
    });
    expect(v2).toMatchObject({
      version: 2,
      props: { prop_status: "opt_b", prop_due: { start: "2026-11-01" } },
      altTitles: ["Document"],
      tags: ["guide"],
    });
    expect(
      (
        await apiError(
          ana.api.wiki.updateWikiPageMeta(workspaceId, page.slug, { parentVersion: 1, props: {} }),
        )
      ).status,
    ).toBe(409);
    const bad = await apiError(
      ana.api.wiki.updateWikiPageMeta(workspaceId, page.slug, {
        parentVersion: 2,
        props: { prop_status: "opt_zzz", prop_created: "2026-01-01", prop_nothing: 1 },
      }),
    );
    expect(bad).toMatchObject({ status: 400, code: "wiki.invalid_props" });
    expect((bad.params as { errors: { code: string }[] }).errors.map((e) => e.code).sort()).toEqual([
      "read_only",
      "unknown_option",
      "unknown_prop",
    ]);
    const v3 = await ana.api.wiki.updateWikiPageMeta(workspaceId, page.slug, {
      parentVersion: 2,
      props: { prop_due: null },
    });
    expect(v3.props).toEqual({ prop_status: "opt_b" });
    // The alternate title resolves a link.
    const linker = await ana.api.wiki.createWikiPage(workspaceId, { title: "L", body: "[[Document]]" });
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, linker.slug)).outgoing[0]?.state).toBe("ok");
  });
});

describe("diff, authorship, restore and trash (P0-09)", () => {
  test("diff by line and word, with properties; an agent's authorship; restoring creates a new version", async () => {
    const { workspaceId, ana } = await team();
    await ana.api.wiki.setWikiProps(workspaceId, [{ id: "prop_n", name: "Score", type: "number" }], 0);
    const body = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join("\n");
    const p = await ana.api.wiki.createWikiPage(workspaceId, { title: "Diff", body, props: { prop_n: 1 } });
    const row = await server.deps.db.query.knowledgePages.findFirst({
      where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.slug, p.slug)),
    });
    if (!row) throw new Error("page");
    await savePage(server.deps, {
      row,
      author: { type: "agent", id: "agt_x", actingFor: ana.user.id },
      canBypassLock: false,
      parentVersion: 1,
      body: body.replace("Line 10", "Line ten").concat("\nNew line"),
      props: { prop_n: 2 },
    });
    const d = await ana.api.wiki.getWikiPageDiff(workspaceId, p.slug);
    expect(d.from.version).toBe(1);
    expect(d.to).toMatchObject({
      version: 2,
      author: { type: "agent", id: "agt_x", actingFor: ana.user.id },
    });
    // Without a line break at the end, the last line also counts as changed.
    expect(d.stats).toEqual({ added: 3, removed: 2 });
    expect(d.props).toEqual([{ propId: "prop_n", name: "Score", before: "1", after: "2" }]);
    const changed = d.lines.filter((l) => l.kind !== "same" && l.kind !== "gap");
    expect(changed).toEqual([
      {
        kind: "del",
        text: "Line 10",
        parts: [
          { kind: "same", text: "Line " },
          { kind: "del", text: "10" },
        ],
      },
      {
        kind: "add",
        text: "Line ten",
        parts: [
          { kind: "same", text: "Line " },
          { kind: "add", text: "ten" },
        ],
      },
      { kind: "del", text: "Line 20" },
      { kind: "add", text: "Line 20" },
      { kind: "add", text: "New line" },
    ]);
    expect(d.lines[0]).toEqual({ kind: "gap", count: 6 });

    const restored = await ana.api.wiki.restoreWikiPageVersion(workspaceId, p.slug, 1, 2);
    expect(restored).toMatchObject({ version: 3, body, props: { prop_n: 1 } });
    expect(restored.history[0]).toMatchObject({ version: 3, note: "restore:v1", author: { type: "person" } });
    expect((await apiError(ana.api.wiki.restoreWikiPageVersion(workspaceId, p.slug, 1, 2))).status).toBe(409);
  });

  test("trash: gone from the tree, the search and the inbound links; comes back; only the creator or an admin; deleted for good in 30 days", async () => {
    const { workspaceId, ana, beto } = await team();
    const target = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "Kitchen secret",
      body: "recipe xyzzy",
    });
    const source = await beto.api.wiki.createWikiPage(workspaceId, {
      title: "Source",
      body: "[[Kitchen secret]]",
    });
    const viewer = { workspaceId, userId: ana.user.id };
    expect((await search.search(viewer, "xyzzy")).map((h) => h.title)).toEqual(["Kitchen secret"]);

    // Beto didn't create it: he doesn't delete it (attack: deleting someone else's page).
    expect((await apiError(beto.api.wiki.deleteWikiPage(workspaceId, target.slug))).status).toBe(403);
    await ana.api.wiki.deleteWikiPage(workspaceId, target.slug);
    expect((await apiError(ana.api.wiki.getWikiPage(workspaceId, target.slug))).status).toBe(404);
    expect((await ana.api.wiki.listWikiPages(workspaceId)).map((p) => p.slug)).toEqual([source.slug]);
    expect(await ana.api.wiki.getWikiSearch(workspaceId, "xyzzy")).toEqual([]);
    expect(await search.search(viewer, "xyzzy")).toEqual([]);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, source.slug)).outgoing[0]?.state).toBe(
      "trashed",
    );
    // Writing to the page in the trash doesn't pass.
    expect(
      (
        await apiError(
          ana.api.wiki.replaceWikiPage(workspaceId, target.slug, { body: "x", parentVersion: 1 }),
        )
      ).status,
    ).toBe(404);

    const trash = await beto.api.wiki.getWikiTrash(workspaceId);
    expect(trash).toEqual([
      expect.objectContaining({
        slug: target.slug,
        deletedBy: { type: "person", id: ana.user.id },
        canPurge: false,
      }),
    ]);
    expect((await apiError(beto.api.wiki.restoreWikiTrash(workspaceId, target.slug))).status).toBe(403);
    expect((await apiError(beto.api.wiki.deleteWikiTrash(workspaceId, target.slug))).status).toBe(403);
    const back = await ana.api.wiki.restoreWikiTrash(workspaceId, target.slug);
    expect(back).toMatchObject({ slug: target.slug, inboundLinks: [{ slug: source.slug, title: "Source" }] });
    expect((await search.search(viewer, "xyzzy")).length).toBe(1);

    await ana.api.wiki.deleteWikiPage(workspaceId, target.slug);
    expect(await purgeWikiTrash(server.deps)).toBe(0);
    skew = 31 * DAY;
    try {
      expect(await purgeWikiTrash(server.deps)).toBeGreaterThanOrEqual(1);
    } finally {
      skew = 0;
    }
    expect(await ana.api.wiki.getWikiTrash(workspaceId)).toEqual([]);
    expect((await ana.api.wiki.getWikiPagePanel(workspaceId, source.slug)).outgoing[0]?.state).toBe(
      "missing",
    );

    const other = await ana.api.wiki.createWikiPage(workspaceId, { title: "Other", body: "abc" });
    await ana.api.wiki.deleteWikiPage(workspaceId, other.slug);
    await ana.api.wiki.deleteWikiTrash(workspaceId, other.slug);
    expect(await ana.api.wiki.getWikiTrash(workspaceId)).toEqual([]);
  });

  test("search: a slow save that ends after the trash doesn't bring the page back to the search", async () => {
    const { workspaceId, ana } = await team();
    const p = await ana.api.wiki.createWikiPage(workspaceId, { title: "Old draft", body: "plugh" });
    const hold = holdNextIndexWrite(server);
    const save = ana.api.wiki.replaceWikiPage(workspaceId, p.slug, { body: "plugh again", parentVersion: 1 });
    await hold.begun;
    // The held index write keeps its transaction open: on PGlite (one transaction at a time) the trash waits
    // for it at the database, so it is released at once; whichever order the two land in, the end state is
    // the same. On Postgres the order is the page row's share lock in reindex.
    const trash = ana.api.wiki.deleteWikiPage(workspaceId, p.slug);
    hold.release();
    await Promise.all([save, trash]);
    expect(await search.search({ workspaceId, userId: ana.user.id }, "plugh")).toEqual([]);
  });

  test("search (seam 5): saving replaces the chunks; workspace scope; another workspace doesn't see it", async () => {
    const { workspaceId, ana } = await team();
    const other = await team();
    const p = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "On call",
      body: "# On call\n\nfortnightly rota",
    });
    await ana.api.wiki.replaceWikiPage(workspaceId, p.slug, {
      body: "# On call\n\nweekly rota",
      parentVersion: 1,
    });
    const hits = await search.search({ workspaceId, userId: ana.user.id }, "rota");
    expect(hits).toEqual([
      expect.objectContaining({
        source: { kind: "wiki", id: expect.any(String) },
        title: "On call",
        url: `/workspace/${workspaceId}/wiki/${p.slug}`,
      }),
    ]);
    expect(hits[0]?.snippet).toContain("weekly");
    expect(await search.search({ workspaceId, userId: ana.user.id }, "fortnightly")).toEqual([]);
    expect(
      await search.search({ workspaceId: other.workspaceId, userId: other.ana.user.id }, "rota"),
    ).toEqual([]);
  });
});

describe("zip vault (P0-10)", () => {
  test("imports notes, folders, attachments, alternate titles, #tags and front matter as properties; exports and reimports the same", async () => {
    const { workspaceId, ana } = await team();
    const zip = vaultZip();
    const result = await ana.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([zip]),
      fileName: "handbook.zip",
    });
    expect(result).toMatchObject({ created: VAULT_NOTES.length, skipped: 0, attachments: 2, failed: [] });
    expect(result.propsCreated).toEqual(
      expect.arrayContaining(["status", "author", "reviewed", "duration_days", "remote", "attendees"]),
    );
    const tree = await ana.api.wiki.listWikiPages(workspaceId);
    const start = tree.find((p) => p.title === "Start");
    expect(start).toMatchObject({ folder: "", altTitles: ["Home", "Front page"] });
    expect(start?.tags.sort()).toEqual(["handbook", "index", "team/product"]);
    const onboarding = tree.find((p) => p.title === "Onboarding");
    expect(onboarding?.folder).toBe("Processes");
    const { defs } = await ana.api.wiki.listWikiProps(workspaceId);
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.duration_days?.type).toBe("number");
    expect(byName.remote?.type).toBe("checkbox");
    expect(byName.reviewed?.type).toBe("date");
    expect(byName.attendees?.type).toBe("multi_select");
    expect(onboarding?.props).toEqual({
      [byName.duration_days?.id ?? ""]: 10,
      [byName.remote?.id ?? ""]: true,
    });
    // The links between the notes resolve (folder/title, alternate title and block).
    const panel = await ana.api.wiki.getWikiPagePanel(workspaceId, start?.slug ?? "");
    expect(panel.outgoing.map((o) => o.state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const wikiPanel = await ana.api.wiki.getWikiPagePanel(
      workspaceId,
      tree.find((p) => p.title === "Wiki")?.slug ?? "",
    );
    expect(wikiPanel.outgoing.map((o) => [o.target, o.state])).toEqual([
      ["links", "missing"],
      ["Page that does not exist", "missing"],
      ["Values", "ok"],
    ]);
    const attachments = await ana.api.wiki.listWikiAttachments(workspaceId);
    expect(attachments.map((a) => [a.path, a.contentType])).toEqual([
      ["attachments/contract.pdf", "application/pdf"],
      ["attachments/diagram.png", "image/png"],
    ]);
    // Importing again skips what already exists, notes and attachments: the Drive gets no repeated file.
    const files = (await ana.api.wiki.listFiles(workspaceId)).length;
    const again = await ana.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([zip]),
      fileName: "handbook.zip",
    });
    expect(again).toMatchObject({
      created: 0,
      attachments: 0,
      skipped: VAULT_NOTES.length + VAULT_ATTACHMENTS.length,
    });
    expect((await ana.api.wiki.listFiles(workspaceId)).length).toBe(files);

    const exported = unzipSync(
      new Uint8Array(await (await ana.api.wiki.exportWiki(workspaceId)).arrayBuffer()),
    );
    expect(Object.keys(exported).filter((k) => k.endsWith(".md")).length).toBe(VAULT_NOTES.length);
    expect(Object.keys(exported)).toContain("attachments/diagram.png");
    const startMd = new TextDecoder().decode(exported["Start.md"]);
    expect(startMd.startsWith("---\naliases:\n  - Home\n  - Front page\ntags:\n")).toBe(true);
    expect(startMd).toContain("status: active\n---\n# Welcome to the team handbook");

    // Reimporting the export in another workspace gives the same pages, bodies and properties.
    const other = await team();
    const re = await other.ana.api.wiki.importWikiVault(other.workspaceId, {
      file: new Blob([zipSync(exported)]),
      fileName: "export.zip",
    });
    expect(re).toMatchObject({ created: VAULT_NOTES.length, attachments: 2, failed: [] });
    const a = await ana.api.wiki.listWikiPages(workspaceId);
    const b = await other.ana.api.wiki.listWikiPages(other.workspaceId);
    const shape = (xs: typeof a) =>
      xs
        .map((p) => ({ title: p.title, folder: p.folder, tags: [...p.tags].sort(), altTitles: p.altTitles }))
        .sort((x, y) => `${x.folder}/${x.title}`.localeCompare(`${y.folder}/${y.title}`));
    expect(shape(b)).toEqual(shape(a));
    for (const p of a) {
      const q = b.find((x) => x.title === p.title && x.folder === p.folder);
      expect((await other.ana.api.wiki.getWikiPage(other.workspaceId, q?.slug ?? "")).body).toBe(
        (await ana.api.wiki.getWikiPage(workspaceId, p.slug)).body,
      );
    }
  });

  test("attachments that only differ in the path's case become a single file in the Drive", async () => {
    const { workspaceId, ana } = await team();
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const zip = zipSync({ "Note.md": strToU8("![[photo.png]]"), "photo.png": png, "PHOTO.png": png });
    const r = await ana.api.wiki.importWikiVault(workspaceId, { file: new Blob([zip]), fileName: "f.zip" });
    expect(r).toMatchObject({ created: 1, attachments: 1, skipped: 1 });
    expect((await ana.api.wiki.listFiles(workspaceId)).length).toBe(1);
  });

  test("a page that starts with a divider goes out and comes back the same (its --- doesn't become front matter)", async () => {
    const { workspaceId, ana } = await team();
    const body = "---\n\nText between dividers.\n\n---\n\nEnd.\n";
    await ana.api.wiki.createWikiPage(workspaceId, { title: "Divider", body });
    const exported = unzipSync(
      new Uint8Array(await (await ana.api.wiki.exportWiki(workspaceId)).arrayBuffer()),
    );
    const other = await team();
    await other.ana.api.wiki.importWikiVault(other.workspaceId, {
      file: new Blob([zipSync(exported)]),
      fileName: "e.zip",
    });
    expect((await other.ana.api.wiki.getWikiPage(other.workspaceId, "divider")).body).toBe(body);
  });

  test("attack: zip slip (.., absolute, drive letter) is rejected and creates no folder", async () => {
    const { workspaceId, ana } = await team();
    const zip = zipSync({
      "../../outside.md": strToU8("# outside"),
      "/abs.md": strToU8("# abs"),
      "C:\\win.md": strToU8("# win"),
      "ok/../../up.md": strToU8("# up"),
      "inside.md": strToU8("# inside"),
    });
    const r = await ana.api.wiki.importWikiVault(workspaceId, { file: new Blob([zip]), fileName: "x.zip" });
    expect(r.created).toBe(1);
    expect(r.failed.map((f) => f.error)).toEqual(Array(4).fill("wiki.import.unsafe_path"));
    expect((await ana.api.wiki.listWikiPages(workspaceId)).map((p) => [p.folder, p.title])).toEqual([
      ["", "inside"],
    ]);
  });

  test(
    "attack: a zip bomb, even with a forged header size, stops at the limit",
    async () => {
      const { workspaceId, ana } = await team();
      const zeros = new Uint8Array(60 * 1024 * 1024);
      const bomb = zipSync({ "bomb.md": zeros, "ok.md": strToU8("# ok") }, { level: 9 });
      expect(bomb.byteLength).toBeLessThan(1024 * 1024);
      let t0 = performance.now();
      let r = await ana.api.wiki.importWikiVault(workspaceId, { file: new Blob([bomb]), fileName: "b.zip" });
      expect(r).toMatchObject({ created: 1, failed: [{ path: "bomb.md", error: "wiki.import.too_large" }] });
      expect(performance.now() - t0).toBeLessThan(10_000);

      // A lying header: original size 10 in the local record and in the central directory.
      const lying = zipSync({ "lie.md": zeros }, { level: 9 });
      const view = new DataView(lying.buffer, lying.byteOffset, lying.byteLength);
      for (let i = 0; i < lying.byteLength - 4; i++) {
        const sig = view.getUint32(i, true);
        if (sig === 0x04034b50) view.setUint32(i + 22, 10, true);
        if (sig === 0x02014b50) view.setUint32(i + 24, 10, true);
      }
      t0 = performance.now();
      r = await ana.api.wiki.importWikiVault(workspaceId, { file: new Blob([lying]), fileName: "m.zip" });
      expect(r.created).toBe(0);
      expect(r.failed).toEqual([{ path: "lie.md", error: expect.stringMatching(/too_large|invalid_zip/) }]);
      expect(performance.now() - t0).toBeLessThan(10_000);
    },
    SERVER_TEST_MS,
  );

  test("attack: too many files, an invalid zip, hostile YAML", async () => {
    const { workspaceId, ana } = await team();
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2001; i++) many[`n${i}.md`] = new Uint8Array();
    const tooMany = await apiError(
      ana.api.wiki.importWikiVault(workspaceId, { file: new Blob([zipSync(many)]), fileName: "m.zip" }),
    );
    expect(tooMany).toMatchObject({ status: 413, code: "wiki.import.too_many_files" });
    expect(await ana.api.wiki.listWikiPages(workspaceId)).toEqual([]);
    const invalid = await apiError(
      ana.api.wiki.importWikiVault(workspaceId, {
        file: new Blob([strToU8("PK\u0003\u0004 junk")]),
        fileName: "x.zip",
      }),
    );
    expect(invalid).toMatchObject({ status: 400, code: "wiki.import.invalid_zip" });

    const hostile = zipSync({
      "proto.md": strToU8("---\n__proto__:\n  admin: true\nconstructor: x\nname: ok\n---\nbody"),
      "yaml-bomb.md": strToU8(
        `---\na: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n---\nbody`,
      ),
    });
    const r = await ana.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([hostile]),
      fileName: "h.zip",
    });
    expect(r.created).toBe(2);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    const { defs } = await ana.api.wiki.listWikiProps(workspaceId);
    expect(defs.map((d) => d.name)).toEqual(["name"]);
    expect((await ana.api.wiki.getWikiPage(workspaceId, "yaml-bomb")).body).toBe("body");
  });

  test("loose notes (.md) through the old route use the same importer", async () => {
    const { workspaceId, ana } = await team();
    const r = await ana.api.wiki.importWiki(workspaceId, {
      files: [
        { path: "Notes/A.md", text: "---\naliases: [Alpha]\ntags: x, y\n---\nText #extra" },
        { path: "img.png", text: "" },
      ],
    });
    expect(r).toEqual({ created: 1, skipped: 1, failed: [] });
    const [a] = await ana.api.wiki.listWikiPages(workspaceId);
    expect(a).toMatchObject({ title: "A", folder: "Notes", altTitles: ["Alpha"] });
    expect(a?.tags.sort()).toEqual(["extra", "x", "y"]);
  });
});

describe("graph and permissions", () => {
  test("the graph comes from the links table and ignores the trash", async () => {
    const { workspaceId, ana } = await team();
    await ana.api.wiki.createWikiPage(workspaceId, { title: "A", body: "[[B]] [[B]] [[C]] [[A]]" });
    await ana.api.wiki.createWikiPage(workspaceId, { title: "B", body: "[[A]]" });
    const c = await ana.api.wiki.createWikiPage(workspaceId, { title: "C", body: "" });
    await ana.api.wiki.deleteWikiPage(workspaceId, c.slug);
    const g = await ana.api.wiki.getWikiGraph(workspaceId);
    expect(g.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["a>b", "b>a"]);
  });

  test("another workspace neither reads nor writes (attack: another workspace's slug)", async () => {
    const one = await team();
    const two = await team();
    const p = await one.ana.api.wiki.createWikiPage(one.workspaceId, { title: "Internal", body: "x" });
    expect((await apiError(two.ana.api.wiki.getWikiPage(one.workspaceId, p.slug))).status).toBe(404);
    expect((await apiError(two.ana.api.wiki.getWikiPagePanel(two.workspaceId, p.slug))).status).toBe(404);
    expect((await apiError(two.ana.api.wiki.exportWiki(one.workspaceId))).status).toBe(404);
  });
});

describe("guards without a test in the origin", () => {
  test("MAX_BODY on every way in: create, save, the loose notes import and a vault note", async () => {
    const { workspaceId, ana } = await team();
    const over = "x".repeat(MAX_BODY + 1);
    const create = await apiError(ana.api.wiki.createWikiPage(workspaceId, { title: "Over", body: over }));
    expect([create.status, create.code]).toEqual([400, "invalid_request"]);
    const atLimit = await ana.api.wiki.createWikiPage(workspaceId, {
      title: "At limit",
      body: "x".repeat(MAX_BODY),
    });
    expect(atLimit.body.length).toBe(MAX_BODY);
    const save = await apiError(
      ana.api.wiki.replaceWikiPage(workspaceId, atLimit.slug, { body: over, parentVersion: 1 }),
    );
    expect([save.status, save.code]).toEqual([400, "invalid_request"]);
    const loose = await apiError(
      ana.api.wiki.importWiki(workspaceId, {
        files: [{ path: "big.md", text: "y".repeat(MAX_BODY + 10_001) }],
      }),
    );
    expect(loose.status).toBe(400);
    const note = await ana.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([zipSync({ "Huge.md": strToU8(over) })]),
      fileName: "huge.zip",
    });
    expect(note).toMatchObject({ created: 0, failed: [{ path: "Huge.md", error: "wiki.import.too_large" }] });
    expect((await ana.api.wiki.listWikiPages(workspaceId)).map((p) => p.title)).toEqual(["At limit"]);
  });

  test("without a session 401; a non-member gets 404 on every wiki route; only an admin locks", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Guarded", body: "x" });
    await ana.api.wiki.deleteWikiPage(
      workspaceId,
      (await ana.api.wiki.createWikiPage(workspaceId, { title: "Gone" })).slug,
    );
    const routes: [string, string][] = [
      ["GET", "/wiki/pages"],
      ["GET", "/wiki/search?q=x"],
      ["POST", "/wiki/pages"],
      ["GET", `/wiki/pages/${page.slug}`],
      ["PUT", `/wiki/pages/${page.slug}`],
      ["PATCH", `/wiki/pages/${page.slug}/meta`],
      ["POST", `/wiki/pages/${page.slug}/rename`],
      ["POST", `/wiki/pages/${page.slug}/move`],
      ["POST", `/wiki/pages/${page.slug}/lock`],
      ["POST", `/wiki/pages/${page.slug}/pin`],
      ["DELETE", `/wiki/pages/${page.slug}`],
      ["GET", "/wiki/trash"],
      ["POST", "/wiki/trash/gone/restore"],
      ["DELETE", "/wiki/trash/gone"],
      ["GET", `/wiki/pages/${page.slug}/history`],
      ["GET", `/wiki/pages/${page.slug}/versions/1`],
      ["GET", `/wiki/pages/${page.slug}/diff`],
      ["POST", `/wiki/pages/${page.slug}/versions/1/restore`],
      ["GET", `/wiki/pages/${page.slug}/panel`],
      ["POST", `/wiki/pages/${page.slug}/draft/publish`],
      ["DELETE", `/wiki/pages/${page.slug}/draft`],
      ["GET", "/wiki/props"],
      ["PUT", "/wiki/props"],
      ["GET", "/wiki/graph"],
      ["GET", "/wiki/reads"],
      ["POST", "/wiki/import"],
      ["GET", "/wiki/export"],
      ["GET", "/wiki/attachments"],
    ];
    const anon = new Browser(server.url);
    const eve = await signedIn(server, "Eve", email("eve"));
    for (const [method, path] of routes) {
      const url = `/api/v1/workspaces/${workspaceId}${path}`;
      expect([method, path, (await anon.json(url, method)).status]).toEqual([method, path, 401]);
      expect([method, path, (await eve.browser.json(url, method)).status]).toEqual([method, path, 404]);
    }
    const vault = new FormData();
    vault.set("file", new globalThis.File([zipSync({ "a.md": strToU8("a") })], "v.zip"));
    expect(
      (
        await eve.browser.fetch(`/api/v1/workspaces/${workspaceId}/wiki/import/vault`, {
          method: "POST",
          body: vault,
        })
      ).status,
    ).toBe(404);
    expect(await ana.api.wiki.listWikiPages(workspaceId)).toHaveLength(1);
    const lock = await apiError(beto.api.wiki.lockWikiPage(workspaceId, page.slug, true));
    expect([lock.status, lock.code]).toEqual([403, "forbidden"]);
    // A locked page: a member neither edits, moves, renames, publishes nor deletes it; an admin does.
    await ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
    const denied = await Promise.all([
      apiError(beto.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: "y", parentVersion: 1 })),
      apiError(beto.api.wiki.moveWikiPage(workspaceId, page.slug, "elsewhere")),
      apiError(beto.api.wiki.renameWikiPage(workspaceId, page.slug, "Other")),
      apiError(beto.api.wiki.publishWikiPageDraft(workspaceId, page.slug)),
      apiError(beto.api.wiki.deleteWikiPageDraft(workspaceId, page.slug)),
      apiError(beto.api.wiki.deleteWikiPage(workspaceId, page.slug)),
    ]);
    expect(denied.map((e) => [e.status, e.code])).toEqual(Array(6).fill([403, "wiki.page_locked"]));
    expect(
      (await ana.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: "y", parentVersion: 1 })).version,
    ).toBe(2);
  });

  test("simultaneous saves on the same parent version: exactly one wins, the others get 409", async () => {
    const { workspaceId, ana, beto } = await team();
    const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Race", body: "base" });
    const who = [ana, beto, ana, beto, ana];
    const results = await Promise.allSettled(
      who.map((p, i) =>
        p.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: `edit ${i}`, parentVersion: 1 }),
      ),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(won).toHaveLength(1);
    expect(lost.map((e) => [e.status, e.code])).toEqual(Array(4).fill([409, "wiki.stale_draft"]));
    const now = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
    expect(now.version).toBe(2);
    expect(now.history.map((h) => h.version)).toEqual([2, 1]);

    // The properties' first save, five at once: one creates them, the others see the conflict.
    const defs: WikiPropDef[] = [{ id: "prop_n", name: "N", type: "number" }];
    const saves = await Promise.allSettled(who.map((p) => p.api.wiki.setWikiProps(workspaceId, defs, 0)));
    expect(saves.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await ana.api.wiki.listWikiProps(workspaceId)).version).toBe(1);
  });

  test("vault limits: total unpacked size, attachment size and count, folder depth, a zip inside the zip, links out of the vault, the target folder", async () => {
    const { workspaceId, ana } = await team();
    const saved = { ...VAULT_LIMITS };
    try {
      VAULT_LIMITS.totalBytes = 1000;
      const tooBig = await apiError(
        ana.api.wiki.importWikiVault(workspaceId, {
          file: new Blob([zipSync({ "a.md": new Uint8Array(600), "b.md": new Uint8Array(600) })]),
          fileName: "t.zip",
        }),
      );
      expect([tooBig.status, tooBig.code]).toEqual([413, "wiki.import.too_large"]);
      expect(await ana.api.wiki.listWikiPages(workspaceId)).toEqual([]);
      Object.assign(VAULT_LIMITS, saved);

      VAULT_LIMITS.attachmentBytes = 10;
      VAULT_LIMITS.attachments = 2;
      const r = await ana.api.wiki.importWikiVault(workspaceId, {
        file: new Blob([
          zipSync({
            "big.png": new Uint8Array(11),
            "a.png": new Uint8Array(5),
            "b.png": new Uint8Array(5),
            "c.png": new Uint8Array(5),
          }),
        ]),
        fileName: "a.zip",
      });
      expect(r.attachments).toBe(2);
      expect(r.failed.map((f) => [f.path, f.error]).sort()).toEqual([
        ["big.png", "wiki.import.too_large"],
        ["c.png", "wiki.import.too_many_attachments"],
      ]);
    } finally {
      Object.assign(VAULT_LIMITS, saved);
    }

    // A folder 120 levels deep is cut to the folder's 200 characters; the note is still created.
    const deep = `${Array.from({ length: 120 }, (_, i) => `d${i}`).join("/")}/Deep.md`;
    // A zip inside the zip is an attachment like any other file: it isn't unpacked.
    const inner = zipSync({ "evil.md": strToU8("# inside the inner zip") });
    const links = "[[../../etc/passwd]] [[/abs]] [[C:/win]] ![[../outside.png]]";
    const r2 = await ana.api.wiki.importWikiVault(workspaceId, {
      file: new Blob([zipSync({ [deep]: strToU8("deep"), "inner.zip": inner, "Links.md": strToU8(links) })]),
      fileName: "d.zip",
      folder: "../../../imported",
    });
    expect(r2).toMatchObject({ created: 2, attachments: 1, failed: [] });
    const tree = await ana.api.wiki.listWikiPages(workspaceId);
    const deepPage = tree.find((p) => p.title === "Deep");
    expect(deepPage?.folder.length).toBeLessThanOrEqual(200);
    expect(deepPage?.folder.startsWith("imported/d0/d1/")).toBe(true);
    expect(tree.map((p) => p.title).sort()).toEqual(["Deep", "Links"]);
    expect((await ana.api.wiki.listWikiAttachments(workspaceId)).map((a) => [a.path, a.contentType])).toEqual(
      [
        ["a.png", "image/png"],
        ["b.png", "image/png"],
        ["imported/inner.zip", "application/octet-stream"],
      ],
    );
    // Links that climb out of the vault are just names: nothing outside the workspace's pages answers them.
    const panel = await ana.api.wiki.getWikiPagePanel(
      workspaceId,
      tree.find((p) => p.title === "Links")?.slug ?? "",
    );
    expect(panel.outgoing.map((o) => o.state)).toEqual(["missing", "missing", "missing", "missing"]);
  });
});

/** Holds the server's next database transaction before it starts, until `release`. */
function holdNextTransaction(srv: RunningServer) {
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
  db.transaction = (async (...args: Parameters<typeof original>) => {
    db.transaction = original;
    begun();
    await gate;
    return original(...args);
  }) as typeof original;
  return { started, release };
}

describe("a write decides on the page it reads locked in its own transaction", () => {
  test("every member write that read the page before a lock and commits after it is rejected with wiki.page_locked", async () => {
    const { workspaceId, ana, beto } = await team();
    // A live draft row, so publishing and discarding have something to write.
    const withDraft = async (title: string) => {
      const p = await beto.api.wiki.createWikiPage(workspaceId, { title, body: "Original.\n" });
      const row = await server.deps.db.query.knowledgePages.findFirst({
        where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.slug, p.slug)),
      });
      if (!row) throw new Error("page");
      const state = Y.encodeStateAsUpdate((await wikiMarkdown()).toYDoc("Original.\n"));
      await server.deps.db
        .insert(schema.wikiPageDocs)
        .values({ pageId: row.id, state: Buffer.from(state).toString("base64"), parentVersion: 1 });
      return p;
    };
    const writes: [string, (slug: string) => Promise<unknown>][] = [
      [
        "save",
        (slug) => beto.api.wiki.replaceWikiPage(workspaceId, slug, { body: "AFTER LOCK", parentVersion: 1 }),
      ],
      [
        "meta",
        (slug) => beto.api.wiki.updateWikiPageMeta(workspaceId, slug, { parentVersion: 1, tags: ["after"] }),
      ],
      ["rename", (slug) => beto.api.wiki.renameWikiPage(workspaceId, slug, `${slug} after lock`)],
      ["move", (slug) => beto.api.wiki.moveWikiPage(workspaceId, slug, "after-lock")],
      ["restore", (slug) => beto.api.wiki.restoreWikiPageVersion(workspaceId, slug, 1, 1)],
      ["trash", (slug) => beto.api.wiki.deleteWikiPage(workspaceId, slug)],
      ["publish", (slug) => beto.api.wiki.publishWikiPageDraft(workspaceId, slug, true)],
      ["discard", (slug) => beto.api.wiki.deleteWikiPageDraft(workspaceId, slug)],
    ];
    const outcomes: string[] = [];
    for (const [what, write] of writes) {
      const p = await withDraft(`Locked ${what}`);
      const hold = holdNextTransaction(server);
      const pending = write(p.slug).then(
        () => "accepted",
        (e: { status?: number; code?: string }) => `${e.status} ${e.code}`,
      );
      await hold.started;
      await ana.api.wiki.lockWikiPage(workspaceId, p.slug, true);
      hold.release();
      outcomes.push(`${what}: ${await pending}`);
      const now = await ana.api.wiki.getWikiPage(workspaceId, p.slug);
      expect([what, now.version, now.body, now.folder, now.title, now.tags]).toEqual([
        what,
        1,
        "Original.\n",
        "",
        `Locked ${what}`,
        [],
      ]);
    }
    expect(outcomes).toEqual(writes.map(([what]) => `${what}: 403 wiki.page_locked`));
  });

  test("an admin demoted between the check and the commit can't lock any more", async () => {
    const { workspaceId, ana } = await team();
    const carla = withApi(await memberOf(server, workspaceId, "Carla", email("carla"), "admin"));
    const p = await ana.api.wiki.createWikiPage(workspaceId, { title: "Demote race", body: "x" });
    const hold = holdNextTransaction(server);
    const pending = carla.api.wiki.lockWikiPage(workspaceId, p.slug, true).then(
      () => "accepted",
      (e: { status?: number }) => String(e.status),
    );
    await hold.started;
    await server.deps.db
      .update(schema.members)
      .set({ role: "member" })
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, carla.user.id)));
    hold.release();
    expect(await pending).toBe("403");
    expect((await ana.api.wiki.getWikiPage(workspaceId, p.slug)).locked).toBe(false);
  });
});

const UNLOCKED = process.env.VANR_TEST_WIKI_UNLOCKED === "1";
const onPostgres = (name: string) => (TEST_POSTGRES_URL ? name : `${name} (skipped: ${NO_POSTGRES})`);

describe.skipIf(!TEST_POSTGRES_URL)(onPostgres("wiki saves on Postgres"), () => {
  test(
    "simultaneous saves on the same parent version, with real concurrent transactions: exactly one wins",
    async () => {
      const pg = await startTestServer({ env: { DATABASE_URL: await testDatabaseUrl("wiki") } });
      try {
        const ana = withApi(await signedIn(pg, "Ana", email("ana")));
        const { workspaceId } = await seedWorkspace(pg, ana, "Postgres");
        const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Race", body: "base" });
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) =>
            ana.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: `edit ${i}`, parentVersion: 1 }),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const now = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
        expect(now.history.map((h) => h.version)).toEqual([2, 1]);
        // The trash and a save that land together: the page leaves the search either way.
        await Promise.allSettled([
          ana.api.wiki.replaceWikiPage(workspaceId, page.slug, { body: "plugh", parentVersion: 2 }),
          ana.api.wiki.deleteWikiPage(workspaceId, page.slug),
        ]);
        expect(await pg.deps.search.search({ workspaceId, userId: ana.user.id }, "plugh")).toEqual([]);
      } finally {
        await pg.stop();
      }
    },
    SERVER_TEST_MS,
  );
  test("a member's save that comes while a lock holds the page waits for it and is then rejected", async () => {
    const url = await testDatabaseUrl("wikilock");
    const pg = await startTestServer({ env: { DATABASE_URL: url } });
    const locked = pageLock.row;
    try {
      const ana = withApi(await signedIn(pg, "Ana", email("ana")));
      const { workspaceId } = await seedWorkspace(pg, ana, "Postgres lock");
      const beto = withApi(await memberOf(pg, workspaceId, "Beto", email("beto")));
      const page = await ana.api.wiki.createWikiPage(workspaceId, { title: "Lock race", body: "Original" });
      // VANR_TEST_WIKI_UNLOCKED=1: the same read without FOR UPDATE (the CI runs it and expects a failure).
      const read: typeof locked = UNLOCKED
        ? async (tx, id) => {
            const [row] = await tx
              .select()
              .from(schema.knowledgePages)
              .where(eq(schema.knowledgePages.id, id));
            return row ?? null;
          }
        : locked;
      let reached!: () => void;
      let release!: () => void;
      const holding = new Promise<void>((r) => {
        reached = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let held = false;
      // The lock's transaction reads the page and holds it there, uncommitted.
      pageLock.row = async (tx, id) => {
        const row = await read(tx, id);
        if (!held) {
          held = true;
          reached();
          await gate;
        }
        return row;
      };
      const locking = ana.api.wiki.lockWikiPage(workspaceId, page.slug, true);
      await holding;
      const saving = beto.api.wiki
        .replaceWikiPage(workspaceId, page.slug, { body: "MEMBER DURING LOCK", parentVersion: 1 })
        .then(
          () => 200,
          (e: { status?: number }) => e.status ?? 0,
        );
      // Release the lock once the save waits for the page's row lock (or already ended without one).
      const waitingForLock = async () => {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const rows = await pg.deps.db.execute(
            sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
          );
          if (Array.isArray(rows) && rows.length) return;
          if (Date.now() > deadline) throw new Error("the save never waited for the page's lock");
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      await Promise.race([saving, waitingForLock()]);
      release();
      await locking;
      const status = await saving;
      const now = await ana.api.wiki.getWikiPage(workspaceId, page.slug);
      // The save read the page after the lock committed: rejected (unlocked, it read it before and saved).
      expect(status).toBe(403);
      expect({ locked: now.locked, body: now.body }).toEqual({ locked: true, body: "Original" });
    } finally {
      pageLock.row = locked;
      await pg.stop();
    }
  }, 60_000);
});
