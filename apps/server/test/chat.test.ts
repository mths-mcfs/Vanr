import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningServer } from "../src/server";
import { Browser, SERVER_TEST_MS, signedIn, startTestServer, TestSocket } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, type Person } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@chat.test`;

/** The body of a 2xx answer; any other status throws with its status and code. */
async function ok(who: Person, method: string, path: string, payload?: unknown) {
  const res = await call(who, method, path, payload);
  if (res.status >= 300) throw Object.assign(new Error(`${method} ${path}: ${res.status}`), res);
  return res.body;
}
/** The status and code of an answer that must fail. */
async function apiError(who: Person, method: string, path: string, payload?: unknown) {
  const res = await call(who, method, path, payload);
  expect(res.status).toBeGreaterThanOrEqual(400);
  return { status: res.status, code: res.body?.error?.code as string | undefined };
}

/** A workspace with its owner (Ana) and a member (Beto). */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspace, defaultChannelId } = await ok(ana, "POST", "/api/v1/workspaces", { name: "Team" });
  const workspaceId: string = workspace.id;
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  return { workspaceId, w: ws(workspaceId), general: defaultChannelId as string, ana, beto };
}

const channels = async (who: Person, w: string) => (await ok(who, "GET", `${w}/channels`)).channels;

describe("channels", () => {
  test(
    "create, list, join, rename and topic",
    async () => {
      const { w, general, ana, beto } = await team();
      const created = await ok(ana, "POST", `${w}/channels`, {
        name: "  Sales South ",
        visibility: "public",
      });
      expect(created).toMatchObject({
        name: "sales-south",
        visibility: "public",
        isMember: true,
        unreadCount: 0,
      });
      const dup = await apiError(ana, "POST", `${w}/channels`, { name: "sales south", visibility: "public" });
      expect([dup.status, dup.code]).toEqual([409, "channel.name_taken"]);
      const bad = await apiError(ana, "POST", `${w}/channels`, { name: "!!!", visibility: "public" });
      expect(bad.status).toBe(400);

      const seen: { id: string; isMember: boolean; isGeneral: boolean }[] = await channels(beto, w);
      expect(seen.map((c) => [c.id, c.isMember])).toEqual(
        expect.arrayContaining([
          [general, true],
          [created.id, false],
        ]),
      );
      // Only #general comes marked: the screen hides "Leave" and its name field.
      expect(seen.filter((c) => c.isGeneral).map((c) => c.id)).toEqual([general]);
      await ok(beto, "POST", `${w}/channels/${created.id}/join`);
      expect((await channels(beto, w)).find((c: { id: string }) => c.id === created.id)?.isMember).toBe(true);

      const renamed = await ok(beto, "PATCH", `${w}/channels/${created.id}`, {
        name: "Sales",
        topic: "Goals of the month",
      });
      expect(renamed).toMatchObject({ name: "sales", topic: "Goals of the month" });
      const general409 = await apiError(ana, "PATCH", `${w}/channels/${general}`, { name: "main" });
      expect([general409.status, general409.code]).toEqual([409, "channel.general"]);
      expect(renamed.isGeneral).toBe(false);
      expect((await ok(ana, "PATCH", `${w}/channels/${general}`, { topic: "Notices" })).isGeneral).toBe(true);
    },
    SERVER_TEST_MS,
  );

  test(
    "private channel: only a member sees, reads and subscribes; adding and removing",
    async () => {
      const { workspaceId, w, ana, beto } = await team();
      const secret = await ok(ana, "POST", `${w}/channels`, { name: "board", visibility: "private" });
      expect((await channels(beto, w)).some((c: { id: string }) => c.id === secret.id)).toBe(false);
      expect((await apiError(beto, "GET", `${w}/channels/${secret.id}/messages`)).status).toBe(404);
      expect((await apiError(beto, "POST", `${w}/channels/${secret.id}/join`)).status).toBe(404);

      await ok(ana, "POST", `${w}/channels/${secret.id}/members`, { userId: beto.user.id });
      expect((await ok(beto, "GET", `${w}/channels/${secret.id}/members`)).members).toEqual([
        { type: "person", id: ana.user.id },
        { type: "person", id: beto.user.id },
      ]);
      const directory: { name: string; handle: string | null }[] = (
        await ok(beto, "GET", `${w}/channels/${secret.id}/directory`)
      ).members;
      expect(directory.map((r) => [r.name, r.handle])).toEqual([
        ["Ana", "ana"],
        ["Beto", "beto"],
      ]);

      // Beto subscribes to the channel and loses the subscription when he leaves.
      const socket = await TestSocket.open(beto.browser, workspaceId);
      expect((await socket.subscribe(secret.id)).type).toBe("subscribed");
      await ok(beto, "DELETE", `${w}/channels/${secret.id}/members/people/${beto.user.id}`);
      await ok(ana, "POST", `${w}/channels/${secret.id}/messages`, { body: "board only", clientId: "c1" });
      await expect(socket.event("message.posted", 300)).rejects.toThrow("timeout");
      expect((await socket.subscribe(secret.id)).type).toBe("error");
      socket.close();

      // A plain member doesn't remove the others; an unknown agent answers 404.
      await ok(ana, "POST", `${w}/channels/${secret.id}/members`, { userId: beto.user.id });
      expect(
        (await apiError(beto, "DELETE", `${w}/channels/${secret.id}/members/people/${ana.user.id}`)).status,
      ).toBe(403);
      expect((await apiError(ana, "DELETE", `${w}/channels/${secret.id}/members/agents/agt_x`)).status).toBe(
        404,
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "nobody leaves #general",
    async () => {
      const { w, general, beto } = await team();
      const err = await apiError(beto, "DELETE", `${w}/channels/${general}/members/people/${beto.user.id}`);
      expect([err.status, err.code]).toEqual([409, "channel.general"]);
    },
    SERVER_TEST_MS,
  );
});

const messagesOf = async (who: Person, w: string, channelId: string, query = "") =>
  (await ok(who, "GET", `${w}/channels/${channelId}/messages${query}`)).messages;

describe("messages", () => {
  test(
    "a post is idempotent by clientId, mentions by @handle and pages with before",
    async () => {
      const { w, general, ana, beto } = await team();
      const post = (body: string, clientId: string) =>
        ok(ana, "POST", `${w}/channels/${general}/messages`, { body, clientId });
      const first = await post("hi @beto", "a-1");
      expect(first).toMatchObject({
        body: "hi @beto",
        author: { type: "person", id: ana.user.id },
        replyCount: 0,
      });
      const again = await call(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "hi @beto",
        clientId: "a-1",
      });
      expect([again.status, again.body.id]).toEqual([200, first.id]);
      for (let i = 2; i <= 5; i++) await post(`m${i}`, `a-${i}`);
      const messages: { id: string; body: string }[] = await messagesOf(beto, w, general);
      expect(messages.map((m) => m.body)).toEqual(["hi @beto", "m2", "m3", "m4", "m5"]);
      const older: { body: string }[] = await messagesOf(
        beto,
        w,
        general,
        `?before=${messages[3]?.id}&limit=2`,
      );
      expect(older.map((m) => m.body)).toEqual(["m2", "m3"]);
      expect(
        (await apiError(ana, "POST", `${w}/channels/${general}/messages`, { body: "   ", clientId: "empty" }))
          .status,
      ).toBe(400);
    },
    SERVER_TEST_MS,
  );

  test(
    "a quote builds replyTo on the server and a thread counts its replies",
    async () => {
      const { w, general, ana, beto } = await team();
      const path = `${w}/channels/${general}/messages`;
      const root = await ok(ana, "POST", path, { body: "Sales plan", clientId: "r" });
      const quote = await ok(beto, "POST", path, { body: "agreed", clientId: "q", replyTo: root.id });
      expect(quote.meta.replyTo).toEqual({
        messageId: root.id,
        threadId: null,
        author: { type: "person", id: ana.user.id },
        authorName: "Ana",
        excerpt: "Sales plan",
      });
      const reply = await ok(beto, "POST", path, {
        body: "in the thread",
        clientId: "t1",
        threadId: root.id,
      });
      expect(reply.threadId).toBe(root.id);
      const top: { id: string; replyCount: number }[] = await messagesOf(ana, w, general);
      expect(top.find((m) => m.id === root.id)?.replyCount).toBe(1);
      expect(top.some((m) => m.id === reply.id)).toBe(false);
      const thread: { body: string }[] = await messagesOf(ana, w, general, `?threadId=${root.id}`);
      expect(thread.map((m) => m.body)).toEqual(["Sales plan", "in the thread"]);
      const bad = await apiError(ana, "POST", path, { body: "x", clientId: "t2", threadId: reply.id });
      expect(bad.status).toBe(400);
    },
    SERVER_TEST_MS,
  );

  test(
    "reactions: count, remove and tell the channel",
    async () => {
      const { workspaceId, w, general, ana, beto } = await team();
      const msg = await ok(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "good morning",
        clientId: "r1",
      });
      const socket = await TestSocket.open(ana.browser, workspaceId);
      await socket.subscribe(general);
      const react = `${w}/messages/${msg.id}/reactions`;
      await ok(beto, "POST", react, { reaction: "👍" });
      const { reactions } = await ok(ana, "POST", react, { reaction: "👍" });
      expect(reactions).toEqual([
        { reaction: "👍", count: 2, userIds: [beto.user.id, ana.user.id], agentIds: [] },
      ]);
      const ev = await socket.event("message.reactions_updated");
      expect(ev.channelId).toBe(general);
      expect(ev.event).toMatchObject({ messageId: msg.id });
      await ok(beto, "DELETE", `${react}?reaction=${encodeURIComponent("👍")}`);
      expect((await ok(ana, "GET", react)).reactions).toEqual([
        { reaction: "👍", count: 1, userIds: [ana.user.id], agentIds: [] },
      ]);
      socket.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "pins",
    async () => {
      const { w, general, ana, beto } = await team();
      const msg = await ok(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "house rule",
        clientId: "p1",
      });
      const pins = `${w}/channels/${general}/pinned-messages`;
      const pin = await ok(beto, "POST", `${pins}/${msg.id}`);
      expect(pin).toMatchObject({ channelId: general, messageId: msg.id, pinnedBy: beto.user.id });
      expect(pin.message.body).toBe("house rule");
      expect((await ok(ana, "GET", pins)).pins.map((p: { messageId: string }) => p.messageId)).toEqual([
        msg.id,
      ]);
      await ok(ana, "DELETE", `${pins}/${msg.id}`);
      expect((await ok(ana, "GET", pins)).pins).toEqual([]);
      expect((await apiError(ana, "DELETE", `${pins}/${msg.id}`)).status).toBe(404);
    },
    SERVER_TEST_MS,
  );
});

describe("DMs and reading", () => {
  test(
    "opening a DM from both sides lands in the same channel; unread goes to zero on reading",
    async () => {
      const { workspaceId, w, ana, beto } = await team();
      const { channelId } = await ok(ana, "POST", `${w}/dms`, { userId: beto.user.id });
      expect((await ok(beto, "POST", `${w}/dms`, { userId: ana.user.id })).channelId).toBe(channelId);
      await ok(ana, "POST", `${w}/channels/${channelId}/messages`, { body: "hi", clientId: "d1" });
      await ok(ana, "POST", `${w}/channels/${channelId}/messages`, { body: "how are you?", clientId: "d2" });
      expect((await ok(beto, "GET", `${w}/dms`)).dms).toEqual([
        { channelId, with: { type: "person", id: ana.user.id, name: "Ana" }, unread: 2 },
      ]);
      expect((await ok(ana, "GET", `${w}/dms`)).dms[0]).toMatchObject({
        with: { id: beto.user.id, name: "Beto" },
        unread: 0,
      });
      await ok(beto, "POST", `${w}/channels/${channelId}/read`);
      expect((await ok(beto, "GET", `${w}/dms`)).dms[0]?.unread).toBe(0);
      expect((await channels(beto, w)).find((c: { id: string }) => c.id === channelId)?.unreadCount).toBe(0);

      // Changing the topic returns the real unread count of whoever changed it, not zero (the web app replaces
      // the channel in its cache).
      const general = (await channels(ana, w)).find((c: { name: string }) => c.name === "general")?.id ?? "";
      await ok(ana, "POST", `${w}/channels/${general}/messages`, { body: "news", clientId: "g1" });
      expect((await ok(beto, "PATCH", `${w}/channels/${general}`, { topic: "notices" })).unreadCount).toBe(1);

      // A third person neither sees nor reads the DM.
      const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
      expect((await apiError(caio, "GET", `${w}/channels/${channelId}/messages`)).status).toBe(404);
      expect((await apiError(ana, "POST", `${w}/dms`, { agentId: "agt_x" })).status).toBe(404);
    },
    SERVER_TEST_MS,
  );
});

describe("threads", () => {
  test(
    "create, follow, edit, close, move, archive and list",
    async () => {
      const { w, general, ana, beto } = await team();
      const root = await ok(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "Site launch",
        clientId: "th",
      });
      const info = await ok(ana, "POST", `${w}/threads`, {
        channelId: general,
        messageId: root.id,
        title: "Site",
      });
      expect(info).toMatchObject({
        id: root.id,
        state: "open",
        title: "Site",
        openingText: "Site launch",
        channelName: "general",
        following: true,
        manageable: true,
      });
      await ok(beto, "POST", `${w}/channels/${general}/messages`, {
        body: "I'll review it",
        clientId: "th-1",
        threadId: root.id,
      });
      const seen = await ok(beto, "GET", `${w}/threads/${root.id}`);
      expect(seen).toMatchObject({ replyCount: 1, following: true, manageable: false });
      expect(seen.participants).toEqual([
        { type: "person", id: ana.user.id },
        { type: "person", id: beto.user.id },
      ]);
      const follow = `${w}/threads/${root.id}/follow`;
      expect(await ok(beto, "DELETE", follow)).toEqual({ threadId: root.id, following: false });
      expect((await ok(beto, "GET", `${w}/threads/${root.id}`)).following).toBe(false);
      expect(await ok(beto, "PUT", follow)).toEqual({ threadId: root.id, following: true });

      expect((await apiError(beto, "PATCH", `${w}/threads/${root.id}`, { title: "x" })).status).toBe(403);
      expect((await ok(ana, "PATCH", `${w}/threads/${root.id}`, { title: "New site" })).title).toBe(
        "New site",
      );

      const act = (action: string) => ok(ana, "POST", `${w}/threads/${root.id}/${action}`);
      expect((await act("close")).state).toBe("closed");
      const twice = await apiError(ana, "POST", `${w}/threads/${root.id}/close`);
      expect([twice.status, twice.code]).toEqual([409, "thread.invalid_state"]);
      expect((await act("reopen")).state).toBe("open");
      expect((await act("move")).context.moved).toBe(true);
      expect((await act("return")).context.moved).toBe(false);

      const all = await ok(beto, "GET", `${w}/threads`);
      expect(all.threads.map((t: { id: string }) => t.id)).toContain(root.id);
      expect((await ok(beto, "GET", `${w}/channels/${general}/threads?q=launch`)).threads).toHaveLength(1);
      expect((await ok(beto, "GET", `${w}/channels/${general}/threads?q=none+of+that`)).threads).toHaveLength(
        0,
      );

      await act("archive");
      expect(
        (await ok(beto, "GET", `${w}/threads`)).threads.some((t: { id: string }) => t.id === root.id),
      ).toBe(false);
      expect(
        (await ok(beto, "GET", `${w}/threads?tab=archived`)).threads.map((t: { id: string }) => t.id),
      ).toEqual([root.id]);
      expect((await act("unarchive")).state).toBe("open");

      await ok(ana, "DELETE", `${w}/threads/${root.id}`);
      expect((await apiError(ana, "GET", `${w}/threads/${root.id}`)).status).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "the list pages by cursor",
    async () => {
      const { w, general, ana } = await team();
      const path = `${w}/channels/${general}/messages`;
      for (let i = 0; i < 5; i++) {
        const m = await ok(ana, "POST", path, { body: `topic ${i}`, clientId: `pg-${i}` });
        await ok(ana, "POST", path, { body: "answer", clientId: `pg-r-${i}`, threadId: m.id });
      }
      const first = await ok(ana, "GET", `${w}/threads?limit=3`);
      expect(first.threads).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();
      const second = await ok(
        ana,
        "GET",
        `${w}/threads?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`,
      );
      expect(second.threads).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.threads, ...second.threads].map((t: { id: string }) => t.id)).size).toBe(5);
    },
    SERVER_TEST_MS,
  );
});

describe("WebSocket", () => {
  test(
    "a new message reaches whoever subscribed to the channel at once; typing goes to the others",
    async () => {
      const { workspaceId, w, general, ana, beto } = await team();
      const a = await TestSocket.open(ana.browser, workspaceId);
      const b = await TestSocket.open(beto.browser, workspaceId);
      expect((await b.subscribe(general)).type).toBe("subscribed");
      expect((await a.subscribe(general)).type).toBe("subscribed");

      const sent = await ok(ana, "POST", `${w}/channels/${general}/messages`, {
        body: "live",
        clientId: "ws-1",
      });
      const got = await b.event("message.posted");
      expect(got.channelId).toBe(general);
      expect((got.event.message as { id: string }).id).toBe(sent.id);

      a.send({ type: "typing", channelId: general });
      const typing = await b.event("person.typing");
      expect(typing.event).toEqual({ type: "person.typing", userId: ana.user.id, ttlMs: 6000 });
      await expect(a.event("person.typing", 200)).rejects.toThrow("timeout");

      await ok(beto, "POST", `${w}/channels/${general}/messages`, {
        body: "answer",
        clientId: "ws-2",
        threadId: sent.id,
      });
      const updated = await a.event("thread.info_changed");
      expect(updated.event).toMatchObject({ threadId: sent.id, replyCount: 1, state: "open" });

      a.send({ type: "ping" });
      expect((await a.next((f) => f.type === "pong")).type).toBe("pong");
      a.send({ type: "nothing" });
      expect((await a.next((f) => f.type === "error")).code).toBe("invalid_frame");
      a.close();
      b.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "online presence comes from the open connection",
    async () => {
      const { workspaceId, w, ana, beto } = await team();
      const socket = await TestSocket.open(beto.browser, workspaceId);
      const { people } = await ok(ana, "GET", `${w}/people`);
      expect(people.find((p: { userId: string }) => p.userId === beto.user.id)?.online).toBe(true);
      socket.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "rejects an outside origin, no session and whoever isn't in the workspace; whoever leaves it is disconnected",
    async () => {
      const { workspaceId, w, ana, beto } = await team();
      const wsUrl = `${server.url.replace(/^http/, "ws")}/api/v1/realtime?workspaceId=${workspaceId}`;
      const status = async (headers: Record<string, string>) => {
        const res = await fetch(wsUrl.replace(/^ws/, "http"), {
          headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", ...headers },
        });
        return res.status;
      };
      const cookie = [...ana.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      expect(await status({ cookie, origin: "https://evil.example" })).toBe(403);
      expect(await status({ origin: server.url })).toBe(401);
      const outsider = await signedIn(server, "Zed", email("zed"));
      const outsiderCookie = [...outsider.browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      expect(await status({ cookie: outsiderCookie, origin: server.url })).toBe(404);

      const socket = await TestSocket.open(beto.browser, workspaceId);
      await ok(ana, "DELETE", `${w}/members/${beto.user.id}`);
      expect(await socket.closed).toBe(4003);
    },
    SERVER_TEST_MS,
  );
});

test(
  "without a session the channels API answers 401",
  async () => {
    const anon = new Browser(server.url);
    expect((await anon.fetch(`${ws("ws_x")}/channels`)).status).toBe(401);
  },
  SERVER_TEST_MS,
);
