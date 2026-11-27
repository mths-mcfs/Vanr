// A run of an agent's tools, built by hand on the real deps: the runtime (the model loop that builds the context)
// comes with a later module. The receipts are real reversible actions (the undo route reads them) and the cards
// are real messages in the channel, so what a tool did reads back through the routes.

import { schema } from "@vanr/engine/db";
import { RiskTracker } from "@vanr/engine/effects";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import type { AgentRow } from "../src/agents";
import type { ChannelRow } from "../src/channels";
import { UNDO_WINDOW_MS } from "../src/control";
import { allowance, grantsOf, replaceGrants } from "../src/integrations/access";
import { postMessage } from "../src/messages";
import { AGENT_TOOLS } from "../src/runtime/content-tools";
import { type RanTool, runTool, type ToolContext, type ToolDef } from "../src/runtime/tools";
import type { RunningServer } from "../src/server";
import type { Person } from "./seed";

const { agents, channels, channelMemberships, reversibleActions } = schema;

let n = 0;

/**
 * An agent of the workspace, in the given channels (an agent reads only the channels it is in), with every
 * built-in tool granted unless `scopes` says otherwise.
 */
export async function seedAgent(
  server: RunningServer,
  workspaceId: string,
  owner: Person,
  opts: { name?: string; channels?: string[]; scopes?: string[] } = {},
): Promise<AgentRow> {
  const name = opts.name ?? "Lia";
  const id = newId("agent");
  await server.deps.db.insert(agents).values({
    id,
    workspaceId,
    name,
    handle: `${name.toLowerCase()}${++n}`,
    model: "claude-haiku-5-5",
    ownerUserId: owner.user.id,
    instructions: "Helps the team.",
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  if (opts.channels?.length)
    await server.deps.db
      .insert(channelMemberships)
      .values(opts.channels.map((channelId) => ({ channelId, memberType: "agent" as const, memberId: id })));
  await replaceGrants(
    server.deps.db,
    workspaceId,
    id,
    (opts.scopes ?? ["*"]).map((scope) => ({ connectionId: "", scope })),
  );
  const [row] = await server.deps.db.select().from(agents).where(eq(agents.id, id));
  if (!row) throw new Error("agent not seeded");
  return row;
}

export async function channelRow(server: RunningServer, id: string): Promise<ChannelRow> {
  const [row] = await server.deps.db.select().from(channels).where(eq(channels.id, id));
  if (!row) throw new Error("channel not found");
  return row;
}

/**
 * The agent's run in `channelId`, asked by `asker` (none: a routine). `call` runs one tool with the tools the
 * agent's grants allow, as the runtime will (`tools` adds the ones the runtime picks per run, like the
 * assignment's and the runner's); `actions` are the receipts the calls wrote, in order.
 */
export async function toolRun(
  server: RunningServer,
  opts: {
    workspaceId: string;
    agent: AgentRow;
    channelId: string;
    asker?: Person | null;
    tools?: readonly ToolDef<unknown>[];
  },
) {
  const channel = await channelRow(server, opts.channelId);
  const actions: string[] = [];
  const cards: { body: string; meta: unknown }[] = [];
  const asker = opts.asker ?? null;
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => {
    const runId = newId("run");
    return {
      deps: server.deps,
      workspaceId: opts.workspaceId,
      agent: opts.agent,
      channel,
      runId,
      threadId: null,
      trigger: asker ? { id: newId("msg"), authorId: asker.user.id, authorName: asker.user.name } : null,
      personId: asker?.user.id ?? null,
      personStore: () => asker?.user.id ?? null,
      signal: new AbortController().signal,
      risk: new RiskTracker(),
      async delegate() {
        throw new Error("no delegation in these tests");
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
      async recordAction(action, tx) {
        const at = server.deps.now();
        const [row] = await (tx ?? server.deps.db)
          .insert(reversibleActions)
          .values({
            id: newId("act"),
            workspaceId: opts.workspaceId,
            agentId: opts.agent.id,
            runId,
            requesterUserId: asker?.user.id ?? null,
            kind: action.kind,
            target: action.target,
            params: action.params ?? {},
            createdAt: at,
            revertibleUntil: action.revertibleUntil ?? new Date(at.getTime() + UNDO_WINDOW_MS),
          })
          .returning();
        if (!row) throw new Error("action not recorded");
        actions.push(row.id);
      },
      async postCard(body, meta) {
        cards.push({ body, meta });
        const { message } = await postMessage(server.deps, {
          workspaceId: opts.workspaceId,
          channel,
          author: { type: "agent", id: opts.agent.id },
          body,
          meta,
          clientId: null,
        });
        return message;
      },
      toolOutput() {},
      ...over,
    };
  };
  const call = async (name: string, input: unknown, over: Partial<ToolContext> = {}): Promise<RanTool> => {
    const allow = allowance(await grantsOf(server.deps.db, opts.agent.id));
    const tools = [...AGENT_TOOLS, ...(opts.tools ?? [])].filter((t) => allow.builtin(t.name));
    return runTool(ctx(over), tools, name, input);
  };
  /** The id of the latest receipt of `kind`. */
  const action = async (kind: string): Promise<string> => {
    for (const id of [...actions].reverse()) {
      const [row] = await server.deps.db.select().from(reversibleActions).where(eq(reversibleActions.id, id));
      if (row?.kind === kind) return id;
    }
    throw new Error(`no ${kind} action`);
  };
  return { ctx, call, actions, action, cards };
}

/** Undoes or redoes an action through the route, as the person; the status and the error code, if any. */
export async function undo(
  who: Person,
  workspaceId: string,
  actionId: string,
  direction: "undo" | "redo" = "undo",
): Promise<{ status: number; code: string | null }> {
  const res = await who.browser.json(
    `/api/v1/workspaces/${workspaceId}/actions/${actionId}/${direction}`,
    "POST",
  );
  const data = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return { status: res.status, code: res.ok ? null : (data?.error?.code ?? `http_${res.status}`) };
}

/**
 * The server's deps with a concurrent write: `before` runs once, right before the first transaction the tool
 * opens, so the tool's read happened before it and its locked write sees it.
 */
export function racing(server: RunningServer, before: () => Promise<unknown>): RunningServer["deps"] {
  let fired = false;
  const db = new Proxy(server.deps.db, {
    get(target, prop) {
      if (prop !== "transaction") return Reflect.get(target, prop, target);
      return async (...args: Parameters<typeof target.transaction>) => {
        if (!fired) {
          fired = true;
          await before();
        }
        return target.transaction(...args);
      };
    },
  });
  return { ...server.deps, db };
}
