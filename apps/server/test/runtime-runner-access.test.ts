// Runner access through the agent runtime, end to end: Ana pairs a runner and lends it to Lia; Beto, a member who
// may not use it, can't reach it through Lia, neither by asking her himself nor by posting into the run Ana
// started (the run's tools act with Ana's access, so his message opens its own run, checked for him).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { asc, eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { pairFake, type Request } from "./fake-runner";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, waitFor } from "./harness";
import type { ProtocolRunner } from "./protocol-runner";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";

const { agents, runs, runEvents } = schema;
let server: RunningServer;
const open: ProtocolRunner[] = [];
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(async () => {
  for (const r of open) await r.close();
  await server.stop();
}, SERVER_TEST_MS);

const SECRET = "cat ~/.ssh/id_rsa";

describe("the agent's runner, for whoever may use it", () => {
  test(
    "Beto can't use Ana's runner through Lia: not by asking her, not by posting into Ana's live run",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@runner-access.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Runner");
      const beto = await memberOf(server, workspaceId, "Beto", "beto@runner-access.test");
      const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
      const fake = await pairFake(server, ana, workspaceId, { open });
      await server.deps.db.update(agents).set({ environmentId: fake.runnerId }).where(eq(agents.id, lia.id));
      const path = `${ws(workspaceId)}/channels/${general}/messages`;
      const post = async (who: Parameters<typeof call>[0], body: string, clientId: string) =>
        (await call(who, "POST", path, { body, clientId })).body.id as string;
      const runOf = async (messageId: string) =>
        (await server.deps.db.select().from(runs).where(eq(runs.sourceMessageId, messageId)))[0];
      const results = async (runId: string) =>
        (
          await server.deps.db
            .select()
            .from(runEvents)
            .where(eq(runEvents.runId, runId))
            .orderBy(asc(runEvents.seq))
        )
          .filter((e) => e.kind === "tool_result")
          .map((e) => String((e.data as { content: unknown }).content));
      const execs = () =>
        fake.runner.frames
          .filter((f): f is Request => f.type === "request" && f.op === "exec")
          .map((f) => f.args.command);
      const refused = "The person who asked may not use your runner";
      const status = "[[tool:environment_status {}]]";

      // Asked by each one: Ana's ask reaches the runner, Beto's is turned away by the run's access.
      const byAna = await runOf(await post(ana, `@${lia.handle} ${status}`, "a1"));
      await settle(server);
      expect((await results(byAna?.id ?? "")).join()).not.toContain(refused);
      const byBeto = await post(beto, `@${lia.handle} ${status}`, "b1");
      await settle(server);
      expect((await results((await runOf(byBeto))?.id ?? "")).join()).toContain(refused);

      // Ana's run is on the air; Beto posts a runner command to Lia in the same conversation.
      const long = await post(ana, `@${lia.handle} [[slow:300]] tell me a long story about bread`, "a2");
      await waitFor(async () => server.deps.runtime.isBusy(lia.id));
      const steered = await post(beto, `@${lia.handle} [[tool:execute_code {"command":"${SECRET}"}]]`, "b2");
      await settle(server);
      const anaRun = await runOf(long);
      const betoRun = await runOf(steered);
      // His message didn't go into Ana's run: it got its own, which his access turned away.
      expect(betoRun?.id).toBeDefined();
      expect(betoRun?.id).not.toBe(anaRun?.id);
      expect((await results(betoRun?.id ?? "")).join()).toContain(refused);
      expect(await results(anaRun?.id ?? "")).toEqual([]);
      expect(execs()).not.toContain(SECRET);
    },
    SERVER_TEST_MS,
  );
});
