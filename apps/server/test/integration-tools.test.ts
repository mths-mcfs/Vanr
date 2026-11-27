// The run's tools from integrations/tools: a connector's tools follow the level the workspace granted, a channel
// rule only lowers it there, `deny:` takes a tool away, and a connector call waiting for its approval runs only if
// the connection and the tool are still on when the person approves. The MCP server is the local fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq, like } from "drizzle-orm";
import type { AgentRow } from "../src/agents";
import { type ChannelRow, channelInWorkspace } from "../src/channels";
import { replaceGrants } from "../src/integrations/access";
import { connectCustom, integrationSealer, saveCustomTools } from "../src/integrations/connectors";
import { argsValidator, toolsFor } from "../src/integrations/tools";
import type { RunningServer } from "../src/server";
import { type FakeMcp, startFakeMcp } from "./fake-mcp";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { toolRun } from "./integration-run";
import { seedAgent } from "./route-calls";
import { seedWorkspace } from "./seed";

const { connections, agentChannelAccess } = schema;

let server: RunningServer;
let mcp: FakeMcp;
beforeAll(async () => {
  mcp = startFakeMcp({ keyOnly: true });
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true" }, fetchExternal: fetch });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  mcp.stop();
}, SERVER_TEST_MS);

let n = 0;

/** An agent in #general with the fake "Stock" server connected (list_items read, create_item write). */
async function setup() {
  const ana = await signedIn(server, "Ana", `ana${++n}@integration-tools.test`);
  const { workspaceId, general } = await seedWorkspace(server, ana, "Tools");
  const agent = await seedAgent(server, workspaceId, ana, `lia${n}`, [general]);
  const me = { workspaceId, userId: ana.user.id, role: "owner" as const, handle: "ana", sessionId: "s" };
  const start = await connectCustom(server.deps, me, {
    serverUrl: mcp.url,
    apiKey: mcp.apiKey,
    label: "Stock",
    nextPath: "/back",
  });
  if (start.status !== "server") throw new Error(`expected a connected server, got ${start.status}`);
  const [row] = await server.deps.db.select().from(connections).where(eq(connections.id, start.server.id));
  if (!row) throw new Error("no connection");
  await saveCustomTools(server.deps, row, {
    label: "Stock",
    tools: [
      { name: "list_items", access: "read", label: "List items" },
      { name: "create_item", access: "write", label: "Create item" },
    ],
  });
  const channel = (await channelInWorkspace(server.deps.db, workspaceId, general)) as ChannelRow;
  return { workspaceId, channel, agent, connectionId: row.id };
}

const names = async (agent: AgentRow, channel: ChannelRow) =>
  (await toolsFor(server.deps, agent, { channel, threadId: null }))
    .map((t) => t.name)
    .filter((t) => t.startsWith("mcp_"))
    .sort();

