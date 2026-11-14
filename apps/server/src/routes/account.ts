import type { Me } from "@vanr/contract";
import { schema } from "@vanr/engine/db";
import { asc, count, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, requireUser } from "../context";
import { logoUrl } from "../members";

export function registerAccount(app: Hono<AppEnv>) {
  app.get("/api/v1/auth/config", async (c) => {
    const { db, config } = c.get("deps");
    const [row] = await db.select({ n: count() }).from(schema.users);
    return c.json({
      socialProviders: {
        google: Boolean(config.social.google),
        github: Boolean(config.social.github),
        apple: false,
      },
      signupOpen: config.signupOpen,
      firstRun: (row?.n ?? 0) === 0,
    });
  });

  app.get("/api/v1/me", async (c) => {
    const user = requireUser(c);
    const rows = await c
      .get("deps")
      .db.select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        logoKey: schema.workspaces.logoKey,
        role: schema.members.role,
      })
      .from(schema.members)
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.members.workspaceId))
      .where(eq(schema.members.userId, user.id))
      .orderBy(asc(schema.members.memberSince));
    const me: Me = {
      user,
      workspaces: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        logo: logoUrl(r.id, r.logoKey),
      })),
    };
    return c.json(me);
  });
}
