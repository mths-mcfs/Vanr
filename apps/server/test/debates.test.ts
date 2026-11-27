// Ported from the origin's debate tests, through routes/debates. An agent's turn and the synthesis ask the runtime
// for a text, which answers with the test's script (`script`): the debate calls follow it, anything else is the
// fake model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ActorRef } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { and, eq, sql } from "drizzle-orm";
import { textProvider } from "../src/debate-benchmark";
import {
  type DebatePostRow,
  debateById,
  POST_CHARS,
  resumeDebates,
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

const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("") ?? "";
/** An agent's turn: the argument, then the position as the debate protocol reads it. */
const position = (answer: string) =>
  `I say ${answer}.\n${JSON.stringify({ answer, confidence: 0.7, reason: "", evidence: [] })}`;
/** What a debate call answers, by the agent's name, the round (null: the synthesis). */
type Script = (agent: string, round: number | null) => string;
const byName: Script = (agent) => position(agent.toLowerCase());
let script: Script = byName;

let server: RunningServer;
beforeAll(async () => {
  const scripted = textProvider((req) => {
    const agent = /^You are (\S+)/.exec(req.system)?.[1] ?? "?";
    const round = /^Round (\d+)/.exec(lastText(req));
    return script(agent, round ? Number(round[1]) : null);
  });
  const fake = fakeProvider();
  const debateCall = (req: ModelRequest) => /^(Round \d+ of|Write the synthesis)/.test(lastText(req));
  server = await startTestServer({
    modelProvider: { kind: "fake", stream: (req) => (debateCall(req) ? scripted : fake).stream(req) },
  });
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

describe("a turn's paid call", () => {
  test(
    "a round resumed after a fall between an agent's answer and its post posts the recorded answer, without a second call",
    async () => {
      const { open, ana, lia } = await team();
      let calls = 0;
      let armed = false;
      script = (agent, round) => {
        if (agent === "Lia" && round === 0 && ++calls === 1) armed = true;
        return byName(agent, round);
      };
      // The fall: the post's write fails once, right after the answer came back.
      const real = server.deps.db;
      server.deps.db = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p) {
                    const v = Reflect.get(t, p, t);
                    if (p !== "insert") return typeof v === "function" ? v.bind(t) : v;
                    return (table: unknown) => {
                      if (armed && table === schema.debatePosts) {
                        armed = false;
                        throw new Error("fell before the post");
                      }
                      return t.insert(table as typeof schema.debatePosts);
                    };
                  },
                }),
              ),
            );
        },
      });
      try {
        const created = await open(ana, {
          title: "Paid once?",
          goal: "Decide",
          agentIds: [lia.id],
          rounds: 0,
          speakers: [{ type: "agent", id: lia.id }],
        });
        await settle();
        expect(calls).toBe(1);
        await resumeDebates(server.deps);
        await settle();
        const posts = await server.deps.db
          .select()
          .from(schema.debatePosts)
          .where(and(eq(schema.debatePosts.debateId, created.id), eq(schema.debatePosts.kind, "turn")));
        expect([calls, posts.map((p) => p.body)]).toEqual([1, ["I say lia."]]);
      } finally {
        server.deps.db = real;
        script = byName;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a turn whose answer can't be recorded posts it all the same, and leaves no claim behind",
    async () => {
      const { open, ana, lia } = await team();
      let calls = 0;
      script = (agent, round) => {
        if (agent === "Lia" && round === 0) calls++;
        return byName(agent, round);
      };
      let failed = false;
      const real = server.deps.db;
      server.deps.db = new Proxy(real, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "update") return typeof value === "function" ? value.bind(target) : value;
          return (table: unknown) => {
            const builder = target.update(table as typeof schema.effectKeys);
            if (table !== schema.effectKeys || failed) return builder;
            return new Proxy(builder, {
              get(b, p) {
                const v = Reflect.get(b, p, b);
                if (p !== "set") return typeof v === "function" ? v.bind(b) : v;
                return (row: { status?: string }) => {
                  if (row.status === "done") {
                    failed = true;
                    throw new Error("record failed");
                  }
                  return v.call(b, row);
                };
              },
            });
          };
        },
      });
      try {
        const created = await open(ana, {
          title: "Recorded?",
          goal: "Decide",
          agentIds: [lia.id],
          rounds: 0,
          speakers: [{ type: "agent", id: lia.id }],
        });
        await settle();
        const posts = await server.deps.db
          .select()
          .from(schema.debatePosts)
          .where(and(eq(schema.debatePosts.debateId, created.id), eq(schema.debatePosts.kind, "turn")));
        const claims = await server.deps.db
          .select()
          .from(schema.effectKeys)
          .where(sql`${schema.effectKeys.key} like ${`debate-turn:${created.id}:%`}`);
        expect([failed, calls, posts.length, claims.length]).toEqual([true, 1, 1, 0]);
      } finally {
        server.deps.db = real;
        script = byName;
      }
    },
    SERVER_TEST_MS,
  );
});

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
      // The chat route reads the message back; here, its saved meta.
      const [msg] = await server.deps.db.select().from(schema.messages).where(eq(schema.messages.id, a));
      expect(msg?.meta.debate).toEqual({ debateId: res.debate.id, title: "hours" });
      expect(msg?.meta.debateSuggestion).toMatchObject({ state: "accepted", debateId: res.debate.id });
      expect((await call(beto, "POST", `${sugg}/${a}/accept`, {})).body.error.code).toBe(
        "debate.suggestion_closed",
      );

      // Accepted with another goal and table: the suggestion says what the debate opened with.
      const c = await post("shifts");
      const changed = (
        await call(beto, "POST", `${sugg}/${c}/accept`, { goal: "Decide the shifts", agentIds: [rui.id] })
      ).body;
      expect(changed.suggestion).toMatchObject({ goal: "Decide the shifts", agentIds: [rui.id] });
      expect(changed.debate).toMatchObject({ goal: "Decide the shifts", agentIds: [rui.id] });
      const [cm] = await server.deps.db.select().from(schema.messages).where(eq(schema.messages.id, c));
      expect(cm?.meta.debateSuggestion).toMatchObject({ goal: "Decide the shifts", agentIds: [rui.id] });

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
      // An agent that fails stalls the debate: the state it leaves.
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
      meta: {},
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
      // A new answer every round: the table never settles, so it stays open while the routes are tried.
      script = (agent, round) => position(`${agent === "Lia" ? "yes" : "no"} ${round}`);
      const t = await open(ana, {
        title: "Masked",
        goal: "Who said it?",
        agentIds: [lia.id, rui.id],
        rounds: 5,
        speakers: [
          { type: "agent", id: lia.id },
          { type: "agent", id: rui.id },
          { type: "person", id: beto.user.id },
        ],
      });
      // The agents answer round 0 through the runtime.
      await settle();
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

      // Canceling closes it and shows who spoke.
      const turnRuns = (
        await server.deps.db.select().from(schema.debatePosts).where(eq(schema.debatePosts.debateId, t.id))
      ).flatMap((p) => (p.kind === "turn" && p.runId ? [p.runId] : []));
      expect(turnRuns.length).toBeGreaterThanOrEqual(2);
      script = byName;
      const canceled = (await call(ana, "POST", `${base}/${t.id}/cancel`)).body;
      expect(canceled.anonymous).toBe(false);
      // The check sees an author when there is one: closed, both agents and their runs show.
      const shown = new Set(leaks(canceled));
      for (const id of agentIds) expect(shown.has(id)).toBe(true);
      expect(turnRuns.filter((r) => shown.has(r)).length).toBeGreaterThanOrEqual(2);
      expect(
        [
          ...new Set(
            canceled.posts
              .filter((p: { kind: string }) => p.kind === "turn")
              .map((p: { author: ActorRef }) => p.author.id),
          ),
        ].sort(),
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
      script = (agent, round) => position(`answer ${round}.${agent}`);
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
       * One round: each agent in the queue answered through the runtime (each its own answer, a new one every
       * round, so the table neither agrees nor settles and goes on); then Beto closes it.
       */
      let played = 0;
      const round = async (_agents: { id: string }[]) => {
        played++;
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

      // Every post written so far, the ones still hidden in the round now open too: they keep the old labels.
      const existing = new Set(
        (
          await server.deps.db.select().from(schema.debatePosts).where(eq(schema.debatePosts.debateId, t.id))
        ).map((p) => p.id),
      );
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
        // Shown: a post of the round still open is hidden until it closes.
        if (posts.some((p) => p.author.id === eva.id && !p.hiddenUntilRoundEnd)) break;
        await round([lia, rui, eva]);
      }
      const after = await turns();
      // What was published keeps its label.
      for (const p of before) expect(after.find((q) => q.id === p.id)?.pseudonym).toBe(p.pseudonym);
      const later = after.filter((p) => !existing.has(p.id));
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
      script = byName;
    },
    SERVER_TEST_MS,
  );
});

