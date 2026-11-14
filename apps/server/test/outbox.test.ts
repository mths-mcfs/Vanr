// The send queue with an undo window (outbox.ts). The agent tools that queue (runtime/tools, mail-tools) and the
// runtime's tick and timer that deliver come with S6, and the undo route that cancels with S5; here the tests call
// `queueSend`, `deliverDue` and `cancelQueued` the way those callers do, with the clock injected: the deadline
// passes when the test moves the clock, never by waiting. The IMAP/SMTP server is the local fake.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { createSealer } from "@vanr/engine/seal";
import { and, eq } from "drizzle-orm";
import { channelInWorkspace } from "../src/channels";
import type { AppDeps, WorkspaceMember } from "../src/context";
import type { ToolContext } from "../src/forward-types";
import { connectImap, setAgentMailbox } from "../src/integrations/mail";
import { reserveUsage } from "../src/integrations/usage";
import { postMessage } from "../src/messages";
import { cancelQueued, DELIVER_BATCH, deliverDue, type OutboxRow, queueSend } from "../src/outbox";
import type { RunningServer } from "../src/server";
import { type FakeMailServer, startFakeMail } from "./fake-mail";
import { SERVER_TEST_MS, signedIn, startTestServer } from "./harness";
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

const { outbox, reversibleActions, integrationUsage, messages, channelMemberships, agents } = schema;
let n = 0;
const email = (who: string) => `${who}${++n}@outbox.test`;
// Every test starts with nothing due: what a test left queued goes out (or fails) here.
afterEach(async () => {
  later();
  while ((await deliverDue(server.deps)) > 0) {}
});

/** The deadline passes. */
const later = () => {
  clock = new Date(clock.getTime() + WINDOW_MS + 1000);
};

async function team() {
  const ana = await signedIn(server, "Ana", email("ana"));
  const { workspaceId, general } = await seedWorkspace(server, ana, "Outbox");
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
  // The agent's answer in #general, where the receipt of its actions shows.
  const channel = await channelInWorkspace(server.deps.db, workspaceId, general);
  if (!channel) throw new Error("no channel");
  const { message: reply } = await postMessage(server.deps, {
    workspaceId,
    channel,
    author: { type: "agent", id: agentId },
    body: "On it.",
    clientId: null,
  });
  /** The run's context, as runtime/tools builds it: the action is recorded on the agent's answer. */
  const ctx = (deps: AppDeps = server.deps): ToolContext => ({
    deps,
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
        revertibleUntil: action.revertibleUntil ?? null,
      });
    },
  });
  return { workspaceId, general, sales, ana, beto, agentId, reply, ctx };
}
type Team = Awaited<ReturnType<typeof team>>;

/** The runtime as S6 brings it, for `wakeAt` only: it says when the send asked to be woken. */
function withWakeAt(wakes: Date[]): AppDeps {
  return { ...server.deps, runtime: { ...server.deps.runtime, wakeAt: (at: Date) => wakes.push(at) } };
}

const queuePost = (t: Team, text: string, channelId = t.sales) =>
  queueSend(t.ctx(withWakeAt([])), {
    kind: "post",
    payload: { channelId, text, clientId: newId("c") },
    title: "#sales",
  });

const rowOf = async (id: string): Promise<OutboxRow | undefined> =>
  (await server.deps.db.select().from(outbox).where(eq(outbox.id, id)))[0];
const actionOf = async (outboxId: string) =>
  (
    await server.deps.db
      .select()
      .from(reversibleActions)
      .where(eq(reversibleActions.workspaceId, (await rowOf(outboxId))?.workspaceId ?? ""))
  ).find((a) => a.params.outboxId === outboxId);
const bodiesIn = async (channelId: string) =>
  (await server.deps.db.select().from(messages).where(eq(messages.channelId, channelId))).map((m) => m.body);

