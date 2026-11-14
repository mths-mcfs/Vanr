// Web Push (VAPID, RFC 8030/8291/8292). `web-push` builds the encrypted and signed request; the
// sender is the server's `fetchExternal`, which the tests replace with a fake one (no network).
//
// The endpoint comes from the browser and the server POSTs to it: without care, that is an SSRF. We only
// accept https on a known push service host, with no port, no credential in the URL and no redirect.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import type { Config } from "./config";
import { log } from "./logger";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The server's keys. Production passes VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (changing the keys
 * invalidates the subscriptions). Without them: a new pair in memory in tests, or kept in
 * `<DATA_DIR>/vapid.json` (0600) in development.
 */
export async function loadVapid(config: Pick<Config, "push" | "dataDir">): Promise<VapidKeys> {
  const subject = config.push.subject;
  if (config.push.vapid) return { ...config.push.vapid, subject };
  if (config.dataDir === "memory") return { ...webpush.generateVAPIDKeys(), subject };
  const file = join(config.dataDir, "vapid.json");
  if (existsSync(file)) {
    const saved = JSON.parse(await readFile(file, "utf8")) as { publicKey?: unknown; privateKey?: unknown };
    if (typeof saved.publicKey === "string" && typeof saved.privateKey === "string")
      return { publicKey: saved.publicKey, privateKey: saved.privateKey, subject };
  }
  const keys = webpush.generateVAPIDKeys();
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
  await chmod(file, 0o600);
  log.info("push.vapid_generated", { file });
  return { ...keys, subject };
}

/** The browsers' push services (Chrome/Edge via FCM, Firefox, Safari, Windows). */
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

/** Why the endpoint doesn't do, or null when it does. */
export function pushEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "credentials";
  if (url.port) return "port";
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return "unknown_push_service";
  return null;
}

const b64url = (v: string) => (/^[A-Za-z0-9_-]+={0,2}$/.test(v) ? Buffer.from(v, "base64url") : null);

/** The browser's key: an uncompressed P-256 point (65 bytes, 0x04) and a 16-byte secret. */
export function pushKeysProblem(keys: { p256dh: string; auth: string }): string | null {
  const p = b64url(keys.p256dh);
  if (p?.length !== 65 || p[0] !== 0x04) return "bad_p256dh";
  const a = b64url(keys.auth);
  if (a?.length !== 16) return "bad_auth";
  return null;
}

/** What the service worker shows. */
interface PushPayload {
  title: string;
  body: string;
  /** Path inside the app itself; the service worker rejects another origin. */
  url: string;
  /** One notification per notice: the new one replaces the previous. */
  tag: string;
  notificationId: string;
  workspaceId: string;
  critical: boolean;
}

interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSender {
  readonly publicKey: string;
  /** HTTP status from the push service (201 ok; 404/410 dead subscription). */
  send(target: PushTarget, payload: PushPayload): Promise<number>;
}

const PUSH_TIMEOUT_MS = 10_000;

export function webPushSender(vapid: VapidKeys, fetchFn: typeof fetch): PushSender {
  return {
    publicKey: vapid.publicKey,
    async send(target, payload) {
      // Checked again here: the row may have come in before a stricter rule.
      const problem = pushEndpointProblem(target.endpoint);
      if (problem) throw new Error(`push endpoint rejected: ${problem}`);
      const req = webpush.generateRequestDetails(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: vapid,
          // An old notice is useless: the service keeps it for up to 1 day while the device is off.
          TTL: 86_400,
          urgency: payload.critical ? "high" : "normal",
        },
      );
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const res = await fetchFn(req.endpoint, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      return res.status;
    },
  };
}