describe("pseudonyms of the agents that only speak", () => {
  test(
    "an agent seated only as a speaker keeps its pseudonym when someone else joins the table",
    async () => {
      const { workspaceId, base, open, ana, caio, lia, rui } = await team();
      const t = await open(ana, {
        title: "Speakers",
        goal: "Who speaks?",
        agentIds: [lia.id],
        speakers: [
          { type: "agent", id: lia.id },
          { type: "agent", id: rui.id },
        ],
      });
      await settle();
      const before = (await debateById(server.deps.db, workspaceId, t.id)).pseudonyms;
      expect(Object.keys(before).sort()).toEqual([lia.id, rui.id].sort());
      const joined = await call(ana, "PUT", `${base}/${t.id}/participants`, { peopleToAdd: [caio.user.id] });
      expect(joined.status).toBe(200);
      // Same agents at the table: the same map, and the speaker-only agent still has its label.
      expect((await debateById(server.deps.db, workspaceId, t.id)).pseudonyms).toEqual(before);
    },
    SERVER_TEST_MS,
  );
});

describe("anonymity when an agent leaves", () => {
  test(
    "the round summary names the votes by the labels the posts showed: a removed agent's id never appears",
    async () => {
      const { workspaceId, general, base, open, ana, beto, lia, rui } = await team();
      const eva = await seedAgent(server, workspaceId, ana, "eva", [general]);
      const socket = await TestSocket.open(beto.browser, workspaceId);
      const voters = [lia, rui, eva];
      script = (agent) => position(agent === "Lia" ? "yes" : "no");
      const t = await open(ana, {
        title: "Leaver",
        goal: "Who left?",
        agentIds: voters.map((a) => a.id),
        rounds: 5,
        speakers: [
          ...voters.map((a) => ({ type: "agent" as const, id: a.id })),
          { type: "person", id: beto.user.id },
        ],
      });
      // The agents answer round 0 through the runtime.
      await settle();
      expect(
        (await call(beto, "POST", `${base}/${t.id}/posts`, { body: "neutral", answer: "no" })).status,
      ).toBe(201);
      await settle();
      const removed = await call(ana, "PUT", `${base}/${t.id}/participants`, { agentsToRemove: [rui.id] });
      expect(removed.status).toBe(200);
      await settle();

      const detail = (await call(beto, "GET", `${base}/${t.id}`)).body;
      expect(detail.anonymous).toBe(true);
      // The summary of round 0 lists the votes under the labels round 0's posts were shown with (and the person by
      // id): neither the leaver's id nor the labels drawn after the change, which would pair old labels with new.
      const shown = detail.posts
        .filter((p: { kind: string; round: number }) => p.kind === "turn" && p.round === 0)
        .map((p: { pseudonym: string }) => p.pseudonym);
      expect(shown).toHaveLength(3);
      const round0 = detail.track.roundLimit.find((r: { round: number }) => r.round === 0);
      const members = round0.majority.groups.flatMap((g: { members: string[] }) => g.members).sort();
      expect(members).toEqual([...shown, beto.user.id].sort());

      // Who sits at the table is public; who said what isn't. Outside the table's fields, no agent id or run id.
      const table = new Set(["agentIds", "speakers", "leadAgentId", "engagedAgentIds"]);
      const voterRuns = (
        await server.deps.db.select().from(schema.debatePosts).where(eq(schema.debatePosts.debateId, t.id))
      ).flatMap((p) => (p.kind === "turn" && p.runId ? [p.runId] : []));
      expect(voterRuns.length).toBeGreaterThanOrEqual(3);
      const secrets = [...voters.map((a) => a.id), ...voterRuns];
      const leaked = (value: unknown) => {
        const text = JSON.stringify(value, (k, v) => (table.has(k) ? undefined : v));
        return secrets.filter((s) => text.includes(s));
      };
      const events = socket.frames.filter((f) => f.type === "event").map((f) => ev(f));
      expect(events.some((e) => e.type === "debate.post_created")).toBe(true);
      for (const r of [detail, removed.body, (await call(beto, "GET", base)).body, events])
        expect(leaked(r)).toEqual([]);
      socket.close();
      // The synthesis reads round 0 under the labels the people read, with the table's current map at hand.
      const now = await debateById(server.deps.db, workspaceId, t.id);
      const posts = await server.deps.db
        .select()
        .from(schema.debatePosts)
        .where(eq(schema.debatePosts.debateId, t.id));
      const names = new Map(Object.entries(now.pseudonyms).map(([id, p]) => [id, `Participant ${p}`]));
      const said = transcript(posts, names);
      for (const label of shown) expect(said).toContain(`from="Participant ${label}"`);
      for (const label of Object.values(now.pseudonyms)) expect(said).not.toContain(`Participant ${label}"`);
      expect(leaked(said)).toEqual([]);
      const chunks = await server.deps.db
        .select({ text: schema.searchChunks.text, authorId: schema.searchChunks.authorId })
        .from(schema.searchChunks)
        .where(eq(schema.searchChunks.sourceId, t.id));
      expect(leaked(chunks)).toEqual([]);
      // The check bites: once the debate closes, the posts show their authors.
      const canceled = (await call(ana, "POST", `${base}/${t.id}/cancel`)).body;
      expect(leaked(canceled)).toEqual(expect.arrayContaining([lia.id, rui.id, eva.id]));
      script = byName;
    },
    SERVER_TEST_MS,
  );
});

