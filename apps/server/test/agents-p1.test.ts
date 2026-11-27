// The agent lab routes (routes/agent-lab.ts): test cases and the before/after run, the memory consolidation and
// who may do what in them; "describe it and I build it" and the skill draft from a run, rejected at their entry
// while the runtime isn't there. A run of the lab asks the runtime for each answer (`complete`): the server here
// gets a test runtime whose `complete` answers by the side's instructions, as the origin's scripted model did, and
// writes the run it would have written. The advisor's run and the builder and consolidation scenarios that need the
// real runtime wait for P16; see the ledger.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentEval, AgentTestCase, MemoryConsolidation } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { failInterruptedAgentJobs } from "../src/agent-lab";
import { createMemory } from "../src/agent-memory";
import type { CompleteInput, CompleteResult } from "../src/context";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, settle, signedIn, startTestServer } from "./harness";
import { type Called, call, ws } from "./route-calls";
import { memberOf, type Person } from "./seed";

let server: RunningServer;
/** The runtime's answer for one call: by the instructions in the system prompt, as the origin's scripted model. */
let answer: (input: CompleteInput) => string = () => "Hi.";
const asked: CompleteInput[] = [];

async function complete(input: CompleteInput): Promise<CompleteResult> {
  asked.push(input);
  const runId = newId("run");
  await server.deps.db.insert(schema.runs).values({
    id: runId,
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.id,
    status: "done",
    what: input.what,
    model: input.agent.model,
    costUsd: 0.001,
  });
  return { ok: true, text: answer(input), runId };
}

