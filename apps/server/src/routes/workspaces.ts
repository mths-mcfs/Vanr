import type { UsageReport, Workspace, WorkspaceOverview, WorkspaceSettings } from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { randomId } from "@vanr/engine/ids";
import { ROLES } from "@vanr/engine/roles";
import { HANDLE_RE } from "@vanr/engine/text";
import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { budgetOf, monthStart, requireCredential, usageSince, workspaceBudgetDefaults } from "../agents";
import { type AppEnv, type Ctx, requireUser } from "../context";
import { approvalsWaitingFor } from "../control";
import { isUniqueViolation } from "../db-errors";
import { badRequest, conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { decodeImage, imageResponse } from "../images";
import {
  avatarUrl,
  createWorkspace,
  logoUrl,
  memberRows,
  takenHandles,
  toMember,
  toPerson,
} from "../members";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { workspaces, members, users, channelMemberships, agents } = schema;

const name = z.string().trim().min(1).max(80);
const context = z.string().max(20_000);
const timezone = z.string().min(1).max(64).refine(isTimeZone, "Unknown time zone");
const image = z.object({ imageBase64: z.string().min(1), contentType: z.string() });

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function loadWorkspace(c: Ctx) {
  const { workspaceId } = requireMember(c);
  const [workspace] = await c.get("deps").db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw notFound("Workspace not found");
  return workspace;
}

const toSettings = (o: typeof workspaces.$inferSelect): WorkspaceSettings => ({
  name: o.name,
  context: o.context,
  timezone: o.timezone,
  primaryCredentialId: o.primaryCredentialId,
  agentBudgetDefaultUsd: o.agentBudgetDefaultUsd,
  approvalReviewer: o.approvalReviewer,
});

const toWorkspace = (o: typeof workspaces.$inferSelect): Workspace => ({
  id: o.id,
  name: o.name,
  context: o.context,
  logo: logoUrl(o.id, o.logoKey),
});

/** Makes sure the workspace keeps at least one owner after `userId` stops being one. */
async function assertAnotherOwner(c: Ctx, workspaceId: string, userId: string) {
  const [row] = await c
    .get("deps")
    .db.select({ n: count() })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.role, "owner"), ne(members.userId, userId)));
  if ((row?.n ?? 0) === 0) throw conflict("last_owner", "The workspace needs at least one owner");
}

