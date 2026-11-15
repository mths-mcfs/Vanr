// A person's notification preferences in the workspace: push, email, per kind and channel, quiet hours and tab rules.
// Stored as JSON and validated here, at the boundary; what comes from the database goes through the same parse (an
// old or corrupted row falls back to the default instead of breaking notify).
import type { NotificationKind, NotificationSettings } from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { DEFAULT_SETTINGS, MAX_RULES } from "@vanr/engine/notify-rules";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const { notificationSettings, members, workspaces } = schema;

export const NOTIFICATION_KINDS = [
  "mention",
  "thread_followup",
  "dm",
  "question_for_you",
  "issue_ownership",
  "issue_discussion",
  "issue_progress",
  "debate_turn",
  "debate_synthesis",
  "approval",
  "assignment_finished",
  "assignment_stopped",
  "routine_report",
  "routine_alert",
  "runner_connected",
  "browser_intervention",
  "reaction",
] as const satisfies readonly NotificationKind[];

const id = z.string().min(1).max(64);
const clock = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
const toggle = z.object({ push: z.boolean().optional(), email: z.boolean().optional() }).strict();

export const settingsSchema = z
  .object({
    push: z.boolean(),
    email: z.boolean(),
    emailDelayMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    kinds: z.partialRecord(z.enum(NOTIFICATION_KINDS), toggle),
    channels: z.record(id, toggle).refine((r) => Object.keys(r).length <= 500, "too many channels"),
    quietHours: z.object({ enabled: z.boolean(), start: clock, end: clock }).strict(),
    dndUntil: z.iso.datetime({ offset: true }).nullable(),
    rules: z
      .array(
        z
          .object({
            id,
            kind: z.enum(NOTIFICATION_KINDS).optional(),
            channelId: id.optional(),
            agentId: id.optional(),
            tab: z.enum(["action_needed", "fyi"]),
          })
          .strict(),
      )
      .max(MAX_RULES),
    locale: z.enum(["pt-BR", "en"]),
  })
  .strict();

export function parseSettings(raw: unknown): NotificationSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? (parsed.data as NotificationSettings) : DEFAULT_SETTINGS;
}

export async function settingsFor(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<NotificationSettings> {
  const [row] = await db
    .select({ settings: notificationSettings.settings })
    .from(notificationSettings)
    .where(and(eq(notificationSettings.workspaceId, workspaceId), eq(notificationSettings.userId, userId)));
  return parseSettings(row?.settings);
}

export async function saveSettings(
  db: Db,
  workspaceId: string,
  userId: string,
  settings: NotificationSettings,
  at: Date,
): Promise<void> {
  await db
    .insert(notificationSettings)
    .values({ workspaceId, userId, settings: { ...settings }, updatedAt: at })
    .onConflictDoUpdate({
      target: [notificationSettings.workspaceId, notificationSettings.userId],
      set: { settings: { ...settings }, updatedAt: at },
    });
}

/** The person's timezone in the workspace (the one on the member profile) or the workspace's. */
export async function timezoneFor(db: Db, workspaceId: string, userId: string): Promise<string> {
  const [row] = await db
    .select({ mine: members.timezone, workspace: workspaces.timezone })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  return row?.mine ?? row?.workspace ?? "UTC";
}
