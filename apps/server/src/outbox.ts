// Sending with an undo window. An agent's email and post wait `UNDO_SEND_SECONDS` (30 s) in the outbox table
// before they go out: the receipt in the conversation shows the deadline and "Undo" cancels, and then nothing
// goes out. It is what makes a K2 really undoable (once out, an email is K3).
//
// The runtime delivers: a timer set for `sendAt` and, if the server restarts in between, the tick's sweep
// (both through `runtime.track`, so a stopping server waits for the pass before the database closes).
// Delivering and canceling race for the same row on `status = 'pending'` in one conditional UPDATE: only one
// wins, so undoing in the last second while it goes out never sends anything halfway. A send that broke in
// the middle stays `sending` and is never repeated (for email, at most once is the safe side). With a window of
// 0 (config), the tools send at once, without coming here.
import type { AgentAction, AgentActionKind } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentRow } from "./agents";
import { agentCanPost } from "./channels";
import { type AppDeps } from "./context";
import { HttpError } from "./http";
import { mailboxesOf, sentOutOf, transmitMail } from "./integrations/mail";
import { actionMode } from "./integrations/mail-rules";
import { log } from "./logger";
import { postMessage, publishActions } from "./messages";

const { outbox, reversibleActions, agents, channels, mailConnections, integrationUsage, messages } = schema;

export type OutboxRow = typeof outbox.$inferSelect;

const mailItem = z.object({
  accountId: z.string().min(1),
  envelope: z.object({ from: z.string().min(1), to: z.array(z.string().min(1)).min(1) }),
  raw: z.string(),
  /** Reservation of the daily send quota: it goes back if the send is canceled or fails before going out. */
  usageId: z.string().min(1),
});
const postItem = z.object({
  channelId: z.string().min(1),
  text: z.string(),
  clientId: z.string().min(1),
});

export type MailItem = z.infer<typeof mailItem>;
export type PostItem = z.infer<typeof postItem>;

type Item = { kind: "mail"; payload: MailItem } | { kind: "post"; payload: PostItem };

/** How many due items one pass delivers (the next pass takes the rest). */
export const DELIVER_BATCH = 50;

/** What `queueSend` reads of the run that asks for a send (a `runtime/tools` context fits it). */
export interface OutboxRun {
  deps: AppDeps;
  workspaceId: string;
  agent: Pick<AgentRow, "id">;
  runId: string;
  /**
   * Records an action a person can undo; the receipt goes with the agent's next message. With `tx`, the action is
   * written in that transaction (the outbox's: the queued send and its receipt exist together or not at all).
   */
  recordAction(
    action: {
      kind: AgentActionKind;
      target: AgentAction["target"];
      params?: Record<string, unknown>;
      /** Until when it can be undone; by default, the usual window (24 h). */
      revertibleUntil?: Date;
    },
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  ): Promise<void>;
}

/**
 * Queues the send and records the undoable action that goes in the receipt. The email can only be undone until
 * it goes out; the post, once out, can still be retracted (the usual undo). The send is woken by the runtime at
 * `sendAt`.
 */
export async function queueSend(ctx: OutboxRun, item: Item & { title: string }): Promise<OutboxRow> {
  const { db, now, config, runtime } = ctx.deps;
  const at = now();
  const sendAt = new Date(at.getTime() + config.undoSendMs);
  const payload: Record<string, unknown> = { ...item.payload };
  // The item and its receipt in one transaction: a request that failed leaves nothing that goes out later.
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(outbox)
      .values({
        id: newId("out"),
        workspaceId: ctx.workspaceId,
        agentId: ctx.agent.id,
        runId: ctx.runId,
        kind: item.kind,
        payload,
        sendAt,
        createdAt: at,
      })
      .returning();
    if (!inserted) throw new Error("outbox insert returned nothing");
    await ctx.recordAction(
      {
        kind: item.kind === "mail" ? "mail_sent" : "message_posted",
        target: { type: "outbox", id: inserted.id, title: item.title },
        params: { outboxId: inserted.id, sendAt: sendAt.toISOString() },
        ...(item.kind === "mail" ? { revertibleUntil: sendAt } : {}),
      },
      tx,
    );
    return inserted;
  });
  runtime.wakeAt(sendAt);
  return row;
}

