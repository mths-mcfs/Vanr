// The undo window of an agent's post and email, undone through the control center's route. The tools that queue
// (runtime/tools, mail-tools) come with S6: here the send is queued with `queueSend` the way those tools do, with
// the runtime's `wakeAt` only (as outbox.test.ts does), and the runtime's tick is `deliverDue`. The clock is
// injected: the deadline passes when the test moves it, never by waiting. The IMAP/SMTP server is the local fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import type { AppDeps, WorkspaceMember } from "../src/context";
import type { ToolContext } from "../src/forward-types";
import { connectImap, setAgentMailbox } from "../src/integrations/mail";
import { reserveUsage } from "../src/integrations/usage";
import { postMessage } from "../src/messages";
import { deliverDue, queueSend } from "../src/outbox";
import type { RunningServer } from "../src/server";
import { type FakeMailServer, startFakeMail } from "./fake-mail";
import { body, SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
import { memberOf, seedChannel, seedWorkspace } from "./seed";

const WINDOW_MS = 30_000;
let clock = new Date("2026-11-14T12:00:00Z");
let mail: FakeMailServer;
let server: RunningServer;
beforeAll(async () => {
  mail = await startFakeMail();
  server = await startTestServer({
    env: { ALLOW_PRIVATE_NETWORKS: "true", UNDO_SEND_SECONDS: String(WINDOW_MS / 1000) },
    now: () => clock,
  });
}, SERVER_TEST_MS);
afterAll(async () => {
  await server.stop();
  mail.stop();
}, SERVER_TEST_MS);

const { outbox, reversibleActions, integrationUsage, messages, agents } = schema;
let n = 0;
const email = (who: string) => `${who}${++n}@undo.test`;
/** The deadline passes and the runtime's sweep delivers what is due. */
const later = async () => {
  clock = new Date(clock.getTime() + WINDOW_MS + 1000);
  await deliverDue(server.deps);
};

/** The runtime as S6 brings it, for `wakeAt` only. */
const withWakeAt = (): AppDeps => ({ ...server.deps, runtime: { ...server.deps.runtime, wakeAt: () => {} } });

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Workshop");
  const beto = await memberOf(server, workspaceId, "Beto", email("beto"));
  const agentId = newId("agt");
  await server.deps.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: "Lia",
    handle: `lia${n}`,
    model: "claude-haiku-5-5",
    ownerUserId: ana.user.id,
    appearance: { color: "blue", eyes: "dot", adornment: "none" },
  });
  const sales = await seedChannel(server, workspaceId, { name: `sales${n}`, members: [ana, beto] });
  const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
  if (!channel) throw new Error("no channel");
  const { message: reply } = await postMessage(server.deps, {
    workspaceId,
    channel,
    author: { type: "agent", id: agentId },
    body: "On it.",
    clientId: null,
  });
  /** Beto asked: the action is recorded on the agent's answer, as runtime/tools records it. */
  const ctx: ToolContext = {
    deps: withWakeAt(),
    workspaceId,
    agent: { id: agentId },
    runId: newId("run"),
    recordAction: async (action, tx) => {
      await tx.insert(reversibleActions).values({
        id: newId("act"),
        workspaceId,
        agentId,
        messageId: reply.id,
        requesterUserId: beto.user.id,
        kind: action.kind,
        target: action.target,
        params: action.params ?? {},
        revertibleUntil: action.revertibleUntil ?? new Date(clock.getTime() + 24 * 3600_000),
      });
    },
  };
  const actionFor = async (outboxId: string) => {
    const rows = await server.deps.db
      .select()
      .from(reversibleActions)
      .where(eq(reversibleActions.messageId, reply.id));
    const found = rows.find((a) => a.params.outboxId === outboxId);
    if (!found) throw new Error("no receipt");
    return found;
  };
  const url = (path: string) => `/api/v1/workspaces/${workspaceId}${path}`;
  return { workspaceId, general, sales, ana, beto, agentId, reply, ctx, actionFor, url };
}

const bodiesIn = async (channelId: string) =>
  (await server.deps.db.select().from(messages).where(eq(messages.channelId, channelId))).map((m) => m.body);
const code = async (res: Response) => (await body(res)).error?.code;

