import { appendFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "./config";
import { log } from "./logger";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Kind of message, so the tests find the right link (verify, reset, invite...). */
  kind: string;
  link?: string;
  /**
   * The same key on every attempt of the same message: the provider sends it once, even when an attempt
   * it accepted timed out here. Never a secret nor personal data (the delivery's id is the usual one).
   */
  idempotencyKey?: string;
}

/**
 * What happened to a message: accepted, or rejected. A rejection worth retrying is a 429, a 5xx, a network
 * failure, the deadline or the provider still running an attempt with the same idempotency key; any other
 * 4xx is final (the message itself is wrong for the provider).
 */
export type SendResult = { ok: true } | { ok: false; retry: boolean; reason: string };

export interface Mailer {
  send(mail: Mail): Promise<SendResult>;
  /** Messages sent in this process (only the file adapter keeps them). */
  sent(): readonly Mail[];
}

/** Development and tests: writes each message as one JSON line in <dir>/outbox.jsonl. */
function fileMailer(dir: string | null): Mailer {
  const box: Mail[] = [];
  return {
    async send(mail) {
      box.push(mail);
      if (!dir) return { ok: true };
      await mkdir(dir, { recursive: true });
      await appendFile(
        `${dir}/outbox.jsonl`,
        `${JSON.stringify({ at: new Date().toISOString(), ...mail })}\n`,
      );
      return { ok: true };
    },
    sent: () => box,
  };
}

/**
 * Production: Resend's HTTP API. Not verified against Resend itself: there is no Resend credential in
 * development; the tests answer with a double of its HTTP API. `fetch` defaults to the global one at send time.
 */
export function resendMailer(
  apiKey: string,
  from: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Mailer {
  return {
    async send(mail) {
      let res: Response;
      try {
        res = await (opts.fetch ?? globalThis.fetch)("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            // Resend keeps a key for 24 hours: a repeated key with the same payload answers the first
            // response without sending again (https://resend.com/docs/dashboard/emails/idempotency-keys).
            ...(mail.idempotencyKey ? { "idempotency-key": mail.idempotencyKey } : {}),
          },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
          // Without a limit, a hung send holds the email until the queue hands it out again.
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
        log.error("mail.send_failed", { reason, kind: mail.kind, err });
        return { ok: false, retry: true, reason };
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: true };
      }
      // 409 `concurrent_idempotent_requests`: an attempt with the same key is still running there.
      const concurrent = res.status === 409 && (await errorName(res)) === "concurrent_idempotent_requests";
      const retry = res.status === 429 || res.status >= 500 || concurrent;
      log.error("mail.send_failed", { status: res.status, kind: mail.kind, retry });
      return { ok: false, retry, reason: `http_${res.status}` };
    },
    sent: () => [],
  };
}

/** The error body Resend answers with (`{ name, message }`); anything else has no name. */
const ResendError = z.object({ name: z.string() });

async function errorName(res: Response): Promise<string | null> {
  const parsed = ResendError.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data.name : null;
}

export function createMailer(config: Config["mail"], memoryOnly = false): Mailer {
  if (config.provider === "resend") return resendMailer(config.apiKey, config.from);
  return fileMailer(memoryOnly ? null : config.dir);
}
