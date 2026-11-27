// The agent's assignment tools and its commands on a runner, against a fake runner paired through its owner's
// browser (it answers the server's requests as the test says). The agent's runtime comes with a later module, so
// each call goes through `runTool` with the tools the runtime would pick for the run (`assignmentToolsFor`,
// `environmentToolsFor`), in the assignment's thread and as the person who asked.
//
// What a command may reach is the point here: only the runner lent to the agent and paired to this workspace,
// through the approval gates (the workspace's rule and the assignment's command policy), with its output capped,
// and a runner that goes away in the middle leaves an error, never an assignment stuck on it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { RiskTracker } from "@vanr/engine/effects";
import { and, eq } from "drizzle-orm";
import { runningJobsOf } from "../src/assignments/core";
import { createAssignment, wake } from "../src/assignments/engine";
import { planOf, touchItem, writePlan } from "../src/assignments/plan";
import { proofsOf } from "../src/assignments/proofs";
import {
  assignmentPostMeta,
  assignmentPrompt,
  assignmentRouting,
  assignmentToolsFor,
} from "../src/assignments/tools";
import { environmentToolsFor } from "../src/runners/agent-tools";
import { moveIntervention } from "../src/runners/requests";
import { TOOL_OUTPUT_MAX, type ToolContext } from "../src/runtime/tools";
import type { RunningServer } from "../src/server";
import { type Answer, type Answerer, doing, exec, pairFake, requests } from "./fake-runner";
import { body, SERVER_TEST_MS, signedIn, startTestServer, waitFor } from "./harness";
import type { ProtocolRunner } from "./protocol-runner";
import { memberOf, type Person, seedChannel, seedDm, seedWorkspace } from "./seed";
import { racing, seedAgent, toolRun } from "./tool-run";

