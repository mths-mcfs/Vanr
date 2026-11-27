// The agent's content tools (runtime/content-tools.ts) on a real database: Drive, wiki, issues, calendar,
// routines and debates, their undo through the route, and what the agent and the person who asked may read
// (a private channel's file, a restricted wiki page, a page that takes only proposals, a private debate). Each
// write reads back through its own route; the routines and debates routes come with a later module, so those
// read back from their rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CalendarRange, FileDetail, Issue, IssueActivity } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";
import { racing, seedAgent, toolRun, undo } from "./tool-run";
import { apiError, wikiApi } from "./wiki-api";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@content-tools.test`;

/** A person's call to a route; a rejected one throws with its status. */
async function api<T>(who: Person, workspaceId: string, method: string, path: string, data?: unknown) {
  const res = await who.browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await body(res)) as T;
}

/** Ana (owner), Beto (member) and Lia in #general; `call` is Lia's run asked by Beto, `as` by someone else. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, { channels: [general] });
  const run = await toolRun(server, { workspaceId, agent: lia, channelId: general, asker: beto });
  const as = async (asker: Person | null) =>
    toolRun(server, { workspaceId, agent: lia, channelId: general, asker });
  const wiki = { ana: wikiApi(ana.browser), beto: wikiApi(beto.browser) };
  return { workspaceId, general, ana, beto, lia, wiki, as, ...run };
}

describe("content tools", () => {
  test(
    "Drive: create, read, a new version; undo brings the content back and redo applies it again",
    async () => {
      const { workspaceId: ws, beto, call, action } = await team();
      await call("create_drive_file", { title: "Plan", content: { kind: "document", markdown: "# Plan" } });
      const created = await action("file_created");
      const [file] = await wikiApi(beto.browser).listFiles(ws);
      expect(file).toMatchObject({ title: "Plan", version: 1, createdBy: { type: "agent" } });
      const id = String(file?.id);

      expect((await call("list_drive_files", {})).content).toContain(id);
      expect((await call("read_drive_file", { fileId: id })).content).toContain("# Plan");

      const updated = await call("update_drive_file", {
        fileId: id,
        parentVersion: 1,
        content: { kind: "document", markdown: "# Plan v2" },
      });
      expect(updated.content).toContain("version 2");
      // an old parentVersion: the model gets the conflict as a tool error
      const stale = await call("update_drive_file", {
        fileId: id,
        parentVersion: 1,
        content: { kind: "document", markdown: "x" },
      });
      expect(stale.isError).toBe(true);

      const upd = await action("file_updated");
      expect((await undo(beto, ws, upd)).status).toBe(200);
      const afterUndo = await api<FileDetail>(beto, ws, "GET", `/files/${id}`);
      expect(afterUndo.version).toBe(3);
      expect(afterUndo.content).toEqual({ kind: "document", markdown: "# Plan" });
      expect((await undo(beto, ws, upd, "redo")).status).toBe(200);
      expect((await api<FileDetail>(beto, ws, "GET", `/files/${id}`)).content).toEqual({
        kind: "document",
        markdown: "# Plan v2",
      });

      // the creation can't be undone once another version was saved
      expect((await undo(beto, ws, created)).code).toBe("action.changed_since");
    },
    SERVER_TEST_MS,
  );

  test(
    "Drive: undoing the creation sends it to the trash; redo restores it; a private channel's file doesn't show",
    async () => {
      const { workspaceId: ws, ana, beto, lia, as, call, action } = await team();
      await call("create_drive_file", {
        title: "Draft",
        content: { kind: "table", columns: ["a"], rows: [["1"]] },
      });
      const act = await action("file_created");
      expect((await undo(beto, ws, act)).status).toBe(200);
      expect(await wikiApi(beto.browser).listFiles(ws)).toEqual([]);
      expect((await undo(beto, ws, act, "redo")).status).toBe(200);
      expect((await wikiApi(beto.browser).listFiles(ws)).map((a) => a.title)).toEqual(["Draft"]);

      // Ana keeps a file in a private channel without Lia: Lia neither reads nor lists it
      const secret = await seedChannel(server, ws, { name: "board", visibility: "private", members: [ana] });
      const hidden = await api<FileDetail>(ana, ws, "POST", "/files", {
        title: "Salaries",
        content: { kind: "document", markdown: "secret" },
        channelId: secret,
      });
      const read = await call("read_drive_file", { fileId: hidden.id });
      expect(read.isError).toBe(true);
      expect(read.content).toContain("not found");
      expect((await call("list_drive_files", { q: "Sal" })).content).toContain("No files found");
      expect((await call("share_drive_file", { fileId: hidden.id })).isError).toBe(true);
      // Lia joins the channel, Beto doesn't: asked by Beto she still doesn't read it; asked by Ana she does
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: secret, memberType: "agent", memberId: lia.id });
      expect((await call("read_drive_file", { fileId: hidden.id })).content).toContain("not found");
      expect((await call("list_drive_files", { q: "Sal" })).content).toContain("No files found");
      expect((await (await as(ana)).call("read_drive_file", { fileId: hidden.id })).content).toContain(
        "secret",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: the agent's safe edit by passage, with parent_version and warnings",
    async () => {
      const { workspaceId: ws, wiki, call } = await team();
      await call("add_wiki_page", { title: "Rules", body: "Start: 9am.\nLunch: 12pm.\nEnd: 6pm." });
      const pageBody = async () => (await wiki.beto.getWikiPage(ws, "rules")).body;

      // swaps a unique passage
      const ok = await call("update_wiki_page", {
        slug: "rules",
        parent_version: 1,
        edits: [{ old_str: "Lunch: 12pm.", new_str: "Lunch: 1pm." }],
      });
      expect(ok.isError).toBe(false);
      expect(ok.content).toContain("Saved version 2");
      expect(await pageBody()).toBe("Start: 9am.\nLunch: 1pm.\nEnd: 6pm.");

      // a repeated or missing passage: rejected, nothing changes
      const amb = await call("update_wiki_page", {
        slug: "rules",
        parent_version: 2,
        edits: [{ old_str: "m.", new_str: "x" }],
      });
      expect(amb.isError).toBe(true);
      expect(amb.content).toContain("appears 3 times");
      const miss = await call("update_wiki_page", {
        slug: "rules",
        parent_version: 2,
        edits: [{ old_str: "Dinner", new_str: "x" }],
      });
      expect(miss.isError).toBe(true);
      expect(miss.content).toContain("not found");
      expect(await pageBody()).toBe("Start: 9am.\nLunch: 1pm.\nEnd: 6pm.");

      // a person saves over it while the agent worked with version 2
      await wiki.ana.replaceWikiPage(ws, "rules", {
        body: "Start: 8am.\nLunch: 1pm.\nEnd: 6pm.",
        parentVersion: 2,
      });
      // replacing the whole body from the old version would erase Ana's change: rejected
      const clobber = await call("update_wiki_page", {
        slug: "rules",
        parent_version: 2,
        mode: "replace",
        text: "All new",
      });
      expect(clobber.isError).toBe(true);
      expect(clobber.content).toContain("changed since version 2");
      expect(await pageBody()).toContain("Start: 8am.");
      // the swap by passage still lands in the right place, with a warning; Ana's change stays
      const late = await call("update_wiki_page", {
        slug: "rules",
        parent_version: 2,
        edits: [{ old_str: "End: 6pm.", new_str: "End: 5pm. See [[Holidays]]." }],
      });
      expect(late.isError).toBe(false);
      expect(late.content).toContain("changed since version 2 (now 3)");
      expect(late.content).toContain("[[Holidays]] does not match any page");
      expect(await pageBody()).toBe("Start: 8am.\nLunch: 1pm.\nEnd: 5pm. See [[Holidays]].");

      // without parent_version, the agent doesn't even get to save
      const noBase = await call("update_wiki_page", {
        slug: "rules",
        edits: [{ old_str: "8am", new_str: "7am" }],
      });
      expect(noBase.isError).toBe(true);
      expect((await wiki.beto.getWikiPage(ws, "rules")).version).toBe(4);
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: the agent's link warning knows another name of the page and ignores a page in the trash",
    async () => {
      const { workspaceId: ws, wiki, call } = await team();
      const doc = await wiki.ana.createWikiPage(ws, { title: "Document", body: "x" });
      await wiki.ana.updateWikiPageMeta(ws, doc.slug, { parentVersion: 1, altTitles: ["Guide"] });
      const old = await wiki.ana.createWikiPage(ws, { title: "Old", body: "y" });
      await wiki.ana.deleteWikiPage(ws, old.slug);
      await call("add_wiki_page", { title: "Index", body: "Start." });
      const res = await call("update_wiki_page", {
        slug: "index",
        parent_version: 1,
        mode: "append",
        text: "[[Guide]], [[Old]], [[Document#Top|doc]] and ![[photo.png]]",
      });
      expect(res.isError).toBe(false);
      expect(res.content).toContain("[[Old]] does not match any page");
      expect(res.content).not.toContain("[[Guide]] does not");
      expect(res.content).not.toContain("[[Document]] does not");
      expect(res.content).not.toContain("photo.png");
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: create, search, read, append, link; undo after a later edit declines; a locked page is rejected",
    async () => {
      const { workspaceId: ws, wiki, beto, call, action } = await team();
      await call("add_wiki_page", { title: "Onboarding", body: "Welcome aboard." });
      const created = await action("wiki_written");
      expect(await wiki.beto.getWikiPage(ws, "onboarding")).toMatchObject({
        title: "Onboarding",
        version: 1,
      });
      await call("add_wiki_page", { title: "Holidays", body: "Rules." });

      await server.deps.runtime.settle();
      expect((await call("search", { query: "welcome is:wiki" })).content).toContain("Onboarding");
      expect((await call("open_wiki_page", { slug: "onboarding" })).content).toContain("Welcome aboard.");
      expect((await wiki.beto.getWikiReads(ws)).length).toBeGreaterThan(0);

      await call("update_wiki_page", {
        slug: "onboarding",
        parent_version: 1,
        mode: "append",
        text: "## First day",
      });
      const appended = await action("wiki_updated");
      expect((await wiki.beto.getWikiPage(ws, "onboarding")).body).toBe("Welcome aboard.\n\n## First day");
      await call("link_to_wiki", { from: "onboarding", to: "holidays" });
      expect((await wiki.beto.getWikiPage(ws, "onboarding")).body).toContain("[[Holidays]]");

      // undoing the append after the link: the page changed since
      expect((await undo(beto, ws, appended)).code).toBe("action.changed_since");

      // a locked page: the agent doesn't touch it
      await wiki.ana.lockWikiPage(ws, "holidays", true);
      const locked = await call("update_wiki_page", {
        slug: "holidays",
        parent_version: 1,
        mode: "append",
        text: "x",
      });
      expect(locked.isError).toBe(true);
      expect(locked.content).toContain("locked");

      // the creation can't be undone once the page was edited
      expect((await undo(beto, ws, created)).code).toBe("action.changed_since");
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: undo and redo the creation",
    async () => {
      const { workspaceId: ws, wiki, beto, call, action } = await team();
      await call("add_wiki_page", { title: "Glossary", body: "Terms." });
      const act = await action("wiki_written");
      expect((await undo(beto, ws, act)).status).toBe(200);
      expect((await apiError(wiki.beto.getWikiPage(ws, "glossary"))).status).toBe(404);
      expect((await undo(beto, ws, act, "redo")).status).toBe(200);
      expect((await wiki.beto.getWikiPage(ws, "glossary")).body).toBe("Terms.");
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: the agent reads with the person: what both read counts (the intersection)",
    async () => {
      const { workspaceId: ws, wiki, ana, beto, lia, as } = await team();
      const page = await wiki.ana.createWikiPage(ws, { title: "Plans", body: "Secret plan." });
      const { slug } = await wiki.ana.setWikiPageAccess(ws, page.slug, {
        kind: "private",
        userIds: [],
        agentIds: [],
      });
      const forAna = await as(ana);
      const forBeto = await as(beto);
      const routine = await as(null);
      // Ana reads it, but Lia is not on the list: Lia doesn't read it, not even for Ana
      let out = await forAna.call("open_wiki_page", { slug });
      expect(out.isError).toBe(true);
      expect(out.content).not.toContain("Secret plan");
      expect((await routine.call("open_wiki_page", { slug })).isError).toBe(true);
      await wiki.ana.setWikiPageAccess(ws, slug, { kind: "private", userIds: [], agentIds: [lia.id] });
      out = await forAna.call("open_wiki_page", { slug });
      expect(out.content).toContain("Secret plan");
      // Beto asks the same Lia: he doesn't read it, so she doesn't read it for him either
      out = await forBeto.call("open_wiki_page", { slug });
      expect(out.isError).toBe(true);
      expect(out.content).not.toContain("Secret plan");
      // nor change it, propose on it or link to it for him
      const open = await wiki.ana.createWikiPage(ws, { title: "Open", body: "Everyone." });
      const writes = [
        ["update_wiki_page", { slug, parent_version: 2, mode: "append", text: "x" }],
        ["propose_wiki_edit", { slug, parent_version: 2, edits: [{ old_str: "Secret", new_str: "Open" }] }],
        ["link_to_wiki", { from: open.slug, to: slug }],
        ["link_to_wiki", { from: slug, to: open.slug }],
      ] as const;
      for (const [tool, input] of writes) {
        const res = await forBeto.call(tool, input);
        expect(res.isError).toBe(true);
        expect(res.content).toBe("Page not found");
      }
      expect((await wiki.ana.getWikiPage(ws, slug)).body).toBe("Secret plan.");
      expect((await wiki.ana.getWikiPage(ws, open.slug)).body).toBe("Everyone.");
      expect((await wiki.ana.listWikiPageAnnotations(ws, slug)).proposals).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: a page in proposal mode rejects direct writes; the agent's proposal waits for a person",
    async () => {
      const { workspaceId: ws, wiki, beto, lia, call } = await team();
      const text = "# Rules\n\nVacation: 20 days.\n\nRemote: 2 days.\n";
      const page = await wiki.ana.createWikiPage(ws, { title: "Rules", body: text });
      await wiki.ana.updateWikiPageMeta(ws, page.slug, { parentVersion: 1, agentEdits: "propose" });
      const direct = await call("update_wiki_page", {
        slug: page.slug,
        parent_version: 1,
        edits: [{ old_str: "20 days", new_str: "30 days" }],
      });
      expect(direct.isError).toBe(true);
      expect(direct.content).toContain("propose_wiki_edit");
      const link = await call("link_to_wiki", { from: page.slug, to: page.slug });
      expect(link.isError).toBe(true);
      expect((await call("open_wiki_page", { slug: page.slug })).content).toContain(
        "This page takes changes only as proposals",
      );
      // a passage that doesn't exist rejects the whole proposal
      const bad = await call("propose_wiki_edit", {
        slug: page.slug,
        parent_version: 1,
        edits: [{ old_str: "Leave: 5 days", new_str: "x" }],
      });
      expect(bad.isError).toBe(true);
      const ok = await call("propose_wiki_edit", {
        slug: page.slug,
        parent_version: 1,
        note: "New policy",
        edits: [
          { old_str: "Vacation: 20 days.", new_str: "Vacation: 30 days." },
          { old_str: "Remote: 2 days.", new_str: "Remote: 3 days." },
        ],
      });
      expect(ok.isError).toBe(false);
      expect(ok.content).toContain("Proposed 2 change(s)");
      expect((await wiki.ana.getWikiPage(ws, page.slug)).body).toBe(text);
      const [proposal] = (await wiki.ana.listWikiPageAnnotations(ws, page.slug)).proposals;
      expect(proposal).toMatchObject({
        note: "New policy",
        status: "pending",
        author: { type: "agent", id: lia.id, actingFor: beto.user.id },
      });
      expect((await call("open_wiki_page", { slug: page.slug })).content).toContain(
        "1 proposal(s) wait for review",
      );
      const decided = await wiki.ana.decideWikiAnnotation(ws, String(proposal?.id), [
        { hunkId: "h1", accept: true },
        { hunkId: "h2", accept: false },
      ]);
      expect(decided.page.body).toBe("# Rules\n\nVacation: 30 days.\n\nRemote: 2 days.\n");
    },
    SERVER_TEST_MS,
  );

  test(
    "Issues: create, list, move, comment; the agent doesn't finish; undo each step",
    async () => {
      const { workspaceId: ws, beto, lia, call, action } = await team();
      await call("create_issue", {
        title: "Replace the pump",
        criteria: ["Part arrived", "Tested"],
        assignToMe: true,
      });
      const created = await action("issue_opened");
      const issue = await api<Issue>(beto, ws, "GET", "/issues/seq/1");
      expect(issue).toMatchObject({ status: "todo", assignee: { type: "agent", id: lia.id } });
      expect((await call("list_issues", { number: 1 })).content).toContain("- [ ] Part arrived");
      expect((await call("list_issues", { q: "pump" })).content).toContain("#1 Replace the pump · todo");

      await call("update_issue", { number: 1, status: "reviewing", priority: "high" });
      const moved = await action("issue_edited");
      expect(await api<Issue>(beto, ws, "GET", "/issues/seq/1")).toMatchObject({
        status: "reviewing",
        priority: "high",
      });
      expect((await call("update_issue", { number: 1, status: "done" })).isError).toBe(true);
      // a PR link only with http(s): javascript: would become an href on the issue's screen
      expect((await call("update_issue", { number: 1, pullRequest: "javascript:alert(1)" })).isError).toBe(
        true,
      );
      expect((await api<Issue>(beto, ws, "GET", "/issues/seq/1")).pullRequests).toEqual([]);
      expect((await call("update_issue", { number: 99, title: "x" })).content).toBe("Issue not found");

      await call("comment_issue", { number: 1, text: "Part ordered." });
      const comments = async () =>
        (await api<{ activity: IssueActivity[] }>(beto, ws, "GET", `/issues/${issue.id}/activity`)).activity
          .filter((a) => a.kind === "comment")
          .map((a) => a.text);
      expect(await comments()).toEqual(["Part ordered."]);
      const com = await action("issue_commented");
      expect((await undo(beto, ws, com)).status).toBe(200);
      expect(await comments()).toEqual([]);
      expect((await undo(beto, ws, com, "redo")).status).toBe(200);
      expect(await comments()).toEqual(["Part ordered."]);

      expect((await undo(beto, ws, moved)).status).toBe(200);
      expect(await api<Issue>(beto, ws, "GET", "/issues/seq/1")).toMatchObject({
        status: "todo",
        priority: "none",
      });

      expect((await undo(beto, ws, created)).status).toBe(200);
      expect((await api<Issue>(beto, ws, "GET", "/issues/seq/1")).status).toBe("canceled");
      expect((await undo(beto, ws, created, "redo")).status).toBe(200);
      expect((await api<Issue>(beto, ws, "GET", "/issues/seq/1")).status).toBe("todo");
    },
    SERVER_TEST_MS,
  );

  test(
    "Routines and calendar: a routine from a phrase, paused by undo; free time and an event proposal",
    async () => {
      const { workspaceId: ws, ana, beto, lia, call, action, as } = await team();
      await call("schedule_routine", { prompt: "Daily summary", schedule: "every weekday at 9am" });
      const act = await action("routine_scheduled");
      const routines = () =>
        server.deps.db.select().from(schema.routines).where(eq(schema.routines.workspaceId, ws));
      const [routine] = await routines();
      expect(routine).toMatchObject({ agentId: lia.id, active: true, createdBy: beto.user.id });
      expect(routine?.nextFireAt).not.toBeNull();
      expect((await call("list_routines", {})).content).toContain(String(routine?.id));
      expect((await undo(beto, ws, act)).status).toBe(200);
      expect((await routines())[0]?.active).toBe(false);
      expect((await undo(beto, ws, act, "redo")).status).toBe(200);
      expect((await routines())[0]?.active).toBe(true);
      expect((await call("schedule_routine", { prompt: "x", schedule: "whenever" })).isError).toBe(true);
      // pausing and resuming by the tool; a routine of another agent is not found
      expect((await call("update_routine", { routineId: String(routine?.id), active: false })).isError).toBe(
        false,
      );
      expect((await routines())[0]).toMatchObject({ active: false, nextFireAt: null });
      expect((await call("update_routine", { routineId: "rtn_other", active: true })).content).toContain(
        "not found",
      );
      // without a person there's no calendar and no routine "on behalf of"
      const routineRun = await as(null);
      expect(
        (await routineRun.call("schedule_routine", { prompt: "x", schedule: "every day at 9am" })).isError,
      ).toBe(true);

      // Ana is busy tomorrow from 9am to 6pm UTC; the common free time doesn't fall on that day
      const day = new Date(server.deps.now().getTime() + 86_400_000);
      const at = (h: number) =>
        new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h)).toISOString();
      await api(ana, ws, "POST", "/calendar/events", { title: "Fair", start: at(9), end: at(18) });
      const free = (await call("find_available_time", { handles: ["@ana"], durationMinutes: 60, days: 3 }))
        .content;
      expect(free).not.toContain(at(9).slice(0, 13));
      expect((await call("find_available_time", { handles: ["@nobody"] })).content).toContain(
        "Nobody with handle",
      );

      await call("propose_calendar_event", { title: "Sync", start: at(19), end: at(20), handles: ["ana"] });
      const range = (who: Person) =>
        api<CalendarRange>(
          who,
          ws,
          "GET",
          `/calendar?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(23))}`,
        );
      expect((await range(beto)).proposals.map((p) => p.title)).toEqual(["Sync"]);
      expect((await range(ana)).proposals).toHaveLength(1);
      // the events the person asking sees in the calendar, and only those
      const events = (await range(beto)).events.map((e) => e.title);
      const listed = (await call("list_events", { from: at(0), to: at(23) })).content;
      for (const title of events) expect(listed).toContain(title);
      // A whole day two days on, from its start (the time of day of the run must not put `from` past `to`).
      const after = new Date(day.getTime() + 2 * 86_400_000).toISOString().replace(/T.*/, "");
      expect(
        (await call("list_events", { from: `${after}T00:00:00.000Z`, to: `${after}T23:00:00.000Z` })).content,
      ).toBe("No events.");
    },
    SERVER_TEST_MS,
  );

  test(
    "Debates: a suggestion in the chat; opening at once runs the turns; reading what both see",
    async () => {
      const { workspaceId: ws, general, ana, lia, call, cards } = await team();
      const rui = await seedAgent(server, ws, ana, { name: "Rui", channels: [general] });
      await call("open_debate", {
        title: "Price",
        goal: "Set the price",
        agents: [`@${lia.handle}`, rui.handle],
      });
      expect(cards.at(-1)?.meta).toMatchObject({
        debateSuggestion: { title: "Price", state: "pending", agentIds: [lia.id, rui.id] },
      });
      const card = await server.deps.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.workspaceId, ws), eq(schema.messages.channelId, general)));
      expect(card.map((m) => m.meta.debateSuggestion)).toContainEqual(
        expect.objectContaining({ title: "Price" }),
      );
      const debates = () =>
        server.deps.db.select().from(schema.debates).where(eq(schema.debates.workspaceId, ws));
      expect(await debates()).toEqual([]);

      // Opening at once: the debate opens, and the agents' turns run on the runtime.
      const opened = await call("open_debate", {
        title: "Deadline",
        goal: "Set it",
        agents: [rui.handle],
        open: true,
      });
      expect(opened.isError).toBe(false);
      await server.deps.runtime.settle();
      const [deadline] = await debates();
      expect(deadline).toMatchObject({ title: "Deadline", agentIds: [rui.id] });
      const turns = await server.deps.db
        .select()
        .from(schema.debatePosts)
        .where(and(eq(schema.debatePosts.debateId, deadline?.id ?? ""), eq(schema.debatePosts.kind, "turn")));
      expect(turns.map((p) => p.author.id)).toContain(rui.id);
      await server.deps.db.delete(schema.debates).where(eq(schema.debates.id, deadline?.id ?? ""));
      expect((await call("open_debate", { title: "x", goal: "y", agents: ["@ghost"] })).content).toBe(
        "No agent @ghost",
      );

      // a closed debate of #general, and one of a private channel without Beto
      const seedDebate = async (title: string, channelId: string | null) => {
        const id = newId("deb");
        await server.deps.db.insert(schema.debates).values({
          id,
          workspaceId: ws,
          title,
          goal: `Decide ${title}`,
          status: "done",
          channelId,
          agentIds: [lia.id],
          createdBy: { type: "person", id: ana.user.id },
        });
        await server.deps.db.insert(schema.debatePosts).values({
          id: newId("dp"),
          debateId: id,
          author: { type: "agent", id: lia.id },
          kind: "free",
          round: 0,
          body: `About ${title}`,
        });
        return id;
      };
      const open = await seedDebate("the color", general);
      const read = (await call("read_debate", { debateId: open })).content;
      expect(read).toContain("Decide the color");
      expect(read).toContain(`agent:${lia.id}: About the color`);
      const post = await call("post_in_debate", { debateId: open, body: "Late note" });
      expect(post.content).toBe("This debate is closed");
      const board = await seedChannel(server, ws, { name: "board", visibility: "private", members: [ana] });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: board, memberType: "agent", memberId: lia.id });
      const hidden = await seedDebate("the salaries", board);
      const out = await call("read_debate", { debateId: hidden });
      expect(out.isError).toBe(true);
      expect(out.content).toBe("Debate not found");
      expect(out.content).not.toContain("salaries");
      expect((await call("read_debate", { debateId: "deb_none" })).content).toBe("Debate not found");
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: the page cap holds on every write path, and NUL text is rejected at the input",
    async () => {
      const { workspaceId: ws, wiki, call } = await team();
      const full = await wiki.ana.createWikiPage(ws, {
        title: "Full page",
        body: `${"x".repeat(499_990)}UNIQUE0000`,
      });
      const dest = await wiki.ana.createWikiPage(ws, { title: "Link target", body: "short" });
      for (const [tool, input] of [
        ["update_wiki_page", { slug: full.slug, parent_version: 1, mode: "append", text: "small" }],
        ["link_to_wiki", { from: full.slug, to: dest.slug }],
        [
          "propose_wiki_edit",
          {
            slug: full.slug,
            parent_version: 1,
            edits: [{ old_str: "UNIQUE0000", new_str: "UNIQUE00000" }],
          },
        ],
      ] as const) {
        const out = await call(tool, input);
        expect(out).toMatchObject({ isError: true, content: "The page would pass 500000 characters" });
      }
      expect((await wiki.ana.getWikiPage(ws, full.slug)).body.length).toBe(500_000);
      expect((await wiki.ana.listWikiPageAnnotations(ws, full.slug)).proposals).toEqual([]);
      const nul = await call("add_wiki_page", { title: "Bad", body: "a\u0000b" });
      expect(nul.isError).toBe(true);
      expect(nul.content).toContain("Text with a NUL or a broken character");
      expect((await call("comment_issue", { number: 1, text: "x\u0000" })).content).toContain("NUL");
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: a restricted page's title doesn't leak through link warnings or a link",
    async () => {
      const { workspaceId: ws, wiki, lia, call, as, ana } = await team();
      const secret = await wiki.ana.createWikiPage(ws, { title: "Layoffs", body: "secret" });
      const { slug } = await wiki.ana.setWikiPageAccess(ws, secret.slug, {
        kind: "private",
        userIds: [],
        agentIds: [lia.id],
      });
      await call("add_wiki_page", { title: "Notes", body: "Start." });
      // asked by Beto, who can't read it: the warning is the same as for a title that doesn't exist
      const warned = await call("update_wiki_page", {
        slug: "notes",
        parent_version: 1,
        mode: "append",
        text: "[[Layoffs]] and [[Nothing here]]",
      });
      expect(warned.content).toContain("[[Layoffs]] does not match any page");
      expect(warned.content).toContain("[[Nothing here]] does not match any page");
      // asked by Ana, who reads it: no warning for it, but its title can't go onto a page everyone reads
      const forAna = await as(ana);
      const seen = await forAna.call("update_wiki_page", {
        slug: "notes",
        parent_version: 2,
        mode: "append",
        text: "[[Layoffs]]",
      });
      expect(seen.content).not.toContain("[[Layoffs]] does not");
      await forAna.call("add_wiki_page", { title: "Plain", body: "Open to all." });
      const link = await forAna.call("link_to_wiki", { from: "plain", to: slug });
      expect(link.isError).toBe(true);
      expect(link.content).toContain("Not everyone who reads");
      expect((await wiki.ana.getWikiPage(ws, "plain")).body).toBe("Open to all.");
      // the other way round is fine: everyone who reads the restricted page reads the open one
      expect((await forAna.call("link_to_wiki", { from: slug, to: "plain" })).content).toBe(
        'Linked "Layoffs" to "Plain".',
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "Drive: a file of another channel isn't shared into a conversation whose people may not see it",
    async () => {
      const { workspaceId: ws, ana, beto, lia, call, cards } = await team();
      const board = await seedChannel(server, ws, {
        name: "board",
        visibility: "private",
        members: [ana, beto],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: board, memberType: "agent", memberId: lia.id });
      const file = await api<FileDetail>(ana, ws, "POST", "/files", {
        title: "Board minutes",
        content: { kind: "document", markdown: "minutes" },
        channelId: board,
      });
      // Lia and Beto both see it, but #general is everyone's
      const out = await call("share_drive_file", { fileId: file.id });
      expect(out.isError).toBe(true);
      expect(out.content).toContain("belongs to another channel");
      expect(cards).toEqual([]);
      // a workspace file is shared
      const open = await api<FileDetail>(ana, ws, "POST", "/files", {
        title: "Handbook",
        content: { kind: "document", markdown: "rules" },
      });
      expect((await call("share_drive_file", { fileId: open.id })).content).toBe('Shared "Handbook" here.');
    },
    SERVER_TEST_MS,
  );

  test(
    "Routines: a routine of a channel the person asking can't read is neither listed nor changed for them",
    async () => {
      const { workspaceId: ws, ana, lia, call, as } = await team();
      const board = await seedChannel(server, ws, { name: "board", visibility: "private", members: [ana] });
      const id = newId("rtn");
      await server.deps.db.insert(schema.routines).values({
        id,
        workspaceId: ws,
        name: "Payroll digest",
        prompt: "Sum the payroll",
        agentId: lia.id,
        target: { kind: "channel", channelId: board },
        trigger: {
          kind: "schedule",
          rule: { freq: "daily", interval: 1, times: ["09:00"], timezone: "UTC" },
        },
        active: true,
        createdBy: ana.user.id,
      });
      expect((await call("list_routines", {})).content).toBe("You have no routines.");
      const change = await call("update_routine", { routineId: id, active: false });
      expect(change).toMatchObject({ isError: true, content: `Routine ${id} not found` });
      const [row] = await server.deps.db.select().from(schema.routines).where(eq(schema.routines.id, id));
      expect(row?.active).toBe(true);
      // from #general, everyone's channel, nobody acts on it: not Ana, its creator and the workspace's owner,
      // and not a run with no person (a routine's own run, whose requester is the routine's creator)
      for (const asker of [ana, null]) {
        const run = await as(asker);
        expect((await run.call("list_routines", {})).content).toBe("You have no routines.");
        expect((await run.call("update_routine", { routineId: id, active: false })).isError).toBe(true);
      }
      const [still] = await server.deps.db.select().from(schema.routines).where(eq(schema.routines.id, id));
      expect(still?.active).toBe(true);
      // in its own channel it shows, with Ana or with no person
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: board, memberType: "agent", memberId: lia.id });
      for (const asker of [ana, null]) {
        const run = await toolRun(server, { workspaceId: ws, agent: lia, channelId: board, asker });
        expect((await run.call("list_routines", {})).content).toContain("Payroll digest");
      }
      // a routine of a public channel is everyone's to know about
      const pub = await seedChannel(server, ws, { name: "news", members: [ana] });
      await server.deps.db.insert(schema.routines).values({
        id: newId("rtn"),
        workspaceId: ws,
        name: "News digest",
        prompt: "Sum the news",
        agentId: lia.id,
        target: { kind: "channel", channelId: pub },
        trigger: {
          kind: "schedule",
          rule: { freq: "daily", interval: 1, times: ["09:00"], timezone: "UTC" },
        },
        active: true,
        createdBy: ana.user.id,
      });
      const listed = (await call("list_routines", {})).content;
      expect(listed).toContain("News digest");
      expect(listed).not.toContain("Payroll digest");
    },
    SERVER_TEST_MS,
  );

  test(
    "Wiki: a proposal can't pass the page cap however its changes are accepted one by one",
    async () => {
      const { workspaceId: ws, wiki, call } = await team();
      const text = `${"x".repeat(499_990)}GROW-CUTCUT`;
      const page = await wiki.ana.createWikiPage(ws, { title: "Near the cap", body: text.slice(0, 500_000) });
      expect(page.slug).toBeTruthy();
      const body = (await wiki.ana.getWikiPage(ws, page.slug)).body;
      expect(body.length).toBe(500_000);
      // one change grows by 2 and another shrinks by 4: together they fit, the first alone doesn't
      const out = await call("propose_wiki_edit", {
        slug: page.slug,
        parent_version: 1,
        edits: [
          { old_str: "GROW", new_str: "GROW++" },
          { old_str: "CUTC", new_str: "" },
        ],
      });
      expect(out).toMatchObject({ isError: true, content: "The page would pass 500000 characters" });
      expect((await wiki.ana.listWikiPageAnnotations(ws, page.slug)).proposals).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "concurrent writes: a proposal is checked against the page as locked; a prompt change of a moved routine is rejected",
    async () => {
      const { workspaceId: ws, wiki, ana, lia, general, call } = await team();
      const { db } = server.deps;
      // the page is 499,997 characters when the agent reads it; another save takes it to 500,000 first
      const page = await wiki.ana.createWikiPage(ws, {
        title: "Almost full",
        body: `${"x".repeat(499_994)}END`,
      });
      const grown = racing(server, () =>
        db
          .update(schema.knowledgePages)
          .set({ body: `${"x".repeat(499_997)}END` })
          .where(eq(schema.knowledgePages.slug, page.slug)),
      );
      const proposal = await call(
        "propose_wiki_edit",
        { slug: page.slug, parent_version: 1, edits: [{ old_str: "END", new_str: "END!" }] },
        { deps: grown },
      );
      expect(proposal).toMatchObject({ isError: true });
      expect(proposal.content).toContain("would pass 500000 characters");
      expect((await wiki.ana.listWikiPageAnnotations(ws, page.slug)).proposals).toEqual([]);

      // a routine of #general moves to a private channel between the visibility check and the write
      const board = await seedChannel(server, ws, { name: "board", visibility: "private", members: [ana] });
      const id = newId("rtn");
      await db.insert(schema.routines).values({
        id,
        workspaceId: ws,
        name: "Digest",
        prompt: "old instructions",
        agentId: lia.id,
        target: { kind: "channel", channelId: general },
        trigger: {
          kind: "schedule",
          rule: { freq: "daily", interval: 1, times: ["09:00"], timezone: "UTC" },
        },
        active: true,
        createdBy: ana.user.id,
      });
      const moved = racing(server, () =>
        db
          .update(schema.routines)
          .set({ target: { kind: "channel", channelId: board } })
          .where(eq(schema.routines.id, id)),
      );
      const change = await call(
        "update_routine",
        { routineId: id, prompt: "new instructions" },
        { deps: moved },
      );
      expect(change).toMatchObject({
        isError: true,
        content: `Routine ${id} changed; list your routines again`,
      });
      const [row] = await db.select().from(schema.routines).where(eq(schema.routines.id, id));
      expect(row?.prompt).toBe("old instructions");
    },
    SERVER_TEST_MS,
  );

  test(
    "Calendar: a range that ends before it starts is an input error",
    async () => {
      const { call } = await team();
      const out = await call("list_events", { from: "2026-11-27T18:00:00Z", to: "2026-11-27T09:00:00Z" });
      expect(out).toMatchObject({ isError: true });
      expect(out.content).toContain("ends before it starts");
    },
    SERVER_TEST_MS,
  );
});
