// Archiving closes the agent everywhere, not only over HTTP: its live runs stop, what they wait on closes, a decision
// that would run its action is refused, and its tools refuse even when the archive lands mid-call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { createMemory } from "../src/agent-memory";
import { createAssignment, startAssignmentJob } from "../src/assignments/engine";
import { DECISION_TTL_MS, trailEntry } from "../src/control";
import { postMessage } from "../src/messages";
import { environmentToolsFor } from "../src/runners/agent-tools";
import type { RunningServer } from "../src/server";
import { pairFake } from "./fake-runner";
import type { ProtocolRunner } from "./protocol-runner";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, seedWorkspace } from "./seed";
import { channelRow, racing, seedAgent, toolRun } from "./tool-run";

const {
  agents,
  assignments,
  agentEnvironments,
  approvals,
  approvalRules,
  memories,
  messages,
  proposals,
  questions,
  reminders,
  runs,
} = schema;

let server: RunningServer;
const open: ProtocolRunner[] = [];
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(async () => {
  for (const r of open) await r.close();
  await server.stop();
}, SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@agent-archive.test`;

/** Ana owns the workspace and manages agents; Beto owns Lia (and Max, who stays active). */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana);
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, beto, { name: "Lia", channels: [general] });
  const max = await seedAgent(server, workspaceId, beto, { name: "Max", channels: [general] });
  const archive = () =>
    server.deps.db.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, lia.id));
  return { ana, beto, lia, max, workspaceId, general, w: ws(workspaceId), archive };
}
type Team = Awaited<ReturnType<typeof team>>;

async function pendingApproval(t: Team, agentId = t.lia.id) {
  const [row] = await server.deps.db
    .insert(approvals)
    .values({
      id: newId("apv"),
      workspaceId: t.workspaceId,
      agentId,
      channelId: t.general,
      runId: newId("run"),
      tool: "send_email",
      scope: "mail",
      title: "Send the report",
      detail: "The report body",
      payloadHash: "hash-1",
      effect: "K2",
      ruleKey: "mail:ana@acme.test",
      ruleLabel: "to ana@acme.test",
      editable: ["body"],
      input: { body: "The report body" },
      requesterUserId: t.beto.user.id,
      expiresAt: new Date(Date.now() + DECISION_TTL_MS),
      trail: [trailEntry(new Date(), "requested", "Lia asked")],
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

async function openQuestion(t: Team, agentId = t.lia.id) {
  const [row] = await server.deps.db
    .insert(questions)
    .values({
      id: newId("q"),
      workspaceId: t.workspaceId,
      agentId,
      channelId: t.general,
      runId: newId("run"),
      askedUserId: t.beto.user.id,
      text: "Which format?",
      choices: ["PDF", "CSV"],
    })
    .returning();
  if (!row) throw new Error("no question");
  return row;
}

const statusOf = async (table: typeof approvals | typeof questions, id: string) =>
  (await server.deps.db.select({ status: table.status }).from(table).where(eq(table.id, id)))[0]?.status;

/** The runtime pretends a run of the agent waits on every approval, and records what it is told. */
function waitingRuntime(liveAgentId: string) {
  const rt = server.deps.runtime;
  const saved = {
    awaitsApproval: rt.awaitsApproval,
    resolveApproval: rt.resolveApproval,
    activeRuns: rt.activeRuns,
    cancel: rt.cancel,
    reviseApproval: rt.reviseApproval,
  };
  const resolved: string[] = [];
  const canceled: string[] = [];
  rt.awaitsApproval = () => true;
  rt.resolveApproval = (id) => {
    resolved.push(id);
    return true;
  };
  rt.activeRuns = (filter) => [
    ...saved.activeRuns.call(rt, filter),
    {
      runId: "run_live",
      status: "running",
      agentId: liveAgentId,
      channelId: "ch",
      threadId: null,
      startedAt: new Date().toISOString(),
      lastPingAt: new Date().toISOString(),
      sourceMessageId: "msg",
      initiatedBy: null,
      browser: false,
    },
  ];
  rt.cancel = (runId) => {
    canceled.push(runId);
    return true;
  };
  const restore = () => Object.assign(rt, saved);
  return { resolved, canceled, restore };
}

describe("archiving", () => {
  test(
    "stops the agent's live runs and closes its pending approvals and open questions, and only its own",
    async () => {
      const t = await team();
      const approval = await pendingApproval(t);
      const question = await openQuestion(t);
      const othersApproval = await pendingApproval(t, t.max.id);
      const othersQuestion = await openQuestion(t, t.max.id);
      const rt = waitingRuntime(t.lia.id);
      try {
        expect((await call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`)).status).toBe(204);
        expect(rt.canceled).toEqual(["run_live"]);
      } finally {
        rt.restore();
      }
      expect(await statusOf(approvals, approval.id)).toBe("canceled");
      expect(await statusOf(questions, question.id)).toBe("expired");
      expect(await statusOf(approvals, othersApproval.id)).toBe("pending");
      expect(await statusOf(questions, othersQuestion.id)).toBe("open");

      // What the archive closed can't be decided or answered after it.
      const approve = await call(t.beto, "POST", `${t.w}/approvals/${approval.id}/approve`, {
        payloadHash: "hash-1",
        remember: true,
      });
      expect(approve.status).toBe(409);
      const answer = await call(t.beto, "POST", `${t.w}/questions/${question.id}/answer`, { choice: "PDF" });
      expect([answer.status, answer.body?.error?.code]).toEqual([409, "question.closed"]);
      const rules = await server.deps.db
        .select()
        .from(approvalRules)
        .where(eq(approvalRules.agentId, t.lia.id));
      expect(rules).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "stops a real live run, and the agent starts no run after it",
    async () => {
      const t = await team();
      const channel = await channelRow(server, t.general);
      const trigger = async (body: string) => {
        const { message } = await postMessage(server.deps, {
          workspaceId: t.workspaceId,
          channel,
          author: { type: "person", id: t.beto.user.id },
          body,
          clientId: newId("c"),
        });
        const [row] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
        if (!row) throw new Error("no trigger");
        return row;
      };
      const started = await server.deps.runtime.runFor({
        agent: t.lia,
        channel,
        trigger: await trigger("[[slow:5000]] the report"),
      });
      if (!started.ok) throw new Error(started.code);
      expect((await call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`)).status).toBe(204);
      await started.done;
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
      expect(run?.status).toBe("canceled");
      // An assignment's turn or a routine that read the agent before the archive starts nothing.
      const late = await server.deps.runtime.runFor({
        agent: t.lia,
        channel,
        trigger: await trigger("again"),
      });
      expect(late).toEqual({ ok: false, code: "archived" });
    },
    SERVER_TEST_MS,
  );

  test(
    "approving a pending approval of an archived agent refuses with 409 and runs nothing, with or without remember",
    async () => {
      const t = await team();
      const remembered = await pendingApproval(t);
      const plain = await pendingApproval(t);
      // Archived another way than the route (an agent archived before archiving closed its approvals).
      await t.archive();
      const rt = waitingRuntime(t.lia.id);
      try {
        for (const [row, remember] of [
          [remembered, true],
          [plain, false],
        ] as const) {
          const res = await call(t.beto, "POST", `${t.w}/approvals/${row.id}/approve`, {
            payloadHash: "hash-1",
            remember,
          });
          expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);
          expect(await statusOf(approvals, row.id)).toBe("pending");
        }
        // Edit and approve too: the run validates the edit, then the decision is refused under the agent's lock.
        const edited = await pendingApproval(t);
        server.deps.runtime.reviseApproval = async () => ({
          input: { body: "Edited" },
          payloadHash: "hash-2",
          preview: { title: "Send the report", body: "Edited" },
          effect: "K2",
          rule: null,
        });
        const res = await call(t.beto, "POST", `${t.w}/approvals/${edited.id}/edit`, {
          input: { body: "Edited" },
          payloadHash: "hash-1",
        });
        expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);
        expect(await statusOf(approvals, edited.id)).toBe("pending");
        expect(rt.resolved).toEqual([]);
      } finally {
        rt.restore();
      }
      const rules = await server.deps.db
        .select()
        .from(approvalRules)
        .where(eq(approvalRules.agentId, t.lia.id));
      expect(rules).toEqual([]);
      // Rejecting only ends the wait: it stays open.
      const reject = await call(t.beto, "POST", `${t.w}/approvals/${plain.id}/reject`, {});
      expect(reject.status).toBe(409);
      expect(reject.body?.error?.code).toBe("approval.gone");
    },
    SERVER_TEST_MS,
  );

  test(
    "rejecting a proposal of an archived agent refuses and writes no lesson in its store",
    async () => {
      const t = await team();
      const [p] = await server.deps.db
        .insert(proposals)
        .values({
          id: newId("prp"),
          workspaceId: t.workspaceId,
          agentId: t.lia.id,
          targetKind: "agent_prompt",
          recipientAgentId: t.lia.id,
          title: "Answer in bullet points",
          before: "",
          after: "Use bullet points.",
          why: "People asked",
          channelId: t.general,
        })
        .returning();
      if (!p) throw new Error("no proposal");
      await t.archive();
      const res = await call(t.beto, "POST", `${t.w}/proposals/${p.id}/reject`, {});
      expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);
      const written = await server.deps.db.select().from(memories).where(eq(memories.agentId, t.lia.id));
      expect(written).toEqual([]);
      const [still] = await server.deps.db.select().from(proposals).where(eq(proposals.id, p.id));
      expect(still?.status).toBe("pending");
    },
    SERVER_TEST_MS,
  );
});

describe("what reaches an archived agent another way", () => {
  test(
    "undoing what it wrote is refused, and its memory stays as it was",
    async () => {
      const t = await team();
      const run = await toolRun(server, { workspaceId: t.workspaceId, agent: t.lia, channelId: t.general });
      expect((await run.call("remember", { text: "The report goes out on Fridays." })).isError).toBe(false);
      const action = await run.action("memory_recorded");
      await t.archive();
      const res = await call(t.ana, "POST", `${t.w}/actions/${action}/undo`);
      expect([res.status, res.body?.error?.code]).toEqual([409, "agent.archived"]);
      const [kept] = await server.deps.db.select().from(memories).where(eq(memories.agentId, t.lia.id));
      expect(kept?.archived).toBe(false);
    },
    SERVER_TEST_MS,
  );

  test(
    "an archived agent's assignment starts no job, and nobody gives it a new one",
    async () => {
      const t = await team();
      const fake = await pairFake(server, t.ana, t.workspaceId, { open });
      const row = await createAssignment(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        agentHandle: t.lia.handle,
        channelId: t.general,
        ownerId: t.ana.user.id,
        title: "Fix the flaky test",
        goal: "The suite passes ten times in a row",
        executor: "claude_code",
        runnerId: fake.runnerId,
        commandPolicy: "never",
      });
      const [active] = await server.deps.db
        .update(assignments)
        .set({ status: "active", startedAt: server.deps.now() })
        .where(eq(assignments.id, row.id))
        .returning();
      if (!active) throw new Error("assignment not activated");
      await t.archive();
      await expect(startAssignmentJob(server.deps, active, { extra: "" })).rejects.toMatchObject({
        code: "agent.archived",
      });
      const res = await call(t.ana, "POST", `${t.w}/assignments`, {
        agentId: t.lia.id,
        goal: "Another one",
        channelId: t.general,
      });
      expect(res.status).toBe(404);
    },
    SERVER_TEST_MS,
  );
});

describe("an archived agent's tools", () => {
  test(
    "a call that reaches the run is refused, whatever it writes",
    async () => {
      const t = await team();
      const run = await toolRun(server, { workspaceId: t.workspaceId, agent: t.lia, channelId: t.general });
      await t.archive();
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const out = await run.call("schedule_reminder", { text: "Ping the team", at });
      expect([out.isError, out.content]).toEqual([true, "Not done: this agent was archived."]);
      const rows = await server.deps.db.select().from(reminders).where(eq(reminders.agentId, t.lia.id));
      expect(rows).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "an archive that lands while remember runs refuses the memory write under the agent's lock",
    async () => {
      const t = await team();
      const run = await toolRun(server, { workspaceId: t.workspaceId, agent: t.lia, channelId: t.general });
      const out = await run.call(
        "remember",
        { text: "Archived but still learning." },
        { deps: racing(server, t.archive) },
      );
      expect([out.isError, out.content]).toEqual([true, "Not done: this agent was archived."]);
      const written = await server.deps.db.select().from(memories).where(eq(memories.agentId, t.lia.id));
      expect(written).toEqual([]);
      // The store refuses every writer, not only the tool: the person's lesson and an undo go through here too.
      await expect(
        createMemory(
          server.deps.db,
          new Date(),
          {
            workspaceId: t.workspaceId,
            agentId: t.lia.id,
            scope: "agent",
            text: "A lesson",
            kind: "lesson",
            source: "proposal",
            origin: { by: null, name: null, channel: null, at: new Date().toISOString() },
          },
          { author: { type: "system" } },
        ),
      ).rejects.toMatchObject({ code: "agent.archived" });
    },
    SERVER_TEST_MS,
  );

  test(
    "an archive that lands while environment_start runs leaves the environment stopped",
    async () => {
      const t = await team();
      const fake = await pairFake(server, t.ana, t.workspaceId, { open });
      await server.deps.db
        .update(agents)
        .set({ environmentId: fake.runnerId })
        .where(eq(agents.id, t.lia.id));
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
      if (!agent) throw new Error("agent gone");
      const tools = await environmentToolsFor({ deps: server.deps, agent });
      const run = await toolRun(server, { workspaceId: t.workspaceId, agent, channelId: t.general, tools });
      expect((await run.call("environment_stop", {})).content).toBe("Your runner is stopped.");
      const out = await run.call("environment_start", {}, { deps: racing(server, t.archive) });
      expect([out.isError, out.content]).toEqual([true, "Not done: this agent was archived."]);
      const [env] = await server.deps.db
        .select({ status: agentEnvironments.status })
        .from(agentEnvironments)
        .where(eq(agentEnvironments.agentId, t.lia.id));
      expect(env?.status).toBe("stopped");
      // Once archived every tool refuses, stopping too: a person stops it over HTTP, which stays open.
      expect((await run.call("environment_stop", {})).isError).toBe(true);
    },
    SERVER_TEST_MS,
  );
});