/** Delivers what is due (the tick calls it; the send's timer too). Returns how many went out. */
export async function deliverDue(deps: AppDeps): Promise<number> {
  const due = await deps.db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.status, "pending"), lte(outbox.sendAt, deps.now())))
    .orderBy(asc(outbox.sendAt))
    .limit(DELIVER_BATCH);
  let sent = 0;
  for (const { id } of due) if (await deliver(deps, id)) sent++;
  // Receipt writes may fail after publication. Recover their targets from the persisted clientId on every
  // pass, including passes with nothing left to send; this never repeats the publication.
  try {
    const retargeted = await deps.db
      .update(reversibleActions)
      .set({
        target: sql`jsonb_build_object('type', 'message', 'id', ${messages.id}, 'title', ${reversibleActions.target}->>'title')`,
      })
      .from(outbox)
      .innerJoin(
        messages,
        and(
          eq(messages.workspaceId, outbox.workspaceId),
          eq(messages.channelId, sql`${outbox.payload}->>'channelId'`),
          eq(messages.authorKind, "agent"),
          eq(messages.authorId, outbox.agentId),
          eq(messages.clientId, sql`${outbox.payload}->>'clientId'`),
        ),
      )
      .where(
        and(
          eq(outbox.kind, "post"),
          inArray(outbox.status, ["sending", "sent"]),
          eq(reversibleActions.workspaceId, outbox.workspaceId),
          sql`${reversibleActions.params}->>'outboxId' = ${outbox.id}`,
          sql`${reversibleActions.target}->>'type' = 'outbox'`,
        ),
      )
      .returning({ messageId: reversibleActions.messageId });
    for (const { messageId } of retargeted) if (messageId) await publishActions(deps, messageId);
  } catch (err) {
    log.warn("outbox.receipt_update_failed", { err });
  }
  return sent;
}

async function deliver(deps: AppDeps, id: string): Promise<boolean> {
  const { db } = deps;
  // The claim: one statement, so two passes (or two servers) never take the same item.
  const [row] = await db
    .update(outbox)
    .set({ status: "sending" })
    .where(and(eq(outbox.id, id), eq(outbox.status, "pending"), lte(outbox.sendAt, deps.now())))
    .returning();
  if (!row) return false;
  let ok = true;
  let out = false;
  try {
    if (row.kind === "post") await deliverPost(deps, row);
    else await deliverMail(deps, row);
    out = true;
    await db.update(outbox).set({ status: "sent", sentAt: deps.now() }).where(eq(outbox.id, row.id));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (out || sentOutOf(err)) {
      // It went out and something after it failed (the copy in Sent, the session closing, saving the state):
      // it is sent, never sent again, and the receipt doesn't say it failed.
      log.warn("outbox.sent_with_error", { id: row.id, error });
      await db.update(outbox).set({ status: "sent", sentAt: deps.now(), error }).where(eq(outbox.id, row.id));
    } else {
      ok = false;
      log.warn("outbox.send_failed", { id: row.id, kind: row.kind, error });
      // Failed (or rejected when it was to go out): the state, the quota coming back and the receipt saying so are
      // one transaction, so the reservation never comes back without the item failing, nor stays held after it.
      await db.transaction(async (tx) => {
        await tx.update(outbox).set({ status: "failed", error }).where(eq(outbox.id, row.id));
        await giveQuotaBack(tx, row);
        await tx
          .update(reversibleActions)
          .set({
            params: sql`${reversibleActions.params} || ${JSON.stringify({ failed: error.slice(0, 300) })}::jsonb`,
          })
          .where(sql`${reversibleActions.params}->>'outboxId' = ${row.id}`);
      });
    }
  }
  await publishFor(deps, row.id);
  return ok;
}

/** The saved payload, checked: a row that doesn't hold what this kind needs fails instead of half-sending. */
function payloadOf<T>(row: OutboxRow, shape: z.ZodType<T>): T {
  const parsed = shape.safeParse(row.payload);
  if (!parsed.success) throw new Error("The queued send is malformed");
  return parsed.data;
}

