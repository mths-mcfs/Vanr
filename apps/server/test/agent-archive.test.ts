// Archiving closes the agent everywhere, not only over HTTP: its live runs stop, what they wait on closes, a decision
// that would run its action is refused, and its tools refuse even when the archive lands mid-call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq, gt } from "drizzle-orm";
import { createMemory } from "../src/agent-memory";
import { createAssignment, startAssignmentJob } from "../src/assignments/engine";
import { assignmentToolsFor } from "../src/assignments/tools";
import { archiveAgent, DECISION_TTL_MS, trailEntry } from "../src/control";
import { applyConsolidation } from "../src/memory-consolidation";
import { postMessage } from "../src/messages";
import { registerFire, startRoutineRun } from "../src/routines";
import { environmentToolsFor } from "../src/runners/agent-tools";
import type { RunningServer } from "../src/server";
import { pairFake, requests } from "./fake-runner";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import type { ProtocolRunner } from "./protocol-runner";
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

/** What the agent did after `at`: the runs it started, how they ended, and what it said. */
async function afterArchive(agentId: string, at: Date) {
  const { db } = server.deps;
  const late = await db
    .select({ status: runs.status })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), gt(runs.createdAt, at)));
  const said = await db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.authorId, agentId), gt(messages.createdAt, at)));
  return { late: late.map((r) => r.status), said: said.map((m) => m.body) };
}

const archivedAtOf = async (id: string) => {
  const [row] = await server.deps.db.select({ at: agents.archivedAt }).from(agents).where(eq(agents.id, id));
  if (!row?.at) throw new Error("not archived");
  return row.at;
};

async function settleAgent(workspaceId: string, agentId: string) {
  for (let i = 0; i < 100; i++) {
    if (!server.deps.runtime.activeRuns({ workspaceId }).some((r) => r.agentId === agentId)) return;
    await Bun.sleep(50);
  }
}

