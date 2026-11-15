// Each person's notification inbox in the workspace. One notice per source (groupKey): new notices from the
// same source add to the `count` and to the actors. Every notice that changes goes out as notification.shown
// (or .hidden) and right after it notification.counts_updated goes out with every counter (an event with only
// unread and waiting left all, mentions and reactions wrong).
import type {
  AppNotification,
  NotificationCounts,
  NotificationFilter,
  NotificationKind,
  NotificationPriority,
  NotificationReason,
  NotificationSettings,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { classify, notificationWorkState } from "@vanr/engine/notify-rules";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { AppDeps } from "./context";
import { drainDeliveries, scheduleDeliveries } from "./notify-delivery";
import { requestEnded, requestStates, waitingKeyOf } from "./notify-requests";
import { settingsFor } from "./notify-settings";

const { notifications } = schema;
type Row = typeof notifications.$inferSelect;
type Actor = { type: "person" | "agent"; id: string };

/**
 * Mentions: someone talks to me (mention or DM). An agent's question, a secret and an assignment's requests use
 * `question_for_you`, which is already "waiting on you": counting it as a mention too put the same notice in two
 * tabs and inflated the mentions counter.
 */
const MENTION_KINDS: readonly NotificationKind[] = ["mention", "dm"];
const MAX_ACTORS = 5;

export function toNotification(row: Row): AppNotification {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    waiting: row.waiting,
    readAt: row.readAt?.toISOString() ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    mutedUntil: row.mutedUntil?.toISOString() ?? null,
    savedAt: row.savedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    count: row.count,
    tab: row.tab,
    critical: row.critical,
    reason: (row.reason || "mentioned") as NotificationReason,
    ruleId: row.ruleId,
    remindAt: row.remindAt?.toISOString() ?? null,
    workState: notificationWorkState({ kind: row.kind as NotificationKind, waiting: row.waiting }),
    actors: row.actors,
    source: row.source as AppNotification["source"],
    latest: row.latest as AppNotification["latest"],
  };
}

/** In the inbox: not done and not snoozed (or the snooze already ended). */
const visible = (now: Date): SQL =>
  sql`${notifications.doneAt} is null and (${notifications.mutedUntil} is null or ${notifications.mutedUntil} <= ${now.toISOString()}::timestamptz)`;

export function filterSql(filter: NotificationFilter): SQL | undefined {
  switch (filter) {
    case "all":
      return undefined;
    case "mentions":
      return inArray(notifications.kind, [...MENTION_KINDS]);
    case "waiting":
      return eq(notifications.waiting, true);
    case "unread":
      return isNull(notifications.readAt);
    case "reactions":
      return eq(notifications.kind, "reaction");
    case "action_needed":
      return eq(notifications.tab, "action_needed");
    case "fyi":
      return eq(notifications.tab, "fyi");
  }
}

/**
 * Notices that already have their own badge in the sidebar: approval (Approvals badge) and an assignment's request
 * (Threads badge). Adding them to the Notifications badge too counted the same request twice.
 */
const countedElsewhere = sql`(starts_with(${notifications.groupKey}, 'approval:') or starts_with(${notifications.groupKey}, 'assignment:'))`;

/** "Action needed" that asks for action: an open request, or a DM or mention not read yet. */
const needsAction = sql`(${notifications.tab} = 'action_needed' and (${notifications.waiting} or ${notifications.readAt} is null))`;

export async function countsFor(
  db: Db,
  workspaceId: string,
  userId: string,
  now: Date,
): Promise<NotificationCounts> {
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      mentions: sql<number>`(count(*) filter (where ${filterSql("mentions")}))::int`,
      waiting: sql<number>`(count(*) filter (where ${notifications.waiting}))::int`,
      unread: sql<number>`(count(*) filter (where ${notifications.readAt} is null))::int`,
      reactions: sql<number>`(count(*) filter (where ${notifications.kind} = 'reaction'))::int`,
      badge: sql<number>`(count(*) filter (where ${needsAction} and not ${countedElsewhere}))::int`,
      actionNeeded: sql<number>`(count(*) filter (where ${needsAction}))::int`,
      fyi: sql<number>`(count(*) filter (where ${notifications.tab} = 'fyi' and ${notifications.readAt} is null))::int`,
    })
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId), visible(now)));
  return {
    all: row?.all ?? 0,
    mentions: row?.mentions ?? 0,
    waiting: row?.waiting ?? 0,
    unread: row?.unread ?? 0,
    reactions: row?.reactions ?? 0,
    badge: row?.badge ?? 0,
    actionNeeded: row?.actionNeeded ?? 0,
    fyi: row?.fyi ?? 0,
  };
}