async function deliverPost(deps: AppDeps, row: OutboxRow) {
  const { db } = deps;
  const item = payloadOf(row, postItem);
  const [channel] = await db.select().from(channels).where(eq(channels.id, item.channelId));
  if (!channel || channel.archivedAt || channel.workspaceId !== row.workspaceId)
    throw new Error("The channel is gone");
  // In the window the agent may have left the private channel (or been archived): the right is checked when it
  // goes out, like the mailbox's.
  const [agent] = await db
    .select({ archivedAt: agents.archivedAt })
    .from(agents)
    .where(eq(agents.id, row.agentId));
  if (!agent || agent.archivedAt || !(await agentCanPost(db, channel, row.agentId)))
    throw new Error("The agent can no longer post in this channel");
  try {
    await postMessage(deps, {
      workspaceId: row.workspaceId,
      channel,
      author: { type: "agent", id: row.agentId },
      body: item.text,
      clientId: item.clientId,
    });
  } catch (err) {
    // Indexing or notifications can reject after the INSERT. A persisted post is still a sent item.
    const [posted] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, row.workspaceId),
          eq(messages.channelId, item.channelId),
          eq(messages.authorKind, "agent"),
          eq(messages.authorId, row.agentId),
          eq(messages.clientId, item.clientId),
        ),
      );
    if (!posted) throw err;
    log.warn("outbox.post_sent_with_error", { id: row.id, messageId: posted.id, err });
  }
}

async function deliverMail(deps: AppDeps, row: OutboxRow) {
  const { db } = deps;
  const item = payloadOf(row, mailItem);
  const [agent] = await db
    .select({ archivedAt: agents.archivedAt })
    .from(agents)
    .where(and(eq(agents.id, row.agentId), eq(agents.workspaceId, row.workspaceId)));
  if (!agent || agent.archivedAt) throw new Error("The agent can no longer send email");
  const [account] = await db
    .select()
    .from(mailConnections)
    .where(and(eq(mailConnections.id, item.accountId), eq(mailConnections.workspaceId, row.workspaceId)));
  // The mailbox may have been taken from the agent (or disconnected) during the window.
  const box = (await mailboxesOf(db, row.agentId)).find((b) => b.accountId === item.accountId);
  // Rejected here, or failing before it got out: the failure path gives the quota back with the state.
  if (
    account?.status !== "active" ||
    !box ||
    actionMode({
      action: "send",
      level: box.level,
      deletable: box.deletable,
      policy: box.policy,
      disabledActions: account.disabledActions,
      confirmActions: account.confirmActions,
      recipients: item.envelope.to,
    }) === "off"
  )
    throw new Error("The mailbox is no longer available to this agent");
  await transmitMail(deps, account, item.envelope, item.raw);
}

type Tx = Parameters<Parameters<AppDeps["db"]["transaction"]>[0]>[0];

/** Gives an email's quota reservation back, in the caller's transaction (a post holds none). */
async function giveQuotaBack(tx: Tx, row: OutboxRow) {
  if (row.kind !== "mail") return;
  const parsed = mailItem.safeParse(row.payload);
  if (parsed.success) await tx.delete(integrationUsage).where(eq(integrationUsage.id, parsed.data.usageId));
}

/**
 * Undo within the window: cancels, and nothing goes out. Canceling and giving the quota back are one transaction.
 * Canceling again is the same answer (it was canceled) and never gives the quota back twice. Already out (or going
 * out): 409, and whoever undoes sees it came too late. Only an item of the caller's workspace; who may undo the
 * action is the caller's check.
 */
export async function cancelQueued(
  deps: AppDeps,
  workspaceId: string,
  id: string,
  actorUserId: string,
): Promise<void> {
  const canceled = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(outbox)
      .set({ status: "canceled", canceledByUserId: actorUserId })
      .where(and(eq(outbox.id, id), eq(outbox.workspaceId, workspaceId), eq(outbox.status, "pending")))
      .returning();
    if (row) await giveQuotaBack(tx, row);
    return row !== undefined;
  });
  if (canceled) return;
  const [now] = await deps.db
    .select({ status: outbox.status })
    .from(outbox)
    .where(and(eq(outbox.id, id), eq(outbox.workspaceId, workspaceId)));
  if (now?.status === "canceled") return;
  throw new HttpError(409, "action.changed_since", "It already went out");
}

/** The conversation's receipt follows: sent, failed. */
async function publishFor(deps: AppDeps, outboxId: string) {
  const [action] = await deps.db
    .select({ messageId: reversibleActions.messageId })
    .from(reversibleActions)
    .where(sql`${reversibleActions.params}->>'outboxId' = ${outboxId}`);
  if (action?.messageId) await publishActions(deps, action.messageId);
}
