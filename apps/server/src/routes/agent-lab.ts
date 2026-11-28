// The agent lab: test cases and the before/after evaluation, "describe it and I build it", memory consolidation
// and the skill draft from a run.
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { DESCRIPTION_MAX, draftNewAgent, proposeFromDescription } from "../agent-builder";
import { startEval, TEST_CASES_MAX, toEval, toTestCase } from "../agent-lab";
import { agentInWorkspace, requireActiveAgent, requireAgentEditor, seesSpend } from "../agents";
import type { AppEnv } from "../context";
import { conflict, forbidden, notFound, param, readJson, readQuery } from "../http";
import {
  applyConsolidation,
  consolidationsOf,
  discardConsolidation,
  startConsolidation,
  toConsolidation,
} from "../memory-consolidation";
import { draftSkillFromRun } from "../skill-drafts";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { agentTestCases, agentEvals, proposals } = schema;

const snippets = z.array(z.string().trim().min(1).max(200)).max(10);
const caseInput = z
  .object({
    input: z.string().trim().min(1).max(4000),
    mustInclude: snippets.optional(),
    mustNotInclude: snippets.optional(),
  })
  .strict();
const description = z.object({ description: z.string().trim().min(1).max(DESCRIPTION_MAX) }).strict();

export function registerAgentLab(app: Hono<AppEnv>) {
  /** The agent, if the person edits it (whoever manages agents or its owner). */
  const editable = async (c: Context<AppEnv>) => {
    const me = requireMember(c);
    const agent = await agentInWorkspace(c.get("deps").db, me.workspaceId, param(c, "agentId"));
    requireAgentEditor(me, agent);
    requireActiveAgent(agent);
    return { me, agent };
  };

  // ---- test cases ----

  app.get(`${WORKSPACE}/agents/:agentId/test-cases`, async (c) => {
    const { agent } = await editable(c);
    const rows = await c
      .get("deps")
      .db.select()
      .from(agentTestCases)
      .where(eq(agentTestCases.agentId, agent.id))
      .orderBy(asc(agentTestCases.createdAt), asc(agentTestCases.id));
    return c.json({ cases: rows.map(toTestCase) });
  });

  app.post(`${WORKSPACE}/agents/:agentId/test-cases`, async (c) => {
    const { me, agent } = await editable(c);
    const { db, now } = c.get("deps");
    const input = await readJson(c, caseInput);
    const row = await db.transaction(async (tx) => {
      // Two requests at once don't pass the cap together.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-test-cases:${agent.id}`}))`);
      const [n] = await tx
        .select({ n: count() })
        .from(agentTestCases)
        .where(eq(agentTestCases.agentId, agent.id));
      if ((n?.n ?? 0) >= TEST_CASES_MAX)
        throw conflict("agent_test_case.full", `An agent holds up to ${TEST_CASES_MAX} test cases`, {
          limit: TEST_CASES_MAX,
        });
      const [created] = await tx
        .insert(agentTestCases)
        .values({
          id: newId("tcs"),
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          input: input.input,
          mustInclude: input.mustInclude ?? [],
          mustNotInclude: input.mustNotInclude ?? [],
          createdBy: me.userId,
          createdAt: now(),
          updatedAt: now(),
        })
        .returning();
      return created;
    });
    if (!row) throw new Error("test case insert returned nothing");
    return c.json(toTestCase(row), 201);
  });

  app.patch(`${WORKSPACE}/agents/:agentId/test-cases/:testCaseId`, async (c) => {
    const { agent } = await editable(c);
    const { db, now } = c.get("deps");
    const input = await readJson(c, caseInput);
    const [row] = await db
      .update(agentTestCases)
      .set({
        input: input.input,
        mustInclude: input.mustInclude ?? [],
        mustNotInclude: input.mustNotInclude ?? [],
        updatedAt: now(),
      })
      .where(and(eq(agentTestCases.id, param(c, "testCaseId")), eq(agentTestCases.agentId, agent.id)))
      .returning();
    if (!row) throw notFound("Test case not found");
    return c.json(toTestCase(row));
  });

  app.delete(`${WORKSPACE}/agents/:agentId/test-cases/:testCaseId`, async (c) => {
    const { agent } = await editable(c);
    const [row] = await c
      .get("deps")
      .db.delete(agentTestCases)
      .where(and(eq(agentTestCases.id, param(c, "testCaseId")), eq(agentTestCases.agentId, agent.id)))
      .returning({ id: agentTestCases.id });
    if (!row) throw notFound("Test case not found");
    return c.body(null, 204);
  });

  // ---- the before/after run ----

  app.post(`${WORKSPACE}/agents/:agentId/evals`, async (c) => {
    const { me, agent } = await editable(c);
    const deps = c.get("deps");
    const input = await readJson(
      c,
      z.union([
        z.object({ proposalId: z.string().min(1).max(64) }).strict(),
        z.object({ instructions: z.string().max(20_000) }).strict(),
      ]),
    );
    let after: string;
    let proposalId: string | null = null;
    if ("proposalId" in input) {
      const [p] = await deps.db
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.id, input.proposalId),
            eq(proposals.workspaceId, me.workspaceId),
            eq(proposals.targetKind, "agent_prompt"),
            eq(proposals.recipientAgentId, agent.id),
          ),
        );
      if (!p) throw notFound("Proposal not found");
      if (p.status !== "pending") throw conflict("agent_eval.decided", "This proposal was already decided");
      after = p.after;
      proposalId = p.id;
    } else {
      // The editor's text: only whoever may change instructions (the owner without the role only sees).
      if (!can(me.role, "manage_agents")) throw forbidden();
      after = input.instructions;
    }
    const row = await startEval(deps, { agent, userId: me.userId, after, proposalId });
    return c.json(toEval(row, seesSpend(me)), 201);
  });

  app.get(`${WORKSPACE}/agents/:agentId/evals`, async (c) => {
    const { me, agent } = await editable(c);
    const q = readQuery(c, z.object({ proposalId: z.string().min(1).max(64).optional() }));
    const rows = await c
      .get("deps")
      .db.select()
      .from(agentEvals)
      .where(
        and(
          eq(agentEvals.agentId, agent.id),
          q.proposalId ? eq(agentEvals.proposalId, q.proposalId) : undefined,
        ),
      )
      .orderBy(desc(agentEvals.createdAt), desc(agentEvals.id))
      .limit(20);
    return c.json({ evals: rows.map((r) => toEval(r, seesSpend(me))) });
  });

  app.get(`${WORKSPACE}/agents/:agentId/evals/:evalId`, async (c) => {
    const { me, agent } = await editable(c);
    const [row] = await c
      .get("deps")
      .db.select()
      .from(agentEvals)
      .where(and(eq(agentEvals.id, param(c, "evalId")), eq(agentEvals.agentId, agent.id)));
    if (!row) throw notFound("Test run not found");
    return c.json(toEval(row, seesSpend(me)));
  });

  // ---- "describe it and I build it" ----

  app.post(`${WORKSPACE}/agent-drafts`, async (c) => {
    const me = requirePermission(c, "manage_agents");
    const input = await readJson(c, description);
    return c.json(await draftNewAgent(c.get("deps"), me, input.description));
  });

  app.post(`${WORKSPACE}/agents/:agentId/builder`, async (c) => {
    // Only whoever changes instructions: the owner without the role would accept their own proposal.
    const me = requirePermission(c, "manage_agents");
    const agent = await agentInWorkspace(c.get("deps").db, me.workspaceId, param(c, "agentId"));
    requireActiveAgent(agent);
    const input = await readJson(c, description);
    return c.json(await proposeFromDescription(c.get("deps"), me, agent, input.description));
  });

  // ---- memory consolidation ----

  app.get(`${WORKSPACE}/agents/:agentId/memory-consolidations`, async (c) => {
    const { agent } = await editable(c);
    const rows = await consolidationsOf(c.get("deps").db, agent);
    return c.json({ consolidations: rows.map(toConsolidation) });
  });

  app.post(`${WORKSPACE}/agents/:agentId/memory-consolidations`, async (c) => {
    const { me, agent } = await editable(c);
    return c.json(toConsolidation(await startConsolidation(c.get("deps"), me, agent)), 201);
  });

  app.post(`${WORKSPACE}/agents/:agentId/memory-consolidations/:memoryConsolidationId/apply`, async (c) => {
    const { me, agent } = await editable(c);
    return c.json(
      toConsolidation(await applyConsolidation(c.get("deps"), me, agent, param(c, "memoryConsolidationId"))),
    );
  });

  app.post(`${WORKSPACE}/agents/:agentId/memory-consolidations/:memoryConsolidationId/discard`, async (c) => {
    const { me, agent } = await editable(c);
    return c.json(
      toConsolidation(
        await discardConsolidation(c.get("deps"), me, agent, param(c, "memoryConsolidationId")),
      ),
    );
  });

  // ---- a skill from a run ----

  app.post(`${WORKSPACE}/runs/:runId/skill-draft`, async (c) => {
    // A draft is for saving: whoever doesn't create skills doesn't ask for one.
    const me = requirePermission(c, "manage_agents");
    return c.json(await draftSkillFromRun(c.get("deps"), me, param(c, "runId")));
  });
}
