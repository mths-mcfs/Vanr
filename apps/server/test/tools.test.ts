// The harness's built-in tools on a real database: the registry an agent gets from its grants, each tool's
// writes and refusals, and the once-only rule of outside effects in a routine execution. The runtime (the
// model loop that builds the context) comes with a later module, so the context here is built by hand: the
// real deps and rows, with recorders for what the runtime would do (approvals, cards, receipts).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { AgentAction } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { RiskTracker } from "@vanr/engine/effects";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ChannelRow } from "../src/channels";
import { allowance, grantsOf, replaceGrants } from "../src/integrations/access";
import { postMessage } from "../src/messages";
import {
  BUILTIN_TOOLS,
  define,
  runTool,
  SKILL_PART_CHARS,
  type ToolContext,
  type ToolDef,
  ToolInputError,
  toolSpecs,
} from "../src/runtime/tools";
import type { RunningServer } from "../src/server";
import { signedIn, startTestServer } from "./harness";
import { seedChannel, seedWorkspace } from "./seed";

setDefaultTimeout(30_000);

let server: RunningServer;
beforeAll(async () => {
  // The harness turns the undo window off, so post_message posts at once (the window needs the runtime's timer).
  server = await startTestServer();
});
afterAll(() => server.stop());

const { agents, channels, memories, reminders, skills, skillGrants, emojiReactions, proposals, effectKeys } =
  schema;

let n = 0;
async function seedAgent(workspaceId: string, ownerUserId: string, name = "Lia") {
  const id = newId("agent");
  n++;
  await server.deps.db.insert(agents).values({
    id,
    workspaceId,
    name,
    handle: `${name.toLowerCase()}${n}`,
    model: "claude-haiku-5-5",
    ownerUserId,
    instructions: "Be brief.",
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  const [row] = await server.deps.db.select().from(agents).where(eq(agents.id, id));
  if (!row) throw new Error("agent not seeded");
  return row;
}

async function channelRow(id: string): Promise<ChannelRow> {
  const [row] = await server.deps.db.select().from(channels).where(eq(channels.id, id));
  if (!row) throw new Error("channel not found");
  return row;
}

type Recorded = {
  kind: AgentAction["kind"];
  target: AgentAction["target"];
  params?: Record<string, unknown>;
};

/** A workspace with a person, an agent and #general; `ctx()` is a run of that agent in #general. */
async function setup(label: string) {
  const ana = await signedIn(server, "Ana", `ana.${label}@tools.test`);
  const { workspaceId, general } = await seedWorkspace(server, ana, `Tools ${label}`);
  const agent = await seedAgent(workspaceId, ana.user.id);
  const channel = await channelRow(general);
  const actions: Recorded[] = [];
  const cards: { body: string; meta: unknown }[] = [];
  const delegated: { handle: string; question: string }[] = [];
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    deps: server.deps,
    workspaceId,
    agent,
    channel,
    runId: newId("run"),
    threadId: null,
    trigger: null,
    signal: new AbortController().signal,
    risk: new RiskTracker(),
    async delegate(target, question) {
      delegated.push({ handle: target.handle, question });
      return `answer from @${target.handle}`;
    },
    async requestApproval() {
      throw new Error("should not ask");
    },
    async settleApproval() {},
    async recordDecision() {},
    async standingRule() {
      return null;
    },
    async review() {
      return null;
    },
    async ask() {
      return null;
    },
    async recordAction(action) {
      actions.push(action);
    },
    async postCard(body, meta) {
      cards.push({ body, meta });
      const { message } = await postMessage(server.deps, {
        workspaceId,
        channel,
        author: { type: "agent", id: agent.id },
        body,
        meta,
        clientId: null,
      });
      return message;
    },
    toolOutput() {},
    ...over,
  });
  return { ana, workspaceId, general, agent, channel, actions, cards, delegated, ctx };
}

