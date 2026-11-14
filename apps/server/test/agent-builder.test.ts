// "Describe it and I build it" (agent-builder.ts). Drafting calls the agent runtime (the workspace's provider for a
// new agent, a completion paid by the agent for an existing one), which comes with S6: here the entries are proven
// to refuse before taking anything, and the draft's validation (`toDraft`, where everything the model returns goes
// through) is proven on its own, with replies a model could send.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import {
  DRAFT_MODELS,
  DRAFTS_PER_HOUR,
  draftNewAgent,
  proposeFromDescription,
  toDraft,
} from "../src/agent-builder";
import type { AgentRow } from "../src/agents";
import type { WorkspaceMember } from "../src/context";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const skills = [
  { id: "sk_1", name: "Invoices", description: "Reads invoices" },
  { id: "sk_2", name: "Refunds", description: "Handles refunds" },
];

async function existingAgent(): Promise<{ me: WorkspaceMember; agent: AgentRow }> {
  const ana = await signedIn(server, "Ana", `ana${newId("x")}@builder.test`);
  const { workspaceId } = await seedWorkspace(server, ana, "Builder");
  const [agent] = await server.deps.db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: "Lia",
      handle: "lia",
      role: "support",
      model: "claude-opus-5-5",
      instructions: "Be brief.",
      ownerUserId: ana.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  if (!agent) throw new Error("no agent");
  return { me: { workspaceId, userId: ana.user.id, role: "owner", handle: "ana" }, agent };
}

describe("the draft", () => {
  test("a new agent: only catalog roles, only Haiku or Opus, only the workspace's skills, a free handle", () => {
    const ctx = {
      workspaceSkills: skills,
      taken: new Set(["sales", "sales-2"]),
      current: null,
      testModel: false,
    };
    const draft = toDraft(
      {
        name: "  Sales helper  ",
        handle: "Sales",
        role: "overlord",
        instructions: "  Help with sales.  ",
        model: "claude-sonnet-5-5",
        skills: ["invoices", "INVOICES", "Hacking", "Refunds"],
        why: "Because.",
      },
      ctx,
    );
    expect(draft).toEqual({
      name: "Sales helper",
      handle: "sales-3",
      role: "custom",
      instructions: "Help with sales.",
      model: "claude-haiku-5-5",
      skillIds: ["sk_1", "sk_2"],
      why: "Because.",
      testModel: false,
    });
    expect(DRAFT_MODELS).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(toDraft({ instructions: "x", model: "claude-opus-5-5" }, ctx).model).toBe("claude-opus-5-5");
    for (const model of ["made-up-model", "gpt-6", ""])
      expect(toDraft({ instructions: "x", model }, ctx).model).toBe("claude-haiku-5-5");
    // A handle that isn't one falls back to the name, then to "agent".
    expect(toDraft({ name: "Ünïcode Bot", handle: "!!", instructions: "x" }, ctx).handle).toBe("unicode-bot");
    expect(toDraft({ name: "", handle: "", instructions: "x" }, ctx)).toMatchObject({
      name: "Agent",
      handle: "agent",
    });
    expect(toDraft({ instructions: "y".repeat(25_000) }, ctx).instructions.length).toBe(20_000);
  });

  test(
    "an existing agent: the handle never changes, an invalid role or model keeps the agent's own",
    async () => {
      const { agent } = await existingAgent();
      const draft = toDraft(
        { name: "", handle: "takeover", role: "nonsense", model: "nonsense", instructions: "" },
        { workspaceSkills: [], taken: new Set(), current: agent, testModel: true },
      );
      expect(draft).toMatchObject({
        name: "Lia",
        handle: "lia",
        role: "support",
        model: "claude-opus-5-5",
        instructions: "Be brief.",
        testModel: true,
      });
    },
    SERVER_TEST_MS,
  );
});

describe("without the runtime", () => {
  test(
    "both entries refuse with not_available before the hourly slot or a proposal is taken",
    async () => {
      const { me, agent } = await existingAgent();
      for (let i = 0; i < DRAFTS_PER_HOUR + 2; i++) {
        await expect(draftNewAgent(server.deps, me, "A sales helper")).rejects.toMatchObject({
          status: 503,
          code: "not_available",
          params: { method: "providerForWorkspace" },
        });
        await expect(proposeFromDescription(server.deps, me, agent, "Answer in lists")).rejects.toMatchObject(
          {
            status: 503,
            code: "not_available",
            params: { method: "complete" },
          },
        );
      }
      const written = await server.deps.db
        .select()
        .from(schema.proposals)
        .where(eq(schema.proposals.workspaceId, me.workspaceId));
      expect(written).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});
