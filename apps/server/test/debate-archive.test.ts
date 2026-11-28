// A debate turn that is at the model when its agent is archived: the turn isn't posted in the archived agent's name,
// and the agent leaves the round. Each debate call is scripted; everything else goes to the fake model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { fakeProvider } from "@vanr/engine/models/fake";
import type { ModelRequest } from "@vanr/engine/models/types";
import { eq } from "drizzle-orm";
import { archiveAgent } from "../src/control";
import { textProvider } from "../src/debate-benchmark";
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
beforeAll(async () => {
  const scripted = textProvider(async (req) => {
    const agent = /^You are (\S+)/.exec(req.system)?.[1] ?? "?";
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