describe("an answer when closing its notice fails", () => {
  test(
    "the answer is saved and the debate still moves on: the round closes and goes to the synthesis",
    async () => {
      const { workspaceId, base, open, ana, beto, lia } = await team();
      const t = await open(ana, {
        title: "Notice",
        goal: "Close it?",
        agentIds: [lia.id],
        rounds: 3,
        speakers: [{ type: "person", id: beto.user.id }],
      });
      await settle();
      expect((await debateById(server.deps.db, workspaceId, t.id)).round).toBe(0);
      // The next write to the notifications fails, once.
      const db = server.deps.db;
      let failed = false;
      server.deps.db = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "update") return typeof value === "function" ? value.bind(target) : value;
          return (table: unknown) => {
            if (table === schema.notifications && !failed) {
              failed = true;
              throw new Error("notifications down");
            }
            return target.update(table as typeof schema.notifications);
          };
        },
      });
      try {
        const res = await call(beto, "POST", `${base}/${t.id}/posts`, { body: "mine", answer: "yes" });
        expect(res.status).toBe(500);
      } finally {
        server.deps.db = db;
      }
      expect(failed).toBe(true);
      await settle();
      // The only voter answered: the round closed and the debate went on to its synthesis, which the lead wrote.
      const row = await debateById(server.deps.db, workspaceId, t.id);
      expect([row.round, row.status, row.endReason]).toEqual([0, "done", "unanimous"]);
    },
    SERVER_TEST_MS,
  );
});

describe("debate estimate", () => {
  test(
    "a vote (rounds=0) can be priced, like it can be opened: one turn per agent, cheaper than one more round",
    async () => {
      const { base, ana, lia, rui } = await team();
      const price = (rounds: number) =>
        call(ana, "GET", `${base}/estimate?agentIds=${lia.id},${rui.id}&rounds=${rounds}`);
      const vote = await price(0);
      const one = await price(1);
      expect([vote.status, one.status]).toEqual([200, 200]);
      expect(vote.body.calls).toBeLessThan(one.body.calls);
      expect(vote.body.upToUsd).toBeLessThan(one.body.upToUsd);
    },
    SERVER_TEST_MS,
  );
});

describe("debates: who may call each route", () => {
  test(
    "another workspace, a non-member, a signed-out caller, the wrong role and a private channel are rejected",
    async () => {
      const { workspaceId, general, base, open, ana, beto, caio, lia } = await team();
      // Caio at the table keeps it open while the routes are tried.
      const t = await open(ana, {
        title: "Guarded",
        goal: "x",
        agentIds: [lia.id],
        rounds: 1,
        speakers: [
          { type: "agent", id: lia.id },
          { type: "person", id: caio.user.id },
        ],
      });
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