const run = (ctx: ToolContext, name: string, input: unknown) => runTool(ctx, BUILTIN_TOOLS, name, input);

describe("the tool registry", () => {
  test("the built-in names follow the vocabulary and each spec is an object schema the model can read", () => {
    expect(BUILTIN_TOOLS.map((t) => t.name)).toEqual([
      "remember",
      "edit_memory",
      "forget",
      "search",
      "react",
      "schedule_reminder",
      "list_reminders",
      "delete_reminder",
      "use_skill",
      "open_skill_file",
      "delegate_to_agent",
      "post_message",
      "ask_user",
      "propose_instruction_change",
      "propose_context_change",
    ]);
    const specs = toolSpecs(BUILTIN_TOOLS);
    for (const s of specs) {
      expect([s.name, s.inputSchema.type, "$schema" in s.inputSchema]).toEqual([s.name, "object", false]);
      expect(s.description.length).toBeGreaterThan(10);
    }
    const remember = specs.find((s) => s.name === "remember");
    expect(remember?.inputSchema.required).toEqual(["text"]);
  });

  test("an agent sees only the built-ins its grants allow, and a denied tool is gone", async () => {
    const t = await setup("grants");
    const visible = async () => {
      const allow = allowance(await grantsOf(server.deps.db, t.agent.id));
      return BUILTIN_TOOLS.filter((tool) => allow.builtin(tool.name)).map((tool) => tool.name);
    };
    const conversation = [
      "react",
      "delegate_to_agent",
      "post_message",
      "ask_user",
      "propose_instruction_change",
      "propose_context_change",
    ];
    expect(await visible()).toEqual(conversation);
    await replaceGrants(server.deps.db, t.workspaceId, t.agent.id, [
      { connectionId: "", scope: "context:write" },
      { connectionId: "", scope: "skills:read" },
      { connectionId: "", scope: "deny:post_message" },
    ]);
    expect(await visible()).toEqual([
      "remember",
      "edit_memory",
      "forget",
      "search",
      "react",
      "use_skill",
      "open_skill_file",
      "delegate_to_agent",
      "ask_user",
      "propose_instruction_change",
      "propose_context_change",
    ]);
  });

  test("an unknown tool, a bad input and a tool refusal come back as errors the model can correct", async () => {
    const t = await setup("errors");
    expect(await run(t.ctx(), "nope", {})).toEqual({ content: "Unknown tool nope", isError: true });
    const bad = await run(t.ctx(), "remember", { text: "" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toStartWith("Invalid input:");
    expect(await run(t.ctx(), "react", { emoji: "👍" })).toEqual({
      content: "No message to react to",
      isError: true,
    });
  });
});

describe("memory tools", () => {
  test("remember saves to the agent's own store; replaces archives the old one", async () => {
    const t = await setup("remember");
    const first = await run(t.ctx(), "remember", { text: "The client is Acme", kind: "fact" });
    expect(first.isError).toBe(false);
    const [row] = await server.deps.db.select().from(memories).where(eq(memories.agentId, t.agent.id));
    expect(row).toMatchObject({ text: "The client is Acme", scope: "agent", workspaceId: t.workspaceId });
    const second = await run(t.ctx(), "remember", { text: "The client is Acme Inc", replaces: row?.id });
    expect(second.content).toContain(`it replaces ${row?.id}`);
    const live = await server.deps.db
      .select({ text: memories.text })
      .from(memories)
      .where(and(eq(memories.agentId, t.agent.id), eq(memories.archived, false)));
    expect(live.map((m) => m.text)).toEqual(["The client is Acme Inc"]);
    expect(t.actions.map((a) => a.kind)).toEqual(["memory_recorded", "memory_recorded"]);
  });

  test("a memory replaced from another channel is announced here without that channel's name", async () => {
    const t = await setup("replaces-origin");
    const secret = await seedChannel(server, t.workspaceId, {
      name: "secret-ops",
      visibility: "private",
      members: [t.ana],
    });
    const runIn = async (channelId: string) => {
      const id = newId("run");
      await server.deps.db.insert(schema.runs).values({
        id,
        workspaceId: t.workspaceId,
        agentId: t.agent.id,
        channelId,
        status: "running",
        model: "claude-haiku-5-5",
      });
      return id;
    };
    const there = await run(
      t.ctx({ channel: await channelRow(secret), runId: await runIn(secret) }),
      "remember",
      {
        text: "The merger closes Friday",
      },
    );
    expect(there.isError).toBe(false);
    const [old] = await server.deps.db.select().from(memories).where(eq(memories.agentId, t.agent.id));
    expect(old?.origin?.channel).toBe("#secret-ops");
    const announced: {
      channelId: string;
      memory: { id: string; origin: { channel: string | null } | null };
    }[] = [];
    const { hub } = server.deps;
    const toChannel = hub.toChannel.bind(hub);
    hub.toChannel = (channelId, event) => {
      if (event.type === "memory.recorded")
        announced.push({
          channelId,
          memory: (event as unknown as { memory: (typeof announced)[number]["memory"] }).memory,
        });
      return toChannel(channelId, event);
    };
    try {
      await run(t.ctx({ runId: await runIn(t.general) }), "remember", {
        text: "It moved to Monday",
        replaces: old?.id,
      });
    } finally {
      hub.toChannel = toChannel;
    }
    expect(announced.map((a) => [a.channelId, a.memory.id === old?.id, a.memory.origin?.channel])).toEqual([
      [t.general, true, null],
      [t.general, false, "#general"],
    ]);
  });

  test("after reading outside content (flag A) a memory write waits for review and nothing is saved", async () => {
    const t = await setup("review");
    const ctx = t.ctx();
    ctx.risk.raise({ flag: "A", source: "email from x@outside.test" });
    const out = await run(ctx, "remember", { text: "Wire the money to account 123" });
    expect(out.content).toStartWith(
      "Not saved yet: this run read content from outside (email from x@outside.test)",
    );
    expect(await server.deps.db.select().from(memories).where(eq(memories.agentId, t.agent.id))).toEqual([]);
    const queued = await server.deps.db
      .select()
      .from(schema.memoryReviews)
      .where(eq(schema.memoryReviews.agentId, t.agent.id));
    expect(queued.map((q) => [q.op, q.text])).toEqual([["create", "Wire the money to account 123"]]);
    expect(t.actions).toEqual([]);
  });

  test("edit_memory and forget reach only the agent's own memories", async () => {
    const t = await setup("own");
    await run(t.ctx(), "remember", { text: "Mine" });
    const [mine] = await server.deps.db.select().from(memories).where(eq(memories.agentId, t.agent.id));
    const other = await setup("own-other");
    await run(other.ctx(), "remember", { text: "Theirs" });
    const [theirs] = await server.deps.db.select().from(memories).where(eq(memories.agentId, other.agent.id));
    expect(await run(t.ctx(), "edit_memory", { id: theirs?.id, text: "Hijacked" })).toEqual({
      content: `Memory ${theirs?.id} not found`,
      isError: true,
    });
    expect((await run(t.ctx(), "forget", { id: theirs?.id })).isError).toBe(true);
    expect((await run(t.ctx(), "edit_memory", { id: mine?.id, text: "Mine, edited" })).isError).toBe(false);
    expect((await run(t.ctx(), "forget", { id: mine?.id })).isError).toBe(false);
    const rows = await server.deps.db
      .select()
      .from(memories)
      .where(eq(memories.id, theirs?.id ?? ""));
    expect(rows.map((r) => [r.text, r.archived])).toEqual([["Theirs", false]]);
  });
});

describe("conversation tools", () => {
  test("react adds the agent's reaction to the calling message once", async () => {
    const t = await setup("react");
    const { message } = await postMessage(server.deps, {
      workspaceId: t.workspaceId,
      channel: t.channel,
      author: { type: "person", id: t.ana.user.id },
      body: "Done?",
      clientId: null,
    });
    const ctx = t.ctx({ trigger: { id: message.id, authorId: t.ana.user.id, authorName: "Ana" } });
    expect(await run(ctx, "react", { emoji: "👍" })).toEqual({ content: "Reacted with 👍.", isError: false });
    await run(ctx, "react", { emoji: "👍" });
    const rows = await server.deps.db
      .select()
      .from(emojiReactions)
      .where(eq(emojiReactions.messageId, message.id));
    expect(rows.map((r) => [r.reaction, r.actorType, r.actorId])).toEqual([["👍", "agent", t.agent.id]]);
  });

  test("reminders: not in the past; listed and deleted only by the agent that made them", async () => {
    const t = await setup("reminders");
    const past = await run(t.ctx(), "schedule_reminder", { text: "Late", at: "2020-01-01T00:00:00Z" });
    expect(past).toEqual({ content: "The time is in the past", isError: true });
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect((await run(t.ctx(), "schedule_reminder", { text: "Call Acme", at })).isError).toBe(false);
    const [rem] = await server.deps.db.select().from(reminders).where(eq(reminders.agentId, t.agent.id));
    expect(rem).toMatchObject({ text: "Call Acme", channelId: t.general, workspaceId: t.workspaceId });
    expect((await run(t.ctx(), "list_reminders", {})).content).toContain("Call Acme");
    const other = await setup("reminders-other");
    expect(await run(other.ctx(), "delete_reminder", { id: rem?.id })).toEqual({
      content: `Reminder ${rem?.id} not found`,
      isError: true,
    });
    expect((await run(t.ctx(), "delete_reminder", { id: rem?.id })).isError).toBe(false);
    expect((await run(t.ctx(), "list_reminders", {})).content).toBe("No scheduled reminders.");
    expect(t.actions.map((a) => a.kind)).toEqual(["reminder_created"]);
  });

  test("a reminder whose receipt fails is not kept", async () => {
    const t = await setup("reminder-receipt");
    const ctx = t.ctx({
      async recordAction() {
        throw new Error("receipt write failed");
      },
    });
    const at = new Date(Date.now() + 3600_000).toISOString();
    await expect(run(ctx, "schedule_reminder", { text: "Call Acme", at })).rejects.toThrow(
      "receipt write failed",
    );
    expect(await server.deps.db.select().from(reminders).where(eq(reminders.agentId, t.agent.id))).toEqual(
      [],
    );
  });

  test("use_skill comes in parts with the files at the end; a disabled or foreign skill is rejected", async () => {
    const t = await setup("skills");
    const skill = async (workspaceId: string, name: string, enabled: boolean) => {
      const id = newId("skill");
      await server.deps.db.insert(skills).values({
        id,
        workspaceId,
        name,
        body: `${"a".repeat(SKILL_PART_CHARS)}tail`,
        files: [
          { path: "guide.md", status: "ok", mime: "text/markdown", text: "# Guide" },
          { path: "big.bin", status: "skipped", mime: "application/octet-stream" },
        ],
      });
      await server.deps.db.insert(skillGrants).values({ agentId: t.agent.id, skillId: id, enabled });
    };
    await skill(t.workspaceId, "tone", true);
    await skill(t.workspaceId, "off", false);
    const other = await setup("skills-other");
    await skill(other.workspaceId, "foreign", true);

    const one = await run(t.ctx(), "use_skill", { name: "tone" });
    expect(one.content).toEndWith("[Part 1 of 2. Call use_skill with part 2 for the rest.]");
    expect((await run(t.ctx(), "use_skill", { name: "tone", part: 2 })).content).toBe(
      "tail\n\nFiles (open_skill_file): guide.md",
    );
    expect((await run(t.ctx(), "use_skill", { name: "tone", part: 3 })).content).toBe(
      "Skill tone has 2 part(s)",
    );
    expect((await run(t.ctx(), "open_skill_file", { skill: "tone", path: "guide.md" })).content).toBe(
      "# Guide",
    );
    expect((await run(t.ctx(), "open_skill_file", { skill: "tone", path: "big.bin" })).isError).toBe(true);
    for (const name of ["off", "foreign"]) {
      expect(await run(t.ctx(), "use_skill", { name })).toEqual({
        content: `You don't have the skill ${name} enabled`,
        isError: true,
      });
    }
  });

  test("delegate_to_agent reaches only active agents of the same workspace, never itself", async () => {
    const t = await setup("delegate");
    const bob = await seedAgent(t.workspaceId, t.ana.user.id, "Bob");
    const gone = await seedAgent(t.workspaceId, t.ana.user.id, "Gone");
    await server.deps.db.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, gone.id));
    const other = await setup("delegate-other");
    const far = await seedAgent(other.workspaceId, other.ana.user.id, "Far");

    expect(await run(t.ctx(), "delegate_to_agent", { handle: `@${bob.handle}`, question: "Price?" })).toEqual(
      {
        content: `answer from @${bob.handle}`,
        isError: false,
      },
    );
    for (const handle of [gone.handle, far.handle]) {
      expect(await run(t.ctx(), "delegate_to_agent", { handle, question: "Hi" })).toEqual({
        content: `No agent @${handle}`,
        isError: true,
      });
    }
    expect(
      (await run(t.ctx(), "delegate_to_agent", { handle: t.agent.handle, question: "Hi" })).content,
    ).toBe("You cannot delegate to yourself");
    expect(t.delegated).toEqual([{ handle: bob.handle, question: "Price?" }]);
  });

  test("post_message asks a person with the whole text, and posts only in a channel the agent can write in", async () => {
    const t = await setup("post");
    const sales = await seedChannel(server, t.workspaceId, { name: "sales", members: [t.ana] });
    await seedChannel(server, t.workspaceId, { name: "secret", visibility: "private", members: [t.ana] });
    const text = "x".repeat(300);
    const asked: { tool: string; card: unknown; preview: unknown }[] = [];
    const ctx = t.ctx({
      async requestApproval(req) {
        asked.push({ tool: req.tool, card: req.card, preview: req.preview });
        return {
          id: "apv1",
          decision: "approved",
          reason: null,
          byName: "Ana",
          payloadHash: req.payloadHash,
        };
      },
    });
    const out = await run(ctx, "post_message", { channel: "#sales", text });
    expect(out.isError).toBe(false);
    expect(asked[0]).toMatchObject({
      tool: "post_message",
      preview: { title: "Post in #sales", body: text },
      card: { scope: "chat:post_message", params: { channel: "#sales" } },
    });
    const posted = await server.deps.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, sales));
    expect(posted.map((m) => [m.body, m.authorKind])).toEqual([[text, "agent"]]);
    expect(t.actions.map((a) => a.kind)).toEqual(["message_posted"]);

    for (const [channel, error] of <[string, string][]>[
      ["general", "To post here, reply normally"],
      ["secret", "You are not in #secret"],
      ["nowhere", "No channel #nowhere"],
    ]) {
      expect(await run(ctx, "post_message", { channel, text: "hi" })).toEqual({
        content: error,
        isError: true,
      });
    }
    expect(asked).toHaveLength(1);
  });

  test("propose_context_change creates a pending proposal with its card; the same text is rejected", async () => {
    const t = await setup("propose");
    await server.deps.db
      .update(schema.workspaces)
      .set({ context: "We bake." })
      .where(eq(schema.workspaces.id, t.workspaceId));
    const same = await run(t.ctx(), "propose_context_change", {
      context: "We bake.",
      title: "Same",
      why: "No",
    });
    expect(same).toEqual({ content: "The proposed text is the same as the current one", isError: true });
    const out = await run(t.ctx(), "propose_context_change", {
      context: "We bake and sell online.",
      title: "Add online sales",
      why: "Clients ask for it",
    });
    expect(out.content).toEndWith("A person will review it; it changes nothing until accepted.");
    const [row] = await server.deps.db.select().from(proposals).where(eq(proposals.agentId, t.agent.id));
    expect(row).toMatchObject({
      targetKind: "workspace_context",
      before: "We bake.",
      after: "We bake and sell online.",
      status: "pending",
      recipientAgentId: null,
    });
    expect(row?.messageId).toBeString();
    expect(t.cards).toEqual([{ body: "Add online sales", meta: { proposalId: row?.id } }]);
    const [ws] = await server.deps.db
      .select({ context: schema.workspaces.context })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, t.workspaceId));
    expect(ws?.context).toBe("We bake.");
  });
});

