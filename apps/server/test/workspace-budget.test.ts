// The calls no agent pays (a search answer, a wiki check, a new agent's draft) go on the workspace's month budget:
// each one reserves before the model call and stops with 402 workspace.budget once the month's spend (every call
// of the workspace, agents' included) reaches it. The usage report shows what they cost to whoever has view_usage.
// The test server answers through the test model, which costs nothing; these calls take the paid path instead.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { fakeProvider } from "@vanr/engine/models/fake";
import { and, eq, isNull } from "drizzle-orm";
import { draftNewAgent } from "../src/agent-builder";
import type { AppDeps, WorkspaceMember } from "../src/context";
import { postMessage } from "../src/messages";
import { askSources } from "../src/search-ask";
import type { RunningServer } from "../src/server";
import { checkWorkspace } from "../src/wiki-checks";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";
import { wikiApi } from "./wiki-api";

let server: RunningServer;
/** The server's deps with a paid model: the calls go through the ledger as they do with a real key. */
let paid: AppDeps;
beforeAll(async () => {
  server = await startTestServer();
  paid = { ...server.deps, testModelFor: async () => () => false };
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@workspace-budget.test`;

async function team(defaultBudget: number) {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Budget");
  await server.deps.db
    .update(schema.workspaces)
    .set({ agentBudgetDefaultUsd: defaultBudget })
    .where(eq(schema.workspaces.id, workspaceId));
  const me: WorkspaceMember = { workspaceId, userId: ana.user.id, role: "owner", handle: "ana" };
  const channel = (
    await server.deps.db.select().from(schema.channels).where(eq(schema.channels.id, general))
  )[0];
  if (!channel) throw new Error("no general");
  await postMessage(server.deps, {
    workspaceId,
    channel,
    author: { type: "person", id: ana.user.id },
    body: "the onboarding checklist lives in the wiki",
    clientId: `seed${n}`,
  });
  return { ana, me, workspaceId };
}

const unowned = (workspaceId: string) =>
  server.deps.db
    .select()
    .from(schema.usageLines)
    .where(and(eq(schema.usageLines.workspaceId, workspaceId), isNull(schema.usageLines.agentId)));

const refused = { status: 402, code: "workspace.budget" };
/** What the fake model answers for a draft (it replies with the text in [[reply:...]]). */
const DRAFT = JSON.stringify({ name: "Sales", handle: "sales", instructions: "Help with sales.", why: "" });

describe("the workspace's month budget", () => {
  test(
    "a search answer and a new agent's draft are charged to it, and stop when it is spent",
    async () => {
      const { ana, me, workspaceId } = await team(20);
      const asked = await askSources(paid, me, "where is the onboarding checklist?");
      expect(asked.blocks.length).toBeGreaterThan(0);
      const draft = await draftNewAgent(paid, me, `A sales helper [[reply:${DRAFT}]]`);
      expect(draft.testModel).toBe(false);
      const lines = await unowned(workspaceId);
      expect(lines.map((l) => l.source).sort()).toEqual(["other", "search"]);
      expect(lines.every((l) => l.costMicros > 0)).toBe(true);

      // Spent: an agent's run this month already took the whole budget (one agent of $1).
      await server.deps.db
        .update(schema.workspaces)
        .set({ agentBudgetDefaultUsd: 1 })
        .where(eq(schema.workspaces.id, workspaceId));
      const lia = await seedAgent(server, workspaceId, ana, `lia${n}`);
      await server.deps.ledger.record(
        {
          workspaceId,
          agentId: lia.id,
          userId: me.userId,
          runId: null,
          source: "chat",
          model: "claude-opus-5-5",
          usage: { inputTokens: 300_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          at: server.deps.now(),
        },
        [],
      );
      await expect(askSources(paid, me, "where is the onboarding checklist?")).rejects.toMatchObject(refused);
      await expect(draftNewAgent(paid, me, "Another helper")).rejects.toMatchObject(refused);
      // Nothing went out: no new line, no open reservation.
      expect((await unowned(workspaceId)).length).toBe(2);
      const open = await server.deps.db
        .select()
        .from(schema.usageReservations)
        .where(
          and(
            eq(schema.usageReservations.workspaceId, workspaceId),
            eq(schema.usageReservations.status, "open"),
          ),
        );
      expect(open).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the platform's embeddings never spend it; a run from before the ledger does, once",
    async () => {
      const { ana, me, workspaceId } = await team(1);
      const emb = await seedAgent(server, workspaceId, ana, `emb${n}`);
      const embed = (source: "embedding" | "search") =>
        server.deps.ledger.record(
          {
            workspaceId,
            agentId: null,
            userId: null,
            runId: null,
            source,
            model: "voyage-4",
            usage: { inputTokens: 50_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
            at: server.deps.now(),
          },
          [],
        );
      // $3 of embeddings each way (the new source, and an old row written as search with nobody behind it).
      await embed("embedding");
      await embed("search");
      expect(
        (await askSources(paid, me, "where is the onboarding checklist?")).blocks.length,
      ).toBeGreaterThan(0);
      // A run whose cost is only on the run (no ledger row) counts: $1 fills the $1 budget. It is a turn of a debate
      // still anonymous, which the per-agent numbers leave out and the month's total doesn't.
      const debateId = `deb_open${n}`;
      await server.deps.db.insert(schema.debates).values({
        id: debateId,
        workspaceId,
        title: "Open",
        goal: "g",
        createdBy: { type: "person", id: me.userId },
      });
      await server.deps.db.insert(schema.runs).values({
        debateId,
        id: `run_legacy${n}`,
        workspaceId,
        agentId: emb.id,
        status: "done",
        model: "claude-haiku-5-5",
        costUsd: 1,
        createdAt: server.deps.now(),
      });
      await expect(askSources(paid, me, "where is the onboarding checklist?")).rejects.toMatchObject(refused);
      // The overview reads the very same spend: the budget is used up.
      expect(
        (await call(ana, "GET", `${ws(workspaceId)}/overview`)).body.budgetSpentPct,
      ).toBeGreaterThanOrEqual(100);
    },
    SERVER_TEST_MS,
  );

  test(
    "the overview counts an anonymous debate's run, and a run with its ledger rows once",
    async () => {
      const { ana, me, workspaceId } = await team(1);
      const agent = await seedAgent(server, workspaceId, ana, `ov${n}`);
      const scope = { kind: "workspace" as const, id: workspaceId, limitUsd: 1, period: "month" as const };
      const debateId = `deb_anon${n}`;
      await server.deps.db
        .insert(schema.debates)
        .values({
          id: debateId,
          workspaceId,
          title: "A",
          goal: "g",
          createdBy: { type: "person", id: me.userId },
        });
      await server.deps.db.insert(schema.runs).values({
        debateId,
        id: `run_anon${n}`,
        workspaceId,
        agentId: agent.id,
        status: "done",
        model: "claude-haiku-5-5",
        costUsd: 0.5,
        createdAt: server.deps.now(),
      });
      const pct = async () => (await call(ana, "GET", `${ws(workspaceId)}/overview`)).body.budgetSpentPct;
      expect(await pct()).toBeCloseTo(50, 0);
      // A run settled through the ledger: its rows count, its own cost doesn't count again.
      const runId = `run_led${n}`;
      await server.deps.db.insert(schema.runs).values({
        id: runId,
        workspaceId,
        agentId: agent.id,
        status: "done",
        model: "claude-haiku-5-5",
        costUsd: 0,
        createdAt: server.deps.now(),
      });
      const { costUsd } = await server.deps.ledger.record(
        {
          workspaceId,
          agentId: agent.id,
          userId: null,
          runId,
          source: "chat",
          model: "claude-haiku-5-5",
          usage: { inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          at: server.deps.now(),
        },
        [],
      );
      await server.deps.db.update(schema.runs).set({ costUsd }).where(eq(schema.runs.id, runId));
      expect(costUsd).toBeGreaterThan(0);
      expect(await server.deps.ledger.spent(scope, server.deps.now())).toBeCloseTo(0.5 + costUsd, 6);
    },
    SERVER_TEST_MS,
  );

  test(
    "embeddings show in the usage report, outside the month's spend",
    async () => {
      const { ana, workspaceId } = await team(1);
      await server.deps.ledger.record(
        {
          workspaceId,
          agentId: null,
          userId: null,
          runId: null,
          source: "embedding",
          model: "voyage-4",
          usage: { inputTokens: 10_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          at: server.deps.now(),
        },
        [],
      );
      const report = (await call(ana, "GET", `${ws(workspaceId)}/usage/report`)).body;
      expect(report.perKind.map((k: { kind: string }) => k.kind)).toContain("embedding");
      expect(report.spendUsd).toBeGreaterThan(0);
      expect((await call(ana, "GET", `${ws(workspaceId)}/overview`)).body.budgetSpentPct).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "a wiki check asks pair by pair on it, and stops asking once it is spent",
    async () => {
      const { ana, workspaceId } = await team(20);
      const wiki = wikiApi(ana.browser);
      await wiki.createWikiPage(workspaceId, {
        title: "One",
        body: "The deadline is Friday. [[Two]] [[Three]]",
      });
      await wiki.createWikiPage(workspaceId, { title: "Two", body: "The deadline is Thursday." });
      await wiki.createWikiPage(workspaceId, { title: "Three", body: "The deadline is Monday." });
      const provider = fakeProvider();
      const check = () => checkWorkspace(paid, workspaceId, { gapMs: 0, model: async () => provider });
      expect(await check()).toBe("ran");
      expect((await unowned(workspaceId)).filter((l) => l.source === "wiki")).toHaveLength(2);
      // A page changed: its pairs are asked again, but the month is spent (no agent, a $0 default budget).
      await server.deps.db
        .update(schema.workspaces)
        .set({ agentBudgetDefaultUsd: 0 })
        .where(eq(schema.workspaces.id, workspaceId));
      await wiki.replaceWikiPage(workspaceId, "two", { body: "The deadline is Tuesday.", parentVersion: 1 });
      expect(await check()).toBe("out_of_budget");
      expect((await unowned(workspaceId)).filter((l) => l.source === "wiki")).toHaveLength(2);
    },
    SERVER_TEST_MS,
  );

  test(
    "the usage report shows what they cost to whoever has view_usage",
    async () => {
      const { ana, me, workspaceId } = await team(20);
      await askSources(paid, me, "where is the onboarding checklist?");
      const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
      const report = await call(ana, "GET", `${ws(workspaceId)}/usage/report`);
      expect(report.status).toBe(200);
      const search = report.body.perKind.find((k: { kind: string }) => k.kind === "search");
      expect(search.calls).toBe(1);
      expect(search.costUsd).toBeGreaterThan(0);
      expect(report.body.spendUsd).toBeCloseTo(search.costUsd, 9);
      expect(
        (await call(ana, "GET", `${ws(workspaceId)}/overview`)).body.budgetSpentPct,
      ).toBeGreaterThanOrEqual(0);
      expect((await call(beto, "GET", `${ws(workspaceId)}/usage/report`)).status).toBe(403);
      expect((await call(beto, "GET", `${ws(workspaceId)}/overview`)).body.budgetSpentPct).toBeNull();
    },
    SERVER_TEST_MS,
  );
});
