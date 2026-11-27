// What the assignment engine tests stand on: the agent runtime as the engine sees it before slice S6, a
// verifier that passes everything, an agent on a runner and a fake runner paired through its owner's browser.
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import type { Verifier } from "../src/assignments/verify";
import type { RuntimePort } from "../src/context";
import type { RunEnd } from "../src/forward-types";
import type { RunningServer } from "../src/server";
import { body } from "./harness";
import { connectProtocolRunner, mintSession, type ProtocolRunner } from "./protocol-runner";
import type { Person } from "./seed";

/**
 * The agent runtime as the engine sees it, before slice S6: no run is on the air until `runFor` starts one,
 * which stays live until the test ends it with `finish` (that tells every `onRunEnd` listener, as the runtime
 * does after saving the run's status).
 */
export function agentRuntime() {
  /** `onTurn` runs inside `runFor`, after the run is live and before it answers (a test's interleaving). */
  const hooks: { onTurn?: (runId: string) => Promise<void> } = {};
  const listeners: ((end: RunEnd) => void)[] = [];
  const live = new Map<string, Omit<RunEnd, "runId" | "status" | "errorCode">>();
  const turns: { runId: string; triggerId: string }[] = [];
  let k = 0;
  const finish = (runId: string, status: RunEnd["status"] = "done") => {
    const run = live.get(runId);
    if (!run) return false;
    live.delete(runId);
    for (const l of listeners) l({ ...run, runId, status, errorCode: null });
    return true;
  };
  const wrap = (port: RuntimePort): RuntimePort => ({
    ...port,
    activeRun: (agentId, channelId, threadId) =>
      [...live].find(
        ([, r]) => r.agentId === agentId && r.channelId === channelId && r.threadId === threadId,
      )?.[0] ?? null,
    liveRun: (runId) => {
      const r = live.get(runId);
      return r ? { workspaceId: r.workspaceId, channelId: r.channelId } : null;
    },
    cancel: (runId) => finish(runId, "canceled"),
    onRunEnd: (listener) => {
      listeners.push(listener);
    },
    busyAgents: () => new Set([...live.values()].map((r) => r.agentId)),
    runFor: async ({ agent, channel, trigger }) => {
      const runId = `run_test${++k}`;
      live.set(runId, {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        channelId: channel.id,
        threadId: trigger.threadId,
      });
      turns.push({ runId, triggerId: trigger.id });
      await hooks.onTurn?.(runId);
      return { ok: true, runId, done: Promise.resolve() };
    },
  });
  return { wrap, turns, finish, hooks };
}

/** A verifier that passes every item and keeps what it was asked. */
export function passing() {
  const seen: string[][] = [];
  const verifier: Verifier = async (_deps, _row, items) => {
    seen.push(items.map((i) => i.item.id));
    return {
      ok: true,
      runId: null,
      verdicts: items.map((i) => ({ id: i.item.id, passes: true, reason: "ok" })),
    };
  };
  return { verifier, seen };
}

/** An agent of the workspace, in its #general, on the runner (or none). */
export async function seedAgent(db: Db, workspaceId: string, owner: Person, runnerId: string | null) {
  const id = newId("agt");
  await db.insert(schema.agents).values({
    id,
    workspaceId,
    name: "Lia",
    handle: `lia${id.slice(-6).toLowerCase()}`,
    model: "claude-haiku-5-5",
    ownerUserId: owner.user.id,
    environmentId: runnerId,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  const [general] = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.workspaceId, workspaceId), eq(schema.channels.name, "general")));
  if (general)
    await db
      .insert(schema.channelMemberships)
      .values({ channelId: general.id, memberType: "agent", memberId: id });
  return id;
}

/** Pairs a fake runner through the owner's browser; it answers `job.start` with its start time. */
export async function pairRunner(
  server: RunningServer,
  owner: Person,
  workspaceId: string,
  onStart: (jobId: string) => void,
): Promise<ProtocolRunner> {
  const post = (path: string, payload: unknown) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const pairing = await body(
    await post("/api/v1/runner-pairings", { os: "linux", arch: "x64", hostname: "engine", version: "0.2.0" }),
  );
  await owner.browser.json(
    `/api/v1/workspaces/${workspaceId}/runner-pairings/${pairing.userCode}/confirm`,
    "POST",
    {},
  );
  const token = await body(await post("/api/v1/runner-pairings/token", { deviceCode: pairing.deviceCode }));
  const minted = await mintSession(server.url, token.token);
  return connectProtocolRunner(server.url, minted.body.session, {
    answer: (req) => {
      if (req.op === "job.start") {
        onStart(String(req.args.jobId));
        return { ok: true, data: { startedAt: new Date().toISOString() } };
      }
      return { ok: true, data: {} };
    },
  });
}
