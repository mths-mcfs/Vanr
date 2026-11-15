import {
  type BatchInviteResult,
  can,
  type Invitation,
  type InvitationPreview,
  type InvitationWithStatus,
  type Role,
} from "@vanr/contract";
import { type Db, schema } from "@vanr/engine/db";
import { newId, newToken, sha256Hex } from "@vanr/engine/ids";
import { ROLES } from "@vanr/engine/roles";
import { PRODUCT } from "@vanr/product";
import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { type AppDeps, type AppEnv, type Ctx, requireUser } from "../context";
import { pgCode } from "../db-errors";
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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Who an invitation is for: the normalized email, or the link itself (a link invitation has no email). Every
 * write that decides on the invitations of one invitee (create, bulk, resend, revoke, accept) runs in a
 * transaction holding this lock, so "revoke the pending one, then create the new one" and "check, then claim"
 * never interleave: on Postgres with several connections and on PGlite alike.
 */
const inviteeOf = (r: { email: string | null; id: string }) => r.email ?? `link:${r.id}`;

async function lockInvitee(tx: Tx, workspaceId: string, invitee: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invitation:${workspaceId}:${invitee}`}))`);
}

/**
 * Creates (or renews) the invitation of an email. An email has at most one pending invitation per workspace:
 * inviting again changes the token and the deadline, and the old link stops working. The caller holds the
 * invitee's lock (`lockInvitee`) in the transaction `tx`.
 */
async function issueInvite(
  tx: Tx,
  c: Ctx,
  input: { workspaceId: string; email: string | null; role: Role; invitedBy: string },
): Promise<{ row: Row; url: string }> {
  const deps = c.get("deps");
  const token = newToken();
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  if (input.email) {
    const [owner] = await tx
      .select({ role: invitations.role })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          eq(invitations.email, input.email),
          eq(invitations.status, "pending"),
          eq(invitations.role, "owner"),
        ),
      )
      .limit(1);
    if (owner) requireRoleAllowed(c, owner.role);
    await tx
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
  const [row] = await tx
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

