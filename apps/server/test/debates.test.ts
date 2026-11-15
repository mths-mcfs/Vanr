// Ported from the origin's debate tests, through routes/debates. An agent's turn and the synthesis ask the runtime
// for a text (slice S6): until then the debate's advance stops at that step and the debate waits, so the
// scenarios that need an agent to speak keep only what happens before it (the ledger lists the rest). An agent's
// answer is saved the way its turn saves it (`answerRound`), to see what the routes show of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActorRef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, sql } from "drizzle-orm";
import {
  answerRound,
  type DebatePostRow,
  debateById,
  POST_CHARS,
  TRANSCRIPT_CHARS,
  transcript,
} from "../src/debates";
import type { RunningServer } from "../src/server";
import {
  Browser,
  type RealtimeFrame,
  SERVER_TEST_MS,
  signedIn,
  startTestServer,
  TestSocket,
} from "./harness";
import { addToChannel, call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@debates.test`;
const settle = () => server.deps.runtime.settle();
const ev = (f: RealtimeFrame) => f.event as RealtimeFrame;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Debate");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
  const rui = await seedAgent(server, workspaceId, ana, "rui", [general]);
  const base = `${ws(workspaceId)}/debates`;
  const open = async (who: Person, input: Record<string, unknown>) => {
    const res = await call(who, "POST", base, input);
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return { workspaceId, general, ana, beto, caio, lia, rui, base, open };
}

describe("debates", () => {
  test(
    'two people at the table: both have the turn in "waiting for you" (the round runs in parallel)',
    async () => {
      const { workspaceId, base, open, ana, beto, caio, lia } = await team();
      const created = await open(ana, {
        title: "Change supplier?",
        goal: "Decide by Friday",
        agentIds: [lia.id],
        rounds: 1,
        speakers: [
          { type: "agent", id: lia.id },
          { type: "person", id: beto.user.id },
          { type: "person", id: caio.user.id },
        ],
      });
      expect(created.waitingUserIds.sort()).toEqual([beto.user.id, caio.user.id].sort());
      await settle();
      for (const who of [beto, caio]) {
        const waiting = (await call(who, "GET", `${ws(workspaceId)}/notifications?filter=waiting`)).body
          .items;
        expect(waiting.map((x: { kind: string }) => x.kind)).toContain("debate_turn");
      }
      expect((await call(beto, "GET", `${base}/${created.id}`)).body.awaitedUserId).not.toBeNull();
    },
    SERVER_TEST_MS,
  );

  test(
    "conclude early, cancel, the people at the table and asking for one more round",
    async () => {
      const { workspaceId, base, open, ana, beto, lia, rui } = await team();
      const t = await open(ana, {
        title: "Shipping price",
        goal: "Set the shipping price",
        agentIds: [lia.id],
        rounds: 0,
        speakers: [
          { type: "person", id: beto.user.id },
          { type: "agent", id: lia.id },
        ],
      });
      await settle();
      // Only whoever opened it (or an admin) runs it.
      expect((await call(beto, "POST", `${base}/${t.id}/cancel`)).status).toBe(403);
      // A vote (0 challenge rounds): Beto asks for one more round on his turn, and it is added to the limit.
      const asked = await call(beto, "POST", `${base}/${t.id}/posts`, {
        body: "One more round",
        wantsExtraRound: true,
      });
      expect(asked.status).toBe(201);
      await settle();
      expect((await call(ana, "GET", `${base}/${t.id}`)).body.roundLimit).toBe(1);

      const changed = (
        await call(ana, "PUT", `${base}/${t.id}/participants`, {
          agentsToAdd: [rui.id],
          removeSpeakerUserIds: [beto.user.id],
        })
      ).body;
      expect(changed.speakers).toEqual([
        { type: "agent", id: lia.id },
        { type: "agent", id: rui.id },
      ]);
      expect(changed.agentIds).toEqual([lia.id, rui.id]);
      // Rui came in later and got a pseudonym of his own (seen once the debate closes).
      const row = await debateById(server.deps.db, workspaceId, t.id);
      expect(row.pseudonyms[rui.id]).toMatch(/^[A-Z]$/);
      expect(row.pseudonyms[rui.id]).not.toBe(row.pseudonyms[lia.id]);
      const none = await call(ana, "PUT", `${base}/${t.id}/participants`, {
        agentsToRemove: [lia.id, rui.id],
      });
      expect(none.body.error.code).toBe("debate.no_agents");

      // Ana at the table: concluding skips the rounds left and goes to the synthesis.
      const second = await open(ana, {
        title: "Another",
        goal: "x",
        agentIds: [lia.id],
        rounds: 5,
        speakers: [
          { type: "person", id: ana.user.id },
          { type: "agent", id: lia.id },
        ],
      });
      await settle();
      const concluded = (await call(ana, "POST", `${base}/${second.id}/conclude`)).body;
      expect(concluded).toMatchObject({ phase: "concluding", endReason: "concluded", waitingUserIds: [] });

      const third = await open(ana, {
        title: "Cancel",
        goal: "x",
        agentIds: [lia.id],
        speakers: [{ type: "person", id: ana.user.id }],
      });
      await settle();
      const canceled = (await call(ana, "POST", `${base}/${third.id}/cancel`)).body;
      expect(canceled).toMatchObject({ status: "canceled", awaitedUserId: null });
      expect((await call(ana, "GET", `${ws(workspaceId)}/notifications/counts`)).body.waiting).toBe(0);
      expect((await call(ana, "POST", `${base}/${third.id}/cancel`)).body.error.code).toBe("debate.closed");
    },
    SERVER_TEST_MS,
  );

  test(
    "a debate suggestion in the chat: accepting opens the debate, dismissing closes it",
    async () => {
      const { workspaceId, general, ana, beto, lia, rui } = await team();
      const socket = await TestSocket.open(beto.browser, workspaceId);
      await socket.subscribe(general);
      const post = async (title: string) => {
        const [m] = await server.deps.db
          .insert(schema.messages)
          .values({
            id: `msg_sug_${title}_${n}`,
            workspaceId,
            channelId: general,
            authorKind: "agent",
            authorId: lia.id,
            body: `How about debating: ${title}?`,
            meta: { debateSuggestion: { title, goal: `Decide ${title}`, agentIds: [lia.id, rui.id] } },
          })
          .returning();
        return m?.id ?? "";
      };
      const sugg = `${ws(workspaceId)}/debate-suggestions`;
      const a = await post("hours");
      const res = (await call(beto, "POST", `${sugg}/${a}/accept`, { rounds: 1 })).body;
      expect(res.suggestion).toMatchObject({
        state: "accepted",
        debateId: res.debate.id,
        proposerAgentId: lia.id,
      });
      expect(res.debate).toMatchObject({
        title: "hours",
        goal: "Decide hours",
        createdBy: { type: "agent", id: lia.id },
        requesterUserId: beto.user.id,
        origin: { kind: "suggestion", channelId: general, agentId: lia.id },
      });
      expect(ev(await socket.event("debate.suggestion_updated"))).toMatchObject({
        messageId: a,
        suggestion: { state: "accepted" },
      });
      // The chat route (S6) reads the message back; here, its saved meta.
      const [msg] = await server.deps.db.select().from(schema.messages).where(eq(schema.messages.id, a));
      expect(msg?.meta.debate).toEqual({ debateId: res.debate.id, title: "hours" });
      expect(msg?.meta.debateSuggestion).toMatchObject({ state: "accepted", debateId: res.debate.id });
      expect((await call(beto, "POST", `${sugg}/${a}/accept`, {})).body.error.code).toBe(
        "debate.suggestion_closed",
      );

      const b = await post("menu");
      expect((await call(ana, "POST", `${sugg}/${b}/dismiss`)).body.suggestion.state).toBe("dismissed");
      socket.close();
      await settle();
    },
    SERVER_TEST_MS,
  );
});

describe("the debates' debts (F2-3.2-P0-01)", () => {
  test(
    "a debate of a private channel: whoever isn't in the channel doesn't see it in the list, the read, the search or the socket",
    async () => {
      const { workspaceId, base, open, ana, beto, caio, lia } = await team();
      const betoSocket = await TestSocket.open(beto.browser, workspaceId);
      const secret = await seedChannel(server, workspaceId, {
        name: "board",
        visibility: "private",
        members: [ana],
      });
      const hidden = await open(ana, {
        title: "Confidential layoffs",
        goal: "Plan to cut staff",
        agentIds: [lia.id],
        rounds: 1,
        channelId: secret,
      });
      const shown = await open(ana, {
        title: "Public layoffs",
        goal: "General policy",
        agentIds: [lia.id],
        rounds: 1,
      });
      await settle();

      // The list and the read.
      const ids = async (who: Person) =>
        ((await call(who, "GET", base)).body.debates as { id: string }[]).map((d) => d.id);
      expect(await ids(beto)).toEqual([shown.id]);
      expect((await ids(ana)).sort()).toEqual([hidden.id, shown.id].sort());
      expect((await call(beto, "GET", `${base}/${hidden.id}`)).status).toBe(404);
      expect((await call(beto, "POST", `${base}/${hidden.id}/posts`, { body: "hi" })).status).toBe(404);
      // The search.
      const hits = async (who: Person, q: string) =>
        (
          (await call(who, "GET", `${ws(workspaceId)}/search?q=${encodeURIComponent(q)}&kinds=debate`)).body
            .hits as { sourceId: string }[]
        ).map((h) => h.sourceId);
      expect(await hits(beto, "layoffs")).toEqual([shown.id]);
      expect(await hits(ana, "Confidential")).toEqual([hidden.id]);
      // The socket: Beto got the public debate's events and none of the private one's.
      const debateIds = betoSocket.frames
        .filter((f) => f.type === "event")
        .map((f) => ev(f))
        .filter((e) => String(e.type).startsWith("debate."))
        .map((e) => (e as { debateId?: string }).debateId);
      expect(debateIds).toContain(shown.id);
      expect(debateIds).not.toContain(hidden.id);
      betoSocket.close();

      // Whoever was called to the table sees it, even outside the channel.
      await call(ana, "PUT", `${base}/${hidden.id}/participants`, { peopleToAdd: [caio.user.id] });
      expect((await call(caio, "GET", `${base}/${hidden.id}`)).body.title).toBe("Confidential layoffs");
      expect(await ids(caio)).toContain(hidden.id);
      // Whoever joins the channel starts seeing it.
      await addToChannel(server, secret, { type: "person", id: beto.user.id });
      expect((await call(beto, "GET", `${base}/${hidden.id}`)).body.id).toBe(hidden.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "resuming and creating issues: rejected for whoever doesn't run the debate",
    async () => {
      const { workspaceId, base, open, ana, beto, lia, rui } = await team();
      const t = await open(ana, { title: "Stalled", goal: "x", agentIds: [lia.id, rui.id], rounds: 1 });
      await settle();
      // An agent that fails stalls the debate (its turn is the runtime's, S6): the state it leaves.
      await server.deps.db
        .update(schema.debates)
        .set({ status: "stalled", stallInfo: { agentId: rui.id, round: 0, reason: "failed" } })
        .where(eq(schema.debates.id, t.id));
      expect((await call(beto, "GET", `${base}/${t.id}`)).body.status).toBe("stalled");
      expect((await call(beto, "POST", `${base}/${t.id}/resume`)).status).toBe(403);
      expect(
        (await call(beto, "POST", `${base}/${t.id}/issues`, { items: [{ title: "Break in" }] })).status,
      ).toBe(403);
      expect(
        await server.deps.db.select().from(schema.issues).where(eq(schema.issues.workspaceId, workspaceId)),
      ).toEqual([]);
      // Whoever opened it can.
      const made = (await call(ana, "POST", `${base}/${t.id}/issues`, { items: [{ title: "Fix Rui" }] }))
        .body;
      expect(made.numbers).toHaveLength(1);
      expect((await debateById(server.deps.db, workspaceId, t.id)).issueIds).toEqual([made.issues[0].id]);
      expect((await call(ana, "POST", `${base}/${t.id}/resume`)).body.status).toBe("open");
      expect((await call(ana, "POST", `${base}/${t.id}/resume`)).body.error.code).toBe("debate.not_stalled");
      await settle();
    },
    SERVER_TEST_MS,
  );

  test("cutting the transcript: each post and the total have a ceiling, the latest stay", () => {
    const posts = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      author: { type: "agent", id: "ag" },
      kind: "turn",
      round: i + 1,
      body: `${String(i).padStart(2, "0")}${"x".repeat(5000)}`,
    })) as unknown as DebatePostRow[];
    const text = transcript(posts, new Map([["ag", "Lia"]]));
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_CHARS + 100);
    expect(text).toContain("earlier post(s) omitted");
    expect(text).toContain('<post round="20" from="Lia">\n19');
    expect(text).not.toContain('<post round="1" from="Lia">\n00');
    for (const line of text.split("\n\n").slice(1)) expect(line.length).toBeLessThan(POST_CHARS + 40);
  });
});

describe("anonymity through the routes", () => {
  test(
    "while the debate is open, no route, list, event or error ties an agent's post to the agent",
    async () => {
      const { workspaceId, base, open, ana, beto, lia, rui } = await team();
      const socket = await TestSocket.open(beto.browser, workspaceId);
      const t = await open(ana, {
        title: "Masked",
        goal: "Who said it?",
        agentIds: [lia.id, rui.id],
        rounds: 2,
        speakers: [
          { type: "agent", id: lia.id },
          { type: "agent", id: rui.id },
          { type: "person", id: beto.user.id },
        ],
      });
      await settle();
      // The agents answer round 0 the way their turn does (the runtime's, S6).
      const row = await debateById(server.deps.db, workspaceId, t.id);
      const claim = (answer: string) => ({
        answer,
        key: answer,
        confidence: 0.7,
        reason: "",
        evidence: [],
        changed: false,
      });
      for (const [agent, answer] of [
        [lia, "yes"],
        [rui, "no"],
      ] as const) {
        const who: ActorRef = { type: "agent", id: agent.id };
        expect(
          await answerRound(server.deps, row, who, {
            kind: "turn",
            body: `I say ${answer}`,
            claimData: claim(answer),
            runId: `run_${agent.handle}`,
          }),
        ).not.toBeNull();
      }
      // Beto's answer closes round 0: the hidden posts open together, under pseudonyms.
      const [hiddenPost] = await server.deps.db
        .select()
        .from(schema.debatePosts)
        .where(and(eq(schema.debatePosts.debateId, t.id), eq(schema.debatePosts.hiddenUntilRoundEnd, true)));
      // Replying to a hidden post answers as one that doesn't exist.
      const probe = await call(beto, "POST", `${base}/${t.id}/posts`, {
        body: "re",
        replyTo: hiddenPost?.id,
      });
      expect([probe.status, probe.body.error.code]).toEqual([404, "not_found"]);
      expect(
        (await call(beto, "POST", `${base}/${t.id}/posts`, { body: "Maybe", answer: "maybe" })).status,
      ).toBe(201);
      await settle();

      const agentIds = [lia.id, rui.id];
      /** Every agent author and run id anywhere in a body (a masked post has neither). */
      const leaks = (value: unknown): string[] => {
        const found: string[] = [];
        const walk = (v: unknown) => {
          if (Array.isArray(v)) for (const x of v) walk(x);
          else if (v && typeof v === "object")
            for (const [k, x] of Object.entries(v)) {
              if (
                k === "author" &&
                x &&
                typeof x === "object" &&
                "type" in x &&
                x.type === "agent" &&
                "id" in x
              )
                found.push(String(x.id));
              if (k === "runId" && typeof x === "string") found.push(x);
              walk(x);
            }
        };
        walk(value);
        return found;
      };
      const detail = (await call(beto, "GET", `${base}/${t.id}`)).body;
      const agentPosts = detail.posts.filter((p: { kind: string }) => p.kind === "turn");
      expect(agentPosts).toHaveLength(2);
      for (const p of agentPosts)
        expect(p).toMatchObject({ author: null, runId: null, pseudonym: expect.stringMatching(/^[A-Z]$/) });
      expect(detail).toMatchObject({ anonymous: true, pseudonyms: null });
      const responses = [
        detail,
        (await call(beto, "GET", base)).body,
        (await call(beto, "POST", `${base}/${t.id}/posts`, { body: "A comment" })).body,
        (await call(ana, "PUT", `${base}/${t.id}/participants`, { peopleToAdd: [beto.user.id] })).body,
        (await call(beto, "POST", `${base}/${t.id}/skip`)).body,
        (await call(beto, "GET", `${base}/${t.id}/review`)).body,
        (await call(beto, "GET", `${base}/metrics`)).body,
        (await call(ana, "POST", `${base}/${t.id}/verdict`, { action: "accept" })).body,
      ];
      for (const r of responses) expect(leaks(r)).toEqual([]);
      // The socket's events carry the same masked posts.
      const events = socket.frames.filter((f) => f.type === "event").map((f) => ev(f));
      const created = events.filter(
        (e) => e.type === "debate.post_created" && (e as { debateId?: string }).debateId === t.id,
      );
      expect(created.length).toBeGreaterThanOrEqual(2);
      expect(leaks(events)).toEqual([]);
      socket.close();

      // Concluding keeps it masked until the synthesis closes it; canceling closes it and shows who spoke.
      expect(leaks((await call(ana, "POST", `${base}/${t.id}/conclude`)).body)).toEqual([]);
      const canceled = (await call(ana, "POST", `${base}/${t.id}/cancel`)).body;
      expect(canceled.anonymous).toBe(false);
      // The check sees an author when there is one: closed, both agents and their runs show.
      expect(leaks(canceled).sort()).toEqual([...agentIds, "run_lia", "run_rui"].sort());
      expect(
        canceled.posts
          .filter((p: { kind: string }) => p.kind === "turn")
          .map((p: { author: ActorRef }) => p.author.id)
          .sort(),
      ).toEqual(agentIds.sort());
    },
    SERVER_TEST_MS,
  );
});

describe("anonymity when the table changes", () => {
  test(
    "an agent added to an anonymous debate can't be told by its pseudonym: every label is drawn again, old posts keep theirs",
    async () => {
      const { workspaceId, general, base, open, ana, beto, lia, rui } = await team();
      const eva = await seedAgent(server, workspaceId, ana, "eva", [general]);
      const t = await open(ana, {
        title: "Recast",
        goal: "Who joined?",
        agentIds: [lia.id, rui.id],
        rounds: 5,
        speakers: [
          { type: "agent", id: lia.id },
          { type: "agent", id: rui.id },
          { type: "person", id: beto.user.id },
        ],
      });
      await settle();
      /**
       * One round: each agent still in the queue answers the way its turn does (each its own answer, a new one
       * every round, so the table neither agrees nor settles and goes on), then Beto closes it.
       */
      let played = 0;
      const round = async (agents: { id: string }[]) => {
        played++;
        for (const [i, agent] of agents.entries()) {
          const answer = `answer ${played}.${i}`;
          const row = await debateById(server.deps.db, workspaceId, t.id);
          await answerRound(
            server.deps,
            row,
            { type: "agent", id: agent.id },
            {
              kind: "turn",
              body: "neutral",
              claimData: {
                answer,
                key: answer,
                confidence: 0.7,
                reason: "",
                evidence: [],
                changed: played > 1,
              },
            },
          );
        }
        const closing = await call(beto, "POST", `${base}/${t.id}/posts`, {
          body: "neutral",
          answer: `mine ${played}`,
        });
        expect(closing.status).toBe(201);
        await settle();
      };
      type Shown = { id: string; kind: string; pseudonym: string | null; author: unknown };
      const turns = async () =>
        ((await call(beto, "GET", `${base}/${t.id}`)).body.posts as Shown[]).filter((p) => p.kind === "turn");
      await round([lia, rui]);
      const before = await turns();
      expect(before).toHaveLength(2);
      const oldLabels = new Set(before.map((p) => p.pseudonym));
      expect(oldLabels.size).toBe(2);

      const added = await call(ana, "PUT", `${base}/${t.id}/participants`, { agentsToAdd: [eva.id] });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ anonymous: true, pseudonyms: null });
      await settle();
      // The newcomer speaks from the next round on; play rounds until it has.
      for (let i = 0; i < 3; i++) {
        const posts = await server.deps.db
          .select()
          .from(schema.debatePosts)
          .where(eq(schema.debatePosts.debateId, t.id));
        if (posts.some((p) => p.author.id === eva.id)) break;
        await round([lia, rui, eva]);
      }
      const after = await turns();
      // What was published keeps its label.
      for (const p of before) expect(after.find((q) => q.id === p.id)?.pseudonym).toBe(p.pseudonym);
      const later = after.filter((p) => !before.some((q) => q.id === p.id));
      for (const p of later) expect(p.author).toBeNull();
      // After the change, the three agents show under three labels the debate never showed before: none is "the
      // one label that is new", so the newcomer's posts look like anyone's.
      const newLabels = new Set(later.map((p) => p.pseudonym));
      expect(newLabels.size).toBe(3);
      for (const label of newLabels) expect(oldLabels.has(label)).toBe(false);

      // Once closed, the posts show who spoke, and the newcomer is one of the new labels.
      const canceled = (await call(ana, "POST", `${base}/${t.id}/cancel`)).body;
      const evaLabels = canceled.posts
        .filter((p: { author: ActorRef | null }) => p.author?.id === eva.id)
        .map((p: Shown) => p.pseudonym);
      expect(evaLabels.length).toBeGreaterThan(0);
      for (const label of evaLabels) expect(newLabels.has(label)).toBe(true);
    },
    SERVER_TEST_MS,
  );
});

describe("debates: who may call each route", () => {
  test(
    "another workspace, a non-member, a signed-out caller, the wrong role and a private channel are rejected",
    async () => {
      const { workspaceId, general, base, open, ana, beto, lia } = await team();
      const t = await open(ana, { title: "Guarded", goal: "x", agentIds: [lia.id], rounds: 1 });
      await settle();
      const [m] = await server.deps.db
        .insert(schema.messages)
        .values({
          id: `msg_guard_${n}`,
          workspaceId,
          channelId: general,
          authorKind: "agent",
          authorId: lia.id,
          body: "Debate?",
          meta: { debateSuggestion: { title: "Guard", agentIds: [lia.id] } },
        })
        .returning();
      const sugg = `${ws(workspaceId)}/debate-suggestions/${m?.id}`;
      const routes: [string, string, unknown?][] = [
        ["GET", base],
        ["GET", `${base}/estimate?agentIds=${lia.id}&rounds=1`],
        ["GET", `${base}/metrics`],
        ["GET", `${base}/${t.id}`],
        ["POST", base, { title: "x", goal: "y", agentIds: [lia.id] }],
        ["POST", `${base}/${t.id}/posts`, { body: "x" }],
        ["POST", `${base}/${t.id}/skip`],
        ["POST", `${base}/${t.id}/conclude`],
        ["POST", `${base}/${t.id}/cancel`],
        ["POST", `${base}/${t.id}/resume`],
        ["PUT", `${base}/${t.id}/participants`, {}],
        ["POST", `${base}/${t.id}/issues`, { items: [{ title: "x" }] }],
        ["POST", `${base}/${t.id}/verdict`, { action: "accept" }],
        ["GET", `${base}/${t.id}/review`],
        ["POST", `${base}/${t.id}/review`, { pick: "a" }],
        ["POST", `${sugg}/accept`, {}],
        ["POST", `${sugg}/dismiss`],
      ];
      const outsider = await signedIn(server, "Out", email("out"));
      const other = await seedWorkspace(server, outsider, "Other");
      const anonymous: Person = { browser: new Browser(server.url), user: { id: "", name: "", email: "" } };
      for (const [method, path, payload] of routes) {
        expect([method, path, (await call(outsider, method, path, payload)).status]).toEqual([
          method,
          path,
          404,
        ]);
        expect([method, path, (await call(anonymous, method, path, payload)).status]).toEqual([
          method,
          path,
          401,
        ]);
      }
      // The debate through the outsider's own workspace isn't there.
      expect((await call(outsider, "GET", `${ws(other.workspaceId)}/debates/${t.id}`)).status).toBe(404);
      // A member who doesn't run the debate can't conclude, cancel, resume, change the table, make issues or judge.
      for (const action of ["conclude", "cancel", "resume", "issues", "verdict"])
        expect([
          action,
          (
            await call(
              beto,
              "POST",
              `${base}/${t.id}/${action}`,
              action === "issues"
                ? { items: [{ title: "x" }] }
                : action === "verdict"
                  ? { action: "accept" }
                  : undefined,
            )
          ).status,
        ]).toEqual([action, 403]);
      expect((await call(beto, "PUT", `${base}/${t.id}/participants`, {})).status).toBe(403);
      // Not their turn: skipping is rejected without saying whose turn it is.
      expect((await call(beto, "POST", `${base}/${t.id}/skip`)).body.error.code).toBe("debate.out_of_turn");
      // Whoever runs the debate can't bring to the table someone outside the workspace, as a reader or a speaker.
      const table = await debateById(server.deps.db, workspaceId, t.id);
      for (const body of [{ peopleToAdd: [outsider.user.id] }, { addSpeakerUserIds: [outsider.user.id] }]) {
        const res = await call(ana, "PUT", `${base}/${t.id}/participants`, body);
        expect([Object.keys(body)[0], res.status, res.body.error?.code]).toEqual([
          Object.keys(body)[0],
          404,
          "not_found",
        ]);
      }
      const untouched = await debateById(server.deps.db, workspaceId, t.id);
      expect([untouched.userIds, untouched.speakers]).toEqual([table.userIds, table.speakers]);
      // An admin runs anyone's debate.
      const admin = await memberOf(server, workspaceId, "Adm", email("adm"), "admin");
      expect((await call(admin, "POST", `${base}/${t.id}/cancel`)).body.status).toBe("canceled");

      // A private channel: its debate and its suggestions don't exist for whoever doesn't read it.
      const secret = await seedChannel(server, workspaceId, {
        name: "private",
        visibility: "private",
        members: [ana],
      });
      const hidden = await open(ana, {
        title: "Hidden",
        goal: "x",
        agentIds: [lia.id],
        rounds: 1,
        channelId: secret,
      });
      await settle();
      await server.deps.db
        .update(schema.debates)
        .set({
          status: "done",
          synthesis: sql`'{"format":"decision","revision":1,"structured":{"summary":"s"}}'::jsonb`,
        })
        .where(eq(schema.debates.id, hidden.id));
      for (const [method, path, payload] of [
        ["GET", `${base}/${hidden.id}`],
        ["POST", `${base}/${hidden.id}/posts`, { body: "x" }],
        ["POST", `${base}/${hidden.id}/skip`],
        ["GET", `${base}/${hidden.id}/review`],
        ["POST", `${base}/${hidden.id}/review`, { pick: "a" }],
        ["POST", `${base}/${hidden.id}/verdict`, { action: "accept" }],
      ] as [string, string, unknown?][])
        expect([method, path, (await call(beto, method, path, payload)).status]).toEqual([method, path, 404]);
      const [pm] = await server.deps.db
        .insert(schema.messages)
        .values({
          id: `msg_private_${n}`,
          workspaceId,
          channelId: secret,
          authorKind: "agent",
          authorId: lia.id,
          body: "Debate?",
          meta: { debateSuggestion: { title: "Private", agentIds: [lia.id] } },
        })
        .returning();
      expect(
        (await call(beto, "POST", `${ws(workspaceId)}/debate-suggestions/${pm?.id}/accept`, {})).status,
      ).toBe(404);
      // Opening a debate in a channel the person doesn't read is rejected as if it didn't exist.
      expect(
        (await call(beto, "POST", base, { title: "x", goal: "y", agentIds: [lia.id], channelId: secret }))
          .status,
      ).toBe(404);
    },
    SERVER_TEST_MS,
  );
});
