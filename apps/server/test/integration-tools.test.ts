// The run's tools from integrations/tools: a connector's tools follow the level the workspace granted, a channel
// rule only lowers it there, `deny:` takes a tool away, and a connector call waiting for its approval runs only if
// the connection and the tool are still on when the person approves. The MCP server is the local fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import type { AgentRow } from "../src/agents";
import { type ChannelRow, channelInWorkspace } from "../src/channels";
import { replaceGrants } from "../src/integrations/access";
import { connectCustom, saveCustomTools } from "../src/integrations/connectors";
import { toolsFor } from "../src/integrations/tools";
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
});
