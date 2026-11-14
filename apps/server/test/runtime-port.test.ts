// The runtime port before slice S6: background work is real (and stopping the server waits for it), every
// other method is a declared absence that throws `not_available` with its name.
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { RuntimePort } from "../src/context";
import { NotAvailable } from "../src/server";
import { settle, startTestServer } from "./harness";

describe("runtime port", () => {
  test("stopping the server waits for the background work, with the database still open for it", async () => {
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
  });

  test("settle in the harness waits for work tracked through deps.runtime", async () => {
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
  });

  test("every method the runtime slice brings throws not_available with its own name", async () => {
    const server = await startTestServer();
    try {
      const rt = server.deps.runtime;
      const absent: [keyof RuntimePort, () => unknown][] = [
        ["complete", () => rt.complete({} as never)],
        ["runFor", () => rt.runFor({} as never)],
        ["activeRun", () => rt.activeRun("a", "c", null)],
        ["activeRuns", () => rt.activeRuns({ workspaceId: "w" })],
        ["liveRun", () => rt.liveRun("r")],
        ["liveInfo", () => rt.liveInfo("r")],
        ["cancel", () => rt.cancel("r", null)],
        ["onRunEnd", () => rt.onRunEnd(() => {})],
        ["onPersonMessage", () => rt.onPersonMessage({} as never)],
        ["providerForWorkspace", () => rt.providerForWorkspace("w")],
        ["isBusy", () => rt.isBusy("a")],
        ["busyAgents", () => rt.busyAgents()],
        ["awaitsApproval", () => rt.awaitsApproval("ap")],
        ["resolveApproval", () => rt.resolveApproval("ap", {} as never)],
        ["reviseApproval", () => rt.reviseApproval("ap", {})],
        ["answerQuestion", () => rt.answerQuestion("q", "a", "u")],
        ["wakeAt", () => rt.wakeAt(new Date())],
      ];
      for (const [method, call] of absent) {
        let thrown: unknown = null;
        try {
          call();
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(NotAvailable);
        expect(thrown).toMatchObject({ status: 503, code: "not_available", method, params: { method } });
      }
    } finally {
      await server.stop();
    }
  });
});