describe("a post with an undo window", () => {
  test(
    "undo within the window: nothing shows in the channel, not even after the deadline; redo doesn't send",
    async () => {
      const t = await team();
      const row = await queueSend(t.ctx, {
        kind: "post",
        payload: { channelId: t.sales, text: "Flash sale", clientId: newId("c") },
        title: "#sales",
      });
      const action = await t.actionFor(row.id);
      expect(action).toMatchObject({ kind: "message_posted", target: { type: "outbox", title: "#sales" } });
      expect(await bodiesIn(t.sales)).not.toContain("Flash sale");

      const undone = await t.beto.browser.json(t.url(`/actions/${action.id}/undo`), "POST");
      expect(undone.status).toBe(200);
      expect((await body(undone)).revertedAt).toBeTruthy();
      await later();
      expect(await bodiesIn(t.sales)).not.toContain("Flash sale");
      const [after] = await server.deps.db.select().from(outbox).where(eq(outbox.id, row.id));
      expect(after).toMatchObject({ status: "canceled", canceledByUserId: t.beto.user.id });
      expect(await code(await t.beto.browser.json(t.url(`/actions/${action.id}/redo`), "POST"))).toBe(
        "action.changed_since",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "without undo: it goes out at the deadline, and undoing then retracts the message",
    async () => {
      const t = await team();
      const row = await queueSend(t.ctx, {
        kind: "post",
        payload: { channelId: t.sales, text: "Open on Saturday", clientId: newId("c") },
        title: "#sales",
      });
      // Before the deadline the sweep delivers nothing.
      await deliverDue(server.deps);
      expect(await bodiesIn(t.sales)).not.toContain("Open on Saturday");
      await later();
      const [posted] = await server.deps.db
        .select()
        .from(messages)
        .where(eq(messages.body, "Open on Saturday"));
      expect(posted).toMatchObject({ authorKind: "agent", channelId: t.sales });
      // The receipt now points at the message: undoing is retracting.
      const action = await t.actionFor(row.id);
      expect(action.target).toMatchObject({ type: "message", id: posted?.id, title: "#sales" });
      expect((await t.beto.browser.json(t.url(`/actions/${action.id}/undo`), "POST")).status).toBe(200);
      const [retracted] = await server.deps.db
        .select()
        .from(messages)
        .where(eq(messages.id, posted?.id ?? ""));
      expect(retracted?.meta.retracted).toMatchObject({ actorUserId: t.beto.user.id });
    },
    SERVER_TEST_MS,
  );
});

describe("an email with an undo window", () => {
  async function mailbox() {
    const t = await team();
    const me: WorkspaceMember & { sessionId: string } = {
      workspaceId: t.workspaceId,
      userId: t.ana.user.id,
      role: "owner",
      handle: "ana",
      sessionId: "s-ana",
    };
    const account = await connectImap(server.deps, me, {
      address: mail.user,
      preset: "other",
      imapHost: mail.host,
      imapPort: mail.imapPort,
      smtpHost: mail.host,
      smtpPort: mail.smtpPort,
      username: mail.user,
      password: mail.password,
    });
    await setAgentMailbox(server.deps, t.workspaceId, t.agentId, account, {
      level: "read_write",
      policy: { recipientAllowlist: ["@client.test"], autoSend: true, sendsPerDay: 5 },
    });
    /** Queues an email as mail_send does: the day's quota is reserved first. */
    const queueMail = async () => {
      const usageId = await reserveUsage(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.agentId,
        resourceId: account.id,
        kind: "mail_send",
        cap: 5,
      });
      if (!usageId) throw new Error("no quota");
      const raw = `From: ${mail.user}\r\nTo: joao@client.test\r\nSubject: Order\r\n\r\nPacked the boxes.\r\n`;
      return queueSend(t.ctx, {
        kind: "mail",
        payload: {
          accountId: account.id,
          envelope: { from: mail.user, to: ["joao@client.test"] },
          raw,
          usageId,
        },
        title: "joao@client.test",
      });
    };
    const reserved = async () =>
      (
        await server.deps.db
          .select()
          .from(integrationUsage)
          .where(eq(integrationUsage.workspaceId, t.workspaceId))
      ).length;
    return { ...t, queueMail, reserved };
  }

  test(
    "undo within the window: the email doesn't go out and the quota comes back",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      const action = await t.actionFor(row.id);
      // It can only be undone until it goes out.
      expect(action.revertibleUntil).toEqual(row.sendAt);
      expect(await t.reserved()).toBe(1);
      expect((await t.beto.browser.json(t.url(`/actions/${action.id}/undo`), "POST")).status).toBe(200);
      await later();
      expect(mail.sent).toEqual([]);
      expect(await t.reserved()).toBe(0);
    },
    SERVER_TEST_MS,
  );

  test(
    "without undo: it goes out at the deadline, once; after that there is no undo",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      const action = await t.actionFor(row.id);
      await later();
      await later();
      expect(mail.sent.map((s) => s.to)).toEqual([["joao@client.test"]]);
      const [after] = await server.deps.db.select().from(outbox).where(eq(outbox.id, row.id));
      expect(after?.status).toBe("sent");
      expect(await code(await t.beto.browser.json(t.url(`/actions/${action.id}/undo`), "POST"))).toBe(
        "action.expired",
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "undo and the send racing: whichever comes first wins, never both",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      const action = await t.actionFor(row.id);
      // A millisecond before the deadline the person undoes; the sweep already sees the deadline passed.
      clock = new Date(row.sendAt.getTime() - 1);
      const [undo] = await Promise.all([
        t.beto.browser.json(t.url(`/actions/${action.id}/undo`), "POST"),
        deliverDue({ ...server.deps, now: () => row.sendAt }),
      ]);
      const [after] = await server.deps.db.select().from(outbox).where(eq(outbox.id, row.id));
      if (undo.status === 200) {
        expect(after?.status).toBe("canceled");
        expect(mail.sent).toEqual([]);
      } else {
        expect(undo.status).toBe(409);
        expect(after?.status).toBe("sent");
        expect(mail.sent).toHaveLength(1);
      }
    },
    SERVER_TEST_MS,
  );
});
