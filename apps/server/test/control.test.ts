// The control center over raw HTTP: approvals, "always allow" rules, proposals, questions and undo. The rows a run
// writes (an approval, a proposal, a question, the receipt of an action) come from the agent runtime (S6) and its
// tools; here the test writes the same rows the tools write, and everything after that goes through the routes.
// Deciding an approval, editing it and answering a question wake the waiting run: until the runtime is there those
// routes refuse with `not_available`, and the tests prove that nothing was written. The clock is injected.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import { DECISION_TTL_MS, recordDecision, trailEntry, UNDO_WINDOW_MS } from "../src/control";
import { columnsOf, createIssue, issueById, updateIssue } from "../src/issues";
import { postMessage } from "../src/messages";
import type { RunningServer } from "../src/server";
import { createPage, savePage } from "../src/wiki";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let clock = new Date("2026-11-14T12:00:00Z");
let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer({ now: () => clock });
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

const {
  approvals,
  proposals,
  questions,
  reversibleActions,
  agents,
  reminders,
  messages,
  memories,
  workspaces,
} = schema;
let n = 0;
const email = (who: string) => `${who}${++n}@control.test`;

/**
 * Ana owns the workspace (an admin), Beto owns the agent, Carla is a plain member. #secret is private, with Beto
 * only. Dora owns another workspace.
 */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Control");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const carla = await memberOf(server, workspaceId, "Carla", email("carla"));
  const agentId = newId("agt");
  await server.deps.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: "Lia",
    handle: `lia${n}`,
    model: "claude-haiku-5-5",
    ownerUserId: beto.user.id,
    instructions: "Be brief.",
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  const secret = await seedChannel(server, workspaceId, {
    name: `secret${n}`,
    visibility: "private",
    members: [beto],
  });
  const dora = await signedIn(server, "Dora", email("dora"));
  const other = await seedWorkspace(server, dora, "Other");
  const url = (path: string) => `/api/v1/workspaces/${workspaceId}${path}`;
  return { workspaceId, general, secret, ana, beto, carla, dora, other, agentId, url };
}
type Team = Awaited<ReturnType<typeof team>>;