async function publishCounts(deps: AppDeps, workspaceId: string, userId: string) {
  const counts = await countsFor(deps.db, workspaceId, userId, deps.now());
  deps.hub.toUser(workspaceId, userId, { type: "notification.counts_updated", counts, ...counts });
}

/**
 * Tells each person that their notices changed (it leaves the inbox when done or snoozed; otherwise it enters or
 * updates) and sends the counters once per person at the end.
 */
export async function publishNotifications(deps: AppDeps, rows: Row[]) {
  const now = deps.now();
  const people = new Map<string, { workspaceId: string; userId: string }>();
  for (const row of rows) {
    const hidden = !!row.doneAt || (!!row.mutedUntil && row.mutedUntil > now);
    deps.hub.toUser(
      row.workspaceId,
      row.userId,
      hidden
        ? { type: "notification.hidden", id: row.id }
        : { type: "notification.shown", notification: toNotification(row) },
    );
    people.set(`${row.workspaceId}|${row.userId}`, { workspaceId: row.workspaceId, userId: row.userId });
  }
  for (const { workspaceId, userId } of people.values()) await publishCounts(deps, workspaceId, userId);
}

export const publishNotification = (deps: AppDeps, row: Row) => publishNotifications(deps, [row]);

/** The newest wins, but the reaction emojis add up in the group. */
function mergeLatest(
  old: Record<string, unknown>,
  next: AppNotification["latest"],
): AppNotification["latest"] {
  const before = Array.isArray(old.emojis)
    ? old.emojis.filter((e): e is string => typeof e === "string")
    : [];
  if (!next.emojis || before.length === 0) return next;
  return { ...next, emojis: [...new Set([...before, ...next.emojis])] };
}

/**
 * `notify(recipient, kind, reason, priority)`: every feature notifies someone only through here.
 * - `userId`: recipient. `kind`: kind (text and filter). `reason`: reason shown on the row (the kind's default
 *   in REASON_OF_KIND). `priority`: what the notifier asks for (`critical` breaks through quiet hours with an
 *   open request; `action_needed` and `fyi` choose the tab when the person has no rule).
 * - `waiting`: there is an open request behind it (the `groupKey` says which, in notify-rules `requestOf`). The
 *   notice only waits while the request is open in the database.
 */
interface NotifyInput {
  workspaceId: string;
  userId: string;
  kind: NotificationKind;
  reason?: NotificationReason;
  priority?: NotificationPriority;
  /** Source: notices with the same key become a single row. */
  groupKey: string;
  actor?: Actor;
  waiting?: boolean;
  source: AppNotification["source"];
  latest: AppNotification["latest"];
}

function classifyFor(input: NotifyInput, waiting: boolean, settings: NotificationSettings) {
  return classify(
    {
      kind: input.kind,
      reason: input.reason,
      priority: input.priority,
      waiting,
      channelId: input.source.channelId ?? null,
      agentId: input.actor?.type === "agent" ? input.actor.id : null,
    },
    settings.rules,
  );
}

/**
 * News that cancels the snooze: any new event on the notice except a reaction, which is only noise. Whoever
 * wants to hide it for good marks it done.
 */
const cancelsSnooze = (kind: NotificationKind) => kind !== "reaction";

/**
 * Creates or adds to a notice. A done notice that gets news comes back to the inbox as new; an open notice adds
 * one to `count`, puts the actor first and becomes unread again. Then it schedules push and email.
 */
