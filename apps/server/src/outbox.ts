// Sending with an undo window. An agent's email and post wait `UNDO_SEND_SECONDS` (30 s) in the outbox table
// before they go out: the receipt in the conversation shows the deadline and "Undo" cancels, and then nothing
// goes out. It is what makes a K2 really undoable (once out, an email is K3).
//
// The runtime delivers: a timer set for `sendAt` and, if the server restarts in between, the tick's sweep
// (both through `runtime.track`, so a stopping server waits for the pass before the database closes).
// Delivering and canceling race for the same row on `status = 'pending'` in one conditional UPDATE: only one
// wins, so undoing in the last second while it goes out never sends anything halfway. A delivery that broke in
// the middle stays `sending` and is never repeated (for email, at most once is the safe side). With a window of
// 0 (config), the tools send at once, without coming here.
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { agentCanPost } from "./channels";
import { type AppDeps, requireRuntime } from "./context";
import type { ToolContext } from "./forward-types";
import { HttpError } from "./http";
import { mailboxesOf, sentOutOf, transmitMail } from "./integrations/mail";
import { releaseUsage } from "./integrations/usage";
import { log } from "./logger";
import { postMessage, publishActions } from "./messages";

const { outbox, reversibleActions, agents, channels, mailConnections } = schema;

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

/**
 * Queues the send and records the undoable action that goes in the receipt. The email can only be undone until
 * it goes out; the post, once out, can still be retracted (the usual undo). The send is woken by the runtime at
 * `sendAt`: without it (until slice S6) the call is rejected before anything is written.
 */
export async function queueSend(ctx: ToolContext, item: Item & { title: string }): Promise<OutboxRow> {
  const { db, now, config, runtime } = ctx.deps;
  requireRuntime(runtime, "wakeAt");
  const at = now();
  const sendAt = new Date(at.getTime() + config.undoSendMs);
  const payload: Record<string, unknown> = { ...item.payload };
  const [row] = await db
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
  if (!row) throw new Error("outbox insert returned nothing");
  await ctx.recordAction({
    kind: item.kind === "mail" ? "mail_sent" : "message_posted",
    target: { type: "outbox", id: row.id, title: item.title },
    params: { outboxId: row.id, sendAt: sendAt.toISOString() },
    ...(item.kind === "mail" ? { revertibleUntil: sendAt } : {}),
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
      log.warn("outbox.delivery_failed", { id: row.id, kind: row.kind, error });
      await db.update(outbox).set({ status: "failed", error }).where(eq(outbox.id, row.id));
      await db
        .update(reversibleActions)
        .set({
          params: sql`${reversibleActions.params} || ${JSON.stringify({ failed: error.slice(0, 300) })}::jsonb`,
        })
        .where(sql`${reversibleActions.params}->>'outboxId' = ${row.id}`);
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
  const { message } = await postMessage(deps, {
    workspaceId: row.workspaceId,
    channel,
    author: { type: "agent", id: row.agentId },
    body: item.text,
    clientId: item.clientId,
  });
  // Out: the action now points at the message, and undo becomes retract (as it always was).
  await db
    .update(reversibleActions)
    .set({
      target: sql`jsonb_build_object('type', 'message', 'id', ${message.id}::text, 'title', ${reversibleActions.target}->>'title')`,
    })
    .where(sql`${reversibleActions.params}->>'outboxId' = ${row.id}`);
}

async function deliverMail(deps: AppDeps, row: OutboxRow) {
  const { db } = deps;
  const item = payloadOf(row, mailItem);
  const [account] = await db
    .select()
    .from(mailConnections)
    .where(and(eq(mailConnections.id, item.accountId), eq(mailConnections.workspaceId, row.workspaceId)));
  // The mailbox may have been taken from the agent (or disconnected) during the window.
  const box = (await mailboxesOf(db, row.agentId)).find((b) => b.accountId === item.accountId);
  if (account?.status !== "active" || !box || box.level === "none") {
    await releaseUsage(deps, item.usageId);
    throw new Error("The mailbox is no longer available to this agent");
  }
  try {
    await transmitMail(deps, account, item.envelope, item.raw);
  } catch (err) {
    if (!sentOutOf(err)) await releaseUsage(deps, item.usageId);
    throw err;
  }
}

/**
 * Undo within the window: cancels, and nothing goes out. Already out (or going out): 409, and whoever undoes sees
 * it came too late. Only an item of the caller's workspace; who may undo the action is the caller's check.
 */
export async function cancelQueued(
  deps: AppDeps,
  workspaceId: string,
  id: string,
  byUserId: string,
): Promise<void> {
  const [row] = await deps.db
    .update(outbox)
    .set({ status: "canceled", canceledByUserId: byUserId })
    .where(and(eq(outbox.id, id), eq(outbox.workspaceId, workspaceId), eq(outbox.status, "pending")))
    .returning();
  if (!row) throw new HttpError(409, "action.changed_since", "It already went out");
  if (row.kind === "mail") {
    const parsed = mailItem.safeParse(row.payload);
    if (parsed.success) await releaseUsage(deps, parsed.data.usageId);
  }
}

/** The conversation's receipt follows: sent, failed. */
async function publishFor(deps: AppDeps, outboxId: string) {
  const [action] = await deps.db
    .select({ messageId: reversibleActions.messageId })
    .from(reversibleActions)
    .where(sql`${reversibleActions.params}->>'outboxId' = ${outboxId}`);
  if (action?.messageId) await publishActions(deps, action.messageId);
}
