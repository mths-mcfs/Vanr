// Who seats which agent at a debate, who reads a private channel's debate, what a stalled turn tells while the
// debate is anonymous, and the estimate's amount, on the real server (PGlite). Rui's model call fails with a message
// that names him; Gate's turns wait for the test; Syn fails only the synthesis.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { and, eq } from "drizzle-orm";
import { textProvider } from "../src/debate-benchmark";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("") ?? "";
const position = (answer: string) =>
  `I argue for ${answer}.\n${JSON.stringify({ answer, confidence: 0.6, reason: "", evidence: [] })}`;

let server: RunningServer;
/** Gate's turns wait here until the test lets them go. */
let gate: Promise<void> = Promise.resolve();
beforeAll(async () => {
  const scripted = textProvider(async (req) => {
    const agent = /^You are (\S+)/.exec(req.system)?.[1] ?? "?";
    if (agent.startsWith("Rui")) throw new Error(`${agent} could not reach the model`);
    if (agent.startsWith("Gate")) await gate;
    if (agent.startsWith("Syn") && lastText(req).startsWith("Write the synthesis"))
      throw new Error(`${agent} synthesis failed`);
    return position(agent.toLowerCase());
  });
  const fake = fakeProvider();
  const debateCall = (req: ModelRequest) => /^(Round \d+ of|Write the synthesis)/.test(lastText(req));
  server = await startTestServer({
    modelProvider: { kind: "fake", stream: (req) => (debateCall(req) ? scripted : fake).stream(req) },
  });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@debates-access.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId } = await seedWorkspace(server, ana, "Debates");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const dora = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
  return { workspaceId, base: `${ws(workspaceId)}/debates`, ana, beto, dora };
}

describe("seating an agent at a debate", () => {
  test(
    "takes its editor or whoever talks to it: someone else's owner-only agent stays off the table",
    async () => {
      const { workspaceId, base, ana, beto, dora } = await team();
      const open = await seedAgent(server, workspaceId, ana, `open${n}`);
      const solo = await seedAgent(server, workspaceId, ana, `solo${n}`);
      await server.deps.db
        .update(schema.agents)
        .set({ visibilityMode: "owner" })
        .where(eq(schema.agents.id, solo.id));
      const debate = (who: Person, agentIds: string[]) =>
        call(who, "POST", base, { title: "Pick", goal: "g", agentIds, rounds: 0 });
      expect((await debate(beto, [solo.id])).status).toBe(403);
      const mine = await debate(beto, [open.id]);
      expect(mine.status).toBe(201);
      // Nor can he bring it in later as the debate's host.
      const added = await call(beto, "PUT", `${base}/${mine.body.id}/participants`, {
        agentsToAdd: [solo.id],
      });
      expect(added.status).toBe(403);
      // Its owner and whoever manages agents seat it.
      expect((await debate(ana, [solo.id])).status).toBe(201);
      expect((await debate(dora, [solo.id])).status).toBe(201);
      await server.deps.runtime.settle();
    },
    SERVER_TEST_MS,
  );
});

describe("a debate in a private channel", () => {
  test(
    "is read only by the channel's members: whoever took part and left loses it, its events and its turns",
    async () => {
      const { workspaceId, base, ana, beto } = await team();
      const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
      const lia = await seedAgent(server, workspaceId, ana, `gate${n}`);
      const board = await seedChannel(server, workspaceId, {
        name: `board${n}`,
        visibility: "private",
        members: [ana, beto],
      });
      // Calling someone who can't read the channel to the table is refused.
      const outsider = await call(ana, "POST", base, {
        title: "Outsider",
        goal: "g",
        agentIds: [lia.id],
        channelId: board,
        userIds: [caio.user.id],
      });
      expect(outsider.status).toBe(400);
      let release = () => {};
      gate = new Promise((r) => {
        release = r;
      });
      const opened = await call(ana, "POST", base, {
        title: "Sell?",
        goal: "Decide",
        agentIds: [lia.id],
        rounds: 1,
        channelId: board,
        speakers: [
          { type: "person", id: ana.user.id },
          { type: "person", id: beto.user.id },
          { type: "agent", id: lia.id },
        ],
      });
      expect(opened.status).toBe(201);
      const id = opened.body.id;
      expect((await call(beto, "POST", `${base}/${id}/posts`, { body: "No", answer: "no" })).status).toBe(
        201,
      );
      expect((await call(ana, "POST", `${base}/${id}/posts`, { body: "Yes", answer: "yes" })).status).toBe(
        201,
      );
      expect(
        (await call(ana, "PUT", `${base}/${id}/participants`, { peopleToAdd: [caio.user.id] })).status,
      ).toBe(400);
      // Beto leaves the channel while the round waits on the agent.
      await server.deps.db
        .delete(schema.channelMemberships)
        .where(
          and(
            eq(schema.channelMemberships.channelId, board),
            eq(schema.channelMemberships.memberId, beto.user.id),
          ),
        );
      const sent: { userId: string; type: string }[] = [];
      const toUser = server.deps.hub.toUser.bind(server.deps.hub);
      server.deps.hub.toUser = (workspace, userId, event, ...rest) => {
        sent.push({ userId, type: event.type });
        return toUser(workspace, userId, event, ...rest);
      };
      try {
        release();
        await waitFor(async () => (await call(ana, "GET", `${base}/${id}`)).body.round === 1);
        await call(ana, "POST", `${base}/${id}/posts`, { body: "A comment" });
        await server.deps.runtime.settle();
      } finally {
        server.deps.hub.toUser = toUser;
      }
      expect(sent.some((e) => e.userId === ana.user.id && e.type === "debate.turn_requested")).toBe(true);
      expect(sent.filter((e) => e.userId === beto.user.id)).toEqual([]);
      // The detail, the list, posting and commenting all answer as if the debate weren't there.
      expect((await call(beto, "GET", `${base}/${id}`)).status).toBe(404);
      expect((await call(beto, "GET", base)).body.debates.map((d: { id: string }) => d.id)).not.toContain(id);
      expect((await call(beto, "POST", `${base}/${id}/posts`, { body: "Still here?" })).status).toBe(404);
      expect((await call(ana, "GET", `${base}/${id}`)).status).toBe(200);
    },
    SERVER_TEST_MS,
  );
});

