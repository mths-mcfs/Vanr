// Delivery outside the app: push and the "waiting for you" email. Notifying schedules (one pending row per
// notification and channel, at the right time after the quiet hours) and the tick, or the notify itself when
// the time already came, takes the due rows with `FOR UPDATE SKIP LOCKED`. Before sending, everything is
// checked again: the notification may have been read, resolved or snoozed, and the person may have changed
// their preferences.
import type { AppNotification, NotificationSettings } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { dueAt, silenceUntil, wantsChannel } from "@vanr/engine/notify-rules";
import { PRODUCT } from "@vanr/product";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { AppDeps } from "./context";
import { log } from "./logger";
import { requestEnded, requestStates, waitingKeyOf } from "./notify-requests";
import { settingsFor, timezoneFor } from "./notify-settings";
import { emailText, notificationPath, pushText } from "./notify-text";

const { notificationDeliveries, notifications, pushSubscriptions, members, users, agents, workspaces } =
  schema;
type Row = typeof notifications.$inferSelect;
type Delivery = typeof notificationDeliveries.$inferSelect;
type Channel = "push" | "email";

const BATCH = 50;
/**
 * A row stuck in "sending" (the process died halfway) goes back to the queue after this. The deadline counts
 * from the last renewal, which happens before each delivery, not from the start of the batch.
 */
const STUCK_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
/**
 * A new attempt of an email goes out only while the provider still keeps its idempotency key (Resend keeps
 * it 24 hours): past this age the attempt could send a second email, so the delivery ends failed with
 * `email_outcome_unknown` instead. An email a day late is worth less than the risk of sending it twice. The
 * age counts from the delivery's `createdAt`, an upper bound of the first attempt (the exact time of the
 * first attempt needs a column, for when the schema opens): after a very long postponement (quiet hours, do
 * not disturb) a retry of a first attempt that failed in a retryable way is dropped, and the person goes
 * without that email (the notification stays in the app). The first attempt is never rejected for its age.
 * The hour of margin covers the backoff between attempts and the clocks.
 */
const EMAIL_RETRY_MAX_AGE_MS = 23 * 3600_000;
/** A subscription that fails this many times in a row (other than 404/410) is removed. */
const MAX_SUB_FAILURES = 5;

const channelIdOf = (row: Row) => (typeof row.source.channelId === "string" ? row.source.channelId : null);

/**
 * Schedules push and email for the notification that just changed. One pending row per notification and
 * channel: a burst of the same notification goes out as a single one. The email goes out once per episode
 * (since `createdAt`). `reminder`: the person asked for the reminder, so the push goes out even from "FYI".
 */
export async function scheduleDeliveries(
  deps: AppDeps,
  row: Row,
  opts: { settings?: NotificationSettings; reminder?: boolean } = {},
): Promise<void> {
  if (row.doneAt) return;
  const settings = opts.settings ?? (await settingsFor(deps.db, row.workspaceId, row.userId));
  const view = {
    tab: row.tab,
    waiting: row.waiting,
    kind: row.kind as AppNotification["kind"],
    channelId: channelIdOf(row),
  };
  const channels: Channel[] = [];
  if (opts.reminder ? settings.push : wantsChannel("push", view, settings)) channels.push("push");
  if (!opts.reminder && wantsChannel("email", view, settings)) channels.push("email");
  if (channels.length === 0) return;
  const tz = await timezoneFor(deps.db, row.workspaceId, row.userId);
  const now = deps.now();
  let kick = false;
  for (const channel of channels) {
    if (channel === "email") {
      const [already] = await deps.db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.notificationId, row.id),
            eq(notificationDeliveries.channel, "email"),
            eq(notificationDeliveries.status, "sent"),
            sql`${notificationDeliveries.createdAt} >= ${row.createdAt.toISOString()}::timestamptz`,
          ),
        )
        .limit(1);
      if (already) continue;
    }
    const at = dueAt(channel, { critical: row.critical }, settings, tz, now);
    const inserted = await deps.db
      .insert(notificationDeliveries)
      .values({
        id: newId("ndl"),
        workspaceId: row.workspaceId,
        userId: row.userId,
        notificationId: row.id,
        channel,
        cause: opts.reminder ? "reminder" : "event",
        dueAt: at,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id });
    if (inserted.length > 0 && at <= now) kick = true;
  }
  // Already due: sends now in the background instead of waiting for the tick (tests wait with settle).
  if (kick) deps.runtime.track(drainDeliveries(deps), "notify.deliver");
}