describe("queueing", () => {
  test(
    "without the runtime's wakeAt the send is rejected before anything is written",
    async () => {
      const t = await team();
      const err = await queueSend(t.ctx(), {
        kind: "post",
        payload: { channelId: t.sales, text: "too early", clientId: "c-early" },
        title: "#sales",
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 503, code: "not_available", params: { method: "wakeAt" } });
      expect(await server.deps.db.select().from(outbox).where(eq(outbox.workspaceId, t.workspaceId))).toEqual(
        [],
      );
      expect(
        await server.deps.db
          .select()
          .from(reversibleActions)
          .where(eq(reversibleActions.workspaceId, t.workspaceId)),
      ).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a queued post waits the window, records its receipt and asks to be woken at the deadline",
    async () => {
      const t = await team();
      const wakes: Date[] = [];
      const row = await queueSend(t.ctx(withWakeAt(wakes)), {
        kind: "post",
        payload: { channelId: t.sales, text: "Flash sale", clientId: "c-1" },
        title: "#sales",
      });
      const sendAt = new Date(clock.getTime() + WINDOW_MS);
      expect(row).toMatchObject({ status: "pending", kind: "post", sendAt, workspaceId: t.workspaceId });
      expect(wakes).toEqual([sendAt]);
      const action = await actionOf(row.id);
      expect(action).toMatchObject({
        kind: "message_posted",
        target: { type: "outbox", id: row.id, title: "#sales" },
        params: { outboxId: row.id, sendAt: sendAt.toISOString() },
        // A post can still be retracted once out: the usual window, not the send's.
        revertibleUntil: null,
      });
      expect(await bodiesIn(t.sales)).not.toContain("Flash sale");
    },
    SERVER_TEST_MS,
  );
});

describe("a queued send and its receipt", () => {
  test(
    "a receipt that can't be written leaves nothing queued: retrying doesn't send twice",
    async () => {
      const t = await team();
      const failing: ToolContext = {
        ...t.ctx(withWakeAt([])),
        recordAction: async (action, tx) => {
          await t.ctx().recordAction(action, tx);
          throw new Error("receipt write failed");
        },
      };
      for (let i = 0; i < 2; i++) {
        const err = await queueSend(failing, {
          kind: "post",
          payload: { channelId: t.sales, text: "asked once", clientId: newId("c") },
          title: "#sales",
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({ message: "receipt write failed" });
      }
      expect(await server.deps.db.select().from(outbox).where(eq(outbox.workspaceId, t.workspaceId))).toEqual(
        [],
      );
      expect(
        await server.deps.db
          .select()
          .from(reversibleActions)
          .where(eq(reversibleActions.workspaceId, t.workspaceId)),
      ).toEqual([]);
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(await bodiesIn(t.sales)).not.toContain("asked once");
    },
    SERVER_TEST_MS,
  );
});

describe("a post with an undo window", () => {
  test(
    "it goes out once when the deadline passes, by the agent, and the receipt then points at the message",
    async () => {
      const t = await team();
      const row = await queuePost(t, "Open on Saturday");
      // Before the deadline a pass delivers nothing.
      expect(await deliverDue(server.deps)).toBe(0);
      expect(await bodiesIn(t.sales)).not.toContain("Open on Saturday");
      later();
      expect(await deliverDue(server.deps)).toBe(1);
      const posted = (
        await server.deps.db.select().from(messages).where(eq(messages.channelId, t.sales))
      ).find((m) => m.body === "Open on Saturday");
      if (!posted) throw new Error("not posted");
      expect(posted).toMatchObject({ authorKind: "agent", authorId: t.agentId });
      expect(await rowOf(row.id)).toMatchObject({ status: "sent", sentAt: clock, error: null });
      expect((await actionOf(row.id))?.target).toEqual({ type: "message", id: posted.id, title: "#sales" });
      // Another pass doesn't send it again.
      expect(await deliverDue(server.deps)).toBe(0);
      expect((await bodiesIn(t.sales)).filter((b) => b === "Open on Saturday")).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "undo within the window: nothing goes out, not even after the deadline; again, the same answer; late, a 409",
    async () => {
      const t = await team();
      const row = await queuePost(t, "Promo");
      // An item of another workspace isn't canceled by its id.
      const other = await team();
      expect(cancelQueued(server.deps, other.workspaceId, row.id, other.ana.user.id)).rejects.toMatchObject({
        status: 409,
      });
      expect((await rowOf(row.id))?.status).toBe("pending");

      await cancelQueued(server.deps, t.workspaceId, row.id, t.beto.user.id);
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(await bodiesIn(t.sales)).not.toContain("Promo");
      expect(await rowOf(row.id)).toMatchObject({ status: "canceled", canceledByUserId: t.beto.user.id });
      // Undoing again answers what it is: canceled.
      expect(await cancelQueued(server.deps, t.workspaceId, row.id, t.beto.user.id)).toBeUndefined();
      // Too late is a 409: it went out.
      const sent = await queuePost(t, "Out already");
      later();
      await deliverDue(server.deps);
      expect(cancelQueued(server.deps, t.workspaceId, sent.id, t.beto.user.id)).rejects.toMatchObject({
        status: 409,
        code: "action.changed_since",
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "the right is checked when it goes out: the agent taken out of a private channel doesn't post there",
    async () => {
      const t = await team();
      const secret = await seedChannel(server, t.workspaceId, {
        name: `secret${n}`,
        visibility: "private",
        members: [t.ana],
      });
      await server.deps.db
        .insert(channelMemberships)
        .values({ channelId: secret, memberType: "agent", memberId: t.agentId });
      const row = await queuePost(t, "leaked", secret);
      // Within the window the owner takes the agent out of the private channel.
      await server.deps.db
        .delete(channelMemberships)
        .where(and(eq(channelMemberships.channelId, secret), eq(channelMemberships.memberId, t.agentId)));
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(await bodiesIn(secret)).not.toContain("leaked");
      expect((await rowOf(row.id))?.status).toBe("failed");
      expect(String((await actionOf(row.id))?.params.failed)).toContain("can no longer post");
    },
    SERVER_TEST_MS,
  );

  test(
    "an agent archived, or a channel archived or deleted, during the window: the post doesn't go out",
    async () => {
      const t = await team();
      const byArchivedAgent = await queuePost(t, "after the archive");
      await server.deps.db.update(agents).set({ archivedAt: clock }).where(eq(agents.id, t.agentId));
      later();
      await deliverDue(server.deps);
      expect(await bodiesIn(t.sales)).not.toContain("after the archive");
      expect((await rowOf(byArchivedAgent.id))?.error).toBe("The agent can no longer post in this channel");

      const u = await team();
      const archived = await queuePost(u, "into an archived channel");
      await server.deps.db
        .update(schema.channels)
        .set({ archivedAt: clock })
        .where(eq(schema.channels.id, u.sales));
      const gone = await queuePost(u, "into a deleted channel", u.general);
      await server.deps.db.delete(schema.channels).where(eq(schema.channels.id, u.general));
      later();
      await deliverDue(server.deps);
      expect(await rowOf(archived.id)).toMatchObject({ status: "failed", error: "The channel is gone" });
      // Deleting the channel took the agent's answer and its receipt with it; the row still fails.
      expect(await rowOf(gone.id)).toMatchObject({ status: "failed", error: "The channel is gone" });
    },
    SERVER_TEST_MS,
  );

  test(
    "a saved payload that isn't a post fails instead of posting half of it",
    async () => {
      const t = await team();
      const row = await queuePost(t, "fine");
      await server.deps.db
        .update(outbox)
        .set({ payload: { channelId: t.sales } })
        .where(eq(outbox.id, row.id));
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(await rowOf(row.id)).toMatchObject({ status: "failed", error: "The queued send is malformed" });
    },
    SERVER_TEST_MS,
  );

  test(
    "N passes at once and N cancels racing a pass: each item goes out at most once, and never canceled too",
    async () => {
      const t = await team();
      const row = await queuePost(t, "only once");
      later();
      const counts = await Promise.all(Array.from({ length: 8 }, () => deliverDue(server.deps)));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      expect((await bodiesIn(t.sales)).filter((b) => b === "only once")).toHaveLength(1);
      expect((await rowOf(row.id))?.status).toBe("sent");

      const raced = await queuePost(t, "cancel or send");
      later();
      const outcome = await Promise.allSettled([
        deliverDue(server.deps),
        ...Array.from({ length: 4 }, () =>
          cancelQueued(server.deps, t.workspaceId, raced.id, t.beto.user.id),
        ),
      ]);
      const canceled = outcome.slice(1).filter((o) => o.status === "fulfilled").length;
      const status = (await rowOf(raced.id))?.status;
      const posted = (await bodiesIn(t.sales)).filter((b) => b === "cancel or send").length;
      expect({ status, canceled, posted }).toEqual(
        status === "canceled"
          ? // Every undo answers canceled; only one of them made it so.
            { status, canceled: 4, posted: 0 }
          : { status: "sent", canceled: 0, posted: 1 },
      );
    },
    SERVER_TEST_MS,
  );

  test(
    "an item whose deadline moved after a pass read it is not taken before its time",
    async () => {
      const t = await team();
      const row = await queuePost(t, "not yet");
      later();
      // The pass reads the due list; before it claims, the item's deadline moves past the clock.
      const db = afterDueRead(server.deps, () =>
        server.deps.db
          .update(outbox)
          .set({ sendAt: new Date(clock.getTime() + WINDOW_MS) })
          .where(eq(outbox.id, row.id)),
      );
      expect(await deliverDue({ ...server.deps, db })).toBe(0);
      expect(await rowOf(row.id)).toMatchObject({ status: "pending" });
      expect(await bodiesIn(t.sales)).not.toContain("not yet");
    },
    SERVER_TEST_MS,
  );

  test(
    "one pass delivers at most a batch; the next one takes the rest",
    async () => {
      const t = await team();
      for (let i = 0; i <= DELIVER_BATCH; i++) await queuePost(t, `batch ${i}`);
      later();
      expect(await deliverDue(server.deps)).toBe(DELIVER_BATCH);
      expect(await deliverDue(server.deps)).toBe(1);
    },
    SERVER_TEST_MS * 2,
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
    const queueMail = async (deps: AppDeps = withWakeAt([])) => {
      const usageId = await reserveUsage(server.deps, {
        workspaceId: t.workspaceId,
        agentId: t.agentId,
        resourceId: account.id,
        kind: "mail_send",
        cap: 5,
      });
      if (!usageId) throw new Error("no quota");
      const raw = `From: ${mail.user}\r\nTo: joao@client.test\r\nSubject: Order\r\n\r\nPacked the boxes.\r\n`;
      return queueSend(t.ctx(deps), {
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
    return { ...t, account, queueMail, reserved };
  }

  test(
    "it can be undone only until it goes out; it goes out once at the deadline and keeps the quota",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      const action = await actionOf(row.id);
      expect(action).toMatchObject({
        kind: "mail_sent",
        target: { type: "outbox", title: "joao@client.test" },
      });
      expect(action?.revertibleUntil).toEqual(row.sendAt);
      expect(mail.sent).toEqual([]);
      later();
      expect(await deliverDue(server.deps)).toBe(1);
      expect(mail.sent.map((s) => s.to)).toEqual([["joao@client.test"]]);
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toHaveLength(1);
      expect(await t.reserved()).toBe(1);
      expect(cancelQueued(server.deps, t.workspaceId, row.id, t.beto.user.id)).rejects.toMatchObject({
        code: "action.changed_since",
      });
    },
    SERVER_TEST_MS,
  );

  test(
    "undo within the window: the email doesn't go out and the quota comes back",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      expect(await t.reserved()).toBe(1);
      await cancelQueued(server.deps, t.workspaceId, row.id, t.beto.user.id);
      expect(await t.reserved()).toBe(0);
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "the mailbox taken from the agent during the window: nothing goes out, the receipt says so, the quota comes back",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      await setAgentMailbox(server.deps, t.workspaceId, t.agentId, t.account, { level: "none" });
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toEqual([]);
      expect((await rowOf(row.id))?.status).toBe("failed");
      expect(await t.reserved()).toBe(0);
      expect(String((await actionOf(row.id))?.params.failed)).toContain("no longer available");
    },
    SERVER_TEST_MS,
  );

  test(
    "a send that fails before going out gives the quota back once and isn't tried again",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const first = await t.queueMail();
      const second = await t.queueMail();
      expect(await t.reserved()).toBe(2);
      // The password was changed on the mail server: the login is rejected and nothing goes out.
      const sealer = createSealer(server.deps.config.authSecret, "mail");
      const sealed = t.account.secret;
      if (!sealed) throw new Error("no secret");
      const secret = sealer.seal(JSON.stringify({ ...JSON.parse(sealer.open(sealed)), password: "rotated" }));
      await server.deps.db
        .update(schema.mailConnections)
        .set({ secret })
        .where(eq(schema.mailConnections.id, t.account.id));
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect((await rowOf(first.id))?.status).toBe("failed");
      expect((await rowOf(second.id))?.status).toBe("failed");
      expect(await t.reserved()).toBe(0);
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "it went out and saving that failed: it is sent, never sent again, and the quota stays spent",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      later();
      await deliverDue({ ...server.deps, db: failingSentWrite(server.deps) });
      expect(mail.sent).toHaveLength(1);
      expect(await rowOf(row.id)).toMatchObject({ status: "sent", error: "connection lost" });
      expect((await actionOf(row.id))?.params.failed).toBeUndefined();
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toHaveLength(1);
      expect(await t.reserved()).toBe(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "it went out and the database is gone for every write after it: the item stays claimed, never sent again",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      later();
      await expect(deliverDue({ ...server.deps, db: failingSentWrite(server.deps, true) })).rejects.toThrow(
        "connection lost",
      );
      expect(mail.sent).toHaveLength(1);
      expect((await rowOf(row.id))?.status).toBe("sending");
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toHaveLength(1);
    },
    SERVER_TEST_MS,
  );

  test(
    "a cancel whose quota can't come back changes nothing; retried, it cancels once and gives the quota back once",
    async () => {
      const t = await mailbox();
      const row = await t.queueMail();
      const broken = { ...server.deps, db: failingQuotaDelete(server.deps) };
      await expect(cancelQueued(broken, t.workspaceId, row.id, t.beto.user.id)).rejects.toThrow(
        "quota connection lost",
      );
      expect((await rowOf(row.id))?.status).toBe("pending");
      expect(await t.reserved()).toBe(1);
      await cancelQueued(server.deps, t.workspaceId, row.id, t.beto.user.id);
      expect(await rowOf(row.id)).toMatchObject({ status: "canceled", canceledByUserId: t.beto.user.id });
      expect(await t.reserved()).toBe(0);
      // Canceling again answers the same and gives nothing back twice (another reservation stays).
      const other = await t.queueMail();
      await cancelQueued(server.deps, t.workspaceId, row.id, t.ana.user.id);
      expect(await rowOf(row.id)).toMatchObject({ status: "canceled", canceledByUserId: t.beto.user.id });
      expect(await t.reserved()).toBe(1);
      await cancelQueued(server.deps, t.workspaceId, other.id, t.beto.user.id);
    },
    SERVER_TEST_MS,
  );

  test(
    "a failure whose quota can't come back keeps the pair: the item stays claimed with its reservation, never sent",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      await setAgentMailbox(server.deps, t.workspaceId, t.agentId, t.account, { level: "none" });
      later();
      await expect(deliverDue({ ...server.deps, db: failingQuotaDelete(server.deps) })).rejects.toThrow(
        "quota connection lost",
      );
      expect((await rowOf(row.id))?.status).toBe("sending");
      expect(await t.reserved()).toBe(1);
      expect((await actionOf(row.id))?.params.failed).toBeUndefined();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(mail.sent).toEqual([]);
    },
    SERVER_TEST_MS,
  );

  test(
    "a saved email that isn't one fails instead of going out",
    async () => {
      const t = await mailbox();
      mail.sent.length = 0;
      const row = await t.queueMail();
      const [saved] = await server.deps.db.select().from(outbox).where(eq(outbox.id, row.id));
      await server.deps.db
        .update(outbox)
        .set({ payload: { ...saved?.payload, envelope: { from: mail.user, to: "joao@client.test" } } })
        .where(eq(outbox.id, row.id));
      later();
      expect(await deliverDue(server.deps)).toBe(0);
      expect(await rowOf(row.id)).toMatchObject({ status: "failed", error: "The queued send is malformed" });
      expect(mail.sent).toEqual([]);
    },
    SERVER_TEST_MS,
  );
});

describe("stopping the server", () => {
  test(
    "a pass in progress finishes its writes before the database closes",
    async () => {
      const own = await startTestServer({ env: { UNDO_SEND_SECONDS: "30" }, now: () => clock });
      const ana = await signedIn(own, "Ana", email("ana"));
      const { workspaceId, general } = await seedWorkspace(own, ana, "Stop");
      const agentId = newId("agt");
      await own.deps.db.insert(agents).values({
        id: agentId,
        workspaceId,
        name: "Lia",
        handle: "lia",
        model: "claude-haiku-5-5",
        ownerUserId: ana.user.id,
        appearance: { color: "blue", eyes: "dot", adornment: "none" },
      });
      await own.deps.db.insert(outbox).values({
        id: newId("out"),
        workspaceId,
        agentId,
        runId: null,
        kind: "post",
        payload: { channelId: general, text: "before the stop", clientId: "c-stop" },
        sendAt: clock,
      });
      const hold = holdSentWrite(own.deps);
      // The runtime's tick tracks the pass, as S6 does.
      own.deps.runtime.track(deliverDue({ ...own.deps, db: hold.db }), "outbox");
      await hold.begun;
      let stopped = false;
      const stopping = own.stop().then(() => {
        stopped = true;
      });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(false);
      hold.release();
      await stopping;
      expect(hold.wrote()).toBe(true);
    },
    SERVER_TEST_MS,
  );
});

// biome-ignore lint/suspicious/noExplicitAny: the doubles wrap drizzle's builders, whatever their type
type Any = any;

/** The database where saving `sent` on the outbox fails (and, with `allWrites`, every outbox write after it). */
function failingSentWrite(deps: AppDeps, allWrites = false): AppDeps["db"] {
  let sent = false;
  return new Proxy(deps.db, {
    get(target, prop) {
      if (prop !== "update") return Reflect.get(target, prop, target);
      return (table: Any) => {
        const builder: Any = target.update(table);
        if (table !== outbox) return builder;
        return {
          set(values: Any) {
            if (values.status === "sent" && (!sent || allWrites)) {
              sent = true;
              throw new Error("connection lost");
            }
            if (allWrites && sent) throw new Error("connection lost");
            return builder.set(values);
          },
        };
      };
    },
  });
}

/** The database where saving `sent` on the outbox waits for `release`; `begun` says it is waiting. */
function holdSentWrite(deps: AppDeps) {
  let started!: () => void;
  let release!: () => void;
  let done = false;
  const begun = new Promise<void>((r) => {
    started = r;
  });
  const until = new Promise<void>((r) => {
    release = r;
  });
  const db = new Proxy(deps.db, {
    get(target, prop) {
      if (prop !== "update") return Reflect.get(target, prop, target);
      return (table: Any) => {
        const builder: Any = target.update(table);
        if (table !== outbox) return builder;
        return {
          set(values: Any) {
            const query: Any = builder.set(values);
            if (values.status !== "sent") return query;
            return {
              where(...args: Any[]) {
                const q: Promise<unknown> = query.where(...args);
                started();
                return until
                  .then(() => q)
                  .then((v) => {
                    done = true;
                    return v;
                  });
              },
            };
          },
        };
      };
    },
  });
  return { db, begun, release, wrote: () => done };
}

/** The database whose transactions fail to give a quota reservation back (the delete of integration_usage). */
function failingQuotaDelete(deps: AppDeps): AppDeps["db"] {
  return new Proxy(deps.db, {
    get(target, prop) {
      if (prop !== "transaction") return Reflect.get(target, prop, target);
      return (fn: (tx: Any) => Promise<unknown>) =>
        target.transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(inner, key) {
                if (key !== "delete") return Reflect.get(inner, key, inner);
                return (table: Any) => {
                  if (table === integrationUsage) throw new Error("quota connection lost");
                  return inner.delete(table);
                };
              },
            }),
          ),
        );
    },
  });
}

/** The database where `run` happens right after a pass read the due list, before it claims anything. */
function afterDueRead(deps: AppDeps, run: () => Promise<unknown>): AppDeps["db"] {
  let done = false;
  return new Proxy(deps.db, {
    get(target, prop) {
      if (prop !== "select") return Reflect.get(target, prop, target);
      return (fields: Any) => {
        const query: Any = target.select(fields);
        return {
          from(table: Any) {
            const q: Any = query.from(table);
            if (table !== outbox || done) return q;
            return {
              where: (...w: Any[]) => ({
                orderBy: (...o: Any[]) => ({
                  limit: async (n: number) => {
                    const rows = await q
                      .where(...w)
                      .orderBy(...o)
                      .limit(n);
                    done = true;
                    await run();
                    return rows;
                  },
                }),
              }),
            };
          },
        };
      };
    },
  });
}
