// The signed-in person's notification inbox: list by filter, count, mark read, done, snooze and read everything.
import type { NotificationFilter, NotificationSettings } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, AppEnv, WorkspaceMember } from "../context";
import { HttpError, notFound, param, readJson, readQuery } from "../http";
import {
  countsFor,
  filterSql,
  listNotifications,
  publishNotification,
  publishNotifications,
  reclassify,
  toNotification,
} from "../notifications";
import { saveSettings, settingsFor, settingsSchema } from "../notify-settings";
import { requireMember, WORKSPACE } from "../workspace-scope";

const { notifications, channels, agents } = schema;
const FILTERS = [
  "all",
  "mentions",
  "waiting",
  "unread",
  "reactions",
  "action_needed",
  "fyi",
] as const satisfies readonly NotificationFilter[];

/** The channel and agent named in the settings must be of this workspace (otherwise the rule would never match). */
async function checkRefs(deps: AppDeps, workspaceId: string, s: NotificationSettings) {
  const channelIds = [
    ...new Set([...s.rules.flatMap((r) => (r.channelId ? [r.channelId] : [])), ...Object.keys(s.channels)]),
  ];
  const agentIds = [...new Set(s.rules.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  if (channelIds.length) {
    const found = await deps.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, channelIds)));
    if (found.length !== channelIds.length)
      throw new HttpError(400, "notification.unknown_channel", "Unknown channel in settings");
  }
  if (agentIds.length) {
    const found = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, agentIds)));
    if (found.length !== agentIds.length)
      throw new HttpError(400, "notification.unknown_agent", "Unknown agent in settings");
  }
}

async function mine(deps: AppDeps, me: WorkspaceMember, id: string) {
  const [row] = await deps.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.workspaceId, me.workspaceId),
        eq(notifications.userId, me.userId),
      ),
    );
  if (!row) throw notFound("Notification not found");
  return row;
}

async function change(deps: AppDeps, id: string, set: Partial<typeof notifications.$inferInsert>) {
  const [row] = await deps.db
    .update(notifications)
    .set({ ...set, updatedAt: deps.now() })
    .where(eq(notifications.id, id))
    .returning();
  if (!row) throw notFound("Notification not found");
  await publishNotification(deps, row);
  return row;
}

