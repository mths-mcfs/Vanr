// Posting and reading messages (messages.ts): the safe resend by clientId, mentions, quotes, thread replies,
// the page cursor, what the hub tells and the search index entry each post writes. The chat route that calls
// `postMessage` comes with S6; here the tests call it the way that route does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { hydrate, listMessages, postMessage } from "../src/messages";
import type { RealtimeEvent } from "../src/realtime/hub";
import type { RunningServer } from "../src/server";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@messages.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  return { workspaceId, general, ana, beto, caio };
}

async function seedAgent(workspaceId: string, owner: Person, handle: string) {
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
}

async function post(
  workspaceId: string,
  channelId: string,
  author: { type: "person" | "agent"; id: string },
  text: string,
  opts: { clientId?: string; threadId?: string; replyTo?: string } = {},
) {
  const channel = await channelInWorkspace(server.deps.db, workspaceId, channelId);
  if (!channel) throw new Error("no channel");
  return postMessage(server.deps, {
    workspaceId,
    channel,
    author,
    body: text,
    clientId: opts.clientId ?? null,
    threadId: opts.threadId ?? null,
    replyTo: opts.replyTo ?? null,
  });
}
const person = (p: Person) => ({ type: "person" as const, id: p.user.id });
const status = (err: unknown) => (err instanceof Error && "status" in err ? err.status : err);

describe("posting", () => {
  test(
    "the same clientId returns the same message, also when N sends arrive at once",
    async () => {
      const { workspaceId, general, ana } = await team();
      const first = await post(workspaceId, general, person(ana), "hello", { clientId: "c-1" });
      const again = await post(workspaceId, general, person(ana), "hello", { clientId: "c-1" });
      expect(first.created).toBe(true);
      expect(again).toMatchObject({ created: false, message: { id: first.message.id } });

      const burst = await Promise.all(
        Array.from({ length: 8 }, () =>
          post(workspaceId, general, person(ana), "burst", { clientId: "c-2" }),
        ),
      );
      expect(new Set(burst.map((r) => r.message.id)).size).toBe(1);
      expect(burst.filter((r) => r.created)).toHaveLength(1);
      const rows = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.clientId, "c-2"));
      expect(rows).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "@handles become mentions of the workspace's agents and members, never of the author or of an archived agent",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const lia = await seedAgent(workspaceId, ana, `lia${n}`);
      const old = await seedAgent(workspaceId, ana, `old${n}`);
      await server.deps.db
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, old));
      const [handles] = await server.deps.db
        .select({ handle: schema.members.handle })
        .from(schema.members)
        .where(eq(schema.members.userId, beto.user.id));
      const [own] = await server.deps.db
        .select({ handle: schema.members.handle })
        .from(schema.members)
        .where(eq(schema.members.userId, ana.user.id));
      const { message } = await post(
        workspaceId,
        general,
        person(ana),
        `hi @lia${n} @old${n} @${handles?.handle} @${own?.handle} @nobody`,
      );
      expect(message.agentMentionIds).toEqual([lia]);
      const [row] = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, message.id));
      expect(row?.mentionedUserIds).toEqual([beto.user.id]);

      const fromAgent = await post(workspaceId, general, { type: "agent", id: lia }, `I am @lia${n}`);
      expect(fromAgent.message.agentMentionIds).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a quote builds replyTo on the server; a quote or a thread of another channel is refused",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const sales = await seedChannel(server, workspaceId, { name: "sales", members: [ana, beto] });
      const root = await post(workspaceId, general, person(ana), "Sales plan");
      const quote = await post(workspaceId, general, person(beto), "agreed", { replyTo: root.message.id });
      expect(quote.message.meta.replyTo).toEqual({
        messageId: root.message.id,
        threadId: null,
        author: { type: "person", id: ana.user.id },
        authorName: "Ana",
        excerpt: "Sales plan",
      });
      const long = await post(workspaceId, general, person(ana), "x".repeat(300));
      const cut = await post(workspaceId, general, person(beto), "long one", { replyTo: long.message.id });
      expect(cut.message.meta.replyTo?.excerpt).toBe(`${"x".repeat(139)}…`);

      expect(
        status(
          await post(workspaceId, sales, person(beto), "q", { replyTo: root.message.id }).catch((e) => e),
        ),
      ).toBe(400);
      expect(
        status(
          await post(workspaceId, sales, person(beto), "t", { threadId: root.message.id }).catch((e) => e),
        ),
      ).toBe(400);
      const reply = await post(workspaceId, general, person(beto), "in the thread", {
        threadId: root.message.id,
      });
      expect(
        status(
          await post(workspaceId, general, person(ana), "t", { threadId: reply.message.id }).catch((e) => e),
        ),
      ).toBe(400);
    },
    SERVER_TEST_MS,
  );

  test(
    "thread replies count on the root, N at once included, and stay out of the channel's list",
    async () => {
      const { workspaceId, general, ana, beto, caio } = await team();
      const root = await post(workspaceId, general, person(ana), "root");
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          post(workspaceId, general, person(i % 2 ? beto : caio), `reply ${i}`, {
            threadId: root.message.id,
          }),
        ),
      );
      const top = await listMessages(server.deps.db, { channelId: general, limit: 50 });
      expect(top.map((m) => m.id)).toEqual([root.message.id]);
      expect(top[0]?.replyCount).toBe(10);
      const inThread = await listMessages(server.deps.db, {
        channelId: general,
        threadId: root.message.id,
        limit: 50,
      });
      expect(inThread).toHaveLength(10);
      const [state] = await server.deps.db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, root.message.id));
      expect(state?.state).toBe("open");
      const follows = await server.deps.db
        .select({ userId: schema.threadSubscriptions.userId })
        .from(schema.threadSubscriptions)
        .where(eq(schema.threadSubscriptions.threadId, root.message.id));
      expect(follows.map((f) => f.userId).sort()).toEqual([ana.user.id, beto.user.id, caio.user.id].sort());
    },
    SERVER_TEST_MS,
  );

  test(
    "the list pages with `before`, oldest first; an unknown cursor is refused",
    async () => {
      const { workspaceId, general, ana } = await team();
      for (let i = 1; i <= 5; i++) await post(workspaceId, general, person(ana), `m${i}`);
      const all = await listMessages(server.deps.db, { channelId: general, limit: 50 });
      expect(all.map((m) => m.body)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
      const older = await listMessages(server.deps.db, { channelId: general, before: all[3]?.id, limit: 2 });
      expect(older.map((m) => m.body)).toEqual(["m2", "m3"]);
      expect(
        status(
          await listMessages(server.deps.db, { channelId: general, before: "msg_nope", limit: 2 }).catch(
            (e) => e,
          ),
        ),
      ).toBe(400);
    },
    SERVER_TEST_MS,
  );
});

