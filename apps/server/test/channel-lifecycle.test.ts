// A channel's people and agents on the real server (PGlite): who may add someone else's agent to a channel, and a
// private channel whose last person leaves (archived, its name free, brought back only by the workspace's owner).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { eq } from "drizzle-orm";
import type { RunningServer } from "../src/server";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, type Person, seedWorkspace } from "./seed";

let server: RunningServer;
beforeAll(async () => {
  server = await startTestServer();
}, SERVER_TEST_MS);
afterAll(() => server.stop(), SERVER_TEST_MS);

let n = 0;
const email = (who: string) => `${who}${++n}@channel-life.test`;

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Team");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const caio = await memberOf(server, workspaceId, "Caio", email("caio"));
  const dora = await memberOf(server, workspaceId, "Dora", email("dora"), "admin");
  return { workspaceId, w: ws(workspaceId), general, ana, beto, caio, dora };
}

const audience = (id: string, mode: "everyone" | "people" | "owner", userIds: string[] = []) =>
  server.deps.db
    .update(schema.agents)
    .set({ visibilityMode: mode, audienceUserIds: userIds })
    .where(eq(schema.agents.id, id));

describe("adding an agent to a channel", () => {
  test(
    "follows the agent's own rule: its editor or whoever talks to it, never someone else's owner-only agent",
    async () => {
      const { workspaceId, w, ana, beto, dora } = await team();
      const solo = await seedAgent(server, workspaceId, ana, `solo${n}`);
      await audience(solo.id, "owner");
      const few = await seedAgent(server, workspaceId, ana, `few${n}`);
      await audience(few.id, "people", [beto.user.id]);
      const room = (await call(beto, "POST", `${w}/channels`, { name: `room-${n}`, visibility: "private" }))
        .body.id;
      await call(beto, "POST", `${w}/channels/${room}/members`, { userId: dora.user.id });
      const add = (who: Person, agentId: string) =>
        call(who, "POST", `${w}/channels/${room}/members`, { agentId });
      // Beto neither edits nor talks to Ana's owner-only agent: refused, as PUT /agents/:id/channels refuses him.
      expect((await add(beto, solo.id)).status).toBe(403);
      const agents = async () =>
        (await call(beto, "GET", `${w}/channels/${room}/members`)).body.members
          .filter((m: { type: string }) => m.type === "agent")
          .map((m: { id: string }) => m.id);
      expect(await agents()).toEqual([]);
      // He is in the other agent's audience: he talks to it, so he may bring it in.
      expect((await add(beto, few.id)).status).toBe(204);
      // Who manages agents edits every one: the admin brings the owner-only one.
      expect((await add(dora, solo.id)).status).toBe(204);
      expect((await agents()).sort()).toEqual([few.id, solo.id].sort());
    },
    SERVER_TEST_MS,
  );
});

describe("adding to an archived channel", () => {
  test("is refused, even by someone whose membership a leave raced past", async () => {
    const { w, beto, caio } = await team();
    const id = (await call(beto, "POST", `${w}/channels`, { name: `raced-${n}`, visibility: "private" })).body
      .id;
    // The state a lost race would leave: the channel archived while the adder's row was still read as a member.
    await server.deps.db
      .update(schema.channels)
      .set({ archivedAt: new Date() })
      .where(eq(schema.channels.id, id));
    const added = await call(beto, "POST", `${w}/channels/${id}/members`, { userId: caio.user.id });
    expect([added.status, added.body.error.code]).toEqual([409, "channel.archived"]);
    const people = await server.deps.db
      .select()
      .from(schema.channelMemberships)
      .where(eq(schema.channelMemberships.channelId, id));
    expect(people.map((p) => p.memberId)).toEqual([beto.user.id]);
  });
});

describe("a private channel nobody is left in", () => {
  test(
    "is archived with the last leave, frees its name, and only the workspace's owner sees and restores it",
    async () => {
      const { w, ana, beto, caio, dora } = await team();
      const made = await call(beto, "POST", `${w}/channels`, { name: `plans-${n}`, visibility: "private" });
      const id = made.body.id;
      const name = made.body.name;
      await call(beto, "POST", `${w}/channels/${id}/members`, { userId: caio.user.id });
      const archivedAt = async () =>
        (await server.deps.db.select().from(schema.channels).where(eq(schema.channels.id, id)))[0]
          ?.archivedAt ?? null;
      expect((await call(caio, "DELETE", `${w}/channels/${id}/members/people/${caio.user.id}`)).status).toBe(
        204,
      );
      expect(await archivedAt()).toBeNull();
      expect((await call(beto, "DELETE", `${w}/channels/${id}/members/people/${beto.user.id}`)).status).toBe(
        204,
      );
      expect(await archivedAt()).not.toBeNull();
      // Its name is free: a new channel takes it.
      const again = await call(caio, "POST", `${w}/channels`, { name, visibility: "public" });
      expect(again.status).toBe(201);
      // Only the owner lists the archived channels; an admin and a member get 403.
      expect((await call(dora, "GET", `${w}/archived-channels`)).status).toBe(403);
      expect((await call(beto, "GET", `${w}/archived-channels`)).status).toBe(403);
      const listed = await call(ana, "GET", `${w}/archived-channels`);
      expect(listed.status).toBe(200);
      expect(listed.body.channels.map((c: { id: string }) => c.id)).toEqual([id]);
      // Restoring while another channel holds the name: refused with the code, nothing renamed.
      expect((await call(dora, "POST", `${w}/archived-channels/${id}/restore`)).status).toBe(403);
      const clash = await call(ana, "POST", `${w}/archived-channels/${id}/restore`);
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe("channel.name_taken");
      expect(await archivedAt()).not.toBeNull();
      // Once the other one is renamed, the owner brings it back and is its member.
      expect(
        (await call(caio, "PATCH", `${w}/channels/${again.body.id}`, { name: `other-${n}` })).status,
      ).toBe(200);
      const restored = await call(ana, "POST", `${w}/archived-channels/${id}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({ id, name, isMember: true, visibility: "private" });
      expect(await archivedAt()).toBeNull();
      expect((await call(ana, "POST", `${w}/archived-channels/${id}/restore`)).body.error.code).toBe(
        "channel.not_archived",
      );
      expect((await call(ana, "GET", `${w}/archived-channels`)).body.channels).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "leaving the workspace archives the private channels one was the last person in, and only those",
    async () => {
      const { workspaceId, w, ana, beto, caio } = await team();
      const alone = (await call(beto, "POST", `${w}/channels`, { name: `alone-${n}`, visibility: "private" }))
        .body.id;
      const shared = (
        await call(beto, "POST", `${w}/channels`, { name: `shared-${n}`, visibility: "private" })
      ).body.id;
      await call(beto, "POST", `${w}/channels/${shared}/members`, { userId: caio.user.id });
      // An agent left behind doesn't keep the channel alive: no person could read it.
      await seedAgent(server, workspaceId, beto, `lia${n}`, [alone]);
      expect((await call(beto, "DELETE", `${w}/members/${beto.user.id}`)).status).toBe(204);
      const rows = await server.deps.db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.workspaceId, workspaceId));
      const state = Object.fromEntries(rows.map((r) => [r.id, r.archivedAt !== null]));
      expect(state[alone]).toBe(true);
      expect(state[shared]).toBe(false);
      const listed = await call(ana, "GET", `${w}/archived-channels`);
      expect(listed.body.channels.map((c: { id: string }) => c.id)).toEqual([alone]);
    },
    SERVER_TEST_MS,
  );
});
