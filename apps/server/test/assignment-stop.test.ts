// Pausing an assignment is for whoever may act on it (`actOn`). Its run stops at once, in the person's name, only when
// they may also stop that run elsewhere (`mayStopRun`); otherwise the engine's halt ends it, in nobody's name.
// Whoever may not act on the assignment stops nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { createAssignment } from "../src/assignments/engine";
import { postMessage } from "../src/messages";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";
import { channelRow, seedAgent } from "./tool-run";

const { assignments, assignmentParticipants, messages } = schema;

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@assignment-stop.test`;

/** An active assignment of Beto's that Dora decides on, with Lia's (Ana's agent) turn running in its thread. */
async function runningAssignment() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana);
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const dora = await memberOf(server, workspaceId, "Dora", email("dora"));
  const carla = await memberOf(server, workspaceId, "Carla", email("carla"));
  // Neither Beto nor Dora manages agents.
  const lia = await seedAgent(server, workspaceId, ana, { name: "Lia", channels: [general] });
  const row = await createAssignment(server.deps, {
    workspaceId,
    agentId: lia.id,
    agentHandle: lia.handle,
    channelId: general,
    ownerId: beto.user.id,
    title: "Fix the flaky test",
    goal: "The suite passes ten times in a row",
    executor: "agent",
    runnerId: null,
    commandPolicy: "never",
  });
  await server.deps.db
    .update(assignments)
    .set({ status: "active", startedAt: server.deps.now() })
    .where(eq(assignments.id, row.id));
  await server.deps.db
    .insert(assignmentParticipants)
    .values({ assignmentId: row.id, userId: dora.user.id, role: "decide" });
  // Beto's turn runs in the assignment's thread: he is the run's initiator.
  const channel = await channelRow(server, general);
  const { message } = await postMessage(server.deps, {
    workspaceId,
    channel,
    author: { type: "person", id: beto.user.id },
    body: "[[slow:5000]] keep going",
    clientId: newId("c"),
    threadId: row.threadId,
  });
  const [trigger] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
  if (!trigger) throw new Error("no trigger");
  const started = await server.deps.runtime.runFor({ agent: lia, channel, trigger });
  if (!started.ok) throw new Error(started.code);
  return { beto, dora, carla, started, at: `${ws(workspaceId)}/assignments/${row.id}` };
}

/** The stops asked of the runtime while `work` runs, as [run, in whose name]. */
async function stopsDuring(work: () => Promise<void>): Promise<[string, string | null][]> {
  const { runtime } = server.deps;
  const cancel = runtime.cancel;
  const stops: [string, string | null][] = [];
  runtime.cancel = (runId, actor, fence) => {
    stops.push([runId, actor]);
    return cancel.call(runtime, runId, actor, fence);
  };
  try {
    await work();
  } finally {
    runtime.cancel = cancel;
  }
  return stops;
}

describe("pausing, stopping or closing an assignment", () => {
  for (const [action, body, status] of [
    ["pause", undefined, "paused"],
    ["stop", undefined, "paused"],
    ["close", { outcome: "canceled" }, "canceled"],
  ] as const) {
    test(
      `a decider who may not stop the run still uses ${action}; the engine ends the run, in nobody's name`,
      async () => {
        const { dora, carla, started, at } = await runningAssignment();
        // Carla only reads the channel: she can't act on it, and the run goes on.
        expect((await call(carla, "POST", `${at}/${action}`, body)).status).toBe(403);
        expect(server.deps.runtime.liveRun(started.runId) !== null).toBe(true);
        const stops = await stopsDuring(async () => {
          const acted = await call(dora, "POST", `${at}/${action}`, body);
          expect([acted.status, acted.body.status]).toEqual([200, status]);
          await waitFor(async () => server.deps.runtime.liveRun(started.runId) === null);
        });
        await started.done;
        expect(stops.filter(([, actor]) => actor === dora.user.id)).toEqual([]);
        expect(stops.some(([runId, actor]) => runId === started.runId && actor === null)).toBe(true);
      },
      SERVER_TEST_MS,
    );
  }

  test(
    "who may also stop the run stops it at once, in their name",
    async () => {
      const { beto, started, at } = await runningAssignment();
      const stops = await stopsDuring(async () => {
        const paused = await call(beto, "POST", `${at}/pause`);
        expect([paused.status, paused.body.status]).toEqual([200, "paused"]);
      });
      expect(stops[0]).toEqual([started.runId, beto.user.id]);
      await waitFor(async () => server.deps.runtime.liveRun(started.runId) === null);
      await started.done;
    },
    SERVER_TEST_MS,
  );
});