export async function notify(deps: AppDeps, input: NotifyInput): Promise<void> {
  const { db } = deps;
  const at = deps.now();
  // The request was already resolved (answered before the notice went out): nothing to wait for.
  if (input.waiting) {
    const key = { userId: input.userId, groupKey: input.groupKey };
    const state = (await requestStates(db, [key])).get(waitingKeyOf(key));
    if (state === "closed") return;
  }
  const settings = await settingsFor(db, input.workspaceId, input.userId);
  const key = and(
    eq(notifications.workspaceId, input.workspaceId),
    eq(notifications.userId, input.userId),
    eq(notifications.groupKey, input.groupKey),
  );
  // The whole read-merge-write runs in one transaction with the group's row locked (FOR UPDATE): the count,
  // the actors, the latest (with its emojis), the reopening of a done notice and the snooze are all decided on
  // the row as it is now, so notices for one group at the same time add up instead of overwriting each other.
  // A first notice that loses the insert to another one waits for it (the unique index) and adds to it.
  const row = await db.transaction(async (tx) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const [old] = await tx.select().from(notifications).where(key).for("update");
      if (old) {
        const reopened = !!old.doneAt;
        const actors = input.actor
          ? [
              input.actor,
              ...(reopened
                ? []
                : old.actors.filter((a) => !(a.type === input.actor?.type && a.id === input.actor?.id))),
            ]
          : reopened
            ? []
            : old.actors;
        const waiting = input.waiting ?? (reopened ? false : old.waiting);
        const c = classifyFor(input, waiting, settings);
        const snoozed = old.mutedUntil && old.mutedUntil > at ? old.mutedUntil : null;
        const [updated] = await tx
          .update(notifications)
          .set({
            kind: input.kind,
            count: reopened ? 1 : sql`${notifications.count} + 1`,
            actors: actors.slice(0, MAX_ACTORS),
            waiting,
            tab: c.tab,
            critical: c.critical,
            reason: c.reason,
            ruleId: c.ruleId,
            priority: input.priority ?? null,
            source: { ...old.source, ...input.source },
            latest: mergeLatest(reopened ? {} : old.latest, input.latest),
            readAt: null,
            doneAt: null,
            mutedUntil: reopened || cancelsSnooze(input.kind) ? null : snoozed,
            updatedAt: at,
            ...(reopened ? { createdAt: at, remindAt: null } : {}),
          })
          .where(eq(notifications.id, old.id))
          .returning();
        return updated ?? null;
      }
      const waiting = input.waiting ?? false;
      const c = classifyFor(input, waiting, settings);
      const inserted = await tx
        .insert(notifications)
        .values({
          id: newId("ntf"),
          workspaceId: input.workspaceId,
          userId: input.userId,
          kind: input.kind,
          groupKey: input.groupKey,
          waiting,
          tab: c.tab,
          critical: c.critical,
          reason: c.reason,
          ruleId: c.ruleId,
          priority: input.priority ?? null,
          actors: input.actor ? [input.actor] : [],
          source: input.source,
          latest: input.latest,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing()
        .returning();
      // Another notice from the same source went in at the same time: on the second round, add to it.
      if (inserted[0]) return inserted[0];
    }
    return null;
  });
  // Outside the transaction: the realtime event and the counters read what was committed.
  if (row) {
    await publishNotification(deps, row);
    await scheduleDeliveries(deps, row, { settings });
  }
}

/**
 * The notice's reason ended (approval decided, question answered, turn passed): closes the open notices of that
 * source. Without `userId`, everyone's.
 */
export async function closeNotifications(
  deps: AppDeps,
  workspaceId: string,
  groupKey: string,
  userId?: string,
) {
  const at = deps.now();
  const rows = await deps.db
    .update(notifications)
    .set({
      doneAt: sql`coalesce(${notifications.doneAt}, ${at.toISOString()}::timestamptz)`,
      waiting: false,
      critical: false,
      remindAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.groupKey, groupKey),
        // Open, or still marked as waiting (a notice the person took out of the inbox before).
        or(isNull(notifications.doneAt), eq(notifications.waiting, true)),
        userId ? eq(notifications.userId, userId) : undefined,
      ),
    )
    .returning();
  await publishNotifications(deps, rows);
}