describe("a run cut short", () => {
  /** Lia mid-reply: a long answer streams a word at a time. */
  async function midStream(t: Team, limits?: { timeoutMs: number }) {
    const channel = await channelRow(server, t.general);
    const { message } = await postMessage(server.deps, {
      workspaceId: t.workspaceId,
      channel,
      author: { type: "person", id: t.beto.user.id },
      body: "[[slow:150]] tell me a long story about bread and butter and jam and toast and tea",
      clientId: newId("c"),
    });
    const [trigger] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
    if (!trigger) throw new Error("no trigger");
    const started = await server.deps.runtime.runFor({
      agent: t.lia,
      channel,
      trigger,
      ...(limits ? { limits: { scopes: [], maxTurns: 10, ...limits } } : {}),
    });
    if (!started.ok) throw new Error(started.code);
    return started;
  }
  const said = (runId: string) =>
    server.deps.db
      .select({ body: messages.body, meta: messages.meta })
      .from(messages)
      .where(eq(messages.runId, runId));

  test(
    "a person's Stop still posts what the agent had written, marked canceled",
    async () => {
      const t = await team();
      const started = await midStream(t);
      await Bun.sleep(700);
      expect((await call(t.beto, "POST", `${t.w}/runs/${started.runId}/cancel`)).status).toBe(204);
      await started.done;
      const out = await said(started.runId);
      expect(out.length).toBe(1);
      expect((out[0]?.meta as { canceled?: boolean } | undefined)?.canceled).toBe(true);
      expect(out[0]?.body.length).toBeGreaterThan(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "a failed read of the archive while it stops doesn't keep the run from ending",
    async () => {
      const t = await team();
      const started = await midStream(t);
      await Bun.sleep(400);
      const rt = server.runtime as unknown as { agentActive: (id: string) => Promise<boolean> };
      const real = rt.agentActive;
      rt.agentActive = async () => {
        throw new Error("database gone for a moment");
      };
      try {
        expect((await call(t.beto, "POST", `${t.w}/runs/${started.runId}/cancel`)).status).toBe(204);
        await started.done;
      } finally {
        rt.agentActive = real;
      }
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
      expect(run?.status).toBe("canceled");
      expect(server.deps.runtime.liveRun(started.runId)).toBe(null);
    },
    SERVER_TEST_MS,
  );

  test(
    "a time cap that runs out after the agent was archived says nothing, not even that time ran out",
    async () => {
      const t = await team();
      const started = await midStream(t, { timeoutMs: 600 });
      // Archived without the route's cancel: the time cap ends the run, and finds the agent archived.
      await Bun.sleep(200);
      await t.archive();
      await started.done;
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
      expect(run?.status).toBe("canceled");
      expect(await said(started.runId)).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("a run that starts after the archive", () => {
  const say = async (t: Team, body: string) => {
    const channel = await channelRow(server, t.general);
    const { message } = await postMessage(server.deps, {
      workspaceId: t.workspaceId,
      channel,
      author: { type: "person", id: t.beto.user.id },
      body,
      clientId: newId("c"),
    });
    const [row] = await server.deps.db.select().from(messages).where(eq(messages.id, message.id));
    if (!row) throw new Error("no message");
    return { channel, message, row };
  };

  test(
    "the message waiting for the next run ends canceled with it, and the agent says nothing",
    async () => {
      const t = await team();
      const first = await say(t, "[[slow:400]] the report is long and keeps going for a while longer");
      const started = await server.deps.runtime.runFor({
        agent: t.lia,
        channel: first.channel,
        trigger: first.row,
      });
      if (!started.ok) throw new Error(started.code);
      // Long enough for a few words of the reply to stream in.
      await Bun.sleep(1000);
      // A message that came while the run was closing waits for the next run (`live.after`). It asks for an
      // issue's work ("Ask an agent"), so the issue shows as working until that message is settled.
      const second = await say(t, "and the summary too");
      const issue = await call(t.beto, "POST", `${t.w}/issues`, { title: "Quarterly report" });
      expect(issue.status).toBe(201);
      await server.deps.db
        .update(messages)
        .set({ meta: { workedIssue: { issueId: issue.body.id } } })
        .where(eq(messages.id, second.row.id));
      await server.deps.db
        .update(schema.issues)
        .set({ work: { state: "working", reason: null, runId: null, messageId: second.row.id } })
        .where(eq(schema.issues.id, issue.body.id));
      const live = (server.runtime as unknown as { live: Map<string, { after: unknown[] }> }).live.get(
        started.runId,
      );
      live?.after.push(second.row);
      expect((await call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`)).status).toBe(204);
      const at = await archivedAtOf(t.lia.id);
      await started.done;
      await Bun.sleep(300);
      await settleAgent(t.workspaceId, t.lia.id);
      const out = await afterArchive(t.lia.id, at);
      expect(out.late.every((s) => s === "canceled")).toBe(true);
      // Nothing it half wrote before the archive goes out either.
      const [run] = await server.deps.db.select().from(runs).where(eq(runs.id, started.runId));
      expect(run?.status).toBe("canceled");
      const fromRun = await server.deps.db.select().from(messages).where(eq(messages.runId, started.runId));
      expect(fromRun).toEqual([]);
      expect(out.said).toEqual([]);
      const [after] = await server.deps.db
        .select({ work: schema.issues.work })
        .from(schema.issues)
        .where(eq(schema.issues.id, issue.body.id));
      expect((after?.work as { state?: string } | null)?.state).toBe("idle");
    },
    SERVER_TEST_MS,
  );

  test(
    "a mention routed just before the archive starts a run that ends canceled, and the agent says nothing",
    async () => {
      const t = await team();
      const rt = server.runtime as unknown as { budgetCheck: (...args: unknown[]) => Promise<unknown> };
      const saved = rt.budgetCheck;
      let hit = false;
      // The archive lands between the routing (the agent still active) and the run's start.
      rt.budgetCheck = async (...args: unknown[]) => {
        if (!hit) {
          hit = true;
          await archiveAgent(server.deps, t.workspaceId, t.lia.id, t.ana.user.id);
        }
        return saved.apply(rt, args);
      };
      try {
        const posted = await say(t, `@${t.lia.handle} the report`);
        await server.deps.runtime.onPersonMessage({
          workspaceId: t.workspaceId,
          channel: posted.channel,
          message: posted.message,
        });
      } finally {
        rt.budgetCheck = saved;
      }
      expect(hit).toBe(true);
      const at = await archivedAtOf(t.lia.id);
      await Bun.sleep(300);
      await settleAgent(t.workspaceId, t.lia.id);
      const out = await afterArchive(t.lia.id, at);
      expect(out.late).toEqual(["canceled"]);
      expect(out.said).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "its reminders are canceled, one scheduled meanwhile doesn't go out, and redoing one is refused",
    async () => {
      const t = await team();
      const reminder = async (minutes: number) => {
        const id = newId("rem");
        await server.deps.db.insert(reminders).values({
          id,
          workspaceId: t.workspaceId,
          agentId: t.lia.id,
          channelId: t.general,
          threadId: null,
          text: `Standup in ${minutes}`,
          at: new Date(Date.now() + minutes * 60_000),
          createdByType: "agent",
          createdById: t.lia.id,
        });
        return id;
      };
      const statusOfReminder = async (id: string) =>
        (await server.deps.db.select().from(reminders).where(eq(reminders.id, id)))[0]?.status;
      // One the agent scheduled with a receipt, undone before the archive.
      const run = await toolRun(server, { workspaceId: t.workspaceId, agent: t.lia, channelId: t.general });
      const at = new Date(Date.now() + 3_600_000).toISOString();
      expect((await run.call("schedule_reminder", { text: "Ping the team", at })).isError).toBe(false);
      const action = await run.action("reminder_created");
      expect((await call(t.ana, "POST", `${t.w}/actions/${action}/undo`)).status).toBe(200);
      const pending = await reminder(5);
      expect((await call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`)).status).toBe(204);
      expect(await statusOfReminder(pending)).toBe("canceled");
      const redo = await call(t.ana, "POST", `${t.w}/actions/${action}/redo`);
      expect([redo.status, redo.body?.error?.code]).toEqual([409, "agent.archived"]);
      // One a tool scheduled while the archive committed: the sweep doesn't post it.
      const late = await reminder(1);
      await server.deps.db
        .update(reminders)
        .set({ at: new Date(Date.now() - 1000) })
        .where(eq(reminders.id, late));
      const archivedAt = await archivedAtOf(t.lia.id);
      await server.runtime.tick();
      expect(await statusOfReminder(late)).toBe("canceled");
      expect((await afterArchive(t.lia.id, archivedAt)).said).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a routine that writes a file writes none when the archive lands before or while the model writes",
    async () => {
      const t = await team();
      const fire = async () => {
        const [routine] = await server.deps.db
          .insert(schema.routines)
          .values({
            id: newId("rtn"),
            workspaceId: t.workspaceId,
            name: "Digest",
            prompt: "Sum up the day",
            agentId: t.lia.id,
            target: { kind: "file" },
            trigger: { kind: "webhook" },
            createdBy: t.beto.user.id,
          })
          .returning();
        if (!routine) throw new Error("no routine");
        const reg = await registerFire(server.deps, routine.id, { trigger: "webhook", key: newId("k") });
        if (reg.duplicate) throw new Error("duplicate fire");
        return startRoutineRun(server.deps, reg.run);
      };
      const files = () =>
        server.deps.db.select().from(schema.files).where(eq(schema.files.workspaceId, t.workspaceId));
      const rt = server.deps.runtime;
      const complete = rt.complete;
      try {
        // While the model writes: the answer comes back after the archive.
        rt.complete = async (input) => {
          const out = await complete.call(rt, input);
          await t.archive();
          return out;
        };
        expect(await fire()).toMatchObject({ status: "failed", reason: "agent_gone" });
        // Before: the model isn't called at all.
        rt.complete = complete;
        let called = false;
        const real = (server.runtime as unknown as { reserveCall: (...a: unknown[]) => Promise<unknown> })
          .reserveCall;
        (server.runtime as unknown as { reserveCall: (...a: unknown[]) => Promise<unknown> }).reserveCall = (
          ...a
        ) => {
          called = true;
          return real.apply(server.runtime, a);
        };
        try {
          expect(
            (
              await complete.call(rt, {
                agent: t.lia,
                initiatedBy: t.beto.user.id,
                source: "routine",
                what: "x",
                system: "s",
                prompt: "p",
              } as never)
            ).ok,
          ).toBe(false);
        } finally {
          (server.runtime as unknown as { reserveCall: unknown }).reserveCall = real;
        }
        expect(called).toBe(false);
      } finally {
        rt.complete = complete;
      }
      expect(await files()).toEqual([]);
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
    "archiving stops its assignment's running job, starts no other, and nobody gives it a new one",
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
      // A job already running when the archive lands stops with it.
      const job = await startAssignmentJob(server.deps, active, { extra: "" });
      expect((await call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`)).status).toBe(204);
      // The runner is told to cancel it (the job ends when the runner reports back).
      expect(requests(fake.runner, "job.cancel").map((r) => (r.args as { jobId: string }).jobId)).toEqual([
        job.id,
      ]);
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

describe("an archived agent's jobs", () => {
  /** An active assignment of Lia's on a fake runner Ana paired, with the given executor. */
  async function assignmentOn(t: Team, executor: "agent" | "claude_code") {
    const fake = await pairFake(server, t.ana, t.workspaceId, { open });
    await server.deps.db.update(agents).set({ environmentId: fake.runnerId }).where(eq(agents.id, t.lia.id));
    const row = await createAssignment(server.deps, {
      workspaceId: t.workspaceId,
      agentId: t.lia.id,
      agentHandle: t.lia.handle,
      channelId: t.general,
      ownerId: t.ana.user.id,
      title: "Fix the flaky test",
      goal: "The suite passes ten times in a row",
      executor,
      runnerId: fake.runnerId,
      commandPolicy: "never",
    });
    const [active] = await server.deps.db
      .update(assignments)
      .set({ status: "active", startedAt: server.deps.now() })
      .where(eq(assignments.id, row.id))
      .returning();
    if (!active) throw new Error("assignment not activated");
    return { fake, row: active };
  }

  test(
    "start_job past the tool gate starts nothing once the archive landed",
    async () => {
      const t = await team();
      const { fake, row } = await assignmentOn(t, "agent");
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
      if (!agent) throw new Error("agent gone");
      const tools = [
        ...(await assignmentToolsFor(server.deps, agent, row.threadId)),
        ...(await environmentToolsFor({ deps: server.deps, agent })),
      ];
      const i = tools.findIndex((x) => x.name === "start_job");
      const real = tools[i];
      if (!real) throw new Error("no start_job");
      // runTool's check passed; the archive commits and finishes its cancels before the tool's body runs.
      tools[i] = {
        ...real,
        async run(ctx, input, planned) {
          await archiveAgent(server.deps, t.workspaceId, t.lia.id, t.ana.user.id);
          return real.run(ctx, input, planned);
        },
      };
      const run = await toolRun(server, {
        workspaceId: t.workspaceId,
        agent,
        channelId: t.general,
        asker: t.ana,
        tools,
      });
      const out = await run.call("start_job", { title: "Fix", prompt: "Fix it" }, { threadId: row.threadId });
      expect([out.isError, out.content]).toEqual([true, "Not done: this agent was archived."]);
      expect(requests(fake.runner, "job.start")).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "one assignment whose cancel fails doesn't keep the archive from cancelling the others",
    async () => {
      const t = await team();
      const one = await assignmentOn(t, "claude_code");
      const two = await assignmentOn(t, "claude_code");
      const first = await startAssignmentJob(server.deps, one.row, { extra: "" });
      const second = await startAssignmentJob(server.deps, two.row, { extra: "" });
      const { runners } = server.deps;
      const callRunner = runners.call;
      let failed = false;
      // The first cancel throws before it reaches the runner (not a runner error the cancel absorbs).
      runners.call = ((...args: Parameters<typeof callRunner>) => {
        if (args[1] === "job.cancel" && !failed) {
          failed = true;
          throw new Error("database gone for a moment");
        }
        return callRunner.apply(runners, args);
      }) as typeof callRunner;
      try {
        expect((await call(t.ana, "DELETE", `${t.w}/agents/${t.lia.id}`)).status).toBe(204);
      } finally {
        runners.call = callRunner;
      }
      expect(failed).toBe(true);
      const canceled = [
        ...requests(one.fake.runner, "job.cancel"),
        ...requests(two.fake.runner, "job.cancel"),
      ].map((r) => (r.args as { jobId: string }).jobId);
      expect(canceled.length).toBe(1);
      expect([first.id, second.id]).toContain(canceled[0] ?? "");
    },
    SERVER_TEST_MS,
  );
});

describe("a memory consolidation", () => {
  test(
    "applying one for an archived agent is refused under its lock and the proposal stays ready",
    async () => {
      const t = await team();
      const id = newId("mcon");
      await server.deps.db
        .insert(schema.memoryConsolidations)
        .values({ id, workspaceId: t.workspaceId, agentId: t.lia.id, status: "ready" });
      await t.archive();
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
      if (!agent) throw new Error("agent gone");
      const me = { workspaceId: t.workspaceId, userId: t.ana.user.id, role: "owner" as const, handle: "ana" };
      await expect(applyConsolidation(server.deps, me, agent, id)).rejects.toMatchObject({
        code: "agent.archived",
      });
      const [row] = await server.deps.db
        .select({ status: schema.memoryConsolidations.status })
        .from(schema.memoryConsolidations)
        .where(eq(schema.memoryConsolidations.id, id));
      expect(row?.status).toBe("ready");
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
