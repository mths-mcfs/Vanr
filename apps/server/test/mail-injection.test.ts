// A line break in a header, an envelope address or an IMAP string starts a header or a command of its own (a
// hidden Bcc, a second RCPT TO, `A99 DELETE INBOX`): the value is rejected, never cleaned. An attachment's name
// comes from outside and keeps only its last path part.
import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { HttpError } from "../src/http";
import { classifyRecipients, PUBLIC_MAIL_DOMAINS } from "../src/integrations/destinations";
import { ImapError, quote } from "../src/integrations/imap";
import { buildMail, parseMail } from "../src/integrations/mime";
import { smtpSend } from "../src/integrations/smtp";

const MAIL = {
  from: "agent@corp.test",
  to: ["ana@customer.test"],
  cc: ["bia@customer.test"],
  subject: "Quote",
  text: "body",
  date: new Date("2026-11-14T12:00:00Z"),
  messageId: "<id1@corp.test>",
  inReplyTo: "<m1@customer.test>",
  references: "<m0@customer.test> <m1@customer.test>",
};

const fieldOf = (run: () => unknown) => {
  try {
    run();
    return "built";
  } catch (err) {
    return err instanceof HttpError && err.code === "invalid_mail_header" ? err.params?.field : String(err);
  }
};

describe("buildMail rejects CR, LF and NUL in every header it writes", () => {
  test.each([
    ["from", { from: "agent@corp.test\r\nBcc: attacker@evil.test" }],
    ["to", { to: ["ana@customer.test", "victim@corp.test\r\nBcc: attacker@evil.test"] }],
    ["cc", { cc: ["cc@corp.test\nX-Injected: 1"] }],
    ["subject", { subject: "Hello\r\nBcc: ignored@evil.test" }],
    ["subject", { subject: "Hello\u0000there" }],
    ["message-id", { messageId: "<id@corp.test>\rX: 1" }],
    ["in-reply-to", { inReplyTo: "<rep@corp.test>\r\nBcc: reply-hijack@evil.test" }],
    ["references", { references: "<ref@corp.test>\nX-Ref: bad" }],
  ])("%s", (field, change) => {
    expect(fieldOf(() => buildMail({ ...MAIL, ...change }))).toBe(field);
  });

  test("a clean message still builds, with every header on its own line", () => {
    const head = buildMail(MAIL).split("\r\n\r\n")[0] ?? "";
    expect(head.split("\r\n").map((l) => l.split(":")[0])).toEqual([
      "From",
      "To",
      "Cc",
      "Subject",
      "Date",
      "Message-ID",
      "In-Reply-To",
      "References",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
  });
});

describe("parseMail: an attachment's name is only its last path part", () => {
  test.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\win.ini", "win.ini"],
    ["/abs/path/report.pdf", "report.pdf"],
    ["..", "anexo"],
    ["dir/..", "anexo"],
    ["=?UTF-8?B?Li4vLi4vc2VjcmV0LnR4dA==?=", "secret.txt"],
    [`=?UTF-8?B?${Buffer.from("ok\u0007.pdf").toString("base64")}?=`, "ok.pdf"],
    ["relatório.pdf", "relatório.pdf"],
  ])("%p becomes %p", (filename, expected) => {
    const raw = `From: a@b.com\r\nContent-Disposition: attachment; filename="${filename}"\r\n\r\nhi`;
    expect(parseMail(raw).attachments).toEqual([expected]);
  });
});

describe("protocol strings", () => {
  test("an IMAP quoted string rejects a line break or NUL instead of carrying it", () => {
    for (const bad of ['INBOX"\r\nA99 DELETE INBOX\r\n"', "a\nb", "a\rb", "a\u0000b"]) {
      expect(() => quote(bad)).toThrow(ImapError);
    }
    expect(quote('Sent "old" \\ 2026')).toBe('"Sent \\"old\\" \\\\ 2026"');
  });

  test("an SMTP envelope address with a line break or bracket is rejected before connecting", async () => {
    let connections = 0;
    const server = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const opts = {
      host: "127.0.0.1",
      port: addr.port,
      security: "none" as const,
      user: "u",
      password: "p",
      policy: { allowPrivate: true, allowPlaintext: true },
    };
    try {
      for (const envelope of [
        { from: "a@b.com", to: ["x@y.com>\r\nRCPT TO:<evil@attacker.com"] },
        { from: "a@b.com\r\nRCPT TO:<evil@attacker.com>", to: ["x@y.com"] },
        { from: "a@b.com", to: ["x@y.com\u0000"] },
        { from: "a@b.com>", to: ["x@y.com"] },
      ]) {
        const err = await smtpSend(opts, envelope, "Subject: hi\r\n\r\nhello").catch((e: unknown) => e);
        expect(err instanceof HttpError && err.code).toBe("invalid_mail_header");
      }
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("public mail providers: the domain says nothing about the person", () => {
  test.each([
    "mail.ru",
    "yandex.ru",
    "yandex.com",
    "fastmail.com",
    "proton.me",
    "protonmail.com",
    "gmx.com",
    "gmx.net",
    "icloud.com",
    "zoho.com",
    "aol.com",
    "hey.com",
  ])("%s is a public provider: a thread participant there doesn't make the domain known", (domain) => {
    expect(PUBLIC_MAIL_DOMAINS.has(domain)).toBe(true);
    const out = classifyRecipients([`other@${domain}`, `sender@${domain}`], {
      workspaceDomains: new Set(["mycorp.com"]),
      allowList: [],
      thread: [`sender@${domain}`],
    });
    expect(out).toEqual({ known: [`sender@${domain}`], fresh: [`other@${domain}`] });
  });

  test("a company domain in the thread stays known (the rule of the thread's domains is unchanged)", () => {
    const out = classifyRecipients(["ceo@client.test"], {
      workspaceDomains: new Set(),
      allowList: [],
      thread: ["support@client.test"],
    });
    expect(out.known).toEqual(["ceo@client.test"]);
  });
});