describe("outside effects in a routine execution run once", () => {
  /** A K2 tool to an outside destination that counts its runs; `fail` decides how a run ends. */
  function outbound(fail: { mode: "none" | "crash" | "reject" | "reached" }) {
    const state = { ran: 0 };
    const tool = define({
      name: "send_out",
      description: "",
      effect: "K2",
      input: z.object({ text: z.string() }),
      async plan(_ctx, input) {
        return { destination: { kind: "external", allowed: true, target: "partner" }, payload: input };
      },
      async run(_ctx, input) {
        state.ran++;
        if (fail.mode === "crash") throw new Error("connection reset");
        if (fail.mode === "reject") throw new ToolInputError("Partner is closed");
        if (fail.mode === "reached") {
          const err = new ToolInputError("The partner did not answer in time");
          err.reached = true;
          throw err;
        }
        return `sent ${input.text}`;
      },
    }) as ToolDef<unknown>;
    return { state, tool };
  }

  test("the retry of the same execution gets the recorded result and doesn't send again", async () => {
    const t = await setup("once");
    const fail = { mode: "none" as const };
    const { state, tool } = outbound(fail);
    const effectKey = newId("rx");
    expect(await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" })).toEqual({
      content: "sent a",
      isError: false,
    });
    const again = await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" });
    expect(again).toEqual({
      content: "Already done in an earlier attempt of this routine run (not repeated):\nsent a",
      isError: false,
    });
    // Another payload or another execution is another effect.
    await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "b" });
    await runTool(t.ctx({ effectKey: newId("rx") }), [tool], "send_out", { text: "a" });
    expect(state.ran).toBe(3);
  });

  test("a refusal before the send frees the key; a failure after the send keeps it, and the retry doesn't send", async () => {
    const t = await setup("once-reached");
    const fail: { mode: "reject" | "reached" | "none" } = { mode: "reject" };
    const { state, tool } = outbound(fail);
    const effectKey = newId("rx");
    expect((await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" })).isError).toBe(true);
    fail.mode = "none";
    // Refused before anything went out: the retry may send it.
    expect(await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" })).toEqual({
      content: "sent a",
      isError: false,
    });
    // The request reached the partner and failed there (a timeout after the send): it may have gone out.
    fail.mode = "reached";
    const late = await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "b" });
    expect(late).toEqual({ content: "The partner did not answer in time", isError: true });
    fail.mode = "none";
    const retry = await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "b" });
    expect(retry.isError).toBe(true);
    expect(retry.content).toStartWith("Not repeated:");
    expect(state.ran).toBe(3);
  });

  test("an approved retry that finds the effect done settles its approval as done, not failed", async () => {
    const t = await setup("once-approved");
    const sent: string[] = [];
    const tool = define({
      name: "send_out",
      description: "",
      effect: "K2",
      input: z.object({ text: z.string() }),
      async plan(_ctx, input) {
        return {
          destination: { kind: "external", allowed: true, target: "partner" },
          policy: "ask",
          payload: input,
        };
      },
      async run(_ctx, input) {
        sent.push(input.text);
        return `sent ${input.text}`;
      },
    }) as ToolDef<unknown>;
    const settled: { id: string; ok: boolean }[] = [];
    const effectKey = newId("rx");
    const ctx = () =>
      t.ctx({
        effectKey,
        async requestApproval(req) {
          return {
            id: `apv${settled.length + 1}`,
            decision: "approved",
            reason: null,
            byName: "Ana",
            payloadHash: req.payloadHash,
          };
        },
        async settleApproval(id, result) {
          settled.push({ id, ok: result.ok });
        },
      });
    await runTool(ctx(), [tool], "send_out", { text: "a" });
    const again = await runTool(ctx(), [tool], "send_out", { text: "a" });
    expect(again.isError).toBe(false);
    expect(sent).toEqual(["a"]);
    expect(settled).toEqual([
      { id: "apv1", ok: true },
      { id: "apv2", ok: true },
    ]);
  });

  test("N attempts at once of the same execution send once", async () => {
    const t = await setup("race");
    const { state, tool } = outbound({ mode: "none" });
    const effectKey = newId("rx");
    const outs = await Promise.all(
      Array.from({ length: 6 }, () => runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" })),
    );
    expect(state.ran).toBe(1);
    expect(outs.filter((o) => o.content === "sent a")).toHaveLength(1);
    const keys = await server.deps.db
      .select()
      .from(effectKeys)
      .where(eq(effectKeys.workspaceId, t.workspaceId));
    expect(keys.map((k) => k.status)).toEqual(["done"]);
  });

  test("a crash midway is never repeated blindly; a refusal before sending lets the retry send", async () => {
    const t = await setup("crash");
    const fail: { mode: "none" | "crash" | "reject" } = { mode: "crash" };
    const { state, tool } = outbound(fail);
    const effectKey = newId("rx");
    await expect(runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" })).rejects.toThrow(
      "connection reset",
    );
    fail.mode = "none";
    const retry = await runTool(t.ctx({ effectKey }), [tool], "send_out", { text: "a" });
    expect(retry.isError).toBe(true);
    expect(retry.content).toStartWith(
      "Not repeated: an earlier attempt of this routine run started this exact action",
    );
    expect(state.ran).toBe(1);

    fail.mode = "reject";
    const key2 = newId("rx");
    expect(await runTool(t.ctx({ effectKey: key2 }), [tool], "send_out", { text: "a" })).toEqual({
      content: "Partner is closed",
      isError: true,
    });
    fail.mode = "none";
    expect((await runTool(t.ctx({ effectKey: key2 }), [tool], "send_out", { text: "a" })).content).toBe(
      "sent a",
    );
    expect(state.ran).toBe(3);
  });
});