const {
  agents,
  assignments,
  assignmentCommands,
  assignmentDecisions,
  assignmentEvents,
  runners,
  runnerJobs,
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
const email = (who: string) => `${who}${++n}@assignment-tools.test`;

/** Ana owns the workspace, Beto is a member; Lia is Ana's agent in #general, lent a fake runner. */
async function team(answer?: Answerer, browser = false) {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Assignments");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const lia = await seedAgent(server, workspaceId, ana, { name: "Lia", channels: [general] });
  const fake = await pairFake(server, ana, workspaceId, { answer, browser, open });
  await server.deps.db.update(agents).set({ environmentId: fake.runnerId }).where(eq(agents.id, lia.id));
  return { ana, beto, workspaceId, general, lia, fake, ws: `/api/v1/workspaces/${workspaceId}` };
}
type Team = Awaited<ReturnType<typeof team>>;

/** An active assignment of Lia's in #general, owned by Ana. */
async function assignmentOf(
  t: Team,
  opts: { commandPolicy?: "always" | "when_safe" | "never"; runnerId?: string | null } = {},
) {
  const row = await createAssignment(server.deps, {
    workspaceId: t.workspaceId,
    agentId: t.lia.id,
    agentHandle: t.lia.handle,
    channelId: t.general,
    ownerId: t.ana.user.id,
    title: "Fix the flaky test",
    goal: "The suite passes ten times in a row",
    executor: "agent",
    runnerId: opts.runnerId ?? null,
    commandPolicy: opts.commandPolicy ?? "never",
  });
  const [active] = await server.deps.db
    .update(assignments)
    .set({ status: "active", startedAt: server.deps.now() })
    .where(eq(assignments.id, row.id))
    .returning();
  if (!active) throw new Error("assignment not activated");
  return active;
}

/** Lia's run in the assignment's thread (or outside it), asked by `asker`, with the tools the runtime would give. */
async function run(t: Team, threadId: string | null, asker: Person | null = t.ana, channelId = t.general) {
  const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
  if (!agent) throw new Error("agent gone");
  const tools = [
    ...(await assignmentToolsFor(server.deps, agent, threadId)),
    ...(await environmentToolsFor({ deps: server.deps, agent })),
  ];
  const r = await toolRun(server, { workspaceId: t.workspaceId, agent, channelId, asker, tools });
  const call = (name: string, input: unknown, over: Partial<ToolContext> = {}) =>
    r.call(name, input, { threadId, ...over });
  return { ...r, call, tools: tools.map((x) => x.name) };
}

const pendingCommand = async (assignmentId: string) => {
  let id = "";
  await waitFor(async () => {
    const [cmd] = await server.deps.db
      .select()
      .from(assignmentCommands)
      .where(and(eq(assignmentCommands.assignmentId, assignmentId), eq(assignmentCommands.state, "pending")));
    id = cmd?.id ?? "";
    return !!cmd;
  });
  return id;
};

/** Wakes the gate's wait on a command (the route's decision), once the wait is registered. */
const decide = async (commandId: string, value: "allowed" | "denied") => {
  await server.deps.db
    .update(assignmentCommands)
    .set({ state: value })
    .where(eq(assignmentCommands.id, commandId));
  await waitFor(async () => wake(commandId, value));
};

describe("assignment tools", () => {
  test(
    "outside an assignment only propose_assignment: it needs a person and a channel",
    async () => {
      const t = await team();
      const outside = await run(t, null, t.beto);
      expect(outside.tools.filter((x) => !x.startsWith("browser_"))).toContain("propose_assignment");
      expect(outside.tools).not.toContain("update_plan");
      const proposed = await outside.call("propose_assignment", {
        title: "Migrate the reports",
        goal: "Every report reads from the new table",
        plan: ["Map the reports", "Move them"],
      });
      expect(proposed.isError).toBe(false);
      const id = /\((asg_[^)]+)\)/.exec(proposed.content)?.[1] as string;
      const [row] = await server.deps.db.select().from(assignments).where(eq(assignments.id, id));
      expect(row).toMatchObject({ status: "proposed", ownerId: t.beto.user.id, channelId: t.general });

      const routine = await run(t, null, null);
      expect((await routine.call("propose_assignment", { title: "x", goal: "y" })).content).toContain(
        "Only a person can own an assignment",
      );
      const dm = await seedDm(server, t.workspaceId, t.ana, t.beto);
      const inDm = await run(t, null, t.ana, dm);
      expect((await inDm.call("propose_assignment", { title: "x", goal: "y" })).content).toContain(
        "Assignments live in channels",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "in the assignment's thread: plan, finish with proofs, report, decision, review, approval, Drive, context and submission",
    async () => {
      const t = await team();
      const row = await assignmentOf(t);
      const r = await run(t, row.threadId);
      expect(r.tools).toContain("update_plan");
      expect(r.tools).not.toContain("propose_assignment");

      const plan = await r.call("update_plan", {
        items: [
          { id: "p1", title: "Find the flaky test", criteria: "Named in the notes" },
          { id: "p2", title: "Fix it", status: "blocked_on_you" },
        ],
      });
      expect(plan.content).toBe("Plan v1: 0/2 done, 0 passed the verifier.");
      // Only the verifier marks an item passed: a `passes` the agent sends is dropped.
      const again = await r.call("update_plan", {
        items: [
          { id: "p1", title: "Find the flaky test", criteria: "Named in the notes", passes: true },
          { id: "p2", title: "Fix it", status: "blocked_on_you" },
        ],
      });
      expect(again.content).toContain("0 passed the verifier");

      const finished = await r.call("finish_item", {
        itemId: "p1",
        summary: "It is the clock test",
        proofs: [{ kind: "test_log", title: "bun test", text: "3 pass" }],
      });
      expect(finished.content).toContain("Marked p1 done");
      expect((await proofsOf(server.deps, row.id, "p1")).map((p) => p.body)).toEqual(["3 pass"]);
      expect((await r.call("finish_item", { itemId: "nope", summary: "x" })).content).toContain(
        "no item nope",
      );

      // Five reports at once: one statement each appends to the notes as they are now, so none is lost.
      await Promise.all([1, 2, 3, 4, 5].map((i) => r.call("report", { text: `finding ${i}` })));
      const [noted] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
      expect(noted?.findings.map((f) => f.text).sort()).toEqual([1, 2, 3, 4, 5].map((i) => `finding ${i}`));
      expect((await r.call("report", { text: "x", prUrl: "javascript:alert(1)" })).isError).toBe(true);

      const asked = await r.call("ask_decision", {
        question: "Retry or rewrite?",
        options: ["retry", "rewrite"],
        recommendation: "rewrite",
      });
      expect(asked.content).toContain("End the turn");
      const [decision] = await server.deps.db
        .select()
        .from(assignmentDecisions)
        .where(eq(assignmentDecisions.assignmentId, row.id));
      expect(decision).toMatchObject({ status: "pending", recommendation: "rewrite" });
      expect(decision?.messageId).toBeTruthy();
      const inbox = await body(await t.ana.browser.json(`${t.ws}/notifications`, "GET"));
      expect(JSON.stringify(inbox)).toContain("Retry or rewrite?");
      expect(
        (await r.call("ask_decision", { question: "q", options: ["a", "b"], recommendation: "c" })).isError,
      ).toBe(true);

      // A file from a channel the assignment doesn't share is not attached to its review.
      const secret = await seedChannel(server, t.workspaceId, {
        name: "board",
        visibility: "private",
        members: [t.ana],
      });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: secret, memberType: "agent", memberId: t.lia.id });
      const elsewhere = await run(t, null, t.ana, secret);
      const saved = await elsewhere.call("create_drive_file", {
        title: "Board notes",
        content: { kind: "document", markdown: "private" },
      });
      const boardFile = /\((file_[^)]+)\)/.exec(saved.content)?.[1] as string;
      const leaked = await r.call("request_review", { title: "Look", summary: "s", fileIds: [boardFile] });
      expect(leaked.isError).toBe(true);
      const uploaded = await r.call("upload_drive_file", {
        title: "Findings",
        markdown: "# It is the clock",
      });
      const findings = /\((file_[^)]+)\)/.exec(uploaded.content)?.[1] as string;
      expect(
        (await r.call("request_review", { title: "Look", summary: "s", fileIds: [findings] })).content,
      ).toContain("Review requested");

      const approvals: unknown[] = [];
      const approved = await r.call(
        "request_approval",
        { title: "Deploy the fix" },
        {
          requestApproval: async (req) => {
            approvals.push(req.gateReason);
            return {
              id: "apv_t",
              decision: "approved",
              reason: null,
              byName: "Ana",
              payloadHash: req.payloadHash,
            };
          },
        },
      );
      expect(approved.content).toBe("Approved.");
      expect(approvals).toEqual(["policy"]);

      expect((await r.call("get_context", {})).content).toContain("Find the flaky test");

      const early = await r.call("complete_assignment", { summary: "done", checklist: ["Run the suite"] });
      expect(early.content).toContain("Not every deliverable passed the verifier yet");
      for (const item of ["p1", "p2"])
        await touchItem(server.deps, row.id, item, { status: "done", passes: true });
      const submitted = await r.call("complete_assignment", {
        summary: "The clock is injected now",
        checklist: ["Run the suite ten times"],
        paths: ["src/clock.ts"],
        fileIds: [findings],
      });
      expect(submitted.content).toContain("Submitted");
      const [after] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
      expect(after?.status).toBe("wrapping_up");
      const kinds = (
        await server.deps.db.select().from(assignmentEvents).where(eq(assignmentEvents.assignmentId, row.id))
      ).map((e) => e.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(["plan_edited", "item_done", "proof_added", "decision_asked"]),
      );
    },
    2 * SERVER_TEST_MS,
  );

  test(
    "another agent's, another workspace's, a paused or a closed assignment gets an error, not a write",
    async () => {
      const t = await team();
      const row = await assignmentOf(t);
      const other = await seedAgent(server, t.workspaceId, t.ana, { name: "Rui", channels: [t.general] });
      const rui = await toolRun(server, {
        workspaceId: t.workspaceId,
        agent: other,
        channelId: t.general,
        asker: t.ana,
        tools: await assignmentToolsFor(server.deps, other, row.threadId),
      });
      expect(
        (await rui.call("update_plan", { items: [{ title: "x" }] }, { threadId: row.threadId })).content,
      ).toContain("Unknown tool");

      const r = await run(t, row.threadId);
      // The same agent's run in another workspace, aimed at this thread.
      const eve = await signedIn(server, "Eve", email("eve"));
      const foreign = await seedWorkspace(server, eve, "Other");
      const misplaced = await r.call("report", { text: "x" }, { workspaceId: foreign.workspaceId });
      expect(misplaced.content).toContain("not one of your assignments");

      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, row.id));
      expect((await r.call("report", { text: "x" })).content).toContain("paused");
      await server.deps.db.update(assignments).set({ status: "done" }).where(eq(assignments.id, row.id));
      expect((await r.call("report", { text: "x" })).content).toContain("closed");
      const [kept] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
      expect(kept?.findings).toEqual([]);
      expect((await assignmentToolsFor(server.deps, t.lia, row.threadId)).map((x) => x.name)).toEqual([
        "propose_assignment",
      ]);
    },
    SERVER_TEST_MS,
  );

  test(
    "adversarial: the agent neither drops nor rewrites a person's item, and doesn't submit without an approved deliverable",
    async () => {
      const t = await team();
      const row = await assignmentOf(t);
      const person = { type: "person" as const, id: t.ana.user.id };
      await writePlan(server.deps, row.id, {
        author: person,
        mode: "person",
        items: [{ id: "p1", title: "Migrate the database", criteria: "Migration applied" }],
      });
      const r = await run(t, row.threadId);
      // The attack: the agent drops the item, swaps its criterion and submits.
      await r.call("update_plan", {
        items: [{ id: "p1", title: "Other", criteria: "nothing", status: "dropped" }],
      });
      const submitted = await r.call("complete_assignment", { summary: "done", checklist: ["ok"] });
      expect(submitted.content).toContain("Not every deliverable passed the verifier yet (p1)");
      const [p1] = await planOf(server.deps, row.id);
      expect(p1?.status).not.toBe("dropped");
      expect(p1?.title).toBe("Migrate the database");
      expect(p1?.criteria).toStartWith("Migration applied");
      const none = await server.deps.db
        .select()
        .from(schema.assignmentSubmissions)
        .where(eq(schema.assignmentSubmissions.assignmentId, row.id));
      expect(none).toEqual([]);

      // A plan dropped whole: complete_assignment doesn't submit (before, nothing open was enough).
      const empty = await assignmentOf(t);
      await writePlan(server.deps, empty.id, {
        author: person,
        mode: "person",
        items: [{ id: "p1", title: "One" }],
      });
      await writePlan(server.deps, empty.id, { author: person, mode: "person", items: [] });
      const e = await run(t, empty.threadId);
      const out = await e.call("complete_assignment", { summary: "done", checklist: ["ok"] });
      expect(out.content).toContain("The plan has no deliverable");
      expect(
        await server.deps.db
          .select()
          .from(schema.assignmentSubmissions)
          .where(eq(schema.assignmentSubmissions.assignmentId, empty.id)),
      ).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "an approved item sent again without a status keeps its verdict; a proposal's item can't be finished",
    async () => {
      const t = await team();
      const row = await assignmentOf(t);
      const r = await run(t, row.threadId);
      await r.call("update_plan", { items: [{ id: "p1", title: "Find the flaky test" }] });
      await touchItem(server.deps, row.id, "p1", { status: "done", passes: true });
      const again = await r.call("update_plan", {
        items: [{ id: "p1", title: "Find the flaky test" }, { title: "Fix it" }],
      });
      expect(again.content).toBe("Plan v2: 1/2 done, 1 passed the verifier.");
      const [p1] = await planOf(server.deps, row.id);
      expect(p1).toMatchObject({ status: "done", passes: true });

      const proposed = await createAssignment(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        agentHandle: t.lia.handle,
        channelId: t.general,
        ownerId: t.ana.user.id,
        title: "Not started",
        goal: "Wait for the owner",
        executor: "agent",
        runnerId: null,
        commandPolicy: "never",
        plan: ["Do it"],
      });
      const early = await (await run(t, proposed.threadId)).call("finish_item", {
        itemId: "p1",
        summary: "done",
      });
      expect(early.content).toContain("has not started this assignment yet");
      const [untouched] = await planOf(server.deps, proposed.id);
      expect(untouched?.status).toBe("todo");
      expect(await proofsOf(server.deps, proposed.id)).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a card posted before its post call fails keeps its decision and its review: the card points at them",
    async () => {
      const t = await team();
      const row = await assignmentOf(t);
      const r = await run(t, row.threadId);
      const base = r.ctx();
      // The message is written and published, then something after it (a notice) fails.
      const late = {
        postCard: async (body: string, meta: Parameters<typeof base.postCard>[1]) => {
          await base.postCard(body, meta);
          throw new Error("notice failed");
        },
      };
      await expect(
        r.call("ask_decision", { question: "Retry or rewrite?", options: ["retry", "rewrite"] }, late),
      ).rejects.toThrow("notice failed");
      await expect(r.call("request_review", { title: "Look", summary: "s" }, late)).rejects.toThrow(
        "notice failed",
      );
      const pointed = r.cards.map(
        (c) =>
          c.meta as { assignmentDecision?: { decisionId: string }; assignmentReview?: { reviewId: string } },
      );
      const decisionId = pointed.find((m) => m.assignmentDecision)?.assignmentDecision?.decisionId as string;
      const reviewId = pointed.find((m) => m.assignmentReview)?.assignmentReview?.reviewId as string;
      expect(
        await server.deps.db.select().from(assignmentDecisions).where(eq(assignmentDecisions.id, decisionId)),
      ).toHaveLength(1);
      expect(
        await server.deps.db
          .select()
          .from(schema.assignmentReviews)
          .where(eq(schema.assignmentReviews.id, reviewId)),
      ).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "the thread's prompt, routing and the suggestion of whoever only views",
    async () => {
      const t = await team();
      const row = await assignmentOf(t);
      await run(t, row.threadId).then((r) =>
        r.call("update_plan", { items: [{ id: "p1", title: "Find the flaky test", criteria: "Named" }] }),
      );
      const prompt = await assignmentPrompt(server.deps, t.lia.id, row.threadId);
      expect(prompt).toContain("# Assignment: Fix the flaky test");
      expect(prompt).toContain("- [todo] (p1) Find the flaky test — done when: Named");
      expect(await assignmentPrompt(server.deps, "agt_someone_else", row.threadId)).toBe("");

      expect(await assignmentRouting(server.deps, { threadId: row.threadId, meta: {} })).toBe(true);
      expect(
        await assignmentRouting(server.deps, { threadId: row.threadId, meta: { assignmentSuggestion: {} } }),
      ).toBe(false);
      await server.deps.db.update(assignments).set({ status: "paused" }).where(eq(assignments.id, row.id));
      expect(await assignmentRouting(server.deps, { threadId: row.threadId, meta: {} })).toBe(false);

      const me = (who: Person) => ({ workspaceId: t.workspaceId, userId: who.user.id });
      expect(await assignmentPostMeta(server.deps, me(t.ana), row.threadId, "go")).toEqual({});
      expect(await assignmentPostMeta(server.deps, me(t.beto), row.threadId, "try the clock")).toEqual({
        assignmentSuggestion: { assignmentId: row.id, text: "try the clock", status: "pending" },
      });
      expect(
        await assignmentPostMeta(
          server.deps,
          { workspaceId: "ws_other", userId: t.beto.user.id },
          row.threadId,
          "x",
        ),
      ).toEqual({});
    },
    SERVER_TEST_MS,
  );
});