async function isMemberByEmail(tx: Tx, workspaceId: string, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: members.userId })
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
    const deps = c.get("deps");
    const { row, url } = await deps.db.transaction(async (tx) => {
      await lockInvitee(tx, me.workspaceId, input.email);
      if (await isMemberByEmail(tx, me.workspaceId, input.email)) {
        throw new HttpError(409, "already_member", "This person is already a member", { email: input.email });
      }
      return issueInvite(tx, c, {
        workspaceId: me.workspaceId,
        email: input.email,
        role: input.role,
        invitedBy: me.userId,
      });
    });
    await sendInviteMail(deps, {
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
      const outcome = await deps.db.transaction(async (tx) => {
        await lockInvitee(tx, me.workspaceId, email);
        if (await isMemberByEmail(tx, me.workspaceId, email)) return { status: "already_member" as const };
        const [pending] = await tx
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
        if (pending) return { status: "already_invited" as const };
        const { url } = await issueInvite(tx, c, {
          workspaceId: me.workspaceId,
          email,
          role: input.role,
          invitedBy: me.userId,
        });
        return { status: "invited" as const, url };
      });
      if (outcome.status !== "invited") {
        results.push({ email, status: outcome.status });
        continue;
      }
      await sendInviteMail(deps, { to: email, url: outcome.url, ...from });
      results.push({ email, status: "invited", url: outcome.url });
    }
    return c.json({ results });
  });

  app.post(`${WORKSPACE}/invitations/:invitationId/resend`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const deps = c.get("deps");
    const id = param(c, "invitationId");
    const current = (tx: Tx) =>
      tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.workspaceId, me.workspaceId), eq(invitations.id, id)))
        .then((rows) => rows[0]);
    const { row, url } = await deps.db.transaction(async (tx) => {
      const seen = await current(tx);
      if (!seen) throw notFound("Invitation not found");
      await lockInvitee(tx, me.workspaceId, inviteeOf(seen));
      // Read again under the lock: an accept or another resend may have changed it meanwhile.
      const old = await current(tx);
      if (!old || old.status === "accepted") throw notFound("Invitation not found");
      requireRoleAllowed(c, old.role);
      const issued = await issueInvite(tx, c, {
        workspaceId: me.workspaceId,
        email: old.email,
        role: old.role,
        invitedBy: me.userId,
      });
      if (old.status === "pending") {
        await tx.update(invitations).set({ status: "revoked" }).where(eq(invitations.id, old.id));
      }
      return issued;
    });
    if (row.email) {
      await sendInviteMail(deps, { to: row.email, url, ...(await workspaceAndInviter(c, me.workspaceId)) });
    }
    return c.json({ url, expiresAt: row.expiresAt.toISOString() });
  });

  app.delete(`${WORKSPACE}/invitations/:invitationId`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const id = param(c, "invitationId");
    const row = await c.get("deps").db.transaction(async (tx) => {
      const [seen] = await tx
        .select({ id: invitations.id, email: invitations.email })
        .from(invitations)
        .where(and(eq(invitations.workspaceId, me.workspaceId), eq(invitations.id, id)));
      if (!seen) return null;
      await lockInvitee(tx, me.workspaceId, inviteeOf(seen));
      const [current] = await tx
        .select({ role: invitations.role })
        .from(invitations)
        .where(
          and(
            eq(invitations.workspaceId, me.workspaceId),
            eq(invitations.id, id),
            eq(invitations.status, "pending"),
          ),
        );
      if (!current) return null;
      requireRoleAllowed(c, current.role);
      const [revoked] = await tx
        .update(invitations)
        .set({ status: "revoked" })
        .where(
          and(
            eq(invitations.workspaceId, me.workspaceId),
            eq(invitations.id, id),
            eq(invitations.status, "pending"),
          ),
        )
        .returning({ id: invitations.id });
      return revoked ?? null;
    });
    if (!row) throw notFound("Invitation not found");
    return c.body(null, 204);
  });

  // Invite link: without an email, joins as a member, valid for 7 days and accepts several people.
  app.post(`${WORKSPACE}/invite-links`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const deps = c.get("deps");
    // A new link has no invitee to share a lock with: nothing else writes it before it exists.
    const { row, url } = await deps.db.transaction((tx) =>
      issueInvite(tx, c, {
        workspaceId: me.workspaceId,
        email: null,
        role: "member",
        invitedBy: me.userId,
      }),
    );
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
    const join = { workspaceId: row.workspaceId, userId: user.id, name: user.name, role: row.role };
    if (row.email) {
      // An email invitation works once: it is claimed (still pending, under the invitee's lock, so a renewal
      // of the same email waits) and the person joins in the same transaction.
      const email = row.email;
      for (let attempt = 0; ; attempt++) {
        try {
          await deps.db.transaction(async (tx) => {
            await lockInvitee(tx, row.workspaceId, email);
            const [claimed] = await tx
              .update(invitations)
              .set({ status: "accepted", acceptedAt: deps.now(), endorsedBy: user.id })
              .where(
                and(
                  eq(invitations.id, row.id),
                  eq(invitations.status, "pending"),
                  gt(invitations.expiresAt, deps.now()),
                ),
              )
              .returning({ id: invitations.id });
            if (!claimed) throw invitationGone();
            await joinWorkspace(tx, join);
          });
          break;
        } catch (err) {
          // joinWorkspace catches 23505, then its next query sees the aborted transaction (25P02).
          // Retry the whole claim and join after rollback, so the new handle is visible.
          if (pgCode(err) !== "25P02" || attempt === 7) throw err;
        }
      }
    } else {
      // A link accepts several people; joining is idempotent per person.
      await joinWorkspace(deps.db, join);
    }
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
    // Check and mark in one statement: of the requests within the hour, only the one that marks sends the email.
    const [marked] = await deps.db
      .update(invitations)
      .set({ requestedNewAt: now })
      .where(
        and(
          eq(invitations.id, row.id),
          or(
            isNull(invitations.requestedNewAt),
            lte(invitations.requestedNewAt, new Date(now.getTime() - 3600_000)),
          ),
        ),
      )
      .returning({ id: invitations.id });
    if (!marked) return c.body(null, 204);
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
