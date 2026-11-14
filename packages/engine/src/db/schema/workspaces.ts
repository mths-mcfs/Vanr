import { boolean, doublePrecision, index, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { createdAt, ts } from "./columns";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Company context that agents read. */
  context: text("context").notNull().default(""),
  logoKey: text("logo_key"),
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  primaryCredentialId: text("primary_credential_id"),
  agentBudgetDefaultUsd: doublePrecision("agent_budget_default_usd").notNull().default(20),
  /**
   * Model reviewer for approvals: decides risk-flagged requests at K1/K2 reading only the people's
   * messages. Off by default.
   */
  approvalReviewer: boolean("approval_reviewer").notNull().default(false),
  /** #general: whoever joins the workspace joins it. */
  defaultChannelId: text("default_channel_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const members = pgTable(
  "members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    handle: text("handle").notNull(),
    timezone: text("timezone"),
    avatarKey: text("avatar_key"),
    joinedAt: createdAt(),
    lastSeenAt: ts("last_seen_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    uniqueIndex("members_handle_uq").on(t.workspaceId, t.handle),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** null for a link invitation (any account may accept). */
    email: text("email"),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status", { enum: ["pending", "accepted", "revoked"] })
      .notNull()
      .default("pending"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: text("accepted_by"),
    requestedNewAt: ts("requested_new_at"),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_workspace_idx").on(t.workspaceId), index("invitations_email_idx").on(t.email)],
);