async function seedApproval(t: Team, over: Partial<typeof approvals.$inferInsert> = {}) {
  const [row] = await server.deps.db
    .insert(approvals)
    .values({
      id: newId("apv"),
      workspaceId: t.workspaceId,
      agentId: t.agentId,
      channelId: t.general,
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
      requesterUserId: t.carla.user.id,
      expiresAt: new Date(clock.getTime() + DECISION_TTL_MS),
      trail: [trailEntry(clock, "requested", "Lia asked")],
      ...over,
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

const approvalOf = async (id: string) => {
  const [row] = await server.deps.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error("no approval");
  return row;
};

async function seedProposal(t: Team, over: Partial<typeof proposals.$inferInsert> = {}) {
  const [row] = await server.deps.db
    .insert(proposals)
    .values({
      id: newId("prp"),
      workspaceId: t.workspaceId,
      agentId: t.agentId,
      targetKind: "agent_prompt",
      recipientAgentId: t.agentId,
      title: "Answer in bullet points",
      before: "Be brief.",
      after: "Be brief. Use bullet points.",
      why: "People asked for lists",
      channelId: t.general,
      ...over,
    })
    .returning();
  if (!row) throw new Error("no proposal");
  return row;
}

async function seedAction(
  t: Team,
  kind: string,
  target: { type: string; id: string; title?: string },
  over: Partial<typeof reversibleActions.$inferInsert> = {},
) {
  const [row] = await server.deps.db
    .insert(reversibleActions)
    .values({
      id: newId("act"),
      workspaceId: t.workspaceId,
      agentId: t.agentId,
      requesterUserId: t.carla.user.id,
      kind,
      target,
      revertibleUntil: new Date(clock.getTime() + UNDO_WINDOW_MS),
      ...over,
    })
    .returning();
  if (!row) throw new Error("no action");
  return row;
}

/** The agent's answer in #general, where the receipt of its actions shows. */
async function agentReply(t: Team, text = "Done.") {
  const channel = await channelInWorkspace(server.deps.db, t.workspaceId, t.general);
  if (!channel) throw new Error("no channel");
  const { message } = await postMessage(server.deps, {
    workspaceId: t.workspaceId,
    channel,
    author: { type: "agent", id: t.agentId },
    body: text,
    clientId: null,
  });
  return message;
}

const code = async (res: Response) => (await body(res)).error?.code;

describe("approvals", () => {
  test(
    "the list and the card: who decides, who sees a private conversation's request, the filter, other workspaces",
    async () => {
      const t = await team();
      const open = await seedApproval(t);
      const hidden = await seedApproval(t, { channelId: t.secret, title: "Post in #secret" });
      const done = await seedApproval(t, { status: "rejected", decidedAt: clock });
      const foreign = await seedApproval(t, { channelId: null });
      await server.deps.db
        .update(approvals)
        .set({ workspaceId: t.other.workspaceId })
        .where(eq(approvals.id, foreign.id));

      // The agent's owner decides and sees everything of their agent.
      const mine = await body(await t.beto.browser.fetch(t.url("/approvals")));
      const byId = new Map(mine.approvals.map((a: { id: string }) => [a.id, a]));
      expect(byId.get(open.id)).toMatchObject({
        decidable: true,
        ownerUserId: t.beto.user.id,
        status: "pending",
      });
      expect(byId.get(hidden.id)).toMatchObject({ decidable: true });
      expect(byId.get(done.id)).toMatchObject({ decidable: false, status: "rejected" });
      expect(byId.has(foreign.id)).toBe(false);

      // A member who doesn't decide sees the card of #general, not the one of a channel they don't read.
      const carla = await body(await t.carla.browser.fetch(t.url("/approvals")));
      const seen = carla.approvals.map((a: { id: string; decidable: boolean }) => [a.id, a.decidable]);
      expect(seen).toContainEqual([open.id, false]);
      expect(seen.map((s: [string, boolean]) => s[0])).not.toContain(hidden.id);
      expect((await t.carla.browser.fetch(t.url(`/approvals/${hidden.id}`))).status).toBe(404);
      expect((await t.carla.browser.fetch(t.url(`/approvals/${open.id}`))).status).toBe(200);
      // The owner of the workspace isn't the agent's owner: no decision while Beto is a member.
      const ana = await body(await t.ana.browser.fetch(t.url(`/approvals/${open.id}`)));
      expect(ana.decidable).toBe(false);

      const pending = await body(await t.beto.browser.fetch(t.url("/approvals?status=pending")));
      expect(pending.approvals.map((a: { status: string }) => a.status)).not.toContain("rejected");
      const decided = await body(await t.beto.browser.fetch(t.url("/approvals?status=decided")));
      expect(decided.approvals.map((a: { id: string }) => a.id)).toEqual([done.id]);
      expect((await t.beto.browser.fetch(t.url("/approvals?status=maybe"))).status).toBe(400);

      // Another workspace's approval through this workspace, and this workspace by an outsider: 404.
      expect((await t.beto.browser.fetch(t.url(`/approvals/${foreign.id}`))).status).toBe(404);
      expect((await t.dora.browser.fetch(t.url("/approvals"))).status).toBe(404);
    },
    SERVER_TEST_MS,
  );

  test(
    "approve, reject and edit: who may, the hash, remembering and the runtime; nothing is written before the runtime",
    async () => {
      const t = await team();
      const row = await seedApproval(t);
      const approve = (who: Person, json: unknown, id = row.id) =>
        who.browser.json(t.url(`/approvals/${id}/approve`), "POST", json);

      // Only the agent's owner decides: a member, and the workspace's owner while Beto is still a member.
      expect(await code(await approve(t.carla, { payloadHash: "hash-1" }))).toBe("forbidden");
      expect(await code(await approve(t.ana, { payloadHash: "hash-1" }))).toBe("forbidden");
      expect((await t.carla.browser.json(t.url(`/approvals/${row.id}/reject`), "POST", {})).status).toBe(403);
      expect((await t.dora.browser.json(t.url(`/approvals/${row.id}/approve`), "POST", {})).status).toBe(404);
      // Approving needs the hash of what the person saw; rejecting doesn't.
      expect(await code(await approve(t.beto, {}))).toBe("approval.changed");
      expect(await code(await approve(t.beto, { payloadHash: "hash-0" }))).toBe("approval.changed");
      expect((await approve(t.beto, { payloadHash: 42 })).status).toBe(400);
      // "Approve and remember" never covers K3 nor a request the gate left without a predicate (a run that read
      // outside content, a request asked for risk).
      const k3 = await seedApproval(t, { effect: "K3" });
      expect(await code(await approve(t.beto, { payloadHash: "hash-1", remember: true }, k3.id))).toBe(
        "approval.not_rememberable",
      );
      const tainted = await seedApproval(t, { ruleKey: null, ruleLabel: null });
      expect(await code(await approve(t.beto, { payloadHash: "hash-1", remember: true }, tainted.id))).toBe(
        "approval.not_rememberable",
      );
      // The edit: only an approval with editable fields, with the hash of what the person saw.
      const fixed = await seedApproval(t, { editable: [] });
      const edit = (id: string, json: unknown) =>
        t.beto.browser.json(t.url(`/approvals/${id}/edit`), "POST", json);
      expect((await edit(fixed.id, { input: { body: "x" }, payloadHash: "hash-1" })).status).toBe(400);
      expect(await code(await edit(row.id, { input: { body: "x" }, payloadHash: "hash-0" }))).toBe(
        "approval.changed",
      );
      expect((await edit(row.id, { input: "x", payloadHash: "hash-1" })).status).toBe(400);

      // Everything right: the run that waits is the runtime's, which isn't there yet. Nothing is written.
      const before = await approvalOf(row.id);
      for (const res of [
        await approve(t.beto, { payloadHash: "hash-1", remember: true }),
        await t.beto.browser.json(t.url(`/approvals/${row.id}/reject`), "POST", { reason: "no" }),
        await edit(row.id, { input: { body: "Shorter" }, payloadHash: "hash-1" }),
      ]) {
        expect(res.status).toBe(503);
        expect(await code(res)).toBe("not_available");
      }
      expect(await approvalOf(row.id)).toEqual(before);
      const rules = await body(await t.beto.browser.fetch(t.url("/approval-rules")));
      expect(rules.rules).toEqual([]);

      // Already decided: the same answer to whoever decides again.
      const decided = await seedApproval(t, { status: "approved", decidedAt: clock });
      expect(await code(await approve(t.beto, { payloadHash: "hash-1" }, decided.id))).toBe(
        "approval.already_resolved",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "two decisions at once (two tabs, approve and reject) apply one; a decision about an older hash applies none",
    async () => {
      const t = await team();
      const row = await seedApproval(t);
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          recordDecision(server.deps.db, row, {
            status: i % 2 ? "rejected" : "approved",
            deciderUserId: t.beto.user.id,
            at: clock,
            reason: null,
            entries: [trailEntry(clock, i % 2 ? "rejected" : "approved", `decision ${i}`)],
          }),
        ),
      );
      const won = results.filter((r) => r !== null);
      expect(won.length).toBe(1);
      const after = await approvalOf(row.id);
      expect(after.status).toBe(won[0]?.status ?? "pending");
      // One trail entry beyond the request: the winner's.
      expect(after.trail.length).toBe(2);

      const stale = await seedApproval(t);
      await server.deps.db.update(approvals).set({ payloadHash: "hash-2" }).where(eq(approvals.id, stale.id));
      const late = await recordDecision(server.deps.db, stale, {
        status: "approved",
        deciderUserId: t.beto.user.id,
        at: clock,
        reason: null,
        entries: [],
      });
      expect(late).toBeNull();
      expect((await approvalOf(stale.id)).status).toBe("pending");
    },
    SERVER_TEST_MS,
  );

  test(
    "the gate's telemetry per class: only whoever sees the usage; the counts and the decision times",
    async () => {
      const t = await team();
      const asked = await seedApproval(t, {
        status: "approved",
        createdAt: new Date(clock.getTime() - 60_000),
        decidedAt: clock,
      });
      const refusedOne = await seedApproval(t, {
        status: "rejected",
        createdAt: new Date(clock.getTime() - 20_000),
        decidedAt: clock,
      });
      const decision = (over: Partial<typeof schema.gateDecisions.$inferInsert>) => ({
        id: newId("tdec"),
        workspaceId: t.workspaceId,
        agentId: t.agentId,
        tool: "send_email",
        effect: "K2" as const,
        decision: "ask" as const,
        createdAt: clock,
        ...over,
      });
      await server.deps.db
        .insert(schema.gateDecisions)
        .values([
          decision({ approvalId: asked.id }),
          decision({ approvalId: refusedOne.id }),
          decision({ decision: "allow" }),
          decision({ effect: "K3", decision: "deny" }),
          decision({ decision: "allow", createdAt: new Date(clock.getTime() - 40 * 86_400_000) }),
        ]);
      expect((await t.beto.browser.fetch(t.url("/approvals/stats"))).status).toBe(403);
      const stats = await body(await t.ana.browser.fetch(t.url("/approvals/stats")));
      const k2 = stats.byEffect.find((r: { effect: string }) => r.effect === "K2");
      expect(k2).toMatchObject({ calls: 3, auto: 1, asked: 2, approved: 1, rejected: 1, denied: 0 });
      expect(k2.p50Ms).toBe(40_000);
      expect(stats.byEffect.find((r: { effect: string }) => r.effect === "K3")).toMatchObject({
        calls: 1,
        denied: 1,
        p50Ms: null,
      });
      expect((await t.ana.browser.fetch(t.url("/approvals/stats?days=0"))).status).toBe(400);
      const wide = await body(await t.ana.browser.fetch(t.url("/approvals/stats?days=60")));
      expect(wide.byEffect.find((r: { effect: string }) => r.effect === "K2").calls).toBe(4);
    },
    SERVER_TEST_MS,
  );

  test(
    "the hub: the conversation's card goes undecidable, each decider gets their own, nobody else gets a copy",
    async () => {
      const t = await team();
      const row = await seedApproval(t, { channelId: t.secret });
      const { publishApproval } = await import("../src/control");
      const hub = server.deps.hub;
      const toChannel = hub.toChannel.bind(hub);
      const toUser = hub.toUser.bind(hub);
      const sent: { to: string; decidable: unknown }[] = [];
      // Only the approval's events (the decider's notice goes out on its own event).
      const decidableOf = (e: { type: string; approval?: unknown }) =>
        e.type.startsWith("approval.") && typeof e.approval === "object" && e.approval
          ? Reflect.get(e.approval, "decidable")
          : null;
      hub.toChannel = (channelId, event) => {
        const decidable = decidableOf(event);
        if (decidable !== null) sent.push({ to: `channel:${channelId}`, decidable });
        toChannel(channelId, event);
      };
      hub.toUser = (workspaceId, userId, event) => {
        const decidable = decidableOf(event);
        if (decidable !== null) sent.push({ to: `user:${userId}`, decidable });
        toUser(workspaceId, userId, event);
      };
      try {
        await publishApproval(server.deps, row, "approval.requested");
      } finally {
        hub.toChannel = toChannel;
        hub.toUser = toUser;
      }
      expect(sent).toEqual([
        { to: `channel:${t.secret}`, decidable: false },
        { to: `user:${t.beto.user.id}`, decidable: true },
      ]);
    },
    SERVER_TEST_MS,
  );
});

describe("always allow", () => {
  const rememberFor = async (t: Team, key: string, approvalId = newId("apv"), tool = "send_email") => {
    const { rememberRule } = await import("../src/standing-rules");
    return rememberRule(server.deps.db, {
      workspaceId: t.workspaceId,
      agentId: t.agentId,
      tool,
      key,
      label: `to ${key}`,
      approvalId,
      byUserId: t.beto.user.id,
      at: clock,
    });
  };

  test(
    "the rule matches only the exact predicate, counts each use, and stops at once when it expires or is revoked",
    async () => {
      const { matchRule, revokeRule } = await import("../src/standing-rules");
      const t = await team();
      const key = "mail|acct_1|ana@acme.test,bob@acme.test";
      const rule = await rememberFor(t, key);
      const match = (k: string, over: { tool?: string; agentId?: string; at?: Date } = {}) =>
        matchRule(server.deps.db, {
          workspaceId: t.workspaceId,
          agentId: over.agentId ?? t.agentId,
          tool: over.tool ?? "send_email",
          key: k,
          at: over.at ?? clock,
        });
      expect(await match(key)).toEqual({ id: rule.id });
      // A predicate that looks the same is another predicate.
      for (const near of [
        `${key} `,
        key.toUpperCase(),
        key.slice(0, -1),
        "mail|acct_1|ana@acme.test",
        `${key},eve@evil.test`,
      ])
        expect(await match(near)).toBeNull();
      expect(await match(key, { tool: "post_message" })).toBeNull();
      expect(await match(key, { agentId: newId("agt") })).toBeNull();
      const [counted] = await server.deps.db
        .select()
        .from(schema.approvalRules)
        .where(eq(schema.approvalRules.id, rule.id));
      expect(counted?.uses).toBe(1);
      // The index keeps the hash, never the predicate itself.
      expect(counted?.ruleKey).not.toContain("acme");

      // Remembering again renews the same rule for 30 more days.
      const renewed = await rememberFor(t, key);
      expect(renewed.id).toBe(rule.id);
      const thirtyDays = 30 * 24 * 3600_000;
      expect(await match(key, { at: new Date(clock.getTime() + thirtyDays - 1) })).toEqual({ id: rule.id });
      expect(await match(key, { at: new Date(clock.getTime() + thirtyDays) })).toBeNull();

      // Revoked: the very next call asks again.
      const me = { workspaceId: t.workspaceId, userId: t.beto.user.id, role: "member" as const, handle: "" };
      expect(await revokeRule(server.deps.db, me, rule.id, clock)).toBe("ok");
      expect(await match(key)).toBeNull();
      // Remembering after a revoke makes a new rule; the revoked one stays revoked.
      const again = await rememberFor(t, key);
      expect(again.id).not.toBe(rule.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "the list and the revoke: only whoever answers for the agent (or manages agents); twice is not found",
    async () => {
      const t = await team();
      const rule = await rememberFor(t, "post|#sales");
      const ids = async (who: Person, query = "") =>
        (await body(await who.browser.fetch(t.url(`/approval-rules${query}`)))).rules.map(
          (r: { id: string }) => r.id,
        );
      expect(await ids(t.beto)).toEqual([rule.id]);
      expect(await ids(t.ana)).toEqual([rule.id]);
      expect(await ids(t.carla)).toEqual([]);
      expect(await ids(t.beto, `?agentId=${newId("agt")}`)).toEqual([]);
      expect((await t.dora.browser.fetch(t.url("/approval-rules"))).status).toBe(404);

      const revoke = (who: Person) => who.browser.json(t.url(`/approval-rules/${rule.id}`), "DELETE");
      expect((await revoke(t.carla)).status).toBe(403);
      expect((await revoke(t.dora)).status).toBe(404);
      expect((await revoke(t.beto)).status).toBe(204);
      expect((await revoke(t.beto)).status).toBe(404);
      expect(await ids(t.beto)).toEqual([]);
      // A rule past its 30 days leaves the list.
      const old = await rememberFor(t, "post|#old");
      clock = new Date(clock.getTime() + 31 * 24 * 3600_000);
      expect(await ids(t.beto)).not.toContain(old.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "revoking at the same time as uses are counted, and revoking twice at once: one revoke, every use counted",
    async () => {
      const { matchRule, revokeRule } = await import("../src/standing-rules");
      const t = await team();
      const rule = await rememberFor(t, "cmd|ls -la");
      const me = { workspaceId: t.workspaceId, userId: t.beto.user.id, role: "member" as const, handle: "" };
      const q = {
        workspaceId: t.workspaceId,
        agentId: t.agentId,
        tool: "send_email",
        key: "cmd|ls -la",
        at: clock,
      };
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => matchRule(server.deps.db, q)),
        revokeRule(server.deps.db, me, rule.id, clock),
        revokeRule(server.deps.db, me, rule.id, clock),
        ...Array.from({ length: 6 }, () => matchRule(server.deps.db, q)),
      ]);
      const revokes = results.filter((r) => r === "ok" || r === "not_found");
      expect(revokes.sort()).toEqual(["not_found", "ok"]);
      const matched = results.filter((r) => typeof r === "object" && r !== null).length;
      const [row] = await server.deps.db
        .select()
        .from(schema.approvalRules)
        .where(eq(schema.approvalRules.id, rule.id));
      expect(row?.uses).toBe(matched);
      expect(row?.revokedAt).not.toBeNull();
      expect(await matchRule(server.deps.db, q)).toBeNull();
    },
    SERVER_TEST_MS,
  );
});

describe("proposals", () => {
  test(
    "instructions: who decides, accept with an edit, a stale proposal, rejecting becomes a lesson",
    async () => {
      const t = await team();
      const p = await seedProposal(t);
      const accept = (who: Person, json: unknown = {}, id = p.id) =>
        who.browser.json(t.url(`/proposals/${id}/accept`), "POST", json);

      // Carla neither owns the agent nor manages agents.
      const listed = await body(await t.carla.browser.fetch(t.url("/proposals")));
      expect(listed.proposals.find((x: { id: string }) => x.id === p.id)).toMatchObject({ decidable: false });
      expect((await accept(t.carla)).status).toBe(403);
      expect((await t.dora.browser.json(t.url(`/proposals/${p.id}/accept`), "POST", {})).status).toBe(404);

      // Beto accepts with an edit: the edited text is what the agent gets, with an undo.
      const accepted = await body(await accept(t.beto, { text: "Be brief. Use short bullet points." }));
      expect(accepted).toMatchObject({ status: "accepted", after: "Be brief. Use short bullet points." });
      expect(accepted.trail.at(-1)).toMatchObject({ code: "accepted", params: { edited: "true" } });
      expect(accepted.canUndo).toBe(true);
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.agentId));
      expect(agent?.instructions).toBe("Be brief. Use short bullet points.");
      expect(await code(await accept(t.beto))).toBe("proposal.decided");

      // The instructions changed after the proposal: it is stale and can't be accepted.
      const old = await seedProposal(t, { before: "Be brief.", after: "Be very brief." });
      expect(
        (await body(await t.beto.browser.fetch(t.url("/proposals")))).proposals.find(
          (x: { id: string }) => x.id === old.id,
        ),
      ).toMatchObject({ stale: true });
      expect(await code(await accept(t.beto, {}, old.id))).toBe("proposal.stale");

      // Rejecting: the agent learns not to propose it again.
      const rejected = await body(await t.beto.browser.json(t.url(`/proposals/${old.id}/reject`), "POST"));
      expect(rejected).toMatchObject({ status: "rejected", decidedBy: t.beto.user.id });
      const lessons = await server.deps.db
        .select()
        .from(memories)
        .where(and(eq(memories.agentId, t.agentId), eq(memories.kind, "lesson")));
      expect(lessons.map((m) => m.text)).toEqual([
        `Beto rejected the proposal "Answer in bullet points". Don't propose it again unless asked.`,
      ]);
      expect((await t.beto.browser.json(t.url(`/proposals/${old.id}/reject`), "POST")).status).toBe(409);
    },
    SERVER_TEST_MS,
  );

  test(
    "the workspace context: only whoever configures decides; a private channel's proposal is hidden from who can't read it",
    async () => {
      const t = await team();
      const ctx = await seedProposal(t, {
        targetKind: "workspace_context",
        recipientAgentId: null,
        before: "",
        after: "We sell boats.",
      });
      expect((await t.beto.browser.json(t.url(`/proposals/${ctx.id}/accept`), "POST")).status).toBe(403);
      expect((await t.ana.browser.json(t.url(`/proposals/${ctx.id}/accept`), "POST")).status).toBe(200);
      const [ws] = await server.deps.db.select().from(workspaces).where(eq(workspaces.id, t.workspaceId));
      expect(ws?.context).toBe("We sell boats.");

      const hidden = await seedProposal(t, { channelId: t.secret });
      const ids = async (who: Person) =>
        (await body(await who.browser.fetch(t.url("/proposals")))).proposals.map((x: { id: string }) => x.id);
      expect(await ids(t.carla)).not.toContain(hidden.id);
      expect(await ids(t.beto)).toContain(hidden.id);
      // Ana manages agents: she decides the agent's instructions even without reading #secret.
      expect(await ids(t.ana)).toContain(hidden.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "two decisions at once: accepting twice and accepting against rejecting apply one; undo and redo the accepted text",
    async () => {
      const t = await team();
      const p = await seedProposal(t);
      const results = await Promise.all([
        t.beto.browser.json(t.url(`/proposals/${p.id}/accept`), "POST"),
        t.beto.browser.json(t.url(`/proposals/${p.id}/accept`), "POST"),
        t.beto.browser.json(t.url(`/proposals/${p.id}/reject`), "POST"),
        t.ana.browser.json(t.url(`/proposals/${p.id}/reject`), "POST"),
      ]);
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBe(1);
      const [row] = await server.deps.db.select().from(proposals).where(eq(proposals.id, p.id));
      const [agent] = await server.deps.db.select().from(agents).where(eq(agents.id, t.agentId));
      const lessons = await server.deps.db
        .select()
        .from(memories)
        .where(and(eq(memories.agentId, t.agentId), eq(memories.kind, "lesson")));
      const actions = await server.deps.db
        .select()
        .from(reversibleActions)
        .where(eq(reversibleActions.kind, "proposal_applied"));
      const mine = actions.filter((a) => a.target.id === p.id);
      if (row?.status === "accepted") {
        expect(agent?.instructions).toBe(p.after);
        expect(mine.length).toBe(1);
        expect(lessons.length).toBe(0);
      } else {
        expect(row?.status).toBe("rejected");
        expect(agent?.instructions).toBe(p.before);
        expect(mine.length).toBe(0);
        expect(lessons.length).toBe(1);
      }

      // An accepted one comes with an undo: the text from before comes back, and redo puts the accepted one again.
      const q = await seedProposal(t, { before: agent?.instructions ?? "", after: "Answer in haiku." });
      const accepted = await body(await t.beto.browser.json(t.url(`/proposals/${q.id}/accept`), "POST"));
      const undone = await t.beto.browser.json(t.url(`/actions/${accepted.actionId}/undo`), "POST");
      expect(undone.status).toBe(200);
      const instructions = async () =>
        (await server.deps.db.select().from(agents).where(eq(agents.id, t.agentId)))[0]?.instructions;
      expect(await instructions()).toBe(q.before);
      expect(
        (await body(await t.beto.browser.fetch(t.url("/proposals")))).proposals.find(
          (x: { id: string }) => x.id === q.id,
        ),
      ).toMatchObject({ undone: true });
      expect((await t.beto.browser.json(t.url(`/actions/${accepted.actionId}/redo`), "POST")).status).toBe(
        200,
      );
      expect(await instructions()).toBe("Answer in haiku.");
    },
    SERVER_TEST_MS,
  );
});

describe("questions", () => {
  test(
    "only the person asked answers, from the choices, while open; a right answer waits for the runtime and writes nothing",
    async () => {
      const t = await team();
      const seedQuestion = async (over: Partial<typeof questions.$inferInsert> = {}) => {
        const [row] = await server.deps.db
          .insert(questions)
          .values({
            id: newId("q"),
            workspaceId: t.workspaceId,
            agentId: t.agentId,
            channelId: t.general,
            askedUserId: t.carla.user.id,
            text: "Which report?",
            choices: ["Monthly", "Weekly"],
            ...over,
          })
          .returning();
        if (!row) throw new Error("no question");
        return row;
      };
      const q = await seedQuestion();
      const answer = (who: Person, json: unknown, id = q.id) =>
        who.browser.json(t.url(`/questions/${id}/answer`), "POST", json);
      expect((await answer(t.beto, { choice: "Monthly" })).status).toBe(403);
      expect((await answer(t.dora, { choice: "Monthly" })).status).toBe(404);
      expect((await answer(t.carla, { choice: "Daily" })).status).toBe(400);
      expect((await answer(t.carla, {})).status).toBe(400);
      expect((await answer(t.carla, { text: "" })).status).toBe(400);
      const closed = await seedQuestion({ status: "answered", answer: "Weekly" });
      expect(await code(await answer(t.carla, { choice: "Monthly" }, closed.id))).toBe("question.closed");
      // A question in a channel the person doesn't read.
      const hidden = await seedQuestion({ channelId: t.secret });
      expect((await answer(t.carla, { choice: "Monthly" }, hidden.id)).status).toBe(404);

      const res = await answer(t.carla, { choice: "Monthly" });
      expect(res.status).toBe(503);
      expect(await code(res)).toBe("not_available");
      const [after] = await server.deps.db.select().from(questions).where(eq(questions.id, q.id));
      expect(after).toMatchObject({ status: "open", answer: null, responderUserId: null });
    },
    SERVER_TEST_MS,
  );
});

describe("undo", () => {
  test(
    "a posted message: undo retracts, redo brings it back; who may; twice; undo all; the deadline",
    async () => {
      const t = await team();
      const reply = await agentReply(t, "Here is what I posted");
      const posted = await agentReply(t, "Posted for you");
      const action = await seedAction(
        t,
        "message_posted",
        { type: "message", id: posted.id },
        { messageId: reply.id },
      );
      const undo = (who: Person, id = action.id) => who.browser.json(t.url(`/actions/${id}/undo`), "POST");
      const redo = (who: Person, id = action.id) => who.browser.json(t.url(`/actions/${id}/redo`), "POST");
      const meta = async () =>
        (await server.deps.db.select().from(messages).where(eq(messages.id, posted.id)))[0]?.meta;

      // A member who neither asked, owns the agent nor manages agents.
      const stranger = await memberOf(server, t.workspaceId, "Eli", email("eli"));
      expect(await code(await undo(stranger))).toBe("action.not_yours");
      expect((await undo(t.dora)).status).toBe(404);
      expect(await code(await redo(t.carla))).toBe("action.not_undone");

      const undone = await body(await undo(t.carla));
      expect(undone).toMatchObject({ id: action.id, reverterUserId: t.carla.user.id });
      expect(undone.revertedAt).not.toBeNull();
      expect((await meta())?.retracted).toMatchObject({ byUserId: t.carla.user.id });
      expect(await code(await undo(t.beto))).toBe("action.already_undone");
      expect((await redo(t.beto)).status).toBe(200);
      expect((await meta())?.retracted).toBeUndefined();

      // Undo all: only what is still open and is the person's.
      const other = await agentReply(t, "Second post");
      const second = await seedAction(
        t,
        "message_posted",
        { type: "message", id: other.id },
        { messageId: reply.id },
      );
      const notMine = await seedAction(
        t,
        "message_posted",
        { type: "message", id: other.id },
        { messageId: reply.id, requesterUserId: t.ana.user.id },
      );
      const all = await body(await t.carla.browser.json(t.url(`/messages/${reply.id}/actions/undo`), "POST"));
      const state = new Map(
        all.actions.map((a: { id: string; revertedAt: string | null }) => [a.id, a.revertedAt]),
      );
      expect(state.get(action.id)).not.toBeNull();
      expect(state.get(second.id)).not.toBeNull();
      expect(all.failed).toEqual([]);
      // Ana asked for that one: Carla's "undo all" leaves it as it is.
      expect(state.get(notMine.id)).toBeNull();
      expect(
        (await t.carla.browser.json(t.url(`/messages/${newId("msg")}/actions/undo`), "POST")).status,
      ).toBe(404);

      // Past the deadline nothing undoes any more.
      const late = await seedAction(
        t,
        "message_posted",
        { type: "message", id: posted.id },
        { messageId: reply.id },
      );
      clock = new Date(clock.getTime() + UNDO_WINDOW_MS + 1);
      expect(await code(await undo(t.carla, late.id))).toBe("action.expired");
      const unknown = await seedAction(t, "teleported", { type: "x", id: "x" });
      expect(await code(await undo(t.carla, unknown.id))).toBe("action.expired");
    },
    SERVER_TEST_MS,
  );

  test(
    "N undos of the same action at once: one undoes, the rest find it undone",
    async () => {
      const t = await team();
      const posted = await agentReply(t, "Posted once");
      const action = await seedAction(t, "message_posted", { type: "message", id: posted.id });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => t.carla.browser.json(t.url(`/actions/${action.id}/undo`), "POST")),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409))
        expect(await code(r)).toBe("action.already_undone");
    },
    SERVER_TEST_MS,
  );

  test(
    "a reminder the agent created: undo cancels it, redo schedules it again, not once its time passed",
    async () => {
      const t = await team();
      const [rem] = await server.deps.db
        .insert(reminders)
        .values({
          id: newId("rem"),
          workspaceId: t.workspaceId,
          agentId: t.agentId,
          channelId: t.general,
          text: "Call the client",
          at: new Date(clock.getTime() + 3600_000),
          createdByType: "agent",
          createdById: t.agentId,
        })
        .returning();
      if (!rem) throw new Error("no reminder");
      const action = await seedAction(t, "reminder_created", { type: "reminder", id: rem.id });
      const status = async () =>
        (await server.deps.db.select().from(reminders).where(eq(reminders.id, rem.id)))[0]?.status;
      expect((await t.carla.browser.json(t.url(`/actions/${action.id}/undo`), "POST")).status).toBe(200);
      expect(await status()).toBe("canceled");
      expect((await t.carla.browser.json(t.url(`/actions/${action.id}/redo`), "POST")).status).toBe(200);
      expect(await status()).toBe("scheduled");
      expect((await t.carla.browser.json(t.url(`/actions/${action.id}/undo`), "POST")).status).toBe(200);
      clock = new Date(clock.getTime() + 2 * 3600_000);
      expect(await code(await t.carla.browser.json(t.url(`/actions/${action.id}/redo`), "POST"))).toBe(
        "action.changed_since",
      );
      expect(await status()).toBe("canceled");
    },
    SERVER_TEST_MS,
  );

  test(
    "content: an issue a person changed after the agent isn't overwritten; otherwise undo and redo swap the fields",
    async () => {
      const t = await team();
      const by = { type: "agent" as const, id: t.agentId };
      const issue = await createIssue(server.deps, {
        workspaceId: t.workspaceId,
        title: "Draft",
        author: by,
      });
      await updateIssue(server.deps, issue, { title: "Ship it", priority: "high" }, by);
      const params = {
        previous: { title: "Draft", priority: "none" },
        change: { title: "Ship it", priority: "high" },
      };
      const action = await seedAction(t, "issue_edited", { type: "issue", id: issue.id }, { params });
      expect((await t.carla.browser.json(t.url(`/actions/${action.id}/undo`), "POST")).status).toBe(200);
      expect(await issueById(server.deps.db, t.workspaceId, issue.id)).toMatchObject({
        title: "Draft",
        priority: "none",
      });
      expect((await t.carla.browser.json(t.url(`/actions/${action.id}/redo`), "POST")).status).toBe(200);
      expect(await issueById(server.deps.db, t.workspaceId, issue.id)).toMatchObject({
        title: "Ship it",
        priority: "high",
      });

      // Beto renames it after the agent: the undo refuses and his title stays.
      const person = { type: "person" as const, id: t.beto.user.id };
      await updateIssue(
        server.deps,
        await issueById(server.deps.db, t.workspaceId, issue.id),
        { title: "Beto's" },
        person,
      );
      expect(await code(await t.carla.browser.json(t.url(`/actions/${action.id}/undo`), "POST"))).toBe(
        "action.changed_since",
      );
      expect(await issueById(server.deps.db, t.workspaceId, issue.id)).toMatchObject({
        title: "Beto's",
        priority: "high",
      });
      const [still] = await server.deps.db
        .select()
        .from(reversibleActions)
        .where(eq(reversibleActions.id, action.id));
      expect(still?.revertedAt).toBeNull();

      // An issue the agent opened: undo cancels it (its number stays), redo puts it back in its column.
      const opened = await createIssue(server.deps, { workspaceId: t.workspaceId, title: "New", author: by });
      const open = await seedAction(
        t,
        "issue_opened",
        { type: "issue", id: opened.id },
        { params: { columnId: opened.columnId } },
      );
      expect((await t.carla.browser.json(t.url(`/actions/${open.id}/undo`), "POST")).status).toBe(200);
      const cols = await columnsOf(server.deps.db, t.workspaceId);
      const stageOf = async () => {
        const { columnId } = await issueById(server.deps.db, t.workspaceId, opened.id);
        return cols.find((c) => c.id === columnId)?.stage;
      };
      expect(await stageOf()).toBe("canceled");
      expect((await t.carla.browser.json(t.url(`/actions/${open.id}/redo`), "POST")).status).toBe(200);
      expect((await issueById(server.deps.db, t.workspaceId, opened.id)).columnId).toBe(opened.columnId);
    },
    SERVER_TEST_MS,
  );

  test(
    "content: a wiki page the agent wrote and edited; a person's later version is never replaced",
    async () => {
      const t = await team();
      const agent = { type: "agent" as const, id: t.agentId };
      const page = await createPage(server.deps, {
        workspaceId: t.workspaceId,
        title: `Plan ${n}`,
        body: "v1",
        author: agent,
      });
      const v2 = await savePage(server.deps, { row: page, author: agent, canBypassLock: false, body: "v2" });
      const edit = await seedAction(
        t,
        "wiki_updated",
        { type: "wiki", id: page.id },
        { params: { fromVersion: 1, toVersion: 2 } },
      );
      const bodyOf = async () =>
        (
          await server.deps.db
            .select()
            .from(schema.knowledgePages)
            .where(eq(schema.knowledgePages.id, page.id))
        )[0];
      expect((await t.carla.browser.json(t.url(`/actions/${edit.id}/undo`), "POST")).status).toBe(200);
      expect(await bodyOf()).toMatchObject({ body: "v1", version: 3 });
      expect((await t.carla.browser.json(t.url(`/actions/${edit.id}/redo`), "POST")).status).toBe(200);
      expect(await bodyOf()).toMatchObject({ body: "v2", version: 4 });
      // Beto saves after the agent: the undo refuses and his version stays.
      const current = await bodyOf();
      if (!current) throw new Error("no page");
      await savePage(server.deps, {
        row: current,
        author: { type: "person", id: t.beto.user.id },
        canBypassLock: false,
        body: "Beto's",
      });
      expect(await code(await t.carla.browser.json(t.url(`/actions/${edit.id}/undo`), "POST"))).toBe(
        "action.changed_since",
      );
      expect(await bodyOf()).toMatchObject({ body: "Beto's", version: 5 });
      void v2;

      // A page the agent wrote: undo deletes it, redo writes it back with the same address.
      const fresh = await createPage(server.deps, {
        workspaceId: t.workspaceId,
        title: `Notes ${n}`,
        body: "hello",
        author: agent,
      });
      const write = await seedAction(t, "wiki_written", { type: "wiki", id: fresh.id });
      expect((await t.carla.browser.json(t.url(`/actions/${write.id}/undo`), "POST")).status).toBe(200);
      const gone = await server.deps.db
        .select()
        .from(schema.knowledgePages)
        .where(eq(schema.knowledgePages.id, fresh.id));
      expect(gone).toEqual([]);
      expect((await t.carla.browser.json(t.url(`/actions/${write.id}/redo`), "POST")).status).toBe(200);
      const back = await server.deps.db
        .select()
        .from(schema.knowledgePages)
        .where(eq(schema.knowledgePages.id, fresh.id));
      expect(back[0]).toMatchObject({ slug: fresh.slug, body: "hello", version: 1 });
    },
    SERVER_TEST_MS,
  );
});