beforeAll(async () => {
  server = await startTestServer({ runtime: (port) => ({ ...port, complete }) });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@agents-p1.test`;

async function ok<T>(pending: Promise<Called>, status = 200): Promise<T> {
  const res = await pending;
  if (res.status !== status)
    throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Ana (the workspace's owner, Lia's owner) and Beto (member). */
async function team(on = server) {
  const ana = await signedIn(on, "Ana", email("ana"));
  const created = await ok<{ workspace: { id: string }; defaultChannelId: string }>(
    call(ana, "POST", "/api/v1/workspaces", { name: "Agents P1" }),
    201,
  );
  const workspaceId = created.workspace.id;
  const beto = await memberOf(on, workspaceId, "Beto", email("beto"));
  const lia = await ok<{ id: string }>(
    call(ana, "POST", `${ws(workspaceId)}/agents`, {
      name: "Lia",
      handle: "lia",
      role: "support",
      instructions: "Serves customers.",
      channelIds: [created.defaultChannelId],
    }),
    201,
  );
  return { workspaceId, general: created.defaultChannelId, ana, beto, lia };
}

const lab = (workspaceId: string, agentId: string) => `${ws(workspaceId)}/agents/${agentId}`;

/** A pending proposal to change Lia's instructions, as the agent's propose tool writes it. */
async function proposal(t: Awaited<ReturnType<typeof team>>, instructions: string) {
  const id = newId("prp");
  await server.deps.db.insert(schema.proposals).values({
    id,
    workspaceId: t.workspaceId,
    agentId: t.lia.id,
    targetKind: "agent_prompt",
    recipientAgentId: t.lia.id,
    title: "Deadline",
    before: "Serves customers.",
    after: instructions,
    why: "Customers ask for the deadline",
  });
  return { id };
}

/** In the test cases the answer depends on the side's instructions: with the deadline, the agent says it. */
const evalAnswer = (input: CompleteInput) =>
  input.system.includes("Always mention the deadline") ? "The deadline is 3 days." : "I can't say.";

describe("test cases before and after the proposal", () => {
  test(
    "the run shows what improves and the regression, and accepting stays free",
    async () => {
      const t = await team();
      const { workspaceId, ana, lia } = t;
      const cases = `${lab(workspaceId, lia.id)}/test-cases`;
      expect((await ok<{ cases: unknown[] }>(call(ana, "GET", cases))).cases).toEqual([]);
      const deadline = await ok<AgentTestCase>(
        call(ana, "POST", cases, { input: "When does my order arrive?", mustInclude: ["DEADLINE"] }),
        201,
      );
      const hi = await ok<AgentTestCase>(
        call(ana, "POST", cases, { input: "Hi, how are you?", mustNotInclude: ["deadline"] }),
        201,
      );
      const edited = await ok<AgentTestCase>(
        call(ana, "PATCH", `${cases}/${hi.id}`, { input: "Hi!", mustNotInclude: ["deadline"] }),
      );
      expect(edited.input).toBe("Hi!");
      const p = await proposal(t, "Serves customers. Always mention the deadline.");

      answer = evalAnswer;
      const evals = `${lab(workspaceId, lia.id)}/evals`;
      const started = await ok<AgentEval>(call(ana, "POST", evals, { proposalId: p.id }), 201);
      expect(started).toMatchObject({ status: "running", total: 2, proposalId: p.id });
      await settle(server);
      const done = await ok<AgentEval>(call(ana, "GET", `${evals}/${started.id}`));
      expect(done.status).toBe("done");
      expect(done.results.map((r) => [r.caseId, r.before.pass, r.after.pass])).toEqual([
        [deadline.id, false, true],
        [hi.id, true, false],
      ]);
      expect(done.results[0]?.before.failed).toEqual(["include:DEADLINE"]);
      expect(done.results[1]?.after.failed).toEqual(["exclude:deadline"]);
      expect(done.summary).toEqual({ cases: 2, beforePass: 1, afterPass: 1, regressions: 1 });
      expect(done.costUsd).toBeGreaterThan(0);
      // Each side of each case is a run of the agent.
      const runs = await ok<{ runs: { what: string }[] }>(
        call(ana, "GET", `${ws(workspaceId)}/runs?agentId=${lia.id}`),
      );
      expect(runs.runs.filter((r) => r.what.startsWith("Test case"))).toHaveLength(4);
      expect(
        (await ok<{ evals: AgentEval[] }>(call(ana, "GET", `${evals}?proposalId=${p.id}`))).evals.map(
          (e) => e.id,
        ),
      ).toEqual([started.id]);
      // Advisory only: the proposal can still be accepted.
      expect(
        (await ok<{ status: string }>(call(ana, "POST", `${ws(workspaceId)}/proposals/${p.id}/accept`)))
          .status,
      ).toBe("accepted");
      const decided = await call(ana, "POST", evals, { proposalId: p.id });
      expect(decided.body.error.code).toBe("agent_eval.decided");

      // The editor's text runs too; without cases, it doesn't.
      expect((await call(ana, "DELETE", `${cases}/${hi.id}`)).status).toBe(204);
      expect((await call(ana, "DELETE", `${cases}/${deadline.id}`)).status).toBe(204);
      const empty = await call(ana, "POST", evals, { instructions: "x" });
      expect(empty.body.error.code).toBe("agent_eval.no_cases");
    },
    SERVER_TEST_MS,
  );

  test(
    "one open run per agent, a cap of 50 cases and a run cut by the restart",
    async () => {
      const { workspaceId, ana, lia } = await team();
      const cases = `${lab(workspaceId, lia.id)}/test-cases`;
      const evals = `${lab(workspaceId, lia.id)}/evals`;
      await ok(call(ana, "POST", cases, { input: "hi" }), 201);
      await server.deps.db.insert(schema.agentEvals).values({
        id: `evl_open_${lia.id}`,
        workspaceId,
        agentId: lia.id,
        beforeText: "a",
        textAfter: "b",
        total: 1,
      });
      expect((await call(ana, "POST", evals, { instructions: "b" })).body.error.code).toBe(
        "agent_eval.running",
      );
      await failInterruptedAgentJobs(server.deps.db);
      expect(await ok<AgentEval>(call(ana, "GET", `${evals}/evl_open_${lia.id}`))).toMatchObject({
        status: "failed",
        error: "interrupted",
      });

      await server.deps.db.insert(schema.agentTestCases).values(
        Array.from({ length: 48 }, (_, i) => ({
          id: `tcs_${lia.id}_${i}`,
          workspaceId,
          agentId: lia.id,
          input: `case ${i}`,
        })),
      );
      // 49 cases; three requests at once for the last place: only one gets in.
      const tries = await Promise.all(
        [1, 2, 3].map((i) => call(ana, "POST", cases, { input: `extra ${i}` })),
      );
      expect(tries.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(tries.find((r) => r.status === 409)?.body.error.code).toBe("agent_test_case.full");
      expect((await ok<{ cases: unknown[] }>(call(ana, "GET", cases))).cases.length).toBe(50);
    },
    SERVER_TEST_MS,
  );

  test(
    "attack: a member without the role, another agent's proposal and the owner's free text",
    async () => {
      const t = await team();
      const { workspaceId, ana, beto, lia } = t;
      const liaLab = lab(workspaceId, lia.id);
      expect((await call(beto, "GET", `${liaLab}/test-cases`)).status).toBe(403);
      expect((await call(beto, "POST", `${liaLab}/test-cases`, { input: "x" })).status).toBe(403);
      expect((await call(beto, "POST", `${liaLab}/evals`, { instructions: "x" })).status).toBe(403);
      // Beto owns another agent: he runs the proposal's run, not any text of his.
      const rui = await ok<{ id: string }>(
        call(ana, "POST", `${ws(workspaceId)}/agents`, {
          name: "Rui",
          handle: "rui",
          role: "custom",
          ownerUserId: beto.user.id,
        }),
        201,
      );
      const ruiLab = lab(workspaceId, rui.id);
      await ok(call(beto, "POST", `${ruiLab}/test-cases`, { input: "hi" }), 201);
      expect((await call(beto, "POST", `${ruiLab}/evals`, { instructions: "x" })).status).toBe(403);
      // Lia's proposal doesn't serve Rui's run.
      const p = await proposal(t, "Serves customers. Always mention the deadline.");
      expect((await call(beto, "POST", `${ruiLab}/evals`, { proposalId: p.id })).status).toBe(404);
      // Another workspace sees nothing.
      const eva = await signedIn(server, "Eva", email("eva"));
      expect((await call(eva, "GET", `${liaLab}/test-cases`)).status).toBe(404);
      // A test case of Lia's isn't reached through Rui's path, nor its run.
      const liaCase = await ok<AgentTestCase>(
        call(ana, "POST", `${liaLab}/test-cases`, { input: "hello" }),
        201,
      );
      expect(
        (await call(ana, "PATCH", `${ruiLab}/test-cases/${liaCase.id}`, { input: "changed" })).status,
      ).toBe(404);
      expect((await call(ana, "DELETE", `${ruiLab}/test-cases/${liaCase.id}`)).status).toBe(404);
      expect(asked.filter((a) => a.agent.id === rui.id)).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

/** A memory of the agent, as a run's remember writes it. */
const remember = (workspaceId: string, agentId: string, text: string) =>
  createMemory(
    server.deps.db,
    new Date(),
    {
      workspaceId,
      agentId,
      scope: "agent",
      path: null,
      text,
      untrustedSource: false,
      origin: { by: null, name: null, channel: null, at: new Date().toISOString() },
    },
    { author: { type: "system" } },
  );

describe("memory consolidation for review", () => {
  test(
    "attack: a member without the role neither reads nor applies the consolidation of the agent's memory",
    async () => {
      const { workspaceId, ana, beto, lia } = await team();
      await remember(workspaceId, lia.id, "One.");
      await remember(workspaceId, lia.id, "Two.");
      const consolidations = `${lab(workspaceId, lia.id)}/memory-consolidations`;
      expect((await call(beto, "POST", consolidations)).status).toBe(403);
      answer = () => '{"items": []}';
      const mine = await ok<MemoryConsolidation>(call(ana, "POST", consolidations), 201);
      await settle(server);
      expect((await call(beto, "GET", consolidations)).status).toBe(403);
      expect((await call(beto, "POST", `${consolidations}/${mine.id}/apply`)).status).toBe(403);
      // An agent's consolidation applied through another's route: not found.
      const rui = await ok<{ id: string }>(
        call(ana, "POST", `${ws(workspaceId)}/agents`, { name: "Rui", handle: "rui", role: "custom" }),
        201,
      );
      const ruiPath = `${lab(workspaceId, rui.id)}/memory-consolidations/${mine.id}`;
      expect((await call(ana, "POST", `${ruiPath}/apply`)).status).toBe(404);
      expect((await call(ana, "POST", `${ruiPath}/discard`)).status).toBe(404);
    },
    SERVER_TEST_MS,
  );
});

describe("on the real runtime", () => {
  let bare: RunningServer;
  beforeAll(async () => {
    bare = await startTestServer();
  }, SERVER_TEST_MS);
  afterAll(() => bare.stop(), SERVER_TEST_MS);

  test(
    "the lab's run, the drafts, the builder, the consolidation and the skill draft answer on the runtime",
    async () => {
      const { workspaceId, ana, beto, lia } = await team(bare);
      const liaLab = lab(workspaceId, lia.id);
      await ok(call(ana, "POST", `${liaLab}/test-cases`, { input: "hi" }), 201);
      expect((await call(ana, "POST", `${liaLab}/evals`, { instructions: "x" })).status).toBe(201);
      await bare.deps.runtime.settle();
      const { evals } = await ok<{ evals: { status: string }[] }>(call(ana, "GET", `${liaLab}/evals`));
      expect(evals.map((e) => e.status)).toEqual(["done"]);
      const drafted = await ok<{ testModel: boolean }>(
        call(ana, "POST", `${ws(workspaceId)}/agent-drafts`, { description: "A support agent" }),
      );
      expect(drafted.testModel).toBe(true);
      expect((await call(ana, "POST", `${liaLab}/builder`, { description: "A support agent" })).status).toBe(
        200,
      );
      for (const text of ["The office opens at 9.", "the office opens at 9."])
        await createMemory(
          bare.deps.db,
          new Date(),
          {
            workspaceId,
            agentId: lia.id,
            scope: "agent",
            path: null,
            text,
            untrustedSource: false,
            origin: { by: null, name: null, channel: null, at: new Date().toISOString() },
          },
          { author: { type: "system" } },
        );
      expect((await call(ana, "POST", `${liaLab}/memory-consolidations`)).status).toBe(201);
      await bare.deps.runtime.settle();
      const { consolidations } = await ok<{ consolidations: { status: string }[] }>(
        call(ana, "GET", `${liaLab}/memory-consolidations`),
      );
      expect(consolidations.map((x) => x.status)).toEqual(["ready"]);
      expect((await call(ana, "POST", `${ws(workspaceId)}/runs/run_nope/skill-draft`)).status).toBe(404);
      // Who may not ask gets 403.
      for (const path of [
        `${ws(workspaceId)}/agent-drafts`,
        `${liaLab}/builder`,
        `${ws(workspaceId)}/runs/run_nope/skill-draft`,
      ])
        expect((await call(beto, "POST", path, { description: "x" })).status).toBe(403);
    },
    SERVER_TEST_MS,
  );
});
