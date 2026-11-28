// Chat access on the real server (PGlite, the real hub and runtime): a retracted post reaches nobody with its
// text, losing a private channel is announced on the socket, "stop" typed in chat follows the Stop button's rule,
// reacting needs the channel's membership, and a channel's budget notice names a private channel only to whoever
// reads it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { postMessage } from "../src/messages";
import type { RunningServer } from "../src/server";
import { isEvent, SERVER_TEST_MS, settle, signedIn, startTestServer, TestSocket, waitFor } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

/** Every request the model got: what the agent reads of the conversation. */
const seen: ModelRequest[] = [];
let server: RunningServer;
beforeAll(async () => {
  const fake = fakeProvider();
  server = await startTestServer({
    env: { UNDO_SEND_SECONDS: "0" },
    modelProvider: {
      kind: "fake",
      stream: (req) => {
        seen.push({ ...req, messages: [...req.messages] });
        return fake.stream(req);
      },
    },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let seq = 0;
const email = (name: string) => `${name}${++seq}@chat-access.test`;

/** Ana (owner) and Beto in a private channel, Carla outside it, and a public channel only Ana joined. */
async function team() {
  const owner = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, owner, `Studio ${seq}`);
  const insider = await memberOf(server, workspaceId, "Beto", email("beto"));
  const outsider = await memberOf(server, workspaceId, "Carla", email("carla"));
  const priv = await seedChannel(server, workspaceId, {
    name: `vault-${seq}`,
    visibility: "private",
    members: [owner, insider],
  });
  const pub = await seedChannel(server, workspaceId, { name: `open-${seq}`, members: [owner] });
  return { workspaceId, w: ws(workspaceId), general, priv, pub, owner, insider, outsider };
}

async function channelOf(workspaceId: string, channelId: string) {
  const channel = await channelInWorkspace(server.deps.db, workspaceId, channelId);
  if (!channel) throw new Error("no channel");
  return channel;
}

async function handleOf(who: Person) {
  const [row] = await server.deps.db
    .select({ handle: schema.members.handle })
    .from(schema.members)
    .where(eq(schema.members.userId, who.user.id));
  if (!row?.handle) throw new Error("no handle");
  return row.handle;
}

/** The agent's post as an undoable action asked by `requester`, as the post tool records it. */
async function postedAction(workspaceId: string, agentId: string, messageId: string, requester: Person) {
  const id = newId("act");
  await server.deps.db.insert(schema.reversibleActions).values({
    id,
    workspaceId,
    agentId,
    messageId,
    requesterUserId: requester.user.id,
    kind: "message_posted",
    target: { type: "message", id: messageId, title: "#general" },
    params: {},
    revertibleUntil: new Date(Date.now() + 3600_000),
  });
  return id;
}

/** The message as the socket's `message.posted` for it carried it. */
async function postedOf(socket: TestSocket, id: string): Promise<Record<string, unknown>> {
  const frame = await socket.next(
    (f) => isEvent(f, "message.posted") && (f.event.message as { id: string }).id === id,
  );
  return (frame.event as { message: Record<string, unknown> }).message;
}

/** A run that streams slowly in the channel, once it is live. */
async function liveRun(who: Person, w: string, channelId: string, handle: string) {
  const trigger = await call(who, "POST", `${w}/channels/${channelId}/messages`, {
    body: `@${handle} [[slow:1500]] work on it`,
    clientId: newId("c"),
  });
  expect(trigger.status).toBe(201);
  let runId = "";
  await waitFor(async () => {
    const r = await call(who, "GET", `${w}/channels/${channelId}/active-runs`);
    runId = r.body.runs[0]?.runId ?? "";
    return runId !== "";
  });
  return runId;
}

describe("chat access", () => {
  test(
    "a retracted post leaves with no text, files or cards: the message, its live update, quotes, threads, notices, search and the routine run it answered",
    async () => {
      const { workspaceId, w, general, owner, insider, outsider } = await team();
      const bot = await seedAgent(server, workspaceId, owner, `ctrl${seq}`, [general]);
      const channel = await channelOf(workspaceId, general);
      const secret = `CONFIDENTIAL${seq}X`;
      const agent = { type: "agent" as const, id: bot.id };

      // The agent's reply in a person's thread, and a top post of its own that mentions Carla and carries cards.
      const root = await call(owner, "POST", `${w}/channels/${general}/messages`, {
        body: "Where are we?",
        clientId: newId("c"),
      });
      const { message: reply } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: agent,
        body: `${secret} in the thread`,
        clientId: null,
        threadId: root.body.id,
      });
      const { message: top } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: agent,
        body: `@${await handleOf(outsider)} ${secret} on top`,
        clientId: null,
        meta: {
          approvalId: "apr_card",
          files: [{ id: "file_payroll", version: 1, title: "Payroll.xlsx", deleted: false }],
        },
      });
      // Beto quotes it and answers it in a thread; a routine run took it as its answer.
      const quote = await call(insider, "POST", `${w}/channels/${general}/messages`, {
        body: "quoting",
        clientId: newId("c"),
        replyTo: top.id,
      });
      expect(quote.body.meta.replyTo.excerpt).toContain(secret);
      await call(insider, "POST", `${w}/channels/${general}/messages`, {
        body: "an answer in its thread",
        clientId: newId("c"),
        threadId: top.id,
      });
      const routineId = newId("rtn");
      await server.deps.db.insert(schema.routines).values({
        id: routineId,
        workspaceId,
        name: "Digest",
        prompt: "Summarize",
        agentId: bot.id,
        target: { kind: "channel", channelId: general },
        trigger: { kind: "webhook" },
        createdBy: owner.user.id,
      });
      const executionId = newId("rex");
      await server.deps.db.insert(schema.routineExecutions).values({
        id: executionId,
        routineId,
        at: new Date(),
        status: "ok",
        summary: `${secret} on top`,
        messageId: top.id,
      });
      await settle(server);
      const noticeOf = async () =>
        (await call(outsider, "GET", `${w}/notifications`)).body.items.find(
          (n: { source?: { messageId?: string } }) => n.source?.messageId === top.id,
        );
      expect((await noticeOf())?.latest.text).toContain(secret);

      const socket = await TestSocket.open(outsider.browser, workspaceId);
      try {
        expect((await socket.subscribe(general)).type).toBe("subscribed");
        for (const message of [top, reply]) {
          const action = await postedAction(workspaceId, bot.id, message.id, insider);
          expect((await call(insider, "POST", `${w}/actions/${action}/undo`)).status).toBe(200);
        }
        // Live: the post itself, the quote that copied its text, and the notice.
        const posted = await postedOf(socket, top.id);
        expect(posted).toMatchObject({ id: top.id, body: "", author: agent });
        expect(posted).toMatchObject({ meta: { retracted: { actorUserId: insider.user.id } } });
        const quoted = await postedOf(socket, quote.body.id);
        expect(quoted).toMatchObject({ meta: { replyTo: { messageId: top.id, excerpt: "" } } });
        await socket.event("notification.shown");
        await Bun.sleep(50);
        expect(JSON.stringify(socket.frames)).not.toContain(secret);
        expect(JSON.stringify([posted, quoted])).not.toContain(secret);
        expect(JSON.stringify(posted)).not.toContain("Payroll");
        expect(JSON.stringify(posted)).not.toContain("apr_card");
      } finally {
        socket.close();
      }

      // Read again over HTTP, by anyone: the history, the thread, the thread lists, a new quote, the notices.
      const read: unknown[] = [];
      for (const who of [outsider, insider, owner]) {
        const list = await call(who, "GET", `${w}/channels/${general}/messages`);
        const again = list.body.messages.find((m: { id: string }) => m.id === top.id);
        expect(again).toMatchObject({ body: "", meta: { retracted: { actorUserId: insider.user.id } } });
        expect(again.meta.files).toBeUndefined();
        expect(again.meta.approvalId).toBeUndefined();
        const quoting = list.body.messages.find((m: { id: string }) => m.id === quote.body.id);
        expect(quoting.meta.replyTo.excerpt).toBe("");
        const thread = await call(who, "GET", `${w}/channels/${general}/messages?threadId=${root.body.id}`);
        expect(thread.body.messages.find((m: { id: string }) => m.id === reply.id).body).toBe("");
        const threads = await call(who, "GET", `${w}/threads`);
        const ofTop = threads.body.threads.find((t: { id: string }) => t.id === top.id);
        expect(ofTop.openingText).toBe("");
        const ofRoot = threads.body.threads.find((t: { id: string }) => t.id === root.body.id);
        expect(ofRoot.lastMessage.author).toEqual(agent);
        expect(ofRoot.lastMessage.excerpt).toBe("");
        read.push(list.body, thread.body, threads.body);
        read.push((await call(who, "GET", `${w}/threads/${top.id}`)).body);
        read.push((await call(who, "GET", `${w}/threads/${root.body.id}`)).body);
        const search = await call(who, "GET", `${w}/search?q=${secret}`);
        expect(search.body.hits).toHaveLength(0);
        expect((await call(who, "GET", `${w}/threads?q=${secret}`)).body.threads).toEqual([]);
      }
      const late = await call(outsider, "POST", `${w}/channels/${general}/messages`, {
        body: "quoting after",
        clientId: newId("c"),
        replyTo: top.id,
      });
      expect(late.body.meta.replyTo.excerpt).toBe("");
      read.push(late.body);
      const notice = await noticeOf();
      expect(notice?.latest.text).toBeUndefined();
      read.push(notice);
      const [execution] = await server.deps.db
        .select()
        .from(schema.routineExecutions)
        .where(eq(schema.routineExecutions.id, executionId));
      expect(execution?.summary).toBeNull();
      expect(JSON.stringify(read)).not.toContain(secret);

      // The agent itself doesn't read it again in the conversation's history.
      seen.length = 0;
      await call(owner, "POST", `${w}/channels/${general}/messages`, {
        body: `@${bot.handle} what did you say?`,
        clientId: newId("c"),
      });
      await settle(server);
      const history = seen.map((req) => JSON.stringify(req.messages)).join("\n");
      expect(history).toContain("what did you say?");
      expect(history).not.toContain(secret);
    },
    SERVER_TEST_MS,
  );

  test(
    "losing a private channel is announced on the socket and its events stop: removed, left, or out of the workspace",
    async () => {
      const { workspaceId, w, priv, owner, insider } = await team();
      const second = await seedChannel(server, workspaceId, {
        name: `second-${seq}`,
        visibility: "private",
        members: [owner, insider],
      });
      const socket = await TestSocket.open(insider.browser, workspaceId);
      const otherTab = await TestSocket.open(insider.browser, workspaceId);
      try {
        for (const s of [socket, otherTab]) expect((await s.subscribe(priv)).type).toBe("subscribed");
        expect((await socket.subscribe(second)).type).toBe("subscribed");
        // Removed by an admin: both tabs hear it, and nothing more of it reaches them.
        expect(
          (await call(owner, "DELETE", `${w}/channels/${priv}/members/people/${insider.user.id}`)).status,
        ).toBe(204);
        for (const s of [socket, otherTab])
          await s.next((f) => f.type === "unsubscribed" && f.channelId === priv, 2000);
        await call(owner, "POST", `${w}/channels/${priv}/messages`, { body: "after", clientId: newId("c") });
        await Bun.sleep(100);
        for (const s of [socket, otherTab])
          expect(s.frames.filter((f) => f.type === "event" && f.channelId === priv)).toEqual([]);

        // Leaving on one's own says the same.
        await call(owner, "POST", `${w}/channels/${second}/members`, { userId: insider.user.id });
        expect(
          (await call(insider, "DELETE", `${w}/channels/${second}/members/people/${insider.user.id}`)).status,
        ).toBe(204);
        await socket.next((f) => f.type === "unsubscribed" && f.channelId === second, 2000);

        // Out of the workspace: every channel the socket followed is announced before it closes.
        expect((await socket.subscribe(second)).type).toBe("error");
        const general = (await call(insider, "GET", `${w}/channels`)).body.channels.find(
          (c: { isGeneral: boolean }) => c.isGeneral,
        ).id;
        expect((await socket.subscribe(general)).type).toBe("subscribed");
        expect((await call(owner, "DELETE", `${w}/members/${insider.user.id}`)).status).toBe(204);
        expect(await socket.closed).toBe(4003);
        expect(socket.frames.filter((f) => f.type === "unsubscribed")).toEqual([
          { type: "unsubscribed", channelId: general },
        ]);
      } finally {
        socket.close();
        otherTab.close();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    '"stop" typed in chat stops a run only for whoever may stop it, as the Stop button; a routine\'s run has no initiator',
    async () => {
      const { workspaceId, w, general, owner, insider, outsider } = await team();
      const member = await memberOf(server, workspaceId, "Dani", email("dani"));
      // Beto (a member) owns the agent; Carla starts the run; Dani is neither.
      const bot = await seedAgent(server, workspaceId, insider, `bot${seq}`, [general]);
      const status = async (runId: string) =>
        (await call(owner, "GET", `${w}/runs/${runId}`)).body.run?.status;
      const stop = (who: Person) =>
        call(who, "POST", `${w}/channels/${general}/messages`, {
          body: `@${bot.handle} stop`,
          clientId: newId("c"),
        });

      const first = await liveRun(outsider, w, general, bot.handle);
      await stop(member);
      await Bun.sleep(150);
      expect(server.deps.runtime.liveRun(first)).not.toBeNull();
      expect((await call(member, "POST", `${w}/runs/${first}/cancel`)).status).toBe(403);
      await stop(outsider);
      await waitFor(async () => server.deps.runtime.liveRun(first) === null);
      expect(await status(first)).toBe("canceled");

      // The agent's owner and whoever manages agents stop it too.
      for (const who of [insider, owner]) {
        const runId = await liveRun(outsider, w, general, bot.handle);
        await stop(who);
        await waitFor(async () => server.deps.runtime.liveRun(runId) === null);
        expect(await status(runId)).toBe("canceled");
      }

      // A routine posts in its creator's name, but the run isn't the creator's: neither the button nor "stop".
      const channel = await channelOf(workspaceId, general);
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: { type: "person", id: member.user.id },
        body: "[[slow:1500]] the digest",
        clientId: newId("c"),
        meta: { routine: { routineId: newId("rtn"), name: "Digest" } },
      });
      const [trigger] = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, message.id));
      if (!trigger) throw new Error("no trigger");
      const started = await server.deps.runtime.runFor({ agent: bot, channel, trigger });
      if (!started.ok) throw new Error(started.code);
      expect(server.deps.runtime.liveInfo(started.runId)).toEqual({
        initiatedBy: null,
        ownerUserId: insider.user.id,
      });
      expect((await call(member, "POST", `${w}/runs/${started.runId}/cancel`)).status).toBe(403);
      expect((await call(owner, "POST", `${w}/runs/${started.runId}/cancel`)).status).toBe(204);
      await started.done;
      await settle(server);
    },
    SERVER_TEST_MS,
  );

  test(
    "reacting needs the channel's membership: a public channel one hasn't joined refuses, a private one hides",
    async () => {
      const { w, pub, priv, owner, insider, outsider } = await team();
      const post = await call(owner, "POST", `${w}/channels/${pub}/messages`, {
        body: "Public announcement",
        clientId: newId("c"),
      });
      const reactions = `${w}/messages/${post.body.id}/reactions`;
      expect((await call(insider, "POST", reactions, { reaction: "👍" })).status).toBe(403);
      expect(
        (await call(insider, "DELETE", `${reactions}?reaction=${encodeURIComponent("👍")}`)).status,
      ).toBe(403);
      // Reading them stays open to whoever reads the channel.
      expect((await call(insider, "GET", reactions)).status).toBe(200);
      expect((await call(insider, "POST", `${w}/channels/${pub}/join`)).status).toBe(204);
      expect((await call(insider, "POST", reactions, { reaction: "👍" })).status).toBe(200);
      expect(
        (await call(insider, "DELETE", `${reactions}?reaction=${encodeURIComponent("👍")}`)).status,
      ).toBe(200);

      const secret = await call(owner, "POST", `${w}/channels/${priv}/messages`, {
        body: "inside",
        clientId: newId("c"),
      });
      expect(
        (await call(outsider, "POST", `${w}/messages/${secret.body.id}/reactions`, { reaction: "👍" }))
          .status,
      ).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "a channel's budget notice names a private channel only to whoever reads it",
    async () => {
      const { workspaceId, priv, owner, insider } = await team();
      const admin = await memberOf(server, workspaceId, "Edu", email("edu"), "admin");
      await server.deps.db
        .update(schema.channels)
        .set({ budgetPerMonthUsd: 10 })
        .where(eq(schema.channels.id, priv));
      const sent: { userId: string; event: Record<string, unknown> }[] = [];
      const { hub, ledger } = server.deps;
      const toUser = hub.toUser.bind(hub);
      const spent = ledger.spent.bind(ledger);
      hub.toUser = (wsId, userId, event) => {
        if (event.type === "channel.budget") sent.push({ userId, event: event as Record<string, unknown> });
        return toUser(wsId, userId, event);
      };
      ledger.spent = async () => 12;
      try {
        await (server.runtime["channelBudgetCheck"](priv, insider.user.id, true) as Promise<void>);
        const to = (who: Person) => sent.find((s) => s.userId === who.user.id)?.event;
        const { name } = await channelOf(workspaceId, priv);
        expect(to(owner)).toMatchObject({
          channelId: priv,
          channelName: name,
          level: "exhausted",
          spentUsd: 12,
        });
        expect(to(insider)).toMatchObject({ channelId: priv, channelName: name, spentUsd: null });
        // An admin outside the private channel hears that one ran out, with the amounts, but not which by name.
        expect(to(admin)).toMatchObject({ channelId: priv, channelName: null, spentUsd: 12 });
        expect(JSON.stringify(to(admin))).not.toContain(name);
      } finally {
        hub.toUser = toUser;
        ledger.spent = spent;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a routine's runs follow the channel each one answered in: once its target moves to #general, the private channel's run stays hidden",
    async () => {
      const { workspaceId, w, general, priv, owner, outsider } = await team();
      const bot = await seedAgent(server, workspaceId, owner, `rtn${seq}`, [general, priv]);
      const base = `${w}/routines`;
      const routine = (
        await call(owner, "POST", base, {
          agentId: bot.id,
          prompt: "Summarize the secret deal",
          target: { kind: "channel", channelId: priv },
          trigger: { kind: "webhook" },
        })
      ).body;
      expect((await call(outsider, "GET", `${base}/${routine.id}/runs`)).status).toBe(404);
      expect((await call(owner, "POST", `${base}/${routine.id}/run`, {})).status).toBe(200);
      await settle(server);
      const patched = await call(owner, "PATCH", `${base}/${routine.id}`, {
        target: { kind: "channel", channelId: general },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.lastRun).not.toBeNull();
      // Ana, who reads the private channel, still has the run with its reply.
      const mine = await call(owner, "GET", `${base}/${routine.id}/runs`);
      expect(mine.body.runs).toHaveLength(1);
      expect(mine.body.runs[0]).toMatchObject({ channelId: priv });
      expect(typeof mine.body.runs[0].summary).toBe("string");
      // Carla reads #general, so she sees the routine now, but not the run that answered in the private channel.
      const theirs = await call(outsider, "GET", `${base}/${routine.id}/runs`);
      expect(theirs.status).toBe(200);
      expect(theirs.body.runs).toEqual([]);
      const listed = (await call(outsider, "GET", base)).body.routines.find(
        (r: { id: string }) => r.id === routine.id,
      );
      expect(listed).toMatchObject({ lastRun: null, recentFires: [] });
      expect(JSON.stringify(listed)).not.toContain(priv);
    },
    SERVER_TEST_MS,
  );
});
