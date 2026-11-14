// The threads routes over HTTP: create, read, edit, the state actions, the lists and who may do what.
//
// Messages come from `postMessage` (messages.ts), the function the chat route calls when it saves a post:
// the chat route (S6) comes later. Following and unfollowing a thread are chat routes too, so they wait
// with it. Ana owns the workspace; Beto and Caio are members; #sales is private with Ana and Beto.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { postMessage } from "../src/messages";
import type { RealtimeEvent } from "../src/realtime/hub";
import type { RunningServer } from "../src/server";
import { Browser, body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@threads.test`;
const W = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const sales = await seedChannel(server, workspaceId, {
    name: "sales",
    visibility: "private",
    members: [ana, beto],
  });
  return { workspaceId, general, sales, ana, beto, caio };
}

async function post(
  workspaceId: string,
  channelId: string,
  who: Person,
  text: string,
  opts: { threadId?: string; clientId?: string } = {},
) {
  const channel = await channelInWorkspace(server.deps.db, workspaceId, channelId);
  if (!channel) throw new Error("no channel");
  const { message } = await postMessage(server.deps, {
    workspaceId,
    channel,
    author: { type: "person", id: who.user.id },
    body: text,
    clientId: opts.clientId ?? null,
    threadId: opts.threadId ?? null,
  });
  return message;
}

const call = (who: Person, path: string, method = "GET", data?: unknown) =>
  who.browser.json(path, method, data);
const ok = async (res: Response, status = 200) => {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return body(res);
};
const failure = async (res: Response) => ({ status: res.status, code: (await body(res)).error?.code });

describe("threads", () => {
  test(
    "create, edit, close, move, archive, list and remove",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const root = await post(workspaceId, general, ana, "Website launch");
      const info = await ok(
        await call(ana, `${W(workspaceId)}/threads`, "POST", {
          channelId: general,
          messageId: root.id,
          title: "Site",
        }),
        201,
      );
      expect(info).toMatchObject({
        id: root.id,
        state: "open",
        title: "Site",
        openingText: "Website launch",
        channelName: "general",
        venue: "channel",
        following: true,
        manageable: true,
        opener: { type: "person", id: ana.user.id },
      });
      await post(workspaceId, general, beto, "I'll review it", { threadId: root.id });
      const seen = await ok(await call(beto, `${W(workspaceId)}/threads/${root.id}`));
      expect(seen).toMatchObject({ replyCount: 1, following: true, manageable: false });
      expect(seen.participants).toEqual([
        { type: "person", id: ana.user.id },
        { type: "person", id: beto.user.id },
      ]);
      expect(seen.lastMessage).toMatchObject({
        author: { type: "person", id: beto.user.id },
        excerpt: "I'll review it",
      });

      expect(
        (await failure(await call(beto, `${W(workspaceId)}/threads/${root.id}`, "PATCH", { title: "x" })))
          .status,
      ).toBe(403);
      expect(
        (await ok(await call(ana, `${W(workspaceId)}/threads/${root.id}`, "PATCH", { title: "New site" })))
          .title,
      ).toBe("New site");

      const act = (action: string) => call(ana, `${W(workspaceId)}/threads/${root.id}/${action}`, "POST");
      expect((await ok(await act("close"))).state).toBe("closed");
      expect(await failure(await act("close"))).toEqual({ status: 409, code: "thread.invalid_state" });
      expect((await ok(await act("reopen"))).state).toBe("open");
      expect((await ok(await act("move"))).context.moved).toBe(true);
      expect(await failure(await act("move"))).toEqual({ status: 409, code: "thread.already_moved" });
      expect((await ok(await act("return"))).context.moved).toBe(false);
      expect(await failure(await act("return"))).toEqual({ status: 409, code: "thread.not_moved" });
      expect((await failure(await act("explode"))).status).toBe(404);

      const all = await ok(await call(beto, `${W(workspaceId)}/threads`));
      expect(all.threads.map((t: { id: string }) => t.id)).toContain(root.id);
      const inGeneral = (q: string) =>
        call(beto, `${W(workspaceId)}/channels/${general}/threads?q=${encodeURIComponent(q)}`);
      expect((await ok(await inGeneral("launch"))).threads).toHaveLength(1);
      expect((await ok(await inGeneral("none of that"))).threads).toHaveLength(0);

      await ok(await act("archive"));
      expect(
        (await ok(await call(beto, `${W(workspaceId)}/threads`))).threads.some(
          (t: { id: string }) => t.id === root.id,
        ),
      ).toBe(false);
      expect(
        (await ok(await call(beto, `${W(workspaceId)}/threads?tab=archived`))).threads.map(
          (t: { id: string }) => t.id,
        ),
      ).toEqual([root.id]);
      expect((await ok(await act("unarchive"))).state).toBe("open");

      expect((await failure(await call(beto, `${W(workspaceId)}/threads/${root.id}`, "DELETE"))).status).toBe(
        403,
      );
      expect((await call(ana, `${W(workspaceId)}/threads/${root.id}`, "DELETE")).status).toBe(204);
      expect((await failure(await call(ana, `${W(workspaceId)}/threads/${root.id}`))).status).toBe(404);
      // The replies stay: only the thread's state went.
      const [kept] = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.threadId, root.id));
      expect(kept?.body).toBe("I'll review it");
    },
    SERVER_TEST_MS,
  );

  test(
    "the limits of what a thread request takes: title and search 200, a cut of 500 messages, ids of 64",
    async () => {
      const { workspaceId, general, ana } = await team();
      const root = await post(workspaceId, general, ana, "limits");
      const reply = await post(workspaceId, general, ana, "r", { threadId: root.id });
      const thread = `${W(workspaceId)}/threads/${root.id}`;
      expect((await call(ana, thread, "PATCH", { title: "t".repeat(200) })).status).toBe(200);
      expect((await failure(await call(ana, thread, "PATCH", { title: "t".repeat(201) }))).status).toBe(400);
      expect((await call(ana, `${W(workspaceId)}/threads?q=${"q".repeat(200)}`)).status).toBe(200);
      expect((await failure(await call(ana, `${W(workspaceId)}/threads?q=${"q".repeat(201)}`))).status).toBe(
        400,
      );
      expect(
        (await call(ana, thread, "PATCH", { omittedMessageIds: Array(500).fill(reply.id) })).status,
      ).toBe(200);
      expect(
        (await failure(await call(ana, thread, "PATCH", { omittedMessageIds: Array(501).fill(reply.id) })))
          .status,
      ).toBe(400);
      expect(
        (await failure(await call(ana, thread, "PATCH", { lastMessageId: "m".repeat(65) }))).status,
      ).toBe(400);
      expect(
        (await failure(await call(ana, `${W(workspaceId)}/threads?cursor=${"c".repeat(201)}`))).status,
      ).toBe(400);
      const create = (title: string) =>
        call(ana, `${W(workspaceId)}/threads`, "POST", { channelId: general, messageId: root.id, title });
      expect((await failure(await create("t".repeat(201)))).status).toBe(400);
    },
    SERVER_TEST_MS,
  );

  test(
    "the list pages by cursor",
    async () => {
      const { workspaceId, general, ana } = await team();
      for (let i = 0; i < 5; i++) {
        const m = await post(workspaceId, general, ana, `subject ${i}`);
        await post(workspaceId, general, ana, "reply", { threadId: m.id });
      }
      const first = await ok(await call(ana, `${W(workspaceId)}/threads?limit=3`));
      expect(first.threads).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();
      const second = await ok(
        await call(ana, `${W(workspaceId)}/threads?limit=3&cursor=${first.nextCursor}`),
      );
      expect(second.threads).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.threads, ...second.threads].map((t: { id: string }) => t.id)).size).toBe(5);
      expect((await failure(await call(ana, `${W(workspaceId)}/threads?cursor=not-a-cursor`))).status).toBe(
        400,
      );
      expect((await failure(await call(ana, `${W(workspaceId)}/threads?limit=101`))).status).toBe(400);
    },
    SERVER_TEST_MS,
  );

  test(
    "a thread starts only from a top-level message of that channel, and the context cut stays in the thread",
    async () => {
      const { workspaceId, general, sales, ana, beto } = await team();
      const root = await post(workspaceId, general, ana, "root");
      const reply = await post(workspaceId, general, beto, "reply", { threadId: root.id });
      const other = await post(workspaceId, sales, ana, "elsewhere");
      const create = (messageId: string, channelId = general) =>
        call(ana, `${W(workspaceId)}/threads`, "POST", { channelId, messageId });
      expect(await failure(await create(reply.id))).toEqual({ status: 409, code: "thread.not_root" });
      expect((await failure(await create(other.id))).status).toBe(404);
      expect((await failure(await create(root.id, sales))).status).toBe(404);

      const patch = (data: unknown) => call(ana, `${W(workspaceId)}/threads/${root.id}`, "PATCH", data);
      expect((await failure(await patch({ omittedMessageIds: [other.id] }))).status).toBe(400);
      const cut = await ok(await patch({ omittedMessageIds: [reply.id], lastMessageId: reply.id }));
      expect(cut.context).toMatchObject({ omittedMessageIds: [reply.id], lastMessageId: reply.id });
    },
    SERVER_TEST_MS,
  );

  test(
    "two people acting on the same thread at once: one action wins and the other gets a conflict",
    async () => {
      const { workspaceId, general, ana } = await team();
      const root = await post(workspaceId, general, ana, "race");
      await post(workspaceId, general, ana, "reply", { threadId: root.id });
      const act = (action: string) => call(ana, `${W(workspaceId)}/threads/${root.id}/${action}`, "POST");

      const closes = await Promise.all(Array.from({ length: 6 }, () => act("close")));
      expect(closes.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
      await ok(await act("reopen"));

      const moves = await Promise.all(Array.from({ length: 4 }, () => act("move")));
      expect(moves.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);

      // archive (open or closed -> archived) against close (open -> closed): close then archive is fine, but
      // once an archive went through nothing closes the thread again.
      const mixed = await Promise.all([act("archive"), act("close"), act("archive"), act("close")]);
      const won: string[] = [];
      for (const r of mixed) if (r.status === 200) won.push((await body(r)).state);
      expect(won.filter((s) => s === "archived").length).toBeLessThanOrEqual(1);
      expect(won.filter((s) => s === "closed").length).toBeLessThanOrEqual(1);
      const [row] = await server.deps.db.select().from(schema.threads).where(eq(schema.threads.id, root.id));
      expect(row?.state).toBe(won.includes("archived") ? "archived" : "closed");
    },
    SERVER_TEST_MS,
  );
});

describe("threads: who may see and change them", () => {
  test(
    "a private channel's thread is invisible to whoever isn't in it, in the lists and by id",
    async () => {
      const { workspaceId, sales, ana, beto, caio } = await team();
      const root = await post(workspaceId, sales, ana, "private plan");
      await post(workspaceId, sales, beto, "ok", { threadId: root.id });
      const ids = async (who: Person, path: string) =>
        (await ok(await call(who, path))).threads.map((t: { id: string }) => t.id);
      expect(await ids(beto, `${W(workspaceId)}/threads`)).toContain(root.id);
      expect(await ids(caio, `${W(workspaceId)}/threads`)).not.toContain(root.id);
      expect(await ids(caio, `${W(workspaceId)}/threads?mine=true`)).not.toContain(root.id);
      expect((await failure(await call(caio, `${W(workspaceId)}/threads/${root.id}`))).status).toBe(404);
      expect((await failure(await call(caio, `${W(workspaceId)}/channels/${sales}/threads`))).status).toBe(
        404,
      );
      expect(
        (await failure(await call(caio, `${W(workspaceId)}/threads/${root.id}/close`, "POST"))).status,
      ).toBe(404);
      expect((await failure(await call(caio, `${W(workspaceId)}/threads/${root.id}`, "DELETE"))).status).toBe(
        404,
      );
      expect(
        (
          await failure(
            await call(caio, `${W(workspaceId)}/threads`, "POST", { channelId: sales, messageId: root.id }),
          )
        ).status,
      ).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "who opened the thread and an admin manage it; a member who only replied doesn't",
    async () => {
      const { workspaceId, general, ana, beto, caio } = await team();
      const admin = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
      const root = await post(workspaceId, general, beto, "Beto's topic");
      await ok(
        await call(beto, `${W(workspaceId)}/threads`, "POST", { channelId: general, messageId: root.id }),
        201,
      );
      await post(workspaceId, general, caio, "a reply", { threadId: root.id });
      const close = (who: Person) => call(who, `${W(workspaceId)}/threads/${root.id}/close`, "POST");
      expect((await failure(await close(caio))).status).toBe(403);
      expect((await ok(await close(beto))).state).toBe("closed");
      expect((await ok(await call(admin, `${W(workspaceId)}/threads/${root.id}/reopen`, "POST"))).state).toBe(
        "open",
      );
      expect((await ok(await call(ana, `${W(workspaceId)}/threads/${root.id}`))).manageable).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test(
    "without a session the threads answer 401, and another workspace's person gets 404",
    async () => {
      const { workspaceId, general, ana } = await team();
      const root = await post(workspaceId, general, ana, "root");
      const anon = new Browser(server.url);
      expect((await anon.json(`${W(workspaceId)}/threads`, "GET")).status).toBe(401);
      expect((await anon.json(`${W(workspaceId)}/threads/${root.id}/close`, "POST")).status).toBe(401);
      const stranger = await signedIn(server, "Eva", email("eva"));
      expect((await failure(await call(stranger, `${W(workspaceId)}/threads`))).status).toBe(404);
      expect(
        (await failure(await call(stranger, `${W(workspaceId)}/threads/${root.id}`, "PATCH", { title: "x" })))
          .status,
      ).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "every change tells the channel with thread.info_changed",
    async () => {
      const { workspaceId, general, ana, beto } = await team();
      const events: { target: string; event: RealtimeEvent }[] = [];
      const off = server.deps.hub.onPublish((target, event) => {
        if (event.type === "thread.info_changed") events.push({ target, event });
      });
      try {
        const root = await post(workspaceId, general, ana, "watched");
        await post(workspaceId, general, beto, "first reply", { threadId: root.id });
        await ok(await call(ana, `${W(workspaceId)}/threads/${root.id}/close`, "POST"));
        await ok(await call(ana, `${W(workspaceId)}/threads/${root.id}`, "PATCH", { title: "Renamed" }));
        expect((await call(ana, `${W(workspaceId)}/threads/${root.id}`, "DELETE")).status).toBe(204);
        expect(
          events.map((e) => [
            e.event.threadId,
            e.event.state ?? null,
            e.event.title ?? null,
            e.event.removed ?? false,
          ]),
        ).toEqual([
          [root.id, "open", "", false],
          [root.id, "closed", "", false],
          [root.id, "closed", "Renamed", false],
          [root.id, null, null, true],
        ]);
        expect(events.every((e) => e.event.channelId === general)).toBe(true);
      } finally {
        off();
      }
    },
    SERVER_TEST_MS,
  );
});
