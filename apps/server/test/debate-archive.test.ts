// A debate turn that is at the model when its agent is archived: the turn isn't posted in the archived agent's name,
// and the agent leaves the round. Each debate call is scripted; everything else goes to the fake model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { eq } from "drizzle-orm";
import { archiveAgent } from "../src/control";
import { textProvider } from "../src/debate-benchmark";
import { answerRound } from "../src/debates";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedWorkspace } from "./seed";

const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("") ?? "";
const position = (answer: string) =>
  `I say ${answer}.\n${JSON.stringify({ answer, confidence: 0.7, reason: "", evidence: [] })}`;

let server: RunningServer;
/** Runs inside Lia's first debate call, before the model answers. */
let duringLia: (() => Promise<void>) | null = null;
/** Runs inside Lia's synthesis call (she leads: the first agent). */
let duringLiaSynth: (() => Promise<void>) | null = null;
beforeAll(async () => {
  const scripted = textProvider(async (req) => {
    const agent = (/^You are (\S+)/.exec(req.system)?.[1] ?? "?").replace(/[,.]$/, "");
    if (agent === "Lia" && duringLiaSynth && /^Write the synthesis/.test(lastText(req))) {
      const run = duringLiaSynth;
      duringLiaSynth = null;
      await run();
    }
    if (agent === "Lia" && duringLia) {
      const run = duringLia;
      duringLia = null;
      await run();
    }
    return position(agent.toLowerCase());
  });
  const fake = fakeProvider();
  const debateCall = (req: ModelRequest) => /^(Round \d+ of|Write the synthesis)/.test(lastText(req));
  server = await startTestServer({
    modelProvider: { kind: "fake", stream: (req) => (debateCall(req) ? scripted : fake).stream(req) },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

describe("a debate turn in flight when its agent is archived", () => {
  test(
    "isn't posted in the archived agent's name",
    async () => {
      const ana = await signedIn(server, "Ana", "ana@debate-archive.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "Debate");
      const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
      const rui = await seedAgent(server, workspaceId, ana, "rui", [general]);
      let archived = false;
      duringLia = async () => {
        await archiveAgent(server.deps, workspaceId, lia.id, ana.user.id);
        archived = true;
      };
      const res = await call(ana, "POST", `${ws(workspaceId)}/debates`, {
        title: "Archive mid-turn",
        goal: "Decide",
        agentIds: [lia.id, rui.id],
        rounds: 0,
        speakers: [
          { type: "agent", id: lia.id },
          { type: "agent", id: rui.id },
        ],
      });
      expect(res.status).toBe(201);
      for (let i = 0; i < 60 && !archived; i++) await Bun.sleep(50);
      await Bun.sleep(300);
      await server.deps.runtime.settle();
      expect(archived).toBe(true);
      const posts = await server.deps.db
        .select({ author: schema.debatePosts.author, kind: schema.debatePosts.kind })
        .from(schema.debatePosts)
        .where(eq(schema.debatePosts.debateId, res.body.id));
      const lias = posts.filter(
        (p) => (p.author as { id?: string } | null)?.id === lia.id && p.kind === "turn",
      );
      expect(lias).toEqual([]);
      // Rui still had his turn: the round went on without her.
      expect(
        posts.some((p) => (p.author as { id?: string } | null)?.id === rui.id && p.kind === "turn"),
      ).toBe(true);
    },
    SERVER_TEST_MS,
  );
});

describe("an archived agent in a debate", () => {
  test(
    "its turn isn't saved when the archive lands after the turn's own check, and it leaves the round",
    async () => {
      const ana = await signedIn(server, "Ana", "ana3@debate-archive.test");
      const { workspaceId } = await seedWorkspace(server, ana, "Queue");
      const lia = await seedAgent(server, workspaceId, ana, "lia", []);
      const id = newId("dbt");
      const who = { type: "agent" as const, id: lia.id };
      const [row] = await server.deps.db
        .insert(schema.debates)
        .values({
          id,
          workspaceId,
          title: "Queue",
          goal: "Decide",
          createdBy: { type: "person", id: ana.user.id },
          agentIds: [lia.id],
          round: 0,
          phase: "debating",
          pendingSpeakers: [who],
        })
        .returning();
      if (!row) throw new Error("no debate");
      await server.deps.db
        .update(schema.agents)
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.id, lia.id));
      expect(await answerRound(server.deps, row, who, { kind: "turn", body: "My turn" })).toBe(null);
      const posts = await server.deps.db
        .select()
        .from(schema.debatePosts)
        .where(eq(schema.debatePosts.debateId, id));
      expect(posts).toEqual([]);
      const [after] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, id));
      expect(after?.pendingSpeakers).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  /** A debate of Lia (lead) and Rui; `archive` runs inside Lia's synthesis call. Returns its posts and status. */
  async function synthesisWhile(email: string, archive: (ids: { lia: string; rui: string }) => string[]) {
    const ana = await signedIn(server, "Ana", email);
    const { workspaceId, general } = await seedWorkspace(server, ana, "Synthesis");
    const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
    const rui = await seedAgent(server, workspaceId, ana, "rui", [general]);
    let archived = false;
    duringLiaSynth = async () => {
      for (const id of archive({ lia: lia.id, rui: rui.id }))
        await archiveAgent(server.deps, workspaceId, id, ana.user.id);
      archived = true;
    };
    const res = await call(ana, "POST", `${ws(workspaceId)}/debates`, {
      title: "Archive mid-synthesis",
      goal: "Decide",
      agentIds: [lia.id, rui.id],
      rounds: 0,
      speakers: [
        { type: "agent", id: lia.id },
        { type: "agent", id: rui.id },
      ],
    });
    expect(res.status).toBe(201);
    for (let i = 0; i < 80 && !archived; i++) {
      await server.deps.runtime.settle();
      await Bun.sleep(50);
    }
    await Bun.sleep(300);
    await server.deps.runtime.settle();
    expect(archived).toBe(true);
    const posts = await server.deps.db
      .select({ author: schema.debatePosts.author, kind: schema.debatePosts.kind })
      .from(schema.debatePosts)
      .where(eq(schema.debatePosts.debateId, res.body.id));
    const [debate] = await server.deps.db
      .select({ status: schema.debates.status, synthesis: schema.debates.synthesis })
      .from(schema.debates)
      .where(eq(schema.debates.id, res.body.id));
    const notices = await server.deps.db
      .select({ actors: schema.notifications.actors })
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `debate_synthesis:${res.body.id}`));
    const signers = posts
      .filter((p) => p.kind === "synthesis")
      .map((p) => (p.author as { id?: string } | null)?.id);
    return { lia: lia.id, rui: rui.id, signers, debate, notices: JSON.stringify(notices) };
  }

  test(
    "a lead archived while it writes the synthesis doesn't sign it: the next active agent signs the votes",
    async () => {
      const out = await synthesisWhile("ana4@debate-archive.test", ({ lia }) => [lia]);
      expect(out.signers).toEqual([out.rui]);
      expect(out.debate?.status).toBe("done");
      expect(out.notices).not.toContain(out.lia);
    },
    SERVER_TEST_MS,
  );

  test(
    "with every agent archived while the lead writes, the debate closes on the votes and nobody signs it",
    async () => {
      const out = await synthesisWhile("ana5@debate-archive.test", ({ lia, rui }) => [lia, rui]);
      expect(out.signers).toEqual([]);
      expect(out.debate?.status).toBe("done");
      expect(out.debate?.synthesis).not.toBe(null);
      expect(out.notices).not.toContain(out.lia);
      expect(out.notices).not.toContain(out.rui);
    },
    SERVER_TEST_MS,
  );
});

describe("who signs a debate's synthesis", () => {
  /**
   * A debate of `names` (created in that order) with `agentIds` in `order`; `during` runs at the moment it says. Waits
   * until the debate closes or stalls, and returns the synthesis signers, the debate and the notices' actors.
   */
  async function debate(
    tag: string,
    names: string[],
    order: (ids: Record<string, string>) => string[],
    setup: (ids: Record<string, string>, archive: (id: string) => Promise<void>) => void,
  ) {
    const ana = await signedIn(server, "Ana", `ana-${tag}@debate-archive.test`);
    const { workspaceId, general } = await seedWorkspace(server, ana, `Sign ${tag}`);
    const ids: Record<string, string> = {};
    for (const n of names) ids[n] = (await seedAgent(server, workspaceId, ana, n, [general])).id;
    setup(ids, (id) => archiveAgent(server.deps, workspaceId, id, ana.user.id));
    const agentIds = order(ids);
    const res = await call(ana, "POST", `${ws(workspaceId)}/debates`, {
      title: `Sign ${tag}`,
      goal: "Decide",
      agentIds,
      rounds: 0,
      speakers: agentIds.map((id) => ({ type: "agent", id })),
    });
    expect(res.status).toBe(201);
    let row: typeof schema.debates.$inferSelect | undefined;
    for (let i = 0; i < 80; i++) {
      await server.deps.runtime.settle();
      [row] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, res.body.id));
      if (row?.status === "done" || row?.status === "stalled") break;
      await Bun.sleep(50);
    }
    const posts = await server.deps.db
      .select({ author: schema.debatePosts.author, kind: schema.debatePosts.kind })
      .from(schema.debatePosts)
      .where(eq(schema.debatePosts.debateId, res.body.id));
    const name = (id?: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    const signers = posts
      .filter((p) => p.kind === "synthesis")
      .map((p) => name((p.author as { id?: string } | null)?.id));
    return { ids, row, signers };
  }

  test(
    "with the lead archived while it writes, the next active agent in the debate's order signs, not the oldest",
    async () => {
      // Max is created before Rui, but Rui comes first in the debate.
      const out = await debate(
        "order",
        ["lia", "max", "rui"],
        (i) => [i.lia ?? "", i.rui ?? "", i.max ?? ""],
        (i, archive) => {
          duringLiaSynth = () => archive(i.lia ?? "");
        },
      );
      expect(out.row?.status).toBe("done");
      expect(out.signers).toEqual(["rui"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a lead archived just before its synthesis call closes the debate on the votes, not stalled on it",
    async () => {
      const rt = server.deps.runtime;
      const complete = rt.complete;
      let lia = "";
      try {
        const out = await debate(
          "before-call",
          ["lia", "rui"],
          (i) => [i.lia ?? "", i.rui ?? ""],
          (i, archive) => {
            lia = i.lia ?? "";
            rt.complete = async (input) => {
              if (input.agent.id === lia && input.what === "Debate synthesis") await archive(lia);
              return complete.call(rt, input);
            };
          },
        );
        expect(out.row?.status).toBe("done");
        expect(out.row?.stallInfo ?? null).toBe(null);
        expect(out.signers).toEqual(["rui"]);
        expect(JSON.stringify(out.row?.synthesis)).toContain('"decision"');
      } finally {
        rt.complete = complete;
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a lead archived before the synthesis starts closes on the votes' decision, as one archived during it",
    async () => {
      const out = await debate(
        "before-synthesis",
        ["lia", "rui"],
        (i) => [i.lia ?? "", i.rui ?? ""],
        (i, archive) => {
          duringLia = () => archive(i.lia ?? "");
        },
      );
      expect(out.row?.status).toBe("done");
      expect(out.signers).toEqual(["rui"]);
      expect(JSON.stringify(out.row?.synthesis)).toContain('"decision":"rui"');
    },
    SERVER_TEST_MS,
  );

  test(
    "a debate of people only still gets its synthesis post",
    async () => {
      const ana = await signedIn(server, "Ana", "ana-people@debate-archive.test");
      const { workspaceId, general } = await seedWorkspace(server, ana, "People");
      const lia = await seedAgent(server, workspaceId, ana, "lia", [general]);
      const res = await call(ana, "POST", `${ws(workspaceId)}/debates`, {
        title: "People",
        goal: "Decide",
        agentIds: [lia.id],
        rounds: 0,
        speakers: [{ type: "person", id: ana.user.id }],
      });
      expect(res.status).toBe(201);
      await server.deps.db
        .update(schema.debates)
        .set({ agentIds: [], leadAgentId: null })
        .where(eq(schema.debates.id, res.body.id));
      const said = await call(ana, "POST", `${ws(workspaceId)}/debates/${res.body.id}/posts`, {
        body: "I say yes",
        answer: "yes",
      });
      expect(said.status).toBeLessThan(300);
      for (let i = 0; i < 20; i++) {
        await server.deps.runtime.settle();
        await Bun.sleep(50);
      }
      const [row] = await server.deps.db
        .select()
        .from(schema.debates)
        .where(eq(schema.debates.id, res.body.id));
      const posts = await server.deps.db
        .select({ kind: schema.debatePosts.kind })
        .from(schema.debatePosts)
        .where(eq(schema.debatePosts.debateId, res.body.id));
      expect(row?.status).toBe("done");
      expect(posts.filter((p) => p.kind === "synthesis").length).toBe(1);
    },
    SERVER_TEST_MS,
  );
});

describe("the debates' metrics", () => {
  test(
    "give the mean cost only to whoever has view_usage",
    async () => {
      const ana = await signedIn(server, "Ana", "ana2@debate-archive.test");
      const { workspaceId } = await seedWorkspace(server, ana, "Metrics");
      const beto = await memberOf(server, workspaceId, "Beto", "beto@debate-archive.test");
      const cost = async (who: Person) =>
        (await call(who, "GET", `${ws(workspaceId)}/debates/metrics`)).body.meanCostUsd;
      expect(await cost(beto)).toBe(null);
      expect(await cost(ana)).toBe(0);
    },
    SERVER_TEST_MS,
  );
});
