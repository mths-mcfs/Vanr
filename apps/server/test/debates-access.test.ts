// Who seats which agent at a debate, what a stalled turn tells while the debate is anonymous, and the estimate's
// amount, on the real server (PGlite). Rui's model call fails with a message that names him.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { eq } from "drizzle-orm";
import { textProvider } from "../src/debate-benchmark";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedWorkspace } from "./seed";

const lastText = (req: ModelRequest) =>
  req.messages
    .at(-1)
    ?.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("") ?? "";
const position = (answer: string) =>
  `I argue for ${answer}.\n${JSON.stringify({ answer, confidence: 0.6, reason: "", evidence: [] })}`;

let server: RunningServer;
beforeAll(async () => {
  const scripted = textProvider(async (req) => {
    const agent = /^You are (\S+)/.exec(req.system)?.[1] ?? "?";
    if (agent.startsWith("Rui")) throw new Error(`${agent} could not reach the model`);
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