describe("commands on the agent's runner", () => {
  test(
    "a command aimed at another workspace's runner by id returns an error, not a run",
    async () => {
      const t = await team();
      const eve = await signedIn(server, "Eve", email("eve"));
      const foreign = await seedWorkspace(server, eve, "Other");
      const theirs = await pairFake(server, eve, foreign.workspaceId, { open });

      // As if the runtime had kept the runner tools of an earlier read: the call itself says no.
      const [lent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
      const kept = await environmentToolsFor({ deps: server.deps, agent: lent as typeof t.lia });
      expect(kept.map((x) => x.name)).toContain("execute_code");
      // The agent's runner points at the other workspace's runner.
      await server.deps.db
        .update(agents)
        .set({ environmentId: theirs.runnerId })
        .where(eq(agents.id, t.lia.id));
      const [pointed] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
      expect(await environmentToolsFor({ deps: server.deps, agent: pointed as typeof t.lia })).toEqual([]);
      const r = await toolRun(server, {
        workspaceId: t.workspaceId,
        agent: pointed as typeof t.lia,
        channelId: t.general,
        asker: t.ana,
        tools: kept,
      });
      const aimed = await r.call("execute_code", { command: "cat ~/.ssh/id_rsa" });
      expect(aimed.isError).toBe(true);
      expect(aimed.content).toContain("not paired to this workspace");
      for (const tool of ["read_file", "write_file", "list_files"]) {
        const out = await r.call(tool, { path: "x", content: "y" });
        expect(out.isError).toBe(true);
      }

      // The assignment's runner is the other workspace's: the job doesn't start there.
      await server.deps.db
        .update(agents)
        .set({ environmentId: t.fake.runnerId })
        .where(eq(agents.id, t.lia.id));
      const row = await assignmentOf(t, { runnerId: theirs.runnerId });
      const job = await (await run(t, row.threadId)).call("start_job", {
        title: "Fix",
        prompt: "Fix the test",
      });
      expect(job.isError).toBe(true);
      expect(job.content).toContain("no runner");
      expect(requests(theirs.runner, "exec")).toEqual([]);
      expect(requests(theirs.runner, "job.start")).toEqual([]);
      expect(requests(theirs.runner, "read")).toEqual([]);
      expect(
        await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.assignmentId, row.id)),
      ).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the assignment's default runner (the agent's) in another workspace is not reached either",
    async () => {
      const t = await team();
      const eve = await signedIn(server, "Eve", email("eve"));
      const foreign = await seedWorkspace(server, eve, "Other");
      const theirs = await pairFake(server, eve, foreign.workspaceId, { open });
      // No runner chosen for the assignment: it uses the agent's, which now points at the other workspace's.
      const row = await assignmentOf(t, { runnerId: null });
      await server.deps.db
        .update(agents)
        .set({ environmentId: theirs.runnerId })
        .where(eq(agents.id, t.lia.id));
      const job = await (await run(t, row.threadId)).call("start_job", {
        title: "Fix",
        prompt: "Fix the test",
      });
      expect(job.isError).toBe(true);
      expect(job.content).toContain("no runner");
      expect(requests(theirs.runner, "job.start")).toEqual([]);
      expect(requests(theirs.runner, "write")).toEqual([]);
      expect(
        await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.assignmentId, row.id)),
      ).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a command approved for one runner doesn't run on the runner lent in the meantime",
    async () => {
      const t = await team();
      const other = await pairFake(server, t.ana, t.workspaceId, { open });
      await server.deps.db
        .insert(schema.sandboxPolicies)
        .values({ workspaceId: t.workspaceId, requireApproval: true });
      const r = await run(t, null);
      const out = await r.call(
        "execute_code",
        { command: "deploy.sh" },
        {
          // While the approval waits, a person lends Lia the other runner; then the approval comes.
          requestApproval: async (req) => {
            await server.deps.db
              .update(agents)
              .set({ environmentId: other.runnerId })
              .where(eq(agents.id, t.lia.id));
            return {
              id: "apv_l",
              decision: "approved",
              reason: null,
              byName: "Ana",
              payloadHash: req.payloadHash,
            };
          },
          settleApproval: async () => {},
        },
      );
      expect(out.isError).toBe(true);
      expect(out.content).toContain("no longer what was approved");
      expect(requests(other.runner, "exec")).toEqual([]);
      expect(requests(t.fake.runner, "exec")).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a person who may not use the runner can't reach it through the agent; who may, and a run without a person, can",
    async () => {
      const t = await team(undefined, true);
      await server.deps.db
        .insert(schema.sandboxPolicies)
        .values({ workspaceId: t.workspaceId, requireApproval: true });
      const sent = () => t.fake.runner.frames.filter((f) => f.type === "request").length;
      const before = sent();
      const asked: string[] = [];
      const ask = {
        requestApproval: async (req: { tool: string; payloadHash: string }) => {
          asked.push(req.tool);
          return {
            id: "apv_p",
            decision: "approved" as const,
            reason: null,
            byName: "Ana",
            payloadHash: req.payloadHash,
          };
        },
        settleApproval: async () => {},
      };
      // Beto is a member: he didn't pair the runner and doesn't manage agents.
      const beto = await run(t, null, t.beto);
      const calls: [string, unknown][] = [
        ["execute_code", { command: "cat ~/.ssh/id_rsa" }],
        ["read_file", { path: ".ssh/id_rsa" }],
        ["write_file", { path: "x", content: "y" }],
        ["list_files", { path: "." }],
        ["environment_status", {}],
        ["environment_stop", {}],
        ["request_secret", { name: "TOKEN", purpose: "x" }],
        ["browser_navigate", { url: "https://bank.example" }],
        ["browser_read", {}],
      ];
      for (const [tool, input] of calls) {
        const out = await beto.call(tool, input, ask);
        expect(out.isError).toBe(true);
        expect(out.content).toContain("may not use your runner");
      }
      expect(asked).toEqual([]);
      expect(sent()).toBe(before);

      // Ana paired it; Caio is an admin (manages agents); a routine has no person: all three reach it.
      const caio = await memberOf(server, t.workspaceId, "Caio", email("caio"), "admin");
      for (const who of [t.ana, caio, null]) {
        const out = await (await run(t, null, who)).call("execute_code", { command: "echo ok" }, ask);
        expect(out.content).toContain("ran: echo ok");
      }
      expect(asked).toEqual(["execute_code", "execute_code", "execute_code"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a removed or revoked runner gets an error at the tool, even while its connection is still up",
    async () => {
      const t = await team();
      const r = await run(t, null);
      for (const gone of [{ removedAt: server.deps.now() }, { revokedAt: server.deps.now() }]) {
        await server.deps.db
          .update(runners)
          .set({ removedAt: null, revokedAt: null, ...gone })
          .where(eq(runners.id, t.fake.runnerId));
        expect(server.deps.runners.isOnline(t.fake.runnerId)).toBe(true);
        const out = await r.call("execute_code", { command: "echo hi" });
        expect(out.content).toContain("was removed");
      }
      expect(requests(t.fake.runner, "exec")).toEqual([]);
      // The assignment's own runner, revoked: no job starts on it.
      const row = await assignmentOf(t, { runnerId: t.fake.runnerId });
      const job = await (await run(t, row.threadId)).call("start_job", { title: "Fix", prompt: "Fix it" });
      expect(job.content).toContain("no runner");
      expect(requests(t.fake.runner, "job.start")).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "commands turned off on the runner never reach it, and the output that comes back is capped",
    async () => {
      const t = await team((req, runner) =>
        req.op === "exec"
          ? {
              ok: true,
              data: {
                exitCode: 1,
                stdout: "x".repeat(1_000_000),
                stderr: `${"e".repeat(50_000)}FATAL`,
                truncated: true,
                timedOut: false,
                durationMs: 5,
                blocked: [],
              },
            }
          : doing(req, runner),
      );
      const r = await run(t, null);
      const big = await r.call("execute_code", { command: "yes x | head -c 1000000" });
      expect(big.isError).toBe(true);
      expect(big.content.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX);
      expect(big.content).toContain("[… cut 988000 chars]");
      // The stderr's start survives a huge stdout, and the runner's own cut is said.
      expect(big.content).toContain("stderr:\neeee");
      expect(big.content).toContain("(output truncated on the runner)");

      await server.deps.db
        .update(runners)
        .set({
          access: { folders: [], tools: { claude: true, codex: false, commands: false, browser: false } },
        })
        .where(eq(runners.id, t.fake.runnerId));
      const before = requests(t.fake.runner, "exec").length;
      // Even with the workspace asking for every command, nobody is asked to approve one the runner won't run.
      await server.deps.db
        .insert(schema.sandboxPolicies)
        .values({ workspaceId: t.workspaceId, requireApproval: true });
      const asked: string[] = [];
      const off = await r.call(
        "execute_code",
        { command: "echo hi" },
        {
          requestApproval: async (req) => {
            asked.push(req.tool);
            return {
              id: "apv_o",
              decision: "approved",
              reason: null,
              byName: "Ana",
              payloadHash: req.payloadHash,
            };
          },
          settleApproval: async () => {},
        },
      );
      expect(off.content).toBe("Commands are turned off on this runner.");
      expect(asked).toEqual([]);
      expect(requests(t.fake.runner, "exec").length).toBe(before);
    },
    SERVER_TEST_MS,
  );

  test(
    "the approval gates stay: the workspace's rule and the assignment's command policy decide before the runner",
    async () => {
      const t = await team();
      // The workspace asks for every command: rejected, nothing reaches the runner.
      await server.deps.db
        .insert(schema.sandboxPolicies)
        .values({ workspaceId: t.workspaceId, requireApproval: true });
      const r = await run(t, null);
      const rejected = await r.call(
        "execute_code",
        { command: "rm -rf build" },
        {
          requestApproval: async () => ({
            id: "apv_r",
            decision: "rejected",
            reason: "not now",
            byName: "Ana",
          }),
        },
      );
      expect(rejected.isError).toBe(true);
      expect(requests(t.fake.runner, "exec")).toEqual([]);
      await server.deps.db
        .update(schema.sandboxPolicies)
        .set({ requireApproval: false })
        .where(eq(schema.sandboxPolicies.workspaceId, t.workspaceId));

      // An assignment that asks for every command: a denial runs nothing; an approval runs it once.
      const row = await assignmentOf(t, { commandPolicy: "always" });
      const a = await run(t, row.threadId);
      const denied = a.call("execute_code", { command: "git push --force" });
      await decide(await pendingCommand(row.id), "denied");
      expect((await denied).content).toContain("A person denied this command");
      expect(requests(t.fake.runner, "exec")).toEqual([]);
      const allowed = a.call("execute_code", { command: "bun test" });
      await decide(await pendingCommand(row.id), "allowed");
      expect((await allowed).content).toContain("ran: bun test");
      expect(requests(t.fake.runner, "exec").map((f) => f.args.command)).toEqual(["bun test"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a runner that goes away in the middle of a command or a job start leaves an error, and the assignment goes on",
    async () => {
      let vanish = true;
      const t = await team((req, runner) => {
        if (vanish && (req.op === "exec" || req.op === "job.start")) {
          void runner.close();
          return new Promise<Answer>(() => {});
        }
        return doing(req, runner);
      });
      const row = await assignmentOf(t);
      const r = await run(t, row.threadId);
      const gone = await r.call("execute_code", { command: "bun test" });
      expect(gone.isError).toBe(true);
      expect(gone.content).toContain("The runner went offline");

      const back = await t.fake.connect();
      const jobGone = await r.call("start_job", { title: "Fix", prompt: "Fix the clock test" });
      expect(jobGone.isError).toBe(true);
      const [failed] = await server.deps.db
        .select()
        .from(runnerJobs)
        .where(eq(runnerJobs.assignmentId, row.id));
      expect(failed?.status).toBe("failed");
      expect(back.frames.some((f) => f.type === "request" && f.op === "job.start")).toBe(true);

      // Nothing holds the assignment: it is still active, with no command waiting and no job running.
      const [still] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
      expect(still?.status).toBe("active");
      expect(await runningJobsOf(server.deps.db, row.id)).toEqual([]);
      expect(
        await server.deps.db
          .select()
          .from(assignmentCommands)
          .where(and(eq(assignmentCommands.assignmentId, row.id), eq(assignmentCommands.state, "pending"))),
      ).toEqual([]);
      vanish = false;
      await t.fake.connect();
      expect((await r.call("execute_code", { command: "bun test" })).content).toContain("ran: bun test");
      expect((await r.call("start_job", { title: "Fix", prompt: "Fix the clock test" })).content).toContain(
        "Started job",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "live: the agent works an assignment's item on its paired runner and the result lands on the assignment",
    async () => {
      const t = await team((req, runner) =>
        req.op === "exec" ? exec("bun test v1\n 12 pass\n 0 fail\n") : doing(req, runner),
      );
      const row = await assignmentOf(t, { commandPolicy: "when_safe" });
      const r = await run(t, row.threadId);
      await r.call("update_plan", {
        items: [{ id: "p1", title: "Make the suite pass", criteria: "bun test shows 0 fail" }],
      });
      const ran = await r.call("execute_code", { command: "bun test" });
      expect(ran.isError).toBe(false);
      expect(ran.content).toContain("12 pass");
      const finished = await r.call("finish_item", {
        itemId: "p1",
        summary: "The suite passes",
        proofs: [{ kind: "test_log", title: "bun test", text: ran.content }],
      });
      expect(finished.isError).toBe(false);
      expect(await r.call("report", { text: "bun test: 12 pass, 0 fail" })).toMatchObject({ isError: false });

      const proofs = await proofsOf(server.deps, row.id, "p1");
      expect(proofs[0]?.body).toContain("12 pass");
      const [landed] = await server.deps.db.select().from(assignments).where(eq(assignments.id, row.id));
      expect(landed?.findings.map((f) => f.text)).toEqual(["bun test: 12 pass, 0 fail"]);
      expect(r.cards.find((c) => (c.meta as { assignmentReport?: unknown }).assignmentReport)).toBeTruthy();
      expect(requests(t.fake.runner, "exec").map((f) => f.args.command)).toEqual(["bun test"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "two requests for a person in the browser at once make one card; a stopped run gives up its wait",
    async () => {
      const t = await team(undefined, true);
      const r = await run(t, null);
      const tools = r.tools;
      expect(tools).toContain("browser_ask_person");
      const stops = [new AbortController(), new AbortController(), new AbortController()];
      const calls = stops.map((stop) =>
        r.call(
          "browser_ask_person",
          { kind: "login", instructions: "Sign in to the shop" },
          { signal: stop.signal },
        ),
      );
      await waitFor(async () => {
        const rows = await server.deps.db
          .select()
          .from(schema.browserInterventions)
          .where(eq(schema.browserInterventions.agentId, t.lia.id));
        return rows.length > 0 && rows.every((x) => !!x.messageId);
      });
      for (const stop of stops) stop.abort();
      const outs = await Promise.all(calls);
      expect(outs.filter((o) => o.content.includes("already asked")).length).toBe(2);
      expect(outs.filter((o) => o.content === "The run stopped before the person finished.").length).toBe(1);
      const rows = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.agentId, t.lia.id));
      expect(rows.map((x) => x.status)).toEqual(["pending"]);
      expect(
        r.cards.filter((c) => (c.meta as { browserIntervention?: unknown }).browserIntervention).length,
      ).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "forced: a request for a person committed while the agent asks is seen under the lock, so the agent's isn't made",
    async () => {
      const t = await team(undefined, true);
      const r = await run(t, null);
      // Another run's request commits right before this call's transaction opens: after any read outside it.
      const deps = racing(server, () =>
        server.deps.db.insert(schema.browserInterventions).values({
          id: "bi_concurrent",
          workspaceId: t.workspaceId,
          agentId: t.lia.id,
          runnerId: t.fake.runnerId,
          kind: "captcha",
          instructions: "Solve it",
          expiresAt: new Date(server.deps.now().getTime() + 60_000),
        }),
      );
      const out = await r.call("browser_ask_person", { kind: "login", instructions: "Sign in" }, { deps });
      expect(out.content).toContain("already asked");
      const rows = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.agentId, t.lia.id));
      expect(rows.map((x) => x.id)).toEqual(["bi_concurrent"]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a person's request whose card can't be posted is canceled; the page after the person raises A",
    async () => {
      const t = await team(undefined, true);
      const r = await run(t, null);
      const failing = { postCard: async () => Promise.reject(new Error("chat down")) };
      await expect(
        r.call("browser_ask_person", { kind: "captcha", instructions: "Solve it" }, failing),
      ).rejects.toThrow("chat down");
      const [canceled] = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.agentId, t.lia.id));
      expect(canceled?.status).toBe("canceled");

      // The next request isn't held by the one without a card; once the person finishes, the page text counts as A.
      const risk = new RiskTracker();
      const asking = r.call("browser_ask_person", { kind: "captcha", instructions: "Solve it" }, { risk });
      let id = "";
      await waitFor(async () => {
        const [open] = await server.deps.db
          .select()
          .from(schema.browserInterventions)
          .where(
            and(
              eq(schema.browserInterventions.agentId, t.lia.id),
              eq(schema.browserInterventions.status, "pending"),
            ),
          );
        id = open?.messageId ? open.id : "";
        return !!id;
      });
      await moveIntervention(server.deps, id, ["pending"], { status: "done", note: "solved" });
      const out = await asking;
      expect(out.content).toContain("The person finished: solved.");
      expect(risk.reasons).toContainEqual({ flag: "A", source: "browser_ask_person (web page)" });
    },
    SERVER_TEST_MS,
  );

  test(
    "a person who finished the request while its card's post was failing keeps it done",
    async () => {
      const t = await team(undefined, true);
      const r = await run(t, null);
      const base = r.ctx();
      const finishing = {
        postCard: async (body: string, meta: Parameters<typeof base.postCard>[1]) => {
          await base.postCard(body, meta);
          const [open] = await server.deps.db
            .select()
            .from(schema.browserInterventions)
            .where(eq(schema.browserInterventions.agentId, t.lia.id));
          await moveIntervention(server.deps, open?.id as string, ["pending"], {
            status: "done",
            note: "signed in",
          });
          throw new Error("notice failed");
        },
      };
      await expect(
        r.call("browser_ask_person", { kind: "login", instructions: "Sign in" }, finishing),
      ).rejects.toThrow("notice failed");
      const [kept] = await server.deps.db
        .select()
        .from(schema.browserInterventions)
        .where(eq(schema.browserInterventions.agentId, t.lia.id));
      expect(kept).toMatchObject({ status: "done", note: "signed in" });
    },
    SERVER_TEST_MS,
  );

  test(
    "between a tool's plan and its run: lost access, a swapped runner and a revoked default runner all stop it",
    async () => {
      const t = await team();
      const caio = await memberOf(server, t.workspaceId, "Caio", email("caio"), "admin");
      const toolOf = async (name: string) => {
        const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
        const tool = (await environmentToolsFor({ deps: server.deps, agent: agent as typeof t.lia })).find(
          (x) => x.name === name,
        );
        if (!tool?.plan) throw new Error(`no ${name}`);
        return tool as Required<typeof tool>;
      };
      const ctxOf = async (asker: Person) => {
        const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
        return (
          await toolRun(server, {
            workspaceId: t.workspaceId,
            agent: agent as typeof t.lia,
            channelId: t.general,
            asker,
          })
        ).ctx();
      };

      // Caio is an admin when the status is planned and a member when it runs.
      const status = await toolOf("environment_status");
      const asCaio = await ctxOf(caio);
      await status.plan(asCaio, {});
      await server.deps.db
        .update(schema.members)
        .set({ role: "member" })
        .where(and(eq(schema.members.workspaceId, t.workspaceId), eq(schema.members.userId, caio.user.id)));
      await expect(status.run(asCaio, {})).rejects.toThrow("may not use your runner");

      // A command planned on one runner, with the agent lent another before it runs.
      const other = await pairFake(server, t.ana, t.workspaceId, { open });
      const exec = await toolOf("execute_code");
      const asAna = await ctxOf(t.ana);
      const input = { command: "deploy.sh" };
      await exec.plan(asAna, input);
      await server.deps.db
        .update(agents)
        .set({ environmentId: other.runnerId })
        .where(eq(agents.id, t.lia.id));
      await expect(exec.run(asAna, input)).rejects.toThrow("changed since this command was planned");
      expect(requests(other.runner, "exec")).toEqual([]);
      expect(requests(t.fake.runner, "exec")).toEqual([]);

      // The assignment has no runner of its own and the agent's, still connected, was revoked.
      await server.deps.db
        .update(agents)
        .set({ environmentId: t.fake.runnerId })
        .where(eq(agents.id, t.lia.id));
      const row = await assignmentOf(t, { runnerId: null });
      await server.deps.db
        .update(runners)
        .set({ revokedAt: server.deps.now() })
        .where(eq(runners.id, t.fake.runnerId));
      expect(server.deps.runners.isOnline(t.fake.runnerId)).toBe(true);
      const job = await (await run(t, row.threadId)).call("start_job", { title: "Fix", prompt: "Fix it" });
      expect(job.content).toContain("no runner");
      expect(requests(t.fake.runner, "job.start")).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "start_job doesn't use the personal plan of whoever paired the runner on someone else's assignment",
    async () => {
      const t = await team();
      // Beto owns the assignment; the runner (with its Claude Code plan) was paired by Ana.
      const row = await createAssignment(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.lia.id,
        agentHandle: t.lia.handle,
        channelId: t.general,
        ownerId: t.beto.user.id,
        title: "Beto's job",
        goal: "Fix it",
        executor: "agent",
        runnerId: t.fake.runnerId,
        commandPolicy: "never",
      });
      await server.deps.db.update(assignments).set({ status: "active" }).where(eq(assignments.id, row.id));
      const job = await (await run(t, row.threadId)).call("start_job", { title: "Fix", prompt: "Fix it" });
      expect(job.isError).toBe(true);
      expect(job.content).toContain("plan is personal");
      expect(requests(t.fake.runner, "job.start")).toEqual([]);
      expect(
        await server.deps.db.select().from(runnerJobs).where(eq(runnerJobs.assignmentId, row.id)),
      ).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "environment_status answers from the runner it checked, even if the agent is lent another right after the check",
    async () => {
      const t = await team();
      // Beto may use Lia's runner (he paired it); the other one, Ana's, he may not.
      await server.deps.db
        .update(runners)
        .set({ pairedByUserId: t.beto.user.id, workDir: "/fixture/beto-folder" })
        .where(eq(runners.id, t.fake.runnerId));
      const other = await pairFake(server, t.ana, t.workspaceId, { open });
      await server.deps.db
        .update(runners)
        .set({ workDir: "/fixture/private-folder" })
        .where(eq(runners.id, other.runnerId));
      // The run's access check (the second one: the plan has its own) reads the members; right after it, Lia is
      // lent the other runner.
      let checks = 0;
      const swapAfterRunCheck = async () => {
        if (++checks !== 2) return;
        await server.deps.db
          .update(agents)
          .set({ environmentId: other.runnerId })
          .where(eq(agents.id, t.lia.id));
      };
      const db = new Proxy(server.deps.db, {
        get(target, prop) {
          if (prop !== "select") return Reflect.get(target, prop, target);
          return (...args: Parameters<typeof target.select>) => {
            const query = target.select(...args);
            return new Proxy(query, {
              get(q, key) {
                if (key !== "from") return Reflect.get(q, key, q);
                return (table: unknown) => {
                  const from = (q.from as (t: unknown) => ReturnType<typeof q.from>)(table);
                  if (table !== schema.members) return from;
                  return new Proxy(from, {
                    get(f, k) {
                      if (k !== "where") return Reflect.get(f, k, f);
                      return (...w: unknown[]) => {
                        const rows = (f.where as (...a: unknown[]) => Promise<unknown>)(...w);
                        return {
                          // biome-ignore lint/suspicious/noThenProperty: a thenable that stands for the query
                          then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
                            rows
                              .then(async (v) => {
                                await swapAfterRunCheck();
                                return v;
                              })
                              .then(ok, ko),
                        };
                      };
                    },
                  });
                };
              },
            });
          };
        },
      });
      const r = await run(t, null, t.beto);
      const out = await r.call("environment_status", {}, { deps: { ...server.deps, db } });
      expect(checks).toBe(2);
      expect(out.isError).toBe(false);
      expect(out.content).toContain("/fixture/beto-folder");
      expect(out.content).not.toContain("/fixture/private-folder");
    },
    SERVER_TEST_MS,
  );

  test(
    "a browser action planned on one runner isn't sent to the runner the agent was lent before it runs",
    async () => {
      const t = await team(undefined, true);
      const other = await pairFake(server, t.ana, t.workspaceId, { browser: true, open });
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.lia.id));
      const tools = await environmentToolsFor({ deps: server.deps, agent: agent as typeof t.lia });
      const ctx = (
        await toolRun(server, {
          workspaceId: t.workspaceId,
          agent: agent as typeof t.lia,
          channelId: t.general,
          asker: t.ana,
        })
      ).ctx();
      const calls: [string, Record<string, unknown>][] = [
        ["browser_navigate", { url: "https://shop.example/checkout" }],
        ["browser_click", { target: "#pay" }],
        ["browser_back", {}],
      ];
      for (const [name, input] of calls) {
        const tool = tools.find((x) => x.name === name);
        if (!tool?.plan) throw new Error(`no ${name}`);
        await server.deps.db
          .update(agents)
          .set({ environmentId: t.fake.runnerId })
          .where(eq(agents.id, t.lia.id));
        await tool.plan(ctx, input);
        await server.deps.db
          .update(agents)
          .set({ environmentId: other.runnerId })
          .where(eq(agents.id, t.lia.id));
        await expect(tool.run(ctx, input)).rejects.toThrow("changed since this action was planned");
      }
      for (const runner of [t.fake.runner, other.runner]) {
        expect(requests(runner, "browser.open")).toEqual([]);
        expect(requests(runner, "browser.act")).toEqual([]);
      }
    },
    SERVER_TEST_MS,
  );
});
