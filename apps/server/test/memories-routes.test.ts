// The memory routes (routes/memories.ts) one by one: who may call each (a workspace member, who edits the agent,
// the store's owner, who decides a review, who writes in the channel), what of another workspace never answers,
// the size limits rejected before anything is written, two people deciding the same review at once, feedback on an
// answer and reminders.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Memory, MemoryReview, Message, Reminder } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { contentSha256, MEMORY_ITEM_MAX_BYTES, MEMORY_STORE_MAX_ITEMS } from "@vanr/engine/memory";
import { and, eq, sql } from "drizzle-orm";
import { createMemory, memoryPrompt, storeEntries } from "../src/agent-memory";
import { channelInWorkspace } from "../src/channels";
import { queueMemoryReview } from "../src/memory-reviews";
import { postMessage } from "../src/messages";
import {
  MEMORY_NOTE_MAX,
  MEMORY_REASON_MAX,
  REMINDER_HORIZON_MS,
  REMINDER_LIST_LIMIT,
  REMINDER_TEXT_MAX,
  STORE_LIST_LIMIT,
} from "../src/routes/memories";
import type { RunningServer } from "../src/server";
import { Browser, body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let clock = new Date("2026-11-14T12:00:00Z");
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => clock });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@memories.test`;

/** Ana owns the workspace; Beto is a member who owns the agent Bia; Caio is a plain member; Lia is Ana's agent. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Memories");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const agent = async (owner: Person, handle: string) => {
    const id = newId("agt");
    await server.deps.db.insert(schema.agents).values({
      id,
      workspaceId,
      name: handle,
      handle,
      model: "claude-haiku-5-5",
      ownerUserId: owner.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    });
    return id;
  };
  const lia = await agent(ana, "lia");
  const bia = await agent(beto, "bia");
  return { workspaceId, general, ana, beto, caio, lia, bia };
}
type Team = Awaited<ReturnType<typeof team>>;

const call = async (
  who: Person | Browser,
  workspaceId: string,
  method: string,
  path: string,
  data?: unknown,
) => {
  const browser = who instanceof Browser ? who : who.browser;
  const res = await browser.json(`/api/v1/workspaces/${workspaceId}${path}`, method, data);
  return { status: res.status, json: await body(res) };
};
const ok = async <T>(p: ReturnType<typeof call>, status = 200): Promise<T> => {
  const res = await p;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
};

/** A note in the agent's store, as `remember` writes it (the run comes with S6). */
async function noteOf(t: Team, agentId: string, text = "The client pays on the 10th") {
  const at = clock;
  return createMemory(
    server.deps.db,
    at,
    {
      workspaceId: t.workspaceId,
      agentId,
      scope: "agent",
      text,
      origin: { by: null, name: null, channel: null, at: at.toISOString() },
    },
    { author: { type: "agent", id: agentId, runId: null }, reason: "remember" },
  );
}
const countMemories = async (workspaceId: string) =>
  (await server.deps.db.select().from(schema.memories).where(eq(schema.memories.workspaceId, workspaceId)))
    .length;

/** Whether the person is in the channel (writing in a public channel joins it). */
const inChannel = async (channelId: string, who: Person) =>
  (
    await server.deps.db
      .select()
      .from(schema.channelMemberships)
      .where(
        and(
          eq(schema.channelMemberships.channelId, channelId),
          eq(schema.channelMemberships.memberId, who.user.id),
        ),
      )
  ).length > 0;

describe("who may call", () => {
  test(
    "every memory route answers 401 signed out and 404 outside the workspace, writing nothing",
    async () => {
      const t = await team();
      const mem = await noteOf(t, t.lia);
      const outsider = await signedIn(server, "Olga", email("olga"));
      const anonymous = new Browser(server.url);
      const routes: [string, string, unknown?][] = [
        ["GET", `/agents/${t.lia}/memories`],
        ["GET", "/memories/mine"],
        ["GET", "/memories/workspace"],
        ["POST", "/memories", { scope: "person", path: "x.md", text: "x" }],
        ["PATCH", `/memories/${mem.id}`, { text: "hacked" }],
        ["POST", `/memories/${mem.id}/revert`],
        ["GET", `/memories/${mem.id}/versions`],
        ["POST", `/memories/${mem.id}/versions/mv_x/restore`],
        ["GET", "/memory-reviews"],
        ["POST", "/memory-reviews/mrv_x/approve"],
        ["POST", "/memory-reviews/mrv_x/reject"],
        ["POST", "/messages/msg_x/feedback", { body: "no" }],
        [
          "POST",
          "/reminders",
          { channelId: t.general, text: "x", at: new Date(clock.getTime() + 60_000).toISOString() },
        ],
        ["GET", "/reminders"],
        ["DELETE", "/reminders/rem_x"],
      ];
      for (const [method, path, data] of routes) {
        expect([method, path, (await call(anonymous, t.workspaceId, method, path, data)).status]).toEqual([
          method,
          path,
          401,
        ]);
        expect([method, path, (await call(outsider, t.workspaceId, method, path, data)).status]).toEqual([
          method,
          path,
          404,
        ]);
      }
      expect(await countMemories(t.workspaceId)).toBe(1);
      const [row] = await server.deps.db.select().from(schema.memories).where(eq(schema.memories.id, mem.id));
      expect(row?.text).toBe("The client pays on the 10th");
    },
    SERVER_TEST_MS,
  );

  test(
    "an agent's store: any member reads it; an admin or the agent's owner edits it, a plain member doesn't",
    async () => {
      const t = await team();
      const liaNote = await noteOf(t, t.lia);
      const biaNote = await noteOf(t, t.bia, "Bia's note");
      // Caio reads both stores.
      const listed = await ok<{ memories: Memory[] }>(
        call(t.caio, t.workspaceId, "GET", `/agents/${t.bia}/memories`),
      );
      expect(listed.memories.map((m) => m.id)).toEqual([biaNote.id]);
      expect((await call(t.caio, t.workspaceId, "GET", `/memories/${liaNote.id}/versions`)).status).toBe(200);
      // Caio doesn't edit, revert or restore; Beto edits Bia's (he owns her) but not Lia's; Ana (owner) edits both.
      expect(
        (await call(t.caio, t.workspaceId, "PATCH", `/memories/${biaNote.id}`, { pinned: true })).status,
      ).toBe(403);
      expect((await call(t.caio, t.workspaceId, "POST", `/memories/${biaNote.id}/revert`)).status).toBe(403);
      expect(
        (await call(t.beto, t.workspaceId, "PATCH", `/memories/${liaNote.id}`, { pinned: true })).status,
      ).toBe(403);
      const edited = await ok<Memory>(
        call(t.beto, t.workspaceId, "PATCH", `/memories/${biaNote.id}`, { text: "Bia v2" }),
      );
      expect(edited).toMatchObject({ text: "Bia v2", editorUserId: t.beto.user.id, verified: true });
      // Revert brings back the text before the person's edit, as a new version.
      const reverted = await ok<Memory>(
        call(t.beto, t.workspaceId, "POST", `/memories/${biaNote.id}/revert`),
      );
      expect(reverted.text).toBe("Bia's note");
      expect(
        (await call(t.ana, t.workspaceId, "POST", `/memories/${liaNote.id}/revert`)).json.error.code,
      ).toBe("memory.nothing_to_revert");
      expect(
        (await call(t.ana, t.workspaceId, "PATCH", `/memories/${liaNote.id}`, { pinned: true })).status,
      ).toBe(200);
    },
    SERVER_TEST_MS,
  );

  test(
    "another workspace's agent and memory don't answer, by the id in the path",
    async () => {
      const t = await team();
      const other = await team();
      const theirs = await noteOf(other, other.lia, "their secret");
      expect((await call(t.ana, t.workspaceId, "GET", `/agents/${other.lia}/memories`)).status).toBe(404);
      expect((await call(t.ana, t.workspaceId, "GET", `/memories/${theirs.id}/versions`)).status).toBe(404);
      expect(
        (await call(t.ana, t.workspaceId, "PATCH", `/memories/${theirs.id}`, { text: "x" })).status,
      ).toBe(404);
      expect((await call(t.ana, t.workspaceId, "POST", `/memories/${theirs.id}/revert`)).status).toBe(404);
      const [row] = await server.deps.db
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.id, theirs.id));
      expect(row?.text).toBe("their secret");
    },
    SERVER_TEST_MS,
  );
});

describe("size limits, rejected before anything is written", () => {
  test(
    "editing a file preserves indentation and trailing newlines; short notes still trim whitespace",
    async () => {
      const t = await team();
      const file = await ok<Memory>(
        call(t.ana, t.workspaceId, "POST", "/memories", {
          scope: "person",
          path: "code.md",
          text: "before",
        }),
        201,
      );
      const text = "    after\n    code\n\n";
      const patched = await ok<Memory>(
        call(t.ana, t.workspaceId, "PATCH", `/memories/${file.id}`, {
          text,
          expectedSha256: file.sha256,
        }),
      );
      expect(patched).toMatchObject({ text, sha256: contentSha256(text) });
      const stored = await ok<{ memories: Memory[] }>(call(t.ana, t.workspaceId, "GET", "/memories/mine"));
      expect(stored.memories.find((m) => m.id === file.id)?.text).toBe(text);
      // One person's store is never kept by a browser or proxy cache.
      const mine = await t.ana.browser.fetch(`/api/v1/workspaces/${t.workspaceId}/memories/mine`);
      expect(mine.headers.get("cache-control")).toBe("no-store");
      const note = await noteOf(t, t.lia);
      expect(
        (
          await ok<Memory>(
            call(t.ana, t.workspaceId, "PATCH", `/memories/${note.id}`, {
              text: "  note\n",
            }),
          )
        ).text,
      ).toBe("note");
    },
    SERVER_TEST_MS,
  );

  test(
    "a store file, a short note, a reason: one past the limit is a 400 and nothing changes",
    async () => {
      const t = await team();
      const before = await countMemories(t.workspaceId);
      const file = (text: string) =>
        call(t.ana, t.workspaceId, "POST", "/memories", { scope: "person", path: `f${++n}.md`, text });
      expect((await file("x".repeat(MEMORY_ITEM_MAX_BYTES + 1))).status).toBe(400);
      // Within the characters but over the bytes: the store's own check.
      expect((await file("é".repeat(MEMORY_ITEM_MAX_BYTES / 2 + 1))).status).toBe(413);
      expect(await countMemories(t.workspaceId)).toBe(before);
      expect((await file("x".repeat(MEMORY_ITEM_MAX_BYTES))).status).toBe(201);

      const note = await noteOf(t, t.lia);
      const patch = (data: Record<string, unknown>) =>
        call(t.ana, t.workspaceId, "PATCH", `/memories/${note.id}`, data);
      expect((await patch({ text: "y".repeat(MEMORY_NOTE_MAX + 1) })).status).toBe(400);
      expect((await patch({ pinned: true, reason: "r".repeat(MEMORY_REASON_MAX + 1) })).status).toBe(400);
      const [row] = await server.deps.db
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.id, note.id));
      expect(row).toMatchObject({ text: note.text, pinned: false });
      expect((await patch({ text: "y".repeat(MEMORY_NOTE_MAX) })).status).toBe(200);
      expect((await patch({ reason: "nothing else" })).status).toBe(400);
    },
    SERVER_TEST_MS,
  );
});

describe("the review queue", () => {
  const reviewOf = (t: Team, agentId: string) =>
    queueMemoryReview(server.deps, {
      workspaceId: t.workspaceId,
      agentId,
      runId: null,
      scope: "agent",
      ownerUserId: null,
      op: "create",
      memoryId: null,
      path: null,
      newPath: null,
      text: `supplier pix: ${++n}`,
      kind: "fact",
      about: null,
      replaces: null,
      reasons: [{ flag: "A", source: "mail_read inbox/1" }],
      origin: {
        at: clock.toISOString(),
        by: null,
        channel: null,
        name: null,
        untrusted: ["mail_read inbox/1"],
      },
      tool: "remember",
      baseSha256: null,
    });

  test(
    "only who edits the agent sees and decides; a plain member gets 403; a long note is a 400",
    async () => {
      const t = await team();
      const review = await reviewOf(t, t.lia);
      const list = (who: Person) =>
        ok<{ reviews: MemoryReview[] }>(call(who, t.workspaceId, "GET", `/memory-reviews?agentId=${t.lia}`));
      expect((await list(t.ana)).reviews.map((r) => r.id)).toEqual([review.id]);
      expect((await list(t.caio)).reviews).toEqual([]);
      expect((await call(t.caio, t.workspaceId, "POST", `/memory-reviews/${review.id}/approve`)).status).toBe(
        403,
      );
      expect((await call(t.caio, t.workspaceId, "POST", `/memory-reviews/${review.id}/reject`)).status).toBe(
        403,
      );
      const reject = (note: string) =>
        call(t.ana, t.workspaceId, "POST", `/memory-reviews/${review.id}/reject`, { note });
      expect((await reject("n".repeat(MEMORY_REASON_MAX + 1))).status).toBe(400);
      const rejected = await ok<MemoryReview>(reject("a scam"));
      expect(rejected).toMatchObject({ status: "rejected", note: "a scam", deciderUserId: t.ana.user.id });
      expect(
        (await call(t.ana, t.workspaceId, "POST", `/memory-reviews/${review.id}/approve`)).json.error.code,
      ).toBe("memory_review.decided");
      // Beto owns Bia: he decides hers.
      const bias = await reviewOf(t, t.bia);
      const approved = await ok<MemoryReview>(
        call(t.beto, t.workspaceId, "POST", `/memory-reviews/${bias.id}/approve`),
      );
      expect(approved).toMatchObject({ status: "approved", resultMemoryId: expect.any(String) });
    },
    SERVER_TEST_MS,
  );

  test(
    "two people approving and rejecting the same review at once: one decision, applied at most once",
    async () => {
      const t = await team();
      const review = await reviewOf(t, t.bia);
      const decide = (who: Person, action: "approve" | "reject") =>
        call(who, t.workspaceId, "POST", `/memory-reviews/${review.id}/${action}`);
      const results = await Promise.all([
        decide(t.ana, "approve"),
        decide(t.beto, "approve"),
        decide(t.ana, "reject"),
        decide(t.beto, "reject"),
        decide(t.ana, "approve"),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
      const [row] = await server.deps.db
        .select()
        .from(schema.memoryReviews)
        .where(eq(schema.memoryReviews.id, review.id));
      const saved = (
        await server.deps.db.select().from(schema.memories).where(eq(schema.memories.agentId, t.bia))
      ).filter((m) => m.text === review.text);
      expect(saved).toHaveLength(row?.status === "approved" ? 1 : 0);
    },
    SERVER_TEST_MS,
  );
});

describe("feedback on an answer", () => {
  async function answer(t: Team, channelId: string) {
    const channel = await channelInWorkspace(server.deps.db, t.workspaceId, channelId);
    if (!channel) throw new Error("no channel");
    const { message } = await postMessage(server.deps, {
      workspaceId: t.workspaceId,
      channel,
      author: { type: "agent", id: t.lia },
      body: "The refund takes 90 days.",
      clientId: null,
    });
    return message;
  }

  test(
    "a lesson from a private channel stays there: shown to its readers and used in its runs only",
    async () => {
      const t = await team();
      const secret = await seedChannel(server, t.workspaceId, {
        name: `secret${n}`,
        visibility: "private",
        members: [t.ana],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: secret, memberType: "agent", memberId: t.lia });
      const inSecret = await answer(t, secret);
      await ok(
        call(t.ana, t.workspaceId, "POST", `/messages/${inSecret.id}/feedback`, { body: "Say 30 days" }),
        201,
      );
      const inGeneral = await answer(t, t.general);
      await ok(
        call(t.caio, t.workspaceId, "POST", `/messages/${inGeneral.id}/feedback`, { body: "Be brief" }),
        201,
      );
      const lessons = await server.deps.db
        .select()
        .from(schema.memories)
        .where(and(eq(schema.memories.agentId, t.lia), eq(schema.memories.source, "feedback")));
      const secretLesson = lessons.find((m) => m.text === "Say 30 days");
      const openLesson = lessons.find((m) => m.text === "Be brief");
      expect([secretLesson?.channelId, openLesson?.channelId]).toEqual([secret, null]);
      // Shown: Ana reads the channel and sees both; Beto doesn't, so only the open one, and the other is a 404.
      const texts = async (who: Person) =>
        (
          await ok<{ memories: Memory[] }>(call(who, t.workspaceId, "GET", `/agents/${t.lia}/memories`))
        ).memories
          .map((m) => m.text)
          .sort();
      expect(await texts(t.ana)).toEqual(["Be brief", "Say 30 days"]);
      expect(await texts(t.beto)).toEqual(["Be brief"]);
      const versions = (who: Person) =>
        call(who, t.workspaceId, "GET", `/memories/${secretLesson?.id}/versions`);
      expect([(await versions(t.beto)).status, (await versions(t.ana)).status]).toEqual([404, 200]);
      // Used: the agent's prompt in #general leaves it out; in the private channel it is there.
      const prompt = (channelId: string) =>
        memoryPrompt(server.deps.db, clock, {
          workspaceId: t.workspaceId,
          agentId: t.lia,
          personId: null,
          channelId,
        });
      expect(await prompt(t.general)).not.toContain("Say 30 days");
      expect(await prompt(t.general)).toContain("Be brief");
      expect(await prompt(secret)).toContain("Say 30 days");
      // Nor does the memory tool's store reach it from another channel.
      const store = (seenFrom: string) =>
        ({ scope: "agent", workspaceId: t.workspaceId, agentId: t.lia, seenFrom }) as const;
      const listed = async (seenFrom: string) =>
        (await storeEntries(server.deps.db, store(seenFrom))).some((e) => e.id === secretLesson?.id);
      expect([await listed(t.general), await listed(secret)]).toEqual([false, true]);
    },
    SERVER_TEST_MS,
  );

  /** A run of Lia's in a private channel only Ana reads, with Lia in it; its feedback lesson is confined there. */
  async function confinedLesson(t: Team) {
    const secret = await seedChannel(server, t.workspaceId, {
      name: `vault${n}`,
      visibility: "private",
      members: [t.ana],
    });
    await server.deps.db
      .insert(schema.channelMemberships)
      .values({ channelId: secret, memberType: "agent", memberId: t.lia });
    const reply = await answer(t, secret);
    await ok(
      call(t.ana, t.workspaceId, "POST", `/messages/${reply.id}/feedback`, { body: "Acme pays in 30 days" }),
      201,
    );
    const [lesson] = await server.deps.db
      .select()
      .from(schema.memories)
      .where(and(eq(schema.memories.agentId, t.lia), eq(schema.memories.source, "feedback")));
    if (!lesson) throw new Error("no lesson");
    const runId = newId("run");
    await server.deps.db.insert(schema.runs).values({
      id: runId,
      workspaceId: t.workspaceId,
      agentId: t.lia,
      status: "done",
      model: "claude-haiku-5-5",
      channelId: secret,
    });
    /** What `remember` queues from that run after it read outside content, replacing the lesson. */
    const queue = () =>
      queueMemoryReview(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia,
        runId,
        scope: "agent",
        ownerUserId: null,
        op: "create",
        memoryId: null,
        path: null,
        newPath: null,
        text: "Acme pays in 30 days, by pix",
        kind: "lesson",
        about: null,
        replaces: lesson.id,
        reasons: [{ flag: "A", source: "web_fetch acme.example" }],
        origin: { at: clock.toISOString(), by: null, channel: `#vault${n}`, name: null, runId },
        tool: "remember",
        baseSha256: null,
      });
    return { secret, lesson, queue };
  }

  test(
    "approving a review that replaces a confined lesson keeps the replacement confined",
    async () => {
      const t = await team();
      const { secret, queue } = await confinedLesson(t);
      const review = await queue();
      await ok(call(t.ana, t.workspaceId, "POST", `/memory-reviews/${review.id}/approve`));
      const [created] = await server.deps.db
        .select()
        .from(schema.memories)
        .where(
          and(eq(schema.memories.agentId, t.lia), eq(schema.memories.text, "Acme pays in 30 days, by pix")),
        );
      expect(created?.channelId).toBe(secret);
      const seen = await ok<{ memories: Memory[] }>(
        call(t.beto, t.workspaceId, "GET", `/agents/${t.lia}/memories`),
      );
      expect(seen.memories.some((m) => m.text.startsWith("Acme pays"))).toBe(false);
      const prompt = await memoryPrompt(server.deps.db, clock, {
        workspaceId: t.workspaceId,
        agentId: t.lia,
        personId: null,
        channelId: t.general,
      });
      expect(prompt).not.toContain("Acme pays");
    },
    SERVER_TEST_MS,
  );

  test(
    "a review queued from a private channel is listed and decided only by deciders who read that channel",
    async () => {
      const t = await team();
      const dora = await memberOf(server, t.workspaceId, "Dora", email("dora"), "admin");
      const { queue } = await confinedLesson(t);
      const review = await queue();
      const listed = async (who: Person) =>
        (
          await ok<{ reviews: MemoryReview[] }>(call(who, t.workspaceId, "GET", "/memory-reviews"))
        ).reviews.map((r) => r.id);
      // Dora manages agents but isn't in the channel: the review isn't hers to see, its text included.
      expect(await listed(dora)).toEqual([]);
      expect((await call(dora, t.workspaceId, "POST", `/memory-reviews/${review.id}/approve`)).status).toBe(
        404,
      );
      expect(await listed(t.ana)).toEqual([review.id]);
    },
    SERVER_TEST_MS,
  );

  test.each(["insert", "thread update"] as const)(
    "feedback keeps its lesson exactly when the message was persisted despite a failing %s",
    async (failure) => {
      const t = await team();
      const reply = await answer(t, t.general);
      // The insert fails on the message itself; the thread update after it, on the thread's state (the root's
      // reply count goes in with the reply, so it fails with the insert).
      const condition = failure === "insert" ? sql`NEW.thread_id IS NOT NULL` : sql`TRUE`;
      const table = sql.raw(failure === "insert" ? "messages" : "threads");
      await server.deps.db.execute(sql`CREATE FUNCTION fail_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} THEN RAISE EXCEPTION 'feedback write failed'; END IF; RETURN NEW; END $$`);
      await server.deps.db.execute(sql`CREATE TRIGGER fail_feedback BEFORE ${sql.raw(failure === "insert" ? "INSERT" : "UPDATE")}
        ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_feedback()`);
      try {
        const res = await call(t.caio, t.workspaceId, "POST", `/messages/${reply.id}/feedback`, {
          body: "It's 7 days.",
        });
        const posts = await server.deps.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.threadId, reply.id));
        const lessons = await server.deps.db
          .select()
          .from(schema.memories)
          .where(eq(schema.memories.agentId, t.lia));
        expect(res.status).toBe(failure === "insert" ? 500 : 201);
        expect(posts).toHaveLength(failure === "insert" ? 0 : 1);
        expect(lessons).toHaveLength(posts.length);
        if (failure === "thread update") {
          expect(res.json).toMatchObject({
            id: posts[0]?.id,
            body: "It's 7 days.",
            memories: [{ id: lessons[0]?.id }],
          });
          expect(lessons[0]).toMatchObject({
            kind: "lesson",
            source: "feedback",
            originMessageId: posts[0]?.id,
          });
        }
      } finally {
        await server.deps.db.execute(sql`DROP TRIGGER fail_feedback ON ${table}`);
        await server.deps.db.execute(sql`DROP FUNCTION fail_feedback()`);
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "it goes into the answer's thread and becomes a lesson of the agent, with its origin",
    async () => {
      const t = await team();
      const reply = await answer(t, t.general);
      const posted = await ok<Message>(
        call(t.caio, t.workspaceId, "POST", `/messages/${reply.id}/feedback`, { body: "It's 7 days." }),
        201,
      );
      expect(posted).toMatchObject({
        body: "It's 7 days.",
        threadId: reply.id,
        author: { type: "person", id: t.caio.user.id },
        meta: { feedback: { messageId: reply.id, agentId: t.lia } },
      });
      const [lesson] = await ok<{ memories: Memory[] }>(
        call(t.ana, t.workspaceId, "GET", `/agents/${t.lia}/memories`),
      ).then((r) => r.memories);
      expect(lesson).toMatchObject({
        text: "It's 7 days.",
        kind: "lesson",
        source: "feedback",
        verified: true,
        origin: { by: { type: "person", id: t.caio.user.id }, channel: "#general" },
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "rejected: a person's message, a private channel the person isn't in, another workspace's message, a long body",
    async () => {
      const t = await team();
      const secret = await seedChannel(server, t.workspaceId, {
        name: "secret",
        visibility: "private",
        members: [t.ana],
      });
      const hidden = await answer(t, secret);
      const general = await channelInWorkspace(server.deps.db, t.workspaceId, t.general);
      if (!general) throw new Error("no channel");
      const { message: human } = await postMessage(server.deps, {
        workspaceId: t.workspaceId,
        channel: general,
        author: { type: "person", id: t.ana.user.id },
        body: "hi",
        clientId: null,
      });
      const other = await team();
      const theirs = await answer(other, other.general);
      const reply = await answer(t, t.general);
      const feedback = (id: string, text = "wrong") =>
        call(t.caio, t.workspaceId, "POST", `/messages/${id}/feedback`, { body: text });
      expect((await feedback(human.id)).status).toBe(400);
      expect((await feedback(hidden.id)).status).toBe(404);
      expect((await feedback(theirs.id)).status).toBe(404);
      expect((await feedback(reply.id, "z".repeat(MEMORY_NOTE_MAX + 1))).status).toBe(400);
      expect(await countMemories(t.workspaceId)).toBe(0);
      expect(await countMemories(other.workspaceId)).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "with the agent's store full the answer is a 409 and nothing shows: no message, no lesson, no join",
    async () => {
      const t = await team();
      const open = await seedChannel(server, t.workspaceId, { name: "open", members: [t.ana] });
      const reply = await answer(t, open);
      const origin = { by: null, name: null, channel: null, at: clock.toISOString() };
      for (let i = 0; i < MEMORY_STORE_MAX_ITEMS; i += 1000)
        await server.deps.db.insert(schema.memories).values(
          Array.from({ length: Math.min(1000, MEMORY_STORE_MAX_ITEMS - i) }, (_, k) => ({
            id: `mem_fb${n}_${i + k}`,
            workspaceId: t.workspaceId,
            agentId: t.lia,
            scope: "agent" as const,
            text: "full",
            origin,
            createdAt: clock,
            updatedAt: clock,
          })),
        );
      for (let i = 0; i < 2; i++) {
        const res = await call(t.caio, t.workspaceId, "POST", `/messages/${reply.id}/feedback`, {
          body: "It's 7 days.",
        });
        expect([res.status, res.json.error.code]).toEqual([409, "memory.store_full"]);
      }
      const bodies = (
        await server.deps.db.select().from(schema.messages).where(eq(schema.messages.channelId, open))
      ).map((m) => m.body);
      expect(bodies).toEqual(["The refund takes 90 days."]);
      expect(await countMemories(t.workspaceId)).toBe(MEMORY_STORE_MAX_ITEMS);
      expect(await inChannel(open, t.caio)).toBe(false);
    },
    SERVER_TEST_MS * 2,
  );
});

describe("reminders", () => {
  const inMinutes = (m: number) => new Date(clock.getTime() + m * 60_000).toISOString();

  test(
    "a person sets one in a channel they write in; the time is in the future and within a year",
    async () => {
      const t = await team();
      const create = (data: Record<string, unknown>) =>
        call(t.caio, t.workspaceId, "POST", "/reminders", data);
      const created = await ok<Reminder>(
        create({ channelId: t.general, text: "Call the client", at: inMinutes(30) }),
        201,
      );
      expect(created).toMatchObject({
        channelId: t.general,
        status: "scheduled",
        createdBy: { type: "person", id: t.caio.user.id },
        agentId: null,
      });
      expect((await create({ channelId: t.general, text: "past", at: inMinutes(0) })).status).toBe(400);
      const horizon = clock.getTime() + REMINDER_HORIZON_MS;
      expect(
        (await create({ channelId: t.general, text: "far", at: new Date(horizon + 1000).toISOString() }))
          .status,
      ).toBe(400);
      expect(
        (await create({ channelId: t.general, text: "edge", at: new Date(horizon).toISOString() })).status,
      ).toBe(201);
      expect(
        (await create({ channelId: t.general, text: "r".repeat(REMINDER_TEXT_MAX + 1), at: inMinutes(5) }))
          .status,
      ).toBe(400);
      const secret = await seedChannel(server, t.workspaceId, {
        name: "secret",
        visibility: "private",
        members: [t.ana],
      });
      expect((await create({ channelId: secret, text: "x", at: inMinutes(5) })).status).toBe(404);
      const other = await team();
      expect(
        (await create({ channelId: t.general, agentId: other.lia, text: "x", at: inMinutes(5) })).status,
      ).toBe(404);
      expect((await create({ channelId: other.general, text: "x", at: inMinutes(5) })).status).toBe(404);
      const rows = await server.deps.db
        .select()
        .from(schema.reminders)
        .where(eq(schema.reminders.workspaceId, t.workspaceId));
      expect(rows.map((r) => r.text).sort()).toEqual(["Call the client", "edge"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a rejected reminder doesn't join the person to the public channel; an accepted one does",
    async () => {
      const t = await team();
      const open = await seedChannel(server, t.workspaceId, { name: "open", members: [t.ana] });
      const create = (data: Record<string, unknown>) =>
        call(t.caio, t.workspaceId, "POST", "/reminders", data);
      expect((await create({ channelId: open, text: "past", at: inMinutes(0) })).status).toBe(400);
      expect(
        (await create({ channelId: open, threadId: "msg_none", text: "x", at: inMinutes(5) })).status,
      ).toBe(400);
      expect(
        (await create({ channelId: open, agentId: "agt_none", text: "x", at: inMinutes(5) })).status,
      ).toBe(404);
      expect(await inChannel(open, t.caio)).toBe(false);
      expect((await create({ channelId: open, text: "ok", at: inMinutes(5) })).status).toBe(201);
      expect(await inChannel(open, t.caio)).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test(
    "the list shows the person's own and the agents' in channels they read; only the creator cancels a person's",
    async () => {
      const t = await team();
      const mine = await ok<Reminder>(
        call(t.caio, t.workspaceId, "POST", "/reminders", {
          channelId: t.general,
          text: "mine",
          at: inMinutes(10),
        }),
        201,
      );
      const secret = await seedChannel(server, t.workspaceId, {
        name: "secret",
        visibility: "private",
        members: [t.ana],
      });
      const byAgent = (channelId: string, text: string) => ({
        id: newId("rem"),
        workspaceId: t.workspaceId,
        agentId: t.lia,
        channelId,
        threadId: null,
        text,
        at: new Date(inMinutes(20)),
        createdByType: "agent" as const,
        createdById: t.lia,
      });
      const open = byAgent(t.general, "agent in general");
      const hidden = byAgent(secret, "agent in secret");
      await server.deps.db.insert(schema.reminders).values([open, hidden]);
      const list = async (who: Person) =>
        (await ok<{ reminders: Reminder[] }>(call(who, t.workspaceId, "GET", "/reminders"))).reminders.map(
          (r) => r.text,
        );
      expect(await list(t.caio)).toEqual(["mine", "agent in general"]);
      expect(await list(t.ana)).toEqual(["agent in general", "agent in secret"]);

      expect((await call(t.ana, t.workspaceId, "DELETE", `/reminders/${mine.id}`)).status).toBe(403);
      expect((await call(t.caio, t.workspaceId, "DELETE", `/reminders/${hidden.id}`)).status).toBe(404);
      const canceled = await ok<Reminder>(call(t.caio, t.workspaceId, "DELETE", `/reminders/${mine.id}`));
      expect(canceled.status).toBe("canceled");
      expect(
        (await ok<Reminder>(call(t.caio, t.workspaceId, "DELETE", `/reminders/${open.id}`))).status,
      ).toBe("canceled");
      // Canceling again changes nothing.
      expect(
        (await ok<Reminder>(call(t.caio, t.workspaceId, "DELETE", `/reminders/${mine.id}`))).status,
      ).toBe("canceled");
      const other = await team();
      expect((await call(other.ana, other.workspaceId, "DELETE", `/reminders/${hidden.id}`)).status).toBe(
        404,
      );
      clock = new Date(clock.getTime() + 60_000);
    },
    SERVER_TEST_MS,
  );
});

describe("list limits", () => {
  test(
    "a store lists at most its page and the reminders list at most theirs",
    async () => {
      const t = await team();
      const at = clock;
      const origin = { by: null, name: null, channel: null, at: at.toISOString() };
      await server.deps.db.insert(schema.memories).values(
        Array.from({ length: STORE_LIST_LIMIT + 1 }, (_, i) => ({
          id: `mem_list${n}_${i}`,
          workspaceId: t.workspaceId,
          scope: "person" as const,
          ownerUserId: t.caio.user.id,
          path: `notes/${i}.md`,
          text: "x",
          origin,
          createdAt: at,
          updatedAt: at,
        })),
      );
      const mine = await ok<{ memories: Memory[] }>(call(t.caio, t.workspaceId, "GET", "/memories/mine"));
      expect(mine.memories).toHaveLength(STORE_LIST_LIMIT);
      await server.deps.db.insert(schema.reminders).values(
        Array.from({ length: REMINDER_LIST_LIMIT + 1 }, (_, i) => ({
          id: `rem_list${n}_${i}`,
          workspaceId: t.workspaceId,
          agentId: null,
          channelId: t.general,
          threadId: null,
          text: `r${i}`,
          at: new Date(clock.getTime() + (i + 1) * 60_000),
          createdByType: "person" as const,
          createdById: t.caio.user.id,
        })),
      );
      const listed = await ok<{ reminders: Reminder[] }>(call(t.caio, t.workspaceId, "GET", "/reminders"));
      expect(listed.reminders).toHaveLength(REMINDER_LIST_LIMIT);
      expect(listed.reminders[0]?.text).toBe("r0");
    },
    SERVER_TEST_MS,
  );
});