export function registerNotifications(app: Hono<AppEnv>) {
  app.get(`${WORKSPACE}/notifications`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const q = readQuery(
      c,
      z.object({
        filter: z.enum(FILTERS).default("all"),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    );
    const now = deps.now();
    const page = await listNotifications(deps.db, {
      workspaceId: me.workspaceId,
      userId: me.userId,
      ...q,
      now,
    });
    const counts = await countsFor(deps.db, me.workspaceId, me.userId, now);
    return c.json({ ...page, counts });
  });

  // Settings: push, email, per kind and channel, quiet hours and tab rules. Changing the rules redoes the tab
  // of the notices in the inbox.
  app.get(`${WORKSPACE}/notifications/settings`, async (c) => {
    const me = requireMember(c);
    return c.json(await settingsFor(c.get("deps").db, me.workspaceId, me.userId));
  });

  app.put(`${WORKSPACE}/notifications/settings`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const next: NotificationSettings = await readJson(c, settingsSchema);
    if (new Set(next.rules.map((r) => r.id)).size !== next.rules.length)
      throw new HttpError(400, "notification.duplicate_rule", "Rule ids must be unique");
    await checkRefs(deps, me.workspaceId, next);
    await saveSettings(deps.db, me.workspaceId, me.userId, next, deps.now());
    await reclassify(deps, me.workspaceId, me.userId, next);
    return c.json(next);
  });

  app.get(`${WORKSPACE}/notifications/counts`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    return c.json(await countsFor(deps.db, me.workspaceId, me.userId, deps.now()));
  });

  app.post(`${WORKSPACE}/notifications/:notificationId/read`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await mine(deps, me, param(c, "notificationId"));
    const { read } = await readJson(c, z.object({ read: z.boolean() }).strict());
    const updated = await change(deps, row.id, { readAt: read ? (row.readAt ?? deps.now()) : null });
    return c.json(toNotification(updated));
  });

  // Done takes it out of the inbox; undoing brings it back. Done also counts as read.
  app.post(`${WORKSPACE}/notifications/:notificationId/complete`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await mine(deps, me, param(c, "notificationId"));
    const { done } = await readJson(c, z.object({ done: z.boolean() }).strict());
    // An open request (approval, question, secret, debate turn) doesn't leave the inbox by "done": the notice
    // would disappear while the request stayed pending, counted in another badge. It closes by itself when the
    // request is resolved, on any screen.
    if (done && row.waiting)
      throw new HttpError(
        409,
        "notification.waiting",
        "Answer the request first; it leaves the inbox by itself",
      );
    const at = deps.now();
    const updated = await change(
      deps,
      row.id,
      done ? { doneAt: row.doneAt ?? at, readAt: row.readAt ?? at } : { doneAt: null },
    );
    return c.json(toNotification(updated));
  });

  // Saving takes the notice out of the 3-month retention; it doesn't change read, done or snoozed.
  app.post(`${WORKSPACE}/notifications/:notificationId/save`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await mine(deps, me, param(c, "notificationId"));
    const { saved } = await readJson(c, z.object({ saved: z.boolean() }).strict());
    const updated = await change(deps, row.id, { savedAt: saved ? (row.savedAt ?? deps.now()) : null });
    return c.json(toNotification(updated));
  });

  // Snoozing hides the notice until the set time; `null` brings it back at once. The return happens on the runtime's tick.
  app.post(`${WORKSPACE}/notifications/:notificationId/snooze`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await mine(deps, me, param(c, "notificationId"));
    const { until } = await readJson(
      c,
      z.object({ until: z.iso.datetime({ offset: true }).nullable() }).strict(),
    );
    const at = until ? new Date(until) : null;
    if (at && at <= deps.now())
      throw new HttpError(400, "notification.snooze_past", "Snooze must end in the future");
    const updated = await change(deps, row.id, { mutedUntil: at, ...(at ? {} : { readAt: null }) });
    return c.json(toNotification(updated));
  });

  // Reminder: unlike snoozing, the notice stays in the inbox; at the time it comes back to the top and goes out by push.
  app.post(`${WORKSPACE}/notifications/:notificationId/remind`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const row = await mine(deps, me, param(c, "notificationId"));
    const { at } = await readJson(c, z.object({ at: z.iso.datetime({ offset: true }).nullable() }).strict());
    const when = at ? new Date(at) : null;
    if (when && when <= deps.now())
      throw new HttpError(400, "notification.remind_past", "Reminder must be in the future");
    if (when && row.doneAt) throw new HttpError(409, "notification.done", "Notification is done");
    const updated = await change(deps, row.id, { remindAt: when });
    return c.json(toNotification(updated));
  });

  // Reads everything in the inbox of that filter (snoozed and done ones stay as they are).
  app.post(`${WORKSPACE}/notifications/read-all`, async (c) => {
    const me = requireMember(c);
    const deps = c.get("deps");
    const { filter } = await readJson(c, z.object({ filter: z.enum(FILTERS).optional() }).strict());
    const at = deps.now();
    const rows = await deps.db
      .update(notifications)
      .set({ readAt: at, updatedAt: at })
      .where(
        and(
          eq(notifications.workspaceId, me.workspaceId),
          eq(notifications.userId, me.userId),
          isNull(notifications.readAt),
          isNull(notifications.doneAt),
          sql`(${notifications.mutedUntil} is null or ${notifications.mutedUntil} <= ${at.toISOString()}::timestamptz)`,
          filterSql(filter ?? "all"),
        ),
      )
      .returning();
    await publishNotifications(deps, rows);
    return c.json({ ids: rows.map((r) => r.id) });
  });
}
