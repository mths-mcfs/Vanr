import {
  type BatchInviteResult,
  can,
  type Invitation,
  type InvitationPreview,
  type InvitationWithStatus,
  type Role,
} from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { newId, newToken, sha256Hex } from "@vanr/engine/ids";
import { ROLES } from "@vanr/engine/roles";
import { PRODUCT } from "@vanr/product";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { type AppDeps, type AppEnv, type Ctx, requireUser } from "../context";
import { forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { joinWorkspace } from "../members";
import { requirePermission, WORKSPACE } from "../workspace-scope";

const { invitations, workspaces, members, users } = schema;

const INVITE_TTL_MS = 7 * 24 * 3600_000;
/** Cookie the invitation preview leaves: with it, closed sign-up accepts whoever came through the link. */
export const INVITE_COOKIE = `${PRODUCT.slug}.invite`;

const invitationGone = () => new HttpError(404, "not_found", "Invitation not found or expired");
const emailSchema = z.email().max(254);

type Row = typeof invitations.$inferSelect;

const toInvitation = (r: Row): Invitation => ({
  id: r.id,
  email: r.email,
  role: r.role,
  invitedBy: r.invitedBy,
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});

function statusOf(r: Row, now: Date): InvitationWithStatus["status"] {
  if (r.status !== "pending") return r.status;
  return r.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

const inviteUrl = (deps: AppDeps, token: string) => `${deps.config.publicUrl}/invite/${token}`;

function requireRoleAllowed(c: Ctx, role: Role) {
  const me = requirePermission(c, "manage_members");
  if (role === "owner" && !can(me.role, "manage_owners")) throw forbidden("Only owners can invite owners");
  return me;
}

async function sendInviteMail(
  deps: AppDeps,
  input: { to: string; workspaceName: string; inviter: string; url: string },
) {
  await deps.mailer.send({
    to: input.to,
    kind: "invite",
    subject: `${input.inviter} invited you to ${input.workspaceName} on ${PRODUCT.name}`,
    text: `${input.inviter} invited you to the workspace ${input.workspaceName}.\n\nAccept through the link (valid for 7 days):\n${input.url}\n`,
    link: input.url,
  });
}

/**
 * Creates (or renews) the invitation of an email. An email has at most one pending invitation per workspace:
 * inviting again changes the token and the deadline, and the old link stops working.
 */
async function issueInvite(
  c: Ctx,
  input: { workspaceId: string; email: string | null; role: Role; invitedBy: string },
): Promise<{ row: Row; url: string }> {
  const deps = c.get("deps");
  const token = newToken();
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  if (input.email) {
    await deps.db
      .update(invitations)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          eq(invitations.email, input.email),
          eq(invitations.status, "pending"),
        ),
      );
  }
  const [row] = await deps.db
    .insert(invitations)
    .values({
      id: newId("inv"),
      workspaceId: input.workspaceId,
      email: input.email,
      role: input.role,
      tokenHash: sha256Hex(token),
      invitedBy: input.invitedBy,
      expiresAt,
      createdAt: now,
    })
    .returning();
  if (!row) throw new HttpError(500, "internal", "Invitation not created");
  return { row, url: inviteUrl(deps, token) };
}

async function workspaceAndInviter(c: Ctx, workspaceId: string) {
  const user = requireUser(c);
  const [workspace] = await c
    .get("deps")
    .db.select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return { workspaceName: workspace?.name ?? "", inviter: user.name };
}

async function isMemberByEmail(c: Ctx, workspaceId: string, email: string): Promise<boolean> {
  const [row] = await c
    .get("deps")
    .db.select({ id: members.userId })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.workspaceId, workspaceId), eq(users.email, email)));
  return Boolean(row);
}

/** A valid invitation by its token (pending and within its deadline). */
async function findValid(deps: AppDeps, token: string): Promise<Row | null> {
  const [row] = await deps.db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, sha256Hex(token)));
  if (!row || statusOf(row, deps.now()) !== "pending") return null;
  return row;
}

/** An invitation already used or expired, but whoever opens the link is a member: accepting only leads to the workspace. */
async function findForMember(deps: AppDeps, token: string, userId: string | undefined): Promise<Row | null> {
  if (!userId) return null;
  const [row] = await deps.db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, sha256Hex(token)));
  if (!row) return null;
  const [member] = await deps.db
    .select({ id: members.userId })
    .from(members)
    .where(and(eq(members.workspaceId, row.workspaceId), eq(members.userId, userId)));
  return member ? row : null;
}

