// Pausing an assignment stops the agent's run in its thread for whoever may act on the assignment (`actOn`), not only
// for who may stop a run elsewhere (`mayStopRun`): the thread is the assignment's, and the engine halts the run of a
// paused assignment anyway. Whoever may not act on the assignment stops nothing.
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

describe("pausing an assignment", () => {
  test(
    "stops the run in its thread for whoever may act on it, and for nobody else",
    async () => {
      const ana = await signedIn(server, "Ana", email("ana"));
      const { workspaceId, general } = await seedWorkspace(server, ana);
      const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
      const dora = await memberOf(server, workspaceId, "Dora", email("dora"));
      const carla = await memberOf(server, workspaceId, "Carla", email("carla"));
      // Lia is Ana's; Beto owns the assignment and Dora decides on it. Neither manages agents.
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

      // Beto's turn runs in the assignment's thread.
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

      const w = `${ws(workspaceId)}/assignments/${row.id}`;
      // Carla only reads the channel: she can't pause it, and the run goes on.
      expect((await call(carla, "POST", `${w}/pause`)).status).toBe(403);
      expect(server.deps.runtime.liveRun(started.runId) !== null).toBe(true);
      // Dora decides on the assignment: her pause ends the run, though she may not stop Beto's run elsewhere.
      const paused = await call(dora, "POST", `${w}/pause`);
      expect([paused.status, paused.body.status]).toEqual([200, "paused"]);
      await waitFor(async () => server.deps.runtime.liveRun(started.runId) === null);
      await started.done;
    },
    SERVER_TEST_MS,
  );
});