describe("what a post tells and indexes", () => {
  test(
    "message.posted to the channel, channel.unread to the other people in it; a reply tells the thread instead",
    async () => {
      const { workspaceId, general, ana, beto, caio } = await team();
      const events: { target: string; event: RealtimeEvent }[] = [];
      const off = server.deps.hub.onPublish((target, event) => events.push({ target, event }));
      try {
        const root = await post(workspaceId, general, person(ana), "news");
        const posted = events.filter((e) => e.event.type === "message.posted");
        expect(posted).toHaveLength(1);
        expect(posted[0]?.event.message).toMatchObject({ id: root.message.id });
        const unread = events.filter((e) => e.event.type === "channel.unread").map((e) => e.target);
        expect(unread.sort()).toEqual(
          [`user:${workspaceId}:${beto.user.id}`, `user:${workspaceId}:${caio.user.id}`].sort(),
        );

        events.length = 0;
        await post(workspaceId, general, person(beto), "reply", { threadId: root.message.id });
        const chat = new Set(["message.posted", "thread.info_changed", "channel.unread"]);
        expect(events.filter((e) => chat.has(e.event.type)).map((e) => [e.target, e.event.type])).toEqual([
          [`channel:${general}`, "message.posted"],
          [`channel:${general}`, "thread.info_changed"],
        ]);
      } finally {
        off();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a posted message is found by the workspace's search, only by who reads its channel",
    async () => {
      const { workspaceId, general, ana, beto, caio } = await team();
      const sales = await seedChannel(server, workspaceId, {
        name: "sales",
        visibility: "private",
        members: [ana, beto],
      });
      const open = await post(workspaceId, general, person(ana), "quarterly zebra forecast");
      const closed = await post(workspaceId, sales, person(beto), "secret zebra margin");
      const hits = async (who: Person) => {
        const res = await who.browser.fetch(`/api/v1/workspaces/${workspaceId}/search?q=zebra`);
        expect(res.status).toBe(200);
        return ((await body(res)).hits as { kind: string; sourceId: string }[])
          .map((h) => `${h.kind}:${h.sourceId}`)
          .sort();
      };
      expect(await hits(beto)).toEqual([`message:${closed.message.id}`, `message:${open.message.id}`].sort());
      expect(await hits(caio)).toEqual([`message:${open.message.id}`]);
    },
    SERVER_TEST_MS,
  );

  test(
    "hydrate adds reactions and receipts, and marks an attachment in the trash as deleted",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const lia = await seedAgent(workspaceId, ana, `lia${n}`);
      const kept = newId("fil");
      const trashed = newId("fil");
      const by = { type: "person" as const, id: ana.user.id };
      await server.deps.db.insert(schema.files).values([
        { id: kept, workspaceId, title: "kept", kind: "file", createdBy: by, updatedBy: by },
        {
          id: trashed,
          workspaceId,
          title: "gone",
          kind: "file",
          createdBy: by,
          updatedBy: by,
          deletedAt: new Date(),
        },
      ]);
      const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
      if (!channel) throw new Error("no channel");
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: person(ana),
        body: "two files",
        clientId: null,
        meta: {
          files: [
            { id: kept, title: "kept", version: 1, deleted: false },
            { id: trashed, title: "gone", version: 1, deleted: false },
          ],
        },
      });
      await server.deps.db.insert(schema.emojiReactions).values([
        { messageId: message.id, reaction: "👍", actorType: "person", actorId: ana.user.id },
        { messageId: message.id, reaction: "👍", actorType: "person", actorId: beto.user.id },
        { messageId: message.id, reaction: "👍", actorType: "agent", actorId: lia },
      ]);
      await server.deps.db
        .insert(schema.messageDispatches)
        .values({ messageId: message.id, agentId: lia, state: "routed" });
      const [row] = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, message.id));
      if (!row) throw new Error("no row");
      const [full] = await hydrate(server.deps.db, [row]);
      expect(full?.reactions).toEqual([
        { reaction: "👍", count: 3, userIds: [ana.user.id, beto.user.id], agentIds: [lia] },
      ]);
      expect(full?.receipts).toEqual({ viewedBy: [lia], claimedBy: [], handled: [] });
      expect(full?.meta.files?.map((f) => [f.id, f.deleted])).toEqual([
        [kept, false],
        [trashed, true],
      ]);
    },
    SERVER_TEST_MS,
  );
});
