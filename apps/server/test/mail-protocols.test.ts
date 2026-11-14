import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { ImapClient, ImapError, imapDate, parseList } from "../src/integrations/imap";
import { buildMail, parseMail } from "../src/integrations/mime";
import { dotStuff, type SmtpError, smtpSend } from "../src/integrations/smtp";
import { type FakeMailServer, startFakeMail } from "./fake-mail";

let mail: FakeMailServer;
beforeAll(async () => {
  mail = await startFakeMail();
});
afterAll(() => mail.stop());

/** The fake servers listen on localhost without TLS: the installation allows both. */
const LOCAL = { allowPrivate: true, allowPlaintext: true };

const imapOpts = () => ({
  host: mail.host,
  port: mail.imapPort,
  secure: false,
  policy: LOCAL,
  user: mail.user,
  password: mail.password,
});

test("IMAP: logs in, lists folders with special use, searches and reads without marking as read", async () => {
  mail.deliver(
    "INBOX",
    [
      "From: Ana <ana@customer.test>",
      "To: lia@workshop.test",
      "Subject: =?UTF-8?B?Q2Fmw6kgcXVvdGU=?=",
      "Message-ID: <m1@customer.test>",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "How much is the caf=C3=A9 water pump swap?",
    ].join("\n"),
    new Date("2026-10-19T10:00:00Z"),
  );
  mail.deliver("INBOX", "From: spam@x.test\nSubject: offer\n\nbuy now", new Date("2026-09-01T10:00:00Z"));
  const client = await ImapClient.open(imapOpts());
  await client.login();
  const folders = await client.folders();
  expect(folders.map((f) => [f.name, f.special])).toEqual([
    ["INBOX", "inbox"],
    ["Sent", "sent"],
    ["Drafts", "drafts"],
    ["Trash", "trash"],
    ["Archive", "archive"],
  ]);
  await client.open("INBOX");
  const uids = await client.search(
    `SINCE ${imapDate(new Date("2026-10-01T00:00:00Z"))} FROM "customer.test"`,
  );
  expect(uids).toEqual([1]);
  const [msg] = await client.fetch(uids);
  const parsed = parseMail(msg?.raw ?? "");
  expect([parsed.subject, parsed.from, parsed.text, parsed.messageId]).toEqual([
    "Café quote",
    "Ana <ana@customer.test>",
    "How much is the café water pump swap?",
    "<m1@customer.test>",
  ]);
  expect(mail.folders.get("INBOX")?.messages[0]?.flags).toEqual([]);

  await client.open("INBOX", false);
  await client.move(2, "Trash");
  expect(mail.folders.get("Trash")?.messages.length).toBe(1);
  await client.append("Sent", "From: lia@workshop.test\r\nSubject: hi\r\n\r\nreply");
  expect(mail.folders.get("Sent")?.messages[0]?.raw).toContain("reply");
  await client.close();
});

test("IMAP: a wrong password becomes an auth error; a closed port, a connection error", async () => {
  const client = await ImapClient.open({ ...imapOpts(), password: "wrong" });
  const err = await client.login().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ImapError);
  expect((err as ImapError).kind).toBe("auth");
  await client.close();
  const down = await ImapClient.open({ ...imapOpts(), port: 1 }).catch((e: unknown) => e);
  expect((down as ImapError).kind).toBe("unreachable");
});

test("SMTP: authenticates, sends with a dot at the start of a line and rejects a wrong password", async () => {
  const raw = buildMail({
    from: "lia@workshop.test",
    to: ["ana@customer.test"],
    subject: "Re: Café quote",
    text: "It is $280.\n.\nCheers",
    date: new Date("2026-10-20T12:00:00Z"),
    messageId: "<r1@workshop.test>",
    inReplyTo: "<m1@customer.test>",
    references: "<m1@customer.test>",
  });
  const opts = {
    host: mail.host,
    port: mail.smtpPort,
    security: "none" as const,
    policy: LOCAL,
    user: mail.user,
    password: mail.password,
  };
  await smtpSend(opts, { from: "lia@workshop.test", to: ["ana@customer.test"] }, raw);
  const got = mail.sent.at(-1);
  expect(got?.to).toEqual(["ana@customer.test"]);
  const parsed = parseMail(got?.raw ?? "");
  expect([parsed.subject, parsed.text, parsed.inReplyTo]).toEqual([
    "Re: Café quote",
    "It is $280.\n.\nCheers",
    "<m1@customer.test>",
  ]);
  const err = await smtpSend({ ...opts, password: "x" }, { from: "a@b.c", to: ["d@e.f"] }, raw).catch(
    (e) => e,
  );
  expect((err as SmtpError).kind).toBe("auth");
  expect(dotStuff(".a\n.b")).toBe("..a\r\n..b");
});

test("MIME: multipart prefers text; HTML becomes text; attachments show by name", () => {
  const raw = [
    "From: x@y.z",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: multipart/alternative; boundary="b2"',
    "",
    "--b2",
    "Content-Type: text/html",
    "",
    "<p>Hello &amp; até</p>",
    "--b2--",
    "--b1",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--b1--",
  ].join("\r\n");
  const parsed = parseMail(raw);
  expect(parsed.text).toBe("Hello & até");
  expect(parsed.attachments).toEqual(["invoice.pdf"]);
  expect(parseList('* LIST (\\Noselect) "/" "[Gmail]"')).toBeNull();
});

test.each([true, false])("IMAP fallback preserves other deleted messages (UIDPLUS=%s)", async (uidPlus) => {
  const local = await startFakeMail({ move: false, uidPlus });
  const client = await ImapClient.open({ ...imapOpts(), port: local.imapPort });
  try {
    local.deliver("INBOX", "one");
    local.deliver("INBOX", "two");
    await client.login();
    await client.open("INBOX", false);
    await client.addFlags(2, "\\Deleted");
    if (uidPlus) await client.move(1, "Archive");
    else await expect(client.move(1, "Archive")).rejects.toBeInstanceOf(ImapError);
    expect(local.folders.get("INBOX")?.messages.map((m) => m.uid)).toEqual(uidPlus ? [2] : [1, 2]);
    expect(local.folders.get("Archive")?.messages.length).toBe(uidPlus ? 1 : 0);
  } finally {
    await client.close();
    local.stop();
  }
});

test.each([true, false])("mail response timeout closes the socket (IMAP=%s)", async (imap) => {
  let peer: Socket | undefined;
  let forced = false;
  const server = createServer((socket) => {
    peer = socket;
    socket.resume();
    if (imap) socket.write("* OK ready\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const opts = { host: "127.0.0.1", port: addr.port, user: "u", password: "p", timeoutMs: 20, policy: LOCAL };
  const timer = setTimeout(() => {
    forced = true;
    peer?.destroy();
  }, 500);
  try {
    if (imap) {
      const client = await ImapClient.open({ ...opts, secure: false });
      await expect(client.login()).rejects.toThrow();
      await client.close();
    } else
      await expect(
        smtpSend({ ...opts, security: "none" }, { from: "a@b.c", to: ["d@e.f"] }, "x"),
      ).rejects.toThrow();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(forced).toBe(false);
  } finally {
    clearTimeout(timer);
    peer?.destroy();
    server.close();
  }
});
