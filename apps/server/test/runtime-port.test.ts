// The runtime port as the server hands it out: background work (stopping the server waits for it), the questions
// about live runs with none on the air, and the bound port a test spreads to replace one method.
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { SERVER_TEST_MS, settle, startTestServer } from "./harness";

describe("runtime port", () => {
  test(
    "stopping the server waits for the background work, with the database still open for it",
    async () => {
      const server = await startTestServer();
      let used = "";
      server.deps.runtime.track(
        Bun.sleep(50).then(async () => {
          await server.deps.db.execute(sql`select 1`);
          used = "database";
        }),
        "test.slow",
      );
      await server.stop();
      expect(used).toBe("database");
    },
    SERVER_TEST_MS,
  );

  test(
    "settle in the harness waits for work tracked through deps.runtime",
    async () => {
      const server = await startTestServer();
      try {
        let done = false;
        server.deps.runtime.track(
          Bun.sleep(30).then(() => {
            done = true;
          }),
          "test.work",
        );
        await settle(server);
        expect(done).toBe(true);
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "with no run on the air nobody is busy, no run is active and none can be found to stop",
    async () => {
      const server = await startTestServer();
      try {
        const rt = server.deps.runtime;
        expect(rt.isBusy("agt_x")).toBe(false);
        expect([...rt.busyAgents()]).toEqual([]);
        expect(rt.activeRuns({ workspaceId: "w" })).toEqual([]);
        expect(rt.activeRuns({ workspaceId: "w", channelId: "c" })).toEqual([]);
        expect(rt.liveInfo("run_x")).toBeNull();
        expect(rt.liveRun("run_x")).toBeNull();
        expect(rt.activeRun("agt_x", "chn_x", null)).toBeNull();
        expect(rt.cancel("run_x", null)).toBe(false);
        expect(rt.awaitsApproval("apv_x")).toBe(false);
        expect(
          rt.resolveApproval("apv_x", { id: "apv_x", decision: "expired", reason: null, byName: null }),
        ).toBe(false);
        expect(await rt.reviseApproval("apv_x", {})).toBeNull();
        expect(await rt.answerQuestion("q_x", "yes", "usr_x")).toBeNull();
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a test that spreads the port and replaces one method keeps every other method working",
    async () => {
      let ended = 0;
      const server = await startTestServer({
        runtime: (port) => ({ ...port, isBusy: () => true }),
      });
      try {
        const rt = server.deps.runtime;
        expect(rt.isBusy("agt_x")).toBe(true);
        expect([...rt.busyAgents()]).toEqual([]);
        rt.onRunEnd(() => {
          ended++;
        });
        const provider = await rt.providerForWorkspace("wsp_missing");
        expect("error" in provider ? provider.error : provider.kind).toBe("fake");
        let done = false;
        rt.track(
          Bun.sleep(10).then(() => {
            done = true;
          }),
          "test.spread",
        );
        await rt.settle();
        expect([done, ended]).toEqual([true, 0]);
      } finally {
        await server.stop();
      }
    },
    SERVER_TEST_MS,
  );
});