describe("an approval never stays open", () => {
  test("a crash while planning again after the approval settles it as failed and nothing runs", async () => {
    const t = await setup("replan");
    const state = { plans: 0, ran: 0 };
    const tool = define({
      name: "send_out",
      description: "",
      effect: "K2",
      input: z.object({ text: z.string() }),
      async plan(_ctx, input) {
        state.plans++;
        if (state.plans > 1) throw new Error("lookup failed");
        return {
          destination: { kind: "external", allowed: true, target: "partner" },
          policy: "ask",
          payload: input,
        };
      },
      async run() {
        state.ran++;
        return "sent";
      },
    }) as ToolDef<unknown>;
    const settled: { id: string; ok: boolean; text: string }[] = [];
    const ctx = t.ctx({
      async requestApproval(req) {
        return {
          id: "apv1",
          decision: "approved",
          reason: null,
          byName: "Ana",
          payloadHash: req.payloadHash,
        };
      },
      async settleApproval(id, result) {
        settled.push({ id, ...result });
      },
    });
    await expect(runTool(ctx, [tool], "send_out", { text: "a" })).rejects.toThrow("lookup failed");
    expect(settled).toEqual([{ id: "apv1", ok: false, text: "Failed while planning" }]);
    expect(state.ran).toBe(0);
  });
});
