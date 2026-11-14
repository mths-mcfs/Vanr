import { appendFile, mkdir } from "node:fs/promises";
import type { Config } from "./config";
import { log } from "./logger";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** Kind of message, so the tests find the right link (verify, reset, invite...). */
  kind: string;
  link?: string;
}

/**
 * What happened to a message: accepted, or rejected. A rejection worth retrying is a 429, a 5xx, a network
 * failure or the deadline; any other 4xx is final (the message itself is wrong for the provider).
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
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
          // Without a limit, a hung send holds the email until the queue hands it out again.
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
        log.error("mail.send_failed", { reason, kind: mail.kind, err });
        return { ok: false, retry: true, reason };
      }
      await res.body?.cancel().catch(() => {});
      if (res.ok) return { ok: true };
      const retry = res.status === 429 || res.status >= 500;
      log.error("mail.send_failed", { status: res.status, kind: mail.kind, retry });
      return { ok: false, retry, reason: `http_${res.status}` };
    },
    sent: () => [],
  };
}

export function createMailer(config: Config["mail"], memoryOnly = false): Mailer {
  if (config.provider === "resend") return resendMailer(config.apiKey, config.from);
  return fileMailer(memoryOnly ? null : config.dir);
}
