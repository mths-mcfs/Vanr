// The agent lab: a test run asks the runtime for each case's reply on both sides (`complete`); the checks, the
// summary, the system prompt, the JSON reader and the cleanup after a crash.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../test/harness";
import {
  checkReply,
  evalSystem,
  failInterruptedAgentJobs,
  jsonFrom,
  startEval,
  summarize,
  toEval,
} from "./agent-lab";
import type { AgentRow } from "./agents";
import { createWorkspace } from "./members";
import type { RunningServer } from "./server";

let server: RunningServer;
let agent: AgentRow;
let userId: string;
beforeAll(async () => {
  server = await startTestServer();
  const ana = await signedIn(server, "Ana", "ana@lab.test");
  userId = ana.user.id;
  const { workspaceId } = await createWorkspace(server.deps.db, {
    name: "Lab",
    context: "We sell bikes.",
    user: ana.user,
  });
  const [row] = await server.deps.db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: "Lia",
      handle: "lia",
      role: "support",
      instructions: "Be kind.",
      model: "claude-haiku-5-5",
      ownerUserId: ana.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  if (!row) throw new Error("no agent");
  agent = row;
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

describe("agent lab", () => {
  test("a test run asks the runtime for both sides of each case and ends with the summary", async () => {
    const caseId = newId("tc");
    // The test model repeats the request, so the reply carries "hello" on both sides.
    await server.deps.db.insert(schema.agentTestCases).values({
      id: caseId,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      input: "Say hello",
      mustInclude: ["hello"],
      createdBy: userId,
    });
    const row = await startEval(server.deps, { agent, userId, after: "Be brief.", proposalId: null });
    await server.deps.runtime.settle();
    const [done] = await server.deps.db
      .select()
      .from(schema.agentEvals)
      .where(eq(schema.agentEvals.id, row.id));
    expect(done).toMatchObject({ status: "done", error: null });
    expect(done?.summary).toEqual({ cases: 1, beforePass: 1, afterPass: 1, regressions: 0 });
    expect(done?.results.map((r) => [r.caseId, r.before.pass, r.after.pass])).toEqual([[caseId, true, true]]);
    // Each side was a run of the agent on the runtime.
    const agentRuns = await server.deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agent.id));
    expect(agentRuns.filter((r) => r.status === "done").length).toBeGreaterThanOrEqual(2);
  });

  test("a reply passes when every required snippet shows and no forbidden one does, ignoring case and width", () => {
    const c = { mustInclude: ["Olá", "PEDIDO"], mustNotInclude: ["refund"] };
    expect(checkReply("olá! Seu pedido saiu.", c)).toEqual({
      text: "olá! Seu pedido saiu.",
      pass: true,
      failed: [],
    });
    expect(checkReply("Ｏｌá, a REFUND is on the way", c)).toEqual({
      text: "Ｏｌá, a REFUND is on the way",
      pass: false,
      failed: ["include:PEDIDO", "exclude:refund"],
    });
  });

  test("the summary counts the passes on each side and the regressions", () => {
    const side = (pass: boolean) => ({ text: "", pass, failed: [] });
    const results = [
      { caseId: "a", input: "1", before: side(true), after: side(true) },
      { caseId: "b", input: "2", before: side(true), after: side(false) },
      { caseId: "c", input: "3", before: side(false), after: side(true) },
    ];
    expect(summarize(results)).toEqual({ cases: 3, beforePass: 2, afterPass: 2, regressions: 1 });
  });

  test("the case's system prompt says who the agent is, the side's instructions and the workspace's context", async () => {
    const text = await evalSystem(server.deps.db, agent, "  ");
    expect(text).toContain("You are Lia (@lia), an AI agent on Vanr, the team chat of Lab.");
    expect(text).toContain("Your role on the team: support.");
    expect(text).toContain("No specific instructions yet.");
    expect(text).toContain("# About the company\nWe sell bikes.");
    expect(await evalSystem(server.deps.db, { ...agent, role: "custom" }, "Answer in rhymes.")).not.toContain(
      "Your role",
    );
  });

  test("a model's JSON is the first object of its text, fenced or not", () => {
    expect(jsonFrom('Sure:\n```json\n{"a": {"b": 1}}\n```')).toEqual({ a: { b: 1 } });
    expect(jsonFrom("no object here")).toBeNull();
    expect(jsonFrom("{ broken")).toBeNull();
  });

  test("runs open when the server went down are failed as interrupted", async () => {
    const [row] = await server.deps.db
      .insert(schema.agentEvals)
      .values({
        id: newId("evl"),
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        beforeText: "a",
        textAfter: "b",
        total: 2,
        createdBy: userId,
      })
      .returning();
    if (!row) throw new Error("no eval");
    await failInterruptedAgentJobs(server.deps.db);
    const [after] = await server.deps.db
      .select()
      .from(schema.agentEvals)
      .where(eq(schema.agentEvals.id, row.id));
    if (!after) throw new Error("gone");
    expect(toEval(after)).toMatchObject({ status: "failed", error: "interrupted", total: 2, done: 0 });
    expect(after.finishedAt).not.toBeNull();
  });
});