/** Closes every group that starts with the prefix (e.g. everything of an assignment that ended). */
export async function closeNotificationGroups(deps: AppDeps, workspaceId: string, prefix: string) {
  const at = deps.now();
  const rows = await deps.db
    .update(notifications)
    .set({ doneAt: at, waiting: false, critical: false, remindAt: null, updatedAt: at })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        sql`starts_with(${notifications.groupKey}, ${prefix})`,
        isNull(notifications.doneAt),
      ),
    )
    .returning();
  await publishNotifications(deps, rows);
}

/**
 * The group shrank (e.g. someone removed their reaction). The caller says what still exists, counted at the
 * source: how many items and who, from the newest to the oldest. The notice's actor list keeps only the latest
 * ones and can't decide it. With nothing left, the notice goes away.
 */
export async function shrinkGroup(
  deps: AppDeps,
  workspaceId: string,
  groupKey: string,
  remaining: { count: number; actors: Actor[]; emojis: string[] },
) {
  const at = deps.now();
  const rows = await deps.db
    .update(notifications)
    .set({
      latest: sql`jsonb_set(${notifications.latest}, '{emojis}', ${JSON.stringify(remaining.emojis)}::jsonb)`,
      ...(remaining.count === 0
        ? { actors: [], count: 0, doneAt: at, waiting: false, updatedAt: at }
        : { actors: remaining.actors.slice(0, MAX_ACTORS), count: remaining.count, updatedAt: at }),
    })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.groupKey, groupKey),
        isNull(notifications.doneAt),
      ),
    )
    .returning();
  await publishNotifications(deps, rows);
}

/** Snoozes that ended come back to the inbox as unread (the client has no clock for that). */
async function wakeSnoozed(deps: AppDeps) {
  const at = deps.now();
  const rows = await deps.db
    .update(notifications)
    .set({ mutedUntil: null, readAt: null, updatedAt: at })
    .where(
      and(
        isNotNull(notifications.mutedUntil),
        lte(notifications.mutedUntil, at),
        isNull(notifications.doneAt),
      ),
    )
    .returning();
  await publishNotifications(deps, rows);
}

/**
 * Reminder (apart from snooze): the notice stays in the inbox and, at the time, comes back to the top as unread
 * and goes out by push, even in "FYI".
 */
async function wakeReminders(deps: AppDeps) {
  const at = deps.now();
  const rows = await deps.db
    .update(notifications)
    .set({ remindAt: null, readAt: null, mutedUntil: null, updatedAt: at })
    .where(
      and(isNotNull(notifications.remindAt), lte(notifications.remindAt, at), isNull(notifications.doneAt)),
    )
    .returning();
  await publishNotifications(deps, rows);
  for (const row of rows) await scheduleDeliveries(deps, row, { reminder: true });
}

const RECONCILE_PAGE = 500;

/**
 * "Waiting on you" derived from the request: closes the notice whose request was resolved or deleted, even if
 * whoever resolved it didn't call closeNotifications. Goes through every waiting notice, in pages by id: a fixed
 * window would get stuck on the requests that stay open.
 */
async function reconcileWaiting(deps: AppDeps): Promise<number> {
  const at = deps.now();
  let after = "";
  let closed = 0;
  for (;;) {
    const rows = await deps.db
      .select({
        id: notifications.id,
        workspaceId: notifications.workspaceId,
        userId: notifications.userId,
        groupKey: notifications.groupKey,
        updatedAt: notifications.updatedAt,
      })
      .from(notifications)
      .where(and(eq(notifications.waiting, true), gt(notifications.id, after)))
      .orderBy(notifications.id)
      .limit(RECONCILE_PAGE);
    if (rows.length === 0) break;
    const states = await requestStates(deps.db, rows);
    for (const r of rows) {
      if (!requestEnded(states.get(waitingKeyOf(r)), r.updatedAt, at)) continue;
      await closeNotifications(deps, r.workspaceId, r.groupKey, r.userId);
      closed++;
    }
    if (rows.length < RECONCILE_PAGE) break;
    after = rows[rows.length - 1]?.id ?? after;
  }
  return closed;
}

/** Everything of the inbox that runs on the runtime's tick. */
export async function notificationTick(deps: AppDeps) {
  await reconcileWaiting(deps);
  await wakeSnoozed(deps);
  await wakeReminders(deps);
  await purgeOldNotifications(deps);
  await drainDeliveries(deps);
}