/** Used by the sign-up hook: is there a pending invitation for this email, or does the cookie carry a valid one? */
export async function hasPendingInvite(
  deps: AppDeps,
  email: string,
  cookieToken: string | null,
): Promise<boolean> {
  const now = deps.now();
  const [byEmail] = await deps.db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email.toLowerCase()),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);
  if (byEmail) return true;
  if (!cookieToken) return false;
  const row = await findValid(deps, cookieToken);
  return Boolean(row && (row.email === null || row.email === email.toLowerCase()));
}

export function registerInvitations(app: Hono<AppEnv>) {
  // Pending invitations; `?scope=all` lists every invitation of the workspace with its status.
  app.get(`${WORKSPACE}/invitations`, async (c) => {
    const { workspaceId } = requirePermission(c, "manage_members");
    const { scope } = readQuery(c, z.object({ scope: z.literal("all").optional() }));
    const deps = c.get("deps");
    const now = deps.now();
    if (scope === "all") {
      const rows = await deps.db
        .select()
        .from(invitations)
        .where(eq(invitations.workspaceId, workspaceId))
        .orderBy(desc(invitations.createdAt));
      return c.json({
        invitations: rows.map(
          (r): InvitationWithStatus => ({ ...toInvitation(r), status: statusOf(r, now) }),
        ),
      });
    }
    const rows = await deps.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, now),
        ),
      )
      .orderBy(desc(invitations.createdAt));
    return c.json({ invitations: rows.map(toInvitation) });
  });

  app.post(`${WORKSPACE}/invitations`, async (c) => {
    const input = await readJson(
      c,
      z.object({ email: z.string().trim().toLowerCase().pipe(emailSchema), role: z.enum(ROLES) }),
    );
    const me = requireRoleAllowed(c, input.role);
    if (await isMemberByEmail(c, me.workspaceId, input.email)) {
      throw new HttpError(409, "already_member", "This person is already a member", { email: input.email });
    }
    const { row, url } = await issueInvite(c, {
      workspaceId: me.workspaceId,
      email: input.email,
      role: input.role,
      invitedBy: me.userId,
    });
    await sendInviteMail(c.get("deps"), {
      to: input.email,
      url,
      ...(await workspaceAndInviter(c, me.workspaceId)),
    });
    return c.json({ invitation: toInvitation(row), url }, 201);
  });

  app.post(`${WORKSPACE}/invitations/bulk`, async (c) => {
    const input = await readJson(
      c,
      z.object({ emails: z.array(z.string()).min(1).max(100), role: z.enum(ROLES) }),
    );
    const me = requireRoleAllowed(c, input.role);
    const deps = c.get("deps");
    const from = await workspaceAndInviter(c, me.workspaceId);
    const now = deps.now();
    const results: BatchInviteResult[] = [];
    const seen = new Set<string>();
    for (const raw of input.emails) {
      const email = raw.trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      if (!emailSchema.safeParse(email).success) {
        results.push({ email, status: "bad_email" });
        continue;
      }
      if (await isMemberByEmail(c, me.workspaceId, email)) {
        results.push({ email, status: "already_member" });
        continue;
      }
      const [pending] = await deps.db
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, me.workspaceId),
            eq(invitations.email, email),
            eq(invitations.status, "pending"),
            gt(invitations.expiresAt, now),
          ),
        );
      if (pending) {
        results.push({ email, status: "already_invited" });
        continue;
      }
      const { url } = await issueInvite(c, {
        workspaceId: me.workspaceId,
        email,
        role: input.role,
        invitedBy: me.userId,
      });
      await sendInviteMail(deps, { to: email, url, ...from });
      results.push({ email, status: "invited", url });
    }
    return c.json({ results });
  });

  app.post(`${WORKSPACE}/invitations/:invitationId/resend`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const deps = c.get("deps");
    const [old] = await deps.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.workspaceId, me.workspaceId), eq(invitations.id, param(c, "invitationId"))));
    if (!old || old.status === "accepted") throw notFound("Invitation not found");
    requireRoleAllowed(c, old.role);
    const { row, url } = await issueInvite(c, {
      workspaceId: me.workspaceId,
      email: old.email,
      role: old.role,
      invitedBy: me.userId,
    });
    if (old.status === "pending") {
      await deps.db.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, old.id));
    }
    if (row.email) {
      await sendInviteMail(deps, { to: row.email, url, ...(await workspaceAndInviter(c, me.workspaceId)) });
    }
    return c.json({ url, expiresAt: row.expiresAt.toISOString() });
  });

  app.delete(`${WORKSPACE}/invitations/:invitationId`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const [row] = await c
      .get("deps")
      .db.update(invitations)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitations.workspaceId, me.workspaceId),
          eq(invitations.id, param(c, "invitationId")),
          eq(invitations.status, "pending"),
        ),
      )
      .returning({ id: invitations.id });
    if (!row) throw notFound("Invitation not found");
    return c.body(null, 204);
  });

  // Invite link: without an email, joins as a member, valid for 7 days and accepts several people.
  app.post(`${WORKSPACE}/invite-links`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const { row, url } = await issueInvite(c, {
      workspaceId: me.workspaceId,
      email: null,
      role: "member",
      invitedBy: me.userId,
    });
    return c.json({ url, expiresAt: row.expiresAt.toISOString() }, 201);
  });

  // Global routes of the invitation (by its token, the `:invitationId` of the path). The preview needs no
  // session: the page shows it before the login.
  app.get("/api/v1/invitations/:invitationId", async (c) => {
    const deps = c.get("deps");
    const token = param(c, "invitationId");
    const valid = await findValid(deps, token);
    const row = valid ?? (await findForMember(deps, token, c.get("user")?.id));
    if (!row) {
      // Already used by someone else: "ask for a new invitation" doesn't apply to it (request-new rejects it),
      // so the page needs to know it is this case, and not an expired invitation.
      const [used] = await deps.db
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.tokenHash, sha256Hex(token)));
      if (used?.status === "accepted") throw new HttpError(410, "invitation.used", "Invitation already used");
      throw invitationGone();
    }
    const [workspace] = await deps.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId));
    const [inviter] = row.invitedBy
      ? await deps.db.select({ name: users.name }).from(users).where(eq(users.id, row.invitedBy))
      : [];
    if (valid) {
      setCookie(c, INVITE_COOKIE, token, {
        path: "/api/auth",
        httpOnly: true,
        sameSite: "Lax",
        secure: deps.config.publicUrl.startsWith("https://"),
        maxAge: Math.floor((row.expiresAt.getTime() - deps.now().getTime()) / 1000),
      });
    }
    const preview: InvitationPreview = {
      workspaceId: row.workspaceId,
      workspaceName: workspace?.name ?? "",
      email: row.email,
      role: row.role,
      invitedByName: inviter?.name ?? null,
      expiresAt: row.expiresAt.toISOString(),
    };
    return c.json(preview);
  });

  app.post("/api/v1/invitations/:invitationId/accept", async (c) => {
    const user = requireUser(c);
    const deps = c.get("deps");
    const [row] = await deps.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256Hex(param(c, "invitationId"))));
    if (!row) throw invitationGone();
    const [already] = await deps.db
      .select({ id: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, row.workspaceId), eq(members.userId, user.id)));
    // Whoever is already a member is only led to the workspace; the invitation stays as it is.
    if (already) return c.json({ workspaceId: row.workspaceId });
    if (statusOf(row, deps.now()) !== "pending") throw invitationGone();
    if (row.email && row.email !== user.email.toLowerCase()) {
      throw new HttpError(403, "invitation.wrong_email", "This invitation is for another email", {
        email: row.email,
      });
    }
    // An email invitation works once: it is marked before joining, on the condition it is still pending.
    if (row.email) {
      const [claimed] = await deps.db
        .update(invitations)
        .set({ status: "accepted", acceptedAt: deps.now(), endorsedBy: user.id })
        .where(and(eq(invitations.id, row.id), eq(invitations.status, "pending")))
        .returning({ id: invitations.id });
      if (!claimed) throw invitationGone();
    }
    await joinWorkspace(deps.db, {
      workspaceId: row.workspaceId,
      userId: user.id,
      name: user.name,
      role: row.role,
    });
    return c.json({ workspaceId: row.workspaceId });
  });

  // Ask for a new invitation: tells whoever invited. Once an hour per invitation.
  app.post("/api/v1/invitations/:invitationId/request-new", async (c) => {
    const deps = c.get("deps");
    const [row] = await deps.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256Hex(param(c, "invitationId"))));
    if (!row || row.status === "accepted") throw invitationGone();
    const now = deps.now();
    if (row.requestedNewAt && now.getTime() - row.requestedNewAt.getTime() < 3600_000)
      return c.body(null, 204);
    await deps.db.update(invitations).set({ requestedNewAt: now }).where(eq(invitations.id, row.id));
    const [inviter] = row.invitedBy
      ? await deps.db.select({ email: users.email }).from(users).where(eq(users.id, row.invitedBy))
      : [];
    const [workspace] = await deps.db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId));
    if (inviter) {
      const who = row.email ?? "Someone with the invite link";
      await deps.mailer.send({
        to: inviter.email,
        kind: "invite_request",
        subject: `${who} asked for a new invitation to ${workspace?.name ?? ""}`,
        text: `${who} tried to join ${workspace?.name ?? ""} with an invitation that expired. Send another one in Settings > Members.`,
        link: `${deps.config.publicUrl}/workspace/${row.workspaceId}/settings/members`,
      });
    }
    return c.body(null, 204);
  });
}
