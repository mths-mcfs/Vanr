// What the control center's routes let through: an edit-and-approve the gate would deny is refused, and the counts
// and numbers about approvals leave out conversations the viewer can't read. The edit runs through a live run (the
// engine's fake model calling the mail tools against the local IMAP/SMTP fake); the counts read rows seeded here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { DECISION_TTL_MS, trailEntry } from "../src/control";
import type { RunningServer } from "../src/server";
import { type FakeMailServer, startFakeMail } from "./fake-mail";
import { SERVER_TEST_MS, settle, signedIn, startTestServer, waitFor } from "./harness";
import { call, seedAgent, ws } from "./route-calls";
import { memberOf, seedChannel, seedWorkspace } from "./seed";

let mail: FakeMailServer;
let server: RunningServer;
beforeAll(async () => {
  mail = await startFakeMail();
  server = await startTestServer({ env: { ALLOW_PRIVATE_NETWORKS: "true", UNDO_SEND_SECONDS: "30" } });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  mail.stop();
}, SERVER_TEST_MS);

const { approvals, gateDecisions, outbox } = schema;
let n = 0;
const email = (who: string) => `${who}${++n}@control-access.test`;

/** Ana owns the workspace; Beto owns Lia; #secret is private to Beto; Carla is a member. */
async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const carla = await memberOf(server, workspaceId, "Carla", email("carla"));
  const secret = await seedChannel(server, workspaceId, {
    name: `secret${n}`,
    visibility: "private",
    members: [beto],
  });
  const lia = await seedAgent(server, workspaceId, beto, `lia${n}`, [general, secret]);
  return { workspaceId, w: ws(workspaceId), general, secret, ana, beto, carla, lia };
}

/** A pending approval of Lia's in a channel, as the runtime writes it. */
async function pendingIn(workspaceId: string, agentId: string, channelId: string, requesterUserId: string) {
  const [row] = await server.deps.db
    .insert(approvals)
    .values({
      id: newId("apv"),
      workspaceId,
      agentId,
      channelId,
      tool: "post_message",
      scope: "chat:post_message",
      title: "Post the plan",
      detail: "The plan",
      payloadHash: "h1",
      effect: "K2",
      requesterUserId,
      expiresAt: new Date(Date.now() + DECISION_TTL_MS),
      trail: [trailEntry(new Date(), "requested", "Lia asked")],
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

describe("edit and approve", () => {
  test(
    "an edit the gate would deny (outside address after the run read outside mail) is refused and nothing goes out",
    async () => {
      const { w, general, ana, beto, lia } = await team();
      const account = await call(ana, "POST", `${w}/mail/accounts/imap`, {
        preset: "other",
        address: mail.user,
        password: mail.password,
        imapHost: mail.host,
        imapPort: mail.imapPort,
        smtpHost: mail.host,
        smtpPort: mail.smtpPort,
      });
      expect(account.status).toBe(201);
      const accountId = account.body.account.id as string;
      expect(
        (
          await call(ana, "PUT", `${w}/agents/${lia.id}/mail/${accountId}`, {
            level: "read_write",
            deletable: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (await call(ana, "PATCH", `${w}/mail/accounts/${accountId}`, { confirmActions: ["send"] })).status,
      ).toBe(200);
      // Reading the mailbox raises flag A; the send to a workspace member then asks a person.
      const directive =
        `@${lia.handle} [[tool:mail_folders {"account":"${mail.user}"}]] ` +
        `[[tool:mail_send {"account":"${mail.user}","to":["${ana.user.email}"],"subject":"Status","text":"Update"}]]`;
      expect(
        (await call(beto, "POST", `${w}/channels/${general}/messages`, { body: directive, clientId: "e1" }))
          .status,
      ).toBe(201);
      let asked: { id: string; payloadHash: string; flags: { flag: string }[] } | undefined;
      await waitFor(async () => {
        asked = (await call(beto, "GET", `${w}/approvals?status=pending`)).body.approvals.find(
          (a: { tool: string }) => a.tool === "mail_send",
        );
        return asked !== undefined;
      });
      if (asked === undefined) throw new Error("no approval");
      expect(asked.flags.some((flag) => flag.flag === "A")).toBe(true);

      const edited = await call(beto, "POST", `${w}/approvals/${asked.id}/edit`, {
        input: { to: ["someone@outside.example"] },
        payloadHash: asked.payloadHash,
      });
      expect(edited.status).toBe(400);
      expect(edited.body.error.code).toBe("approval.edit_blocked");
      const still = (await call(beto, "GET", `${w}/approvals/${asked.id}`)).body;
      expect(still).toMatchObject({ status: "pending", edited: false, payloadHash: asked.payloadHash });
      expect(await server.deps.db.select().from(outbox).where(eq(outbox.agentId, lia.id))).toEqual([]);

      // The request is still decidable as it was: rejecting it ends the run.
      expect((await call(beto, "POST", `${w}/approvals/${asked.id}/reject`, {})).status).toBe(200);
      await settle(server);
      expect(mail.sent.filter((sent) => sent.to.includes("someone@outside.example"))).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("counts that leave out conversations the viewer can't read", () => {
  test(
    "the agent's queued approvals",
    async () => {
      const { workspaceId, w, secret, general, ana, beto, carla, lia } = await team();
      await pendingIn(workspaceId, lia.id, secret, beto.user.id);
      await pendingIn(workspaceId, lia.id, general, beto.user.id);
      const queued = async (who: Parameters<typeof call>[0]) =>
        (await call(who, "GET", `${w}/agents/${lia.id}`)).body.queuedApprovals;
      expect(await queued(beto)).toBe(2);
      expect(await queued(carla)).toBe(1);
      // Managing agents is not reading #secret.
      expect(await queued(ana)).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "the gate's numbers",
    async () => {
      const { workspaceId, w, secret, general, ana, beto, lia } = await team();
      const inSecret = await pendingIn(workspaceId, lia.id, secret, beto.user.id);
      const inGeneral = await pendingIn(workspaceId, lia.id, general, beto.user.id);
      const decision = (approvalId: string | null, effect: "K1" | "K2") => ({
        id: newId("tdec"),
        workspaceId,
        agentId: lia.id,
        tool: "post_message",
        effect,
        decision: "ask" as const,
        approvalId,
      });
      await server.deps.db
        .insert(gateDecisions)
        .values([decision(inSecret.id, "K2"), decision(inGeneral.id, "K2"), decision(null, "K1")]);
      const byEffect = async () =>
        Object.fromEntries(
          (
            (await call(ana, "GET", `${w}/approvals/stats`)).body.byEffect as {
              effect: string;
              calls: number;
            }[]
          ).map((row) => [row.effect, row.calls]),
        );
      // Ana sees usage but doesn't read #secret: its call stays out; a call outside any conversation counts.
      expect(await byEffect()).toEqual({ K1: 1, K2: 1 });
      expect(
        (await call(beto, "POST", `${w}/channels/${secret}/members`, { userId: ana.user.id })).status,
      ).toBe(204);
      expect(await byEffect()).toEqual({ K1: 1, K2: 2 });
    },
    SERVER_TEST_MS,
  );
});