export function registerWorkspaces(app: Hono<AppEnv>) {
  app.post("/api/v1/workspaces", async (c) => {
    const user = requireUser(c);
    const input = await readJson(
      c,
      z.object({ name, context: context.optional(), timezone: timezone.optional() }),
    );
    const { db } = c.get("deps");
    const { workspaceId, defaultChannelId } = await createWorkspace(db, {
      name: input.name,
      context: input.context ?? "",
      timezone: input.timezone,
      user,
    });
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) throw new HttpError(500, "internal", "Workspace not created");
    return c.json({ workspace: toWorkspace(workspace), defaultChannelId }, 201);
  });

  app.get(WORKSPACE, async (c) => c.json(toWorkspace(await loadWorkspace(c))));

  app.patch(WORKSPACE, async (c) => {
    const { workspaceId } = requirePermission(c, "configure");
    const input = await readJson(c, z.object({ name: name.optional(), context: context.optional() }));
    await c.get("deps").db.update(workspaces).set(input).where(eq(workspaces.id, workspaceId));
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/settings`, async (c) => c.json(toSettings(await loadWorkspace(c))));

  app.patch(`${WORKSPACE}/settings`, async (c) => {
    const { workspaceId } = requirePermission(c, "configure");
    const input = await readJson(
      c,
      z.object({
        name: name.optional(),
        context: context.optional(),
        timezone: timezone.optional(),
        primaryCredentialId: z.string().nullable().optional(),
        agentBudgetDefaultUsd: z.number().min(0).max(100_000).optional(),
        approvalReviewer: z.boolean().optional(),
      }),
    );
    const { db } = c.get("deps");
    await requireCredential(db, workspaceId, input.primaryCredentialId);
    await db.update(workspaces).set(input).where(eq(workspaces.id, workspaceId));
    return c.json(toSettings(await loadWorkspace(c)));
  });

  app.get(`${WORKSPACE}/overview`, async (c) => {
    const me = requireMember(c);
    const { workspaceId } = me;
    const { db, now } = c.get("deps");
    const [people] = await db
      .select({ n: count() })
      .from(members)
      .where(eq(members.workspaceId, workspaceId));
    const active = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)));
    const { defaultBudget } = await workspaceBudgetDefaults(db, workspaceId);
    const usage = await usageSince(db, workspaceId, monthStart(now()));
    const budget = active.reduce((total, a) => total + budgetOf(a, defaultBudget), 0);
    const spent = [...usage.values()].reduce((total, u) => total + u.costUsd, 0);
    const overview: WorkspaceOverview = {
      myApprovalQueue: (await approvalsWaitingFor(db, me)).length,
      budgetSpentPct: budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0,
      agents: active.length,
      people: people?.n ?? 0,
    };
    return c.json(overview);
  });

  app.get(`${WORKSPACE}/members`, async (c) => {
    const { workspaceId } = requireMember(c);
    const rows = await memberRows(c.get("deps").db, workspaceId);
    return c.json({ members: rows.map((r) => toMember(workspaceId, r)) });
  });

  app.get(`${WORKSPACE}/people`, async (c) => {
    const { workspaceId } = requireMember(c);
    const { db, now, hub } = c.get("deps");
    const rows = await memberRows(db, workspaceId);
    const at = now();
    return c.json({
      people: rows.map((r) => toPerson(workspaceId, r, at, (id) => hub.isOnline(workspaceId, id))),
    });
  });

  // Role: nobody changes their own; touching an owner (from or to) needs manage_owners.
  app.patch(`${WORKSPACE}/members/:memberId`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const target = param(c, "memberId");
    const { role } = await readJson(c, z.object({ role: z.enum(ROLES) }));
    if (target === me.userId) throw forbidden("You can't change your own role");
    const { db } = c.get("deps");
    const [current] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, target)));
    if (!current) throw notFound("Member not found");
    if ((current.role === "owner" || role === "owner") && !can(me.role, "manage_owners")) {
      throw forbidden("Only owners can promote or demote owners");
    }
    if (current.role === "owner" && role !== "owner") await assertAnotherOwner(c, me.workspaceId, target);
    await db
      .update(members)
      .set({ role })
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, target)));
    return c.body(null, 204);
  });

  // Remove: manage_members removes others; anyone can leave. An owner leaves only if another owner stays.
  app.delete(`${WORKSPACE}/members/:memberId`, async (c) => {
    const me = requireMember(c);
    const target = param(c, "memberId");
    const self = target === me.userId;
    if (!self && !can(me.role, "manage_members")) throw forbidden();
    const { db } = c.get("deps");
    const [current] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, target)));
    if (!current) throw notFound("Member not found");
    if (current.role === "owner") {
      if (!self && !can(me.role, "manage_owners")) throw forbidden("Only owners can remove owners");
      await assertAnotherOwner(c, me.workspaceId, target);
    }
    await db.transaction(async (tx) => {
      await tx
        .delete(members)
        .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, target)));
      const workspaceChannels = tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.workspaceId, me.workspaceId));
      await tx
        .delete(channelMemberships)
        .where(
          and(
            eq(channelMemberships.memberType, "person"),
            eq(channelMemberships.memberId, target),
            inArray(channelMemberships.channelId, workspaceChannels),
          ),
        );
    });
    // Whoever left the workspace loses their open connections to it.
    c.get("deps").hub.dropUser(me.workspaceId, target);
    return c.body(null, 204);
  });

  app.patch(`${WORKSPACE}/me`, async (c) => {
    const me = requireMember(c);
    const input = await readJson(
      c,
      z.object({
        name: name.optional(),
        handle: z.string().trim().toLowerCase().regex(HANDLE_RE).optional(),
        timezone: timezone.nullable().optional(),
      }),
    );
    const { db, now } = c.get("deps");
    if (input.name !== undefined) {
      await db.update(users).set({ name: input.name, updatedAt: now() }).where(eq(users.id, me.userId));
    }
    if (input.handle !== undefined && input.handle !== me.handle) {
      const taken = await takenHandles(db, me.workspaceId);
      if (taken.has(input.handle))
        throw conflict("handle.taken", "This handle is taken", { handle: input.handle });
      try {
        await db
          .update(members)
          .set({ handle: input.handle })
          .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
      } catch (err) {
        if (isUniqueViolation(err))
          throw conflict("handle.taken", "This handle is taken", { handle: input.handle });
        throw err;
      }
    }
    if (input.timezone !== undefined) {
      await db
        .update(members)
        .set({ timezone: input.timezone })
        .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
    }
    const [row] = await memberRows(db, me.workspaceId, me.userId);
    if (!row) throw notFound("Member not found");
    return c.json(
      toPerson(me.workspaceId, row, now(), (id) => c.get("deps").hub.isOnline(me.workspaceId, id)),
    );
  });

  app.put(`${WORKSPACE}/me/avatar`, async (c) => {
    const me = requireMember(c);
    const img = decodeImage(await readJson(c, image));
    const { db, blobs } = c.get("deps");
    const key = `workspaces/${me.workspaceId}/avatars/${me.userId}-${randomId(10)}`;
    await blobs.put(key, img.bytes, img.contentType);
    const [old] = await db
      .select({ key: members.avatarKey })
      .from(members)
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
    await db
      .update(members)
      .set({ avatarKey: key })
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
    if (old?.key) await blobs.delete(old.key);
    return c.json({ avatarUrl: avatarUrl(me.workspaceId, me.userId, key) ?? "" });
  });

  app.delete(`${WORKSPACE}/me/avatar`, async (c) => {
    const me = requireMember(c);
    const { db, blobs } = c.get("deps");
    const [old] = await db
      .select({ key: members.avatarKey })
      .from(members)
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
    await db
      .update(members)
      .set({ avatarKey: null })
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
    if (old?.key) await blobs.delete(old.key);
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/people/:personId/avatar`, async (c) => {
    const me = requireMember(c);
    const { db, blobs } = c.get("deps");
    const [row] = await db
      .select({ key: members.avatarKey })
      .from(members)
      .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, param(c, "personId"))));
    const blob = row?.key ? await blobs.get(row.key) : null;
    if (!blob) throw notFound("No avatar");
    return imageResponse(blob);
  });

  app.put(`${WORKSPACE}/logo`, async (c) => {
    const me = requirePermission(c, "configure");
    const img = decodeImage(await readJson(c, image));
    const { db, blobs } = c.get("deps");
    const workspace = await loadWorkspace(c);
    const key = `workspaces/${me.workspaceId}/logo-${randomId(10)}`;
    await blobs.put(key, img.bytes, img.contentType);
    await db.update(workspaces).set({ logoKey: key }).where(eq(workspaces.id, me.workspaceId));
    if (workspace.logoKey) await blobs.delete(workspace.logoKey);
    return c.json({ logo: logoUrl(me.workspaceId, key) ?? "" });
  });

  app.delete(`${WORKSPACE}/logo`, async (c) => {
    const me = requirePermission(c, "configure");
    const { db, blobs } = c.get("deps");
    const workspace = await loadWorkspace(c);
    await db.update(workspaces).set({ logoKey: null }).where(eq(workspaces.id, me.workspaceId));
    if (workspace.logoKey) await blobs.delete(workspace.logoKey);
    return c.body(null, 204);
  });

  app.get(`${WORKSPACE}/logo`, async (c) => {
    const workspace = await loadWorkspace(c);
    const blob = workspace.logoKey ? await c.get("deps").blobs.get(workspace.logoKey) : null;
    if (!blob) throw notFound("No logo");
    return imageResponse(blob);
  });

  app.get(`${WORKSPACE}/usage/report`, async (c) => {
    requirePermission(c, "view_usage");
    const { since } = readQuery(
      c,
      z.object({ since: z.iso.datetime({ offset: true }).or(z.iso.date()).optional() }),
    );
    const { db, now } = c.get("deps");
    const from = since ? new Date(since) : monthStart(now());
    if (Number.isNaN(from.getTime())) throw badRequest("Invalid since");
    const { workspaceId } = requireMember(c);
    const usage = await usageSince(db, workspaceId, from);
    const { defaultBudget } = await workspaceBudgetDefaults(db, workspaceId);
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)))
      .orderBy(agents.name);
    const total = [...usage.values()].reduce((sum, u) => sum + u.costUsd, 0);
    const calls = [...usage.values()].reduce((sum, u) => sum + u.calls, 0);
    const report: UsageReport = {
      spendUsd: total,
      since: from.toISOString(),
      // For now there is only one kind of spend: the runs' model calls.
      perKind: calls > 0 ? [{ kind: "model", calls, costUsd: total }] : [],
      agents: rows.map((a) => {
        const costUsd = usage.get(a.id)?.costUsd ?? 0;
        const budgetPerMonthUsd = budgetOf(a, defaultBudget);
        return {
          agentId: a.id,
          name: a.name,
          costUsd,
          budgetPerMonthUsd,
          budgetInherited: a.budgetPerMonthUsd === null,
          budgetSpentPct: budgetPerMonthUsd > 0 ? Math.round((costUsd / budgetPerMonthUsd) * 1000) / 10 : 0,
        };
      }),
    };
    return c.json(report);
  });
}