/**
 * The person changed their rules: redoes the tab of their notices in the workspace that aren't done. An open
 * request stays in "Action needed" (classify makes sure).
 */
export async function reclassify(
  deps: AppDeps,
  workspaceId: string,
  userId: string,
  settings: NotificationSettings,
) {
  const rows = await deps.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.userId, userId),
        isNull(notifications.doneAt),
      ),
    )
    .limit(5000);
  const changed: Row[] = [];
  for (const row of rows) {
    const c = classify(
      {
        kind: row.kind as NotificationKind,
        reason: (row.reason || undefined) as NotificationReason | undefined,
        priority: (row.priority ?? undefined) as NotificationPriority | undefined,
        waiting: row.waiting,
        channelId: typeof row.source.channelId === "string" ? row.source.channelId : null,
        agentId: row.actors.find((a) => a.type === "agent")?.id ?? null,
      },
      settings.rules,
    );
    if (c.tab === row.tab && c.ruleId === row.ruleId) continue;
    const [updated] = await deps.db
      .update(notifications)
      .set({ tab: c.tab, ruleId: c.ruleId })
      .where(eq(notifications.id, row.id))
      .returning();
    if (updated) changed.push(updated);
  }
  await publishNotifications(deps, changed);
  return changed.length;
}

const RETENTION_DAYS = 90;

/**
 * Retention: a notice idle for more than 3 months (no news since then) is deleted, except a saved one and one
 * still waiting on the person (an open request doesn't go away). Runs on the tick, in batches.
 */
async function purgeOldNotifications(deps: AppDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - RETENTION_DAYS * 86_400_000);
  const old = deps.db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        isNull(notifications.savedAt),
        eq(notifications.waiting, false),
        lte(notifications.updatedAt, cutoff),
      ),
    )
    .limit(500);
  const gone = await deps.db.delete(notifications).where(inArray(notifications.id, old)).returning({
    id: notifications.id,
    workspaceId: notifications.workspaceId,
    userId: notifications.userId,
    doneAt: notifications.doneAt,
  });
  // Whoever had the notice in the inbox sees it go away and the counter change.
  const people = new Map<string, { workspaceId: string; userId: string }>();
  for (const row of gone) {
    if (!row.doneAt)
      deps.hub.toUser(row.workspaceId, row.userId, { type: "notification.hidden", id: row.id });
    people.set(`${row.workspaceId}|${row.userId}`, { workspaceId: row.workspaceId, userId: row.userId });
  }
  for (const { workspaceId, userId } of people.values()) await publishCounts(deps, workspaceId, userId);
  return gone.length;
}

/** A page of the inbox: waiting first, then the newest. Opaque cursor "w|updatedAt|id". */
export async function listNotifications(
  db: Db,
  input: {
    workspaceId: string;
    userId: string;
    filter: NotificationFilter;
    cursor?: string;
    limit: number;
    now: Date;
  },
) {
  let after: SQL | undefined;
  if (input.cursor) {
    const [w, ts, id] = input.cursor.split("|");
    const waiting = w === "1";
    const at = new Date(ts ?? "");
    if (id && !Number.isNaN(at.getTime())) {
      const older = sql`(${notifications.updatedAt}, ${notifications.id}) < (${at.toISOString()}::timestamptz, ${id})`;
      // The order is "waiting first": after the last waiting one come the older waiting ones and then
      // every one that isn't waiting.
      after = waiting
        ? or(eq(notifications.waiting, false), and(eq(notifications.waiting, true), older))
        : and(eq(notifications.waiting, false), older);
    }
  }
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, input.workspaceId),
        eq(notifications.userId, input.userId),
        visible(input.now),
        filterSql(input.filter),
        after,
      ),
    )
    .orderBy(desc(notifications.waiting), desc(notifications.updatedAt), desc(notifications.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > input.limit && last
      ? `${last.waiting ? "1" : "0"}|${last.updatedAt.toISOString()}|${last.id}`
      : null;
  return { items: page.map(toNotification), nextCursor };
}
