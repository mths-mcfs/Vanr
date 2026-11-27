// Ported from the origin's debate v1 tests, through routes/debates: part B of the harness (the verdict, the blind
// read and the decision metrics, on a debate the agents play through the runtime with the test's script) and the
// comment of whoever isn't on their turn.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { textProvider } from "../src/debate-benchmark";
import { challengeContext, type DebatePostRow, debateById } from "../src/debates";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";

const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("") ?? "";
const position = (answer: string) =>
  `I argue for ${answer}.\n${JSON.stringify({ answer, confidence: 0.6, reason: "", evidence: [] })}`;
/** What a debate call answers, by the agent's name and the round (null: the synthesis). */
type Script = (agent: string, round: number | null) => string | Promise<string>;
let script: Script = (agent) => position(agent.toLowerCase());
/** Each debate call, as it came in. */
const calls: { agent: string; round: number | null }[] = [];

let server: RunningServer;
beforeAll(async () => {
  const scripted = textProvider(async (req) => {
    const agent = /^You are (\S+)/.exec(req.system)?.[1] ?? "?";
    const round = /^Round (\d+)/.exec(lastText(req));
    const at = round ? Number(round[1]) : null;
    calls.push({ agent, round: at });
    return script(agent, at);
  });
  const fake = fakeProvider();
  const debateCall = (req: ModelRequest) => /^(Round \d+ of|Write the synthesis)/.test(lastText(req));
  server = await startTestServer({
    modelProvider: { kind: "fake", stream: (req) => (debateCall(req) ? scripted : fake).stream(req) },
  });
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
          meta: {},
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

      // Round 0 splits, round 1 agrees (Back changes its position); the lead writes the synthesis.
      script = (agent, round) => {
        if (round === null) return JSON.stringify({ summary: "Debate summary", decision: "Go" });
        if (agent === "Go") return position("go");
        return position(round === 0 ? "stay" : "go");
      };
      const t = (
        await call(ana, "POST", base, { title: "Trip", goal: "Go?", agentIds: [a.id, b.id], rounds: 1 })
      ).body;
      await settle();
      const played = await debateById(server.deps.db, workspaceId, t.id);
      expect([played.status, played.endReason]).toEqual(["done", "unanimous"]);

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
      // The agents' turns wait for the test: the queue stays as it is while Beto posts.
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const before = calls.length;
      script = async (who) => {
        await held;
        return position(who.toLowerCase());
      };
      const t = (
        await call(ana, "POST", base, { title: "Outside", goal: "x", agentIds: [a.id, b.id], rounds: 1 })
      ).body;
      await waitFor(async () => calls.length - before >= 2);
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
      release();
      await settle();
      script = (who) => position(who.toLowerCase());
    },
    SERVER_TEST_MS,
  );
});