/** Takes up to `BATCH` due deliveries, locked with SKIP LOCKED (another process takes the others). */
async function claim(deps: AppDeps): Promise<Delivery[]> {
  const now = deps.now();
  await deps.db
    .update(notificationDeliveries)
    .set({ status: "pending", lockedAt: null })
    .where(
      and(
        eq(notificationDeliveries.status, "sending"),
        lt(notificationDeliveries.lockedAt, new Date(now.getTime() - STUCK_MS)),
      ),
    );
  const due = deps.db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        sql`${notificationDeliveries.dueAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(notificationDeliveries.dueAt)
    .limit(BATCH)
    .for("update", { skipLocked: true });
  return deps.db
    .update(notificationDeliveries)
    .set({ status: "sending", lockedAt: now, attempts: sql`${notificationDeliveries.attempts} + 1` })
    .where(and(inArray(notificationDeliveries.id, due), eq(notificationDeliveries.status, "pending")))
    .returning();
}

type Outcome =
  | { status: "sent"; note?: string }
  | { status: "skipped"; note: string }
  | { status: "retry"; note: string }
  | { status: "failed"; note: string }
  | { status: "later"; at: Date; note: string };

export async function drainDeliveries(deps: AppDeps): Promise<number> {
  let total = 0;
  for (let round = 0; round < 10; round++) {
    const batch = await claim(deps);
    if (batch.length === 0) break;
    for (const d of batch) {
      // Renews this row's deadline; if another drain took it back already, it is no longer ours.
      if (!(await renew(deps, d))) continue;
      let outcome: Outcome;
      try {
        outcome = await deliver(deps, d);
      } catch (err) {
        log.error("notify.deliver_failed", { channel: d.channel, err });
        outcome = { status: "retry", note: "error" };
      }
      await finish(deps, d, outcome);
      if (outcome.status === "sent") total++;
    }
  }
  return total;
}

/**
 * Whoever took the row owns it while `attempts` is the claim's: every claim adds one, so a slow drain that
 * lost the row neither renews it nor writes over the other.
 */
const ownedBy = (d: Delivery) =>
  and(
    eq(notificationDeliveries.id, d.id),
    eq(notificationDeliveries.status, "sending"),
    eq(notificationDeliveries.attempts, d.attempts),
  );

async function renew(deps: AppDeps, d: Delivery): Promise<boolean> {
  const rows = await deps.db
    .update(notificationDeliveries)
    .set({ lockedAt: deps.now() })
    .where(ownedBy(d))
    .returning({ id: notificationDeliveries.id });
  return rows.length > 0;
}

async function finish(deps: AppDeps, d: Delivery, o: Outcome) {
  const now = deps.now();
  const set: Partial<Delivery> =
    o.status === "sent"
      ? { status: "sent", sentAt: now, lockedAt: null, note: o.note ?? null }
      : o.status === "skipped"
        ? { status: "skipped", lockedAt: null, note: o.note }
        : o.status === "failed"
          ? { status: "failed", lockedAt: null, note: o.note }
          : o.status === "later"
            ? { status: "pending", dueAt: o.at, lockedAt: null, attempts: d.attempts - 1, note: o.note }
            : d.attempts >= MAX_ATTEMPTS
              ? { status: "failed", lockedAt: null, note: o.note }
              : {
                  status: "pending",
                  lockedAt: null,
                  note: o.note,
                  dueAt: new Date(now.getTime() + 60_000 * 2 ** d.attempts),
                };
  await deps.db.update(notificationDeliveries).set(set).where(ownedBy(d));
}

async function deliver(deps: AppDeps, d: Delivery): Promise<Outcome> {
  const { db } = deps;
  const now = deps.now();
  const [row] = await db.select().from(notifications).where(eq(notifications.id, d.notificationId));
  if (!row) return { status: "skipped", note: "gone" };
  if (row.doneAt) return { status: "skipped", note: "done" };
  if (row.mutedUntil && row.mutedUntil > now) return { status: "skipped", note: "snoozed" };
  if (row.readAt) return { status: "skipped", note: "read" };
  // The request may have ended before the tick closed the notification: no notice of a resolved request.
  if (row.waiting) {
    const state = (await requestStates(db, [row])).get(waitingKeyOf(row));
    if (requestEnded(state, row.updatedAt, now)) return { status: "skipped", note: "request_closed" };
  }
  const [member] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, row.workspaceId), eq(members.userId, row.userId)));
  if (!member) return { status: "skipped", note: "not_member" };
  const settings = await settingsFor(db, row.workspaceId, row.userId);
  const view = {
    tab: row.tab,
    waiting: row.waiting,
    kind: row.kind as AppNotification["kind"],
    channelId: channelIdOf(row),
  };
  const reminder = d.cause === "reminder";
  const allowed = d.channel === "push" && reminder ? settings.push : wantsChannel(d.channel, view, settings);
  if (!allowed) return { status: "skipped", note: "preference" };
  // Quiet hours turned on after scheduling: waits until they end, unless it is critical.
  if (!row.critical) {
    const quiet = silenceUntil(settings, await timezoneFor(db, row.workspaceId, row.userId), now);
    if (quiet && quiet > now) return { status: "later", at: quiet, note: "quiet" };
  }
  const who = await actorName(deps, row);
  const n = {
    reason: row.reason as AppNotification["reason"],
    latest: row.latest,
    source: row.source,
  } as Pick<AppNotification, "reason" | "latest" | "source">;
  return d.channel === "push"
    ? sendPush(deps, row, settings, who, n)
    : sendEmail(deps, row, settings, who, n, d);
}

async function actorName(deps: AppDeps, row: Row): Promise<string> {
  const actor = row.actors[0];
  if (actor?.type === "agent") {
    const [a] = await deps.db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.id));
    if (a) return a.name;
  }
  if (actor?.type === "person") {
    const [u] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, actor.id));
    if (u) return u.name;
  }
  return row.source.label && typeof row.source.label === "string" ? row.source.label : PRODUCT.name;
}

async function sendPush(
  deps: AppDeps,
  row: Row,
  settings: NotificationSettings,
  who: string,
  n: Pick<AppNotification, "reason" | "latest" | "source">,
): Promise<Outcome> {
  const subs = await deps.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, row.userId));
  if (subs.length === 0) return { status: "skipped", note: "no_subscription" };
  const text = pushText(settings.locale, who, n);
  const payload = {
    ...text,
    url: notificationPath(row.workspaceId, row.id),
    tag: row.id,
    notificationId: row.id,
    workspaceId: row.workspaceId,
    critical: row.critical,
  };
  // Every device at once: the delivery lasts one send (10 s at most), not one per device.
  const statuses = await Promise.all(
    subs.map((sub) =>
      deps.push.send(sub, payload).catch((err) => {
        log.warn("push.send_failed", { err });
        return 0;
      }),
    ),
  );
  let ok = 0;
  let transient = 0;
  for (const [i, sub] of subs.entries()) {
    const status = statuses[i] ?? 0;
    if (status >= 200 && status < 300) {
      ok++;
      await deps.db
        .update(pushSubscriptions)
        .set({ failures: 0, lastSuccessAt: deps.now() })
        .where(eq(pushSubscriptions.id, sub.id));
    } else if (status === 404 || status === 410) {
      // The subscription died (permission revoked, browser cleared): trying again is useless.
      await deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    } else if (sub.failures + 1 >= MAX_SUB_FAILURES) {
      await deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
    } else {
      transient++;
      await deps.db
        .update(pushSubscriptions)
        .set({ failures: sub.failures + 1 })
        .where(eq(pushSubscriptions.id, sub.id));
    }
  }
  if (ok > 0) return { status: "sent", note: `${ok}/${subs.length}` };
  return transient > 0
    ? { status: "retry", note: "push_error" }
    : { status: "skipped", note: "subscriptions_gone" };
}

async function sendEmail(
  deps: AppDeps,
  row: Row,
  settings: NotificationSettings,
  who: string,
  n: Pick<AppNotification, "reason" | "latest" | "source">,
  d: Delivery,
): Promise<Outcome> {
  // `attempts` already counts this one (the claim adds it; a postponement gives it back).
  if (d.attempts > 1 && deps.now().getTime() - d.createdAt.getTime() >= EMAIL_RETRY_MAX_AGE_MS)
    return { status: "failed", note: "email_outcome_unknown" };
  const [user] = await deps.db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
  if (!user) return { status: "skipped", note: "no_user" };
  const [workspace] = await deps.db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, row.workspaceId));
  const base = deps.config.publicUrl.replace(/\/$/, "");
  const link = `${base}${notificationPath(row.workspaceId, row.id)}`;
  const settingsLink = `${base}/workspace/${encodeURIComponent(row.workspaceId)}/notifications/settings`;
  const mail = emailText(settings.locale, {
    who,
    workspaceName: workspace?.name ?? "",
    link,
    settingsLink,
    n,
  });
  const sent = await deps.mailer.send({
    to: user.email,
    subject: mail.subject,
    text: mail.text,
    kind: "notification",
    link,
    // Every attempt of this delivery carries the same key, so an accepted attempt that timed out here is
    // not sent twice.
    idempotencyKey: `notification-delivery/${d.id}`,
  });
  // A provider that already had this key with another payload sent the first attempt: no second email.
  if (sent.ok)
    return sent.alreadyAccepted ? { status: "sent", note: "email_already_accepted" } : { status: "sent" };
  // A rejection worth retrying goes back to the queue with the same growing wait as a push; a final one is
  // recorded as failed with its reason.
  return sent.retry
    ? { status: "retry", note: `email_${sent.reason}` }
    : { status: "failed", note: `email_${sent.reason}` };
}
