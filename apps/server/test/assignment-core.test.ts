// The assignment core (assignments/core.ts), its proofs (assignments/proofs.ts) and the verifier's entry
// (assignments/verify.ts), on the rows the assignment routes (S5) will write: who sees and acts on an
// assignment, its API shape, the status change that only one click wins, the thread's view of it, the
// messages it posts, and the proofs a submission carries. A person's message reaches the agent through the
// runtime (S6): until then it is rejected before anything is written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import {
  type AssignmentRow,
  agentSays,
  assignmentFor,
  moveAssignment,
  personSays,
  roleOf,
  toAssignment,
  visibleAssignments,
  waitingFor,
} from "../src/assignments/core";
import { type PlanItemRow, writePlan } from "../src/assignments/plan";
import {
  addJobProofs,
  addProofs,
  clip,
  PROOF_TEXT_MAX,
  type ProofInput,
  proofInput,
  proofsOf,
} from "../src/assignments/proofs";
import { modelVerifier } from "../src/assignments/verify";
import { channelInWorkspace } from "../src/channels";
import type { WorkspaceMember } from "../src/context";
import { ensureThread, postMessage } from "../src/messages";
import type { RealtimeEvent } from "../src/realtime/hub";
import type { RunningServer } from "../src/server";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@assignment-core.test`;

/** Ana owns the workspace and the assignment; Beto decides in it; Caio is a member; Dora is an admin. */
async function team(opts: { visibility?: "public" | "private" } = {}) {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const dora = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
  const channelId = await seedChannel(server, workspaceId, {
    name: `work${n}`,
    visibility: opts.visibility ?? "public",
    members: [ana, beto],
  });
  const { db } = server.deps;
  const agentId = newId("agt");
  const handle = `lia${n}`;
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Lia",
    handle,
    model: "claude-haiku-5-5",
    ownerUserId: ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  await db.insert(schema.channelMemberships).values({ channelId, memberType: "agent", memberId: agentId });
  const channel = await channelInWorkspace(db, workspaceId, channelId);
  if (!channel) throw new Error("no channel");
  const { message: root } = await postMessage(server.deps, {
    workspaceId,
    channel,
    author: { type: "agent", id: agentId },
    body: "Plan: ship the site",
    clientId: null,
  });
  const id = newId("asg");
  const [row] = await db
    .insert(schema.assignments)
    .values({
      id,
      workspaceId,
      title: "Ship the site",
      goal: "The site is live",
      agentId,
      channelId,
      threadId: root.id,
      ownerId: ana.user.id,
    })
    .returning();
  if (!row) throw new Error("no assignment");
  await db.insert(schema.threads).values({
    id: root.id,
    workspaceId,
    channelId,
    createdByType: "agent",
    createdById: agentId,
    lastTouchedAt: new Date(),
  });
  await db
    .insert(schema.assignmentParticipants)
    .values({ assignmentId: id, userId: beto.user.id, role: "decide" });
  const member = (p: Person, role: WorkspaceMember["role"] = "member"): WorkspaceMember => ({
    workspaceId,
    userId: p.user.id,
    role,
    handle: "",
  });
  return { workspaceId, channelId, agentId, handle, root, row, ana, beto, caio, dora, member };
}

const reload = async (row: AssignmentRow) => {
  const [next] = await server.deps.db
    .select()
    .from(schema.assignments)
    .where(eq(schema.assignments.id, row.id));
  if (!next) throw new Error("gone");
  return next;
};
const messagesIn = (channelId: string) =>
  server.deps.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));

describe("who sees and acts on an assignment", () => {
  test(
    "the thread counts the current plan and excludes dropped items",
    async () => {
      const t = await team();
      await writePlan(server.deps, t.row.id, {
        author: { type: "agent", id: t.agentId },
        mode: "agent",
        items: [
          { id: "done", title: "Shipped", status: "done" },
          { id: "todo", title: "Next", status: "todo" },
          { id: "dropped", title: "Removed" },
        ],
      });
      await writePlan(server.deps, t.row.id, {
        author: { type: "agent", id: t.agentId },
        mode: "agent",
        items: [
          { id: "done", title: "Shipped" },
          { id: "todo", title: "Next" },
        ],
      });
      const assignment = await assignmentFor(server.deps, await reload(t.row), t.member(t.ana));
      expect(assignment.plan).toMatchObject({ done: 1, total: 2 });
      const res = await t.ana.browser.fetch(`/api/v1/workspaces/${t.workspaceId}/threads/${t.root.id}`);
      expect(res.status).toBe(200);
      expect((await body(res)).assignment).toMatchObject({ stepsDone: 1, stepsTotal: 2 });
    },
    SERVER_TEST_MS,
  );

  test(
    "action-needed filtering matches assignment waits and owner restrictions before pagination",
    async () => {
      const t = await team();
      const { db } = server.deps;
      const channel = await channelInWorkspace(db, t.workspaceId, t.channelId);
      if (!channel) throw new Error("no channel");
      for (let i = 0; i < 2; i++) {
        const { message } = await postMessage(server.deps, {
          workspaceId: t.workspaceId,
          channel,
          author: { type: "agent", id: t.agentId },
          body: "Nothing pending",
          clientId: null,
        });
        const [root] = await db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
        if (!root) throw new Error("no root");
        await ensureThread(db, {
          root,
          by: { type: "agent", id: t.agentId },
          at: new Date("2030-01-01T00:00:00Z"),
          title: "Quiet",
        });
      }
      const actor = { type: "agent", id: t.agentId } satisfies schema.AssignmentActor;
      await db.insert(schema.assignmentPlanItems).values({
        assignmentId: t.row.id,
        id: "item",
        ord: 0,
        title: "Work",
        createdBy: actor,
        updatedBy: actor,
      });
      await db.insert(schema.assignmentJoinRequests).values({
        assignmentId: t.row.id,
        userId: t.caio.user.id,
        status: "declined",
      });
      const cases: {
        assignment?: Partial<AssignmentRow>;
        item?: Partial<PlanItemRow>;
        join?: boolean;
        owner: boolean;
        decider: boolean;
      }[] = [
        { assignment: { status: "paused", ceiling: "usd" }, owner: true, decider: false },
        { join: true, owner: true, decider: false },
        { item: { status: "blocked_on_you" }, owner: true, decider: true },
        { item: { turns: 4 }, owner: true, decider: true },
        { item: { status: "done", checks: 3 }, owner: true, decider: true },
        { item: { status: "done", checks: 3, passes: false }, owner: true, decider: true },
        { item: { turns: 3, checks: 3 }, owner: false, decider: false },
        { item: { status: "done", turns: 4, checks: 2 }, owner: false, decider: false },
        { item: { status: "done", checks: 3, passes: true }, owner: false, decider: false },
        { item: { status: "done", checks: 3, kind: "fix" }, owner: false, decider: false },
        { item: { status: "dropped", turns: 4, checks: 3 }, owner: false, decider: false },
        { assignment: { status: "done" }, item: { turns: 4 }, join: true, owner: false, decider: false },
        { assignment: { status: "canceled" }, item: { turns: 4 }, join: true, owner: false, decider: false },
      ];
      const path = `/api/v1/workspaces/${t.workspaceId}/threads`;
      for (const c of cases) {
        await db
          .update(schema.assignments)
          .set({ status: "active", ceiling: null, ...c.assignment })
          .where(eq(schema.assignments.id, t.row.id));
        await db
          .update(schema.assignmentPlanItems)
          .set({ status: "todo", turns: 0, checks: 0, passes: null, kind: "work", ...c.item })
          .where(eq(schema.assignmentPlanItems.assignmentId, t.row.id));
        await db
          .update(schema.assignmentJoinRequests)
          .set({ status: c.join ? "pending" : "declined" })
          .where(eq(schema.assignmentJoinRequests.assignmentId, t.row.id));
        const row = await reload(t.row);
        for (const [who, expected] of [
          [t.ana, c.owner],
          [t.beto, c.decider],
          [t.caio, false],
        ] as const) {
          expect(await waitingFor(db, t.member(who), row)).toBe(expected);
          const detail = await who.browser.fetch(`${path}/${t.root.id}`);
          expect(detail.status).toBe(200);
          expect(await body(detail)).toMatchObject({
            actionNeeded: expected,
            assignment: { blockedOnYou: expected },
          });
          const filtered = await who.browser.fetch(`${path}?actionNeeded=true&limit=1`);
          expect(filtered.status).toBe(200);
          const page = await body(filtered);
          expect(page.threads.map((thread: { id: string }) => thread.id)).toEqual(
            expected ? [t.root.id] : [],
          );
          expect(page.nextCursor).toBeNull();
        }
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "the owner, a participant who decides, a reader of the public channel; a private channel hides it",
    async () => {
      const t = await team();
      const { db } = server.deps;
      expect(await roleOf(db, t.member(t.ana), t.row)).toBe("owner");
      expect(await roleOf(db, t.member(t.beto), t.row)).toBe("decide");
      expect(await roleOf(db, t.member(t.caio), t.row)).toBe("view");

      const hidden = await team({ visibility: "private" });
      expect(await roleOf(db, hidden.member(hidden.caio), hidden.row)).toBeNull();
      expect(await visibleAssignments(server.deps, hidden.member(hidden.caio), {})).toEqual([]);
      expect(
        (await visibleAssignments(server.deps, hidden.member(hidden.beto), {})).map((r) => r.id),
      ).toEqual([hidden.row.id]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the API shape: actionable for who decides, manageable for the owner and an admin, the dollar cap as `usd`",
    async () => {
      const t = await team();
      const owner = await assignmentFor(server.deps, t.row, t.member(t.ana, "owner"));
      expect(owner).toMatchObject({ role: "owner", actionable: true, manageable: true, status: "proposed" });
      const decider = await assignmentFor(server.deps, t.row, t.member(t.beto));
      expect(decider).toMatchObject({ role: "decide", actionable: true, manageable: false });
      const reader = await assignmentFor(server.deps, t.row, t.member(t.caio));
      expect(reader).toMatchObject({
        role: "view",
        actionable: false,
        manageable: false,
        pendingJoin: false,
      });
      expect((await assignmentFor(server.deps, t.row, t.member(t.dora, "admin"))).manageable).toBe(true);
      expect((await toAssignment(server.deps, t.row, t.member(t.dora, "admin"))).manageable).toBe(false);

      await server.deps.db
        .update(schema.assignments)
        .set({ status: "paused", ceiling: "usd" })
        .where(eq(schema.assignments.id, t.row.id));
      const paused = await toAssignment(server.deps, await reload(t.row), t.member(t.ana));
      expect(paused).toMatchObject({ ceiling: "usd", state: "blocked_on_you" });
    },
    SERVER_TEST_MS,
  );

  test(
    "something pending waits on who decides, not on a reader; the thread shows it to whoever it waits on",
    async () => {
      const t = await team();
      const { db } = server.deps;
      await db
        .update(schema.assignments)
        .set({ status: "active" })
        .where(eq(schema.assignments.id, t.row.id));
      const row = await reload(t.row);
      expect(await waitingFor(db, t.member(t.ana), row)).toBe(false);
      await db.insert(schema.assignmentDecisions).values({
        id: newId("adec"),
        assignmentId: row.id,
        question: "Which host?",
        options: ["A", "B"],
        status: "pending",
      });
      expect(await waitingFor(db, t.member(t.ana), row)).toBe(true);
      expect(await waitingFor(db, t.member(t.beto), row)).toBe(true);
      expect(await waitingFor(db, t.member(t.caio), row)).toBe(false);

      const thread = async (who: Person, query = "") => {
        const res = await who.browser.fetch(`/api/v1/workspaces/${t.workspaceId}/threads${query}`);
        expect(res.status).toBe(200);
        return (
          (await body(res)).threads as { id: string; actionNeeded: boolean; assignment: unknown }[]
        ).find((x) => x.id === t.root.id);
      };
      expect(await thread(t.beto, "?tab=assignments")).toMatchObject({
        actionNeeded: true,
        assignment: {
          assignmentId: row.id,
          agentId: t.agentId,
          role: "decide",
          status: "active",
          blockedOnYou: true,
          stepsDone: 0,
          stepsTotal: 0,
        },
      });
      expect(await thread(t.beto, "?actionNeeded=true")).toBeDefined();
      expect(await thread(t.caio)).toMatchObject({
        actionNeeded: false,
        assignment: { role: "view", blockedOnYou: false },
      });
      expect(await thread(t.caio, "?actionNeeded=true")).toBeUndefined();
    },
    SERVER_TEST_MS,
  );
});

describe("changing an assignment", () => {
  test(
    "N status changes from the same status at once: one wins and only it tells the channel",
    async () => {
      const t = await team();
      const events: RealtimeEvent[] = [];
      const off = server.deps.hub.onPublish((_, e) => {
        if (e.type === "assignment.updated") events.push(e);
      });
      try {
        const moved = await Promise.all(
          Array.from({ length: 8 }, () =>
            moveAssignment(
              server.deps,
              t.row,
              ["proposed"],
              { status: "active", startedAt: new Date() },
              "status",
            ),
          ),
        );
        expect(moved.filter((m) => m !== null)).toHaveLength(1);
        expect(events).toEqual([
          {
            type: "assignment.updated",
            assignmentId: t.row.id,
            threadId: t.root.id,
            channelId: t.channelId,
            change: "status",
          },
        ]);
      } finally {
        off();
      }
    },
    SERVER_TEST_MS,
  );

  test(
    "a person's message waits for the runtime: rejected before anything is written",
    async () => {
      const t = await team();
      const before = await messagesIn(t.channelId);
      const err = await personSays(server.deps, t.row, t.ana.user.id, "start").catch((e) => e);
      expect(err).toMatchObject({
        status: 503,
        code: "not_available",
        params: { method: "onPersonMessage" },
      });
      expect(await messagesIn(t.channelId)).toHaveLength(before.length);
      const [root] = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, t.root.id));
      expect(root?.replyCount).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "the agent's message goes into the assignment's thread as the agent",
    async () => {
      const t = await team();
      const message = await agentSays(server.deps, t.row, "Decision needed", { decisionId: "adec_x" });
      expect(message).toMatchObject({
        author: { type: "agent", id: t.agentId },
        threadId: t.root.id,
        body: "Decision needed",
        meta: { decisionId: "adec_x" },
      });
      expect(message.clientId?.startsWith("am_")).toBe(true);
      const [root] = await server.deps.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, t.root.id));
      expect(root?.replyCount).toBe(1);
    },
    SERVER_TEST_MS,
  );
});

describe("proofs", () => {
  test("what each kind of proof needs, and a preview only over http(s)", () => {
    const parse = (p: unknown) => proofInput.safeParse(p).success;
    expect(parse({ kind: "diff", title: "d", text: "+a" })).toBe(true);
    expect(parse({ kind: "diff", title: "d", text: "  " })).toBe(false);
    expect(parse({ kind: "test_log", title: "t" })).toBe(false);
    expect(parse({ kind: "preview", title: "p", url: "https://example.com/x" })).toBe(true);
    expect(parse({ kind: "preview", title: "p", url: "javascript:alert(1)" })).toBe(false);
    expect(parse({ kind: "preview", title: "p", url: "data:text/html,x" })).toBe(false);
    expect(parse({ kind: "preview", title: "p" })).toBe(false);
    expect(parse({ kind: "screenshot", title: "s" })).toBe(false);
    expect(parse({ kind: "screenshot", title: "s", fileId: "fil_1" })).toBe(true);
    expect(parse({ kind: "diff", title: "d", text: "x".repeat(PROOF_TEXT_MAX + 1) })).toBe(false);
  });

  test("a long text keeps its start and end, and fits the cap", () => {
    expect(clip("x".repeat(PROOF_TEXT_MAX))).toBe("x".repeat(PROOF_TEXT_MAX));
    const long = `${"a".repeat(PROOF_TEXT_MAX)}${"z".repeat(10)}`;
    const cut = clip(long);
    expect(cut.length).toBeLessThanOrEqual(PROOF_TEXT_MAX);
    expect(cut.startsWith("aaaa")).toBe(true);
    expect(cut.endsWith("zzzzzzzzzz")).toBe(true);
    expect(cut).toContain("chars cut");
  });

  test(
    "a screenshot must be a file the assignment's readers see; another channel's file is rejected",
    async () => {
      const t = await team();
      const other = await seedChannel(server, t.workspaceId, { name: `other${n}`, members: [t.ana] });
      const { db } = server.deps;
      const by = { type: "person" as const, id: t.ana.user.id };
      const file = async (channelId: string | null) => {
        const id = newId("fil");
        await db.insert(schema.files).values({
          id,
          workspaceId: t.workspaceId,
          title: "shot",
          kind: "file",
          createdBy: by,
          updatedBy: by,
          channelId,
        });
        return id;
      };
      await db
        .insert(schema.channelMemberships)
        .values({ channelId: other, memberType: "agent", memberId: t.agentId });
      const shared = await file(null);
      const here = await file(t.channelId);
      const elsewhere = await file(other);
      const add = (fileId: string) =>
        addProofs(server.deps, t.row, {
          itemId: null,
          by: { type: "agent", id: t.agentId },
          proofs: [{ kind: "screenshot", title: "shot", fileId }],
        });
      expect(await add(shared)).toHaveLength(1);
      expect(await add(here)).toHaveLength(1);
      expect(await add(elsewhere).catch((e) => e)).toMatchObject({
        status: 400,
        code: "assignment.proof_file",
      });
      expect(await add("fil_missing").catch((e) => e)).toMatchObject({
        status: 400,
        code: "assignment.proof_file",
      });
      expect((await proofsOf(server.deps, t.row.id)).map((p) => p.fileId).sort()).toEqual(
        [shared, here].sort(),
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "a batch with one bad proof, wherever it sits, is rejected whole: no proof of it is saved",
    async () => {
      const t = await team();
      const bad = { kind: "screenshot" as const, title: "bad", fileId: "fil_missing" };
      const good = [
        { kind: "diff" as const, title: "diff", text: "+ok" },
        { kind: "preview" as const, title: "site", url: "https://example.com" },
      ];
      for (const at of [0, 1, 2]) {
        const proofs: ProofInput[] = [...good];
        proofs.splice(at, 0, bad);
        const err = await addProofs(server.deps, t.row, {
          itemId: `s${at}`,
          by: { type: "agent", id: t.agentId },
          proofs,
        }).catch((e) => e);
        expect(err).toMatchObject({ status: 400, code: "assignment.proof_file" });
      }
      expect(await proofsOf(server.deps, t.row.id)).toEqual([]);
      const saved = await addProofs(server.deps, t.row, {
        itemId: "s9",
        by: { type: "agent", id: t.agentId },
        proofs: good,
      });
      expect(saved.map((p) => p.kind).sort()).toEqual(["diff", "preview"]);
      expect(
        await addProofs(server.deps, t.row, {
          itemId: "s9",
          by: { type: "agent", id: t.agentId },
          proofs: [],
        }),
      ).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a job's end that arrives twice doesn't duplicate its proofs",
    async () => {
      const t = await team();
      const job = { id: "aj_1", itemId: "s1", files: ["a.ts", "b.ts"], diff: "+x", agentId: t.agentId };
      await addJobProofs(server.deps, t.row.id, job);
      await addJobProofs(server.deps, t.row.id, job);
      const rows = await proofsOf(server.deps, t.row.id, "s1");
      expect(rows.map((r) => [r.id, r.kind, r.body])).toEqual([
        ["apf_aj_1_files", "files", "a.ts\nb.ts"],
        ["apf_aj_1_diff", "diff", "+x"],
      ]);
      const none = await server.deps.db
        .select()
        .from(schema.assignmentProofs)
        .where(
          and(
            eq(schema.assignmentProofs.assignmentId, t.row.id),
            eq(schema.assignmentProofs.itemId, "other"),
          ),
        );
      expect(none).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("the verifier's entry", () => {
  test(
    "items without any evidence fail without a model call; with evidence the call goes to the runtime",
    async () => {
      const t = await team();
      const item = (id: string, summary: string | null) => ({
        item: { id, title: id, criteria: "works", summary, kind: "work" as const, fixes: null },
        proofs: [],
        results: [],
      });
      expect(await modelVerifier(server.deps, t.row, [item("s1", null), item("s2", "  ")])).toEqual({
        ok: true,
        runId: null,
        verdicts: [
          { id: "s1", passes: false, reason: "No evidence: no summary, job result or proof." },
          { id: "s2", passes: false, reason: "No evidence: no summary, job result or proof." },
        ],
      });
      // `complete` is the runtime's (S6): today it answers not_available.
      expect(await modelVerifier(server.deps, t.row, [item("s1", "done it")]).catch((e) => e)).toMatchObject({
        code: "not_available",
        params: { method: "complete" },
      });
    },
    SERVER_TEST_MS,
  );
});
