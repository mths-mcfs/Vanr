// Signed inbound webhook in the Standard Webhooks 1.0 format
// (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
// headers `webhook-id`, `webhook-timestamp` (seconds) and `webhook-signature` (`v1,<base64>`, one or
// more separated by spaces, to rotate the secret without stopping the sender). The signature is HMAC-SHA256
// of `id.timestamp.body` with the secret `whsec_<base64>`. The `webhook-id` is the dedupe key.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "whsec_";
/** Maximum difference between the sender's clock and ours (the libraries use 5 min). */
export const WEBHOOK_TOLERANCE_S = 5 * 60;
const MAX_ID = 200;

export function newWebhookSecret(): string {
  return `${PREFIX}${randomBytes(24).toString("base64")}`;
}

function keyOf(secret: string): Buffer {
  return Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, "base64");
}

/** `v1,<base64>` of the HMAC-SHA256 of `id.timestamp.body`. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

export type WebhookCheck =
  | { ok: true; id: string }
  | {
      ok: false;
      code: "webhook.unsigned" | "webhook.bad_timestamp" | "webhook.stale" | "webhook.bad_signature";
    };

/** Checks headers, time window and signature (constant-time comparison). */
export function verifyWebhook(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  now: Date,
): WebhookCheck {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || id.length > MAX_ID) return { ok: false, code: "webhook.unsigned" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, code: "webhook.bad_timestamp" };
  const ts = Number(timestamp);
  if (Math.abs(now.getTime() / 1000 - ts) > WEBHOOK_TOLERANCE_S) return { ok: false, code: "webhook.stale" };
  const expected = Buffer.from(signWebhook(secret, id, ts, body).slice(3), "base64");
  for (const part of signature.split(" ")) {
    const [version, mac] = part.split(",", 2);
    if (version !== "v1" || !mac) continue;
    const got = Buffer.from(mac, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, id };
  }
  return { ok: false, code: "webhook.bad_signature" };
}
