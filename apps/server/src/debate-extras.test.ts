// The modules around the debate: the cost estimate (an upper bound of what the turns reserve), who sees a debate's
// run (hidden while the debate is anonymous) and the accuracy benchmark (its simulated panel reads the real prompts;
// running it needs the runtime, so until slice S6 it is rejected at its entry).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { PRICES } from "@vanr/engine/models/prices";
import { estimateUsd, utf8Bytes } from "@vanr/engine/usage";
import { eq } from "drizzle-orm";
import { SERVER_TEST_MS, signedIn, startTestServer } from "../test/harness";
import { memberOf, type Person, seedWorkspace } from "../test/seed";
import type { AgentRow } from "./agents";
import { arithmeticItems, report, runAccuracyBenchmark, simulatedPanel } from "./debate-benchmark";
import {
  challengeContext,
  type DebatePostRow,
  openDebate,
  optionsBlock,
  TURN_EXTRA_CHARS,
  turnPrompt,
} from "./debates";
import { debateEstimate, routineEstimate } from "./estimates";
import { readableRun } from "./run-access";
import type { RunningServer } from "./server";

let server: RunningServer;
let workspaceId: string;
let ana: Person;
let bob: Person;
let agent: AgentRow;

beforeAll(async () => {
  server = await startTestServer();
  ana = await signedIn(server, "Ana", "ana@extras.test");
  ({ workspaceId } = await seedWorkspace(server, ana, "Extras"));
  bob = await memberOf(server, workspaceId, "Bob", "bob@extras.test");
  const [row] = await server.deps.db
    .insert(schema.agents)
    .values({
      id: newId("agt"),
      workspaceId,
      name: "Ada",
      handle: "ada",
      role: "support",
      instructions: "Think twice.",
      model: "claude-haiku-5-5",
      ownerUserId: ana.user.id,
      appearance: { color: "blue", eyes: "dot", adornment: "none" },
    })
    .returning();
  if (!row) throw new Error("no agent");
  agent = row;
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

describe("the debate's estimate", () => {
  test("is an upper bound of what every turn at its largest reserves, and grows with the rounds", () => {
    const at = new Date();
    const estimate = debateEstimate([agent], { roundLimit: 2 }, at);
    expect(estimate.calls).toBe(3 + 1);
    // One real turn at the largest: title and goal at the route's maximum, the options and the context full.
    const debate = {
      title: "t".repeat(200),
      goal: "g".repeat(4000),
      round: 2,
      roundLimit: 2,
      format: "decision" as const,
    };
    const posts: DebatePostRow[] = Array.from({ length: 40 }, (_, i) => ({
      id: `dpost_${i}`,
      debateId: "deb_x",
      author: { type: "agent", id: `agt_${i}` },
      kind: "turn",
      round: 1,
      body: "é".repeat(5000),
      claimData: null,
      hiddenUntilRoundEnd: false,
      replyTo: null,
      wantsExtraRound: false,
      runId: null,
      meta: {},
      createdAt: at,
    }));
    const turn = turnPrompt(agent, debate, {
      pseudonym: "A",
      blind: false,
      options: optionsBlock(Array.from({ length: 8 }, () => "o".repeat(200))),
      context: challengeContext(posts, { id: "deb_x", pseudonyms: {} }, 2, "agt_0", new Map()),
    });
    const real = estimateUsd(PRICES, {
      model: agent.model,
      promptBytes: utf8Bytes(turn.system) + utf8Bytes(turn.prompt),
      maxTokens: 4000,
      at,
    });
    expect(real * 3).toBeLessThan(estimate.upToUsd);
    expect(TURN_EXTRA_CHARS).toBeGreaterThan(0);
    expect(debateEstimate([agent], { roundLimit: 4 }, at).upToUsd).toBeGreaterThan(estimate.upToUsd);
    expect(debateEstimate([], { roundLimit: 1 }, at)).toEqual({ calls: 0, upToUsd: 0 });
    expect(routineEstimate({ upToUsd: null, calls: null, recent: [0.5, 1.5] })).toEqual({
      upToUsd: null,
      calls: null,
      recent: { runs: 2, avgUsd: 1, maxUsd: 1.5 },
    });
  });
});

describe("a debate's run", () => {
  test(
    "stays hidden while the debate is anonymous and shows once it closed",
    async () => {
      const debate = await openDebate(server.deps, {
        workspaceId,
        title: "Run",
        goal: "Hide it",
        agentIds: [],
        speakers: [{ type: "person", id: bob.user.id }],
        createdBy: { type: "person", id: ana.user.id },
        requesterUserId: ana.user.id,
        origin: { kind: "manual" },
      });
      await server.deps.runtime.settle();
      const runId = newId("run");
      await server.deps.db.insert(schema.runs).values({
        id: runId,
        workspaceId,
        agentId: agent.id,
        debateId: debate.id,
        model: agent.model,
        status: "done",
      });
      await expect(readableRun(workspaceId, bob.user.id, runId, server.deps.db)).rejects.toMatchObject({
        status: 404,
      });
      await server.deps.db
        .update(schema.debates)
        .set({ status: "done" })
        .where(eq(schema.debates.id, debate.id));
      expect((await readableRun(workspaceId, bob.user.id, runId, server.deps.db)).id).toBe(runId);
      await expect(readableRun("ws_other", bob.user.id, runId, server.deps.db)).rejects.toMatchObject({
        status: 404,
      });
    },
    SERVER_TEST_MS,
  );
});

describe("the accuracy benchmark", () => {
  test(
    "running it is rejected with not_available before any debate is opened",
    async () => {
      const before = await server.deps.db.select({ id: schema.debates.id }).from(schema.debates);
      await expect(
        runAccuracyBenchmark(server.deps, {
          workspaceId,
          initiatedBy: ana.user.id,
          agentIds: [agent.id],
          items: arithmeticItems(2),
        }),
      ).rejects.toMatchObject({ status: 503, code: "not_available", params: { method: "complete" } });
      expect(await server.deps.db.select({ id: schema.debates.id }).from(schema.debates)).toHaveLength(
        before.length,
      );
    },
    SERVER_TEST_MS,
  );

  test("the items are reproducible by the seed and the report pairs the methods", () => {
    expect(arithmeticItems(3)).toEqual(arithmeticItems(3));
    expect(arithmeticItems(3, "other")).not.toEqual(arithmeticItems(3));
    const [item] = arithmeticItems(1);
    const [, a, b, c, d, e] = /What is (\d+)\*(\d+)\+(\d+)-(\d+)\*(\d+)\?/.exec(item?.question ?? "") ?? [];
    expect(item?.answer).toBe(String(Number(a) * Number(b) + Number(c) - Number(d) * Number(e)));
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `arith-${i}`,
      debateId: `deb_${i}`,
      single: i % 2 === 0,
      vote: i % 4 !== 3,
      debate: true,
      tokens: { single: 10, vote: 30, debate: 60 },
      roundsPlayed: 2,
    }));
    const out = report(rows);
    expect(out.accuracy).toEqual({ single: 0.5, vote: 0.75, debate: 1 });
    expect(out.meanTokens).toEqual({ single: 10, vote: 30, debate: 60 });
    expect(out.debateVsVote).toMatchObject({ n: 40, diff: 0.25, discordant: 10 });
    expect(out.recommendedDefault).toBe("debate");
  });

  test("the simulated panel reads the real turn prompt: the goal, the round and the others' positions", async () => {
    const goal = "What is 3*4+5-2*2? Answer with the number only.";
    const debate = { title: "Benchmark", goal, round: 0, roundLimit: 1, format: "decision" as const };
    const panel = simulatedPanel({ accuracy: 1, conformity: 1 });
    const ask = async (system: string, prompt: string) => {
      let text = "";
      for await (const ev of panel.stream({
        model: "claude-haiku-5-5",
        system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        tools: [],
        maxTokens: 100,
        signal: new AbortController().signal,
      }))
        if (ev.type === "text") text += ev.text;
      return text;
    };
    const blind = turnPrompt(agent, debate, { pseudonym: "A", blind: true, options: "", context: "" });
    expect(await ask(blind.system, blind.prompt)).toContain('"answer":"13"');
    // In the challenge round, full conformity takes the others' most common answer.
    const post = (id: string, answer: string): DebatePostRow => ({
      id,
      debateId: "deb_x",
      author: { type: "agent", id },
      kind: "turn",
      round: 0,
      body: `It is ${answer}.`,
      claimData: { answer, key: answer, confidence: 0.6, reason: "", evidence: [], changed: false },
      hiddenUntilRoundEnd: false,
      replyTo: null,
      wantsExtraRound: false,
      runId: null,
      meta: {},
      createdAt: new Date(),
    });
    const posts = [post("agt_me", "13"), post("agt_b", "14"), post("agt_c", "14")];
    const names = new Map([
      ["agt_b", "Participant B"],
      ["agt_c", "Participant C"],
    ]);
    const challenge = turnPrompt(
      agent,
      { ...debate, round: 1 },
      {
        pseudonym: "A",
        blind: false,
        options: "",
        context: challengeContext(posts, { id: "deb_x", pseudonyms: {} }, 1, "agt_me", names),
      },
    );
    expect(await ask(challenge.system, challenge.prompt)).toContain('"answer":"14"');
  });
});
