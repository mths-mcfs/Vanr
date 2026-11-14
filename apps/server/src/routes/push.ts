// The browser's Web Push subscription. The subscription belongs to the person (it works in all their
// workspaces); sending is the delivery queue's job (notify-delivery.ts).
import { schema } from "@vanr/engine/db";
import { newId } from "@vanr/engine/ids";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, requireUser } from "../context";
import { HttpError, readJson, readQuery } from "../http";
import { pushEndpointProblem, pushKeysProblem } from "../push";

const { pushSubscriptions } = schema;
/** Devices per person; the oldest goes away past this. */
const MAX_SUBSCRIPTIONS = 20;

export function registerPush(app: Hono<AppEnv>) {
  app.get("/api/v1/push/key", (c) => {
    requireUser(c);
    return c.json({ publicKey: c.get("deps").push.publicKey });
  });

  app.post("/api/v1/push/subscriptions", async (c) => {
    const user = requireUser(c);
    const deps = c.get("deps");
    const body = await readJson(
      c,
      z
        .object({
          endpoint: z.string().max(2048),
          expirationTime: z.number().nullable().optional(),
          keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict(),
        })
        .strict(),
    );
    // The server POSTs to the endpoint: only a known push service, over https (SSRF).
    const problem = pushEndpointProblem(body.endpoint);
    if (problem) throw new HttpError(400, "push.endpoint", `Push endpoint rejected: ${problem}`);
    const keys = pushKeysProblem(body.keys);
    if (keys) throw new HttpError(400, "push.keys", `Push keys rejected: ${keys}`);
    const ua = c.req.header("user-agent")?.slice(0, 300) ?? null;
    const [row] = await deps.db
      .insert(pushSubscriptions)
      .values({
        id: newId("psub"),
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: ua,
        createdAt: deps.now(),
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
        set: { p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: ua, failures: 0 },
      })
      .returning({ id: pushSubscriptions.id });
    const keep = await deps.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, user.id))
      .orderBy(asc(pushSubscriptions.createdAt))
      .then((rows) => rows.slice(-MAX_SUBSCRIPTIONS).map((r) => r.id));
    await deps.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, user.id), notInArray(pushSubscriptions.id, keep)));
    return c.json({ id: row?.id ?? "" });
  });

  // Signing out or turning push off on this device. Only deletes the person's own subscription.
  app.delete("/api/v1/push/subscriptions", async (c) => {
    const user = requireUser(c);
    const deps = c.get("deps");
    const { endpoint } = readQuery(c, z.object({ endpoint: z.string().max(2048) }));
    const gone = await deps.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, endpoint)))
      .returning({ id: pushSubscriptions.id });
    return c.json({ removed: gone.length });
  });
}