describe("a stall while the debate is anonymous", () => {
  test(
    "names the stalled turn by its pseudonym, never by the agent's id or name, until the reveal",
    async () => {
      const { workspaceId, base, ana, beto } = await team();
      const lia = await seedAgent(server, workspaceId, ana, `lia${n}`);
      const rui = await seedAgent(server, workspaceId, ana, `rui${n}`);
      const made = await call(ana, "POST", base, {
        title: "Stall",
        goal: "g",
        agentIds: [lia.id, rui.id],
        rounds: 1,
      });
      expect(made.status).toBe(201);
      const id = made.body.id;
      await waitFor(async () => (await call(beto, "GET", `${base}/${id}`)).body.status === "stalled");
      const [row] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, id));
      expect(row?.stallInfo?.agentId).toBe(rui.id);
      const pseudonym = row?.pseudonyms[rui.id];
      const seen = (await call(beto, "GET", `${base}/${id}`)).body;
      expect(seen.stallInfo).toMatchObject({ agentId: null, pseudonym, round: 0 });
      expect(seen.stallInfo.reason).toContain(`Participant ${pseudonym}`);
      expect(JSON.stringify(seen).includes(rui.name)).toBe(false);
      expect(JSON.stringify(seen.stallInfo).includes(rui.id)).toBe(false);
      // Revealed (closed), the stall names the agent.
      await server.deps.db
        .update(schema.debates)
        .set({ status: "canceled" })
        .where(eq(schema.debates.id, id));
      expect((await call(beto, "GET", `${base}/${id}`)).body.stallInfo).toMatchObject({
        agentId: rui.id,
        pseudonym,
      });
    },
    SERVER_TEST_MS,
  );
});

describe("a stall of the lead's own turn", () => {
  test(
    "names it by its pseudonym too: only the synthesis keeps the lead's id",
    async () => {
      const { workspaceId, base, ana, beto } = await team();
      // Rui first and no lead chosen: Rui leads, and also speaks in the rounds.
      const rui = await seedAgent(server, workspaceId, ana, `rui${n}`);
      const lia = await seedAgent(server, workspaceId, ana, `lia${n}`);
      const made = await call(ana, "POST", base, {
        title: "Lead",
        goal: "g",
        agentIds: [rui.id, lia.id],
        rounds: 1,
      });
      const id = made.body.id;
      await waitFor(async () => (await call(beto, "GET", `${base}/${id}`)).body.status === "stalled");
      const [row] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, id));
      const seen = (await call(beto, "GET", `${base}/${id}`)).body;
      expect(seen.anonymous).toBe(true);
      expect(seen.stallInfo).toMatchObject({ agentId: null, pseudonym: row?.pseudonyms[rui.id], round: 0 });
    },
    SERVER_TEST_MS,
  );

  test(
    "a stalled synthesis is marked as one and keeps the lead's id without its letter, until the reveal",
    async () => {
      const { workspaceId, base, ana, beto } = await team();
      const syn = await seedAgent(server, workspaceId, ana, `syn${n}`);
      const lia = await seedAgent(server, workspaceId, ana, `lia${n}`);
      const made = await call(ana, "POST", base, {
        title: "Synth",
        goal: "g",
        agentIds: [syn.id, lia.id],
        rounds: 0,
      });
      const id = made.body.id;
      await waitFor(async () => (await call(beto, "GET", `${base}/${id}`)).body.status === "stalled");
      const [row] = await server.deps.db.select().from(schema.debates).where(eq(schema.debates.id, id));
      expect(row?.stallInfo?.synthesis).toBe(true);
      const seen = (await call(beto, "GET", `${base}/${id}`)).body;
      expect(seen.stallInfo).toMatchObject({ agentId: syn.id, pseudonym: null });
      expect(JSON.stringify(seen.stallInfo).includes(`Participant ${row?.pseudonyms[syn.id]}`)).toBe(false);
      await call(ana, "POST", `${base}/${id}/cancel`);
      expect((await call(beto, "GET", `${base}/${id}`)).body.stallInfo).toMatchObject({
        agentId: syn.id,
        pseudonym: row?.pseudonyms[syn.id],
      });
    },
    SERVER_TEST_MS,
  );
});

describe("the estimate", () => {
  test("sends its amount only with view_usage, the number of calls to everyone", async () => {
    const { workspaceId, base, ana, beto } = await team();
    const lia = await seedAgent(server, workspaceId, ana, `est${n}`);
    const path = `${base}/estimate?agentIds=${lia.id}&rounds=1`;
    const member = (await call(beto, "GET", path)).body;
    const owner = (await call(ana, "GET", path)).body;
    expect(member).toEqual({ calls: owner.calls, upToUsd: null });
    expect(owner.calls).toBeGreaterThan(0);
    expect(owner.upToUsd).toBeGreaterThan(0);
  });
});