describe("a connector's tools in the run", () => {
  test(
    "the workspace's level, a channel rule that only lowers it, and deny",
    async () => {
      const { workspaceId, channel, agent, connectionId } = await setup();
      const grant = (scopes: string[]) =>
        replaceGrants(
          server.deps.db,
          workspaceId,
          agent.id,
          scopes.map((scope) => ({ connectionId: scope.startsWith("custom:") ? connectionId : "", scope })),
        );
      expect(await names(agent, channel)).toEqual([]);
      await grant([`custom:${connectionId}:read`]);
      expect(await names(agent, channel)).toEqual(["mcp_stock__list_items"]);
      await grant([`custom:${connectionId}:read`, `custom:${connectionId}:write`]);
      expect(await names(agent, channel)).toEqual(["mcp_stock__create_item", "mcp_stock__list_items"]);

      // A `read` rule in this channel leaves only the reads; `approval` keeps the writes, asking a person.
      await server.deps.db
        .insert(agentChannelAccess)
        .values({ agentId: agent.id, workspaceId, channelId: channel.id, connectionId, level: "read" });
      expect(await names(agent, channel)).toEqual(["mcp_stock__list_items"]);
      await server.deps.db.update(agentChannelAccess).set({ level: "approval" });
      const tools = await toolsFor(server.deps, agent, { channel, threadId: null });
      const run = toolRun(server.deps, agent, channel);
      const out = await run.run(tools, "mcp_stock__create_item", { name: "bolt" });
      expect([out.isError, run.approvals.map((a) => a.tool)]).toEqual([true, ["mcp_stock__create_item"]]);

      await grant([
        `custom:${connectionId}:read`,
        `custom:${connectionId}:write`,
        "deny:mcp_stock__list_items",
      ]);
      expect(await names(agent, channel)).toEqual(["mcp_stock__create_item"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a call approved after the connection was revoked, or after its tool was turned off, isn't sent",
    async () => {
      const { workspaceId, channel, agent, connectionId } = await setup();
      await replaceGrants(server.deps.db, workspaceId, agent.id, [{ connectionId: "", scope: "*" }]);
      // Every write in this channel waits for a person.
      await server.deps.db
        .insert(agentChannelAccess)
        .values({ agentId: agent.id, workspaceId, channelId: channel.id, connectionId, level: "approval" });
      const tools = await toolsFor(server.deps, agent, { channel, threadId: null });
      const sent = mcp.toolCalls.length;
      const approvedAfter = (change: () => Promise<unknown>) =>
        toolRun(server.deps, agent, channel, {
          decide: async () => {
            await change();
            return "approved" as const;
          },
        }).run(tools, "mcp_stock__create_item", { name: "bolt" });
      const gone = [true, "This connection or tool is no longer available to the agent."];

      const off = await approvedAfter(async () => {
        const [row] = await server.deps.db.select().from(connections).where(eq(connections.id, connectionId));
        if (!row) throw new Error("no connection");
        await saveCustomTools(server.deps, row, {
          label: "Stock",
          tools: [{ name: "create_item", access: "off", label: "Create item" }],
        });
      });
      expect([off.isError, off.content]).toEqual(gone);

      // The tool back on: only the revoke stops the next call.
      const [row] = await server.deps.db.select().from(connections).where(eq(connections.id, connectionId));
      if (!row) throw new Error("no connection");
      await saveCustomTools(server.deps, row, {
        label: "Stock",
        tools: [{ name: "create_item", access: "write", label: "Create item" }],
      });
      const revoked = await approvedAfter(() =>
        server.deps.db
          .update(connections)
          .set({ revokedAt: new Date() })
          .where(eq(connections.id, connectionId)),
      );
      expect([revoked.isError, revoked.content]).toEqual(gone);
      expect(mcp.toolCalls.length).toBe(sent);
    },
    SERVER_TEST_MS,
  );

  test(
    "a call approved after the agent's level went down, in the channel or in its grants, isn't sent",
    async () => {
      const { workspaceId, channel, agent, connectionId } = await setup();
      const all = [{ connectionId: "", scope: "*" }];
      await replaceGrants(server.deps.db, workspaceId, agent.id, all);
      await server.deps.db
        .insert(agentChannelAccess)
        .values({ agentId: agent.id, workspaceId, channelId: channel.id, connectionId, level: "approval" });
      const tools = await toolsFor(server.deps, agent, { channel, threadId: null });
      const approvedAfter = (change: () => Promise<unknown>) =>
        toolRun(server.deps, agent, channel, {
          decide: async () => {
            await change();
            return "approved" as const;
          },
        }).run(tools, "mcp_stock__create_item", { name: "bolt" });
      const gone = [true, "This connection or tool is no longer available to the agent."];
      const sent = mcp.toolCalls.length;

      // Nothing changed while it waited: it goes out.
      expect((await approvedAfter(async () => {})).content).toBe("created: bolt");
      expect(mcp.toolCalls.length).toBe(sent + 1);

      const rule = (level: "read" | "approval") =>
        server.deps.db
          .update(agentChannelAccess)
          .set({ level })
          .where(eq(agentChannelAccess.agentId, agent.id));
      const readOnly = await approvedAfter(() => rule("read"));
      expect([readOnly.isError, readOnly.content]).toEqual(gone);
      await rule("approval");

      const denied = await approvedAfter(() =>
        replaceGrants(server.deps.db, workspaceId, agent.id, [
          ...all,
          { connectionId: "", scope: "deny:mcp_stock__create_item" },
        ]),
      );
      expect([denied.isError, denied.content]).toEqual(gone);

      const readGrant = await approvedAfter(() =>
        replaceGrants(server.deps.db, workspaceId, agent.id, [
          { connectionId, scope: `custom:${connectionId}:read` },
        ]),
      );
      expect([readGrant.isError, readGrant.content]).toEqual(gone);
      expect(mcp.toolCalls.length).toBe(sent + 1);
    },
    SERVER_TEST_MS,
  );
});

describe("a connector call while the run goes on", () => {
  test(
    "a tool whose access changed since the plan, to asking a person or to another class, goes back to the model",
    async () => {
      const { workspaceId, channel, agent, connectionId } = await setup();
      await replaceGrants(server.deps.db, workspaceId, agent.id, [{ connectionId: "", scope: "*" }]);
      const tools = await toolsFor(server.deps, agent, { channel, threadId: null });
      const sent = mcp.toolCalls.length;
      const [row] = await server.deps.db.select().from(connections).where(eq(connections.id, connectionId));
      if (!row) throw new Error("no connection");
      // The read was planned as K0, with no person; the workspace now asks for approval on it.
      await saveCustomTools(server.deps, row, {
        label: "Stock",
        tools: [{ name: "list_items", access: "approval", label: "List items" }],
      });
      const run = toolRun(server.deps, agent, channel);
      const out = await run.run(tools, "mcp_stock__list_items", {});
      expect([out.isError, out.content]).toEqual([
        true,
        'Stock: "List items" changed its access. Call it again.',
      ]);
      expect(run.approvals).toEqual([]);
      // A channel rule that starts asking now does the same to a write planned without a person.
      await server.deps.db
        .insert(agentChannelAccess)
        .values({ agentId: agent.id, workspaceId, channelId: channel.id, connectionId, level: "approval" });
      const write = await toolRun(server.deps, agent, channel).run(tools, "mcp_stock__create_item", {
        name: "x",
      });
      expect(write.content).toBe('Stock: "Create item" changed its access. Call it again.');
      expect(mcp.toolCalls.length).toBe(sent);
    },
    SERVER_TEST_MS,
  );

  test(
    "a credential stored again during the run is the one the next call sends",
    async () => {
      const { workspaceId, channel, agent, connectionId } = await setup();
      await replaceGrants(server.deps.db, workspaceId, agent.id, [{ connectionId: "", scope: "*" }]);
      const tools = await toolsFor(server.deps, agent, { channel, threadId: null });
      const run = toolRun(server.deps, agent, channel);
      expect((await run.run(tools, "mcp_stock__list_items", {})).content).toBe("bolt, nut");
      const stale = integrationSealer(server.deps).seal(
        JSON.stringify({ kind: "api_key", apiKey: "rotated" }),
      );
      await server.deps.db.update(connections).set({ secret: stale }).where(eq(connections.id, connectionId));
      const before = mcp.calls.length;
      const out = await run.run(tools, "mcp_stock__list_items", {});
      expect(out.isError).toBe(true);
      expect(mcp.calls.slice(before).map((c) => c.auth)).toContain("Bearer rotated");
    },
    SERVER_TEST_MS,
  );

  test(
    "a write whose answer never came keeps its effect key; a server that never opened the session releases it",
    async () => {
      const { workspaceId, channel, agent, connectionId } = await setup();
      await replaceGrants(server.deps.db, workspaceId, agent.id, [{ connectionId: "", scope: "*" }]);
      const tools = await toolsFor(server.deps, agent, { channel, threadId: null });
      const keys = async (effectKey: string) =>
        server.deps.db
          .select()
          .from(schema.effectKeys)
          .where(like(schema.effectKeys.key, `${effectKey}:%`));
      const pointAt = (url: string) =>
        server.deps.db.update(connections).set({ serverUrl: url }).where(eq(connections.id, connectionId));

      // The session opens, then the call's answer is lost: the write may have happened.
      const lossy = Bun.serve({
        port: 0,
        async fetch(req) {
          const msg = (await req.json()) as { id?: number; method: string };
          if (msg.method === "initialize")
            return Response.json({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "lossy" },
              },
            });
          if (msg.method === "tools/call") return new Response("upstream reset", { status: 502 });
          return new Response(null, { status: 202 });
        },
      });
      try {
        await pointAt(`http://localhost:${lossy.port}/mcp`);
        const run = toolRun(server.deps, agent, channel, { effectKey: `lost_${connectionId}` });
        await expect(run.run(tools, "mcp_stock__create_item", { name: "bolt" })).rejects.toThrow(
          "Stock failed",
        );
        expect(await keys(`lost_${connectionId}`)).toHaveLength(1);
      } finally {
        lossy.stop(true);
      }

      // Nobody answers the session: nothing was sent, the key goes and a retry may do it.
      const gone = startFakeMcp({ keyOnly: true });
      await pointAt(gone.url);
      gone.stop();
      const run = toolRun(server.deps, agent, channel, { effectKey: `closed_${connectionId}` });
      const out = await run.run(tools, "mcp_stock__create_item", { name: "bolt" });
      expect([out.isError, out.content.startsWith("Stock failed")]).toEqual([true, true]);
      expect(await keys(`closed_${connectionId}`)).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("a connector tool's arguments", () => {
  test("a required key must be the argument's own, not one every object inherits", () => {
    const check = argsValidator({ type: "object", required: ["constructor", "toString"] });
    expect(check.safeParse({}).success).toBe(false);
    expect(check.safeParse({ constructor: 1, toString: "x" }).success).toBe(true);
  });

  test("with no extras allowed, a key a pattern matches is still allowed", () => {
    const check = argsValidator({
      type: "object",
      patternProperties: { "^x_": { type: "string" } },
      additionalProperties: false,
    });
    expect(check.safeParse({ x_item: "bolt" }).success).toBe(true);
    expect(check.safeParse({ y_item: "bolt" }).success).toBe(false);
  });
});
