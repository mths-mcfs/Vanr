import type { UsageReport, Workspace, WorkspaceOverview, WorkspaceSettings } from "@vanr/contract";
import { can } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { randomId } from "@vanr/engine/ids";
import { ROLES } from "@vanr/engine/roles";
import { HANDLE_RE } from "@vanr/engine/text";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import {
  budgetOf,
  monthStart,
  requireCredential,
  seesSpend,
  usageSince,
  workspaceBudgetDefaults,
  workspaceBudgetScope,
  workspaceCallsSince,
} from "../agents";
import { type AppEnv, type Ctx, requireUser } from "../context";
import { approvalsWaitingFor } from "../control";
import { isUniqueViolation } from "../db-errors";
import { releaseSeats } from "../debates";
import { badRequest, conflict, forbidden, HttpError, notFound, param, readJson, readQuery } from "../http";
import { decodeImage, imageResponse } from "../images";
import {
  avatarUrl,
  changeRole,
  createWorkspace,
  logoUrl,
  memberRows,
  removeMember,
  takenHandles,
  toMember,
  toPerson,
} from "../members";
import { requireMember, requirePermission, WORKSPACE } from "../workspace-scope";

const { workspaces, members, users, agents } = schema;

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

/** An update body with no field set (`{}`, which the client allows) changes nothing. */
const hasChanges = (input: Record<string, unknown>) => Object.values(input).some((v) => v !== undefined);

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
    if (hasChanges(input)) {
      await c.get("deps").db.update(workspaces).set(input).where(eq(workspaces.id, workspaceId));
    }
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
    if (hasChanges(input)) await db.update(workspaces).set(input).where(eq(workspaces.id, workspaceId));
    return c.json(toSettings(await loadWorkspace(c)));
  });

  app.get(`${WORKSPACE}/overview`, async (c) => {
    const me = requireMember(c);
    const { workspaceId } = me;
    const { db, now, ledger } = c.get("deps");
    const [people] = await db
      .select({ n: count() })
      .from(members)
      .where(eq(members.workspaceId, workspaceId));
    const active = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)));
    // The very numbers the month's cap uses (`workspaceBudgetScope`): its budget, and its spend, a total that names
    // no agent (an anonymous debate's runs count without saying whose they are).
    const scope = await workspaceBudgetScope(db, workspaceId);
    const budget = scope.limitUsd;
    const spent = await ledger.spent(scope, now());
    const overview: WorkspaceOverview = {
      myApprovalQueue: (await approvalsWaitingFor(db, me)).length,
      // Spend follows view_usage, as GET /usage: whoever doesn't have it gets null.
      budgetSpentPct: seesSpend(me) ? (budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0) : null,
      agents: active.length,
      people: people?.n ?? 0,
    };
    return c.json(overview, 200, { "cache-control": "no-store" });
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

  app.patch(`${WORKSPACE}/members/:memberId`, async (c) => {
    const me = requirePermission(c, "manage_members");
    const target = param(c, "memberId");
    const { role } = await readJson(c, z.object({ role: z.enum(ROLES) }));
    await changeRole(c.get("deps").db, { workspaceId: me.workspaceId, actorId: me.userId, target, role });
    return c.body(null, 204);
  });

  app.delete(`${WORKSPACE}/members/:memberId`, async (c) => {
    const me = requireMember(c);
    const target = param(c, "memberId");
    if (target !== me.userId && !can(me.role, "manage_members")) throw forbidden();
    const { db, now } = c.get("deps");
    await removeMember(db, { workspaceId: me.workspaceId, actorId: me.userId, target, at: now() });
    // Whoever left the workspace loses their open connections to it, before anything else is sent.
    c.get("deps").hub.dropUser(me.workspaceId, target);
    // The debates whose round waited on them go on without them.
    await releaseSeats(c.get("deps"), { workspaceId: me.workspaceId, userId: target });
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
    // All or nothing: a taken handle leaves the name and the time zone as they were.
    await db.transaction(async (tx) => {
      if (input.name !== undefined) {
        await tx.update(users).set({ name: input.name, updatedAt: now() }).where(eq(users.id, me.userId));
      }
      if (input.handle !== undefined && input.handle !== me.handle) {
        const taken = await takenHandles(tx, me.workspaceId);
        if (taken.has(input.handle))
          throw conflict("handle.taken", "This handle is taken", { handle: input.handle });
        try {
          await tx
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
        await tx
          .update(members)
          .set({ timezone: input.timezone })
          .where(and(eq(members.workspaceId, me.workspaceId), eq(members.userId, me.userId)));
      }
    });
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
    return imageResponse(blob, c.req.header("if-none-match"));
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
    return imageResponse(blob, c.req.header("if-none-match"));
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
    const runsUsd = [...usage.values()].reduce((sum, u) => sum + u.costUsd, 0);
    const calls = [...usage.values()].reduce((sum, u) => sum + u.calls, 0);
    // The agents' runs, then what the workspace paid with no agent (search, wiki checks, agent drafts) by source.
    const unowned = await workspaceCallsSince(db, workspaceId, from);
    const report: UsageReport = {
      spendUsd: runsUsd + unowned.reduce((sum, k) => sum + k.costUsd, 0),
      since: from.toISOString(),
      perKind: [...(calls > 0 ? [{ kind: "model", calls, costUsd: runsUsd }] : []), ...unowned],
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
