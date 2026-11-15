// The workspace's search over HTTP: the permission in the WHERE for each kind the index accepts (a file,
// a message, a wiki page, an issue, a debate), operators, the Cmd+K palette, the boot's backfill and "ask"
// mode, which is rejected at its entry until the runtime slice brings the model resolver.
//
// Only files have a producer in this slice (the Drive). The other kinds' producers (chat S6, wiki S4,
// issues S4, debates S3) come with their areas; here their rows are written straight to the database and
// `reindex` reads them back, the same call each producer makes after it saves.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { ASK_LIMIT } from "../src/search-ask";
import { backfillSearch, reindex } from "../src/search-index";
import type { RunningServer } from "../src/server";
import { Browser, body, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedDm, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.stop());

let n = 0;
const email = (who: string) => `${who}${++n}@search-routes.test`;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;
const failure = async (res: Response) => (await body(res)).error;

/** Ana (owner), Beto and Caio (members); #sales is private with Ana and Beto. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Search");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const sales = await seedChannel(server, workspaceId, {
    name: "sales",
    visibility: "private",
    members: [ana, beto],
  });
  return { workspaceId, general, sales, ana, beto, caio };
}

const search = async (who: Person, workspaceId: string, q: string, extra = "") => {
  const res = await who.browser.fetch(`${W(workspaceId)}/search?q=${encodeURIComponent(q)}${extra}`);
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  return (await body(res)).hits as {
    kind: string;
    sourceId: string;
    snippet: string;
    threadId: string | null;
  }[];
};
const ids = async (who: Person, workspaceId: string, q: string, extra = "") =>
  (await search(who, workspaceId, q, extra)).map((h) => `${h.kind}:${h.sourceId}`).sort();

async function message(workspaceId: string, channelId: string, who: Person, text: string, meta = {}) {
  const id = newId("msg");
  await server.deps.db
    .insert(schema.messages)
    .values({ id, workspaceId, channelId, authorKind: "person", authorId: who.user.id, body: text, meta });
  await reindex(server.deps, { kind: "message", id });
  return id;
}

describe("search: the permission in the WHERE (attacks)", () => {
  test("a DM of Ana and Beto doesn't show to Caio; a private channel only to members, not even through operators", async () => {
    const { workspaceId, sales, ana, beto, caio } = await team();
    const dm = await seedDm(server, workspaceId, ana, beto);
    await message(workspaceId, dm, ana, "password of the blue vault");
    await message(workspaceId, sales, beto, "secret vault target");
    expect((await search(beto, workspaceId, "vault")).map((h) => h.snippet).sort()).toEqual([
      "password of the blue vault",
      "secret vault target",
    ]);
    expect(await search(caio, workspaceId, "vault")).toEqual([]);
    expect(await search(caio, workspaceId, "vault in:#sales")).toEqual([]);
    expect(await search(caio, workspaceId, "vault in:@ana")).toEqual([]);
    expect(await search(caio, workspaceId, "vault from:@ana")).toEqual([]);
  });

  test("the filter before the cut: hidden chunks past the cut don't take the slot of the only visible one", async () => {
    const { workspaceId, general, sales, beto, caio } = await team();
    // limit=5 asks the index for 15 candidates: 40 hidden chunks would fill them all if the filter came after.
    for (let i = 0; i < 40; i++) await message(workspaceId, sales, beto, `hidden zebra note ${i}`);
    await message(workspaceId, general, beto, "visible zebra note");
    const hits = await search(caio, workspaceId, "zebra", "&limit=5");
    expect(hits.map((h) => h.snippet)).toEqual(["visible zebra note"]);
  });

  test("another workspace's search sees nothing of this one; a non-member gets 404 on every search route", async () => {
    const { workspaceId, general, ana } = await team();
    await message(workspaceId, general, ana, "budget of the lighthouse project");
    const other = await seedWorkspace(server, ana, "Other");
    expect(await search(ana, other.workspaceId, "lighthouse")).toEqual([]);
    const eve = await signedIn(server, "Eve", email("eve"));
    expect((await eve.browser.fetch(`${W(workspaceId)}/search?q=lighthouse`)).status).toBe(404);
    expect((await eve.browser.fetch(`${W(workspaceId)}/search/palette?q=gen`)).status).toBe(404);
    expect((await eve.browser.json(`${W(workspaceId)}/search/ask`, "POST", { q: "lighthouse" })).status).toBe(
      404,
    );
    expect((await new Browser(server.url).fetch(`${W(workspaceId)}/search?q=lighthouse`)).status).toBe(401);
  });

  test("a retracted message leaves on reindex and the backfill doesn't bring it back", async () => {
    const { workspaceId, general, ana } = await team();
    const id = await message(workspaceId, general, ana, "retract this marmalade");
    expect(await ids(ana, workspaceId, "marmalade")).toEqual([`message:${id}`]);
    await server.deps.db
      .update(schema.messages)
      .set({ meta: { retracted: { actorUserId: ana.user.id, at: new Date().toISOString() } } })
      .where(eq(schema.messages.id, id));
    await reindex(server.deps, { kind: "message", id });
    expect(await ids(ana, workspaceId, "marmalade")).toEqual([]);
    await backfillSearch(server.deps);
    expect(await ids(ana, workspaceId, "marmalade")).toEqual([]);
  });

  test("a channel that turns private disappears for non-members without reindexing", async () => {
    const { workspaceId, ana, caio } = await team();
    const ops = await seedChannel(server, workspaceId, { name: "ops", members: [ana] });
    await message(workspaceId, ops, ana, "migration window on friday");
    expect(await search(caio, workspaceId, "migration window")).toHaveLength(1);
    await server.deps.db
      .update(schema.channels)
      .set({ visibility: "private" })
      .where(eq(schema.channels.id, ops));
    expect(await search(caio, workspaceId, "migration window")).toEqual([]);
    expect(await search(ana, workspaceId, "migration window")).toHaveLength(1);
  });
});

describe("search: every kind the index accepts", () => {
  test("a wiki page and an issue belong to the workspace; a page in the trash leaves", async () => {
    const { workspaceId, ana, caio } = await team();
    const pageId = newId("kp");
    await server.deps.db.insert(schema.knowledgePages).values({
      id: pageId,
      workspaceId,
      slug: "onboarding-guide",
      title: "Onboarding guide",
      body: "# Welcome\n\nThe espresso maker is on the second floor.",
      updatedBy: { type: "person", id: ana.user.id },
    });
    await reindex(server.deps, { kind: "wiki", id: pageId });
    const columnId = newId("col");
    await server.deps.db
      .insert(schema.boardColumns)
      .values({ id: columnId, workspaceId, name: "To do", stage: "todo", position: 0 });
    const issueId = newId("iss");
    await server.deps.db.insert(schema.issues).values({
      id: issueId,
      workspaceId,
      number: 7,
      title: "Fix the espresso grinder",
      description: "It jams every morning.",
      columnId,
      createdBy: { type: "person", id: ana.user.id },
    });
    await reindex(server.deps, { kind: "issue", id: issueId });
    // The id each screen uses: the wiki's slug and the issue's number.
    expect(await ids(caio, workspaceId, "espresso")).toEqual(["issue:7", "wiki:onboarding-guide"]);
    await server.deps.db
      .update(schema.knowledgePages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.knowledgePages.id, pageId));
    await reindex(server.deps, { kind: "wiki", id: pageId });
    expect(await ids(caio, workspaceId, "espresso")).toEqual(["issue:7"]);
  });

  test("a debate in a private channel: who takes part sees it, the rest don't; a hidden turn stays out", async () => {
    const { workspaceId, sales, ana, beto, caio } = await team();
    const dora = await memberOf(server, workspaceId, "Dora", email("dora"));
    const debateId = newId("deb");
    await server.deps.db.insert(schema.debates).values({
      id: debateId,
      workspaceId,
      title: "Pricing for the harbor plan",
      goal: "Decide the harbor plan price",
      channelId: sales,
      createdBy: { type: "person", id: ana.user.id },
      userIds: [dora.user.id],
    });
    await server.deps.db.insert(schema.debatePosts).values([
      {
        id: newId("dp"),
        debateId,
        author: { type: "person", id: ana.user.id },
        kind: "free",
        round: 1,
        body: "open turn mentions anchovy",
      },
      {
        id: newId("dp"),
        debateId,
        author: { type: "person", id: ana.user.id },
        kind: "turn",
        round: 1,
        body: "blind turn mentions sardine",
        hiddenUntilRoundEnd: true,
      },
    ]);
    await reindex(server.deps, { kind: "debate", id: debateId });
    expect(await ids(beto, workspaceId, "harbor")).toEqual([`debate:${debateId}`]);
    expect(await ids(dora, workspaceId, "harbor")).toEqual([`debate:${debateId}`]);
    expect(await ids(caio, workspaceId, "harbor")).toEqual([]);
    expect(await ids(beto, workspaceId, "anchovy")).toEqual([`debate:${debateId}`]);
    expect(await ids(beto, workspaceId, "sardine")).toEqual([]);
  });

  test("recovery replaces stale file chunks after a failed reindex", async () => {
    const { workspaceId, ana } = await team();
    const file = await body(
      await ana.browser.json(`${W(workspaceId)}/files`, "POST", {
        title: "Notes",
        content: { kind: "document", markdown: "oldword" },
      }),
    );
    const failed = spyOn(server.deps.search, "withDb").mockImplementationOnce(() => {
      throw new Error("index unavailable");
    });
    try {
      expect(
        (
          await ana.browser.json(`${W(workspaceId)}/files/${file.id}/versions`, "POST", {
            parentVersion: 1,
            content: { kind: "document", markdown: "newword" },
          })
        ).status,
      ).toBe(200);
    } finally {
      failed.mockRestore();
    }
    expect(await ids(ana, workspaceId, "newword")).toEqual([]);
    await backfillSearch(server.deps);
    expect(await ids(ana, workspaceId, "newword")).toEqual([`file:${file.id}`]);
    expect(await ids(ana, workspaceId, "oldword")).toEqual([]);
  });
});

describe("search: operators and the format", () => {
  test("from:, in:, has:, is:thread and the kinds filter; the message's thread in the hit", async () => {
    const { workspaceId, general, ana, beto } = await team();
    await message(workspaceId, general, ana, "kiwi from ana https://example.com/kiwi");
    await message(workspaceId, general, beto, "kiwi from beto");
    const fromAna = await search(beto, workspaceId, "kiwi from:@ana");
    expect(fromAna.map((h) => h.snippet)).toEqual(["kiwi from ana https://example.com/kiwi"]);
    expect((await search(beto, workspaceId, "kiwi from:me")).map((h) => h.snippet)).toEqual([
      "kiwi from beto",
    ]);
    expect(await search(beto, workspaceId, "kiwi has:link")).toHaveLength(1);
    expect(await search(beto, workspaceId, "kiwi in:#general")).toHaveLength(2);
    expect(await search(beto, workspaceId, "kiwi in:#nowhere")).toEqual([]);
    expect(await search(beto, workspaceId, "kiwi", "&kinds=file")).toEqual([]);
    expect(await search(beto, workspaceId, "k")).toEqual([]);
  });
});

describe("Cmd+K palette", () => {
  test("groups on the server and the # and @ prefixes, only what the person reads", async () => {
    const { workspaceId, ana, caio } = await team();
    await seedChannel(server, workspaceId, { name: "salesforce-sync", members: [ana] });
    const palette = async (who: Person, q: string) =>
      body(await who.browser.fetch(`${W(workspaceId)}/search/palette?q=${encodeURIComponent(q)}`));
    const forCaio = await palette(caio, "#sales");
    expect(forCaio.channels.map((c: { name: string }) => c.name)).toEqual(["salesforce-sync"]);
    expect(forCaio.people).toEqual([]);
    const forAna = await palette(ana, "#sales");
    expect(forAna.channels.map((c: { name: string }) => c.name).sort()).toEqual(["sales", "salesforce-sync"]);
    const people = await palette(caio, "@beto");
    expect(people.channels).toEqual([]);
    expect(people.people.map((p: { name: string }) => p.name)).toEqual(["Beto"]);
    expect(await palette(caio, "")).toEqual({ channels: [], people: [], agents: [], hits: [] });
  });
});

describe("ask mode", () => {
  test("rejected at its entry with not_available until the runtime slice: no question counted, nothing in the ledger", async () => {
    const { workspaceId, general, ana } = await team();
    await message(workspaceId, general, ana, "the onboarding checklist lives in the wiki");
    const ledgerBefore = await server.deps.db.select().from(schema.usageLines);
    for (let i = 0; i < ASK_LIMIT.max + 2; i++) {
      const res = await ana.browser.json(`${W(workspaceId)}/search/ask`, "POST", {
        q: "where is the checklist?",
      });
      expect(res.status).toBe(503);
      expect(await failure(res)).toMatchObject({
        code: "not_available",
        params: { method: "providerForWorkspace" },
      });
    }
    expect(await server.deps.db.select().from(schema.usageLines)).toHaveLength(ledgerBefore.length);
    // The body is validated before anything else.
    expect((await ana.browser.json(`${W(workspaceId)}/search/ask`, "POST", { q: "x" })).status).toBe(400);
  });
});
