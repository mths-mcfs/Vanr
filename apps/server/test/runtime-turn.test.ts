// One whole agent turn through the chat route and the agent runtime, with the engine's fake model behind a recorder:
// what the model is given (the agent's instructions, the workspace's context, the agent's memory and skills, the
// conversation and the tools), the tool it calls, the reservation on the agent's budget and the usage ledger, the
// streamed reply and the run's record. Sending the same post again (the same clientId) runs nothing a second time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { and, eq } from "drizzle-orm";
import { createMemory } from "../src/agent-memory";
import { agentBudgetScope } from "../src/agents";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, TestSocket } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { seedWorkspace } from "./seed";

const { runs, runEvents, messages, usageLines, messageDispatches, skills, skillGrants, workspaces, agents } =
  schema;

/** Every request the model got, in order. */
const seen: ModelRequest[] = [];
let server: RunningServer;
beforeAll(async () => {
  const fake = fakeProvider();
  server = await startTestServer({
    modelProvider: {
      kind: "fake",
      stream: (req) => {
        seen.push(req);
        return fake.stream(req);
      },
    },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const textOf = (req: ModelRequest) =>
  req.messages.flatMap((m) => m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))).join("\n");

describe("one agent turn", () => {
  test(
    "context, a tool, the budget, the reply and the ledger; the same post sent again runs nothing more",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@turn.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Bakery");
      await server.deps.db
        .update(workspaces)
        .set({ context: "We bake sourdough in Lisbon." })
        .where(eq(workspaces.id, workspaceId));
      const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
      await server.deps.db
        .update(agents)
        .set({ instructions: "Answer in one line.", budgetPerMonthUsd: 5 })
        .where(eq(agents.id, lia.id));
      await createMemory(
        server.deps.db,
        new Date(),
        {
          workspaceId,
          agentId: lia.id,
          scope: "agent",
          path: null,
          text: "Orders close at 6pm.",
          untrustedSource: false,
          origin: { by: null, name: null, channel: null, at: new Date().toISOString() },
        },
        { author: { type: "system" } },
      );
      const skillId = newId("skl");
      await server.deps.db.insert(skills).values({
        id: skillId,
        workspaceId,
        name: "Pricing",
        description: "How we price",
        body: "# Pricing",
      });
      await server.deps.db.insert(skillGrants).values({ agentId: lia.id, skillId, enabled: true });

      const socket = await TestSocket.open(ana.browser, workspaceId);
      await socket.subscribe(general);
      const before = seen.length;
      const path = `${ws(workspaceId)}/channels/${general}/messages`;
      const body = `@${lia.handle} got the flour? [[tool:react {"emoji":"👍"}]]`;
      const posted = await call(ana, "POST", path, { body, clientId: "turn-1" });
      expect(posted.status).toBe(201);
      await settle(server);

      // What the model got: the agent, the workspace, the memory, the skills, the conversation and the tools.
      const turn = seen.slice(before);
      expect(turn.length).toBe(2);
      const [first] = turn;
      if (!first) throw new Error("no model call");
      expect(first.system).toContain("You are Lia (@lia)");
      expect(first.system).toContain("Answer in one line.");
      expect(first.system).toContain("We bake sourdough in Lisbon.");
      expect(first.system).toContain("Orders close at 6pm.");
      expect(first.system).toContain("- Pricing: How we price");
      expect(textOf(first)).toContain(`Ana (@ana): ${body}`);
      expect(first.tools.map((t) => t.name)).toContain("react");

      // The run: running, the tool call and its result, the reply streamed and posted, the run done.
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, posted.body.id));
      if (!run) throw new Error("no run");
      expect([run.status, run.agentId, run.channelId]).toEqual(["done", lia.id, general]);
      const steps = await server.deps.db.select().from(runEvents).where(eq(runEvents.runId, run.id));
      expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "text"]);
      expect(steps[0]?.data).toMatchObject({ name: "react" });
      // The tool did its effect: the agent's reaction on Ana's message.
      const [reaction] = await server.deps.db
        .select()
        .from(schema.emojiReactions)
        .where(eq(schema.emojiReactions.messageId, posted.body.id));
      expect(reaction).toMatchObject({ actorType: "agent", actorId: lia.id, reaction: "👍" });
      expect((await socket.event("run.tool_call")).event).toMatchObject({
        runId: run.id,
        tool: "react",
      });
      expect((await socket.event("run.text_delta")).event.runId).toBe(run.id);
      expect((await socket.event("run.completed")).event).toMatchObject({ runId: run.id, status: "done" });
      socket.close();
      const [reply] = await server.deps.db
        .select()
        .from(messages)
        .where(and(eq(messages.runId, run.id), eq(messages.authorKind, "agent")));
      expect(reply).toMatchObject({ authorId: lia.id, channelId: general });
      expect(reply?.meta).toMatchObject({ toolSteps: 1, testModel: true });
      const [dispatch] = await server.deps.db
        .select()
        .from(messageDispatches)
        .where(eq(messageDispatches.messageId, posted.body.id));
      expect(dispatch).toMatchObject({
        agentId: lia.id,
        state: "handled",
        status: "answered",
        runId: run.id,
      });

      // Each model call is a line in the ledger, reserved on the agent's month first; the run carries the total.
      const lines = await server.deps.db.select().from(usageLines).where(eq(usageLines.runId, run.id));
      expect(lines).toHaveLength(2);
      expect(lines.every((l) => l.source === "chat" && l.agentId === lia.id && l.costMicros > 0)).toBe(true);
      const total = lines.reduce((sum, l) => sum + l.costMicros, 0) / 1_000_000;
      expect(run.costUsd).toBeCloseTo(total, 6);
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, lia.id));
      if (!agent) throw new Error("no agent");
      const spent = await server.deps.ledger.spent(await agentBudgetScope(server.deps.db, agent), new Date());
      expect(spent).toBeCloseTo(total, 6);
      // No reservation is left open: each was settled by its line.
      const reserved = await server.deps.db
        .select()
        .from(schema.usageReservations)
        .where(eq(schema.usageReservations.workspaceId, workspaceId));
      expect(reserved.map((r) => r.status)).toEqual(["settled", "settled"]);

      // The same post again: the same message back, and nothing runs, posts or is charged a second time.
      const again = await call(ana, "POST", path, { body, clientId: "turn-1" });
      expect([again.status, again.body.id]).toEqual([200, posted.body.id]);
      await settle(server);
      expect(seen.length - before).toBe(2);
      expect(await server.deps.db.select().from(runs).where(eq(runs.agentId, lia.id))).toHaveLength(1);
      expect(
        await server.deps.db.select().from(usageLines).where(eq(usageLines.agentId, lia.id)),
      ).toHaveLength(2);
      const replies = await server.deps.db
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, general), eq(messages.authorKind, "agent")));
      expect(replies).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );
});
