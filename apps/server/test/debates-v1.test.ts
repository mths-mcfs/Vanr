// Ported from the origin's debate v1 tests. The rounds, claims and the benchmark that need an agent to speak go
// through the runtime (a later slice); src/debates.test.ts and src/debate-extras.test.ts cover them without it.
// Through routes/debates here: part B of the harness (the verdict, the blind read and the decision metrics, on a
// debate whose rounds were answered the way the agents' turns answer them and whose synthesis is the one the lead's
// call writes) and the comment of whoever isn't on their turn.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActorRef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import {
  answerRound,
  challengeContext,
  type DebatePostRow,
  debateById,
  scheduleAdvance,
} from "../src/debates";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@debates-v1.test`;
const settle = () => server.deps.runtime.settle();

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId } = await seedWorkspace(server, ana, "Debate v1");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const agent = (handle: string) => seedAgent(server, workspaceId, ana, handle);
  return { workspaceId, ana, beto, agent, base: `${ws(workspaceId)}/debates` };
}

const claim = (answer: string, changed = false) => ({
  answer,
  key: answer,
  confidence: null,
  reason: "",
  evidence: [],
  changed,
});

/** Answers the debate's current round for an agent, as its turn does (the turn itself is the runtime's, S6). */
async function agentAnswers(
  workspaceId: string,
  debateId: string,
  agentId: string,
  answer: string,
  changed = false,
) {
  const row = await debateById(server.deps.db, workspaceId, debateId);
  const who: ActorRef = { type: "agent", id: agentId };
  const done = await answerRound(server.deps, row, who, {
    kind: "turn",
    body: `I argue for ${answer}.`,
    claimData: claim(answer, changed),
  });
  if (!done) throw new Error("not the agent's turn");
  // After the turn the debate moves on (the round closes once everyone answered).
  scheduleAdvance(server.deps, debateId);
  await settle();
}

describe("debates v1: rounds, claim and majority", () => {
  test("P0-02: the shuffled order changes from reader to reader", () => {
    const posts = ["a1", "a2", "a3", "a4", "a5", "a6"].map(
      (id, i) =>
        ({
          id: `p${i}`,
          author: { type: "agent", id },
          kind: "turn",
          round: 0,
          body: `post ${id}`,
          claimData: {
            answer: `r${i}`,
            key: `r${i}`,
            confidence: null,
            reason: "",
            evidence: [],
            changed: false,
          },
        }) as unknown as DebatePostRow,
    );
    const pseudonyms = Object.fromEntries(posts.map((p, i) => [p.author.id, "ABCDEF"[i] as string]));
    const names = new Map(Object.entries(pseudonyms).map(([id, a]) => [id, `Participant ${a}`]));
    const orders = new Set(
      ["a1", "a2", "a3", "a4", "a5", "a6"].map((reader) =>
        [...challengeContext(posts, { id: "deb_x", pseudonyms }, 1, reader, names).matchAll(/answer: (r\d)/g)]
          .map((m) => m[1])
          .join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(3);
  });
});

describe("debates v1: harness (P0-07)", () => {
  test(
    "part B: the verdict accepted and reverted, the blind read and the decision metrics",
    async () => {
      const { workspaceId, ana, beto, agent, base } = await team();
      const [a, b] = [await agent("go"), await agent("back")];
      // The verdict and the blind read only after it closes (Ana at the table holds the debate open).
      const open = (
        await call(ana, "POST", base, {
          title: "Open",
          goal: "x",
          agentIds: [a.id],
          speakers: [{ type: "person", id: ana.user.id }],
        })
      ).body;
      expect(
        (await call(ana, "POST", `${base}/${open.id}/verdict`, { action: "accept" })).body.error.code,
      ).toBe("debate.not_done");
      expect((await call(ana, "GET", `${base}/${open.id}/review`)).body.error.code).toBe("debate.not_done");
      await call(ana, "POST", `${base}/${open.id}/cancel`);

      const t = (
        await call(ana, "POST", base, { title: "Trip", goal: "Go?", agentIds: [a.id, b.id], rounds: 1 })
      ).body;
      await settle();
      // Round 0 splits, round 1 agrees (Back changes its position).
      await agentAnswers(workspaceId, t.id, a.id, "go");
      await agentAnswers(workspaceId, t.id, b.id, "stay");
      await agentAnswers(workspaceId, t.id, a.id, "go");
      await agentAnswers(workspaceId, t.id, b.id, "go", true);
      // The lead's synthesis is a model call (S6): the state it leaves when the round ends unanimous.
      await server.deps.db
        .update(schema.debates)
        .set({
          status: "done",
          phase: null,
          endReason: "unanimous",
          synthesis: {
            format: "decision",
            revision: 1,
            structured: { summary: "Debate summary", decision: "Go" },
          },
        })
        .where(eq(schema.debates.id, t.id));

      // Only whoever runs it accepts or reverts.
      expect((await call(beto, "POST", `${base}/${t.id}/verdict`, { action: "accept" })).status).toBe(403);
      expect((await call(ana, "POST", `${base}/${t.id}/verdict`, { action: "revert" })).body.error.code).toBe(
        "debate.verdict_not_accepted",
      );
      const accepted = (await call(ana, "POST", `${base}/${t.id}/verdict`, { action: "accept" })).body;
      expect(accepted.verdictState).toMatchObject({ state: "accepted", endorsedBy: ana.user.id });
      const reverted = (await call(ana, "POST", `${base}/${t.id}/verdict`, { action: "revert" })).body;
      expect(reverted.verdictState).toMatchObject({ state: "reverted", revertedBy: ana.user.id });

      // The blind read: both texts in an order fixed per person; picking "a" or "b" becomes debate or single answer.
      expect((await call(beto, "POST", `${base}/${t.id}/review`, { pick: "a" })).body.error.code).toBe(
        "debate.review_not_started",
      );
      const pair = (await call(beto, "GET", `${base}/${t.id}/review`)).body;
      expect((await call(beto, "GET", `${base}/${t.id}/review`)).body).toEqual(pair);
      expect([pair.a, pair.b].sort()).toEqual(["Go\n\nDebate summary", "go\n\nI argue for go."].sort());
      const debateSide = pair.a.startsWith("Go\n") ? "a" : "b";
      expect((await call(beto, "POST", `${base}/${t.id}/review`, { pick: debateSide })).body.pick).toBe(
        debateSide,
      );

      // Two people picking at the same time: no pick is lost.
      await call(ana, "GET", `${base}/${t.id}/review`);
      const [carla, davi] = [
        await memberOf(server, workspaceId, "Carla", email("carla")),
        await memberOf(server, workspaceId, "Davi", email("davi")),
      ];
      await Promise.all([carla, davi].map((p) => call(p, "GET", `${base}/${t.id}/review`)));
      await Promise.all(
        [ana, carla, davi].map((p) => call(p, "POST", `${base}/${t.id}/review`, { pick: "tie" })),
      );
      const reviews = (await debateById(server.deps.db, workspaceId, t.id)).blindReviews;
      expect(reviews.map((r) => r.pick).sort()).toEqual(["debate", "tie", "tie", "tie"]);

      const m = (await call(ana, "GET", `${base}/metrics?days=30`)).body;
      expect(m).toMatchObject({
        days: 30,
        settled: 1,
        accepted: 1,
        reverted30: 1,
        challenged: 1,
        changedDebates: 1,
        endReasons: { unanimous: 1 },
        blindReviews: { debate: 1, single: 0, tie: 3 },
        theater: false,
      });
      // Nobody else's debates count: Beto's view of a workspace without them is empty.
      const outsider = await signedIn(server, "Out", email("out"));
      const other = await seedWorkspace(server, outsider, "Other");
      expect((await call(outsider, "GET", `${ws(other.workspaceId)}/debates/metrics`)).body.settled).toBe(0);
    },
    SERVER_TEST_MS,
  );
});

describe("debates v1: attacks on the anonymity and the visibility", () => {
  test(
    "a comment from whoever isn't on their turn doesn't ask for a round",
    async () => {
      const { workspaceId, ana, beto, agent, base } = await team();
      const [a, b] = [await agent("ari"), await agent("bia")];
      const t = (
        await call(ana, "POST", base, { title: "Outside", goal: "x", agentIds: [a.id, b.id], rounds: 1 })
      ).body;
      await settle();
      // Beto isn't at the table: asking for a round is rejected; commenting stays free.
      const asked = await call(beto, "POST", `${base}/${t.id}/posts`, {
        body: "one more!",
        wantsExtraRound: true,
      });
      expect([asked.status, asked.body.error.code]).toEqual([409, "debate.out_of_turn"]);
      const comment = (await call(beto, "POST", `${base}/${t.id}/posts`, { body: "just a comment" })).body;
      expect(comment).toMatchObject({ kind: "comment", author: { type: "person", id: beto.user.id } });
      const row = await debateById(server.deps.db, workspaceId, t.id);
      // The comment brings Beto into the debate (he follows it) without changing the queue or the limit.
      expect(row.userIds).toContain(beto.user.id);
      expect(row.roundLimit).toBe(1);
      expect(row.pendingSpeakers.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    },
    SERVER_TEST_MS,
  );
});
