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

export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Messages sent in this process (only the file adapter keeps them). */
  sent(): readonly Mail[];
}

/** Development and tests: writes each message as one JSON line in <dir>/outbox.jsonl. */
function fileMailer(dir: string | null): Mailer {
  const box: Mail[] = [];
  return {
    async send(mail) {
      box.push(mail);
      if (!dir) return;
      await mkdir(dir, { recursive: true });
      await appendFile(
        `${dir}/outbox.jsonl`,
        `${JSON.stringify({ at: new Date().toISOString(), ...mail })}\n`,
      );
    },
    sent: () => box,
  };
}

/** Production: Resend's HTTP API. No credential on this machine; not verified. */
function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(mail) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
        // Without a limit, a hung send holds the delivery until it goes back to the queue and out again.
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) log.error("mail.send_failed", { status: res.status, kind: mail.kind });
    },
    sent: () => [],
  };
}

export function createMailer(config: Config["mail"], memoryOnly = false): Mailer {
  if (config.provider === "resend") return resendMailer(config.apiKey, config.from);
  return fileMailer(memoryOnly ? null : config.dir);
}
