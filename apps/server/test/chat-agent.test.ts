// A conversation with an agent through the chat routes, with the agent runtime of test/chat-runtime.ts (the engine's
// fake model behind the RuntimePort): a message calls a connector tool through integrations/tools and the reply
// streams back; a channel rule takes the connector away in that channel; another workspace's ids answer as missing
// ones; a double submit routes once; the live runs follow the run detail's reveal rule; and without the runtime a
// post an agent could answer is rejected before it is written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import type { AgentRow } from "../src/agents";
import { channelInWorkspace, openDm } from "../src/channels";
import { replaceGrants } from "../src/integrations/access";
import { connectCustom, saveCustomTools } from "../src/integrations/connectors";
import { postMessage } from "../src/messages";
import type { RunningServer } from "../src/server";
import { type ChatRuntime, chatRuntime } from "./chat-runtime";
import { type FakeMcp, startFakeMcp } from "./fake-mcp";
import {
  isEvent,
  type RealtimeFrame,
  SERVER_TEST_MS,
  settle,
  signedIn,
  startTestServer,
  TestSocket,
} from "./harness";
import { addToChannel, call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
let runtime: ChatRuntime;
let mcp: FakeMcp;
beforeAll(async () => {
  mcp = startFakeMcp({ keyOnly: true });
  runtime = chatRuntime(() => server.deps);
  try {
    server = await startTestServer({
      env: { ALLOW_PRIVATE_NETWORKS: "true" },
      fetchExternal: fetch,
      runtime: (port) => runtime.port(port),
    });
  } catch (err) {
    mcp.stop();
    throw err;
  }
}, SERVER_TEST_MS);
afterAll(async () => {
  try {
    await server?.stop();
  } finally {
    mcp.stop();
  }
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@chat-agent.test`;

/** A workspace with Ana (owner) and Beto (member), and the agent Lia in #general. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, `lia${n}`, [general]);
  return { workspaceId, w: ws(workspaceId), general, ana, beto, lia };
}

/** The fake MCP server connected to the workspace (its "Stock" tools on), and every scope granted to the agent. */
async function stockFor(workspaceId: string, owner: Person, agent: AgentRow) {
  const me = { workspaceId, userId: owner.user.id, role: "owner" as const, handle: "ana", sessionId: "s" };
  const start = await connectCustom(server.deps, me, {
    serverUrl: mcp.url,
    apiKey: mcp.apiKey,
    label: "Stock",
    nextPath: "/back",
  });
  if (start.status !== "server") throw new Error(`expected a connected server, got ${start.status}`);
  const [row] = await server.deps.db
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.id, start.server.id));
  if (!row) throw new Error("no connection");
  await saveCustomTools(server.deps, row, {
    label: "Stock",
    tools: [
      { name: "list_items", access: "read", label: "List items" },
      { name: "create_item", access: "write", label: "Create item" },
    ],
  });
  await replaceGrants(server.deps.db, workspaceId, agent.id, [{ connectionId: "", scope: "*" }]);
  return row.id;
}

const post = (who: Person, w: string, channelId: string, body: string, clientId: string) =>
  call(who, "POST", `${w}/channels/${channelId}/messages`, { body, clientId });

describe("a conversation with an agent", () => {
  test(
    "a message to the agent calls a connector tool and the reply streams back to the channel",
    async () => {
      const { workspaceId, w, general, ana, beto, lia } = await team();
      await stockFor(workspaceId, ana, lia);
      const socket = await TestSocket.open(beto.browser, workspaceId);
      expect((await socket.subscribe(general)).type).toBe("subscribed");
      const calledBefore = mcp.toolCalls.length;

      const sent = await post(ana, w, general, `@${lia.handle} [[tool:mcp_stock__list_items]]`, "live-1");
      expect(sent.status).toBe(201);
      await settle(server);

      const toolCall = await socket.event("run.tool_call");
      expect(toolCall.event).toMatchObject({ tool: "mcp_stock__list_items" });
      const result = await socket.event("run.tool_result");
      expect(result.event).toMatchObject({
        tool: "mcp_stock__list_items",
        ok: true,
        runId: toolCall.event.runId,
      });
      expect(mcp.toolCalls.slice(calledBefore).map((c) => c.name)).toEqual(["list_items"]);
      // The text arrives in pieces before the reply is posted, and the run ends.
      const delta = await socket.next(
        (f) => isEvent(f, "run.text_delta") && f.event.runId === toolCall.event.runId,
      );
      expect(delta.type).toBe("event");
      const authorOf = (f: RealtimeFrame) =>
        isEvent(f, "message.posted")
          ? (f.event.message as { author: { type: string; id: string } }).author
          : null;
      const reply = await socket.next((f) => authorOf(f)?.type === "agent");
      expect(authorOf(reply)?.id).toBe(lia.id);
      expect((await socket.event("run.completed")).event).toMatchObject({ runId: toolCall.event.runId });
      socket.close();

      const { messages } = (await call(beto, "GET", `${w}/channels/${general}/messages`)).body;
      expect(messages.map((m: { author: { type: string } }) => m.author.type)).toEqual(["person", "agent"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a channel rule that turns the connector off takes its tools away from the agent in that channel only",
    async () => {
      const { workspaceId, w, general, ana, beto, lia } = await team();
      const connectionId = await stockFor(workspaceId, ana, lia);
      const quiet = await seedChannel(server, workspaceId, { name: "quiet", members: [ana, beto] });
      await addToChannel(server, quiet, { type: "agent", id: lia.id });
      await server.deps.db
        .insert(schema.agentChannelAccess)
        .values({ agentId: lia.id, workspaceId, channelId: quiet, connectionId, level: "off" });
      const socket = await TestSocket.open(ana.browser, workspaceId);
      await socket.subscribe(quiet);
      const calledBefore = mcp.toolCalls.length;

      expect(
        (await post(ana, w, quiet, `@${lia.handle} [[tool:mcp_stock__list_items]]`, "rule-1")).status,
      ).toBe(201);
      await settle(server);
      expect((await socket.event("run.tool_result")).event).toMatchObject({ ok: false });
      expect(mcp.toolCalls.length).toBe(calledBefore);

      // In #general the same agent still has it.
      expect(
        (await post(ana, w, general, `@${lia.handle} [[tool:mcp_stock__list_items]]`, "rule-2")).status,
      ).toBe(201);
      await settle(server);
      expect(mcp.toolCalls.slice(calledBefore).map((c) => c.name)).toEqual(["list_items"]);
      socket.close();
    },
    SERVER_TEST_MS,
  );

  test(
    "a member of another workspace gets 404 on the conversation, as for an id that doesn't exist",
    async () => {
      const { w, general, ana, lia } = await team();
      const { body: root } = await post(ana, w, general, "a plan", "own-1");
      const outsider = await signedIn(server, "Zed", email("zed"));
      const other = await seedWorkspace(server, outsider, "Other");
      // Ids of the first workspace under the outsider's own workspace path, and the outsider under the first one.
      const ow = ws(other.workspaceId);
      const missingIds = (text: string) => text.replace(/(ch|msg|agt)_[a-z0-9]+/g, "$1_missing");
      const asMissing = async (path: string, method = "GET", payload?: unknown) => {
        const real = await call(outsider, method, path, payload);
        const missing = await call(
          outsider,
          method,
          missingIds(path),
          payload === undefined ? undefined : JSON.parse(missingIds(JSON.stringify(payload))),
        );
        expect([real.status, real.body?.error?.code]).toEqual([404, "not_found"]);
        expect([missing.status, missing.body]).toEqual([404, real.body]);
      };
      await asMissing(`${ow}/channels/${general}/messages`);
      await asMissing(`${ow}/channels/${general}/messages`, "POST", { body: "hi", clientId: "x-1" });
      await asMissing(`${ow}/channels/${general}/directory`);
      await asMissing(`${ow}/channels/${general}/members`);
      await asMissing(`${ow}/channels/${general}/pinned-messages`);
      await asMissing(`${ow}/channels/${general}/join`, "POST");
      await asMissing(`${ow}/channels/${general}/active-runs`);
      await asMissing(`${ow}/messages/${root.id}/reactions`);
      await asMissing(`${ow}/messages/${root.id}/reactions`, "POST", { reaction: "x" });
      await asMissing(`${ow}/threads/${root.id}/follow`, "PUT");
      await asMissing(`${ow}/dms`, "POST", { agentId: lia.id });
      // The first workspace's path itself: the outsider isn't a member.
      const notMember = await call(outsider, "GET", `${w}/channels/${general}/messages`);
      expect(notMember.status).toBe(404);
      // Nothing was written in the first workspace.
      const rows = await server.deps.db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.channelId, general));
      expect(rows.map((r) => r.id)).toEqual([root.id]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a message of a channel the person doesn't read answers exactly like a missing one",
    async () => {
      const { workspaceId, w, general, ana, beto } = await team();
      const board = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const { body: secret } = await post(ana, w, board, "board only", "secret-1");
      const same = async (method: string, path: (id: string) => string, payload?: unknown) => {
        const hidden = await call(beto, method, path(secret.id), payload);
        const missing = await call(beto, method, path("msg_missing"), payload);
        expect([hidden.status, hidden.body]).toEqual([missing.status, missing.body]);
        expect(hidden.status).toBe(404);
        return hidden.body.error.message as string;
      };
      expect(await same("GET", (id) => `${w}/messages/${id}/reactions`)).toBe("Message not found");
      await same("POST", (id) => `${w}/messages/${id}/reactions`, { reaction: "x" });
      await same("DELETE", (id) => `${w}/messages/${id}/reactions?reaction=x`);
      expect(await same("PUT", (id) => `${w}/threads/${id}/follow`)).toBe("Thread not found");
      await same("DELETE", (id) => `${w}/threads/${id}/follow`);
      // A pin of that message from a channel Beto reads is the same 404 too.
      await same("POST", (id) => `${w}/channels/${general}/pinned-messages/${id}`);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a double submit while the first post is still routing gives the same message and routes once",
    async () => {
      const { w, general, ana, lia } = await team();
      let entered!: () => void;
      let release!: () => void;
      const inRoute = new Promise<void>((r) => {
        entered = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      runtime.before = async () => {
        runtime.before = undefined;
        entered();
        await held;
      };
      const routedBefore = runtime.routed.length;
      const first = post(ana, w, general, `@${lia.handle} once`, "dup-1");
      let second: Awaited<ReturnType<typeof post>>;
      try {
        await Promise.race([
          inRoute,
          first.then(() => {
            throw new Error("the first post ended without reaching the runtime");
          }),
        ]);
        second = await post(ana, w, general, `@${lia.handle} once`, "dup-1");
      } finally {
        runtime.before = undefined;
        release();
      }
      const done = await first;
      expect([done.status, second.status]).toEqual([201, 200]);
      expect(second.body.id).toBe(done.body.id);
      // N more resends at once: still the one message, routed once.
      const burst = await Promise.all(
        Array.from({ length: 6 }, () => post(ana, w, general, `@${lia.handle} once`, "dup-1")),
      );
      expect(burst.map((r) => [r.status, r.body.id])).toEqual(burst.map(() => [200, done.body.id]));
      await settle(server);
      expect(runtime.routed.slice(routedBefore)).toEqual([done.body.id]);
    },
    SERVER_TEST_MS,
  );
});

describe("live runs show only where the person may see the run", () => {
  test(
    "a run of a private channel, of a delegation from one or of a debate still anonymous doesn't show",
    async () => {
      const { workspaceId, w, general, ana, beto, lia } = await team();
      const board = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const debateId = newId("deb");
      await server.deps.db.insert(schema.debates).values({
        id: debateId,
        workspaceId,
        title: "Price",
        goal: "Pick the price",
        channelId: general,
        createdBy: { type: "person", id: ana.user.id },
      });
      const live = async (
        what: string,
        at: { channelId: string; sourceChannelId?: string; debateId?: string },
      ) => {
        const runId = newId("run");
        await server.deps.db.insert(schema.runs).values({
          id: runId,
          workspaceId,
          agentId: lia.id,
          channelId: at.channelId,
          sourceChannelId: at.sourceChannelId ?? null,
          debateId: at.debateId ?? null,
          status: "running",
          what,
          model: "claude-haiku-5-5",
        });
        runtime.live.push({
          workspaceId,
          runId,
          agentId: lia.id,
          channelId: at.channelId,
          threadId: null,
          status: "running",
          startedAt: new Date().toISOString(),
          lastPingAt: new Date().toISOString(),
          initiatedBy: ana.user.id,
          sourceMessageId: null,
          browser: false,
        });
        return runId;
      };
      const open = await live("open work", { channelId: general });
      const secret = await live("board work", { channelId: board });
      const delegated = await live("asked from the board", { channelId: general, sourceChannelId: board });
      const anonymous = await live("a debate turn", { channelId: general, debateId });
      try {
        const runsOf = async (who: Person, path: string) =>
          (await call(who, "GET", path)).body.runs.map((r: { runId: string }) => r.runId).sort();
        expect(await runsOf(beto, `${w}/active-runs`)).toEqual([open]);
        expect(await runsOf(beto, `${w}/channels/${general}/active-runs`)).toEqual([open]);
        // Ana reads the board, but the debate hasn't revealed who spoke yet.
        expect(await runsOf(ana, `${w}/active-runs`)).toEqual([open, secret, delegated].sort());
        expect(await runsOf(ana, `${w}/channels/${general}/active-runs`)).toEqual([open, delegated].sort());
        expect(anonymous).toBeString();
      } finally {
        runtime.live.length = 0;
      }
    },
    SERVER_TEST_MS,
  );
});

describe("without the agent runtime", () => {
  let bare: RunningServer;
  beforeAll(async () => {
    bare = await startTestServer();
  }, SERVER_TEST_MS);
  afterAll(() => bare.stop(), SERVER_TEST_MS);

  /** Ana and Beto, Lia (who answers on mention only) in #general, and a #people channel without agents. */
  async function bareTeam() {
    const ana = await signedIn(bare, "Ana", email("ana"));
    const { workspaceId, general } = await seedWorkspace(bare, ana, "Bare");
    const beto = await memberOf(bare, workspaceId, "Beto", email("beto"));
    const people = await seedChannel(bare, workspaceId, { name: "people", members: [ana, beto] });
    const lia = await seedAgent(bare, workspaceId, ana, `lia${n}`, [general]);
    const w = ws(workspaceId);
    const send = (who: Person, channelId: string, body: string, extra: Record<string, unknown> = {}) =>
      call(who, "POST", `${w}/channels/${channelId}/messages`, { body, clientId: `c${++n}`, ...extra });
    const written = async (channelId: string) =>
      (
        await bare.deps.db
          .select({ body: schema.messages.body })
          .from(schema.messages)
          .where(eq(schema.messages.channelId, channelId))
      ).map((r) => r.body);
    return { workspaceId, w, general, people, ana, beto, lia, send, written };
  }
  const rejected = (res: { status: number; body: { error?: { code?: string } } }) =>
    expect([res.status, res.body.error?.code]).toEqual([503, "not_available"]);

  test(
    "a post goes out unless an agent would answer it: a mention, auto answer, a DM or a thread the agent is in",
    async () => {
      const { workspaceId, w, general, people, ana, beto, lia, send, written } = await bareTeam();
      // Lia answers on mention only: a plain post in her channel goes out, a mention of her is rejected unwritten.
      expect((await send(ana, general, "Quick update for the team")).status).toBe(201);
      rejected(await send(ana, general, `@${lia.handle} are you there?`));
      expect(await written(general)).toEqual(["Quick update for the team"]);
      // A mention where she isn't, or by someone she doesn't talk to, reaches no agent: it goes out.
      expect((await send(ana, people, `@${lia.handle} see this`)).status).toBe(201);
      await bare.deps.db
        .update(schema.agents)
        .set({ visibilityMode: "owner" })
        .where(eq(schema.agents.id, lia.id));
      expect((await send(beto, general, `@${lia.handle} take a look`)).status).toBe(201);
      await bare.deps.db
        .update(schema.agents)
        .set({ visibilityMode: "everyone" })
        .where(eq(schema.agents.id, lia.id));

      // A thread she already spoke in: a reply there reaches her, a reply in another thread doesn't.
      const spoke = (await send(ana, general, "Plan for Monday")).body;
      const quiet = (await send(ana, general, "Plan for Tuesday")).body;
      const channel = await channelInWorkspace(bare.deps.db, workspaceId, general);
      if (!channel) throw new Error("no channel");
      await postMessage(bare.deps, {
        workspaceId,
        channel,
        author: { type: "agent", id: lia.id },
        body: "On it",
        clientId: null,
        threadId: spoke.id,
      });
      rejected(await send(beto, general, "and the budget?", { threadId: spoke.id }));
      expect((await send(beto, general, "and the room?", { threadId: quiet.id })).status).toBe(201);

      // Auto answer: every post in the channel reaches her.
      await bare.deps.db
        .update(schema.channelMemberships)
        .set({ autoAnswer: true })
        .where(eq(schema.channelMemberships.memberId, lia.id));
      rejected(await send(ana, general, "Anyone?"));

      // Her DM: it isn't opened, and a post in one opened before is rejected.
      rejected(await call(ana, "POST", `${w}/dms`, { agentId: lia.id }));
      const dms = await bare.deps.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.kind, "dm"));
      expect(dms).toEqual([]);
      const dm = await openDm(bare.deps.db, {
        workspaceId,
        userId: ana.user.id,
        other: { type: "agent", id: lia.id },
      });
      rejected(await send(ana, dm, "hello"));

      // Archived, she answers nobody.
      await bare.deps.db
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, lia.id));
      expect((await send(ana, general, `@${lia.handle} still there?`)).status).toBe(201);
    },
    SERVER_TEST_MS,
  );

  test(
    "a resend of an accepted post answers it after an agent joined; a bad attachment doesn't make anyone a member",
    async () => {
      const { workspaceId, w, ana, beto, lia, send } = await bareTeam();
      const open = await seedChannel(bare, workspaceId, { name: "open", members: [ana] });
      const accepted = await call(beto, "POST", `${w}/channels/${open}/messages`, {
        body: "hi all",
        clientId: "r-1",
      });
      expect(accepted.status).toBe(201);
      await addToChannel(bare, open, { type: "agent", id: lia.id });
      await bare.deps.db
        .update(schema.channelMemberships)
        .set({ autoAnswer: true })
        .where(eq(schema.channelMemberships.memberId, lia.id));
      const again = await call(beto, "POST", `${w}/channels/${open}/messages`, {
        body: "hi all",
        clientId: "r-1",
      });
      expect([again.status, again.body.id]).toEqual([200, accepted.body.id]);

      const other = await seedChannel(bare, workspaceId, { name: "other", members: [ana] });
      const caio = await memberOf(bare, workspaceId, "Caio", email("caio"));
      const bad = await send(caio, other, "with a file", { attachments: ["file_missing"] });
      expect(bad.status).toBe(404);
      const { members } = (await call(ana, "GET", `${w}/channels/${other}/members`)).body;
      expect(members.map((m: { id: string }) => m.id)).toEqual([ana.user.id]);
      // The history isn't kept by a cache.
      const page = await ana.browser.fetch(`${w}/channels/${other}/messages`);
      expect(page.headers.get("cache-control")).toBe("private, no-store");
    },
    SERVER_TEST_MS,
  );

  test(
    "a rejected post doesn't make the person join a public channel",
    async () => {
      const { workspaceId, w, ana, beto, lia } = await bareTeam();
      const open = await seedChannel(bare, workspaceId, { name: "open", members: [ana] });
      await addToChannel(bare, open, { type: "agent", id: lia.id });
      const res = await call(beto, "POST", `${w}/channels/${open}/messages`, {
        body: `@${lia.handle} hi`,
        clientId: "j-1",
      });
      expect(res.status).toBe(503);
      const { members } = (await call(ana, "GET", `${w}/channels/${open}/members`)).body;
      expect(members.map((m: { id: string }) => m.id)).not.toContain(beto.user.id);
    },
    SERVER_TEST_MS,
  );
});
