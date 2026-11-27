// The agent runtime as the chat route sees it, for the chat tests until the real one (slice S6): a person's post
// reaches the channel's agents by the reply rule, and each one answers with the engine's fake model, the run's
// tools (integrations/tools) called through runTool, and the reply streamed to the channel and then posted.
import type { ActiveRun, Message } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelContent, ModelMessage } from "@vanr/engine/models/types";
import { whoAnswers } from "@vanr/engine/reply-rule";
import { and, eq } from "drizzle-orm";
import { agentInWorkspace } from "../src/agents";
import type { ChannelRow } from "../src/channels";
import type { AppDeps, RuntimePort } from "../src/context";
import { toolsFor } from "../src/integrations/tools";
import { postMessage } from "../src/messages";
import { toolSpecs } from "../src/runtime/tools";
import { toolRun } from "./integration-run";

const { channelMemberships } = schema;
const MAX_TURNS = 4;

export interface ChatRuntime {
  /** The ids of the messages the route handed to the runtime, in order. */
  routed: string[];
  /** Live runs `activeRuns` answers, each with its workspace (the test fills it). */
  live: (ActiveRun & { workspaceId: string })[];
  /** Called with each routed message before its agents answer; the test can hold it there. */
  before?: (message: Message) => Promise<void>;
  /** Makes the server's port with these methods. */
  port(base: RuntimePort): RuntimePort;
}

export function chatRuntime(deps: () => AppDeps): ChatRuntime {
  const runtime: ChatRuntime = {
    routed: [],
    live: [],
    port(base) {
      return {
        ...base,
        activeRuns: ({ workspaceId, channelId }) =>
          runtime.live
            .filter((r) => r.workspaceId === workspaceId && (!channelId || r.channelId === channelId))
            .map(({ workspaceId: _, ...run }) => run),
        async onPersonMessage({ channel, message }) {
          runtime.routed.push(message.id);
          await runtime.before?.(message);
          const d = deps();
          const members = await d.db
            .select({ id: channelMemberships.memberId })
            .from(channelMemberships)
            .where(
              and(eq(channelMemberships.channelId, channel.id), eq(channelMemberships.memberType, "agent")),
            );
          const pick = whoAnswers({
            agentMentionIds: message.agentMentionIds,
            isDm: channel.kind === "dm",
            members: members.map((m) => ({ id: m.id, mode: "mention" as const })),
            mutedAgentIds: [],
            threadAgentIds: [],
          });
          for (const agentId of pick.ids) base.track(answer(d, agentId, channel, message), "test.chat_run");
        },
      };
    },
  };
  return runtime;
}

/** One agent turn loop: the fake model, its tool calls through runTool, the text streamed, the reply posted. */
async function answer(deps: AppDeps, agentId: string, channel: ChannelRow, trigger: Message) {
  const agent = await agentInWorkspace(deps.db, channel.workspaceId, agentId);
  const tools = await toolsFor(deps, agent, { channel, threadId: trigger.threadId });
  const run = toolRun(deps, agent, channel, {
    trigger: { id: trigger.id, authorId: trigger.author.id, authorName: "" },
    personId: trigger.author.id,
  });
  const runId = run.ctx.runId;
  const emit = (event: { type: string; [key: string]: unknown }) =>
    deps.hub.toChannel(channel.id, { ...event, runId });
  const provider = fakeProvider();
  const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: trigger.body }] }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let content: ModelContent[] = [];
    for await (const ev of provider.stream({
      model: agent.model,
      system: "",
      messages: history,
      tools: toolSpecs(tools),
      maxTokens: 1024,
      signal: run.ctx.signal,
    })) {
      if (ev.type === "text") emit({ type: "run.text_delta", text: ev.text });
      if (ev.type === "turn") content = ev.content;
    }
    history.push({ role: "assistant", content });
    const calls = content.filter(
      (c): c is Extract<ModelContent, { type: "tool_use" }> => c.type === "tool_use",
    );
    if (calls.length === 0) {
      const body = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
      await postMessage(deps, {
        workspaceId: channel.workspaceId,
        channel,
        author: { type: "agent", id: agent.id },
        body,
        clientId: null,
        threadId: trigger.threadId,
      });
      emit({ type: "run.completed", status: "done" });
      return;
    }
    const results: ModelContent[] = [];
    for (const call of calls) {
      emit({ type: "run.tool_call", tool: call.name, callId: call.id });
      const out = await run.run(tools, call.name, call.input);
      emit({ type: "run.tool_result", tool: call.name, callId: call.id, ok: !out.isError });
      results.push({ type: "tool_result", toolUseId: call.id, content: out.content, isError: out.isError });
    }
    history.push({ role: "user", content: results });
  }
}
