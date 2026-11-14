import { can, type PERMISSIONS } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { type AppEnv, type Ctx, requireUser, type WorkspaceMember } from "./context";
import { forbidden, HttpError } from "./http";

type Permission = keyof typeof PERMISSIONS;

export const WORKSPACE = "/api/v1/workspaces/:workspaceId";

/** A non-member gets 404: a workspace that doesn't exist and someone else's are indistinguishable. */
const workspaceNotFound = () => new HttpError(404, "not_found", "Workspace not found");

const SEEN_EVERY_MS = 60_000;

/** Requires a session and membership in the workspace. Updates `lastOnlineAt` at most once a minute. */
export function registerWorkspaceScope(app: Hono<AppEnv>) {
  const scope: MiddlewareHandler<AppEnv> = async (c, next) => {
    const user = requireUser(c);
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) throw workspaceNotFound();
    const { db, now } = c.get("deps");
    const [m] = await db
      .select({ role: schema.members.role, handle: schema.members.handle })
      .from(schema.members)
      .where(and(eq(schema.members.workspaceId, workspaceId), eq(schema.members.userId, user.id)));
    if (!m) throw workspaceNotFound();
    c.set("member", { workspaceId, userId: user.id, role: m.role, handle: m.handle });
    const at = now();
    await db
      .update(schema.members)
      .set({ lastOnlineAt: at })
      .where(
        and(
          eq(schema.members.workspaceId, workspaceId),
          eq(schema.members.userId, user.id),
          or(
            isNull(schema.members.lastOnlineAt),
            lt(schema.members.lastOnlineAt, new Date(at.getTime() - SEEN_EVERY_MS)),
          ),
        ),
      );
    await next();
  };
  app.use(WORKSPACE, scope);
  app.use(`${WORKSPACE}/*`, scope);
}

export function requireMember(c: Ctx): WorkspaceMember {
  const member = c.get("member");
  if (!member) throw workspaceNotFound();
  return member;
}

export function requirePermission(c: Ctx, permission: Permission): WorkspaceMember {
  const member = requireMember(c);
  if (!can(member.role, permission)) throw forbidden();
  return member;
}
