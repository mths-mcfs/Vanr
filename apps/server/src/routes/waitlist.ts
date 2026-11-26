import { schema } from "@vanr/engine/db";
import { newToken } from "@vanr/engine/ids";
import { PRODUCT } from "@vanr/product";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { notFound, readJson } from "../http";

const JoinBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  locale: z.string().max(10).optional(),
});
const ConfirmBody = z.object({ token: z.string().min(10).max(200) });

export function registerWaitlist(app: Hono<AppEnv>) {
  const resendAt = new Map<string, number>();
  let windowEnds = 0;
  let sent = 0;
  // Joining twice is not an error. Resends keep the persisted token and wait 15 minutes.
  app.post("/api/v1/waitlist", async (c) => {
    const { db, mailer, config, now } = c.get("deps");
    const body = await readJson(c, JoinBody);
    await db
      .insert(schema.waitlist)
      .values({ email: body.email, token: newToken(), locale: body.locale ?? null })
      .onConflictDoNothing({ target: schema.waitlist.email });
    const [existing] = await db.select().from(schema.waitlist).where(eq(schema.waitlist.email, body.email));
    const at = now().getTime();
    for (const [email, until] of resendAt) if (until <= at) resendAt.delete(email);
    if (at >= windowEnds) {
      windowEnds = at + 60_000;
      sent = 0;
    }
    if (existing && !existing.confirmedAt && !resendAt.has(body.email) && sent < 20) {
      resendAt.set(body.email, at + 15 * 60_000);
      sent++;
      const link = `${config.publicUrl}/?confirm=${encodeURIComponent(existing.token)}`;
      await mailer.send({
        to: body.email,
        kind: "waitlist",
        subject: `${PRODUCT.name}: confirm your place on the list`,
        text: link,
        link,
      });
    }
    return c.json({ ok: true as const });
  });

  app.post("/api/v1/waitlist/confirm", async (c) => {
    const { db, now } = c.get("deps");
    const { token } = await readJson(c, ConfirmBody);
    const [row] = await db.select().from(schema.waitlist).where(eq(schema.waitlist.token, token));
    if (!row) throw notFound("Confirmation link not found");
    if (!row.confirmedAt)
      await db.update(schema.waitlist).set({ confirmedAt: now() }).where(eq(schema.waitlist.token, token));
    return c.json({ ok: true as const });
  });
}
