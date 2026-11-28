// Who lets people into an assignment, and what creating one does to the creator's channels, over HTTP on the real
// server (PGlite). Only who manages the assignment (its owner, or an admin with `configure`) lists, answers and
// counts the join requests; a refused creation leaves the person outside the channel.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { and, eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { agentRuntime, passing, seedAgent } from "./assignment-kit";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, ws } from "./route-calls";
import { memberOf, type Person, seedChannel, seedWorkspace } from "./seed";

let server: RunningServer;
let n = 0;
const email = (who: string) => `${who}${++n}@assignment-access.test`;
const runtime = agentRuntime();

beforeAll(async () => {
  server = await startTestServer({ runtime: runtime.wrap, assignmentVerifier: passing().verifier });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server?.stop();
}, SERVER_TEST_MS);

/** Ana owns an assignment in #general; Beto asks to join; Caio decides; Dora is an admin; Eva only reads. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const dora = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
  const eva = await memberOf(server, workspaceId, "Eva", email("eva"));
  const agentId = await seedAgent(server.deps.db, workspaceId, ana, null);
  const created = await call(ana, "POST", `${ws(workspaceId)}/assignments`, {
    agentId,
    channelId: general,
    goal: "Ship the site",
  });
  expect(created.status).toBe(201);
  const path = `${ws(workspaceId)}/assignments/${created.body.id}`;
  await server.deps.db
    .insert(schema.assignmentParticipants)
    .values({ assignmentId: created.body.id, userId: caio.user.id, role: "decide", addedBy: ana.user.id });
  return { ana, beto, caio, dora, eva, workspaceId, general, agentId, path };
}

const isMember = async (channelId: string, who: Person) =>
  (
    await server.deps.db
      .select()
      .from(schema.channelMemberships)
      .where(
        and(
          eq(schema.channelMemberships.channelId, channelId),
          eq(schema.channelMemberships.memberType, "person"),
          eq(schema.channelMemberships.memberId, who.user.id),
        ),
      )
  ).length > 0;

describe("join requests", () => {
  test(
    "are counted, listed and answered by the same people: the owner and an admin, never a decider or a reader",
    async () => {
      const t = await team();
      expect((await call(t.beto, "POST", `${t.path}/join-requests`)).status).toBe(201);
      const pendingOf = async (who: Person) => (await call(who, "GET", t.path)).body.pending.joinRequests;
      expect(await pendingOf(t.ana)).toBe(1);
      expect(await pendingOf(t.dora)).toBe(1);
      expect(await pendingOf(t.caio)).toBe(0);
      expect(await pendingOf(t.eva)).toBe(0);
      const list = async (who: Person) => (await call(who, "GET", `${t.path}/join-requests`)).status;
      expect([await list(t.ana), await list(t.dora), await list(t.caio), await list(t.eva)]).toEqual([
        200, 200, 403, 403,
      ]);
      // The admin who only reads it lists the request, and accepts it, by one rule.
      const listed = await call(t.dora, "GET", `${t.path}/join-requests`);
      expect(listed.body.requests.map((r: { userId: string }) => r.userId)).toEqual([t.beto.user.id]);
      expect(
        (await call(t.caio, "POST", `${t.path}/join-requests/${t.beto.user.id}/accept`, { role: "comment" }))
          .status,
      ).toBe(403);
      const accepted = await call(t.dora, "POST", `${t.path}/join-requests/${t.beto.user.id}/accept`, {
        role: "comment",
      });
      expect(accepted.status).toBe(200);
      expect(await pendingOf(t.ana)).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "wait on the decider who is also an admin, and on nobody who can't let people in",
    async () => {
      const t = await team();
      await call(t.beto, "POST", `${t.path}/join-requests`);
      const blocked = async (who: Person) =>
        (await call(who, "GET", `${ws(t.workspaceId)}/assignments?status=blocked_on_you`)).body.counts
          .blockedOnYou;
      expect(await blocked(t.ana)).toBe(1);
      expect(await blocked(t.caio)).toBe(0);
      // Caio becomes an admin: he decides and may let people in, so the request now waits on him too.
      await server.deps.db
        .update(schema.members)
        .set({ role: "admin" })
        .where(and(eq(schema.members.workspaceId, t.workspaceId), eq(schema.members.userId, t.caio.user.id)));
      expect(await blocked(t.caio)).toBe(1);
    },
    SERVER_TEST_MS,
  );
});

describe("creating an assignment", () => {
  test(
    "in a public channel the agent isn't in: 409, and the person stays outside the channel",
    async () => {
      const t = await team();
      const bare = await seedChannel(server, t.workspaceId, { name: `bare${n}`, members: [t.ana] });
      const refused = await call(t.beto, "POST", `${ws(t.workspaceId)}/assignments`, {
        agentId: t.agentId,
        channelId: bare,
        goal: "In bare",
      });
      expect([refused.status, refused.body.error.code]).toEqual([409, "assignment.agent_not_in_channel"]);
      expect(await isMember(bare, t.beto)).toBe(false);
      // A refusal later in the checks (a runner of another workspace) leaves them outside too.
      const ops = await seedChannel(server, t.workspaceId, { name: `ops${n}`, members: [t.ana] });
      await server.deps.db
        .insert(schema.channelMemberships)
        .values({ channelId: ops, memberType: "agent", memberId: t.agentId });
      const badRunner = await call(t.beto, "POST", `${ws(t.workspaceId)}/assignments`, {
        agentId: t.agentId,
        channelId: ops,
        goal: "In ops",
        runnerId: "rn_elsewhere",
      });
      expect(badRunner.status).toBe(404);
      expect(await isMember(ops, t.beto)).toBe(false);
      // With every check passed, creating it joins them.
      const made = await call(t.beto, "POST", `${ws(t.workspaceId)}/assignments`, {
        agentId: t.agentId,
        channelId: ops,
        goal: "In ops",
      });
      expect(made.status).toBe(201);
      expect(await isMember(ops, t.beto)).toBe(true);
    },
    SERVER_TEST_MS,
  );
});
